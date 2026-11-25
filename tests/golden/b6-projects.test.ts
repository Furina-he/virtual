import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import {
  evaluateSegment7,
  getInstrumentDefaults,
  measureSignal,
  readInstrument,
} from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import {
  createFaultFlowState,
  type MeasurementSnapshot,
  observeFaultSymptom,
  recordFaultMeasurement,
  repairFault,
  scopedReference,
  startFaultSession,
  submitFaultDiagnosis,
  verifyFaultRepair,
} from '../../src/domain/task/index.ts'
import { checkWiring, detectDanger } from '../../src/domain/wiring-check/index.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

type ProjectFault = NonNullable<Project['faults']>[number]

// M2 B6（SD-13~21；SD-22 已有独立实时/音频/流程验证）真实 ngspice 全流程金标准验证：
// 覆盖 555 多谐/单稳/施密特 + C2 开路故障、微分型单稳（SIM-09）、74LS121/123 不可/可重触发单稳、
// 74LS14/CD40106 施密特整形与 RC 振荡、声光控路灯（SIM-10）、8 线 TDM 传输、
// 74LS194/175 环形/扭环形节拍器、32768 Hz CD4060+74LS74 1 Hz 秒脉冲（SIM-11）及伺服电机 60 槽光电测速。

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const loadIns = (id: string) => Instrument.parse(loadJson(`content/instruments/${id}/instrument.json`))
const loadMod = (id: string) => Module.parse(loadJson(`content/modules/${id}/module.json`))
const loadProject = (id: string) => Project.parse(loadJson(`content/projects/${id}/project.json`))

const LIBRARIES = {
  'ttl.lib': readFileSync('content/models/spice/ttl.lib', 'utf8'),
  'cmos.lib': readFileSync('content/models/spice/cmos.lib', 'utf8'),
  'timers.lib': readFileSync('content/models/spice/timers.lib', 'utf8'),
  'sensors.lib': readFileSync('content/models/spice/sensors.lib', 'utf8'),
}
const loadModCir = (id: string) =>
  expandLocalLibraries(readFileSync(`content/modules/${id}/module.cir`, 'utf8'), LIBRARIES)

const mod555 = loadMod('mod-555-app')
const cir555 = loadModCir('mod-555-app')
const modPulse = loadMod('mod-dig-pulse')
const cirPulse = loadModCir('mod-dig-pulse')
const modStreet = loadMod('mod-app-street-light')
const cirStreet = loadModCir('mod-app-street-light')
const modMux = loadMod('mod-dig-mux-bus')
const cirMux = loadModCir('mod-dig-mux-bus')
const modRing = loadMod('mod-dig-ring')
const cirRing = loadModCir('mod-dig-ring')
const modSec = loadMod('mod-app-second-pulse')
const cirSec = loadModCir('mod-app-second-pulse')
const modSpeed = loadMod('mod-motor-speed')
const cirSpeed = loadModCir('mod-motor-speed')
const modDig = loadMod('mod-digital-logic')
const cirDig = loadModCir('mod-digital-logic')

const dcPower = loadIns('ins-dc-power')
const dcVolt = loadIns('ins-dc-voltmeter')
const funcGen = loadIns('ins-func-gen')
const scope = loadIns('ins-oscilloscope')

