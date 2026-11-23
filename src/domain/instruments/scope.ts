import type { Instrument, ScopeConfig } from '../../shared/schema/instrument.ts'

// 示波器（INS-09/11）：触发判定、时基换算、自动测量、X-Y 配准与双光标测量。纯函数，输入为等间隔采样（技术设计 §7）。

export type Coupling = 'dc' | 'ac' | 'gnd'
export type TriggerMode = 'auto' | 'normal' | 'single'
export type TriggerSlope = 'rise' | 'fall'
export type ScopeDisplayMode = 'yt' | 'xy'
export type CursorMode = 'off' | 'time' | 'voltage'

export const COUPLINGS: Coupling[] = ['dc', 'ac', 'gnd']
export const TRIGGER_MODES: TriggerMode[] = ['auto', 'normal', 'single']
export const TRIGGER_SLOPES: TriggerSlope[] = ['rise', 'fall']
export const SCOPE_DISPLAY_MODES: ScopeDisplayMode[] = ['yt', 'xy']
export const CURSOR_MODES: CursorMode[] = ['off', 'time', 'voltage']

/** 垂直位移范围（格），水平位移范围为 ±半屏 */
export const SCOPE_POSITION_LIMIT = 4
export const SCOPE_TRIGGER_LEVEL_LIMIT = 50

export type ScopeChannelSettings = {
  id: string
  label: string
  enabled: boolean
  voltsPerDiv: number
  position: number
  coupling: Coupling
}

export type ScopeCursors = {
  mode: CursorMode
  source: number
  /** 光标 A 相对屏幕中心的格数偏移 */
  a: number
  /** 光标 B 相对屏幕中心的格数偏移 */
  b: number
}

export type ScopeSettings = {
  config: ScopeConfig
  channels: ScopeChannelSettings[]
  secondsPerDiv: number
  horizontalPosition: number
  trigger: { mode: TriggerMode; source: number; slope: TriggerSlope; level: number }
  running: boolean
  /** 单次触发重新布防计数，每按一次加 1 */
  arm: number
  displayMode: ScopeDisplayMode
  cursors: ScopeCursors
}

export type XyPoint = {
  xV: number
  yV: number
  xDiv: number
  yDiv: number
}

export type XyCurveSummary = {
  count: number
  xMinV: number
  xMaxV: number
  xVpp: number
  yMinV: number
  yMaxV: number
  yVpp: number
  correlation: number
  /** 归一化围合面积比 [0, 1]：同相/反相直线约为 0，90° 正交椭圆/圆约为 1 */
  areaRatio: number
}

export type CursorMeasurement = {
  mode: Exclude<CursorMode, 'off'>
  sourceChannelId: string
  aDiv: number
  bDiv: number
  t1: number | null
  t2: number | null
  deltaT: number | null
  frequency: number | null
  v1: number | null
  v2: number | null
  deltaV: number | null
}

export type SignalMeasurement = {
  max: number
  min: number
  vpp: number
  mean: number
  /** 未检测到至少一个完整周期时为 null */
  frequency: number | null
  period: number | null
  /** Actual complete rising-edge intervals retained in the measurement window. */
  completeCycles?: number
}

const key = (channel: { id: string }, field: string) => `${channel.id.toLowerCase()}_${field}`

