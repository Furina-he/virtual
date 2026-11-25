import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import { getInstrumentDefaults, measureSignal, readInstrument } from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import {
  createCompetitionState,
  createFaultFlowState,
  createTaskState,
  evaluateCompetition,
  extractChartDataset,
  type MeasurementSnapshot,
  observeFaultSymptom,
  recordCurrentReading,
  recordFaultMeasurement,
  repairFault,
  scopedReference,
  startCompetition,
  startFaultSession,
  submitFaultDiagnosis,
  verifyFaultRepair,
  writeTableCell,
} from '../../src/domain/task/index.ts'
import { checkWiring, detectDanger } from '../../src/domain/wiring-check/index.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// M2 B4（MD-10~19）真实 ngspice 全流程金标准验证（含 MD-11 6 故障、MD-13 3 故障与 MD-18 TSK-08 竞赛指标判定）。

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const loadIns = (id: string) => Instrument.parse(loadJson(`content/instruments/${id}/instrument.json`))
const loadMod = (id: string) => Module.parse(loadJson(`content/modules/${id}/module.json`))
const loadProject = (id: string) => Project.parse(loadJson(`content/projects/${id}/project.json`))

const LIBRARIES = {
  'bjt.lib': readFileSync('content/models/spice/bjt.lib', 'utf8'),
  'diodes.lib': readFileSync('content/models/spice/diodes.lib', 'utf8'),
  'opamp.lib': readFileSync('content/models/spice/opamp.lib', 'utf8'),
  'sensors.lib': readFileSync('content/models/spice/sensors.lib', 'utf8'),
}

const loadModCir = (id: string) =>
  expandLocalLibraries(readFileSync(`content/modules/${id}/module.cir`, 'utf8'), LIBRARIES)

const modOtl = loadMod('mod-analog-otl')
const cirOtl = loadModCir('mod-analog-otl')
const mod386 = loadMod('mod-app-lm386')
const cir386 = loadModCir('mod-app-lm386')
const modSmoke = loadMod('mod-app-smoke')
const cirSmoke = loadModCir('mod-app-smoke')
const modOpamp = loadMod('mod-opamp')
const cirOpamp = loadModCir('mod-opamp')

const dcPower = loadIns('ins-dc-power')
const dcVolt = loadIns('ins-dc-voltmeter')
const multimeter = loadIns('ins-multimeter')
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
const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / Math.max(1e-12, Math.abs(expected))

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
    await wait(10)
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

async function solveOp(input: AssembleInput) {
  const plan = buildMeasurementPlan(input, true, 'b4-op')
  const loadCmd = { ...plan.command, analysis: { kind: 'op' as const } }
  events.length = 0
  session.handle(loadCmd)
  let loaded = false
  const logs: string[] = []
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'log') logs.push(ev.line)
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})\n${logs.slice(-10).join('\n')}`)
      if (ev.type === 'loaded') loaded = true
      if (ev.type === 'op' && loaded) {
        const readings: Record<string, ReturnType<typeof readInstrument>> = {}
        const rawV: Record<string, number> = {}
        for (const meter of plan.meters) {
          const voltage = meter.voltageProbe ? ev.values[meter.voltageProbe] : undefined
          if (voltage !== undefined) rawV[meter.instanceId] = voltage
          readings[meter.instanceId] = readInstrument(meter.config, {
            voltage,
            current: meter.currentProbe ? ev.values[meter.currentProbe] : undefined,
            connectedJacks: meter.connectedJacks,
          })
        }
        return {
          plan,
          values: ev.values,
          rawV,
          readings,
          snapshot: { current: true, plan, readings } satisfies MeasurementSnapshot,
        }
      }
    }
  }
  throw new Error(`Timed out waiting for .op result: ${input.title}`)
}

async function runTran(
  input: AssembleInput,
  durationSec: number,
  options: { settleSec?: number; stepOverride?: number } = {},
) {
  const plan = buildMeasurementPlan(input, true, 'b4-tran')
  const step = options.stepOverride ?? (plan.command.analysis.kind === 'tran' ? plan.command.analysis.step : 0.0001)
  const loadCmd = {
    ...plan.command,
    analysis: { kind: 'tran' as const, step, continuous: true as const },
  }
  events.length = 0
  session.handle(loadCmd)
  session.handle({ type: 'setPacing', mode: 'window' })

  const probeIds = loadCmd.probes.map((p) => p.id)
  const times: number[] = []
  const channels: Record<string, number[]> = Object.fromEntries(probeIds.map((id) => [id, []]))
  let loaded = false
  let dtOut = step
  const logs: string[] = []
  const deadline = Date.now() + 25_000

  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'log') logs.push(ev.line)
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})\n${logs.slice(-12).join('\n')}`)
      if (ev.type === 'loaded') {
        loaded = true
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
          if (!src) continue
          for (let i = 0; i < src.length; i++) arr.push(src[i] ?? 0)
        }
        const simNow = ev.t0 + count * ev.dt
        if (simNow >= durationSec) {
          await pauseAndIdle()
          const settle = options.settleSec ?? durationSec * 0.4
          const startIdx = Math.max(
            times.findIndex((t) => t >= settle),
            0,
          )
          const foundEnd = times.findIndex((t) => t > durationSec)
          const endIdx = foundEnd > startIdx ? foundEnd : times.length
          const sliceArr = (id: string) =>
            Float32Array.from(defined(channels[id], `channel ${id}`).slice(startIdx, endIdx))
          const stats = (id: string) => {
            const arr = defined(channels[id], `channel ${id}`)
            let lo = Number.POSITIVE_INFINITY
            let hi = Number.NEGATIVE_INFINITY
            let sum = 0
            for (let k = startIdx; k < endIdx; k++) {
              const v = arr[k] ?? 0
              if (v < lo) lo = v
              if (v > hi) hi = v
              sum += v
            }
            const mean = sum / Math.max(1, endIdx - startIdx)
            const measured = measureSignal(sliceArr(id), dtOut)
            return { min: lo, max: hi, vpp: hi - lo, mean, measured }
          }
          return { plan, times, channels, startIdx, endIdx, dt: dtOut, stats }
        }
      }
    }
  }
  await pauseAndIdle()
  throw new Error(`Timed out running transient simulation: ${input.title}`)
}

