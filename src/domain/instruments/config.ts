import type { Instrument, InstrumentAccuracy, InstrumentMode, InstrumentRange } from '../../shared/schema/instrument.ts'
import { powerDefaults } from './power.ts'
import { scopeDefaults } from './scope.ts'
import { signalDefaults } from './signal.ts'

export class InstrumentConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstrumentConfigurationError'
  }
}

const DISPLAY_SCALE: Record<string, number> = {
  V: 1,
  mV: 1e-3,
  A: 1,
  mA: 1e-3,
  uA: 1e-6,
  Ω: 1,
  kΩ: 1e3,
  MΩ: 1e6,
  W: 1,
  VA: 1,
  var: 1,
}
const MODES = new Set<string>(['dcv', 'acv', 'dca', 'aca', 'ohm', 'diode', 'continuity', 'power'])
const KIND_TO_MODE: Partial<Record<Instrument['kind'], InstrumentMode>> = {
  dcv: 'dcv',
  acv: 'acv',
  dca: 'dca',
  aca: 'aca',
  acMillivolt: 'acv',
  galvanometer: 'dca',
  wattmeter: 'power',
}

export const WATTMETER_DISPLAY_MODES = ['P', 'pf', 'S', 'Q', 'U', 'I'] as const
export type WattmeterDisplayMode = (typeof WATTMETER_DISPLAY_MODES)[number]

export type RangeSettings = {
  range: InstrumentRange
  fullScale: number
  resolution: number
  internalR: number | undefined
  inputC: number | undefined
  /** Display unit; all circuit and sample values remain SI. */
  unit: string
  /** SI units per displayed unit, e.g. mA = 0.001 A. */
  displayScale: number
  accuracy: Required<InstrumentAccuracy>
  /** Deterministic calibration error in [-1, 1] of the specified error bound. */
  accuracyOffset: number
}

export type ResolvedWattmeter = {
  currentPositiveJack: string
  currentNegativeJack: string
  currentR: number
  maxVoltage: number
  maxCurrent: number
  displayMode: WattmeterDisplayMode
}

export type ResolvedInstrument = RangeSettings & {
  instrument: Instrument
  mode: InstrumentMode
  positiveJack: string
  negativeJack: string
  /** Jacks allowed to be wired simultaneously (e.g. dual-channel millivoltmeter CH1/CH2/GND). */
  allowedJacks?: readonly string[]
  channelId?: string
  wattmeter?: ResolvedWattmeter
  passive: boolean
  testSource: InstrumentRange['testSource']
}

function numberSetting(settings: Record<string, unknown>, key: string, fallback: number, min: number): number {
  const value = settings[key] ?? fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min)
    throw new InstrumentConfigurationError(`仪表设置 ${key} 必须是大于等于 ${min} 的有限数值。`)
  return value
}

export function getInstrumentDefaults(instrument: Instrument): Record<string, string | number> {
  const defaults: Record<string, string | number> = {}
  const range = instrument.defaultRange ?? instrument.ranges[0]?.id
  if (range) defaults.range = range
  const firstChannel = instrument.inputChannels?.[0]
  if (firstChannel) defaults.channel = firstChannel.id
  if (instrument.wattmeter) defaults.displayMode = 'P'
  Object.assign(defaults, powerDefaults(instrument), signalDefaults(instrument), scopeDefaults(instrument))
  for (const control of instrument.settingsControls ?? []) defaults[control.id] = control.default
  return defaults
}

export function getRangeSettings(instrument: Instrument, settings: Record<string, unknown> = {}): RangeSettings {
  const rangeId = settings.range ?? instrument.defaultRange ?? instrument.ranges[0]?.id
  const range = instrument.ranges.find((candidate) => candidate.id === rangeId)
  if (!range) throw new InstrumentConfigurationError(`${instrument.name}的量程 ${String(rangeId)} 不存在。`)
  const resolution = numberSetting(settings, 'resolution', range.resolution, Number.MIN_VALUE)
  if (resolution >= range.full) throw new InstrumentConfigurationError('分辨率必须小于量程。')
  const internalR =
    settings.internalR === undefined && range.internalR === undefined
      ? undefined
      : numberSetting(settings, 'internalR', range.internalR ?? 0, Number.MIN_VALUE)
  const accuracyOffset = numberSetting(settings, 'accuracyOffset', 0, -1)
  if (accuracyOffset > 1) throw new InstrumentConfigurationError('精度偏移必须在 -1 到 1 之间。')
  const unit = range.displayUnit ?? range.unit
  const displayScale = DISPLAY_SCALE[unit]
  if (displayScale === undefined) throw new InstrumentConfigurationError(`未支持的仪表单位 ${unit}。`)
  const digits = numberSetting(settings, 'accuracyDigits', range.accuracy?.digits ?? 0, 0)
  if (!Number.isInteger(digits)) throw new InstrumentConfigurationError('精度字数必须是非负整数。')
  return {
    range,
    fullScale: range.full,
    resolution,
    internalR,
    inputC: range.inputC,
    unit,
    displayScale,
    accuracy: {
      percentReading: numberSetting(settings, 'accuracyPercentReading', range.accuracy?.percentReading ?? 0, 0),
      percentFullScale: numberSetting(
        settings,
        'accuracyClass',
        range.accuracy?.percentFullScale ?? (range.accuracy ? 0 : (instrument.accuracyClass ?? 0)),
        0,
      ),
      digits,
    },
    accuracyOffset,
  }
}

