import type { Instrument, ScopeConfig } from '../../shared/schema/instrument.ts'

// 示波器（INS-09）：触发判定、时基换算、自动测量。纯函数，输入为等间隔采样（技术设计 §7）。

export type Coupling = 'dc' | 'ac' | 'gnd'
export type TriggerMode = 'auto' | 'normal' | 'single'
export type TriggerSlope = 'rise' | 'fall'

export const COUPLINGS: Coupling[] = ['dc', 'ac', 'gnd']
export const TRIGGER_MODES: TriggerMode[] = ['auto', 'normal', 'single']
export const TRIGGER_SLOPES: TriggerSlope[] = ['rise', 'fall']

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

export type ScopeSettings = {
  config: ScopeConfig
  channels: ScopeChannelSettings[]
  secondsPerDiv: number
  horizontalPosition: number
  trigger: { mode: TriggerMode; source: number; slope: TriggerSlope; level: number }
  running: boolean
  /** 单次触发重新布防计数，每按一次加 1 */
  arm: number
}

export type SignalMeasurement = {
  max: number
  min: number
  vpp: number
  mean: number
  /** 未检测到至少一个完整周期时为 null */
  frequency: number | null
  period: number | null
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
  return { max, min, vpp, mean, frequency, period }
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
