import type { Instrument, SignalSource, SignalWaveform } from '../../shared/schema/instrument.ts'

// 函数信号发生器与示波器内置信号源（INS-08/10）共用同一套模型：设置 → ngspice SIN/PULSE 源。
// 幅值为峰峰值（Vpp），占空比为百分数；输出关闭或未上电时不生成源，输出端开路。

export const WAVEFORM_LABEL: Record<SignalWaveform, string> = {
  sine: '正弦波',
  square: '方波',
  triangle: '三角波',
  sawtooth: '锯齿波',
  ttl: 'TTL 脉冲',
}

/** PULSE 边沿占周期的比例；仿真步长取周期的 1/1000，与之对应 */
const EDGE = 1e-3

export type ResolvedSource = {
  source: SignalSource
  waveform: SignalWaveform
  frequency: number
  amplitude: number
  offset: number
  duty: number
  enabled: boolean
}

export const sourceKey = (source: Pick<SignalSource, 'id'>, field: string) => `${source.id.toLowerCase()}_${field}`

function value(settings: Record<string, unknown>, key: string, fallback: number): number {
  const v = settings[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 可独立设置的通道（不含跟随其他通道的同步输出） */
export function adjustableSources(instrument: Instrument): SignalSource[] {
  return (instrument.signalSources ?? []).filter((source) => !source.syncTo)
}

export function resolveSource(
  instrument: Instrument,
  settings: Record<string, unknown>,
  source: SignalSource,
): ResolvedSource {
  const master = source.syncTo ? instrument.signalSources?.find((entry) => entry.id === source.syncTo) : undefined
  const timing = master ?? source
  const waveIndex = value(settings, sourceKey(source, 'wave'), 0)
  const waveform = source.waveforms[waveIndex] ?? (source.waveforms[0] as SignalWaveform)
  const masterOn = master ? value(settings, sourceKey(master, 'on'), 1) === 1 : true
  return {
    source,
    waveform,
    frequency: value(settings, sourceKey(timing, 'freq'), timing.frequency?.default ?? 1000),
    amplitude:
      waveform === 'ttl' ? source.ttlHigh : value(settings, sourceKey(source, 'amp'), source.amplitude?.default ?? 0),
    offset:
      waveform === 'ttl'
        ? source.ttlHigh / 2
        : value(settings, sourceKey(source, 'offset'), source.offset?.default ?? 0),
    duty: value(settings, sourceKey(timing, 'duty'), timing.duty?.default ?? 50) / 100,
    enabled: settings.passive !== true && masterOn && value(settings, sourceKey(source, 'on'), 1) === 1,
  }
}

export function resolveSources(instrument: Instrument, settings: Record<string, unknown>): ResolvedSource[] {
  return (instrument.signalSources ?? []).map((source) => resolveSource(instrument, settings, source))
}

const n = (x: number) => String(Number(x.toPrecision(12)))

/** ngspice 独立源的时域描述，t=0 起按设定周期重复 */
export function waveformSpec(resolved: ResolvedSource): string {
  const { waveform, frequency, amplitude, offset, duty } = resolved
  const period = 1 / frequency
  const edge = period * EDGE
  const low = offset - amplitude / 2
  const high = offset + amplitude / 2
  switch (waveform) {
    case 'sine':
      return `SIN(${n(offset)} ${n(amplitude / 2)} ${n(frequency)})`
    case 'triangle': {
      const ramp = (period - edge) / 2
      return `PULSE(${n(low)} ${n(high)} 0 ${n(ramp)} ${n(ramp)} ${n(edge)} ${n(period)})`
    }
    case 'sawtooth':
      return `PULSE(${n(low)} ${n(high)} 0 ${n(period - 2 * edge)} ${n(edge)} ${n(edge)} ${n(period)})`
    default:
      // 方波与 TTL：沿中点到沿中点的高电平时间 = 占空比 × 周期
      return `PULSE(${n(low)} ${n(high)} 0 ${n(edge)} ${n(edge)} ${n(duty * period - edge)} ${n(period)})`
  }
}

/** 网表行，沿用拼装器的 {J:插孔}/{X} 占位符 */
export function signalSourceTemplate(instrument: Instrument, settings: Record<string, unknown>): string {
  return resolveSources(instrument, settings)
    .filter((resolved) => resolved.enabled)
    .map(({ source, ...rest }) => {
      const id = source.id.toLowerCase()
      return [
        `Vsig_${id}_{X} s_${id}_{X} {J:${source.negativeJack}} ${waveformSpec({ source, ...rest })}`,
        `Rsig_${id}_{X} {J:${source.positiveJack}} s_${id}_{X} ${n(source.outputR)}`,
      ].join('\n')
    })
    .join('\n')
}

export function signalDefaults(instrument: Instrument): Record<string, number> {
  const defaults: Record<string, number> = {}
  for (const source of instrument.signalSources ?? []) {
    defaults[sourceKey(source, 'wave')] = 0
    defaults[sourceKey(source, 'on')] = 1
    if (source.frequency) defaults[sourceKey(source, 'freq')] = source.frequency.default
    if (source.amplitude) defaults[sourceKey(source, 'amp')] = source.amplitude.default
    if (source.offset) defaults[sourceKey(source, 'offset')] = source.offset.default
    if (source.duty) defaults[sourceKey(source, 'duty')] = source.duty.default
  }
  if (adjustableSources(instrument).length > 1) defaults.display_ch = 0
  return defaults
}

/** undefined：不是信号源设置；true/false：是否为该仪表允许的值 */
export function signalSettingValid(instrument: Instrument, key: string, v: unknown): boolean | undefined {
  if (key === 'display_ch' && adjustableSources(instrument).length > 1)
    return Number.isInteger(v) && (v as number) >= 0 && (v as number) < adjustableSources(instrument).length
  for (const source of instrument.signalSources ?? []) {
    const prefix = `${source.id.toLowerCase()}_`
    if (!key.startsWith(prefix)) continue
    const field = key.slice(prefix.length)
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
    if (field === 'wave') return Number.isInteger(v) && v >= 0 && v < source.waveforms.length
    if (field === 'on') return v === 0 || v === 1
    const bounds = { freq: source.frequency, amp: source.amplitude, offset: source.offset, duty: source.duty }[field]
    if (bounds) return v >= bounds.min && v <= bounds.max
    return undefined
  }
  return undefined
}

/** 正在输出的最短周期（秒），决定仿真步长 */
export function shortestActivePeriod(instrument: Instrument, settings: Record<string, unknown>): number | undefined {
  if (settings.passive === true) return undefined
  if (instrument.kind === 'acSupply') {
    const uPhase = typeof settings.u_phase === 'number' ? settings.u_phase : 220
    return uPhase > 0 ? 1 / 50 : undefined
  }
  const periods = resolveSources(instrument, settings)
    .filter((resolved) => resolved.enabled)
    .map((resolved) => 1 / resolved.frequency)
  return periods.length ? Math.min(...periods) : undefined
}

/** 频率按 Hz/kHz/MHz 取 4 位有效数字 */
export function formatFrequency(hz: number): { text: string; unit: string } {
  const [scale, unit] = hz >= 1e6 ? [1e6, 'MHz'] : hz >= 1e3 ? [1e3, 'kHz'] : [1, 'Hz']
  const scaled = hz / scale
  const digits = Math.max(0, 3 - Math.floor(Math.log10(Math.max(scaled, 1e-9))))
  return { text: scaled.toFixed(Math.min(digits, 4)), unit }
}

export function formatVoltage(volts: number): string {
  const abs = Math.abs(volts)
  if (abs > 0 && abs < 1) return `${Number((volts * 1e3).toPrecision(4))} mV`
  return `${Number(volts.toPrecision(4))} V`
}