export function isMeasurementInstrument(instrument: Instrument): boolean {
  return (
    MODES.has(instrument.kind) ||
    instrument.kind === 'multimeter' ||
    instrument.kind === 'acMillivolt' ||
    instrument.kind === 'galvanometer' ||
    instrument.kind === 'wattmeter'
  )
}

export function isCurrentMode(mode: InstrumentMode): boolean {
  return mode === 'dca' || mode === 'aca'
}

export function isSelfPoweredMode(mode: InstrumentMode): boolean {
  return mode === 'ohm' || mode === 'diode' || mode === 'continuity'
}

export function isAcTransientMode(mode: InstrumentMode): boolean {
  return mode === 'acv' || mode === 'aca' || mode === 'power'
}

function resolveDisplayMode(value: unknown): WattmeterDisplayMode {
  if (value === undefined) return 'P'
  if (typeof value === 'number' && Number.isInteger(value)) {
    const byIndex = WATTMETER_DISPLAY_MODES[value]
    if (byIndex) return byIndex
  }
  if (typeof value === 'string' && (WATTMETER_DISPLAY_MODES as readonly string[]).includes(value)) {
    return value as WattmeterDisplayMode
  }
  throw new InstrumentConfigurationError(`功率表显示模式 ${String(value)} 无效。`)
}

export function resolveInstrument(instrument: Instrument, settings: Record<string, unknown> = {}): ResolvedInstrument {
  const values = getRangeSettings(instrument, settings)
  const mode = values.range.mode ?? KIND_TO_MODE[instrument.kind]
  if (!mode) throw new InstrumentConfigurationError(`${instrument.name}的测量模式尚未实现。`)

  if (mode === 'power') {
    const watt = instrument.wattmeter
    if (!watt) throw new InstrumentConfigurationError(`${instrument.name}缺少功率表回路配置。`)
    const displayMode = resolveDisplayMode(settings.displayMode)
    return {
      ...values,
      internalR: values.internalR ?? watt.voltageR,
      instrument,
      mode,
      positiveJack: watt.voltageJacks[0],
      negativeJack: watt.voltageJacks[1],
      wattmeter: {
        currentPositiveJack: watt.currentJacks[0],
        currentNegativeJack: watt.currentJacks[1],
        currentR: watt.currentR,
        maxVoltage: watt.maxVoltage,
        maxCurrent: watt.maxCurrent,
        displayMode,
      },
      passive: settings.passive === true,
      testSource: undefined,
    }
  }

  let positiveJack: string | undefined
  let negativeJack: string | undefined
  let channelId: string | undefined
  let allowedJacks: string[] | undefined

  if (instrument.inputChannels?.length) {
    const requested = settings.channel ?? instrument.inputChannels[0]?.id
    const channel = instrument.inputChannels.find((entry) => entry.id === requested)
    if (!channel) throw new InstrumentConfigurationError(`${instrument.name}的通道 ${String(requested)} 不存在。`)
    channelId = channel.id
    positiveJack = channel.positiveJack
    negativeJack = channel.negativeJack
    allowedJacks = [...new Set(instrument.inputChannels.flatMap((entry) => [entry.positiveJack, entry.negativeJack]))]
  } else {
    const legacyPair = isCurrentMode(mode) ? instrument.measure?.series[0] : instrument.measure?.voltage[0]
    positiveJack = values.range.positiveJack ?? legacyPair?.[0]
    negativeJack = values.range.negativeJack ?? legacyPair?.[1]
  }

  if (!positiveJack || !negativeJack)
    throw new InstrumentConfigurationError(`${instrument.name}的档位缺少正负测量插孔。`)
  if (
    !instrument.jacks.some((jack) => jack.id === positiveJack) ||
    !instrument.jacks.some((jack) => jack.id === negativeJack)
  )
    throw new InstrumentConfigurationError(`${instrument.name}的档位引用了不存在的插孔。`)
  if (!values.internalR) throw new InstrumentConfigurationError(`${instrument.name}的档位缺少内阻。`)
  const testSource = values.range.testSource
  if (isSelfPoweredMode(mode) && !testSource)
    throw new InstrumentConfigurationError(`${instrument.name}的档位缺少限压限流测试源。`)
  return {
    ...values,
    instrument,
    mode,
    positiveJack,
    negativeJack,
    ...(allowedJacks ? { allowedJacks } : {}),
    ...(channelId ? { channelId } : {}),
    passive: settings.passive === true || (isSelfPoweredMode(mode) && settings.testSourceEnabled === false),
    testSource,
  }
}

/** Supply the existing topology checker with only the currently selected input pair(s). */
export function activeInstrumentDefinition(config: ResolvedInstrument): Instrument {
  if (config.mode === 'power' && config.wattmeter) {
    return {
      ...config.instrument,
      measure: {
        voltage: [[config.positiveJack, config.negativeJack]],
        series: config.passive ? [] : [[config.wattmeter.currentPositiveJack, config.wattmeter.currentNegativeJack]],
      },
    }
  }
  if (config.instrument.inputChannels?.length) {
    return {
      ...config.instrument,
      measure: {
        voltage: config.instrument.inputChannels.map((ch) => [ch.positiveJack, ch.negativeJack] as [string, string]),
        series: [],
      },
    }
  }
  const pair: [string, string] = [config.positiveJack, config.negativeJack]
  return {
    ...config.instrument,
    measure: {
      voltage: config.mode === 'dcv' || config.mode === 'acv' ? [pair] : [],
      series: isCurrentMode(config.mode) && !config.passive ? [pair] : [],
    },
  }
}
