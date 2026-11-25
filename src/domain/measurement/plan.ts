import type { Probe, SimCommand } from '../../shared/ipc/sim.ts'
import type { Instrument } from '../../shared/schema/instrument.ts'
import { type AssembleInput, type AssembleOutput, assembleNetlist, spiceSafe } from '../circuit/assemble.ts'
import { type ModuleParameter, moduleParameters } from '../circuit/module-controls.ts'
import {
  activeInstrumentDefinition,
  checkInstrumentJacks,
  getRangeSettings,
  instrumentProbe,
  isAcTransientMode,
  isMeasurementInstrument,
  isSelfPoweredMode,
  type RangeSettings,
  type ResolvedCurrentSource,
  type ResolvedDcChannel,
  type ResolvedInstrument,
  resolveDcSupply,
  resolveInstrument,
  resolveScope,
  SEGMENT7_NAMES,
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
  screenId: 'CH1' | 'CH2' | 'V5' | 'IS'
  kind: 'cvcc' | 'currentSource'
  range: RangeSettings
  voltageProbe: string
  currentProbe: string
  wired: boolean
  channel?: ResolvedDcChannel
  currentSource?: ResolvedCurrentSource
}
export type ScopePlan = {
  instanceId: string
  /** probe 缺省表示该通道信号端未接线 */
  channels: { id: string; probe?: string; groundWired: boolean }[]
}
export type SimPacing = Extract<SimCommand, { type: 'setPacing' }>
export type SpeakerPlan = { instanceId: string; indicatorId: string; probe: string; fullScale: number }
export type Segment7Plan = {
  instanceId: string
  indicatorId: string
  label: string
  probes: readonly [string, string, string, string, string, string, string]
  threshold: number
}
export type LedPlan = {
  instanceId: string
  indicatorId: string
  label: string
  probe: string
  threshold: number
}

/** 示波器通道探针 ID 固定，2D 面板、3D 屏幕和弹出窗口按同一 ID 读环形缓冲 */
export const scopeProbeId = (instanceId: string, channelId: string) => `scope:${instanceId}:${channelId}`
export const indicatorProbeId = (instanceId: string, indicatorId: string) => `indicator:${instanceId}:${indicatorId}`
export const SPEAKER_MAX_STEP = 1 / 44_100

