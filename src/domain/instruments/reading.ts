import { isCurrentMode, isSelfPoweredMode, type ResolvedInstrument } from './config.ts'
import type { PowerMetrics } from './power-window.ts'

export type InstrumentSample = {
  voltage?: number
  /** Amperes from the selected sense source: into a shunt, out of a test source. */
  current?: number
  /** True RMS of the AC component; no fallback from a DC operating point. */
  rmsVoltage?: number
  rmsCurrent?: number
  /** Synchronized AC power metrics for wattmeters. */
  power?: PowerMetrics
  /** Local jack IDs actually wired by the learner, not software-selected probes. */
  connectedJacks?: readonly string[]
  /** Passive preflight voltage with all built-in meter test sources disabled. */
  externalVoltage?: number
}

export type InstrumentReading = {
  status: 'ok' | 'overload' | 'wrong-jacks' | 'external-voltage' | 'disconnected' | 'invalid'
  text: string
  unit: string
  value: number | null
  rawValue: number | null
  negative: boolean
  beep: boolean
  /** Specified absolute error bound in SI, excluding display rounding. */
  uncertainty: number | null
  /** Full multi-quantity AC power metrics when kind === 'wattmeter'. */
  metrics?: PowerMetrics
  /** Normalized needle deflection in [-1, 1] for center-zero analog galvanometers. */
  deflection?: number
  message?: string
}

function blank(config: ResolvedInstrument, status: InstrumentReading['status'], message: string): InstrumentReading {
  return {
    status,
    text: '----',
    unit: config.unit,
    value: null,
    rawValue: null,
    negative: false,
    beep: false,
    uncertainty: null,
    message,
  }
}

function jackLabel(config: ResolvedInstrument, id: string): string {
  return config.instrument.jacks.find((jack) => jack.id === id)?.label ?? id
}

export function checkInstrumentJacks(
  config: ResolvedInstrument,
  connectedJacks: readonly string[],
): InstrumentReading | undefined {
  const connected = new Set(connectedJacks)
  if (config.mode === 'power' && config.wattmeter) {
    const required = [
      config.positiveJack,
      config.negativeJack,
      config.wattmeter.currentPositiveJack,
      config.wattmeter.currentNegativeJack,
    ]
    const allowed = new Set(required)
    if ([...connected].some((jack) => !allowed.has(jack))) {
      return blank(config, 'wrong-jacks', '功率表存在无效插孔连线，请断电后检查接线。')
    }
    if (required.some((jack) => !connected.has(jack))) {
      return blank(
        config,
        'disconnected',
        `请同时连接电压端（${jackLabel(config, config.positiveJack)}、${jackLabel(config, config.negativeJack)}）与电流端（${jackLabel(config, config.wattmeter.currentPositiveJack)}、${jackLabel(config, config.wattmeter.currentNegativeJack)}）。`,
      )
    }
    return undefined
  }

  const allowed = new Set(config.allowedJacks ?? [config.positiveJack, config.negativeJack])
  const extra = [...connected].some((jack) => !allowed.has(jack))
  if (extra) {
    const modeHint = isCurrentMode(config.mode) ? '当前为电流档，不能按电压表方式跨接。' : ''
    return blank(
      config,
      'wrong-jacks',
      `表笔插孔与档位不匹配。${modeHint}断电后将表笔接入 ${config.positiveJack} 与 ${config.negativeJack}，再选择正确档位。`,
    )
  }
  if (!connected.has(config.positiveJack) || !connected.has(config.negativeJack))
    return blank(config, 'disconnected', `请自行连接 ${config.positiveJack} 与 ${config.negativeJack} 两个测量插孔。`)
  return undefined
}

export function accuracyBound(config: ResolvedInstrument, value: number): number {
  const accuracy = config.accuracy
  return (
    (Math.abs(value) * accuracy.percentReading) / 100 +
    (config.fullScale * accuracy.percentFullScale) / 100 +
    config.resolution * accuracy.digits
  )
}

function decimalPlaces(step: number): number {
  const [coefficient = '', exponent = '0'] = Number(step.toPrecision(12)).toString().split('e')
  return Math.max(0, Math.min(12, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent)))
}

