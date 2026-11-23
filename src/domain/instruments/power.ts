import type { Instrument } from '../../shared/schema/instrument.ts'
import { InstrumentConfigurationError } from './config.ts'

export const DC_CURRENT_SOURCE_RANGES = [2, 20, 500] as const
export type DcCurrentSourceRangeMa = (typeof DC_CURRENT_SOURCE_RANGES)[number]
export const DC_CURRENT_SOURCE_COMPLIANCE_V = 30
export const THREE_PHASE_FREQUENCY_HZ = 50
export const THREE_PHASE_MAX_CURRENT_A = 5

export type ResolvedDcChannel = {
  id: 'CH1' | 'CH2' | 'V5'
  positiveJack: string
  negativeJack: string
  voltageSet: number
  currentLimit: number
  outputR: number
}

export type ResolvedCurrentSource = {
  positiveJack: string
  negativeJack: string
  rangeMa: DcCurrentSourceRangeMa
  currentSetMa: number
  currentSetA: number
  complianceV: number
}

export type ResolvedDcSupply = {
  tracking: boolean
  ch1: ResolvedDcChannel
  ch2: ResolvedDcChannel
  v5?: ResolvedDcChannel
  currentSource?: ResolvedCurrentSource
}

export type ResolvedAcSupply = {
  phaseVoltageRms: number
  lineVoltageRms: number
  frequencyHz: number
  outputR: number
  maxCurrentA: number
}

function finiteIn(settings: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = settings[key] ?? fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new InstrumentConfigurationError(`电源设置 ${key} 超出有效范围 [${min}, ${max}]。`)
  }
  return raw
}

function resolveIsRangeMa(value: unknown): DcCurrentSourceRangeMa {
  if (value === undefined) return 20
  if (typeof value === 'number' && Number.isInteger(value)) {
    const byIndex = DC_CURRENT_SOURCE_RANGES[value]
    if (byIndex !== undefined) return byIndex
    if ((DC_CURRENT_SOURCE_RANGES as readonly number[]).includes(value)) return value as DcCurrentSourceRangeMa
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/mA$/i, ''))
    if ((DC_CURRENT_SOURCE_RANGES as readonly number[]).includes(parsed)) return parsed as DcCurrentSourceRangeMa
  }
  throw new InstrumentConfigurationError(`恒流源档位 ${String(value)} 无效。`)
}

export function powerDefaults(instrument: Instrument): Record<string, number> {
  if (instrument.kind === 'dcSupply') {
    const hasExtended = instrument.jacks.some((j) => j.id === 'ISP')
    return {
      ch1_v: 6,
      ch1_i: 1,
      ch2_v: 12,
      ch2_i: 1,
      ...(hasExtended ? { is_ma: 20, is_range: 1, tracking: 0 } : {}),
    }
  }
  if (instrument.kind === 'acSupply') {
    return { u_phase: 220 }
  }
  return {}
}

export function powerSettingValid(instrument: Instrument, key: string, value: unknown): boolean | undefined {
  if (instrument.kind === 'dcSupply') {
    if (key === 'tracking') return value === 0 || value === 1 || typeof value === 'boolean'
    if (key === 'is_range') {
      try {
        resolveIsRangeMa(value)
        return true
      } catch {
        return false
      }
    }
    if (key === 'ch1_i' || key === 'ch2_i') {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0.02 && value <= 1
    }
    if (key === 'is_ma') {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 500
    }
  }
  if (instrument.kind === 'acSupply' && key === 'u_phase') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 260
  }
  return undefined
}