const DUAL_12V_WIRES = [
  { a: 'ins-dc-power.CH1P', b: 'oa1.OA_VP' },
  { a: 'ins-dc-power.CH1N', b: 'ins-dc-power.CH2P' },
  { a: 'ins-dc-power.CH1N', b: 'oa1.OA_GND1' },
  { a: 'ins-dc-power.CH2N', b: 'oa1.OA_VM' },
]

describe('M2 B4（MD-10~19）真实 ngspice 金标准验证', () => {
  it('MD-10：复合互补 OTL 功放中点电位器单调调节（50% ≈ 6.0 V）、8 Ω 输出与交越失真对比', async () => {
    const project = loadProject('MD-10')
    const baseWires = [
      { a: 'ins-dc-power.CH1P', b: 'otl1.OTL_VCC' },
      { a: 'ins-dc-power.CH1N', b: 'otl1.OTL_GND1' },
      { a: 'generator1.CH1', b: 'otl1.OTL_IN' },
      { a: 'generator1.GND', b: 'otl1.OTL_GND2' },
      { a: 'ins-dc-voltmeter.POS', b: 'otl1.OTL_MID' },
      { a: 'ins-dc-voltmeter.NEG', b: 'otl1.OTL_GND1' },
      { a: 'scope1.CH1', b: 'otl1.OTL_IN' },
      { a: 'scope1.CH2', b: 'otl1.OTL_SPK_P' },
      { a: 'scope1.GND', b: 'otl1.OTL_SPK_N' },
    ]
    const mids: number[] = []
    let task = { ...createTaskState(project), completedSteps: ['prepare', 'wire'] }
    for (const [row, rp] of [20, 50, 80].entries()) {
      const dc = await solveOp({
        title: `MD-10 mid rp=${rp}`,
        modules: [{ instanceId: 'otl1', module: modOtl, subckt: cirOtl }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 0.4 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: baseWires,
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'otl1.RP_MID': rp, 'otl1.SW_XOVER': 0 },
        analysis: [],
      })
      if (rp === 50) assertWiringClean(project, 'wire', dc.plan)
      const uMid = defined(dc.rawV['ins-dc-voltmeter'], 'u_mid')
      mids.push(uMid)
      task = writeTableCell(project, task, 'otl_debug', row, 'rp_pct', rp).state
      const rec = recordCurrentReading(project, task, 'otl_debug', row, 'u_mid', {
        snapshot: dc.snapshot,
        row,
        advance: false,
      })
      expect(rec.ok, rec.message).toBe(true)
      task = rec.state
    }
    expect(mids[0] ?? 9).toBeLessThan(5.2)
    expect(mids[1] ?? 0).toBeGreaterThan(5.4)
    expect(mids[1] ?? 9).toBeLessThan(6.6)
    expect(mids[2] ?? 0).toBeGreaterThan(6.8)
    expect(extractChartDataset(project, task, defined(project.charts[0], 'otl chart')).points).toHaveLength(3)

    // 正常偏置 vs 短接偏置管交越失真对比（小信号 0.12 Vpp 下交越死区导致输出幅值骤降）
    const normal = await runTran(
      {
        title: 'MD-10 normal',
        modules: [{ instanceId: 'otl1', module: modOtl, subckt: cirOtl }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 0.4 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: baseWires.filter((w) => !w.a.startsWith('ins-dc-voltmeter') && !w.b.startsWith('ins-dc-voltmeter')),
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'otl1.RP_MID': 50, 'otl1.SW_XOVER': 0 },
        analysis: [],
      },
      0.015,
      { settleSec: 0.008, stepOverride: 0.000025 },
    )
    const xover = await runTran(
      {
        title: 'MD-10 xover',
        modules: [{ instanceId: 'otl1', module: modOtl, subckt: cirOtl }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 0.12 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: baseWires.filter((w) => !w.a.startsWith('ins-dc-voltmeter') && !w.b.startsWith('ins-dc-voltmeter')),
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'otl1.RP_MID': 50, 'otl1.SW_XOVER': 1 },
        analysis: [],
      },
      0.015,
      { settleSec: 0.008, stepOverride: 0.000025 },
    )
    const normalSmall = await runTran(
      {
        title: 'MD-10 normal small',
        modules: [{ instanceId: 'otl1', module: modOtl, subckt: cirOtl }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 0.12 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: baseWires.filter((w) => !w.a.startsWith('ins-dc-voltmeter') && !w.b.startsWith('ins-dc-voltmeter')),
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'otl1.RP_MID': 50, 'otl1.SW_XOVER': 0 },
        analysis: [],
      },
      0.015,
      { settleSec: 0.008, stepOverride: 0.000025 },
    )
    expect(normal.stats('scope:scope1:CH2').vpp).toBeGreaterThan(1.5)
    expect(xover.stats('scope:scope1:CH2').vpp).toBeLessThan(normalSmall.stats('scope:scope1:CH2').vpp * 0.75)
  })

  it('MD-11：OTL 功放 6 项预设故障（FLT-01/FLT-04）全流程真实异常与六步排故闭环', async () => {
    const project = loadProject('MD-11')
    const faults = defined(project.faults, 'MD-11 faults')
    expect(faults.length).toBeGreaterThanOrEqual(6)

    const measureOtl = async (fault?: (typeof faults)[number]) => {
      const dc = await solveOp({
        title: `MD-11 dc ${fault?.id ?? 'clean'}`,
        modules: [{ instanceId: 'otl1', module: modOtl, subckt: cirOtl }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('meter1', multimeter, { range: 'dcv20' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'otl1.OTL_VCC' },
          { a: 'ins-dc-power.CH1N', b: 'otl1.OTL_GND1' },
          { a: 'ins-dc-voltmeter.POS', b: 'otl1.OTL_MID' },
          { a: 'ins-dc-voltmeter.NEG', b: 'otl1.OTL_GND1' },
          { a: 'meter1.VOHM', b: 'otl1.OTL_BUP' },
          { a: 'meter1.COM', b: 'otl1.OTL_BDN' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'otl1.RP_MID': 50, 'otl1.SW_XOVER': 0 },
        ...(fault ? { fault } : {}),
        analysis: [],
      })
      const tr = await runTran(
        {
          title: `MD-11 tr ${fault?.id ?? 'clean'}`,
          modules: [{ instanceId: 'otl1', module: modOtl, subckt: cirOtl }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 0.4 }),
            defaultIns('scope1', scope, { timebase: 0.0005 }),
          ],
          wires: [
            { a: 'ins-dc-power.CH1P', b: 'otl1.OTL_VCC' },
            { a: 'ins-dc-power.CH1N', b: 'otl1.OTL_GND1' },
            { a: 'generator1.CH1', b: 'otl1.OTL_IN' },
            { a: 'generator1.GND', b: 'otl1.OTL_GND2' },
            { a: 'scope1.CH1', b: 'otl1.OTL_IN' },
            { a: 'scope1.CH2', b: 'otl1.OTL_SPK_P' },
            { a: 'scope1.GND', b: 'otl1.OTL_SPK_N' },
          ],
          ground: 'ins-dc-power.CH1N',
          controlValues: { 'otl1.RP_MID': 50, 'otl1.SW_XOVER': 0 },
          ...(fault ? { fault } : {}),
          analysis: [],
        },
        0.012,
        { settleSec: 0.006, stepOverride: 0.00004 },
      )
      return {
        dc,
        uMid: defined(dc.rawV['ins-dc-voltmeter'], 'uMid'),
        uBupDn: defined(dc.rawV.meter1, 'uBupDn'),
        spkVpp: tr.stats('scope:scope1:CH2').vpp,
        tr,
      }
    }

    const clean = await measureOtl()
    expect(clean.uMid).toBeGreaterThan(5.4)
    expect(clean.uMid).toBeLessThan(6.6)
    expect(clean.uBupDn).toBeGreaterThan(1.75)
    expect(clean.spkVpp).toBeGreaterThan(1.5)

    // 逐一验证 6 个故障注入均产生真实异常现象，并走通六步排故状态机闭环
    for (const fault of faults) {
      const bad = await measureOtl(fault)
      const isBadMid = bad.uMid < 5.0 || bad.uMid > 7.0
      const isBadBias = bad.uBupDn < 1.55
      const isBadSpk = bad.spkVpp < 0.2
      expect(
        isBadMid || isBadBias || isBadSpk,
        `${fault.id}: uMid=${bad.uMid}, uBupDn=${bad.uBupDn}, spkVpp=${bad.spkVpp}`,
      ).toBe(true)

      let flow = createFaultFlowState()
      const started = startFaultSession(project, flow, {
        mode: 'preset',
        faultId: fault.id,
        powered: false,
        nowMs: 1000,
      })
      expect(started.ok, `${fault.id}: ${started.message}`).toBe(true)
      flow = started.state
      const observed = observeFaultSymptom(project, flow, { powered: true, nowMs: 1500 })
      expect(observed.ok, `${fault.id}: ${observed.message}`).toBe(true)
      flow = observed.state
      const measured = recordFaultMeasurement(project, flow, { snapshot: bad.dc.snapshot, nowMs: 2000 })
      expect(measured.ok, `${fault.id}: ${measured.message}`).toBe(true)
      flow = measured.state
      const judged = submitFaultDiagnosis(project, flow, { target: fault.target, kind: fault.kind, nowMs: 3000 })
      expect(judged.ok, `${fault.id}: ${judged.message}`).toBe(true)
      flow = judged.state
      expect(flow.stage).toBe('repair')
      const repaired = repairFault(project, flow, { powered: false, nowMs: 4000 })
      expect(repaired.ok, `${fault.id}: ${repaired.message}`).toBe(true)
      flow = repaired.state
      expect(flow.stage).toBe('verify')

      // 针对需要示波器验证的故障，构造携带真实波形的快照；其余直接用直流快照验证
      const verifySnapshot: MeasurementSnapshot =
        fault.id === 'otl_cout_open'
          ? {
              current: true,
              plan: clean.tr.plan,
              readings: {},
              waveforms: [
                {
                  instanceId: 'scope1',
                  channelId: 'CH2',
                  positiveRef: 'otl1.OTL_SPK_P',
                  negativeRef: 'otl1.OTL_SPK_N',
                  coupling: 'dc',
                  current: true,
                  measurement: clean.tr.stats('scope:scope1:CH2').measured,
                },
              ],
            }
          : clean.dc.snapshot
      const verified = verifyFaultRepair(project, flow, {
        powered: true,
        snapshot: verifySnapshot,
        nowMs: 5000,
      })
      expect(verified.ok, `${fault.id}: ${verified.message}`).toBe(true)
      expect(verified.state.stage).toBe('completed')
    }
  })

  it('MD-12：LM386 静态中点 4.5 V、20× 与 200× 增益切换及音量电位器线性调节', async () => {
    const project = loadProject('MD-12')
    const baseWires = [
      { a: 'ins-dc-power.CH1P', b: 'lm1.AMP_VS' },
      { a: 'ins-dc-power.CH1N', b: 'lm1.AMP_GND1' },
      { a: 'generator1.CH1', b: 'lm1.AMP_IN' },
      { a: 'generator1.GND', b: 'lm1.AMP_GND2' },
      { a: 'ins-dc-voltmeter.POS', b: 'lm1.AMP_OUT' },
      { a: 'ins-dc-voltmeter.NEG', b: 'lm1.AMP_GND1' },
      { a: 'scope1.CH1', b: 'lm1.AMP_WIP' },
      { a: 'scope1.CH2', b: 'lm1.AMP_SPK_P' },
      { a: 'scope1.GND', b: 'lm1.AMP_SPK_N' },
    ]
    const dc = await solveOp({
      title: 'MD-12 dc',
      modules: [{ instanceId: 'lm1', module: mod386, subckt: cir386 }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 9 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 0.1 }),
        defaultIns('scope1', scope, { timebase: 0.0005 }),
      ],
      wires: baseWires,
      ground: 'ins-dc-power.CH1N',
      controlValues: { 'lm1.VOL_POT': 100, 'lm1.SW_GAIN': 0 },
      analysis: [],
    })
    assertWiringClean(project, 'wire', dc.plan)
    expect(relErr(defined(dc.rawV['ins-dc-voltmeter'], 'u_out_dc'), 4.5)).toBeLessThan(0.03)

    const run386 = (swGain: number, amp: number, vol = 100) =>
      runTran(
        {
          title: `MD-12 g=${swGain} vol=${vol}`,
          modules: [{ instanceId: 'lm1', module: mod386, subckt: cir386 }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 9 }),
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: amp }),
            defaultIns('scope1', scope, { timebase: 0.0005 }),
          ],
          wires: baseWires.filter((w) => !w.a.startsWith('ins-dc-voltmeter') && !w.b.startsWith('ins-dc-voltmeter')),
          ground: 'ins-dc-power.CH1N',
          controlValues: { 'lm1.VOL_POT': vol, 'lm1.SW_GAIN': swGain },
          analysis: [],
        },
        0.025,
        { settleSec: 0.016, stepOverride: 0.000025 },
      )

    const g20 = await run386(0, 0.1, 100)
    const g200 = await run386(1, 0.02, 100)
    const g20Half = await run386(0, 0.1, 50)
    const av20 = g20.stats('scope:scope1:CH2').vpp / g20.stats('scope:scope1:CH1').vpp
    const av200 = g200.stats('scope:scope1:CH2').vpp / g200.stats('scope:scope1:CH1').vpp
    expect(av20).toBeGreaterThan(18)
    expect(av20).toBeLessThan(22)
    expect(av200).toBeGreaterThan(170)
    expect(av200).toBeLessThan(225)
    expect(g20Half.stats('scope:scope1:CH2').vpp).toBeLessThan(g20.stats('scope:scope1:CH2').vpp * 0.65)
  })

  it('MD-13：运放反相(−2×)/同相(+3×)/加法/减法精度 ≤ 1%、输出饱和削顶与 3 项预设故障（FLT-04）', async () => {
    const project = loadProject('MD-13')

    // 1. 反相比例 (-2x) + 饱和 + 3 项故障
    const invWires = [
      ...DUAL_12V_WIRES,
      { a: 'oa1.OA1_FB', b: 'oa1.OA1_OUT' },
      { a: 'oa1.OA1_PIN', b: 'oa1.OA_GND2' },
      { a: 'generator1.CH1', b: 'oa1.OA1_IN1' },
      { a: 'generator1.GND', b: 'oa1.OA_GND2' },
      { a: 'scope1.CH1', b: 'oa1.OA1_IN1' },
      { a: 'scope1.CH2', b: 'oa1.OA1_OUT' },
      { a: 'scope1.GND', b: 'oa1.OA_GND2' },
    ]
    const inv = await runTran(
      {
        title: 'MD-13 inv',
        modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 2 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: invWires,
        ground: 'oa1.OA_GND1',
        controlValues: {},
        analysis: [],
      },
      0.008,
      { settleSec: 0.003, stepOverride: 0.000025 },
    )
    assertWiringClean(project, 'inverting', inv.plan)
    expect(relErr(inv.stats('scope:scope1:CH2').vpp / inv.stats('scope:scope1:CH1').vpp, 2.0)).toBeLessThan(0.01)

    // 2. 同相比例 (+3x)
    const nonInv = await runTran(
      {
        title: 'MD-13 non-inv',
        modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 2 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: [
          ...DUAL_12V_WIRES,
          { a: 'oa1.OA1_FB', b: 'oa1.OA1_OUT' },
          { a: 'oa1.OA1_IN1', b: 'oa1.OA_GND2' },
          { a: 'generator1.CH1', b: 'oa1.OA1_P' },
          { a: 'generator1.GND', b: 'oa1.OA_GND2' },
          { a: 'scope1.CH1', b: 'oa1.OA1_P' },
          { a: 'scope1.CH2', b: 'oa1.OA1_OUT' },
          { a: 'scope1.GND', b: 'oa1.OA_GND2' },
        ],
        ground: 'oa1.OA_GND1',
        controlValues: {},
        analysis: [],
      },
      0.008,
      { settleSec: 0.003, stepOverride: 0.000025 },
    )
    assertWiringClean(project, 'non_inverting', nonInv.plan)
    expect(relErr(nonInv.stats('scope:scope1:CH2').vpp / nonInv.stats('scope:scope1:CH1').vpp, 3.0)).toBeLessThan(0.01)

    // 3. 反相加法 Uo = -2*(1V + 1V) = -4Vpp；饱和验证（14 Vpp 输入被钳位在 ~22.4 Vpp）
    const adder = await runTran(
      {
        title: 'MD-13 adder',
        modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
          defaultIns('generator1', funcGen, {
            ch1_wave: 0,
            ch1_freq: 1000,
            ch1_amp: 1,
            ch2_wave: 0,
            ch2_freq: 1000,
            ch2_amp: 1,
          }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: [...invWires, { a: 'generator1.CH2', b: 'oa1.OA1_IN2' }],
        ground: 'oa1.OA_GND1',
        controlValues: {},
        analysis: [],
      },
      0.008,
      { settleSec: 0.003, stepOverride: 0.000025 },
    )
    assertWiringClean(project, 'adder_sub', adder.plan)
    expect(relErr(adder.stats('scope:scope1:CH2').vpp, 4.0)).toBeLessThan(0.02)

    // 4. 差分减法（直流 CH1=+1V -> IN1, 偏移 +3V -> PIN => Uo = 2*(3-1) = +4.00 V）
    const sub = await runTran(
      {
        title: 'MD-13 subtractor',
        modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
          defaultIns('generator1', funcGen, {
            ch1_wave: 0,
            ch1_freq: 1000,
            ch1_amp: 2,
            ch2_wave: 0,
            ch2_freq: 1000,
            ch2_amp: 4,
          }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: [
          ...DUAL_12V_WIRES,
          { a: 'oa1.OA1_FB', b: 'oa1.OA1_OUT' },
          { a: 'generator1.CH1', b: 'oa1.OA1_IN1' },
          { a: 'generator1.CH2', b: 'oa1.OA1_PIN' },
          { a: 'generator1.GND', b: 'oa1.OA_GND2' },
          { a: 'scope1.CH1', b: 'oa1.OA1_IN1' },
          { a: 'scope1.CH2', b: 'oa1.OA1_OUT' },
          { a: 'scope1.GND', b: 'oa1.OA_GND2' },
        ],
        ground: 'oa1.OA_GND1',
        controlValues: {},
        analysis: [],
      },
      0.008,
      { settleSec: 0.003, stepOverride: 0.000025 },
    )
    expect(relErr(sub.stats('scope:scope1:CH2').vpp, 4.0)).toBeLessThan(0.02)

    // 5. MD-13 三项预设故障验证（Rf 开路饱和、R_in1 开路零输出、Rf 漂移 2x 增益翻倍）
    for (const fault of defined(project.faults, 'MD-13 faults')) {
      const bad = await runTran(
        {
          title: `MD-13 fault ${fault.id}`,
          modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 2 }),
            defaultIns('scope1', scope, { timebase: 0.0005 }),
          ],
          wires: invWires,
          ground: 'oa1.OA_GND1',
          controlValues: {},
          fault,
          analysis: [],
        },
        0.006,
        { settleSec: 0.002, stepOverride: 0.000025 },
      )
      const vpp = bad.stats('scope:scope1:CH2').vpp
      if (fault.id === 'oa1_rf_open') expect(vpp).toBeGreaterThan(18)
      if (fault.id === 'oa1_rin1_open') expect(vpp).toBeLessThan(0.05)
      if (fault.id === 'oa1_rf_drift') expect(relErr(vpp, 8.0)).toBeLessThan(0.03)
    }
  }, 30_000)

  it('MD-14：运放反相积分（1 kHz 方波→约 4.5 Vpp 三角波）与实用微分（500 Hz 三角波→约 3.5 Vpp 方波）', async () => {
    const project = loadProject('MD-14')
    const integ = await runTran(
      {
        title: 'MD-14 integrator',
        modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
          defaultIns('generator1', funcGen, { ch1_wave: 1, ch1_freq: 1000, ch1_amp: 4 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: [
          ...DUAL_12V_WIRES,
          { a: 'oa1.OA1_PIN', b: 'oa1.OA_GND2' },
          { a: 'generator1.CH1', b: 'oa1.OA1_IN1' },
          { a: 'generator1.GND', b: 'oa1.OA_GND2' },
          { a: 'oa1.OA1_SUM', b: 'oa1.OA1_C1' },
          { a: 'oa1.OA1_C2', b: 'oa1.OA1_OUT' },
          { a: 'scope1.CH1', b: 'generator1.CH1' },
          { a: 'scope1.CH2', b: 'oa1.OA1_OUT' },
          { a: 'scope1.GND', b: 'oa1.OA_GND2' },
        ],
        ground: 'oa1.OA_GND1',
        controlValues: {},
        analysis: [],
      },
      0.055,
      { settleSec: 0.045, stepOverride: 0.000025 },
    )
    assertWiringClean(project, 'integrator', integ.plan)
    expect(integ.stats('scope:scope1:CH2').vpp).toBeGreaterThan(3.9)
    expect(integ.stats('scope:scope1:CH2').vpp).toBeLessThan(5.1)

    const diff = await runTran(
      {
        title: 'MD-14 differentiator',
        modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
          defaultIns('generator1', funcGen, { ch1_wave: 2, ch1_freq: 500, ch1_amp: 4 }),
          defaultIns('scope1', scope, { timebase: 0.001 }),
        ],
        wires: [
          ...DUAL_12V_WIRES,
          { a: 'oa1.OA1_PIN', b: 'oa1.OA_GND2' },
          { a: 'generator1.CH1', b: 'oa1.OA1_C1' },
          { a: 'oa1.OA1_C2', b: 'oa1.OA1_SUM' },
          { a: 'oa1.OA1_FB', b: 'oa1.OA1_OUT' },
          { a: 'generator1.GND', b: 'oa1.OA_GND2' },
          { a: 'scope1.CH1', b: 'generator1.CH1' },
          { a: 'scope1.CH2', b: 'oa1.OA1_OUT' },
          { a: 'scope1.GND', b: 'oa1.OA_GND2' },
        ],
        ground: 'oa1.OA_GND1',
        controlValues: {},
        analysis: [],
      },
      0.016,
      { settleSec: 0.008, stepOverride: 0.000025 },
    )
    assertWiringClean(project, 'differentiator', diff.plan)
    expect(diff.stats('scope:scope1:CH2').vpp).toBeGreaterThan(3.0)
    expect(diff.stats('scope:scope1:CH2').vpp).toBeLessThan(4.2)
  })

  it('MD-15：过零比较器单线跳变与滞回比较器（SW_CMP_MODE=1）约 4.5 V 矩形滞回窗口', async () => {
    const project = loadProject('MD-15')
    const wires = [
      ...DUAL_12V_WIRES,
      { a: 'oa1.CMP_VREF', b: 'oa1.OA_GND2' },
      { a: 'generator1.CH1', b: 'oa1.CMP_IN' },
      { a: 'generator1.GND', b: 'oa1.OA_GND2' },
      { a: 'scope1.CH1', b: 'oa1.CMP_IN' },
      { a: 'scope1.CH2', b: 'oa1.CMP_OUT' },
      { a: 'scope1.GND', b: 'oa1.OA_GND2' },
    ]
    const measureThresholds = async (mode: number) => {
      const tr = await runTran(
        {
          title: `MD-15 mode=${mode}`,
          modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
            defaultIns('generator1', funcGen, { ch1_wave: 2, ch1_freq: 200, ch1_amp: 10 }),
            defaultIns('scope1', scope, { timebase: 0.002 }),
          ],
          wires,
          ground: 'oa1.OA_GND1',
          controlValues: { 'oa1.SW_CMP_MODE': mode },
          analysis: [],
        },
        0.02,
        { settleSec: 0.005, stepOverride: 0.00004 },
      )
      const x = defined(tr.channels['scope:scope1:CH1'], 'x')
      const y = defined(tr.channels['scope:scope1:CH2'], 'y')
      let riseX: number | undefined
      let fallX: number | undefined
      for (let k = tr.startIdx + 1; k < tr.endIdx; k++) {
        if ((y[k - 1] ?? 0) > 0 && (y[k] ?? 0) <= 0) fallX = x[k]
        if ((y[k - 1] ?? 0) < 0 && (y[k] ?? 0) >= 0) riseX = x[k]
      }
      return { tr, vpp: tr.stats('scope:scope1:CH2').vpp, fallX: fallX ?? 0, riseX: riseX ?? 0 }
    }
    const zero = await measureThresholds(0)
    assertWiringClean(project, 'wire', zero.tr.plan)
    expect(zero.vpp).toBeGreaterThan(21)
    expect(Math.abs(zero.fallX - zero.riseX)).toBeLessThan(0.5)

    const hyst = await measureThresholds(1)
    expect(hyst.vpp).toBeGreaterThan(21)
    expect(hyst.fallX).toBeGreaterThan(1.7)
    expect(hyst.riseX).toBeLessThan(-1.9)
    expect(hyst.fallX - hyst.riseX).toBeGreaterThan(3.8)
  })

  it('MD-16：MQ-2 气敏烟雾报警器四档采样单调升高、阈值翻转、LED 与 2.4 kHz 蜂鸣器实时联动', async () => {
    const project = loadProject('MD-16')
    const dcWires = [
      { a: 'ins-dc-power.V5P', b: 'smk1.SMK_VCC' },
      { a: 'ins-dc-power.V5N', b: 'smk1.SMK_GND1' },
      { a: 'ins-dc-voltmeter.POS', b: 'smk1.SMK_VS' },
      { a: 'ins-dc-voltmeter.NEG', b: 'smk1.SMK_GND1' },
      { a: 'meter1.VOHM', b: 'smk1.SMK_CMP' },
      { a: 'meter1.COM', b: 'smk1.SMK_GND2' },
    ]
    const vsList: number[] = []
    const cmpList: number[] = []
    for (const ppm of [0, 200, 500, 1000]) {
      const res = await solveOp({
        title: `MD-16 ppm=${ppm}`,
        modules: [{ instanceId: 'smk1', module: modSmoke, subckt: cirSmoke }],
        instruments: [
          defaultIns('ins-dc-power', dcPower),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('meter1', multimeter, { range: 'dcv20' }),
        ],
        wires: dcWires,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'smk1.SMOKE_PPM': ppm, 'smk1.VREF_POT': 50 },
        analysis: [],
      })
      if (ppm === 0) assertWiringClean(project, 'wire', res.plan)
      vsList.push(defined(res.rawV['ins-dc-voltmeter'], 'vs'))
      cmpList.push(defined(res.rawV.meter1, 'cmp'))
    }
    expect(vsList[0] ?? 9).toBeLessThan(1.1)
    expect(vsList[1] ?? 0).toBeGreaterThan(1.8)
    expect(vsList[2] ?? 0).toBeGreaterThan(2.9)
    expect(vsList[3] ?? 0).toBeGreaterThan(3.7)
    // 默认阈值 2.5 V：0/200 ppm 静音待机，500/1000 ppm 触发高电平报警
    expect(cmpList[0] ?? 9).toBeLessThan(0.25)
    expect(cmpList[1] ?? 9).toBeLessThan(0.25)
    expect(cmpList[2] ?? 0).toBeGreaterThan(2.5)
    expect(cmpList[3] ?? 0).toBeGreaterThan(2.5)

    // 下调阈值电位器至 35%（1.75 V），200 ppm 即可提前报警并驱动 2.4 kHz 蜂鸣器发声
    const buzOn = await runTran(
      {
        title: 'MD-16 buzzer on',
        modules: [{ instanceId: 'smk1', module: modSmoke, subckt: cirSmoke }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.0005 })],
        wires: [
          { a: 'ins-dc-power.V5P', b: 'smk1.SMK_VCC' },
          { a: 'ins-dc-power.V5N', b: 'smk1.SMK_GND1' },
          { a: 'scope1.CH1', b: 'smk1.SMK_SND_P' },
          { a: 'scope1.GND', b: 'smk1.SMK_SND_N' },
        ],
        ground: 'ins-dc-power.V5N',
        controlValues: { 'smk1.SMOKE_PPM': 200, 'smk1.VREF_POT': 35 },
        analysis: [],
      },
      0.004,
      { settleSec: 0.001, stepOverride: 0.00002 },
    )
    expect(buzOn.stats('scope:scope1:CH1').vpp).toBeGreaterThan(3.4)
  })

  it('MD-17：方波/三角波振荡器频率随积分电阻反比调节、三角波恒幅及锯齿波不对称切换', async () => {
    const project = loadProject('MD-17')
    const wires = [
      ...DUAL_12V_WIRES,
      { a: 'oa1.OA_VP', b: 'oa1.FG_EN' },
      { a: 'scope1.CH1', b: 'oa1.FG_SQ' },
      { a: 'scope1.CH2', b: 'oa1.FG_TRI' },
      { a: 'scope1.GND', b: 'oa1.OA_GND2' },
    ]
    const runFg = (rKohm: number, sym: number) =>
      runTran(
        {
          title: `MD-17 r=${rKohm} sym=${sym}`,
          modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
            defaultIns('scope1', scope, { timebase: 0.0005 }),
          ],
          wires,
          ground: 'oa1.OA_GND1',
          controlValues: { 'oa1.R_FG_FREQ': rKohm, 'oa1.SW_FG_SYM': sym },
          analysis: [],
        },
        0.016,
        { settleSec: 0.004, stepOverride: 0.00002 },
      )

    const r30 = await runFg(30, 0)
    const r15 = await runFg(15, 0)
    assertWiringClean(project, 'wire', r15.plan)
    const r8 = await runFg(8, 0)
    const saw = await runFg(15, 1)

    const f30 = r30.stats('scope:scope1:CH1').measured?.frequency ?? 0
    const f15 = r15.stats('scope:scope1:CH1').measured?.frequency ?? 0
    const f8 = r8.stats('scope:scope1:CH1').measured?.frequency ?? 0
    const fSaw = saw.stats('scope:scope1:CH1').measured?.frequency ?? 0

    expect(f30).toBeGreaterThan(430)
    expect(f30).toBeLessThan(580)
    expect(f15).toBeGreaterThan(850)
    expect(f15).toBeLessThan(1120)
    expect(f8).toBeGreaterThan(1480)
    expect(f8).toBeLessThan(2050)
    // 三角波峰峰值稳定在 9.5~13.0 Vpp
    expect(r15.stats('scope:scope1:CH2').vpp).toBeGreaterThan(9.5)
    expect(r15.stats('scope:scope1:CH2').vpp).toBeLessThan(13.0)
    // 锯齿波模式：正半周快充（高电平脉冲明显变窄，均值显著偏负）且频率明显升高
    expect(fSaw).toBeGreaterThan(f15 * 1.4)
    expect(saw.stats('scope:scope1:CH1').mean).toBeLessThan(-4.0)
  }, 30_000)

  it('MD-18（TSK-08 竞赛）：默认参数不达标，自主调校频率与幅值后经真实 ngspice 波形实现 3/3 100% 竞赛达标', async () => {
    const project = loadProject('MD-18')
    const spec = defined(project.competition, 'MD-18 competition')

    const capturePair = async (rFreq: number, rAmp: number, ch2Jack: 'FG_SIN' | 'FG_TRI') => {
      const tr = await runTran(
        {
          title: `MD-18 f=${rFreq} a=${rAmp} ${ch2Jack}`,
          modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
            defaultIns('scope1', scope, { timebase: 0.0005 }),
          ],
          wires: [
            ...DUAL_12V_WIRES,
            { a: 'oa1.OA_VP', b: 'oa1.FG_EN' },
            { a: 'scope1.CH1', b: 'oa1.FG_SQ' },
            { a: 'scope1.CH2', b: `oa1.${ch2Jack}` },
            { a: 'scope1.GND', b: 'oa1.OA_GND2' },
          ],
          ground: 'oa1.OA_GND1',
          controlValues: { 'oa1.R_FG_FREQ': rFreq, 'oa1.R_FG_AMP': rAmp, 'oa1.SW_FG_SYM': 0 },
          analysis: [],
        },
        0.014,
        { settleSec: 0.004, stepOverride: 0.00002 },
      )
      const snapshot: MeasurementSnapshot = {
        current: true,
        plan: tr.plan,
        readings: {},
        waveforms: [
          {
            instanceId: 'scope1',
            channelId: 'CH1',
            positiveRef: 'oa1.FG_SQ',
            negativeRef: 'oa1.OA_GND1',
            coupling: 'dc',
            current: true,
            measurement: tr.stats('scope:scope1:CH1').measured,
          },
          {
            instanceId: 'scope1',
            channelId: 'CH2',
            positiveRef: `oa1.${ch2Jack}`,
            negativeRef: 'oa1.OA_GND1',
            coupling: 'dc',
            current: true,
            measurement: tr.stats('scope:scope1:CH2').measured,
          },
        ],
      }
      return { tr, snapshot }
    }

    // 1. 默认参数（15 kΩ / 40%）核验：频率约 1 kHz、正弦幅值约 2.2 Vpp -> 0/2 不达标
    const defRun = await capturePair(15, 40, 'FG_SIN')
    assertWiringClean(project, 'build_wire', defRun.tr.plan)
    let comp = startCompetition(spec, 1000)
    comp = evaluateCompetition(project, comp, defRun.snapshot, 5000)
    expect(comp.status).toBe('running')
    expect(comp.passedCount).toBe(0)

    // 2. 自主调校至 R_FG_FREQ = 8 kΩ（补偿 LM324 压摆率，f ≈ 1570 Hz）、R_FG_AMP = 75%（≈4.2 Vpp）-> 先验收 SQ+SIN，再改接 TRI 完成 3/3
    const tunedSin = await capturePair(8, 75, 'FG_SIN')
    comp = evaluateCompetition(project, comp, tunedSin.snapshot, 20_000)
    expect(comp.passedCount, JSON.stringify(comp.results)).toBe(2)
    expect(comp.results.freq_1500?.passed).toBe(true)
    expect(comp.results.sin_4vpp?.passed).toBe(true)

    const tunedTri = await capturePair(8, 75, 'FG_TRI')
    comp = evaluateCompetition(project, comp, tunedTri.snapshot, 35_000)
    expect(comp.status).toBe('passed')
    expect(comp.passedCount).toBe(3)
    expect(comp.scorePct).toBe(100)
    expect(createCompetitionState(spec).totalCount).toBe(3)
  }, 30_000)

  it('MD-19：RC 文氏桥正弦波振荡器起振阈值（11k 停振 / 17k 稳幅正弦 / 23k 削顶）与 1 kHz / 2 kHz 双频切换', async () => {
    const project = loadProject('MD-19')
    const wires = [
      ...DUAL_12V_WIRES,
      { a: 'oa1.OA_VP', b: 'oa1.WIEN_EN' },
      { a: 'scope1.CH1', b: 'oa1.WIEN_OUT' },
      { a: 'scope1.CH2', b: 'oa1.WIEN_P' },
      { a: 'scope1.GND', b: 'oa1.OA_GND2' },
    ]
    const runWien = (rf: number, swC: number, dur = 0.04) =>
      runTran(
        {
          title: `MD-19 rf=${rf} c=${swC}`,
          modules: [{ instanceId: 'oa1', module: modOpamp, subckt: cirOpamp }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12, ch2_v: 12 }),
            defaultIns('scope1', scope, { timebase: 0.0005 }),
          ],
          wires,
          ground: 'oa1.OA_GND1',
          controlValues: { 'oa1.RF_WIEN': rf, 'oa1.SW_WIEN_C': swC },
          analysis: [],
        },
        dur,
        { settleSec: dur * 0.65, stepOverride: 0.000025 },
      )

    // 1. Rf = 11 kΩ（Av < 3）：不起振
    const dead = await runWien(11, 0, 0.025)
    expect(dead.stats('scope:scope1:CH1').vpp).toBeLessThan(0.15)

    // 2. Rf = 17 kΩ（稳幅正弦，1.0 kHz）：频率 920~1080 Hz，非削顶稳幅 2.0~12.0 Vpp，WIEN_OUT/WIEN_P ≈ 3:1
    const w1k = await runWien(17, 0, 0.055)
    assertWiringClean(project, 'wire', w1k.plan)
    const out1k = w1k.stats('scope:scope1:CH1')
    const p1k = w1k.stats('scope:scope1:CH2')
    expect(out1k.vpp).toBeGreaterThan(2.0)
    expect(out1k.vpp).toBeLessThan(12.5)
    expect(out1k.measured?.frequency ?? 0).toBeGreaterThan(920)
    expect(out1k.measured?.frequency ?? 0).toBeLessThan(1080)
    expect(relErr(out1k.vpp / p1k.vpp, 3.0)).toBeLessThan(0.06)

    // 3. 切换 2.0 kHz 档（7.96 nF）：频率翻倍至 1850~2150 Hz
    const w2k = await runWien(17, 1, 0.04)
    const f2k = w2k.stats('scope:scope1:CH1').measured?.frequency ?? 0
    expect(f2k).toBeGreaterThan(1850)
    expect(f2k).toBeLessThan(2150)

    // 4. Rf = 23 kΩ（过驱动）：大幅增长至削顶（> 16 Vpp）
    const over = await runWien(23, 0, 0.035)
    expect(over.stats('scope:scope1:CH1').vpp).toBeGreaterThan(16)
  }, 30_000)
})
