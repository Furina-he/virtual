import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveScope } from '../../domain/instruments/index.ts'
import { LongWindow } from '../../domain/instruments/long-window.ts'
import { scopeProbeId } from '../../domain/measurement/plan.ts'
import { Instrument } from '../../shared/schema/instrument.ts'
import { clearInstrumentReadings, setInstrumentReading } from './instrument-readings'
import { RingBuffer } from './ring-buffer'
import { acquireScope, resetScopeAcquisition, scopeSummary } from './scope-acquisition'

const scope = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-oscilloscope/instrument.json', 'utf8')))
const dt = 1e-6
const buffers = new Map<string, RingBuffer>()
const buffer = (id: string) => {
  let b = buffers.get(id)
  if (!b) {
    b = new RingBuffer(1 << 16)
    buffers.set(id, b)
  }
  return b
}
let t = 0
function feed(seconds: number, fn: (time: number) => number) {
  const count = Math.round(seconds / dt)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = fn(t + i * dt)
  buffer(scopeProbeId('s', 'CH1')).push(samples, t, dt)
  buffer(scopeProbeId('s', 'CH2')).push(
    samples.map((v) => v / 2),
    t,
    dt,
  )
  t += count * dt
}
const sine = (time: number) => Math.sin(2 * Math.PI * 1000 * time)
let clock = 0
const acquire = (settings: Record<string, unknown> = {}) => {
  clock += 200
  return acquireScope('s', scope, settings, clock, buffer)
}
const live = () => {
  for (const key of ['main', 'CH1', 'CH2']) setInstrumentReading('s', { text: '', unit: '', status: 'ok' }, key)
}

afterEach(() => {
  resetScopeAcquisition()
  clearInstrumentReadings()
  buffers.clear()
  t = 0
})