function num(settings: Record<string, unknown>, k: string, fallback: number): number {
  const v = settings[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function resolveScope(instrument: Instrument, settings: Record<string, unknown> = {}): ScopeSettings {
  const config = instrument.scope
  if (!config) throw new Error(`${instrument.name}不是示波器。`)
  return {
    config,
    channels: config.channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      enabled: num(settings, key(channel, 'on'), 1) === 1,
      voltsPerDiv: num(settings, key(channel, 'vdiv'), config.defaultVoltsPerDiv),
      position: num(settings, key(channel, 'pos'), 0),
      coupling: COUPLINGS[num(settings, key(channel, 'coupling'), 0)] ?? 'dc',
    })),
    secondsPerDiv: num(settings, 'tdiv', config.defaultSecondsPerDiv),
    horizontalPosition: num(settings, 'hpos', 0),
    trigger: {
      mode: TRIGGER_MODES[num(settings, 'trig_mode', 0)] ?? 'auto',
      source: Math.min(config.channels.length - 1, Math.max(0, num(settings, 'trig_src', 0))),
      slope: TRIGGER_SLOPES[num(settings, 'trig_slope', 0)] ?? 'rise',
      level: num(settings, 'trig_level', 0),
    },
    running: num(settings, 'run', 1) === 1,
    arm: num(settings, 'arm', 0),
    displayMode: num(settings, 'xy', 0) === 1 ? 'xy' : 'yt',
    cursors: {
      mode: CURSOR_MODES[num(settings, 'cursor_mode', 0)] ?? 'off',
      source: Math.min(config.channels.length - 1, Math.max(0, num(settings, 'cursor_src', 0))),
      a: num(settings, 'cursor_a', -2),
      b: num(settings, 'cursor_b', 2),
    },
  }
}

export function scopeDefaults(instrument: Instrument): Record<string, number> {
  const config = instrument.scope
  if (!config) return {}
  const defaults: Record<string, number> = {
    tdiv: config.defaultSecondsPerDiv,
    hpos: 0,
    trig_mode: 0,
    trig_src: 0,
    trig_slope: 0,
    trig_level: 0,
    run: 1,
    arm: 0,
    xy: 0,
    cursor_mode: 0,
    cursor_src: 0,
    cursor_a: -2,
    cursor_b: 2,
  }
  for (const channel of config.channels) {
    defaults[key(channel, 'on')] = 1
    defaults[key(channel, 'vdiv')] = config.defaultVoltsPerDiv
    defaults[key(channel, 'pos')] = 0
    defaults[key(channel, 'coupling')] = 0
  }
  return defaults
}

/** undefined：不是示波器设置；true/false：是否为允许的值 */
export function scopeSettingValid(instrument: Instrument, k: string, v: unknown): boolean | undefined {
  const config = instrument.scope
  if (!config) return undefined
  const isNumber = typeof v === 'number' && Number.isFinite(v)
  const int = (max: number) => isNumber && Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max
  const within = (limit: number) => isNumber && Math.abs(v as number) <= limit
  for (const channel of config.channels) {
    if (k === key(channel, 'on')) return v === 0 || v === 1
    if (k === key(channel, 'vdiv')) return isNumber && config.voltsPerDiv.includes(v as number)
    if (k === key(channel, 'pos')) return within(SCOPE_POSITION_LIMIT)
    if (k === key(channel, 'coupling')) return int(COUPLINGS.length - 1)
  }
  switch (k) {
    case 'tdiv':
      return isNumber && config.secondsPerDiv.includes(v as number)
    case 'hpos':
      return within(config.divisions.x / 2)
    case 'trig_mode':
      return int(TRIGGER_MODES.length - 1)
    case 'trig_src':
      return int(config.channels.length - 1)
    case 'trig_slope':
      return int(TRIGGER_SLOPES.length - 1)
    case 'trig_level':
      return within(SCOPE_TRIGGER_LEVEL_LIMIT)
    case 'run':
      return v === 0 || v === 1
    case 'arm':
      return isNumber && Number.isInteger(v) && (v as number) >= 0
    case 'xy':
      return v === 0 || v === 1
    case 'cursor_mode':
      return int(CURSOR_MODES.length - 1)
    case 'cursor_src':
      return int(config.channels.length - 1)
    case 'cursor_a':
    case 'cursor_b':
      return within(Math.max(config.divisions.x, config.divisions.y) / 2)
    default:
      return undefined
  }
}

export function screenSeconds(settings: Pick<ScopeSettings, 'config' | 'secondsPerDiv'>): number {
  return settings.secondsPerDiv * settings.config.divisions.x
}

/**
 * 仿真步长：每屏不少于 pointsPerScreen 点，且每个信号周期不少于 1000 点；
 * 每屏最多 50 倍 pointsPerScreen 点（超出时与实物一样出现混叠，而不是让仿真无限变慢）。
 */