export type MeasurementPlan = {
  command: Extract<SimCommand, { type: 'load' }>
  /** 示波器按屏幕时间窗口推进（SIM-11），其余按真实时间 */
  pacing: SimPacing
  parameters: ModuleParameter[]
  speakers: SpeakerPlan[]
  segment7s: Segment7Plan[]
  leds: LedPlan[]
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
    if ((entry.instrument.kind === 'dcSupply' || entry.instrument.kind === 'acSupply') && !powered)
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
  const parameters = moduleParameters(input.modules, input.controlValues)
  const probes: Probe[] = []
  const speakers: SpeakerPlan[] = []
  const segment7s: Segment7Plan[] = []
  const leds: LedPlan[] = []
  if (powered && !options.preflight) {
    for (const { instanceId, module } of input.modules) {
      const safeInstance = spiceSafe(instanceId)
      for (const indicator of module.indicators) {
        if (indicator.kind === 'led') {
          const probe = indicatorProbeId(instanceId, indicator.id)
          const commonNode = indicator.common ? assembled.nodeOf[`${instanceId}.${indicator.common}`] : '0'
          const node = assembled.nodeOf[`${instanceId}.${indicator.probe}`] ?? `x${safeInstance}.${indicator.probe}`
          probes.push({ id: probe, kind: 'v', node, nodeRef: commonNode })
          leds.push({
            instanceId,
            indicatorId: indicator.id,
            label: indicator.label ?? indicator.id,
            probe,
            threshold: indicator.threshold,
          })
          continue
        }
        if (indicator.kind === 'speaker') {
          const probe = indicatorProbeId(instanceId, indicator.id)
          probes.push({
            id: probe,
            kind: 'v',
            node: assembled.nodeOf[`${instanceId}.${indicator.between[0]}`],
            nodeRef: assembled.nodeOf[`${instanceId}.${indicator.between[1]}`],
          })
          speakers.push({ instanceId, indicatorId: indicator.id, probe, fullScale: indicator.audio.fullScale })
          continue
        }
        if (indicator.kind === 'segment7' && indicator.segments) {
          const commonNode = indicator.common ? assembled.nodeOf[`${instanceId}.${indicator.common}`] : '0'
          const segProbes = indicator.segments.map((segNode, idx) => {
            const probeId = `${indicatorProbeId(instanceId, indicator.id)}:${SEGMENT7_NAMES[idx]}`
            const node = assembled.nodeOf[`${instanceId}.${segNode}`] ?? `x${safeInstance}.${segNode}`
            probes.push({
              id: probeId,
              kind: 'v',
              node,
              nodeRef: commonNode,
            })
            return probeId
          }) as [string, string, string, string, string, string, string]
          segment7s.push({
            instanceId,
            indicatorId: indicator.id,
            label: indicator.label ?? indicator.id,
            probes: segProbes,
            threshold: indicator.threshold,
          })
        }
      }
    }
  }
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
    const suffix = assembled.instrumentSuffix[instanceId]
    if (instrument.kind !== 'dcSupply' || !suffix) continue
    const range = getRangeSettings(instrument, settings)
    const dc = resolveDcSupply(instrument, settings)
    const channels: [ResolvedDcChannel, string][] = [
      [dc.ch1, 'ch1'],
      [dc.ch2, 'ch2'],
      ...(dc.v5 ? ([[dc.v5, 'v5']] as [ResolvedDcChannel, string][]) : []),
    ]
    for (const [channel, tag] of channels) {
      const channelWired =
        wired.has(`${instanceId}.${channel.positiveJack}`) && wired.has(`${instanceId}.${channel.negativeJack}`)
      const anyWired =
        wired.has(`${instanceId}.${channel.positiveJack}`) || wired.has(`${instanceId}.${channel.negativeJack}`)
      const voltageProbe = `${token}:${instanceId}:${tag}`
      const currentProbe = `${token}:${instanceId}:${tag}:i`
      if (anyWired) {
        probes.push({
          id: voltageProbe,
          kind: 'v',
          node: assembled.nodeOf[`${instanceId}.${channel.positiveJack}`],
          nodeRef: assembled.nodeOf[`${instanceId}.${channel.negativeJack}`],
        })
      }
      if (!options.preflight && powered && channelWired) {
        probes.push({
          id: currentProbe,
          kind: 'i',
          source: `vs${tag}_${suffix.toLowerCase()}`,
        })
      }
      supplies.push({
        instanceId,
        screenId: channel.id,
        kind: 'cvcc',
        range,
        voltageProbe,
        currentProbe,
        wired: channelWired,
        channel,
      })
    }
    if (dc.currentSource) {
      const cs = dc.currentSource
      const csWired = wired.has(`${instanceId}.${cs.positiveJack}`) && wired.has(`${instanceId}.${cs.negativeJack}`)
      const anyCsWired = wired.has(`${instanceId}.${cs.positiveJack}`) || wired.has(`${instanceId}.${cs.negativeJack}`)
      const voltageProbe = `${token}:${instanceId}:is`
      const currentProbe = `${token}:${instanceId}:is:i`
      if (anyCsWired) {
        probes.push({
          id: voltageProbe,
          kind: 'v',
          node: assembled.nodeOf[`${instanceId}.${cs.positiveJack}`],
          nodeRef: assembled.nodeOf[`${instanceId}.${cs.negativeJack}`],
        })
      }
      if (!options.preflight && powered && csWired) {
        probes.push({
          id: currentProbe,
          kind: 'i',
          source: `vsis_${suffix.toLowerCase()}`,
        })
      }
      supplies.push({
        instanceId,
        screenId: 'IS',
        kind: 'currentSource',
        range,
        voltageProbe,
        currentProbe,
        wired: csWired,
        currentSource: cs,
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
    !options.preflight && meters.some((meter) => isAcTransientMode(meter.config.mode) && meter.voltageProbe)
  const simulations =
    powered && !options.preflight ? input.modules.flatMap(({ module }) => module.simulation ?? []) : []
  const realtime = speakers.length > 0 || simulations.some((simulation) => simulation.pacing !== 'window')
  const transient =
    !options.preflight &&
    (alternating ||
      (powered && (screens.length > 0 || shortest !== undefined || simulations.length > 0 || speakers.length > 0)))
  let step = screens.length
    ? scopeSampleStep(screens, pointsPerScreen, shortest)
    : Math.min(METER_SAMPLE_STEP, shortest ? shortest / 1000 : METER_SAMPLE_STEP)
  if (alternating) step = Math.min(step, METER_SAMPLE_STEP)
  for (const simulation of simulations) step = Math.min(step, simulation.maxStep)
  if (speakers.length) step = Math.min(step, SPEAKER_MAX_STEP)
  return {
    command: {
      type: 'load',
      netlist: assembled.netlist,
      probes,
      analysis: transient ? { kind: 'tran', step, continuous: true } : { kind: 'op' },
      parameterTargets: parameters.flatMap((parameter) =>
        parameter.targets
          ? [{ param: parameter.param, elements: parameter.targets.map((target) => target.element) }]
          : [],
      ),
    },
    pacing:
      screens.length && !realtime
        ? { type: 'setPacing', mode: 'window', windowSec: Math.max(...screens) }
        : { type: 'setPacing', mode: 'realtime' },
    parameters,
    speakers,
    segment7s,
    leds,
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
  return simulationKey(a) === simulationKey(b)
}

function simulationKey(plan: MeasurementPlan, ignoreParameters = false): string {
  const mutable = new Set(plan.parameters.map((parameter) => parameter.param))
  const netlist = ignoreParameters
    ? plan.command.netlist
        .split(/\r?\n/)
        .map((line) => {
          const match = /^\.param\s+([A-Za-z_]\w*)=.+$/.exec(line)
          return match && mutable.has(match[1] as string) ? `.param ${match[1]}=<module-setting>` : line
        })
        .join('\n')
    : plan.command.netlist
  return JSON.stringify([
    netlist,
    plan.command.analysis,
    plan.command.probes.map(({ kind, node, nodeRef, source }) => [kind, node, nodeRef, source]),
    plan.pacing,
    plan.needsPreflight,
    // 换量程只改读数换算、不改网表，也必须重新发布读数；功率表切换 P/Q/S/cosφ/U/I 仅切显示，不重启瞬态窗口
    plan.meters.map(({ instanceId, config, connectedJacks }) => [
      instanceId,
      {
        ...config,
        instrument: config.instrument.id,
        wattmeter: config.wattmeter ? { ...config.wattmeter, displayMode: '<display>' } : undefined,
      },
      connectedJacks,
    ]),
    plan.supplies.map(({ instanceId, screenId, range, channel, currentSource }) => [
      instanceId,
      screenId,
      range,
      channel,
      currentSource,
    ]),
    plan.speakers,
    plan.segment7s,
    plan.leds,
    plan.parameters.length ? plan.command.parameterTargets : undefined,
    plan.parameters.map(({ controlRef, param, value, targets }) => [
      controlRef,
      param,
      targets?.map((target) => (ignoreParameters ? target.element : [target.element, target.value])),
      ...(ignoreParameters ? [] : [value]),
    ]),
  ])
}

/** Only declared module numeric parameters may change without loading a new circuit. */
export function moduleControlChanges(
  a: MeasurementPlan,
  b: MeasurementPlan,
): { param: string; value: number; targets?: { element: string; value: number }[] }[] | undefined {
  if (simulationKey(a, true) !== simulationKey(b, true)) return undefined
  return b.parameters.flatMap((parameter, index) =>
    a.parameters[index]?.value === parameter.value
      ? []
      : [
          {
            param: parameter.param,
            value: parameter.value,
            ...(parameter.targets ? { targets: parameter.targets } : {}),
          },
        ],
  )
}