const events: SimEvent[] = []
const session = new SimSession(
  resolve(import.meta.dirname, '../../resources/ngspice'),
  (event) => events.push(event),
  () => {},
)
afterAll(() => session.dispose())

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing expected value: ${label}`)
  return value
}

function defaultIns(
  instanceId: string,
  instrument: Instrument,
  overrides: Record<string, number | string | boolean> = {},
) {
  return {
    instanceId,
    instrument,
    settings: { ...getInstrumentDefaults(instrument), ...overrides },
  }
}

async function pauseAndIdle(): Promise<void> {
  session.handle({ type: 'pause' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'status' && (ev.state === 'paused' || ev.state === 'idle')) return
    }
  }
}

function assertWiringClean(
  project: Project,
  stepId: string | undefined,
  plan: ReturnType<typeof buildMeasurementPlan>,
) {
  const step = stepId ? project.steps.find((s) => s.id === stepId) : undefined
  const report = checkWiring(plan.checkInput, scopedReference(project, step))
  expect(report.issues, `${project.id}/${stepId ?? 'default'}`).toEqual([])
  expect(report.circuitOk).toBe(true)
  expect(report.measurementsOk).toBe(true)
  expect(detectDanger(plan.checkInput)).toEqual([])
}

function pulseWidthMs(arr: readonly number[], dt: number, thresh = 1.8): number {
  let tRise = -1
  for (let i = 1; i < arr.length; i++) {
    const prev = arr[i - 1] ?? 0
    const cur = arr[i] ?? 0
    if (tRise < 0 && prev < thresh && cur >= thresh) tRise = i * dt
    else if (tRise >= 0 && prev >= thresh && cur < thresh) return (i * dt - tRise) * 1000
  }
  return 0
}

async function runTran(
  input: AssembleInput,
  durationSec: number,
  options: {
    settleSec?: number
    stepOverride?: number
    alters?: Array<{ atSec: number; controlValues: Record<string, number> }>
  } = {},
) {
  const plan = buildMeasurementPlan({ ...input, controlValues: input.controlValues ?? {} }, true, 'b6-tran')
  const step = options.stepOverride ?? (plan.command.analysis.kind === 'tran' ? plan.command.analysis.step : 0.0005)
  const loadCmd = {
    ...plan.command,
    analysis: { kind: 'tran' as const, step, continuous: true as const },
  }
  events.length = 0
  session.handle(loadCmd)
  session.handle({
    type: 'setPacing',
    mode: 'window',
    ...(options.alters?.length ? { windowSec: 0.002 } : {}),
  })

  const probeIds = loadCmd.probes.map((p) => p.id)
  const times: number[] = []
  const channels: Record<string, number[]> = Object.fromEntries(probeIds.map((id) => [id, []]))
  const alters = [...(options.alters ?? [])].sort((a, b) => a.atSec - b.atSec)
  const alterTimes: number[] = []
  let nextAlterIdx = 0
  let alterPending = false
  let curControls = { ...input.controlValues }
  let loaded = false
  let dtOut = step
  const logs: string[] = []
  const deadline = Date.now() + 28_000

  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'log') logs.push(ev.line)
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})\n${logs.slice(-12).join('\n')}`)
      if (ev.type === 'loaded') {
        loaded = true
        session.handle({ type: 'run' })
      }
      if (ev.type === 'altered') {
        alterTimes.push(ev.simTime)
        alterPending = false
        session.handle({ type: 'run' })
      }
      if (ev.type === 'chunk' && loaded) {
        dtOut = ev.dt
        const firstArr = Object.values(ev.data)[0]
        const count = firstArr?.length ?? 0
        if (count === 0) continue
        for (let i = 0; i < count; i++) times.push(ev.t0 + i * ev.dt)
        for (const id of probeIds) {
          const arr = channels[id] as number[]
          const src = ev.data[id]
          for (let i = 0; i < count; i++) arr.push(src?.[i] ?? 0)
        }
        const simNow = ev.t0 + count * ev.dt
        if (
          !alterPending &&
          nextAlterIdx < alters.length &&
          simNow >= (alters[nextAlterIdx]?.atSec ?? Number.POSITIVE_INFINITY)
        ) {
          const item = alters[nextAlterIdx++]
          if (item) {
            alterPending = true
            curControls = { ...curControls, ...item.controlValues }
            const nextPlan = buildMeasurementPlan({ ...input, controlValues: curControls }, true, 'b6-alter')
            const changes = nextPlan.parameters.map((p) => ({
              param: p.param,
              value: p.value,
              ...(p.targets ? { targets: p.targets } : {}),
            }))
            session.handle({ type: 'pause' })
            session.handle({ type: 'alter', changes })
          }
        }
        if (!alterPending && nextAlterIdx >= alters.length && simNow >= durationSec) {
          await pauseAndIdle()
          const settle = options.settleSec ?? durationSec * 0.35
          const startIdx = Math.max(
            times.findIndex((t) => t >= settle),
            0,
          )
          const endIdx = times.length
          const slice = (probeId: string) => defined(channels[probeId], `probe ${probeId}`).slice(startIdx, endIdx)
          const lastVal = (probeId: string) => defined(channels[probeId], `probe ${probeId}`).at(-1) ?? 0
          const valAt = (probeId: string, tq: number) => {
            const idx = times.findIndex((t) => t >= tq)
            return defined(channels[probeId], `probe ${probeId}`)[idx >= 0 ? idx : endIdx - 1] ?? 0
          }
          const ledAt = (instanceId: string, indicatorId: string, tq?: number): 0 | 1 => {
            const led = defined(
              plan.leds.find((l) => l.instanceId === instanceId && l.indicatorId === indicatorId),
              `led ${instanceId}.${indicatorId}`,
            )
            const v = tq === undefined ? lastVal(led.probe) : valAt(led.probe, tq)
            return v >= led.threshold ? 1 : 0
          }
          const segAt = (instanceId: string, indicatorId: string, tq?: number) => {
            const seg = defined(
              plan.segment7s.find((s) => s.instanceId === instanceId && s.indicatorId === indicatorId),
              `seg ${instanceId}.${indicatorId}`,
            )
            const idx = tq === undefined ? endIdx - 1 : times.findIndex((t) => t >= tq)
            const k = idx >= 0 ? idx : endIdx - 1
            return evaluateSegment7(
              seg.probes.map((p) => channels[p]?.[k]),
              seg.threshold,
            ).char
          }
          const signal = (probeId: string) => measureSignal(Float32Array.from(slice(probeId)), dtOut)
          const mean = (probeId: string) => {
            const arr = slice(probeId)
            return arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length)
          }
          const meterReadings: Record<string, ReturnType<typeof readInstrument>> = {}
          const rawV: Record<string, number> = {}
          for (const meter of plan.meters) {
            const v = meter.voltageProbe ? lastVal(meter.voltageProbe) : undefined
            if (v !== undefined) rawV[meter.instanceId] = v
            meterReadings[meter.instanceId] = readInstrument(meter.config, {
              voltage: v,
              current: meter.currentProbe ? lastVal(meter.currentProbe) : undefined,
              connectedJacks: meter.connectedJacks,
            })
          }
          const scopeWaveforms = plan.scopes.flatMap((sc) =>
            sc.channels.flatMap((ch) => {
              if (!ch.probe) return []
              const meas = signal(ch.probe)
              const cfg = input.instruments
                .find((i) => i.instanceId === sc.instanceId)
                ?.instrument.scope?.channels.find((c) => c.id === ch.id)
              if (!cfg) return []
              return [
                {
                  instanceId: sc.instanceId,
                  channelId: ch.id,
                  positiveRef: `${sc.instanceId}.${cfg.positiveJack}`,
                  negativeRef: `${sc.instanceId}.${cfg.negativeJack}`,
                  coupling: 'dc' as const,
                  current: meas !== null,
                  measurement: meas,
                },
              ]
            }),
          )
          return {
            plan,
            times,
            dtOut,
            alterTimes,
            channels,
            slice,
            lastVal,
            valAt,
            ledAt,
            segAt,
            signal,
            mean,
            rawV,
            snapshot: {
              current: true,
              plan,
              readings: meterReadings,
              waveforms: scopeWaveforms,
            } satisfies MeasurementSnapshot,
          }
        }
      }
    }
  }
  throw new Error(`Timed out running transient: ${input.title}\n${logs.slice(-10).join('\n')}`)
}

