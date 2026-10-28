import type { Probe, SimCommand } from '../../shared/ipc/sim.ts'
import type { Instrument } from '../../shared/schema/instrument.ts'
import { type AssembleInput, type AssembleOutput, assembleNetlist } from '../circuit/assemble.ts'
import {
  activeInstrumentDefinition,
  checkInstrumentJacks,
  getRangeSettings,
  instrumentProbe,
  isMeasurementInstrument,
  isSelfPoweredMode,
  type RangeSettings,
  type ResolvedInstrument,
  resolveInstrument,
} from '../instruments/index.ts'
import type { CheckInput } from '../wiring-check/common.ts'

export const METER_SAMPLE_STEP = 0.0001
export const METER_RMS_WINDOW = 0.2

export type MeterPlan = {
  instanceId: string
  config: ResolvedInstrument
  connectedJacks: string[]
  voltageProbe?: string
  currentProbe?: string
}
export type SupplyPlan = {
  instanceId: string
  screenId: string
  range: RangeSettings
  voltageProbe: string
}
export type MeasurementPlan = {
  command: Extract<SimCommand, { type: 'load' }>
  assembled: AssembleOutput
  meters: MeterPlan[]
  supplies: SupplyPlan[]
  checkInput: CheckInput
  needsPreflight: boolean
}

export function connectedInstrumentJacks(input: AssembleInput, instanceId: string, instrument: Instrument): string[] {
  const wired = new Set(input.wires.flatMap((wire) => [wire.a, wire.b]))
  return instrument.jacks.filter((jack) => wired.has(`${instanceId}.${jack.id}`)).map((jack) => jack.id)
}

/** Compile only the learner's connections. No reference wiring or expected values enter this path. */
export function buildMeasurementPlan(
  input: AssembleInput,
  powered: boolean,
  token: string,
  options: { preflight?: boolean; blockedTestIds?: ReadonlySet<string> } = {},
): MeasurementPlan {
  const meters: MeterPlan[] = input.instruments.flatMap(({ instanceId, instrument, settings }) => {
    if (!isMeasurementInstrument(instrument)) return []
    return [
      {
        instanceId,
        config: resolveInstrument(instrument, settings),
        connectedJacks: connectedInstrumentJacks(input, instanceId, instrument),
      },
    ]
  })
  const checkInput: CheckInput = {
    modules: input.modules,
    wires: input.wires,
    instruments: input.instruments.map((entry) => {
      const meter = meters.find((item) => item.instanceId === entry.instanceId)
      return {
        instanceId: entry.instanceId,
        instrument: meter ? activeInstrumentDefinition(meter.config) : entry.instrument,
      }
    }),
  }
  const instruments = input.instruments.map((entry) => {
    if (entry.instrument.kind === 'dcSupply' && !powered)
      return {
        ...entry,
        instrument: { ...entry.instrument, spiceTemplate: '* External supply output is disconnected.' },
      }
    const meter = meters.find((item) => item.instanceId === entry.instanceId)
    if (!meter) return entry
    const disconnect =
      !!checkInstrumentJacks(meter.config, meter.connectedJacks) ||
      (isSelfPoweredMode(meter.config.mode) && (options.preflight || options.blockedTestIds?.has(entry.instanceId)))
    return { ...entry, settings: { ...entry.settings, passive: disconnect } }
  })
  const ground =
    input.ground ??
    input.instruments.flatMap(({ instanceId, instrument }) =>
      (instrument.outputs ?? []).map(([, negative]) => `${instanceId}.${negative}`),
    )[0]
  const assembled = assembleNetlist({ ...input, instruments, ground, analysis: [] })
  const probes: Probe[] = []
  for (const meter of meters) {
    if (!assembled.instrumentSuffix[meter.instanceId] || checkInstrumentJacks(meter.config, meter.connectedJacks))
      continue
    const entry = instruments.find((item) => item.instanceId === meter.instanceId)
    if (!entry) continue
    const probe = instrumentProbe(
      resolveInstrument(entry.instrument, entry.settings),
      meter.instanceId,
      assembled.nodeOf,
    )
    meter.voltageProbe = `${token}:${meter.instanceId}:v`
    probes.push({ id: meter.voltageProbe, kind: 'v', node: probe.positiveNode, nodeRef: probe.negativeNode })
    if (probe.currentVector) {
      meter.currentProbe = `${token}:${meter.instanceId}:i`
      probes.push({ id: meter.currentProbe, kind: 'i', source: probe.currentVector.replace(/#branch$/, '') })
    }
  }
  const supplies: SupplyPlan[] = []
  for (const { instanceId, instrument, settings } of instruments) {
    if (instrument.kind !== 'dcSupply' || !assembled.instrumentSuffix[instanceId]) continue
    for (const [index, [positive, negative]] of (instrument.outputs ?? []).entries()) {
      const voltageProbe = `${token}:${instanceId}:ch${index + 1}`
      probes.push({
        id: voltageProbe,
        kind: 'v',
        node: assembled.nodeOf[`${instanceId}.${positive}`],
        nodeRef: assembled.nodeOf[`${instanceId}.${negative}`],
      })
      supplies.push({
        instanceId,
        screenId: `CH${index + 1}`,
        range: getRangeSettings(instrument, settings),
        voltageProbe,
      })
    }
  }
  const alternating =
    !options.preflight &&
    meters.some((meter) => (meter.config.mode === 'acv' || meter.config.mode === 'aca') && meter.voltageProbe)
  return {
    command: {
      type: 'load',
      netlist: assembled.netlist,
      probes,
      analysis: alternating ? { kind: 'tran', step: METER_SAMPLE_STEP, continuous: true } : { kind: 'op' },
    },
    assembled,
    meters,
    supplies,
    checkInput,
    needsPreflight: meters.some(
      (meter) => isSelfPoweredMode(meter.config.mode) && !checkInstrumentJacks(meter.config, meter.connectedJacks),
    ),
  }
}
