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
  resolveScope,
  scopeSampleStep,
  screenSeconds,
  shortestActivePeriod,
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
export type ScopePlan = {
  instanceId: string
  /** probe 缺省表示该通道信号端未接线 */
  channels: { id: string; probe?: string; groundWired: boolean }[]
}
export type SimPacing = Extract<SimCommand, { type: 'setPacing' }>

/** 示波器通道探针 ID 固定，2D 面板、3D 屏幕和弹出窗口按同一 ID 读环形缓冲 */
export const scopeProbeId = (instanceId: string, channelId: string) => `scope:${instanceId}:${channelId}`

export type MeasurementPlan = {
  command: Extract<SimCommand, { type: 'load' }>
  /** 示波器按屏幕时间窗口推进（SIM-11），其余按真实时间 */
  pacing: SimPacing
  scopes: ScopePlan[]
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
    // 未上电时信号源不输出，输出端开路；示波器输入阻抗仍在网表中
    if (entry.instrument.signalSources?.length && !powered)
      return { ...entry, settings: { ...entry.settings, passive: true } }
    const meter = meters.find((item) => item.instanceId === entry.instanceId)
    if (!meter) return entry
    const disconnect =
      !!checkInstrumentJacks(meter.config, meter.connectedJacks) ||
      (isSelfPoweredMode(meter.config.mode) && (options.preflight || options.blockedTestIds?.has(entry.instanceId)))
    return { ...entry, settings: { ...entry.settings, passive: disconnect } }
  })
  const wired = new Set(input.wires.flatMap((wire) => [wire.a, wire.b]))
  const negatives = input.instruments.flatMap(({ instanceId, instrument }) =>
    (instrument.outputs ?? []).map(([, negative]) => `${instanceId}.${negative}`),
  )
  // 优先取学员已接线的输出负端作参考地，未接线的电源不应把其他仪表的回路悬空
  const ground = input.ground ?? negatives.find((ref) => wired.has(ref)) ?? negatives[0]
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
  const scopes: ScopePlan[] = []
  const screens: number[] = []
  let pointsPerScreen = Number.POSITIVE_INFINITY
  for (const { instanceId, instrument, settings } of instruments) {
    if (!instrument.scope || !assembled.instrumentSuffix[instanceId]) continue
    const scope = resolveScope(instrument, settings)
    const channels = instrument.scope.channels.map((channel) => {
      const positive = `${instanceId}.${channel.positiveJack}`
      const groundWired = wired.has(`${instanceId}.${channel.negativeJack}`)
      if (!wired.has(positive) || options.preflight) return { id: channel.id, groundWired }
      const probe = scopeProbeId(instanceId, channel.id)
      probes.push({
        id: probe,
        kind: 'v',
        node: assembled.nodeOf[positive],
        nodeRef: assembled.nodeOf[`${instanceId}.${channel.negativeJack}`],
      })
      return { id: channel.id, probe, groundWired }
    })
    scopes.push({ instanceId, channels })
    if (channels.some((channel) => channel.probe)) {
      screens.push(screenSeconds(scope))
      pointsPerScreen = Math.min(pointsPerScreen, instrument.scope.pointsPerScreen)
    }
  }
  const periods = instruments.flatMap(({ instanceId, instrument, settings }) => {
    if (!assembled.instrumentSuffix[instanceId]) return []
    const period = shortestActivePeriod(instrument, settings)
    return period === undefined ? [] : [period]
  })
  const shortest = periods.length ? Math.min(...periods) : undefined
  const alternating =
    !options.preflight &&
    meters.some((meter) => (meter.config.mode === 'acv' || meter.config.mode === 'aca') && meter.voltageProbe)
  const transient = !options.preflight && (alternating || (powered && (screens.length > 0 || shortest !== undefined)))
  let step = screens.length
    ? scopeSampleStep(screens, pointsPerScreen, shortest)
    : Math.min(METER_SAMPLE_STEP, shortest ? shortest / 1000 : METER_SAMPLE_STEP)
  if (alternating) step = Math.min(step, METER_SAMPLE_STEP)
  return {
    command: {
      type: 'load',
      netlist: assembled.netlist,
      probes,
      analysis: transient ? { kind: 'tran', step, continuous: true } : { kind: 'op' },
    },
    pacing: screens.length
      ? { type: 'setPacing', mode: 'window', windowSec: Math.max(...screens) }
      : { type: 'setPacing', mode: 'realtime' },
    scopes,
    assembled,
    meters,
    supplies,
    checkInput,
    needsPreflight: meters.some(
      (meter) => isSelfPoweredMode(meter.config.mode) && !checkInstrumentJacks(meter.config, meter.connectedJacks),
    ),
  }
}

/** 只有显示设置（V/div、触发等）变化时网表、分析、探针和仪表档位都不变，不必重新载入仿真 */
export function sameSimulation(a: MeasurementPlan, b: MeasurementPlan): boolean {
  const key = (plan: MeasurementPlan) =>
    JSON.stringify([
      plan.command.netlist,
      plan.command.analysis,
      plan.command.probes.map(({ kind, node, nodeRef, source }) => [kind, node, nodeRef, source]),
      plan.pacing,
      plan.needsPreflight,
      // 换量程只改读数换算、不改网表，也必须重新发布读数
      plan.meters.map(({ instanceId, config, connectedJacks }) => [
        instanceId,
        { ...config, instrument: config.instrument.id },
        connectedJacks,
      ]),
      plan.supplies.map(({ instanceId, screenId, range }) => [instanceId, screenId, range]),
    ])
  return key(a) === key(b)
}