export function resolveDcSupply(instrument: Instrument, settings: Record<string, unknown> = {}): ResolvedDcSupply {
  const outputR = instrument.ranges[0]?.internalR ?? 0.01
  const tracking = settings.tracking === 1 || settings.tracking === true
  const ch1V = finiteIn(settings, 'ch1_v', 6, 0, 30)
  const ch1I = finiteIn(settings, 'ch1_i', 1, 0.02, 1)
  const ch2V = tracking ? ch1V : finiteIn(settings, 'ch2_v', 12, 0, 30)
  const ch2I = tracking ? ch1I : finiteIn(settings, 'ch2_i', 1, 0.02, 1)
  const jacks = new Set(instrument.jacks.map((j) => j.id))
  const v5: ResolvedDcChannel | undefined =
    jacks.has('V5P') && jacks.has('V5N')
      ? { id: 'V5', positiveJack: 'V5P', negativeJack: 'V5N', voltageSet: 5, currentLimit: 1, outputR }
      : undefined
  let currentSource: ResolvedCurrentSource | undefined
  if (jacks.has('ISP') && jacks.has('ISN')) {
    const rangeMa = resolveIsRangeMa(settings.is_range)
    const rawMa = finiteIn(settings, 'is_ma', 20, 0, 500)
    const currentSetMa = Math.min(rawMa, rangeMa)
    currentSource = {
      positiveJack: 'ISP',
      negativeJack: 'ISN',
      rangeMa,
      currentSetMa,
      currentSetA: currentSetMa * 1e-3,
      complianceV: DC_CURRENT_SOURCE_COMPLIANCE_V,
    }
  }
  return {
    tracking,
    ch1: { id: 'CH1', positiveJack: 'CH1P', negativeJack: 'CH1N', voltageSet: ch1V, currentLimit: ch1I, outputR },
    ch2: { id: 'CH2', positiveJack: 'CH2P', negativeJack: 'CH2N', voltageSet: ch2V, currentLimit: ch2I, outputR },
    ...(v5 ? { v5 } : {}),
    ...(currentSource ? { currentSource } : {}),
  }
}

export function resolveAcSupply(instrument: Instrument, settings: Record<string, unknown> = {}): ResolvedAcSupply {
  const phaseVoltageRms = finiteIn(settings, 'u_phase', 220, 0, 260)
  const outputR = instrument.ranges[0]?.internalR ?? 0.05
  return {
    phaseVoltageRms,
    lineVoltageRms: phaseVoltageRms * Math.sqrt(3),
    frequencyHz: THREE_PHASE_FREQUENCY_HZ,
    outputR,
    maxCurrentA: THREE_PHASE_MAX_CURRENT_A,
  }
}

function cvCcChannelNetlist(tag: string, nodePrefix: string, channel: ResolvedDcChannel, wired = true): string[] {
  const p = `{J:${channel.positiveJack}}`
  const n = `{J:${channel.negativeJack}}`
  const vNode = `${nodePrefix}_{X}`
  if (!wired) {
    return [`V${tag}_{X} ${vNode} ${n} DC ${channel.voltageSet}`, `R${tag}_{X} ${vNode} ${p} ${channel.outputR}`]
  }
  return [
    `V${tag}_{X} ${vNode} ${n} DC ${channel.voltageSet}`,
    `I${tag}_{X} ${n} c_${tag}_{X} DC ${channel.currentLimit}`,
    `D${tag}_{X} c_${tag}_{X} ${vNode} dlim_${tag}_{X}`,
    `R${tag}_{X} c_${tag}_{X} m_${tag}_{X} ${channel.outputR}`,
    `Vs${tag}_{X} m_${tag}_{X} ${p} DC 0`,
    `.model dlim_${tag}_{X} D(IS=1e-9 N=1e-4)`,
  ]
}

function currentSourceNetlist(cs: ResolvedCurrentSource, wired = true): string[] {
  const p = `{J:${cs.positiveJack}}`
  const n = `{J:${cs.negativeJack}}`
  if (!wired) {
    return [`Ris_{X} ${p} ${n} 1G`]
  }
  if (cs.currentSetA <= 1e-7) {
    return [`Ris_{X} ${p} ${n} 1G`, `Vsis_{X} m_is_{X} ${p} DC 0`, `Rmis_{X} m_is_{X} ${n} 1G`]
  }
  return [
    `Vis_{X} v_is_{X} ${n} DC ${cs.complianceV}`,
    `Iis_{X} ${n} m_is_{X} DC ${cs.currentSetA}`,
    `Dis_{X} m_is_{X} v_is_{X} dlim_is_{X}`,
    `Ris_{X} m_is_{X} ${n} 1G`,
    `Vsis_{X} m_is_{X} ${p} DC 0`,
    `.model dlim_is_{X} D(IS=1e-11 N=1e-4)`,
  ]
}

/**
 * Generates zero-ASRC SPICE templates for dcSupply (CV/CC + 5V + constant current source)
 * and acSupply (50 Hz three-phase four-wire variac U/V/W/N).
 */