export function scopeSampleStep(screens: number[], pointsPerScreen: number, shortestPeriod?: number): number {
  const screen = Math.min(...screens)
  let step = screen / pointsPerScreen
  if (shortestPeriod) step = Math.min(step, shortestPeriod / 1000)
  step = Math.max(step, Math.max(...screens) / (pointsPerScreen * 50), 1e-9)
  return Number(step.toPrecision(3))
}

/**
 * 在 [from, to] 内找满足边沿和迟滞的触发点，默认取最后一个，单次可取第一个；返回分数下标，没有返回 -1。
 * 迟滞：上升沿要求自上次触发后先低于 level − hysteresis，下降沿反之。
 */
export function findTrigger(
  data: ArrayLike<number>,
  level: number,
  slope: TriggerSlope,
  hysteresis: number,
  from = 1,
  to = data.length - 1,
  order: 'first' | 'last' = 'last',
): number {
  const sign = slope === 'rise' ? 1 : -1
  const lv = level * sign
  let armed = false
  let found = -1
  const start = Math.max(1, Math.floor(from))
  const end = Math.min(data.length - 1, Math.floor(to))
  if (start > end) return -1
  // 迟滞布防可能早于搜索区间；扫描已有前缀，但只返回区间内的触发。
  for (let k = 1; k <= end; k++) {
    const prev = (data[k - 1] as number) * sign
    const cur = (data[k] as number) * sign
    if (prev < lv - hysteresis) armed = true
    if (armed && prev < lv && cur >= lv) {
      if (k >= start) {
        found = k - 1 + (lv - prev) / (cur - prev)
        if (order === 'first') return found
      }
      armed = false
    }
  }
  return found
}

/** Vpp、频率、周期：中值电平上升穿越计数，线性插值穿越时刻，取首末穿越间的整周期 */
export function measureSignal(data: ArrayLike<number>, dt: number): SignalMeasurement | null {
  const count = data.length
  if (count < 2 || !(dt > 0)) return null
  let max = Number.NEGATIVE_INFINITY
  let min = Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < count; i++) {
    const v = data[i] as number
    if (!Number.isFinite(v)) return null
    if (v > max) max = v
    if (v < min) min = v
    sum += v
  }
  const vpp = max - min
  let mean = sum / count
  let frequency: number | null = null
  let period: number | null = null
  let completeCycles = 0
  // 小于 1 mV 或相对直流电平 0.1% 的起伏不当作周期信号
  if (vpp > Math.max(1e-3, Math.abs(mean) * 1e-3)) {
    const mid = (max + min) / 2
    const hysteresis = vpp * 0.1
    let armed = false
    let first = -1
    let last = -1
    let crossings = 0
    for (let k = 1; k < count; k++) {
      const prev = data[k - 1] as number
      const cur = data[k] as number
      if (prev < mid - hysteresis) armed = true
      if (armed && prev < mid && cur >= mid) {
        const at = k - 1 + (mid - prev) / (cur - prev)
        if (first < 0) first = at
        last = at
        crossings++
        armed = false
      }
    }
    if (crossings >= 2 && last > first) {
      completeCycles = crossings - 1
      period = ((last - first) * dt) / (crossings - 1)
      frequency = 1 / period
      // 整周期平均值，供 AC 耦合去直流
      let s = 0
      const a = Math.ceil(first)
      const b = Math.floor(last)
      for (let k = a; k < b; k++) s += data[k] as number
      if (b > a) mean = s / (b - a)
    }
  }
  return { max, min, vpp, mean, frequency, period, completeCycles }
}

/** 耦合后的直流偏移：AC 去掉平均值，GND 输入接地 */
export function couplingOffset(coupling: Coupling, measurement: SignalMeasurement | null): number {
  return coupling === 'ac' ? (measurement?.mean ?? 0) : 0
}

/** 触发点在屏幕上的水平位置（格，从左缘算起） */
export function triggerColumn(settings: Pick<ScopeSettings, 'config' | 'horizontalPosition'>): number {
  const half = settings.config.divisions.x / 2
  return Math.min(settings.config.divisions.x, Math.max(0, half + settings.horizontalPosition))
}

