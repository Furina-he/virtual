import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import { getInstrumentDefaults, readInstrument } from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import {
  createFaultFlowState,
  createTaskState,
  extractChartDataset,
  type MeasurementSnapshot,
  observeFaultSymptom,
  recordCurrentReading,
  recordFaultMeasurement,
  repairFault,
  scopedReference,
  startFaultSession,
  submitFaultDiagnosis,
  verifyFaultRepair,
  writeTableCell,
} from '../../src/domain/task/index.ts'
import { checkWiring, detectDanger } from '../../src/domain/wiring-check/index.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// M2 B1（DG-01~09）真实 ngspice 金标准验证：
// 覆盖除已有独立金标准的 DG-05 外全部 8 项正式直流项目的接线检查、≤1% 线性物理精度、非线性器件特性、数据表/曲线与 9 项直流故障闭环。

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const loadIns = (id: string) => Instrument.parse(loadJson(`content/instruments/${id}/instrument.json`))
const loadMod = (id: string) => Module.parse(loadJson(`content/modules/${id}/module.json`))
const loadProject = (id: string) => Project.parse(loadJson(`content/projects/${id}/project.json`))

const LIBRARIES = {
  'diodes.lib': readFileSync('content/models/spice/diodes.lib', 'utf8'),
  'sensors.lib': readFileSync('content/models/spice/sensors.lib', 'utf8'),
}
const loadModCir = (id: string) =>
  expandLocalLibraries(readFileSync(`content/modules/${id}/module.cir`, 'utf8'), LIBRARIES)

const dcPower = loadIns('ins-dc-power')
const dcVolt = loadIns('ins-dc-voltmeter')
const dcAmp = loadIns('ins-dc-ammeter')
const galv = loadIns('ins-galvanometer')

const modCircuit = loadMod('mod-dc-circuit')
const cirCircuit = loadModCir('mod-dc-circuit')
const modComp = loadMod('mod-dc-components')
const cirComp = loadModCir('mod-dc-components')

const events: SimEvent[] = []
const session = new SimSession(
  resolve(import.meta.dirname, '../../resources/ngspice'),
  (event) => events.push(event),
  () => {},
)
afterAll(() => session.dispose())

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9)

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

async function solveOp(input: AssembleInput) {
  const plan = buildMeasurementPlan(input, true, 'b1-op')
  expect(plan.command.analysis.kind).toBe('op')
  events.length = 0
  session.handle(plan.command)
  let loaded = false
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
      if (ev.type === 'loaded') loaded = true
      if (ev.type === 'op' && loaded) {
        const readings: Record<string, ReturnType<typeof readInstrument>> = {}
        const rawV: Record<string, number> = {}
        const rawI: Record<string, number> = {}
        for (const meter of plan.meters) {
          const voltage = meter.voltageProbe ? ev.values[meter.voltageProbe] : undefined
          const current = meter.currentProbe ? ev.values[meter.currentProbe] : undefined
          if (voltage !== undefined) rawV[meter.instanceId] = voltage
          if (current !== undefined) rawI[meter.instanceId] = current
          readings[meter.instanceId] = readInstrument(meter.config, {
            voltage,
            current,
            connectedJacks: meter.connectedJacks,
          })
        }
        return {
          plan,
          values: ev.values,
          rawV,
          rawI,
          readings,
          snapshot: { current: true, plan, readings } satisfies MeasurementSnapshot,
        }
      }
    }
  }
  throw new Error('Timed out waiting for SimSession .op result')
}

function assertWiringClean(
  project: Project,
  stepId: string | undefined,
  plan: ReturnType<typeof buildMeasurementPlan>,
) {
  const step = stepId ? project.steps.find((s) => s.id === stepId) : undefined
  const report = checkWiring(plan.checkInput, scopedReference(project, step))
  expect(report.circuitOk, `${project.id}/${stepId ?? 'base'} issues=${JSON.stringify(report.issues)}`).toBe(true)
  expect(report.measurementsOk, `${project.id}/${stepId ?? 'base'} issues=${JSON.stringify(report.issues)}`).toBe(true)
  expect(report.issues).toEqual([])
  expect(detectDanger(plan.checkInput)).toEqual([])
}

