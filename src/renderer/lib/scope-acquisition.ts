// 示波器采集（技术设计 §4.2、§7）：在 rAF / useFrame 中从探针环形缓冲取数，按触发设置定位一屏。
// 同一窗口内 2D 面板与 3D SCREEN_ 调用同一缓存，得到同一帧；采样数据不进 React state。
import {
  findTrigger,
  measureSignal,
  resolveScope,
  type ScopeSettings,
  type SignalMeasurement,
  screenSeconds,
  triggerColumn,
} from '@domain/instruments'
import { scopeProbeId } from '@domain/measurement/plan'
import type { Instrument } from '@shared/schema/instrument'
import { getInstrumentReading } from './instrument-readings'
import type { RingBuffer } from './ring-buffer'
import { getSimClient } from './sim-client'

export type ScopeState = 'off' | 'auto' | 'triggered' | 'waiting' | 'ready' | 'stopped'

export type ScopeFrame = {
  /** 每产生新的一屏加 1 */
  revision: number
  state: ScopeState
  dt: number
  /** 每格采样点数 */
  pointsPerDiv: number
  /** 各通道一屏原始电压（耦合在绘制时处理），未接入或关闭为 null */
  traces: (Float32Array | null)[]
  measurements: (SignalMeasurement | null)[]
}

/** 自动测量所用记录长度与刷新间隔 */
const MEASURE_POINTS = 1 << 16
const MEASURE_INTERVAL_MS = 100

type Acquisition = {
  frame: ScopeFrame
  written: number
  key: string
  arm: number
  mode: string
  source: number
  armedWritten: number
  captured: boolean
  measuredAt: number
  scratch: Float32Array
  measureScratch: Float32Array
}

const acquisitions = new Map<string, Acquisition>()
const emptyFrame = (): ScopeFrame => ({
  revision: 0,
  state: 'off',
  dt: 0,
  pointsPerDiv: 0,
  traces: [],
  measurements: [],
})

type BufferSource = (probeId: string) => RingBuffer

function latest(buffer: RingBuffer, out: Float32Array, count: number): Float32Array {
  const view = out.subarray(0, Math.min(count, buffer.length))
  buffer.copyLatest(view)
  return view
}