describe('示波器采集', () => {
  it('uses sufficient certified stream history even when the shorter raw window already has two periods', () => {
    live()
    const raw = new RingBuffer(1 << 18)
    const observed = new LongWindow()
    const step = 2e-6
    for (let chunk = 0; chunk < 8; chunk++) {
      const t0 = chunk * 25_000 * step
      const samples = Float32Array.from({ length: 25_000 }, (_, i) => Math.sin(2 * Math.PI * 40 * (t0 + i * step)))
      raw.push(samples, t0, step)
      observed.push(samples, t0, step)
    }
    const frame = acquireScope(
      's',
      scope,
      {},
      1000,
      () => raw,
      () => observed,
    )
    expect(frame.measurements[0]?.completeCycles).toBeGreaterThanOrEqual(6)
    expect(frame.windows?.[0]?.source).toBe('stream')
    expect(frame.measurements[0]?.frequency).toBeCloseTo(40, 5)
  })

  it('measures 1 Hz and a 1025 Hz carrier on a bounded 2 us long screen without enlarging raw buffers', () => {
    live()
    const raw = new Map<string, RingBuffer>()
    const observed = new Map<string, LongWindow>()
    for (const id of ['CH1', 'CH2']) {
      raw.set(scopeProbeId('s', id), new RingBuffer(1 << 18))
      observed.set(scopeProbeId('s', id), new LongWindow())
    }
    const step = 2e-6
    for (let chunk = 0; chunk < 70; chunk++) {
      const t0 = chunk * 25_000 * step
      for (const [id, frequency] of [
        ['CH1', 1],
        ['CH2', 1025],
      ] as const) {
        const key = scopeProbeId('s', id)
        const samples = Float32Array.from({ length: 25_000 }, (_, i) =>
          Math.sin(2 * Math.PI * frequency * (t0 + i * step)),
        )
        raw.get(key)?.push(samples, t0, step)
        observed.get(key)?.push(samples, t0, step)
      }
    }
    const frame = acquireScope(
      's',
      scope,
      { tdiv: 0.2 },
      1000,
      (id) => raw.get(id) as RingBuffer,
      (id) => observed.get(id) as LongWindow,
    )
    expect(frame.state).toBe('auto')
    expect(frame.dt).toBe(step)
    expect(frame.traces).toEqual([null, null])
    expect(frame.envelopes?.[0]?.min.length).toBeLessThanOrEqual(2048)
    expect(frame.envelopes?.[1]?.max.length).toBeLessThanOrEqual(2048)
    expect(frame.measurements[0]?.frequency).toBeCloseTo(1, 5)
    expect(frame.measurements[1]?.frequency).toBeCloseTo(1025, 3)
    expect(frame.windows?.[0]).toMatchObject({ rawStep: step, source: 'stream', frozen: false })
    expect(raw.get(scopeProbeId('s', 'CH1'))?.data.byteLength).toBe(1 << 20)
    const summary = scopeSummary(frame, resolveScope(scope, { tdiv: 0.2 }))
    expect(summary.channels[0]?.top).toBeCloseTo(2, 5)
    expect(summary.channels[0]?.bottom).toBeCloseTo(-2, 5)
    const stopped = acquireScope(
      's',
      scope,
      { tdiv: 0.2, run: 0 },
      1200,
      (id) => raw.get(id) as RingBuffer,
      (id) => observed.get(id) as LongWindow,
    )
    expect(stopped.state).toBe('stopped')
    expect(stopped.windows?.[0]?.frozen).toBe(true)
    expect(stopped.envelopes).toBe(frame.envelopes)
  })

  it('未上电或通道未接入时不显示轨迹', () => {
    feed(0.01, sine)
    expect(acquire().state).toBe('off')
  })

  it('自动触发：触发点落在屏幕中心，水平位移移动触发点；测量来自真实采样', () => {
    live()
    feed(0.01, sine)
    const frame = acquire()
    expect(frame.state).toBe('triggered')
    expect(frame.pointsPerDiv).toBe(200)
    expect(frame.traces[0]?.length).toBe(2001)
    const summary = scopeSummary(frame, resolveScope(scope))
    expect(summary.channels[0]?.crossing).toBeCloseTo(5, 1)
    expect(summary.channels[0]?.vpp).toBeCloseTo(2, 2)
    expect(summary.channels[0]?.frequency).toBeCloseTo(1000, 0)
    expect(summary.channels[1]?.vpp).toBeCloseTo(1, 2)
    // 0.5 V/div：±1 V 对应 ±2 格；垂直位移 +1 格
    expect(summary.channels[0]?.top).toBeCloseTo(2, 1)
    const moved = { hpos: -2, ch1_pos: 1, ch1_vdiv: 1 }
    const shifted = scopeSummary(acquire(moved), resolveScope(scope, moved))
    expect(shifted.channels[0]?.crossing).toBeCloseTo(3, 1)
    expect(shifted.channels[0]?.top).toBeCloseTo(2, 1)
    expect(shifted.channels[0]?.bottom).toBeCloseTo(0, 1)
  })

  it('AC 耦合去掉直流，GND 耦合显示零电平且不测量', () => {
    live()
    feed(0.01, (time) => 3 + sine(time))
    const ac = { ch1_coupling: 1 }
    const summary = scopeSummary(acquire(ac), resolveScope(scope, ac))
    expect(summary.channels[0]?.top).toBeCloseTo(2, 1)
    expect(summary.channels[0]?.bottom).toBeCloseTo(-2, 1)
    const gnd = { ch1_coupling: 2 }
    const grounded = scopeSummary(acquire(gnd), resolveScope(scope, gnd))
    expect(grounded.channels[0]).toMatchObject({ top: 0, bottom: 0, vpp: null })
  })

  it('常规触发无触发时保留上一屏；自动触发无触发时滚动显示', () => {
    live()
    feed(0.01, sine)
    const first = acquire({ trig_mode: 1 })
    expect(first.state).toBe('triggered')
    feed(0.01, () => 0)
    const waiting = acquire({ trig_mode: 1 })
    expect(waiting.state).toBe('waiting')
    expect(waiting.traces).toBe(first.traces)
    const auto = acquire({ trig_mode: 0, trig_level: 5 })
    expect(auto.state).toBe('auto')
    expect(auto.traces[0]?.every((v) => v === 0)).toBe(true)
  })

  it('单次触发捕获后冻结，再次布防后重新捕获；停止时冻结', () => {
    live()
    feed(0.005, () => 0)
    expect(acquire({ trig_mode: 2, arm: 1 }).state).toBe('ready')
    feed(0.01, sine)
    const captured = acquire({ trig_mode: 2, arm: 1 })
    expect(captured.state).toBe('stopped')
    feed(0.01, (time) => 2 * sine(time))
    expect(acquire({ trig_mode: 2, arm: 1 }).traces).toBe(captured.traces)
    const waiting = acquire({ trig_mode: 2, arm: 2 })
    expect(waiting.state).toBe('ready')
    expect(waiting.traces).toBe(captured.traces)
    expect(acquire({ trig_mode: 2, arm: 2 })).toBe(waiting)
    feed(0.01, () => -1)
    expect(acquire({ trig_mode: 2, arm: 2 }).state).toBe('ready')
    feed(0.004, () => 3)
    const rearmed = acquire({ trig_mode: 2, arm: 2 })
    expect(rearmed.state).toBe('stopped')
    expect(rearmed.traces).not.toBe(captured.traces)
    expect(Math.max(...(rearmed.traces[0] ?? []))).toBeCloseTo(3, 1)
    expect(Math.min(...(rearmed.traces[0] ?? []))).toBeCloseTo(-1, 1)
    const stopped = acquire({ run: 0 })
    feed(0.01, sine)
    expect(acquire({ run: 0 })).toBe(stopped)
    expect(stopped.state).toBe('stopped')
  })

  it('从连续采集切到单次时不捕获已有历史，等待布防后的新边沿', () => {
    live()
    feed(0.01, sine)
    const continuous = acquire()
    expect(continuous.state).toBe('triggered')
    const waiting = acquire({ trig_mode: 2, arm: 1 })
    expect(waiting.state).toBe('ready')
    expect(waiting.traces).toBe(continuous.traces)
    feed(0.01, () => -1)
    expect(acquire({ trig_mode: 2, arm: 1 }).state).toBe('ready')
    feed(0.004, () => 1)
    const captured = acquire({ trig_mode: 2, arm: 1 })
    expect(captured.state).toBe('stopped')
    expect(Math.min(...(captured.traces[0] ?? []))).toBe(-1)
    expect(Math.max(...(captured.traces[0] ?? []))).toBe(1)
  })

  it('单次捕获在测量节流间隔内也冻结本屏读数，不沿用历史测量', () => {
    live()
    feed(0.01, (time) => 5 * sine(time))
    const initial = acquireScope('s', scope, {}, 0, buffer)
    expect(initial.measurements[0]?.vpp).toBe(10)
    const settings = { trig_mode: 2, arm: 1 }
    const waiting = acquireScope('s', scope, settings, 10, buffer)
    expect(waiting.measurements).toBe(initial.measurements)
    feed(0.01, () => -1)
    feed(0.004, () => 3)
    const captured = acquireScope('s', scope, settings, 50, buffer)
    expect(captured.state).toBe('stopped')
    expect(captured.measurements[0]).toMatchObject({ min: -1, max: 3, vpp: 4, frequency: null, period: null })
    expect(captured.measurements[1]?.vpp).toBe(2)
    expect(acquireScope('s', scope, settings, 200, buffer)).toBe(captured)
  })

  it('连续采集的自动测量仍按 10 Hz 节流', () => {
    live()
    feed(0.01, sine)
    const initial = acquireScope('s', scope, {}, 0, buffer)
    feed(0.01, (time) => 2 * sine(time))
    expect(acquireScope('s', scope, {}, 50, buffer).measurements).toBe(initial.measurements)
    feed(0.01, (time) => 2 * sine(time))
    const updated = acquireScope('s', scope, {}, 100, buffer)
    expect(updated.measurements).not.toBe(initial.measurements)
    expect(updated.measurements[0]?.vpp).toBe(4)
  })

  it('单次搜索保留历史并捕获 50 ms 数据块中最早的新尖峰', () => {
    live()
    feed(0.005, () => -1)
    const settings = { trig_mode: 2, arm: 1 }
    expect(acquire(settings).state).toBe('ready')
    feed(0.05, (time) => (time >= 0.01 && time < 0.0102 ? 1 : time >= 0.025 && time < 0.0252 ? 3 : -1))
    const captured = acquire(settings)
    expect(captured.state).toBe('stopped')
    expect(captured.measurements[0]).toMatchObject({ min: -1, max: 1, vpp: 2 })
    expect(captured.traces[0]?.length).toBe(2001)
    expect(scopeSummary(captured, resolveScope(scope, settings)).channels[0]?.crossing).toBeCloseTo(5, 1)
    feed(0.01, sine)
    expect(acquire(settings)).toBe(captured)
  })

  it('手动冻结（run=0）在带电改源重载后仍保留冻结帧，且允许在冻结帧上切换 X-Y 与光标测量', () => {
    live()
    feed(0.01, sine)
    const running = acquire({ run: 1 })
    expect(running.state).toBe('triggered')
    expect(running.measurements[0]?.vpp).toBeCloseTo(2, 2)

    const frozen = acquire({ run: 0 })
    expect(frozen.state).toBe('stopped')
    expect(frozen.windows?.[0]?.frozen).toBe(true)

    // 模拟带电改信号发生器参数触发重载：保留已手动冻结的示波器实例
    resetScopeAcquisition(undefined, { preserveFrozenIds: new Set(['s']) })
    buffer(scopeProbeId('s', 'CH1')).clear()
    buffer(scopeProbeId('s', 'CH2')).clear()
    t = 0
    feed(0.01, (time) => 4 * Math.sin(2 * Math.PI * 2500 * time))

    const stillFrozen = acquire({ run: 0, xy: 1, cursor_mode: 1, cursor_a: -1, cursor_b: 1 })
    expect(stillFrozen.state).toBe('stopped')
    expect(stillFrozen.measurements[0]?.vpp).toBeCloseTo(2, 2)
    expect(stillFrozen.measurements[0]?.frequency).toBeCloseTo(1000, 0)

    const summary = scopeSummary(
      stillFrozen,
      resolveScope(scope, { run: 0, xy: 1, cursor_mode: 1, cursor_a: -1, cursor_b: 1 }),
    )
    expect(summary.displayMode).toBe('xy')
    expect(summary.xy?.xVpp).toBeCloseTo(2, 2)
    expect(summary.cursors?.deltaT).toBeCloseTo(4e-4, 8)

    // 解除冻结（run=1）后立即采集改源后的 8 Vpp / 2500 Hz 新波形
    const unfrozen = acquire({ run: 1 })
    expect(unfrozen.state).toBe('triggered')
    expect(unfrozen.measurements[0]?.vpp).toBeCloseTo(8, 1)
    expect(unfrozen.measurements[0]?.frequency).toBeCloseTo(2500, 0)
  })

  it('在线参数 alter 后自动测量立即切至变更后采样，不混入环形缓冲内旧频率历史', () => {
    live()
    const raw = new RingBuffer(1 << 18)
    const observed = new LongWindow()
    const step = 0.0005
    let time = 0
    const pushFreq = (seconds: number, hz: number) => {
      const count = Math.round(seconds / step)
      const samples = Float32Array.from({ length: count }, (_, i) =>
        Math.sin(2 * Math.PI * hz * (time + i * step)) >= 0 ? 3.4 : 0,
      )
      raw.push(samples, time, step)
      observed.push(samples, time, step)
      time += count * step
    }

    // 模拟 SD-21 初始 30 r/min (30 Hz) 持续 2 s，旧采样留在 65536 点自动测量窗口内
    pushFreq(2.0, 30)
    const before = acquireScope(
      's',
      scope,
      { tdiv: 0.05 },
      100,
      () => raw,
      () => observed,
    )
    expect(before.measurements[0]?.frequency).toBeGreaterThan(29.5)
    expect(before.measurements[0]?.frequency).toBeLessThan(30.5)

    // 在线 alter 切换至 60 r/min：清空观测窗并标记环形缓冲边界，新采样到达前保持上次读数避免瞬时归零闪烁
    observed.clear()
    raw.markBoundary()
    const waiting = acquireScope(
      's',
      scope,
      { tdiv: 0.05 },
      120,
      () => raw,
      () => observed,
    )
    expect(waiting.measurements[0]?.frequency).toBeGreaterThan(29.5)
    expect(raw.length).toBe(4000)

    // 即使尚在 100 ms 节流窗内，首批 0.2 s 的 60 Hz 新采样到达后即刻切换至 ~60 Hz（不混入 2 s 旧 30 Hz 历史）
    pushFreq(0.2, 60)
    const after = acquireScope(
      's',
      scope,
      { tdiv: 0.05 },
      140,
      () => raw,
      () => observed,
    )
    expect(after.measurements[0]?.frequency).toBeGreaterThan(59)
    expect(after.measurements[0]?.frequency).toBeLessThan(61)
  })
})