/** Only formatting/calibration follows simulation; input loading is in the netlist. */
export function readInstrument(config: ResolvedInstrument, sample: InstrumentSample): InstrumentReading {
  if (sample.connectedJacks) {
    const issue = checkInstrumentJacks(config, sample.connectedJacks)
    if (issue) return issue
  }
  if (
    isSelfPoweredMode(config.mode) &&
    sample.externalVoltage !== undefined &&
    (!Number.isFinite(sample.externalVoltage) ||
      Math.abs(sample.externalVoltage) >= (config.testSource?.safetyVoltage ?? 0))
  )
    return blank(
      config,
      'external-voltage',
      '被测回路带电，禁止启用电阻、二极管和通断档测试源。请先断开外部电源并放电。',
    )
  if (config.passive) return blank(config, 'invalid', '正在进行无源安全检查，尚未启用测量输入。')

  if (config.mode === 'power' && config.wattmeter) {
    const metrics = sample.power
    if (!metrics) return blank(config, 'invalid', '尚未收到有效的功率采样窗口数据。')
    const { maxVoltage, maxCurrent, displayMode } = config.wattmeter
    if (
      !Number.isFinite(metrics.U) ||
      !Number.isFinite(metrics.I) ||
      !Number.isFinite(metrics.P) ||
      metrics.U >= maxVoltage ||
      metrics.I >= maxCurrent ||
      Math.abs(metrics.P) >= config.fullScale
    ) {
      return {
        ...blank(
          config,
          'overload',
          `功率表超量程（额定 ${maxVoltage} V / ${maxCurrent} A / ${config.fullScale} W）。请断电检查回路并确认未过载。`,
        ),
        text: 'OL.',
        rawValue: Number.isFinite(metrics.P) ? metrics.P : null,
        negative: metrics.P < 0,
        metrics,
      }
    }
    const spec: Record<
      typeof displayMode,
      { raw: number; unit: string; resolution: number; fullScale: number; signed: boolean }
    > = {
      P: { raw: metrics.P, unit: 'W', resolution: config.resolution, fullScale: config.fullScale, signed: true },
      pf: { raw: metrics.pf, unit: 'cosφ', resolution: 0.001, fullScale: 1, signed: true },
      S: { raw: metrics.S, unit: 'VA', resolution: config.resolution, fullScale: config.fullScale, signed: false },
      Q: { raw: metrics.Q, unit: 'var', resolution: config.resolution, fullScale: config.fullScale, signed: true },
      U: { raw: metrics.U, unit: 'V', resolution: 0.1, fullScale: maxVoltage, signed: false },
      I: { raw: metrics.I, unit: 'A', resolution: 0.001, fullScale: maxCurrent, signed: false },
    }
    const active = spec[displayMode]
    const uncertainty =
      (Math.abs(active.raw) * config.accuracy.percentReading) / 100 +
      (active.fullScale * config.accuracy.percentFullScale) / 100 +
      active.resolution * config.accuracy.digits
    const biased = active.raw + uncertainty * config.accuracyOffset
    const clamped =
      displayMode === 'pf' ? Math.max(-1, Math.min(1, biased)) : active.signed ? biased : Math.max(0, biased)
    const rounded = Math.sign(clamped) * Math.round(Math.abs(clamped) / active.resolution) * active.resolution
    const value = rounded === 0 ? 0 : rounded
    return {
      status: 'ok',
      text: value.toFixed(decimalPlaces(active.resolution)),
      unit: active.unit,
      value,
      rawValue: active.raw,
      negative: metrics.P < 0,
      beep: false,
      uncertainty,
      metrics,
      ...(metrics.P < 0 ? { message: '功率读数为负，请检查电压端或电流端同名端（*）极性。' } : {}),
    }
  }

  let raw: number | undefined
  switch (config.mode) {
    case 'dcv':
    case 'diode':
      raw = Number.isFinite(sample.voltage) ? sample.voltage : undefined
      break
    case 'dca':
      raw = Number.isFinite(sample.current) ? sample.current : undefined
      break
    case 'acv':
      raw = sample.rmsVoltage
      break
    case 'aca':
      raw = sample.rmsCurrent
      break
    case 'ohm':
    case 'continuity':
      if (
        sample.voltage !== undefined &&
        sample.current !== undefined &&
        Number.isFinite(sample.voltage) &&
        Number.isFinite(sample.current)
      ) {
        // Subtract the known input leakage, not an invented loading correction.
        const testCurrent = sample.current - sample.voltage / (config.internalR ?? 1e12)
        raw = testCurrent > 1e-15 ? sample.voltage / testCurrent : Number.POSITIVE_INFINITY
      }
      break
  }
  if (raw === undefined || Number.isNaN(raw)) return blank(config, 'invalid', '尚未收到有效的仿真测量数据。')
  if ((config.mode === 'acv' || config.mode === 'aca') && (raw < 0 || !Number.isFinite(raw)))
    return blank(config, 'invalid', '交流有效值数据无效。')
  if (isSelfPoweredMode(config.mode) && raw < 0)
    return blank(config, 'external-voltage', '检测到反向外部电压，禁止启用测试源。请先断开外部电源并放电。')
  const uncertainty = Number.isFinite(raw) ? accuracyBound(config, raw) : null
  const biased = raw + (uncertainty ?? 0) * config.accuracyOffset
  const measured = config.mode === 'dcv' || config.mode === 'dca' ? biased : Math.max(0, biased)
  const rounded = Math.sign(measured) * Math.round(Math.abs(measured) / config.resolution) * config.resolution
  const isGalvanometer = config.instrument.kind === 'galvanometer'
  if (!Number.isFinite(raw) || Math.abs(raw) >= config.fullScale || Math.abs(rounded) >= config.fullScale)
    return {
      ...blank(
        config,
        'overload',
        isCurrentMode(config.mode)
          ? '电流超量程。请断电检查仪表是否正确串入支路，勿将电流档并联在电压测量点，再选择合适量程。'
          : '超量程或被测回路开路。请检查接线并选择合适量程。',
      ),
      text: 'OL.',
      rawValue: Number.isFinite(raw) ? raw : null,
      negative: raw < 0,
      uncertainty,
      ...(isGalvanometer ? { deflection: raw < 0 ? -1 : 1 } : {}),
    }
  const value = rounded === 0 ? 0 : rounded
  return {
    status: 'ok',
    text: (value / config.displayScale).toFixed(decimalPlaces(config.resolution / config.displayScale)),
    unit: config.unit,
    value,
    rawValue: raw,
    negative: value < 0,
    beep: config.mode === 'continuity' && raw <= (config.testSource?.continuityThreshold ?? 0),
    uncertainty,
    ...(isGalvanometer ? { deflection: Math.max(-1, Math.min(1, value / config.fullScale)) } : {}),
  }
}

/** Equally spaced samples; removeDc models the AC-coupled multimeter ranges. */
export function rms(samples: ArrayLike<number>, removeDc = true): number {
  if (samples.length === 0) return Number.NaN
  let mean = 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] as number
    if (!Number.isFinite(value)) return Number.NaN
    if (removeDc) {
      const delta = value - mean
      mean += delta / (i + 1)
      sumSquares += delta * (value - mean)
    } else sumSquares += value * value
  }
  return Math.sqrt(Math.max(0, sumSquares / samples.length))
}