/** 取当前一帧；没有新数据且设置未变时返回缓存 */
export function acquireScope(
  instanceId: string,
  instrument: Instrument,
  settingsRecord: Record<string, unknown>,
  now = performance.now(),
  buffers: BufferSource = (id) => getSimClient().buffer(id),
): ScopeFrame {
  const settings = resolveScope(instrument, settingsRecord)
  const channelBuffers = settings.channels.map((channel) => buffers(scopeProbeId(instanceId, channel.id)))
  let acq = acquisitions.get(instanceId)
  if (!acq) {
    acq = {
      frame: emptyFrame(),
      written: -1,
      key: '',
      arm: settings.arm,
      mode: '',
      source: settings.trigger.source,
      armedWritten: 0,
      captured: false,
      measuredAt: Number.NEGATIVE_INFINITY,
      scratch: new Float32Array(0),
      measureScratch: new Float32Array(0),
    }
    acquisitions.set(instanceId, acq)
  }
  // 布防前的采样只作预触发历史，不能把旧边沿当作下一次单次触发。
  if (
    settings.trigger.mode === 'single' &&
    (acq.mode !== 'single' || acq.arm !== settings.arm || acq.source !== settings.trigger.source)
  ) {
    acq.captured = false
    acq.armedWritten = channelBuffers[settings.trigger.source]?.written ?? 0
  }
  acq.mode = settings.trigger.mode
  acq.arm = settings.arm
  acq.source = settings.trigger.source

  const frozen = !settings.running || (settings.trigger.mode === 'single' && acq.captured)
  if (frozen) {
    if (acq.frame.state !== 'stopped') acq.frame = { ...acq.frame, state: 'stopped', revision: acq.frame.revision + 1 }
    return acq.frame
  }

  const powered = getInstrumentReading(instanceId).status === 'ok'
  const live = settings.channels.map(
    (channel) => powered && channel.enabled && getInstrumentReading(instanceId, channel.id).status === 'ok',
  )
  const sourceBuffer = channelBuffers[settings.trigger.source]
  if (sourceBuffer && sourceBuffer.written < acq.armedWritten) acq.armedWritten = 0
  const reference = channelBuffers.find((buffer, index) => live[index] && buffer.length > 1)
  if (!reference) {
    if (acq.frame.state !== 'off' || acq.frame.traces.some(Boolean))
      acq.frame = { ...emptyFrame(), revision: acq.frame.revision + 1 }
    acq.written = -1
    return acq.frame
  }

  const key = JSON.stringify([settingsRecord, live])
  if (reference.written === acq.written && key === acq.key) return acq.frame
  acq.written = reference.written
  acq.key = key

  const dt = reference.dt
  const screenPoints = Math.max(2, Math.round(screenSeconds(settings) / dt))
  const pointsPerDiv = screenPoints / settings.config.divisions.x
  const pre = Math.round(triggerColumn(settings) * pointsPerDiv)
  const post = screenPoints - pre

  // 自动测量：长记录、10 Hz 刷新
  let measurements = acq.frame.measurements
  if (now - acq.measuredAt >= MEASURE_INTERVAL_MS || measurements.length !== settings.channels.length) {
    acq.measuredAt = now
    if (acq.measureScratch.length < MEASURE_POINTS) acq.measureScratch = new Float32Array(MEASURE_POINTS)
    measurements = channelBuffers.map((buffer, index) =>
      live[index] && settings.channels[index]?.coupling !== 'gnd'
        ? measureSignal(latest(buffer, acq.measureScratch, MEASURE_POINTS), dt)
        : null,
    )
  }

  // 仿真按 50 ms 分片送达，单次尖峰可能早于最近三屏；搜索保留的有界历史。
  const search = settings.trigger.mode === 'single' ? (sourceBuffer?.length ?? 0) : screenPoints * 3 + 2
  if (acq.scratch.length < search) acq.scratch = new Float32Array(search)
  const source = settings.trigger.source
  const sourceSettings = settings.channels[source]
  let start = -1
  let triggered = false
  if (sourceBuffer && live[source] && sourceSettings && sourceSettings.coupling !== 'gnd') {
    const data = latest(sourceBuffer, acq.scratch, search)
    const offset = sourceSettings.coupling === 'ac' ? (measurements[source]?.mean ?? 0) : 0
    const hysteresis = Math.max(1e-6, sourceSettings.voltsPerDiv * 0.05)
    const at = findTrigger(
      data,
      settings.trigger.level + offset,
      settings.trigger.slope,
      hysteresis,
      settings.trigger.mode === 'single' ? Math.max(pre, data.length - (sourceBuffer.written - acq.armedWritten)) : pre,
      data.length - 1 - post,
      settings.trigger.mode === 'single' ? 'first' : 'last',
    )
    if (at >= 0) {
      // 转成"距最新点"的偏移，所有通道共用同一时间网格
      start = data.length - 1 - (Math.round(at) - pre)
      triggered = true
    }
  }
  let state: ScopeState = triggered ? 'triggered' : 'auto'
  if (!triggered) {
    if (settings.trigger.mode !== 'auto') {
      state = settings.trigger.mode === 'single' ? 'ready' : 'waiting'
      if (acq.frame.state !== state || acq.frame.measurements !== measurements)
        acq.frame = { ...acq.frame, state, measurements, revision: acq.frame.revision + 1 }
      return acq.frame
    }
    start = Math.min(screenPoints, reference.length - 1)
  }
  const traces = channelBuffers.map((buffer, index) => {
    if (!live[index] || buffer.length < 2) return null
    const back = Math.min(start, buffer.length - 1)
    const view = latest(buffer, acq.scratch, back + 1)
    return view.slice(0, Math.min(view.length, screenPoints + 1))
  })
  if (triggered && settings.trigger.mode === 'single') {
    // 单次冻结的是本屏数据，测量快照也必须来自这屏，不能沿用节流缓存或更早的长记录。
    measurements = traces.map((trace, index) =>
      trace && settings.channels[index]?.coupling !== 'gnd' ? measureSignal(trace, dt) : null,
    )
    acq.measuredAt = now
    acq.captured = true
    state = 'stopped'
  }
  acq.frame = { revision: acq.frame.revision + 1, state, dt, pointsPerDiv, traces, measurements }
  return acq.frame
}

export function resetScopeAcquisition(instanceId?: string): void {
  if (instanceId === undefined) acquisitions.clear()
  else acquisitions.delete(instanceId)
}

export type ScopeSummary = {
  state: ScopeState
  revision: number
  channels: {
    id: string
    vpp: number | null
    frequency: number | null
    period: number | null
    /** 屏幕上轨迹的最高/最低位置（格，中心为 0，向上为正） */
    top: number | null
    bottom: number | null
    /** 离触发位置最近的一次按触发边沿穿越触发电平处（格，从左缘算起） */
    crossing: number | null
  }[]
}

/** 供测试与无障碍读取的低频摘要，与屏幕绘制使用同一帧 */
export function scopeSummary(frame: ScopeFrame, settings: ScopeSettings): ScopeSummary {
  return {
    state: frame.state,
    revision: frame.revision,
    channels: settings.channels.map((channel, index) => {
      const trace = frame.traces[index]
      const measurement = frame.measurements[index] ?? null
      const offset = channel.coupling === 'ac' ? (measurement?.mean ?? 0) : 0
      let top: number | null = null
      let bottom: number | null = null
      let crossing: number | null = null
      if (trace && channel.enabled) {
        const level = settings.trigger.level + offset
        const target = triggerColumn(settings)
        const sign = settings.trigger.slope === 'rise' ? 1 : -1
        for (let i = 0; i < trace.length; i++) {
          const v = channel.coupling === 'gnd' ? 0 : (trace[i] as number) - offset
          const y = v / channel.voltsPerDiv + channel.position
          top = top === null ? y : Math.max(top, y)
          bottom = bottom === null ? y : Math.min(bottom, y)
          if (i > 0 && (trace[i - 1] as number) * sign < level * sign && (trace[i] as number) * sign >= level * sign) {
            const at = i / frame.pointsPerDiv
            if (crossing === null || Math.abs(at - target) < Math.abs(crossing - target)) crossing = at
          }
        }
      }
      return {
        id: channel.id,
        vpp: measurement?.vpp ?? null,
        frequency: measurement?.frequency ?? null,
        period: measurement?.period ?? null,
        top,
        bottom,
        crossing,
      }
    }),
  }
}