export function powerSourceTemplate(
  instrument: Instrument,
  settings: Record<string, unknown> = {},
  connectedJacks?: ReadonlySet<string>,
): string | undefined {
  if (instrument.kind !== 'dcSupply' && instrument.kind !== 'acSupply') return undefined
  if (settings.passive === true || /^\s*\*.*disconnected/i.test(instrument.spiceTemplate)) {
    return instrument.spiceTemplate
  }
  const isPairWired = (pos: string, neg: string) =>
    !connectedJacks || (connectedJacks.has(pos) && connectedJacks.has(neg))
  const isAnyWired = (pos: string, neg: string) => !connectedJacks || connectedJacks.has(pos) || connectedJacks.has(neg)
  if (instrument.kind === 'dcSupply') {
    const resolved = resolveDcSupply(instrument, settings)
    const lines = [
      ...(isAnyWired(resolved.ch1.positiveJack, resolved.ch1.negativeJack)
        ? cvCcChannelNetlist(
            'ch1',
            'x1',
            resolved.ch1,
            isPairWired(resolved.ch1.positiveJack, resolved.ch1.negativeJack),
          )
        : []),
      ...(isAnyWired(resolved.ch2.positiveJack, resolved.ch2.negativeJack)
        ? cvCcChannelNetlist(
            'ch2',
            'x2',
            resolved.ch2,
            isPairWired(resolved.ch2.positiveJack, resolved.ch2.negativeJack),
          )
        : []),
      ...(resolved.v5 && isAnyWired(resolved.v5.positiveJack, resolved.v5.negativeJack)
        ? cvCcChannelNetlist('v5', 'x5', resolved.v5, isPairWired(resolved.v5.positiveJack, resolved.v5.negativeJack))
        : []),
      ...(resolved.currentSource && isAnyWired(resolved.currentSource.positiveJack, resolved.currentSource.negativeJack)
        ? currentSourceNetlist(
            resolved.currentSource,
            isPairWired(resolved.currentSource.positiveJack, resolved.currentSource.negativeJack),
          )
        : []),
    ]
    return lines.join('\n')
  }
  if (instrument.kind === 'acSupply') {
    const resolved = resolveAcSupply(instrument, settings)
    const peak = resolved.phaseVoltageRms * Math.SQRT2
    const r = resolved.outputR
    return [
      `Vu_{X} u_src_{X} {J:N} SIN(0 ${peak} ${resolved.frequencyHz} 0 0 0)`,
      `Ru_{X} u_src_{X} u_m_{X} ${r}`,
      `Vsu_{X} u_m_{X} {J:U} DC 0`,
      `Vv_{X} v_src_{X} {J:N} SIN(0 ${peak} ${resolved.frequencyHz} 0 0 -120)`,
      `Rv_{X} v_src_{X} v_m_{X} ${r}`,
      `Vsv_{X} v_m_{X} {J:V} DC 0`,
      `Vw_{X} w_src_{X} {J:N} SIN(0 ${peak} ${resolved.frequencyHz} 0 0 120)`,
      `Rw_{X} w_src_{X} w_m_{X} ${r}`,
      `Vsw_{X} w_m_{X} {J:W} DC 0`,
    ].join('\n')
  }
  return undefined
}

export type DcChannelStatus = {
  mode: 'CV' | 'CC'
  voltage: number
  current: number
}

export function classifyDcChannel(
  channel: ResolvedDcChannel,
  measuredVoltage: number,
  measuredCurrent = 0,
): DcChannelStatus {
  const current = Math.max(0, measuredCurrent)
  const expectedCv = channel.voltageSet - current * channel.outputR
  const inCc =
    channel.voltageSet > 0 &&
    (current >= channel.currentLimit * 0.985 ||
      measuredVoltage < expectedCv - Math.max(0.01, channel.voltageSet * 0.005))
  return {
    mode: inCc ? 'CC' : 'CV',
    voltage: measuredVoltage,
    current,
  }
}

export type CurrentSourceStatus = {
  state: 'CC' | 'OPEN' | 'OFF'
  currentMa: number
  voltage: number
}

export function classifyCurrentSource(
  cs: ResolvedCurrentSource,
  measuredVoltage: number,
  measuredCurrent = 0,
  wired = true,
): CurrentSourceStatus {
  if (!wired || cs.currentSetA <= 1e-7) {
    return { state: 'OFF', currentMa: 0, voltage: wired ? measuredVoltage : 0 }
  }
  const currentMa = Math.max(0, measuredCurrent) * 1e3
  const openCompliance = measuredVoltage >= cs.complianceV - 0.25 && currentMa < cs.currentSetMa * 0.98
  return {
    state: openCompliance ? 'OPEN' : 'CC',
    currentMa,
    voltage: measuredVoltage,
  }
}