export function formatSeconds(seconds: number): string {
  const abs = Math.abs(seconds)
  if (abs >= 1) return `${Number(seconds.toPrecision(4))} s`
  if (abs >= 1e-3) return `${Number((seconds * 1e3).toPrecision(4))} ms`
  if (abs >= 1e-6) return `${Number((seconds * 1e6).toPrecision(4))} μs`
  return `${Number((seconds * 1e9).toPrecision(4))} ns`
}

/**
 * X-Y 模式（INS-11）：将 CH1 (X) 与 CH2 (Y) 的同步采样配准为二维轨迹点及统计特征（李萨如图形、电压比较器传输特性）。
 */
export function buildXyTrace(
  settings: ScopeSettings,
  xTrace: ArrayLike<number> | null | undefined,
  yTrace: ArrayLike<number> | null | undefined,
  measurements?: readonly (SignalMeasurement | null)[],
): { points: XyPoint[]; summary: XyCurveSummary | null } {
  const chX = settings.channels[0]
  const chY = settings.channels[1]
  if (!chX?.enabled || !chY?.enabled || !xTrace || !yTrace) return { points: [], summary: null }
  const count = Math.min(xTrace.length, yTrace.length)
  if (count < 2) return { points: [], summary: null }
  const offsetX = couplingOffset(chX.coupling, measurements?.[0] ?? null)
  const offsetY = couplingOffset(chY.coupling, measurements?.[1] ?? null)
  const points: XyPoint[] = []
  let xMinV = Number.POSITIVE_INFINITY
  let xMaxV = Number.NEGATIVE_INFINITY
  let yMinV = Number.POSITIVE_INFINITY
  let yMaxV = Number.NEGATIVE_INFINITY
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < count; i++) {
    const rawX = xTrace[i] as number
    const rawY = yTrace[i] as number
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return { points: [], summary: null }
    const xV = chX.coupling === 'gnd' ? 0 : rawX - offsetX
    const yV = chY.coupling === 'gnd' ? 0 : rawY - offsetY
    const xDiv = xV / chX.voltsPerDiv + chX.position
    const yDiv = yV / chY.voltsPerDiv + chY.position
    if (xV < xMinV) xMinV = xV
    if (xV > xMaxV) xMaxV = xV
    if (yV < yMinV) yMinV = yV
    if (yV > yMaxV) yMaxV = yV
    sumX += xV
    sumY += yV
    points.push({ xV, yV, xDiv, yDiv })
  }
  const meanX = sumX / count
  const meanY = sumY / count
  let cov = 0
  let varX = 0
  let varY = 0
  for (let i = 0; i < count; i++) {
    const pt = points[i] as XyPoint
    const dx = pt.xV - meanX
    const dy = pt.yV - meanY
    cov += dx * dy
    varX += dx * dx
    varY += dy * dy
  }
  const denom = Math.sqrt(varX * varY)
  const correlation = denom > 1e-18 ? Math.max(-1, Math.min(1, cov / denom)) : 0
  const xVpp = xMaxV - xMinV
  const yVpp = yMaxV - yMinV
  // 在 X 中值穿越处插值比较上升分支与下降分支的 Y 差值：单值传输曲线恒为 0，李萨如椭圆等于 |sin(φ)|
  let upSum = 0
  let upCount = 0
  let downSum = 0
  let downCount = 0
  if (xVpp > 1e-6 && yVpp > 1e-6) {
    const midX = (xMinV + xMaxV) / 2
    for (let i = 1; i < count; i++) {
      const p0 = points[i - 1] as XyPoint
      const p1 = points[i] as XyPoint
      if (p0.xV < midX && p1.xV >= midX && p1.xV > p0.xV) {
        const frac = (midX - p0.xV) / (p1.xV - p0.xV)
        upSum += p0.yV + (p1.yV - p0.yV) * frac
        upCount++
      } else if (p0.xV > midX && p1.xV <= midX && p0.xV > p1.xV) {
        const frac = (p0.xV - midX) / (p0.xV - p1.xV)
        downSum += p0.yV + (p1.yV - p0.yV) * frac
        downCount++
      }
    }
  }
  const areaRatio =
    upCount > 0 && downCount > 0 && yVpp > 1e-6
      ? Math.max(0, Math.min(1, Math.abs(upSum / upCount - downSum / downCount) / yVpp))
      : 0
  return {
    points,
    summary: {
      count,
      xMinV,
      xMaxV,
      xVpp,
      yMinV,
      yMaxV,
      yVpp,
      correlation,
      areaRatio,
    },
  }
}