function runFaultClosedLoop(
  project: Project,
  fault: ProjectFault,
  badSnapshot: MeasurementSnapshot,
  fixedSnapshot: MeasurementSnapshot,
) {
  let flow = createFaultFlowState()
  flow = startFaultSession(project, flow, { mode: 'preset', faultId: fault.id, nowMs: 100 }).state
  flow = observeFaultSymptom(project, flow, { powered: true, nowMs: 200 }).state
  flow = recordFaultMeasurement(project, flow, { snapshot: badSnapshot, nowMs: 300 }).state
  const diag = submitFaultDiagnosis(project, flow, { target: fault.target, kind: fault.kind, nowMs: 400 })
  expect(diag.ok, `${project.id}/${fault.id} diag`).toBe(true)
  flow = repairFault(project, diag.state, { powered: false, nowMs: 500 }).state
  const verified = verifyFaultRepair(project, flow, { powered: true, snapshot: fixedSnapshot, nowMs: 600 })
  expect(verified.ok, `${project.id}/${fault.id} verify`).toBe(true)
  expect(verified.state.stage).toBe('completed')
}

describe('M2 B6（SD-13~21）真实 ngspice 全流程金标准验证', () => {
  it('SD-13：NE555 多谐振荡（~1023 Hz）、单稳态（~0.52 ms）、施密特整形及 C2 开路故障闭环', async () => {
    const project = loadProject('SD-13')
    const gndCaps = [
      { a: 'ins-dc-power.CH1N', b: 'timer1.GND1' },
      { a: 'ins-dc-power.CH1N', b: 'timer1.T1_CT_N' },
      { a: 'ins-dc-power.CH1N', b: 'timer1.T1_CC_2' },
      { a: 'ins-dc-power.CH1N', b: 'timer1.T2_CT_N' },
      { a: 'ins-dc-power.CH1N', b: 'timer1.T2_CC_2' },
      { a: 'ins-dc-power.CH1N', b: 'timer1.C5_N' },
    ]
    // 1. 多谐振荡器（IC2: RA2=10k, RB2=10k, C2=47n；沿用 SD-22 同款 CH1=5 V 供电）
    const wAst = [
      { a: 'ins-dc-power.CH1P', b: 'timer1.VCC1' },
      { a: 'ins-dc-power.CH1P', b: 'timer1.T2_RST' },
      { a: 'ins-dc-power.CH1P', b: 'timer1.T2_RA_1' },
      ...gndCaps,
      { a: 'timer1.T2_RA_2', b: 'timer1.T2_DIS' },
      { a: 'timer1.T2_RA_2', b: 'timer1.T2_RB_1' },
      { a: 'timer1.T2_RB_2', b: 'timer1.T2_TH' },
      { a: 'timer1.T2_RB_2', b: 'timer1.T2_TR' },
      { a: 'timer1.T2_RB_2', b: 'timer1.T2_CT_P' },
      { a: 'timer1.T2_CV', b: 'timer1.T2_CC_1' },
      { a: 'scope1.CH1', b: 'timer1.T2_OUT' },
      { a: 'scope1.GND', b: 'timer1.GND1' },
      { a: 'ins-dc-voltmeter.POS', b: 'timer1.T2_CV' },
      { a: 'ins-dc-voltmeter.NEG', b: 'timer1.GND1' },
    ]
    const ast = await runTran(
      {
        title: 'SD-13 astable',
        modules: [{ instanceId: 'timer1', module: mod555, subckt: cir555 }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 5 }),
          defaultIns('ins-dc-voltmeter', dcVolt),
          defaultIns('scope1', scope, { timebase: 0.0005, sig_on: 0 }),
        ],
        wires: wAst,
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      },
      0.012,
      { settleSec: 0.003, stepOverride: 5e-6 },
    )
    assertWiringClean(project, 'astable', ast.plan)
    const fAst = ast.signal('scope:scope1:CH1')?.frequency ?? 0
    expect(fAst).toBeGreaterThan(970)
    expect(fAst).toBeLessThan(1070)
    expect(ast.rawV['ins-dc-voltmeter'] ?? 0).toBeGreaterThan(3.2)
    expect(ast.rawV['ins-dc-voltmeter'] ?? 0).toBeLessThan(3.45)

    // 2. 单稳态触发器（RA2=10k, C2=47n -> tw = 1.1*RC ≈ 0.517 ms）
    const wMono = [
      { a: 'ins-dc-power.CH1P', b: 'timer1.VCC1' },
      { a: 'ins-dc-power.CH1P', b: 'timer1.T2_RST' },
      { a: 'ins-dc-power.CH1P', b: 'timer1.T2_RA_1' },
      ...gndCaps,
      { a: 'ins-dc-power.CH1N', b: 'ins-func-gen.GND' },
      { a: 'timer1.T2_RA_2', b: 'timer1.T2_DIS' },
      { a: 'timer1.T2_RA_2', b: 'timer1.T2_TH' },
      { a: 'timer1.T2_RA_2', b: 'timer1.T2_CT_P' },
      { a: 'timer1.T2_CV', b: 'timer1.T2_CC_1' },
      { a: 'ins-func-gen.CH1', b: 'timer1.T2_TR' },
      { a: 'scope1.CH1', b: 'timer1.T2_OUT' },
      { a: 'scope1.GND', b: 'timer1.GND1' },
    ]
    const mono = await runTran(
      {
        title: 'SD-13 monostable',
        modules: [{ instanceId: 'timer1', module: mod555, subckt: cir555 }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 5 }),
          defaultIns('ins-func-gen', funcGen, {
            ch1_wave: 1,
            ch1_freq: 500,
            ch1_amp: 5,
            ch1_offset: 2.5,
            ch1_duty: 90,
            ch1_on: 1,
          }),
          defaultIns('scope1', scope, { timebase: 0.0005, sig_on: 0 }),
        ],
        wires: wMono,
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      },
      0.008,
      { settleSec: 0.001, stepOverride: 5e-6 },
    )
    assertWiringClean(project, 'monostable', mono.plan)
    const tw555 = pulseWidthMs(mono.slice('scope:scope1:CH1'), mono.dtOut, 2.0)
    expect(tw555).toBeGreaterThan(0.45)
    expect(tw555).toBeLessThan(0.6)

    // 3. 施密特触发器（500 Hz 正弦整形为 500 Hz 方波）
    const wSch = [
      { a: 'ins-dc-power.CH1P', b: 'timer1.VCC1' },
      { a: 'ins-dc-power.CH1P', b: 'timer1.T2_RST' },
      ...gndCaps,
      { a: 'ins-dc-power.CH1N', b: 'ins-func-gen.GND' },
      { a: 'timer1.T2_CV', b: 'timer1.T2_CC_1' },
      { a: 'ins-func-gen.CH1', b: 'timer1.T2_TR' },
      { a: 'ins-func-gen.CH1', b: 'timer1.T2_TH' },
      { a: 'scope1.CH1', b: 'timer1.T2_OUT' },
      { a: 'scope1.GND', b: 'timer1.GND1' },
    ]
    const sch = await runTran(
      {
        title: 'SD-13 schmitt',
        modules: [{ instanceId: 'timer1', module: mod555, subckt: cir555 }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 5 }),
          defaultIns('ins-func-gen', funcGen, {
            ch1_wave: 0,
            ch1_freq: 500,
            ch1_amp: 4.6,
            ch1_offset: 2.5,
            ch1_on: 1,
          }),
          defaultIns('scope1', scope, { timebase: 0.001, sig_on: 0 }),
        ],
        wires: wSch,
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      },
      0.012,
      { settleSec: 0.002, stepOverride: 1e-5 },
    )
    assertWiringClean(project, 'schmitt', sch.plan)
    expect(sch.signal('scope:scope1:CH1')?.frequency ?? 0).toBeGreaterThan(485)
    expect(sch.signal('scope:scope1:CH1')?.frequency ?? 0).toBeLessThan(515)

    // 4. 3 项典型定时故障六步闭环（C2 击穿短路、RA2 开路、C2 严重失容至 4.7 nF）
    const faults = defined(project.faults, 'SD-13 faults')
    expect(faults).toHaveLength(3)
    for (const fault of faults) {
      const bad = await runTran(
        {
          title: `SD-13 ${fault.id}`,
          modules: [{ instanceId: 'timer1', module: mod555, subckt: cir555 }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 5 }),
            defaultIns('scope1', scope, { timebase: 0.0005, sig_on: 0 }),
          ],
          wires: wAst.filter((w) => !w.a.startsWith('ins-dc-voltmeter')),
          ground: 'ins-dc-power.CH1N',
          controlValues: {},
          fault,
          analysis: [],
        },
        0.006,
        { settleSec: 0.001, stepOverride: 5e-6 },
      )
      const sigBad = bad.signal('scope:scope1:CH1')
      if (fault.id === 'flt-c2-drift') {
        expect(sigBad?.vpp ?? 0).toBeGreaterThan(2.5)
        expect(sigBad?.frequency ?? 0).toBeGreaterThan(5000)
      } else {
        // C2 短路或 RA2 开路时停振输出直流（无振荡摆幅）
        expect(sigBad?.vpp ?? 0).toBeLessThan(0.2)
      }
      runFaultClosedLoop(project, fault, bad.snapshot, ast.snapshot)
    }
  }, 30_000)

  it('SD-14：微分型单稳态触发器（SIM-09 数模混合，Rd=1k → 2k 脉宽成比例展宽）', async () => {
    const project = loadProject('SD-14')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'pls1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'pls1.GND' },
      { a: 'ins-dc-power.V5N', b: 'ins-func-gen.GND' },
      { a: 'ins-func-gen.CH1', b: 'pls1.DIF_IN' },
      { a: 'scope1.CH1', b: 'pls1.DIF_G1Y' },
      { a: 'scope1.CH2', b: 'pls1.DIF_RC' },
      { a: 'scope1.GND', b: 'pls1.GND' },
    ]
    const runDif = (rd: number) =>
      runTran(
        {
          title: `SD-14 Rd=${rd}`,
          modules: [{ instanceId: 'pls1', module: modPulse, subckt: cirPulse }],
          instruments: [
            defaultIns('ins-dc-power', dcPower),
            defaultIns('ins-func-gen', funcGen, {
              ch1_wave: 1,
              ch1_freq: 200,
              ch1_amp: 5,
              ch1_offset: 2.5,
              ch1_duty: 90,
              ch1_on: 1,
            }),
            defaultIns('scope1', scope, { timebase: 0.001, sig_on: 0 }),
          ],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'pls1.R_DIF': rd },
          analysis: [],
        },
        0.016,
        { settleSec: 0.004, stepOverride: 5e-6 },
      )
    const r1 = await runDif(1000)
    assertWiringClean(project, 'wire', r1.plan)
    const tw1 = pulseWidthMs(r1.slice('scope:scope1:CH1'), r1.dtOut)
    const r2 = await runDif(2000)
    const tw2 = pulseWidthMs(r2.slice('scope:scope1:CH1'), r2.dtOut)
    expect(tw1).toBeGreaterThan(0.6)
    expect(tw1).toBeLessThan(1.25)
    expect(tw2).toBeGreaterThan(tw1 * 1.6)
    expect(tw2).toBeLessThan(tw1 * 2.8)
  }, 30_000)

  it('SD-15：74LS121（不可重触发）与 74LS123（可重触发 + /CLR）500 Hz 单触发与 2 kHz 重触发对比', async () => {
    const project = loadProject('SD-15')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'pls1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'pls1.GND' },
      { a: 'ins-dc-power.V5N', b: 'ins-func-gen.GND' },
      { a: 'ins-func-gen.CH1', b: 'pls1.M121_B' },
      { a: 'ins-func-gen.CH1', b: 'pls1.M123_B' },
      { a: 'pls1.K_CLR', b: 'pls1.M123_CLR' },
      { a: 'scope1.CH1', b: 'pls1.M121_Q' },
      { a: 'scope1.CH2', b: 'pls1.M123_Q' },
      { a: 'scope1.GND', b: 'pls1.GND' },
    ]
    const runMono = (freq: number) =>
      runTran(
        {
          title: `SD-15 ${freq}Hz`,
          modules: [{ instanceId: 'pls1', module: modPulse, subckt: cirPulse }],
          instruments: [
            defaultIns('ins-dc-power', dcPower),
            defaultIns('ins-func-gen', funcGen, {
              ch1_wave: 1,
              ch1_freq: freq,
              ch1_amp: 5,
              ch1_offset: 2.5,
              ch1_duty: 50,
              ch1_on: 1,
            }),
            defaultIns('scope1', scope, { timebase: 0.0005, sig_on: 0 }),
          ],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'pls1.R_121': 10000, 'pls1.SW_CLR': 1 },
          analysis: [],
        },
        0.009,
        { settleSec: 0.002, stepOverride: 5e-6 },
      )
    const r500 = await runMono(500)
    assertWiringClean(project, 'wire', r500.plan)
    expect(r500.signal('scope:scope1:CH1')?.frequency ?? 0).toBeGreaterThan(480)
    expect(r500.signal('scope:scope1:CH1')?.frequency ?? 0).toBeLessThan(520)
    expect(r500.signal('scope:scope1:CH2')?.frequency ?? 0).toBeGreaterThan(480)
    expect(r500.signal('scope:scope1:CH2')?.frequency ?? 0).toBeLessThan(520)

    const r2k = await runMono(2000)
    // 2 kHz（周期 0.5 ms < 0.68 ms）：74LS121 忽略中间脉冲变为 1 kHz；74LS123 连续重触发保持高电平 (>2.7 V)
    expect(r2k.signal('scope:scope1:CH1')?.frequency ?? 0).toBeGreaterThan(950)
    expect(r2k.signal('scope:scope1:CH1')?.frequency ?? 0).toBeLessThan(1050)
    expect(r2k.mean('scope:scope1:CH2')).toBeGreaterThan(2.8)
  }, 30_000)

  it('SD-16：74LS14 / CD40106 施密特正弦整形及 CD40106 RC 多谐振荡器（4.7k / 10k 切频）', async () => {
    const project = loadProject('SD-16')
    const wShape = [
      { a: 'ins-dc-power.V5P', b: 'pls1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'pls1.GND' },
      { a: 'ins-dc-power.V5N', b: 'ins-func-gen.GND' },
      { a: 'ins-func-gen.CH1', b: 'pls1.S14_IN' },
      { a: 'ins-func-gen.CH1', b: 'pls1.S106_IN' },
      { a: 'scope1.CH1', b: 'pls1.S14_OUT' },
      { a: 'scope1.CH2', b: 'pls1.S106_OUT' },
      { a: 'scope1.GND', b: 'pls1.GND' },
    ]
    const shape = await runTran(
      {
        title: 'SD-16 sine shape',
        modules: [{ instanceId: 'pls1', module: modPulse, subckt: cirPulse }],
        instruments: [
          defaultIns('ins-dc-power', dcPower),
          defaultIns('ins-func-gen', funcGen, {
            ch1_wave: 0,
            ch1_freq: 1000,
            ch1_amp: 4.6,
            ch1_offset: 2.5,
            ch1_on: 1,
          }),
          defaultIns('scope1', scope, { timebase: 0.0005, sig_on: 0 }),
        ],
        wires: wShape,
        ground: 'ins-dc-power.V5N',
        controlValues: {},
        analysis: [],
      },
      0.006,
      { settleSec: 0.001, stepOverride: 5e-6 },
    )
    assertWiringClean(project, 'shape_sine', shape.plan)
    expect(shape.signal('scope:scope1:CH1')?.frequency ?? 0).toBeGreaterThan(970)
    expect(shape.signal('scope:scope1:CH1')?.frequency ?? 0).toBeLessThan(1030)
    expect(shape.signal('scope:scope1:CH2')?.vpp ?? 0).toBeGreaterThan(4.7)

    const wOsc = [
      { a: 'ins-dc-power.V5P', b: 'pls1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'pls1.GND' },
      { a: 'pls1.S106_OUT', b: 'pls1.OSC_R' },
      { a: 'pls1.OSC_C', b: 'pls1.S106_IN' },
      { a: 'scope1.CH1', b: 'pls1.S106_OUT' },
      { a: 'scope1.GND', b: 'pls1.GND' },
    ]
    const osc4k7 = await runTran(
      {
        title: 'SD-16 osc 4.7k',
        modules: [{ instanceId: 'pls1', module: modPulse, subckt: cirPulse }],
        instruments: [
          defaultIns('ins-dc-power', dcPower),
          defaultIns('scope1', scope, { timebase: 0.0002, sig_on: 0 }),
        ],
        wires: wOsc,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'pls1.R_OSC': 4700 },
        analysis: [],
      },
      0.006,
      { settleSec: 0.001, stepOverride: 5e-6 },
    )
    assertWiringClean(project, 'rc_osc', osc4k7.plan)
    const f4k7 = osc4k7.signal('scope:scope1:CH1')?.frequency ?? 0
    expect(f4k7).toBeGreaterThan(2200)
    expect(f4k7).toBeLessThan(2550)

    const osc10k = await runTran(
      {
        title: 'SD-16 osc 10k',
        modules: [{ instanceId: 'pls1', module: modPulse, subckt: cirPulse }],
        instruments: [
          defaultIns('ins-dc-power', dcPower),
          defaultIns('scope1', scope, { timebase: 0.0005, sig_on: 0 }),
        ],
        wires: wOsc,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'pls1.R_OSC': 10000 },
        analysis: [],
      },
      0.01,
      { settleSec: 0.002, stepOverride: 5e-6 },
    )
    const f10k = osc10k.signal('scope:scope1:CH1')?.frequency ?? 0
    expect(f10k).toBeGreaterThan(1020)
    expect(f10k).toBeLessThan(1260)
  }, 30_000)

  it('SD-17：声光控制节能路灯（白天有声灭、黑夜无声灭、黑夜拍手亮 12 V 且声停后延时熄灭）', async () => {
    const project = loadProject('SD-17')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'stl1.VCC' },
      { a: 'ins-dc-power.CH1P', b: 'stl1.LAMP_V12' },
      { a: 'ins-dc-power.V5N', b: 'stl1.GND' },
      { a: 'ins-dc-power.CH1N', b: 'stl1.GND' },
      { a: 'stl1.GND', b: 'stl1.LAMP_GND' },
      { a: 'stl1.DRV_OUT', b: 'stl1.REL_IN' },
      { a: 'stl1.REL_NO', b: 'stl1.LAMP_IN' },
      { a: 'ins-dc-voltmeter.POS', b: 'stl1.LAMP_IN' },
      { a: 'ins-dc-voltmeter.NEG', b: 'stl1.LAMP_GND' },
    ]
    const runStl = (
      lux: number,
      sound: number,
      alters?: Array<{ atSec: number; controlValues: Record<string, number> }>,
      dur = 0.08,
    ) =>
      runTran(
        {
          title: `SD-17 lux=${lux} snd=${sound}`,
          modules: [{ instanceId: 'stl1', module: modStreet, subckt: cirStreet }],
          instruments: [defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }), defaultIns('ins-dc-voltmeter', dcVolt)],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'stl1.LIGHT_LUX': lux, 'stl1.SOUND_LVL': sound },
          analysis: [],
        },
        dur,
        { settleSec: 0.01, stepOverride: 0.001, ...(alters ? { alters } : {}) },
      )
    // 1. 白天 500 lx + 拍手声 -> 不亮
    const day = await runStl(500, 1)
    assertWiringClean(project, 'wire', day.plan)
    expect(day.rawV['ins-dc-voltmeter'] ?? 9).toBeLessThan(0.2)
    expect(day.ledAt('stl1', 'L_DARK')).toBe(0)
    expect(day.ledAt('stl1', 'L_LAMP')).toBe(0)

    // 2. 黑夜 0 lx + 安静 -> 不亮
    const quiet = await runStl(0, 0)
    expect(quiet.rawV['ins-dc-voltmeter'] ?? 9).toBeLessThan(0.2)
    expect(quiet.ledAt('stl1', 'L_DARK')).toBe(1)
    expect(quiet.ledAt('stl1', 'L_LAMP')).toBe(0)

    // 3. 黑夜 0 lx + 拍手声 -> 亮 12 V；0.08 s 声音停止后短暂延时保持，至 0.55 s 自动熄灭
    const trig = await runStl(0, 1, [{ atSec: 0.08, controlValues: { 'stl1.SOUND_LVL': 0 } }], 0.6)
    expect(trig.ledAt('stl1', 'L_LAMP', 0.05)).toBe(1)
    expect(trig.ledAt('stl1', 'L_LAMP', defined(trig.alterTimes[0], 'alter0') + 0.05)).toBe(1) // 延时保持亮
    expect(trig.rawV['ins-dc-voltmeter'] ?? 9).toBeLessThan(0.5) // 延时结束自动熄灭
  }, 30_000)

  it('SD-18：8 线时分复用数据传输（74LS161 + 74LS151 + 74LS138 逐通道验证与 8 通道扫描）', async () => {
    const project = loadProject('SD-18')
    const baseWires = [
      { a: 'ins-dc-power.V5P', b: 'mux1.VCC' },
      { a: 'ins-dc-power.V5P', b: 'mux1.CNT_CLR' },
      { a: 'ins-dc-power.V5N', b: 'mux1.GND' },
      { a: 'mux1.CNT_A0', b: 'mux1.TX_A0' },
      { a: 'mux1.CNT_A0', b: 'mux1.RX_A0' },
      { a: 'mux1.CNT_A1', b: 'mux1.TX_A1' },
      { a: 'mux1.CNT_A1', b: 'mux1.RX_A1' },
      { a: 'mux1.CNT_A2', b: 'mux1.TX_A2' },
      { a: 'mux1.CNT_A2', b: 'mux1.RX_A2' },
      { a: 'mux1.TX_Y', b: 'mux1.RX_DIN' },
    ]
    // 单次脉冲验证地址 0 (D0=1 -> RX0=1) 与地址 1 (D1=0 -> 全 RX=0) 与地址 2 (D2=1 -> RX2=1)
    const step = await runTran(
      {
        title: 'SD-18 step',
        modules: [{ instanceId: 'mux1', module: modMux, subckt: cirMux }],
        instruments: [defaultIns('ins-dc-power', dcPower)],
        wires: [...baseWires, { a: 'mux1.CP_MAN', b: 'mux1.CNT_CP' }],
        ground: 'ins-dc-power.V5N',
        controlValues: { 'mux1.TX_LOW': 5, 'mux1.TX_HIGH': 10, 'mux1.CP_BTN': 0 },
        analysis: [],
      },
      0.34,
      {
        stepOverride: 0.001,
        alters: [
          { atSec: 0.06, controlValues: { 'mux1.CP_BTN': 1 } }, // 地址 1 (D1=0)
          { atSec: 0.14, controlValues: { 'mux1.CP_BTN': 0 } },
          { atSec: 0.22, controlValues: { 'mux1.CP_BTN': 1 } }, // 地址 2 (D2=1)
        ],
      },
    )
    assertWiringClean(project, 'wire', step.plan)
    expect(step.ledAt('mux1', 'L_BUS', 0.03)).toBe(1)
    expect(step.ledAt('mux1', 'L_RX0', 0.03)).toBe(1)
    expect(step.ledAt('mux1', 'L_RX1', 0.03)).toBe(0)
    const tAddr1 = defined(step.alterTimes[0], 'addr1') + 0.02
    expect(step.ledAt('mux1', 'L_A0', tAddr1)).toBe(1)
    expect(step.ledAt('mux1', 'L_BUS', tAddr1)).toBe(0)
    expect(step.ledAt('mux1', 'L_RX1', tAddr1)).toBe(0)
    const tAddr2 = defined(step.alterTimes[2], 'addr2') + 0.02
    expect(step.ledAt('mux1', 'L_A1', tAddr2)).toBe(1)
    expect(step.ledAt('mux1', 'L_BUS', tAddr2)).toBe(1)
    expect(step.ledAt('mux1', 'L_RX2', tAddr2)).toBe(1)
    expect(step.ledAt('mux1', 'L_RX0', tAddr2)).toBe(0)

    // 连续 10 Hz 扫描 -> f_A2 = 1.25 Hz
    const scan = await runTran(
      {
        title: 'SD-18 scan',
        modules: [{ instanceId: 'mux1', module: modMux, subckt: cirMux }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.2, sig_on: 0 })],
        wires: [
          ...baseWires,
          { a: 'mux1.CLK_OUT', b: 'mux1.CNT_CP' },
          { a: 'scope1.CH1', b: 'mux1.CNT_CP' },
          { a: 'scope1.CH2', b: 'mux1.CNT_A2' },
          { a: 'scope1.GND', b: 'mux1.GND' },
        ],
        ground: 'ins-dc-power.V5N',
        controlValues: { 'mux1.CLK_RATE': 10 },
        analysis: [],
      },
      2.2,
      { settleSec: 0.1, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'continuous_scan', scan.plan)
    expect(scan.signal('scope:scope1:CH2')?.frequency ?? 0).toBeGreaterThan(1.18)
    expect(scan.signal('scope:scope1:CH2')?.frequency ?? 0).toBeLessThan(1.32)
  }, 30_000)

  it('SD-19：4 位自启动环形节拍发生器（74LS194，f/4）与扭环形约翰逊计数器（74LS175，f/8）', async () => {
    const project = loadProject('SD-19')
    // 1. 74LS194 自启动四拍环形计数器（10 Hz -> 2.5 Hz）
    const r194 = await runTran(
      {
        title: 'SD-19 74LS194 ring',
        modules: [{ instanceId: 'rng1', module: modRing, subckt: cirRing }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.2, sig_on: 0 })],
        wires: [
          { a: 'ins-dc-power.V5P', b: 'rng1.VCC' },
          { a: 'ins-dc-power.V5P', b: 'rng1.R194_CLR' },
          { a: 'ins-dc-power.V5P', b: 'rng1.R194_S0' },
          { a: 'ins-dc-power.V5N', b: 'rng1.GND' },
          { a: 'ins-dc-power.V5N', b: 'rng1.R194_S1' },
          { a: 'rng1.CLK_OUT', b: 'rng1.R194_CP' },
          { a: 'rng1.R194_FB', b: 'rng1.R194_SR' },
          { a: 'scope1.CH1', b: 'rng1.CLK_OUT' },
          { a: 'scope1.CH2', b: 'rng1.R194_QA' },
          { a: 'scope1.GND', b: 'rng1.GND' },
        ],
        ground: 'ins-dc-power.V5N',
        controlValues: { 'rng1.CLK_RATE': 10 },
        analysis: [],
      },
      1.6,
      { settleSec: 0.15, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'wire', r194.plan)
    expect(r194.signal('scope:scope1:CH2')?.frequency ?? 0).toBeGreaterThan(2.38)
    expect(r194.signal('scope:scope1:CH2')?.frequency ?? 0).toBeLessThan(2.62)

    // 2. 74LS175 扭环形计数器（10 Hz -> 1.25 Hz）
    const r175 = await runTran(
      {
        title: 'SD-19 74LS175 johnson',
        modules: [{ instanceId: 'rng1', module: modRing, subckt: cirRing }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.2, sig_on: 0 })],
        wires: [
          { a: 'ins-dc-power.V5P', b: 'rng1.VCC' },
          { a: 'ins-dc-power.V5P', b: 'rng1.R175_CLR' },
          { a: 'ins-dc-power.V5N', b: 'rng1.GND' },
          { a: 'rng1.CLK_OUT', b: 'rng1.R175_CP' },
          { a: 'rng1.R175_NQ4', b: 'rng1.R175_D1' },
          { a: 'scope1.CH1', b: 'rng1.CLK_OUT' },
          { a: 'scope1.CH2', b: 'rng1.R175_Q1' },
          { a: 'scope1.GND', b: 'rng1.GND' },
        ],
        ground: 'ins-dc-power.V5N',
        controlValues: { 'rng1.CLK_RATE': 10 },
        analysis: [],
      },
      2.2,
      { settleSec: 0.15, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'johnson_175', r175.plan)
    expect(r175.signal('scope:scope1:CH2')?.frequency ?? 0).toBeGreaterThan(1.18)
    expect(r175.signal('scope:scope1:CH2')?.frequency ?? 0).toBeLessThan(1.32)
  }, 30_000)

  it('SD-20：秒脉冲信号发生器（32768 Hz 晶振 + CD4060 Q14=2.00 Hz + 74LS74 输出精确 1.00 Hz）', async () => {
    const project = loadProject('SD-20')
    const res = await runTran(
      {
        title: 'SD-20 1Hz second pulse',
        modules: [{ instanceId: 'sec1', module: modSec, subckt: cirSec }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.5, sig_on: 0 })],
        wires: [
          { a: 'ins-dc-power.V5P', b: 'sec1.VCC' },
          { a: 'ins-dc-power.V5N', b: 'sec1.GND' },
          { a: 'sec1.XTAL_OUT', b: 'sec1.C4060_PHI' },
          { a: 'sec1.K_MR', b: 'sec1.C4060_MR' },
          { a: 'sec1.C4060_Q14', b: 'sec1.FF_CP' },
          { a: 'sec1.FF_NQ', b: 'sec1.FF_D' },
          { a: 'scope1.CH1', b: 'sec1.C4060_Q14' },
          { a: 'scope1.CH2', b: 'sec1.FF_Q' },
          { a: 'scope1.GND', b: 'sec1.GND' },
        ],
        ground: 'ins-dc-power.V5N',
        controlValues: { 'sec1.SW_MR': 0 },
        analysis: [],
      },
      2.6,
      { settleSec: 0.05, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'wire', res.plan)
    expect(res.signal('scope:scope1:CH1')?.frequency ?? 0).toBeGreaterThan(1.94)
    expect(res.signal('scope:scope1:CH1')?.frequency ?? 0).toBeLessThan(2.06)
    expect(res.signal('scope:scope1:CH2')?.frequency ?? 0).toBeGreaterThan(0.95)
    expect(res.signal('scope:scope1:CH2')?.frequency ?? 0).toBeLessThan(1.05)
  }, 30_000)

  it('SD-21：伺服电机 60 槽光电测速 + 1 s 闸门 + mod-digital-logic 二位数码管直读 30 / 60 r/min', async () => {
    const project = loadProject('SD-21')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'dig1.VCC' },
      { a: 'ins-dc-power.V5P', b: 'spd1.VCC' },
      { a: 'ins-dc-power.CH1P', b: 'spd1.VM_IN' },
      { a: 'ins-dc-power.V5N', b: 'dig1.GND' },
      { a: 'ins-dc-power.CH1N', b: 'dig1.GND' },
      { a: 'dig1.GND', b: 'spd1.GND' },
      { a: 'spd1.ENC_RAW', b: 'spd1.SCH_IN' },
      { a: 'spd1.TACH_OUT', b: 'spd1.AND_A' },
      { a: 'spd1.GATE_OUT', b: 'spd1.AND_B' },
      { a: 'spd1.COUNT_OUT', b: 'dig1.U1_CP0' },
      { a: 'spd1.RST_AUTO', b: 'dig1.U1_R0' },
      { a: 'spd1.RST_AUTO', b: 'dig1.U2_R0' },
      { a: 'dig1.U1_Q0', b: 'dig1.U1_CP1' },
      { a: 'dig1.U1_Q0', b: 'dig1.D1_A' },
      { a: 'dig1.U1_Q1', b: 'dig1.D1_B' },
      { a: 'dig1.U1_Q2', b: 'dig1.D1_C' },
      { a: 'dig1.U1_Q3', b: 'dig1.D1_D' },
      { a: 'dig1.U1_Q3', b: 'dig1.U2_CP0' },
      { a: 'dig1.U2_Q0', b: 'dig1.U2_CP1' },
      { a: 'dig1.U2_Q0', b: 'dig1.D2_A' },
      { a: 'dig1.U2_Q1', b: 'dig1.D2_B' },
      { a: 'dig1.U2_Q2', b: 'dig1.D2_C' },
      { a: 'dig1.U2_Q3', b: 'dig1.D2_D' },
      { a: 'scope1.CH1', b: 'spd1.TACH_OUT' },
      { a: 'scope1.CH2', b: 'spd1.GATE_OUT' },
      { a: 'scope1.GND', b: 'spd1.GND' },
    ]
    const runSpeed = (rpm: number) =>
      runTran(
        {
          title: `SD-21 ${rpm} rpm`,
          modules: [
            { instanceId: 'dig1', module: modDig, subckt: cirDig },
            { instanceId: 'spd1', module: modSpeed, subckt: cirSpeed },
          ],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
            defaultIns('scope1', scope, { timebase: 0.05, sig_on: 0 }),
          ],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'spd1.SPEED_SET': rpm, 'spd1.GATE_MODE': 1 },
          analysis: [],
        },
        1.25,
        { settleSec: 0.1, stepOverride: 0.001 },
      )
    // 1. 30 r/min -> TACH ≈ 30 Hz，1 s 闸门结束后（t=1.2 s）二位数码管锁存显示 29~31
    const r30 = await runSpeed(30)
    assertWiringClean(project, 'wire', r30.plan)
    expect(r30.signal('scope:scope1:CH1')?.frequency ?? 0).toBeGreaterThan(28.8)
    expect(r30.signal('scope:scope1:CH1')?.frequency ?? 0).toBeLessThan(31.2)
    const disp30 = Number(`${r30.segAt('dig1', 'DISP_TENS', 1.2)}${r30.segAt('dig1', 'DISP_ONES', 1.2)}`)
    expect(disp30).toBeGreaterThanOrEqual(29)
    expect(disp30).toBeLessThanOrEqual(31)

    // 2. 60 r/min -> TACH ≈ 60 Hz，1 s 闸门结束后显示 59~61
    const r60 = await runSpeed(60)
    expect(r60.signal('scope:scope1:CH1')?.frequency ?? 0).toBeGreaterThan(58.0)
    expect(r60.signal('scope:scope1:CH1')?.frequency ?? 0).toBeLessThan(62.0)
    const disp60 = Number(`${r60.segAt('dig1', 'DISP_TENS', 1.2)}${r60.segAt('dig1', 'DISP_ONES', 1.2)}`)
    expect(disp60).toBeGreaterThanOrEqual(59)
    expect(disp60).toBeLessThanOrEqual(61)
  }, 30_000)
})