describe('M2 B1（DG-01~09）真实 ngspice 金标准验证', () => {
  it('DG-01：高阻分压加载误差（10 MΩ / 10 kΩ / 1 kΩ）、2 V 超量程 OL.、电流表内阻误差与记表/曲线', async () => {
    const project = loadProject('DG-01')
    expect(project.validation).toBeUndefined()

    const baseWires = [
      { a: 'ins-dc-power.CH1P', b: 'comp1.IM_IN' },
      { a: 'comp1.IM_OUT', b: 'comp1.RB_1' },
      { a: 'comp1.RB_2', b: 'comp1.RC_1' },
      { a: 'comp1.RC_2', b: 'ins-dc-power.CH1N' },
      { a: 'ins-dc-voltmeter.POS', b: 'comp1.RC_1' },
      { a: 'ins-dc-voltmeter.NEG', b: 'comp1.RC_2' },
    ]
    const rTh = (2000.01 * 10000) / (2000.01 + 10000)
    const uOpen = (12 * 10000) / (2000.01 + 10000)
    let task = createTaskState(project)

    for (const [row, internalR] of [10_000_000, 10_000, 1_000].entries()) {
      const res = await solveOp({
        title: `DG-01 Rin=${internalR}`,
        modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20', internalR }),
        ],
        wires: baseWires,
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      })
      if (row === 0) assertWiringClean(project, 'wire', res.plan)
      const expected = (uOpen * internalR) / (rTh + internalR)
      const measured = defined(res.rawV['ins-dc-voltmeter'], 'u_rc')
      expect(relErr(measured, expected)).toBeLessThanOrEqual(0.01)

      task = writeTableCell(project, task, 'meter_error', row, 'r_in', internalR).state
      task = writeTableCell(project, task, 'meter_error', row, 'u_ideal', 10).state
      const rec = recordCurrentReading(project, task, 'meter_error', row, 'u_meas', {
        snapshot: res.snapshot,
        row,
        advance: false,
      })
      expect(rec.ok, rec.message).toBe(true)
      task = rec.state
    }
    expect(task.tables.meter_error?.[2]?.rel_err).toBeCloseTo(-62.5, 0)
    const series = extractChartDataset(project, task, defined(project.charts[0], 'dg01 chart'))
    expect(series.points).toHaveLength(3)

    // 2 V 档超量程 OL.
    const ol = await solveOp({
      title: 'DG-01 OL',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r2', internalR: 10_000_000 }),
      ],
      wires: baseWires,
      ground: 'ins-dc-power.CH1N',
      controlValues: {},
      analysis: [],
    })
    expect(ol.readings['ins-dc-voltmeter']?.status).toBe('overload')
    expect(ol.readings['ins-dc-voltmeter']?.text).toBe('OL.')

    // 毫安表 2 mA 档 (100 Ω) 与 20 mA 档 (10 Ω) 内阻误差
    for (const [range, rA] of [
      ['r2m', 100],
      ['r20m', 10],
    ] as const) {
      const iRes = await solveOp({
        title: `DG-01 I ${range}`,
        modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-ammeter', dcAmp, { range }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'comp1.IM_IN' },
          { a: 'comp1.IM_OUT', b: 'comp1.RB_1' },
          { a: 'comp1.RB_2', b: 'comp1.RC_1' },
          { a: 'comp1.RC_2', b: 'ins-dc-power.CH1N' },
          { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
          { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      })
      assertWiringClean(project, 'current_error', iRes.plan)
      const expectedI = 12 / (12000.01 + rA)
      expect(relErr(defined(iRes.rawI['ins-dc-ammeter'], 'i_loop'), expectedI)).toBeLessThanOrEqual(0.01)
    }
  })

  it('DG-02：四类元件（RA、白炽灯、1N4007、2CW51）伏安特性曲线趋势与接线检查全通过', async () => {
    const project = loadProject('DG-02')

    // 1. 线性电阻 RA = 1 kΩ
    const rRes = await solveOp({
      title: 'DG-02 RA',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 10 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
      ],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'comp1.IM_IN' },
        { a: 'comp1.IM_OUT', b: 'comp1.RA_1' },
        { a: 'comp1.RA_2', b: 'ins-dc-power.CH1N' },
        { a: 'ins-dc-voltmeter.POS', b: 'comp1.RA_1' },
        { a: 'ins-dc-voltmeter.NEG', b: 'comp1.RA_2' },
        { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
        { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: {},
      analysis: [],
    })
    assertWiringClean(project, 'resistor', rRes.plan)
    expect(
      relErr(defined(rRes.rawV['ins-dc-voltmeter'], 'u_ra') / defined(rRes.rawI['ins-dc-ammeter'], 'i_ra'), 1000),
    ).toBeLessThanOrEqual(0.01)

    // 2. 白炽灯 EL1：2 V -> 12 V 阻值单调上升，12 V 时 I ≈ 0.100 A
    let prevR = 0
    for (const u of [2, 6, 12]) {
      const lRes = await solveOp({
        title: `DG-02 EL1 ${u}V`,
        modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: u }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'comp1.IM_IN' },
          { a: 'comp1.IM_OUT', b: 'comp1.EL_1' },
          { a: 'comp1.EL_2', b: 'ins-dc-power.CH1N' },
          { a: 'ins-dc-voltmeter.POS', b: 'comp1.EL_1' },
          { a: 'ins-dc-voltmeter.NEG', b: 'comp1.EL_2' },
          { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
          { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      })
      if (u === 12) assertWiringClean(project, 'lamp', lRes.plan)
      const uMeas = defined(lRes.rawV['ins-dc-voltmeter'], 'u_el')
      const iMeas = defined(lRes.rawI['ins-dc-ammeter'], 'i_el')
      const rHot = uMeas / iMeas
      expect(rHot).toBeGreaterThan(prevR)
      prevR = rHot
      if (u === 12) expect(relErr(iMeas, 0.1)).toBeLessThanOrEqual(0.02)
    }

    // 3. 1N4007 正向导通（串 220 Ω 限流）
    const dRes = await solveOp({
      title: 'DG-02 1N4007',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 5 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
      ],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'comp1.RLIM_1' },
        { a: 'comp1.RLIM_2', b: 'comp1.IM_IN' },
        { a: 'comp1.IM_OUT', b: 'comp1.VD_A' },
        { a: 'comp1.VD_K', b: 'ins-dc-power.CH1N' },
        { a: 'ins-dc-voltmeter.POS', b: 'comp1.VD_A' },
        { a: 'ins-dc-voltmeter.NEG', b: 'comp1.VD_K' },
        { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
        { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: {},
      analysis: [],
    })
    assertWiringClean(project, 'diode', dRes.plan)
    expect(defined(dRes.rawV['ins-dc-voltmeter'], 'vf')).toBeGreaterThan(0.6)
    expect(defined(dRes.rawV['ins-dc-voltmeter'], 'vf')).toBeLessThan(0.8)
    expect(defined(dRes.rawI['ins-dc-ammeter'], 'if')).toBeGreaterThan(0.015)

    // 4. 2CW51 稳压管反向击穿（串 220 Ω 限流）
    const zLow = await solveOp({
      title: 'DG-02 2CW51 2V',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 2 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
      ],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'comp1.RLIM_1' },
        { a: 'comp1.RLIM_2', b: 'comp1.IM_IN' },
        { a: 'comp1.IM_OUT', b: 'comp1.VZ_K' },
        { a: 'comp1.VZ_A', b: 'ins-dc-power.CH1N' },
        { a: 'ins-dc-voltmeter.POS', b: 'comp1.VZ_K' },
        { a: 'ins-dc-voltmeter.NEG', b: 'comp1.VZ_A' },
        { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
        { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: {},
      analysis: [],
    })
    expect(defined(zLow.rawI['ins-dc-ammeter'], 'iz_low')).toBeLessThan(0.0005)

    const zHigh = await solveOp({
      title: 'DG-02 2CW51 6V',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 6 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
      ],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'comp1.RLIM_1' },
        { a: 'comp1.RLIM_2', b: 'comp1.IM_IN' },
        { a: 'comp1.IM_OUT', b: 'comp1.VZ_K' },
        { a: 'comp1.VZ_A', b: 'ins-dc-power.CH1N' },
        { a: 'ins-dc-voltmeter.POS', b: 'comp1.VZ_K' },
        { a: 'ins-dc-voltmeter.NEG', b: 'comp1.VZ_A' },
        { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
        { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: {},
      analysis: [],
    })
    assertWiringClean(project, 'zener', zHigh.plan)
    expect(defined(zHigh.rawV['ins-dc-voltmeter'], 'vz')).toBeGreaterThan(3.2)
    expect(defined(zHigh.rawV['ins-dc-voltmeter'], 'vz')).toBeLessThan(3.6)
    expect(defined(zHigh.rawI['ins-dc-ammeter'], 'iz')).toBeGreaterThan(0.01)
  })

  it('DG-03：单臂电桥测 Rx=470 Ω 与白炽灯冷阻 12.0 Ω 平衡指零，热态测温符合 1724 ℃ 理论', async () => {
    const project = loadProject('DG-03')

    // 1. 未知电阻 Rx = 470 Ω：Rbox = 470 Ω 时电桥严格指零
    const rxBal = await solveOp({
      title: 'DG-03 bridge Rx balanced',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [defaultIns('ins-dc-power', dcPower, { ch1_v: 6 }), defaultIns('g1', galv, {})],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'comp1.BR_P' },
        { a: 'comp1.BR_L', b: 'comp1.RX_1' },
        { a: 'comp1.BR_R', b: 'comp1.RBOX_1' },
        { a: 'comp1.RX_2', b: 'comp1.BR_N' },
        { a: 'comp1.RBOX_2', b: 'comp1.BR_N' },
        { a: 'comp1.BR_N', b: 'ins-dc-power.CH1N' },
        { a: 'g1.POS', b: 'comp1.BR_L' },
        { a: 'g1.NEG', b: 'comp1.BR_R' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: { 'comp1.RBOX': 470 },
      analysis: [],
    })
    assertWiringClean(project, 'bridge_rx', rxBal.plan)
    expect(Math.abs(defined(rxBal.rawI.g1, 'ig_rx'))).toBeLessThan(1e-9)

    // 2. 白炽灯冷阻：2 V 桥压、Rbox = 12.0 Ω 时 |Ig| < 1 µA
    const coldBal = await solveOp({
      title: 'DG-03 bridge cold lamp',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [defaultIns('ins-dc-power', dcPower, { ch1_v: 2 }), defaultIns('g1', galv, {})],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'comp1.BR_P' },
        { a: 'comp1.BR_L', b: 'comp1.EL_1' },
        { a: 'comp1.BR_R', b: 'comp1.RBOX_1' },
        { a: 'comp1.EL_2', b: 'comp1.BR_N' },
        { a: 'comp1.RBOX_2', b: 'comp1.BR_N' },
        { a: 'comp1.BR_N', b: 'ins-dc-power.CH1N' },
        { a: 'g1.POS', b: 'comp1.BR_L' },
        { a: 'g1.NEG', b: 'comp1.BR_R' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: { 'comp1.RBOX': 12 },
      analysis: [],
    })
    assertWiringClean(project, 'bridge_cold', coldBal.plan)
    expect(Math.abs(defined(coldBal.rawI.g1, 'ig_cold'))).toBeLessThan(1e-6)

    // 3. 12 V 热态：Rhot ≈ 120 Ω -> T = 293.15 * (Rhot/12)^(1/1.2) ≈ 1997 K (1724 °C)
    const hot = await solveOp({
      title: 'DG-03 hot lamp 12V',
      modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
      ],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'comp1.IM_IN' },
        { a: 'comp1.IM_OUT', b: 'comp1.EL_1' },
        { a: 'comp1.EL_2', b: 'ins-dc-power.CH1N' },
        { a: 'ins-dc-voltmeter.POS', b: 'comp1.EL_1' },
        { a: 'ins-dc-voltmeter.NEG', b: 'comp1.EL_2' },
        { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
        { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: {},
      analysis: [],
    })
    assertWiringClean(project, 'hot_lamp', hot.plan)
    const rHot = defined(hot.rawV['ins-dc-voltmeter'], 'u') / defined(hot.rawI['ins-dc-ammeter'], 'i')
    const tempK = 293.15 * (rHot / 12) ** (1 / 1.2)
    expect(relErr(tempK, 1997)).toBeLessThanOrEqual(0.02)
  })

  it('DG-04：六节点电位随参考点 D→E 恒定平移、曲线可出图且 3 项故障六步闭环全通过', async () => {
    const project = loadProject('DG-04')
    const baseWires = [
      { a: 'ins-dc-power.CH1P', b: 'dc1.KH_U1P' },
      { a: 'ins-dc-power.CH1N', b: 'dc1.KH_U1N' },
      { a: 'ins-dc-power.CH2P', b: 'dc1.KH_U2P' },
      { a: 'ins-dc-power.CH2N', b: 'dc1.KH_U2N' },
    ]
    const measurePotential = async (
      nodeJack: string,
      refJack: string,
      fault?: NonNullable<Project['faults']>[number],
    ) =>
      solveOp({
        title: `DG-04 ${nodeJack}-${refJack}`,
        modules: [{ instanceId: 'dc1', module: modCircuit, subckt: cirCircuit }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 6, ch2_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        ],
        wires: [
          ...baseWires,
          { a: 'ins-dc-voltmeter.POS', b: `dc1.${nodeJack}` },
          { a: 'ins-dc-voltmeter.NEG', b: `dc1.${refJack}` },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'dc1.K1': 1, 'dc1.K2': 1, 'dc1.K3': 0 },
        ...(fault ? { fault } : {}),
        analysis: [],
      })

    const nodes = ['KH_F', 'KH_A', 'KH_B', 'KH_C', 'KH_D', 'KH_E'] as const
    const phiD: number[] = []
    const phiE: number[] = []
    let task = createTaskState(project)

    for (const [idx, node] of nodes.entries()) {
      const dVal = node === 'KH_D' ? 0 : defined((await measurePotential(node, 'KH_D')).rawV['ins-dc-voltmeter'], 'd')
      const eRes = node === 'KH_E' ? undefined : await measurePotential(node, 'KH_E')
      if (idx === 0 && eRes) assertWiringClean(project, 'ref_e', eRes.plan)
      const eVal = node === 'KH_E' ? 0 : defined(eRes?.rawV['ins-dc-voltmeter'], 'e')
      phiD.push(dVal)
      phiE.push(eVal)
      task = writeTableCell(project, task, 'potentials', idx, 'node_idx', idx + 1).state
      task = writeTableCell(project, task, 'potentials', idx, 'phi_d', dVal).state
      task = writeTableCell(project, task, 'potentials', idx, 'phi_e', eVal).state
    }
    // 全部 6 个节点满足恒定平移量 φ(E) - φ(D) = U_DE（≤ 1 mV 误差）
    const shift = defined(phiE[4], 'u_de')
    expect(shift).toBeGreaterThan(0.95)
    expect(shift).toBeLessThan(1.02)
    for (let i = 0; i < 6; i++) {
      expect(Math.abs((phiE[i] ?? 0) - (phiD[i] ?? 0) - shift)).toBeLessThan(0.002)
    }
    const chartSeries = extractChartDataset(project, task, defined(project.charts[0], 'dg04 chart'))
    expect(chartSeries.points).toHaveLength(6)

    // 3 项预设直流故障六步闭环
    let flow = createFaultFlowState()
    for (const [idx, fault] of defined(project.faults, 'dg04 faults').entries()) {
      const t = 1000 + idx * 5000
      const targetNode = fault.id === 'dg04-r4-drift' ? 'KH_E' : 'KH_A'
      flow = startFaultSession(project, flow, { mode: 'preset', faultId: fault.id, powered: false, nowMs: t }).state
      flow = observeFaultSymptom(project, flow, { powered: true, nowMs: t + 100 }).state
      const bad = await measurePotential(targetNode, 'KH_D', fault)
      flow = recordFaultMeasurement(project, flow, { snapshot: bad.snapshot, nowMs: t + 200 }).state
      flow = submitFaultDiagnosis(project, flow, { target: fault.target, kind: fault.kind, nowMs: t + 300 }).state
      flow = repairFault(project, flow, { powered: false, nowMs: t + 400 }).state
      const good = await measurePotential(targetNode, 'KH_D')
      const verified = verifyFaultRepair(project, flow, { powered: true, snapshot: good.snapshot, nowMs: t + 500 })
      expect(verified.ok, `${fault.id}: ${verified.message}`).toBe(true)
      flow = verified.state
    }
    expect(flow.resolvedFaultIds).toHaveLength(3)
  })

  it('DG-06：最大功率传输 7 点扫描在 RL = R0 = 100 Ω 处达到唯一峰值（≤1% 理论误差）', async () => {
    const project = loadProject('DG-06')
    const rValues = [20, 50, 80, 100, 150, 200, 400]
    let task = createTaskState(project)
    const powers: number[] = []
    for (const [row, rl] of rValues.entries()) {
      const res = await solveOp({
        title: `DG-06 RL=${rl}`,
        modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 10 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'comp1.R0_1' },
          { a: 'comp1.R0_2', b: 'comp1.IM_IN' },
          { a: 'comp1.IM_OUT', b: 'comp1.RBOX_1' },
          { a: 'comp1.RBOX_2', b: 'ins-dc-power.CH1N' },
          { a: 'ins-dc-voltmeter.POS', b: 'comp1.RBOX_1' },
          { a: 'ins-dc-voltmeter.NEG', b: 'comp1.RBOX_2' },
          { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
          { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'comp1.SW_R0': 100, 'comp1.RBOX': rl },
        analysis: [],
      })
      if (rl === 100) assertWiringClean(project, 'match_point', res.plan)
      const u = defined(res.rawV['ins-dc-voltmeter'], 'u_load')
      const i = defined(res.rawI['ins-dc-ammeter'], 'i_load')
      const expectedU = (10 * rl) / (101.01 + rl)
      const expectedI = 10 / (101.01 + rl)
      expect(relErr(u, expectedU)).toBeLessThanOrEqual(0.01)
      expect(relErr(i, expectedI)).toBeLessThanOrEqual(0.01)
      powers.push(u * i)
      task = writeTableCell(project, task, 'max_power', row, 'r_load', rl).state
      task = recordCurrentReading(project, task, 'max_power', row, 'u_load', {
        snapshot: res.snapshot,
        row,
        advance: false,
      }).state
      task = recordCurrentReading(project, task, 'max_power', row, 'i_load', {
        snapshot: res.snapshot,
        row,
        advance: false,
      }).state
    }
    const maxIdx = powers.indexOf(Math.max(...powers))
    expect(rValues[maxIdx]).toBe(100)
    expect(relErr(defined(powers[maxIdx], 'pmax'), 100 / (4 * 101.01))).toBeLessThanOrEqual(0.01)
    expect(extractChartDataset(project, task, defined(project.charts[0], 'p-rl')).points).toHaveLength(7)
  })

  it('DG-07：实际电压源（10 V/100 Ω）与诺顿等效电流源（100 mA∥100 Ω）五点外特性重合度 ≤ 1%', async () => {
    const project = loadProject('DG-07')
    for (const rl of [50, 100, 200, 500, 2000]) {
      const vs = await solveOp({
        title: `DG-07 VS RL=${rl}`,
        modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 10 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'comp1.R0_1' },
          { a: 'comp1.R0_2', b: 'comp1.IM_IN' },
          { a: 'comp1.IM_OUT', b: 'comp1.RBOX_1' },
          { a: 'comp1.RBOX_2', b: 'ins-dc-power.CH1N' },
          { a: 'ins-dc-voltmeter.POS', b: 'comp1.RBOX_1' },
          { a: 'ins-dc-voltmeter.NEG', b: 'comp1.RBOX_2' },
          { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
          { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'comp1.SW_R0': 100, 'comp1.RBOX': rl },
        analysis: [],
      })
      const cs = await solveOp({
        title: `DG-07 CS RL=${rl}`,
        modules: [{ instanceId: 'comp1', module: modComp, subckt: cirComp }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { is_range: 2, is_ma: 100 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
        ],
        wires: [
          { a: 'ins-dc-power.ISP', b: 'comp1.R0_1' },
          { a: 'comp1.R0_1', b: 'comp1.IM_IN' },
          { a: 'comp1.IM_OUT', b: 'comp1.RBOX_1' },
          { a: 'comp1.R0_2', b: 'ins-dc-power.ISN' },
          { a: 'comp1.RBOX_2', b: 'ins-dc-power.ISN' },
          { a: 'ins-dc-voltmeter.POS', b: 'comp1.RBOX_1' },
          { a: 'ins-dc-voltmeter.NEG', b: 'comp1.RBOX_2' },
          { a: 'ins-dc-ammeter.POS', b: 'comp1.IM_A' },
          { a: 'ins-dc-ammeter.NEG', b: 'comp1.IM_B' },
        ],
        ground: 'ins-dc-power.ISN',
        controlValues: { 'comp1.SW_R0': 100, 'comp1.RBOX': rl },
        analysis: [],
      })
      if (rl === 100) {
        assertWiringClean(project, 'voltage_source', vs.plan)
        assertWiringClean(project, 'current_source', cs.plan)
      }
      expect(
        relErr(defined(cs.rawV['ins-dc-voltmeter'], 'u_cs'), defined(vs.rawV['ins-dc-voltmeter'], 'u_vs')),
      ).toBeLessThanOrEqual(0.01)
      expect(
        relErr(defined(cs.rawI['ins-dc-ammeter'], 'i_cs'), defined(vs.rawI['ins-dc-ammeter'], 'i_vs')),
      ).toBeLessThanOrEqual(0.01)
    }
  })

  it('DG-08：线性网络（K3=0）叠加误差 ≤ 1%、二极管支路（K3=1）叠加不成立且 3 项故障闭环通过', async () => {
    const project = loadProject('DG-08')
    const baseWires = [
      { a: 'ins-dc-power.CH1P', b: 'dc1.KH_U1P' },
      { a: 'ins-dc-power.CH1N', b: 'dc1.KH_U1N' },
      { a: 'ins-dc-power.CH2P', b: 'dc1.KH_U2P' },
      { a: 'ins-dc-power.CH2N', b: 'dc1.KH_U2N' },
    ]
    const measureUad = async (k1: number, k2: number, k3: number, fault?: NonNullable<Project['faults']>[number]) =>
      solveOp({
        title: `DG-08 k=${k1}${k2}${k3}`,
        modules: [{ instanceId: 'dc1', module: modCircuit, subckt: cirCircuit }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 6, ch2_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        ],
        wires: [
          ...baseWires,
          { a: 'ins-dc-voltmeter.POS', b: 'dc1.KH_A' },
          { a: 'ins-dc-voltmeter.NEG', b: 'dc1.KH_D' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'dc1.K1': k1, 'dc1.K2': k2, 'dc1.K3': k3 },
        ...(fault ? { fault } : {}),
        analysis: [],
      })

    // 线性：U_AD(1,0) + U_AD(0,1) == U_AD(1,1)
    const lin1 = await measureUad(1, 0, 0)
    const lin2 = await measureUad(0, 1, 0)
    const linBoth = await measureUad(1, 1, 0)
    assertWiringClean(project, 'linear_both', linBoth.plan)
    const u1 = defined(lin1.rawV['ins-dc-voltmeter'], 'u1')
    const u2 = defined(lin2.rawV['ins-dc-voltmeter'], 'u2')
    const uBoth = defined(linBoth.rawV['ins-dc-voltmeter'], 'uboth')
    expect(relErr(u1 + u2, uBoth)).toBeLessThanOrEqual(0.01)

    // 非线性（K3=1 切入 1N4007）：叠加显著失效（偏差 > 0.3 V）
    const nl1 = defined((await measureUad(1, 0, 1)).rawV['ins-dc-voltmeter'], 'nl1')
    const nl2 = defined((await measureUad(0, 1, 1)).rawV['ins-dc-voltmeter'], 'nl2')
    const nlBoth = defined((await measureUad(1, 1, 1)).rawV['ins-dc-voltmeter'], 'nlboth')
    expect(Math.abs(nl1 + nl2 - nlBoth)).toBeGreaterThan(0.3)

    // 3 项故障六步闭环
    let flow = createFaultFlowState()
    for (const [idx, fault] of defined(project.faults, 'dg08 faults').entries()) {
      const t = 1000 + idx * 5000
      flow = startFaultSession(project, flow, { mode: 'preset', faultId: fault.id, powered: false, nowMs: t }).state
      flow = observeFaultSymptom(project, flow, { powered: true, nowMs: t + 100 }).state
      const bad = await measureUad(1, 1, 0, fault)
      const uBad = defined(bad.rawV['ins-dc-voltmeter'], 'uBad')
      expect(uBad < 3.85 || uBad > 4.25, `${fault.id} U_AD=${uBad}`).toBe(true)
      flow = recordFaultMeasurement(project, flow, { snapshot: bad.snapshot, nowMs: t + 200 }).state
      flow = submitFaultDiagnosis(project, flow, { target: fault.target, kind: fault.kind, nowMs: t + 300 }).state
      flow = repairFault(project, flow, { powered: false, nowMs: t + 400 }).state
      const verified = verifyFaultRepair(project, flow, { powered: true, snapshot: linBoth.snapshot, nowMs: t + 500 })
      expect(verified.ok, `${fault.id}: ${verified.message}`).toBe(true)
      flow = verified.state
    }
    expect(flow.resolvedFaultIds).toHaveLength(3)
  })

  it('DG-09：双挂箱戴维南等效（U_oc/I_sc/R_eq 与 5 点带载 ≤1%）、Cu50 测温电桥 0~100 ℃ 与 3 项故障闭环', async () => {
    const project = loadProject('DG-09')
    const thBaseWires = [
      { a: 'ins-dc-power.CH1P', b: 'dc1.TH_USP' },
      { a: 'ins-dc-power.CH1N', b: 'dc1.TH_USN' },
      { a: 'ins-dc-power.ISP', b: 'dc1.TH_ISP' },
      { a: 'ins-dc-power.ISN', b: 'dc1.TH_ISN' },
    ]
    const dualModules = [
      { instanceId: 'dc1', module: modCircuit, subckt: cirCircuit },
      { instanceId: 'comp1', module: modComp, subckt: cirComp },
    ]

    // 1. 开路电压 U_oc ≈ 9.389 V
    const ocRes = await solveOp({
      title: 'DG-09 U_oc',
      modules: dualModules,
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 12, is_range: 1, is_ma: 10 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
      ],
      wires: [
        ...thBaseWires,
        { a: 'ins-dc-voltmeter.POS', b: 'dc1.TH_A' },
        { a: 'ins-dc-voltmeter.NEG', b: 'dc1.TH_B' },
      ],
      ground: 'ins-dc-power.CH1N',
      controlValues: {},
      analysis: [],
    })
    assertWiringClean(project, 'thevenin_oc', ocRes.plan)
    const r67 = (330 * 510) / (330 + 510)
    const rEqTheory = r67 + 10 + 510
    const uOcTheory = (12 * 510) / 840 + 0.01 * (r67 + 10)
    const uOc = defined(ocRes.rawV['ins-dc-voltmeter'], 'u_oc')
    expect(relErr(uOc, uOcTheory)).toBeLessThanOrEqual(0.01)

    // 2. 5 点带载（comp1.RBOX）满足戴维南外特性 ≤ 1%
    for (const rl of [200, 500, 720, 1000, 2000]) {
      const ld = await solveOp({
        title: `DG-09 load ${rl}`,
        modules: dualModules,
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12, is_range: 1, is_ma: 10 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r20m' }),
        ],
        wires: [
          ...thBaseWires,
          { a: 'dc1.TH_A', b: 'comp1.RBOX_1' },
          { a: 'dc1.TH_B', b: 'comp1.RBOX_2' },
          { a: 'ins-dc-voltmeter.POS', b: 'dc1.TH_A' },
          { a: 'ins-dc-voltmeter.NEG', b: 'dc1.TH_B' },
          { a: 'ins-dc-ammeter.POS', b: 'dc1.TH_IA' },
          { a: 'ins-dc-ammeter.NEG', b: 'dc1.TH_IB' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'comp1.RBOX': rl },
        analysis: [],
      })
      if (rl === 720) assertWiringClean(project, 'thevenin_load', ld.plan)
      const iExp = uOcTheory / (rEqTheory + 10 + rl)
      const uExp = iExp * rl
      expect(relErr(defined(ld.rawV['ins-dc-voltmeter'], 'u_th'), uExp)).toBeLessThanOrEqual(0.01)
      expect(relErr(defined(ld.rawI['ins-dc-ammeter'], 'i_th'), iExp)).toBeLessThanOrEqual(0.01)
    }

    // 3. Cu50 非平衡测温电桥 0 ~ 100 °C 标定（≤ 1%）
    const cuWires = [
      { a: 'ins-dc-power.CH1P', b: 'comp1.BR_P' },
      { a: 'comp1.BR_L', b: 'comp1.CU_1' },
      { a: 'comp1.BR_R', b: 'comp1.RBOX_1' },
      { a: 'comp1.CU_2', b: 'comp1.BR_N' },
      { a: 'comp1.RBOX_2', b: 'comp1.BR_N' },
      { a: 'comp1.BR_N', b: 'ins-dc-power.CH1N' },
      { a: 'ins-dc-voltmeter.POS', b: 'comp1.BR_L' },
      { a: 'ins-dc-voltmeter.NEG', b: 'comp1.BR_R' },
    ]
    let task = { ...createTaskState(project), completedSteps: ['prepare', 'thevenin_oc', 'thevenin_load'] }
    const bridgeZero = await solveOp({
      title: 'DG-09 Cu50 0C',
      modules: dualModules,
      instruments: [
        defaultIns('ins-dc-power', dcPower, { ch1_v: 6 }),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r200m' }),
      ],
      wires: cuWires,
      ground: 'ins-dc-power.CH1N',
      controlValues: { 'comp1.RBOX': 50, 'comp1.T_CU50': 0 },
      analysis: [],
    })
    assertWiringClean(project, 'cu50_bridge', bridgeZero.plan)
    expect(Math.abs(defined(bridgeZero.rawV['ins-dc-voltmeter'], 'u0'))).toBeLessThan(1e-5)

    for (const [row, tempC] of [0, 20, 40, 60, 80, 100].entries()) {
      const res = await solveOp({
        title: `DG-09 Cu50 ${tempC}C`,
        modules: dualModules,
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 6 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r200m' }),
        ],
        wires: cuWires,
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'comp1.RBOX': 50, 'comp1.T_CU50': tempC },
        analysis: [],
      })
      const rCu = 50 + 0.214 * tempC
      const expected = 6 * (rCu / (1000 + rCu) - 50 / 1050)
      const actual = defined(res.rawV['ins-dc-voltmeter'], `u_cu50_${tempC}`)
      if (tempC === 0) expect(Math.abs(actual)).toBeLessThan(1e-4)
      else expect(relErr(actual, expected)).toBeLessThanOrEqual(0.01)
      task = writeTableCell(project, task, 'cu50_temp', row, 'temp_c', tempC).state
      const rec = recordCurrentReading(project, task, 'cu50_temp', row, 'u_bridge', {
        snapshot: res.snapshot,
        row,
        advance: false,
      })
      expect(rec.ok, rec.message).toBe(true)
      task = rec.state
    }
    expect(extractChartDataset(project, task, defined(project.charts[1], 'chart_cu50')).points).toHaveLength(6)

    // 4. 3 项预设故障六步闭环（含跨挂箱 dc1 + comp1 故障）
    let flow = createFaultFlowState()
    for (const [idx, fault] of defined(project.faults, 'dg09 faults').entries()) {
      const t = 1000 + idx * 5000
      const isBridge = fault.id === 'dg09-rbr1-drift'
      flow = startFaultSession(project, flow, { mode: 'preset', faultId: fault.id, powered: false, nowMs: t }).state
      flow = observeFaultSymptom(project, flow, { powered: true, nowMs: t + 100 }).state
      const bad = await solveOp({
        title: `DG-09 fault ${fault.id}`,
        modules: dualModules,
        instruments: isBridge
          ? [
              defaultIns('ins-dc-power', dcPower, { ch1_v: 6 }),
              defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r200m' }),
            ]
          : [
              defaultIns('ins-dc-power', dcPower, { ch1_v: 12, is_range: 1, is_ma: 10 }),
              defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
            ],
        wires: isBridge
          ? cuWires
          : [
              ...thBaseWires,
              { a: 'ins-dc-voltmeter.POS', b: 'dc1.TH_A' },
              { a: 'ins-dc-voltmeter.NEG', b: 'dc1.TH_B' },
            ],
        ground: 'ins-dc-power.CH1N',
        controlValues: isBridge ? { 'comp1.RBOX': 50, 'comp1.T_CU50': 0 } : {},
        fault,
        analysis: [],
      })
      flow = recordFaultMeasurement(project, flow, { snapshot: bad.snapshot, nowMs: t + 200 }).state
      flow = submitFaultDiagnosis(project, flow, { target: fault.target, kind: fault.kind, nowMs: t + 300 }).state
      flow = repairFault(project, flow, { powered: false, nowMs: t + 400 }).state
      const verified = verifyFaultRepair(project, flow, {
        powered: true,
        snapshot: isBridge ? bridgeZero.snapshot : ocRes.snapshot,
        nowMs: t + 500,
      })
      expect(verified.ok, `${fault.id}: ${verified.message}`).toBe(true)
      flow = verified.state
    }
    expect(flow.resolvedFaultIds).toHaveLength(3)
  })
})