function interpolateTraceAtColumn(
  trace: ArrayLike<number>,
  colDiv: number,
  divX: number,
  coupling: Coupling,
  offset: number,
): number | null {
  if (trace.length < 2 || !(divX > 0)) return null
  if (coupling === 'gnd') return 0
  const clampedCol = Math.max(0, Math.min(divX, colDiv))
  const exactIndex = (clampedCol / divX) * (trace.length - 1)
  const i0 = Math.min(trace.length - 1, Math.max(0, Math.floor(exactIndex)))
  const i1 = Math.min(trace.length - 1, i0 + 1)
  const frac = exactIndex - i0
  const v0 = trace[i0] as number
  const v1 = trace[i1] as number
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return null
  return v0 + (v1 - v0) * frac - offset
}

/**
 * 双光标测量（INS-11）：
 * - time 模式：计算 T1、T2、Δt = T2 − T1、1/|Δt|，并在选中通道轨迹存在时插值出光标处的瞬时电压 V1、V2、ΔV；
 * - voltage 模式：计算选中通道在两条水平光标线处的电压 V1、V2 与 ΔV = V2 − V1。
 */
export function measureCursors(
  settings: ScopeSettings,
  traces: readonly (ArrayLike<number> | null | undefined)[] = [],
  measurements: readonly (SignalMeasurement | null | undefined)[] = [],
): CursorMeasurement | null {
  const { mode, source, a, b } = settings.cursors
  if (mode === 'off') return null
  const sourceIndex = Math.min(settings.channels.length - 1, Math.max(0, source))
  const channel = settings.channels[sourceIndex]
  if (!channel) return null
  const { x: divX, y: divY } = settings.config.divisions
  if (mode === 'time') {
    const halfX = divX / 2
    const aDiv = Math.max(-halfX, Math.min(halfX, a))
    const bDiv = Math.max(-halfX, Math.min(halfX, b))
    const t1 = aDiv * settings.secondsPerDiv
    const t2 = bDiv * settings.secondsPerDiv
    const deltaT = t2 - t1
    const frequency = Math.abs(deltaT) > 1e-12 ? 1 / Math.abs(deltaT) : null
    const trace = channel.enabled ? traces[sourceIndex] : null
    const offset = couplingOffset(channel.coupling, measurements[sourceIndex] ?? null)
    const v1 = trace ? interpolateTraceAtColumn(trace, halfX + aDiv, divX, channel.coupling, offset) : null
    const v2 = trace ? interpolateTraceAtColumn(trace, halfX + bDiv, divX, channel.coupling, offset) : null
    const deltaV = v1 !== null && v2 !== null ? v2 - v1 : null
    return {
      mode: 'time',
      sourceChannelId: channel.id,
      aDiv,
      bDiv,
      t1,
      t2,
      deltaT,
      frequency,
      v1,
      v2,
      deltaV,
    }
  }
  const halfY = divY / 2
  const aDiv = Math.max(-halfY, Math.min(halfY, a))
  const bDiv = Math.max(-halfY, Math.min(halfY, b))
  const v1 = (aDiv - channel.position) * channel.voltsPerDiv
  const v2 = (bDiv - channel.position) * channel.voltsPerDiv
  const deltaV = v2 - v1
  return {
    mode: 'voltage',
    sourceChannelId: channel.id,
    aDiv,
    bDiv,
    t1: null,
    t2: null,
    deltaT: null,
    frequency: null,
    v1,
    v2,
    deltaV,
  }
}
