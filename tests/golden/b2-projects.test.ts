import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import {
  computePowerMetrics,
  getInstrumentDefaults,
  type PowerMetrics,
  readInstrument,
} from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import {
  createTaskState,
  extractChartDataset,
  type MeasurementSnapshot,
  recordCurrentReading,
  scopedReference,
  writeTableCell,
} from '../../src/domain/task/index.ts'
import { checkWiring, detectDanger } from '../../src/domain/wiring-check/index.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// M2 B2（DG-10~20，含 DG-19 升级正式项目，DG-12 由 m1-projects.test.ts 覆盖）真实 ngspice 全流程金标准验证。

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const loadIns = (id: string) => Instrument.parse(loadJson(`content/instruments/${id}/instrument.json`))
const loadMod = (id: string) => Module.parse(loadJson(`content/modules/${id}/module.json`))
const loadProject = (id: string) => Project.parse(loadJson(`content/projects/${id}/project.json`))

const LIBRARIES = {
  'diodes.lib': readFileSync('content/models/spice/diodes.lib', 'utf8'),
  'sensors.lib': readFileSync('content/models/spice/sensors.lib', 'utf8'),
  'power.lib': readFileSync('content/models/spice/power.lib', 'utf8'),
}

const loadModCir = (id: string) =>
  expandLocalLibraries(readFileSync(`content/modules/${id}/module.cir`, 'utf8'), LIBRARIES)

const modFluor = loadMod('mod-ac-fluorescent')
const cirFluor = loadModCir('mod-ac-fluorescent')
const modDimmer = loadMod('mod-phase-dimmer')
const cirDimmer = loadModCir('mod-phase-dimmer')
const mod3ph = loadMod('mod-3ph-lamp')
const cir3ph = loadModCir('mod-3ph-lamp')
const modXfmr = loadMod('mod-transformer')
const cirXfmr = loadModCir('mod-transformer')
const modRlc = loadMod('mod-rlc-transient')
const cirRlc = loadModCir('mod-rlc-transient')

const acPower = loadIns('ins-ac-power')
const dcPower = loadIns('ins-dc-power')
const acVolt = loadIns('ins-ac-voltmeter')
const acAmp = loadIns('ins-ac-ammeter')
const dcVolt = loadIns('ins-dc-voltmeter')
const watt = loadIns('ins-power-meter')
const mvMeter = loadIns('ins-ac-millivoltmeter')
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

interface TranSampleResult {
  plan: ReturnType<typeof buildMeasurementPlan>
  times: number[]
  channels: Record<string, number[]>
  acV: Record<string, number>
  dcV: Record<string, number>
  acI: Record<string, number>
  power: Record<string, PowerMetrics>
  snapshot: MeasurementSnapshot
}

function rmsOf(values: number[], startIdx: number, endIdx: number): number {
  const n = endIdx - startIdx
  if (n <= 0) return 0
  let sum = 0
  for (let k = startIdx; k < endIdx; k++) sum += values[k] ?? 0
  const mean = sum / n
  let m2 = 0
  for (let k = startIdx; k < endIdx; k++) {
    const d = (values[k] ?? 0) - mean
    m2 += d * d
  }
  return Math.sqrt(m2 / n)
}

let activeRunId = 0

async function runTran(
  input: AssembleInput,
  durationSec: number,
  options: {
    settleSec?: number
    stepOverride?: number
    alterAtSec?: {
      atSec: number
      changes: { param: string; value: number; targets?: { element: string; value: number }[] }[]
    }
  } = {},
): Promise<TranSampleResult> {
  const runId = ++activeRunId
  const plan = buildMeasurementPlan(input, true, 'b2-tran')
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
  let altered = false
  let chunkDt = step
  const deadline = Date.now() + 25_000

  while (Date.now() < deadline && runId === activeRunId) {
    await wait(5)
    if (runId !== activeRunId) break
    for (const ev of events.splice(0)) {
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
      if (ev.type === 'loaded') {
        loaded = true
        session.handle({ type: 'run' })
      }
      if (ev.type === 'chunk' && loaded) {
        const firstArr = Object.values(ev.data)[0]
        const count = firstArr?.length ?? 0
        if (count === 0) continue
        chunkDt = ev.dt
        for (let i = 0; i < count; i++) times.push(ev.t0 + i * ev.dt)
        for (const id of probeIds) {
          const arr = channels[id] as number[]
          const src = ev.data[id]
          if (!src) continue
          for (let i = 0; i < src.length; i++) arr.push(src[i] ?? 0)
        }
        const simNow = ev.t0 + count * ev.dt
        if (options.alterAtSec && !altered && simNow >= options.alterAtSec.atSec) {
          altered = true
          session.handle({ type: 'alter', changes: options.alterAtSec.changes })
        }
        if (simNow >= durationSec) {
          await pauseAndIdle()
          const settle = options.settleSec ?? durationSec * 0.4
          const foundStart = times.findIndex((t) => t >= settle)
          const startIdx = Math.max(foundStart, 0)
          const foundEnd = times.findIndex((t) => t > durationSec)
          const endIdx = foundEnd > startIdx ? foundEnd : times.length
          const acV: Record<string, number> = {}
          const dcV: Record<string, number> = {}
          const acI: Record<string, number> = {}
          const power: Record<string, PowerMetrics> = {}
          const readings: Record<string, ReturnType<typeof readInstrument>> = {}

          for (const meter of plan.meters) {
            const vArr = meter.voltageProbe ? channels[meter.voltageProbe] : undefined
            const iArr = meter.currentProbe ? channels[meter.currentProbe] : undefined
            if (meter.config.mode === 'power' && vArr && iArr) {
              const m = defined(
                computePowerMetrics(vArr.slice(startIdx, endIdx), iArr.slice(startIdx, endIdx), chunkDt),
                `${meter.instanceId} power`,
              )
              power[meter.instanceId] = m
              readings[meter.instanceId] = readInstrument(meter.config, {
                power: m,
                connectedJacks: meter.connectedJacks,
              })
            } else {
              let vVal: number | undefined
              let rmsV: number | undefined
              let iVal: number | undefined
              let rmsI: number | undefined
              if (vArr) {
                if (meter.config.mode === 'acv') {
                  rmsV = rmsOf(vArr, startIdx, endIdx)
                  acV[meter.instanceId] = rmsV
                } else {
                  let sum = 0
                  for (let k = startIdx; k < endIdx; k++) sum += vArr[k] ?? 0
                  vVal = sum / Math.max(1, endIdx - startIdx)
                  dcV[meter.instanceId] = vVal
                }
              }
              if (iArr) {
                if (meter.config.mode === 'aca') {
                  rmsI = rmsOf(iArr, startIdx, endIdx)
                  acI[meter.instanceId] = rmsI
                } else {
                  let sum = 0
                  for (let k = startIdx; k < endIdx; k++) sum += iArr[k] ?? 0
                  iVal = sum / Math.max(1, endIdx - startIdx)
                }
              }
              readings[meter.instanceId] = readInstrument(meter.config, {
                voltage: vVal,
                current: iVal,
                rmsVoltage: rmsV,
                rmsCurrent: rmsI,
                connectedJacks: meter.connectedJacks,
              })
            }
          }
          return {
            plan,
            times,
            channels,
            acV,
            dcV,
            acI,
            power,
            snapshot: { current: true, plan, readings } satisfies MeasurementSnapshot,
          }
        }
      }
    }
  }
  await pauseAndIdle()
  throw new Error(`Timed out running transient simulation for ${input.title}`)
}

describe('M2 B2（DG-10~20）真实 ngspice 金标准验证', () => {
  it('DG-10：日光灯三阶段启辉（未启辉/预热/稳态）与电压相量关系 U_L + U_A > U（≤ 1%）', async () => {
    const project = loadProject('DG-10')
    const baseWires = [
      { a: 'ins-ac-power.U', b: 'ac1.AC_L' },
      { a: 'ins-ac-power.N', b: 'ac1.AC_N' },
      { a: 'ins-ac-ammeter.I', b: 'ac1.I_LINE_A' },
      { a: 'ins-ac-ammeter.STAR', b: 'ac1.I_LINE_B' },
      { a: 'ins-power-meter.I', b: 'ac1.I_TOT_A' },
      { a: 'ins-power-meter.I_STAR', b: 'ac1.I_TOT_B' },
      { a: 'ins-power-meter.U', b: 'ac1.LOAD_IN' },
      { a: 'ins-power-meter.U_STAR', b: 'ac1.AC_N' },
      { a: 'ins-ac-voltmeter.U', b: 'ac1.LOAD_IN' },
      { a: 'ins-ac-voltmeter.STAR', b: 'ac1.AC_N' },
    ]
    const makeInput = (swStart: number, vA = 'ac1.LOAD_IN', vB = 'ac1.AC_N'): AssembleInput => ({
      title: `DG-10 sw=${swStart}`,
      modules: [{ instanceId: 'ac1', module: modFluor, subckt: cirFluor }],
      instruments: [
        defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
        defaultIns('ins-ac-voltmeter', acVolt, { range: 'r500' }),
        defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
        defaultIns('ins-power-meter', watt, { displayMode: 'pf' }),
      ],
      wires: [...baseWires.slice(0, 8), { a: 'ins-ac-voltmeter.U', b: vA }, { a: 'ins-ac-voltmeter.STAR', b: vB }],
      ground: 'ins-ac-power.N',
      controlValues: { 'ac1.KC1': 0, 'ac1.KC2': 0, 'ac1.KC3': 0, 'ac1.SW_START': swStart },
      analysis: [],
    })

    // 未启辉：电流接近 0
    const unlit = await runTran(makeInput(0), 0.14, { settleSec: 0.08 })
    expect(defined(unlit.acI['ins-ac-ammeter'], 'i_unlit')).toBeLessThan(0.005)

    // 预热：电流升至约 0.42 A
    const preheat = await runTran(makeInput(2), 0.14, { settleSec: 0.08 })
    expect(defined(preheat.acI['ins-ac-ammeter'], 'i_preheat')).toBeGreaterThan(0.4)

    // 稳态点亮：接线检查 + 相量关系 U_L ≈ 191.7 V, U_A ≈ 88.2 V, U_L + U_A ≈ 280 V > 220 V
    const steady = await runTran(makeInput(1), 0.18, { settleSec: 0.1 })
    assertWiringClean(project, 'wire', steady.plan)
    const uTotal = defined(steady.acV['ins-ac-voltmeter'], 'u_total')
    const iRl = defined(steady.acI['ins-ac-ammeter'], 'i_rl')
    const pMetrics = defined(steady.power['ins-power-meter'], 'p_rl')
    const zTheory = Math.hypot(300.25, 2 * Math.PI * 50 * 1.65)
    expect(relErr(uTotal, 220)).toBeLessThanOrEqual(0.01)
    expect(relErr(iRl, 220 / zTheory)).toBeLessThanOrEqual(0.01)
    expect(relErr(pMetrics.pf, 300 / Math.hypot(300, 2 * Math.PI * 50 * 1.65))).toBeLessThanOrEqual(0.015)

    const ballast = await runTran(makeInput(1, 'ac1.LOAD_IN', 'ac1.BALLAST_OUT'), 0.18, { settleSec: 0.1 })
    const lamp = await runTran(makeInput(1, 'ac1.BALLAST_OUT', 'ac1.LAMP_N'), 0.18, { settleSec: 0.1 })
    const uBallast = defined(ballast.acV['ins-ac-voltmeter'], 'u_ballast')
    const uLamp = defined(lamp.acV['ins-ac-voltmeter'], 'u_lamp')
    expect(relErr(uBallast, iRl * Math.hypot(60, 2 * Math.PI * 50 * 1.65))).toBeLessThanOrEqual(0.01)
    expect(relErr(uLamp, iRl * 240)).toBeLessThanOrEqual(0.01)
    expect(uBallast + uLamp).toBeGreaterThan(275)
  })

  it('DG-11：阻容移相调光台灯（DB3 + BTA06 + 25 W 灯泡）移相电阻增大使有效电压单调下降', async () => {
    const project = loadProject('DG-11')
    const wires = [
      { a: 'ins-ac-power.U', b: 'dim1.AC_L' },
      { a: 'dim1.AC_L', b: 'dim1.LP_1' },
      { a: 'dim1.LP_2', b: 'dim1.MT2' },
      { a: 'dim1.MT2', b: 'dim1.RC_IN' },
      { a: 'dim1.RC_MID', b: 'dim1.DB_1' },
      { a: 'dim1.DB_2', b: 'dim1.GATE' },
      { a: 'dim1.MT1', b: 'dim1.RC_N' },
      { a: 'dim1.RC_N', b: 'dim1.AC_N' },
      { a: 'dim1.AC_N', b: 'ins-ac-power.N' },
      { a: 'ins-ac-voltmeter.U', b: 'dim1.LP_1' },
      { a: 'ins-ac-voltmeter.STAR', b: 'dim1.LP_2' },
      { a: 'scope1.CH1', b: 'dim1.MT2' },
      { a: 'scope1.CH2', b: 'dim1.RC_MID' },
      { a: 'scope1.GND', b: 'dim1.MT1' },
    ]
    let task = createTaskState(project)
    const uList: number[] = []
    for (const [row, rp] of [10_000, 50_000, 120_000, 200_000, 280_000].entries()) {
      const res = await runTran(
        {
          title: `DG-11 RP=${rp}`,
          modules: [{ instanceId: 'dim1', module: modDimmer, subckt: cirDimmer }],
          instruments: [
            defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
            defaultIns('ins-ac-voltmeter', acVolt, { range: 'r500' }),
            defaultIns('scope1', scope, { timebase: 0.005 }),
          ],
          wires,
          ground: 'ins-ac-power.N',
          controlValues: { 'dim1.RP_DIM': rp },
          analysis: [],
        },
        0.14,
        { settleSec: 0.06, stepOverride: 0.0001 },
      )
      if (row === 0) assertWiringClean(project, 'wire', res.plan)
      const uLamp = defined(res.acV['ins-ac-voltmeter'], `u_lamp_${rp}`)
      uList.push(uLamp)
      task = writeTableCell(project, task, 'dimmer_sweep', row, 'rp_kohm', rp / 1000).state
      const rec = recordCurrentReading(project, task, 'dimmer_sweep', row, 'u_lamp', {
        snapshot: res.snapshot,
        row,
        advance: false,
      })
      expect(rec.ok, rec.message).toBe(true)
      task = rec.state
    }
    expect(uList[0] ?? 0).toBeGreaterThan(195)
    expect(uList[4] ?? 999).toBeLessThan(115)
    for (let i = 1; i < uList.length; i++) {
      expect((uList[i] ?? 0) < (uList[i - 1] ?? 0)).toBe(true)
    }
    expect(extractChartDataset(project, task, defined(project.charts[0], 'dimmer chart')).points).toHaveLength(5)
  })

  it('DG-13：电感感抗升频递增、电容容抗升频递减（≤ 1%）与整流桥三级滤波纹波显著压缩', async () => {
    const project = loadProject('DG-13')

    // 1. 电感 10 mH 频扫：500 Hz -> 4000 Hz（Rs=1 kΩ）
    let prevUl = 0
    for (const freq of [500, 2000, 4000]) {
      const res = await runTran(
        {
          title: `DG-13 L ${freq}Hz`,
          modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
          instruments: [
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: freq, ch1_amp: 4 }),
            defaultIns('mv1', mvMeter, { range: 'r3' }),
          ],
          wires: [
            { a: 'generator1.CH1', b: 'rlc1.RS_1' },
            { a: 'rlc1.RS_2', b: 'rlc1.LS_1' },
            { a: 'rlc1.LS_2', b: 'generator1.GND' },
            { a: 'mv1.CH1', b: 'rlc1.LS_1' },
            { a: 'mv1.GND', b: 'rlc1.LS_2' },
          ],
          ground: 'generator1.GND',
          controlValues: { 'rlc1.SW_RLC_R': 1000 },
          analysis: [],
        },
        12 / freq,
        { settleSec: 6 / freq, stepOverride: 1 / (freq * 80) },
      )
      if (freq === 500) assertWiringClean(project, 'impedance_l', res.plan)
      const xl = 2 * Math.PI * freq * 0.01
      const zL = Math.hypot(5, xl)
      const zTot = Math.hypot(1055, xl)
      const uExp = (4 / (2 * Math.SQRT2)) * (zL / zTot)
      const uActual = defined(res.acV.mv1, `uL_${freq}`)
      expect(relErr(uActual, uExp)).toBeLessThanOrEqual(0.015)
      expect(uActual).toBeGreaterThan(prevUl)
      prevUl = uActual
    }

    // 2. 电容 0.1 µF 频扫：500 Hz -> 4000 Hz（U_C 单调下降）
    let prevUc = Number.POSITIVE_INFINITY
    for (const freq of [500, 2000, 4000]) {
      const res = await runTran(
        {
          title: `DG-13 C ${freq}Hz`,
          modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
          instruments: [
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: freq, ch1_amp: 4 }),
            defaultIns('mv1', mvMeter, { range: 'r3' }),
          ],
          wires: [
            { a: 'generator1.CH1', b: 'rlc1.RS_1' },
            { a: 'rlc1.RS_2', b: 'rlc1.CS_1' },
            { a: 'rlc1.CS_2', b: 'generator1.GND' },
            { a: 'mv1.CH1', b: 'rlc1.CS_1' },
            { a: 'mv1.GND', b: 'rlc1.CS_2' },
          ],
          ground: 'generator1.GND',
          controlValues: { 'rlc1.SW_RLC_R': 1000 },
          analysis: [],
        },
        12 / freq,
        { settleSec: 6 / freq, stepOverride: 1 / (freq * 80) },
      )
      if (freq === 500) assertWiringClean(project, 'impedance_c', res.plan)
      const xc = 1 / (2 * Math.PI * freq * 1e-7)
      const uExp = (4 / (2 * Math.SQRT2)) * (xc / Math.hypot(1050, xc))
      const uActual = defined(res.acV.mv1, `uC_${freq}`)
      expect(relErr(uActual, uExp)).toBeLessThanOrEqual(0.015)
      expect(uActual).toBeLessThan(prevUc)
      prevUc = uActual
    }

    // 3. 整流桥三级滤波（0=无滤波 / 1=单电容 100 µF / 2=π型 LC）
    const ripples: number[] = []
    const dcs: number[] = []
    for (const filt of [0, 1, 2]) {
      const res = await runTran(
        {
          title: `DG-13 filt=${filt}`,
          modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
          instruments: [
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 50, ch1_amp: 10 }),
            defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
            defaultIns('scope1', scope, { timebase: 0.005 }),
          ],
          wires: [
            { a: 'generator1.CH1', b: 'rlc1.BR_AC1' },
            { a: 'generator1.GND', b: 'rlc1.BR_AC2' },
            { a: 'ins-dc-voltmeter.POS', b: 'rlc1.FL_OUT' },
            { a: 'ins-dc-voltmeter.NEG', b: 'rlc1.BR_N' },
            { a: 'scope1.CH1', b: 'rlc1.FL_OUT' },
            { a: 'scope1.GND', b: 'rlc1.BR_N' },
          ],
          ground: 'generator1.GND',
          controlValues: { 'rlc1.SW_FILT': filt },
          analysis: [],
        },
        0.24,
        { settleSec: 0.16, stepOverride: 0.0002 },
      )
      if (filt === 0) assertWiringClean(project, 'rectifier_filter', res.plan)
      const vOut = defined(res.channels['scope:scope1:CH1'], 'scope_ch1')
      const idx0 = res.times.findIndex((t) => t >= 0.16)
      let vmin = Number.POSITIVE_INFINITY
      let vmax = Number.NEGATIVE_INFINITY
      for (let i = idx0; i < vOut.length; i++) {
        const v = vOut[i] ?? 0
        if (v < vmin) vmin = v
        if (v > vmax) vmax = v
      }
      ripples.push(vmax - vmin)
      dcs.push(defined(res.dcV['ins-dc-voltmeter'], `dc_${filt}`))
    }
    expect(ripples[0] ?? 0).toBeGreaterThan(3.0)
    expect(ripples[1] ?? 99).toBeLessThan(0.6)
    expect(ripples[2] ?? 99).toBeLessThan(0.08)
    expect((dcs[1] ?? 0) > (dcs[0] ?? 0) + 0.8).toBe(true)
  })

  it('DG-14：RLC 串联谐振在 f0 = 5033 Hz 处达到唯一单峰电压放大（≤ 1%）且低 Q 档峰值下降', async () => {
    const project = loadProject('DG-14')
    const rlcWires = [
      { a: 'generator1.CH1', b: 'rlc1.RS_1' },
      { a: 'rlc1.RS_2', b: 'rlc1.LS_1' },
      { a: 'rlc1.LS_2', b: 'rlc1.CS_1' },
      { a: 'rlc1.CS_2', b: 'generator1.GND' },
      { a: 'mv1.CH1', b: 'rlc1.CS_1' },
      { a: 'mv1.GND', b: 'rlc1.CS_2' },
    ]
    const freqs = [2500, 3500, 4500, 5033, 5600, 6800, 8500]
    const ucVals: number[] = []
    let task = createTaskState(project)
    for (const [row, freq] of freqs.entries()) {
      const res = await runTran(
        {
          title: `DG-14 ${freq}Hz`,
          modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
          instruments: [
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: freq, ch1_amp: 2 }),
            defaultIns('mv1', mvMeter, { range: 'r3' }),
          ],
          wires: rlcWires,
          ground: 'generator1.GND',
          controlValues: { 'rlc1.SW_RLC_R': 51 },
          analysis: [],
        },
        45 / freq,
        { settleSec: 35 / freq, stepOverride: 1 / (freq * 60) },
      )
      if (freq === 5033) assertWiringClean(project, 'wire', res.plan)
      const w = 2 * Math.PI * freq
      const xl = w * 0.01
      const xc = 1 / (w * 1e-7)
      const uExp = (2 / (2 * Math.SQRT2)) * (xc / Math.hypot(106, xl - xc))
      const uActual = defined(res.acV.mv1, `uc_${freq}`)
      expect(relErr(uActual, uExp)).toBeLessThanOrEqual(0.015)
      ucVals.push(uActual)
      task = writeTableCell(project, task, 'resonance_curve', row, 'freq_hz', freq).state
      task = recordCurrentReading(project, task, 'resonance_curve', row, 'u_c', {
        snapshot: res.snapshot,
        row,
        advance: false,
      }).state
    }
    const maxIdx = ucVals.indexOf(Math.max(...ucVals))
    expect(freqs[maxIdx]).toBe(5033)
    expect(ucVals[maxIdx] ?? 0).toBeGreaterThan(2.05)
    expect(extractChartDataset(project, task, defined(project.charts[0], 'dg14 chart')).points).toHaveLength(7)

    // 低 Q 档 Rs = 150 Ω：谐振峰显著下降
    const lowQ = await runTran(
      {
        title: 'DG-14 lowQ',
        modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
        instruments: [
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 5033, ch1_amp: 2 }),
          defaultIns('mv1', mvMeter, { range: 'r3' }),
        ],
        wires: rlcWires,
        ground: 'generator1.GND',
        controlValues: { 'rlc1.SW_RLC_R': 150 },
        analysis: [],
      },
      40 / 5033,
      { settleSec: 30 / 5033, stepOverride: 1 / (5033 * 60) },
    )
    expect(defined(lowQ.acV.mv1, 'uc_lowq')).toBeLessThan(1.15)
  })

  it('DG-15：三相四线 Y 负载对称（I_N≈0）、不对称有中线（I_N≈0.315 A）与断中线中性点位移（≤ 1%）', async () => {
    const project = loadProject('DG-15')
    const baseWires = [
      { a: 'ins-ac-power.U', b: 'lamp3.U_IN' },
      { a: 'ins-ac-power.V', b: 'lamp3.V_IN' },
      { a: 'ins-ac-power.W', b: 'lamp3.W_IN' },
      { a: 'lamp3.A2', b: 'lamp3.N_STAR' },
      { a: 'lamp3.B2', b: 'lamp3.N_STAR' },
      { a: 'lamp3.C2', b: 'lamp3.N_STAR' },
      { a: 'lamp3.N_OUT', b: 'ins-ac-power.N' },
      { a: 'ins-ac-ammeter.I', b: 'lamp3.IN_A' },
      { a: 'ins-ac-ammeter.STAR', b: 'lamp3.IN_B' },
    ]
    const measure = (controls: Record<string, number>, vA: string, vB: string) =>
      runTran(
        {
          title: `DG-15 ${JSON.stringify(controls)}`,
          modules: [{ instanceId: 'lamp3', module: mod3ph, subckt: cir3ph }],
          instruments: [
            defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
            defaultIns('ins-ac-voltmeter', acVolt, { range: 'r500' }),
            defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
          ],
          wires: [...baseWires, { a: 'ins-ac-voltmeter.U', b: vA }, { a: 'ins-ac-voltmeter.STAR', b: vB }],
          ground: 'ins-ac-power.N',
          controlValues: controls,
          analysis: [],
        },
        0.1,
        { settleSec: 0.04 },
      )

    // 1. 对称 3-3-3 有中线
    const sym = await measure({ 'lamp3.KA': 3, 'lamp3.KB': 3, 'lamp3.KC': 3, 'lamp3.KN': 1 }, 'lamp3.A1', 'lamp3.A2')
    assertWiringClean(project, 'wire', sym.plan)
    expect(relErr(defined(sym.acV['ins-ac-voltmeter'], 'ua_sym'), 220)).toBeLessThanOrEqual(0.01)
    expect(defined(sym.acI['ins-ac-ammeter'], 'in_sym')).toBeLessThan(0.005)

    // 2. 不对称 3-2-1 有中线：I_N = (220/1210) * |3 + 2∠-120° + 1∠120°| = (220/1210) * sqrt(3) ≈ 0.3149 A
    const asym4 = await measure({ 'lamp3.KA': 3, 'lamp3.KB': 2, 'lamp3.KC': 1, 'lamp3.KN': 1 }, 'lamp3.A1', 'lamp3.A2')
    expect(relErr(defined(asym4.acV['ins-ac-voltmeter'], 'ua_asym4'), 220)).toBeLessThanOrEqual(0.01)
    expect(relErr(defined(asym4.acI['ins-ac-ammeter'], 'in_asym4'), (220 / 1210) * Math.sqrt(3))).toBeLessThanOrEqual(
      0.01,
    )

    // 3. 不对称 3-2-1 断中线（KN=0）：U_NN' = 220*sqrt(3)/6 ≈ 63.51 V，U_A ≈ 163.98 V，U_C ≈ 278.28 V
    const ctrlOpen = { 'lamp3.KA': 3, 'lamp3.KB': 2, 'lamp3.KC': 1, 'lamp3.KN': 0 }
    const uA = defined((await measure(ctrlOpen, 'lamp3.A1', 'lamp3.A2')).acV['ins-ac-voltmeter'], 'ua_open')
    const uC = defined((await measure(ctrlOpen, 'lamp3.C1', 'lamp3.C2')).acV['ins-ac-voltmeter'], 'uc_open')
    const uNn = defined((await measure(ctrlOpen, 'lamp3.N_STAR', 'lamp3.N_OUT')).acV['ins-ac-voltmeter'], 'unn_open')
    expect(relErr(uNn, (220 * Math.sqrt(3)) / 6)).toBeLessThanOrEqual(0.01)
    expect(relErr(uA, 220 * Math.sqrt(7 / 12) * Math.sqrt(12 / 12))).toBeLessThanOrEqual(0.025)
    expect(uA).toBeLessThan(170)
    expect(uC).toBeGreaterThan(272)
  })

  it('DG-16：三相三线对称负载 Y 与 △ 接法 √3 线相关系及 3 倍线电流关系（≤ 1%）', async () => {
    const project = loadProject('DG-16')

    // 1. Y 接法（相电压 127 V → 线电压 220 V）
    const yRes = await runTran(
      {
        title: 'DG-16 Y',
        modules: [{ instanceId: 'lamp3', module: mod3ph, subckt: cir3ph }],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 127 }),
          defaultIns('ins-ac-voltmeter', acVolt, { range: 'r500' }),
          defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
        ],
        wires: [
          { a: 'ins-ac-power.U', b: 'lamp3.U_IN' },
          { a: 'ins-ac-power.V', b: 'lamp3.V_IN' },
          { a: 'ins-ac-power.W', b: 'lamp3.W_IN' },
          { a: 'lamp3.A2', b: 'lamp3.B2' },
          { a: 'lamp3.B2', b: 'lamp3.C2' },
          { a: 'ins-ac-voltmeter.U', b: 'lamp3.A1' },
          { a: 'ins-ac-voltmeter.STAR', b: 'lamp3.A2' },
          { a: 'ins-ac-ammeter.I', b: 'lamp3.IA_A' },
          { a: 'ins-ac-ammeter.STAR', b: 'lamp3.IA_B' },
        ],
        ground: 'ins-ac-power.N',
        controlValues: { 'lamp3.KA': 3, 'lamp3.KB': 3, 'lamp3.KC': 3, 'lamp3.KN': 0 },
        analysis: [],
      },
      0.1,
      { settleSec: 0.04 },
    )
    assertWiringClean(project, 'star_3w', yRes.plan)
    const uPhaseY = defined(yRes.acV['ins-ac-voltmeter'], 'up_y')
    const iLineY = defined(yRes.acI['ins-ac-ammeter'], 'il_y')
    expect(relErr(uPhaseY, 127)).toBeLessThanOrEqual(0.01)
    expect(relErr(iLineY, 127 / (1210 / 3))).toBeLessThanOrEqual(0.01)

    // 2. △ 接法（同 220 V 线电压）：测线电流 I_L 与相电流 I_p
    const deltaWires = [
      { a: 'ins-ac-power.U', b: 'lamp3.U_IN' },
      { a: 'ins-ac-power.V', b: 'lamp3.V_IN' },
      { a: 'ins-ac-power.W', b: 'lamp3.W_IN' },
      { a: 'lamp3.A2', b: 'lamp3.B1' },
      { a: 'lamp3.B2', b: 'lamp3.C1' },
      { a: 'lamp3.C2', b: 'lamp3.A_VTX' },
      { a: 'ins-ac-voltmeter.U', b: 'lamp3.A1' },
      { a: 'ins-ac-voltmeter.STAR', b: 'lamp3.A2' },
    ]
    const dLine = await runTran(
      {
        title: 'DG-16 Delta IL',
        modules: [{ instanceId: 'lamp3', module: mod3ph, subckt: cir3ph }],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 127 }),
          defaultIns('ins-ac-voltmeter', acVolt, { range: 'r500' }),
          defaultIns('ins-ac-ammeter', acAmp, { range: 'r5' }),
        ],
        wires: [
          ...deltaWires,
          { a: 'ins-ac-ammeter.I', b: 'lamp3.IA_A' },
          { a: 'ins-ac-ammeter.STAR', b: 'lamp3.IA_B' },
        ],
        ground: 'ins-ac-power.N',
        controlValues: { 'lamp3.KA': 3, 'lamp3.KB': 3, 'lamp3.KC': 3, 'lamp3.KN': 0 },
        analysis: [],
      },
      0.1,
      { settleSec: 0.04 },
    )
    assertWiringClean(project, 'delta_3w', dLine.plan)
    const dPhase = await runTran(
      {
        title: 'DG-16 Delta Ip',
        modules: [{ instanceId: 'lamp3', module: mod3ph, subckt: cir3ph }],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 127 }),
          defaultIns('ins-ac-voltmeter', acVolt, { range: 'r500' }),
          defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
        ],
        wires: [
          ...deltaWires,
          { a: 'ins-ac-ammeter.I', b: 'lamp3.IPA_A' },
          { a: 'ins-ac-ammeter.STAR', b: 'lamp3.IPA_B' },
        ],
        ground: 'ins-ac-power.N',
        controlValues: { 'lamp3.KA': 3, 'lamp3.KB': 3, 'lamp3.KC': 3, 'lamp3.KN': 0 },
        analysis: [],
      },
      0.1,
      { settleSec: 0.04 },
    )
    const uPhaseD = defined(dLine.acV['ins-ac-voltmeter'], 'up_d')
    const iLineD = defined(dLine.acI['ins-ac-ammeter'], 'il_d')
    const iPhaseD = defined(dPhase.acI['ins-ac-ammeter'], 'ip_d')
    expect(relErr(uPhaseD / uPhaseY, Math.sqrt(3))).toBeLessThanOrEqual(0.01)
    expect(relErr(iLineD / iPhaseD, Math.sqrt(3))).toBeLessThanOrEqual(0.01)
    expect(relErr(iLineD / iLineY, 3)).toBeLessThanOrEqual(0.01)
  })

  it('DG-17：50 Hz 交流法测自感 L=0.500 H（≤ 1%）与直流断电尖峰（无抑制 < -90 V / 续流 > -1.5 V / RC 显著抑制）', async () => {
    const project = loadProject('DG-17')

    // 1. 交流伏安法测自感
    const acL = await runTran(
      {
        title: 'DG-17 L meas',
        modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 24 }),
          defaultIns('ins-ac-voltmeter', acVolt, { range: 'r100' }),
          defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
        ],
        wires: [
          { a: 'ins-ac-power.U', b: 'ins-ac-ammeter.I' },
          { a: 'ins-ac-ammeter.STAR', b: 'rlc1.IND_1' },
          { a: 'rlc1.IND_2', b: 'ins-ac-power.N' },
          { a: 'ins-ac-voltmeter.U', b: 'rlc1.IND_1' },
          { a: 'ins-ac-voltmeter.STAR', b: 'rlc1.IND_2' },
        ],
        ground: 'ins-ac-power.N',
        controlValues: { 'rlc1.SW_SUPP': 0, 'rlc1.SW_IND': 0 },
        analysis: [],
      },
      0.16,
      { settleSec: 0.08 },
    )
    assertWiringClean(project, 'self_inductance', acL.plan)
    const uInd = defined(acL.acV['ins-ac-voltmeter'], 'u_ind')
    const iInd = defined(acL.acI['ins-ac-ammeter'], 'i_ind')
    const zMeas = uInd / iInd
    const lMeas = Math.sqrt(Math.max(0, zMeas * zMeas - 50 * 50)) / (2 * Math.PI * 50)
    expect(relErr(lMeas, 0.5)).toBeLessThanOrEqual(0.01)

    // 2. 直流 12 V 断电尖峰对比：运行中经 ADR-009 切换 SW_IND 1 → 0
    const peaks: number[] = []
    for (const supp of [0, 1, 2]) {
      const spk = await runTran(
        {
          title: `DG-17 spike supp=${supp}`,
          modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
            defaultIns('scope1', scope, { timebase: 0.001 }),
          ],
          wires: [
            { a: 'ins-dc-power.CH1P', b: 'rlc1.IND_IN' },
            { a: 'rlc1.IND_2', b: 'ins-dc-power.CH1N' },
            { a: 'scope1.CH1', b: 'rlc1.IND_1' },
            { a: 'scope1.GND', b: 'rlc1.IND_2' },
          ],
          ground: 'ins-dc-power.CH1N',
          controlValues: { 'rlc1.SW_IND': 1, 'rlc1.SW_SUPP': supp },
          analysis: [],
        },
        0.11,
        {
          stepOverride: 0.00005,
          alterAtSec: {
            atSec: 0.04,
            changes: [{ param: 'p_rlc1_sw_ind', value: 0, targets: [{ element: 'r.xrlc1.rsw_ind', value: 500 }] }],
          },
        },
      )
      if (supp === 0) assertWiringClean(project, 'turnoff_spike', spk.plan)
      const ch = defined(spk.channels['scope:scope1:CH1'], 'spike_ch1')
      const idx = spk.times.findIndex((t) => t >= 0.045)
      let vmin = Number.POSITIVE_INFINITY
      for (let i = idx; i < ch.length; i++) if ((ch[i] ?? 0) < vmin) vmin = ch[i] ?? 0
      peaks.push(vmin)
    }
    expect(peaks[0] ?? 0).toBeLessThan(-90)
    expect(peaks[1] ?? -99).toBeGreaterThan(-1.5)
    expect(peaks[2] ?? -99).toBeGreaterThan(-70)
    expect(peaks[2] ?? 0).toBeLessThan(-40)
    expect((peaks[2] ?? -99) - (peaks[0] ?? 0)).toBeGreaterThan(35)
  })

  it('DG-18：互感顺串/反串求得 M=0.120 H、k=0.600（≤ 1%）与 220V/36V 铁芯变压器外特性', async () => {
    const project = loadProject('DG-18')

    // 1. 互感顺串 vs 反串
    const aid = await runTran(
      {
        title: 'DG-18 aid',
        modules: [{ instanceId: 'xf1', module: modXfmr, subckt: cirXfmr }],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 36 }),
          defaultIns('ins-ac-voltmeter', acVolt, { range: 'r100' }),
          defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
        ],
        wires: [
          { a: 'ins-ac-power.U', b: 'xf1.IM1_IN' },
          { a: 'xf1.IM1_OUT', b: 'xf1.M1_DOT' },
          { a: 'xf1.M1_END', b: 'xf1.M2_DOT' },
          { a: 'xf1.M2_END', b: 'ins-ac-power.N' },
          { a: 'ins-ac-ammeter.I', b: 'xf1.IM1_A' },
          { a: 'ins-ac-ammeter.STAR', b: 'xf1.IM1_B' },
          { a: 'ins-ac-voltmeter.U', b: 'xf1.M1_DOT' },
          { a: 'ins-ac-voltmeter.STAR', b: 'xf1.M2_END' },
        ],
        ground: 'ins-ac-power.N',
        controlValues: {},
        analysis: [],
      },
      0.16,
      { settleSec: 0.08 },
    )
    assertWiringClean(project, 'mutual_aid', aid.plan)

    const opp = await runTran(
      {
        title: 'DG-18 opp',
        modules: [{ instanceId: 'xf1', module: modXfmr, subckt: cirXfmr }],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 36 }),
          defaultIns('ins-ac-voltmeter', acVolt, { range: 'r100' }),
          defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
        ],
        wires: [
          { a: 'ins-ac-power.U', b: 'xf1.IM1_IN' },
          { a: 'xf1.IM1_OUT', b: 'xf1.M1_DOT' },
          { a: 'xf1.M1_END', b: 'xf1.M2_END' },
          { a: 'xf1.M2_DOT', b: 'ins-ac-power.N' },
          { a: 'ins-ac-ammeter.I', b: 'xf1.IM1_A' },
          { a: 'ins-ac-ammeter.STAR', b: 'xf1.IM1_B' },
          { a: 'ins-ac-voltmeter.U', b: 'xf1.M1_DOT' },
          { a: 'ins-ac-voltmeter.STAR', b: 'xf1.M2_DOT' },
        ],
        ground: 'ins-ac-power.N',
        controlValues: {},
        analysis: [],
      },
      0.16,
      { settleSec: 0.08 },
    )
    assertWiringClean(project, 'mutual_opp', opp.plan)

    const zAid = defined(aid.acV['ins-ac-voltmeter'], 'u_aid') / defined(aid.acI['ins-ac-ammeter'], 'i_aid')
    const zOpp = defined(opp.acV['ins-ac-voltmeter'], 'u_opp') / defined(opp.acI['ins-ac-ammeter'], 'i_opp')
    const lAid = Math.sqrt(Math.max(0, zAid * zAid - 40 * 40)) / (2 * Math.PI * 50)
    const lOpp = Math.sqrt(Math.max(0, zOpp * zOpp - 40 * 40)) / (2 * Math.PI * 50)
    const mMeas = (lAid - lOpp) / 4
    expect(relErr(mMeas, 0.12)).toBeLessThanOrEqual(0.01)
    expect(relErr(mMeas / 0.2, 0.6)).toBeLessThanOrEqual(0.01)

    // 2. 铁芯变压器 220 V / 36 V 变比与带载外特性（空载→25 Ω 副边电压平缓下降）
    const uSecs: number[] = []
    for (const loadIdx of [0, 1, 2, 3]) {
      const tx = await runTran(
        {
          title: `DG-18 tx load=${loadIdx}`,
          modules: [{ instanceId: 'xf1', module: modXfmr, subckt: cirXfmr }],
          instruments: [
            defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
            defaultIns('ins-ac-voltmeter', acVolt, { range: 'r100' }),
            defaultIns('ins-ac-ammeter', acAmp, { range: 'r5' }),
          ],
          wires: [
            { a: 'ins-ac-power.U', b: 'xf1.TP_1' },
            { a: 'ins-ac-power.N', b: 'xf1.TP_2' },
            { a: 'xf1.TS_1', b: 'xf1.IM1_IN' },
            { a: 'xf1.IM1_OUT', b: 'xf1.TL_1' },
            { a: 'xf1.TS_2', b: 'xf1.TL_2' },
            { a: 'ins-ac-ammeter.I', b: 'xf1.IM1_A' },
            { a: 'ins-ac-ammeter.STAR', b: 'xf1.IM1_B' },
            { a: 'ins-ac-voltmeter.U', b: 'xf1.TS_1' },
            { a: 'ins-ac-voltmeter.STAR', b: 'xf1.TS_2' },
          ],
          ground: 'ins-ac-power.N',
          controlValues: { 'xf1.SW_TLOAD': loadIdx },
          analysis: [],
        },
        0.14,
        { settleSec: 0.06 },
      )
      if (loadIdx === 0) assertWiringClean(project, 'transformer_load', tx.plan)
      uSecs.push(defined(tx.acV['ins-ac-voltmeter'], `usec_${loadIdx}`))
    }
    expect(relErr(uSecs[0] ?? 0, 35.85)).toBeLessThanOrEqual(0.015)
    expect((uSecs[0] ?? 0) > (uSecs[1] ?? 0)).toBe(true)
    expect((uSecs[1] ?? 0) > (uSecs[2] ?? 0)).toBe(true)
    expect((uSecs[2] ?? 0) > (uSecs[3] ?? 0)).toBe(true)
  })

  it('DG-19：正式一阶 RC（1/5/10 kΩ × 0.1 µF）与 RL（10 mH / 106 Ω）时间常数 τ 误差 ≤ 1%', async () => {
    const project = loadProject('DG-19')
    expect(project.validation).toBeUndefined()

    const measureRiseTau = (times: number[], vIn: number[], vOut: number[], halfPeriodSec: number) => {
      // 找到首个位于稳态周期内且后续有完整高电平的上升沿，用斜坡完全结束后的 20%→80% 指数段精确提取 τ = (t80 - t20) / ln(4)
      const tEnd = times[times.length - 1] ?? 0
      let edgeIdx = -1
      for (let i = 1; i < times.length - 5; i++) {
        const t = times[i] ?? 0
        if (t < halfPeriodSec || t > tEnd - halfPeriodSec * 0.9) continue
        if ((vIn[i - 1] ?? 0) < 2.0 && (vIn[i] ?? 0) >= 2.0) {
          edgeIdx = i
          break
        }
      }
      expect(edgeIdx).toBeGreaterThan(0)
      const tEdge = times[edgeIdx] ?? 0
      const vLow = vOut[Math.max(0, edgeIdx - 3)] ?? 0
      let vHigh = vLow
      for (let i = edgeIdx; i < times.length && (times[i] ?? 0) < tEdge + halfPeriodSec * 0.9; i++) {
        if ((vOut[i] ?? 0) > vHigh) vHigh = vOut[i] ?? 0
      }
      const crossAt = (level: number) => {
        for (let i = edgeIdx; i < times.length; i++) {
          const y0 = vOut[i - 1] ?? 0
          const y1 = vOut[i] ?? 0
          if (y1 >= level) {
            const frac = y1 === y0 ? 0 : (level - y0) / (y1 - y0)
            return (times[i - 1] ?? 0) + frac * ((times[i] ?? 0) - (times[i - 1] ?? 0))
          }
        }
        throw new Error(`Did not reach target level ${level}`)
      }
      const t20 = crossAt(vLow + (vHigh - vLow) * 0.2)
      const t80 = crossAt(vLow + (vHigh - vLow) * 0.8)
      return (t80 - t20) / Math.log(4)
    }

    for (const rTau of [1000, 5000, 10000]) {
      const res = await runTran(
        {
          title: `DG-19 RC ${rTau}`,
          modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
          instruments: [
            defaultIns('generator1', funcGen, { ch1_wave: 1, ch1_freq: 50, ch1_amp: 4, ch1_offset: 2 }),
            defaultIns('scope1', scope, { timebase: 0.001 }),
          ],
          wires: [
            { a: 'generator1.CH1', b: 'rlc1.TR_1' },
            { a: 'rlc1.TR_2', b: 'rlc1.TC_1' },
            { a: 'rlc1.TC_2', b: 'generator1.GND' },
            { a: 'scope1.CH1', b: 'rlc1.TR_1' },
            { a: 'scope1.CH2', b: 'rlc1.TC_1' },
            { a: 'scope1.GND', b: 'rlc1.TC_2' },
          ],
          ground: 'generator1.GND',
          controlValues: { 'rlc1.SW_TAU_R': rTau, 'rlc1.SW_TAU_C': 1 },
          analysis: [],
        },
        0.032,
        { stepOverride: 0.000002 },
      )
      if (rTau === 1000) assertWiringClean(project, 'rc_transient', res.plan)
      const tauActual = measureRiseTau(
        res.times,
        defined(res.channels['scope:scope1:CH1'], 'ch1'),
        defined(res.channels['scope:scope1:CH2'], 'ch2'),
        0.01,
      )
      // 计入信号源 50 Ω 内阻、示波器 CH2 1 MΩ 并联输入阻抗与 0.1 µF 电容 ESR
      const rThevenin = ((rTau + 50) * 1e6) / (rTau + 50 + 1e6) + 0.9
      const tauTheory = rThevenin * 1e-7
      expect(relErr(tauActual, tauTheory)).toBeLessThanOrEqual(0.01)
    }

    // RL 暂态：L=10 mH, R_total = 50 + 5 + 51 = 106 Ω → τ = 94.34 µs
    const rlRes = await runTran(
      {
        title: 'DG-19 RL',
        modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
        instruments: [
          defaultIns('generator1', funcGen, { ch1_wave: 1, ch1_freq: 500, ch1_amp: 4, ch1_offset: 2 }),
          defaultIns('scope1', scope, { timebase: 0.0002 }),
        ],
        wires: [
          { a: 'generator1.CH1', b: 'rlc1.LS_1' },
          { a: 'rlc1.LS_2', b: 'rlc1.RS_1' },
          { a: 'rlc1.RS_2', b: 'generator1.GND' },
          { a: 'scope1.CH1', b: 'rlc1.LS_1' },
          { a: 'scope1.CH2', b: 'rlc1.RS_1' },
          { a: 'scope1.GND', b: 'rlc1.RS_2' },
        ],
        ground: 'generator1.GND',
        controlValues: { 'rlc1.SW_RLC_R': 51 },
        analysis: [],
      },
      0.0045,
      { stepOverride: 0.000002 },
    )
    assertWiringClean(project, 'rl_transient', rlRes.plan)
    const tauRl = measureRiseTau(
      rlRes.times,
      defined(rlRes.channels['scope:scope1:CH1'], 'rl_ch1'),
      defined(rlRes.channels['scope:scope1:CH2'], 'rl_ch2'),
      0.001,
    )
    expect(relErr(tauRl, 0.01 / 106)).toBeLessThanOrEqual(0.01)
  })

  it('DG-20：RC 微分电路（方波→正负尖脉冲 ≈ 7.6 Vpp）与 RC 积分电路（方波→三角波 ≈ 0.495 Vpp）', async () => {
    const project = loadProject('DG-20')

    // 1. 微分电路：Rt=1 kΩ, Ct=0.01 µF (τ=10.5 µs), 500 Hz 4 Vpp 对称方波
    const diff = await runTran(
      {
        title: 'DG-20 diff',
        modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
        instruments: [
          defaultIns('generator1', funcGen, { ch1_wave: 1, ch1_freq: 500, ch1_amp: 4, ch1_offset: 0 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: [
          { a: 'generator1.CH1', b: 'rlc1.TC_1' },
          { a: 'rlc1.TC_2', b: 'rlc1.TR_1' },
          { a: 'rlc1.TR_2', b: 'generator1.GND' },
          { a: 'scope1.CH1', b: 'rlc1.TC_1' },
          { a: 'scope1.CH2', b: 'rlc1.TR_1' },
          { a: 'scope1.GND', b: 'rlc1.TR_2' },
        ],
        ground: 'generator1.GND',
        controlValues: { 'rlc1.SW_TAU_R': 1000, 'rlc1.SW_TAU_C': 0 },
        analysis: [],
      },
      0.006,
      { stepOverride: 0.000002 },
    )
    assertWiringClean(project, 'differentiator', diff.plan)
    const chDiff = defined(diff.channels['scope:scope1:CH2'], 'diff_ch2')
    const idxD = diff.times.findIndex((t) => t >= 0.002)
    let dMin = Number.POSITIVE_INFINITY
    let dMax = Number.NEGATIVE_INFINITY
    for (let i = idxD; i < chDiff.length; i++) {
      const v = chDiff[i] ?? 0
      if (v < dMin) dMin = v
      if (v > dMax) dMax = v
    }
    // 有限边沿斜坡 tr = 2 µs（signal.ts EDGE=1e-3）作用下解析峰值 = (4*1000/1050)*(10.5/2)*(1-exp(-2/10.5)) ≈ 3.468 V
    const vPeakTheory = ((4 * 1000) / 1050) * (10.5 / 2) * (1 - Math.exp(-2 / 10.5))
    expect(relErr(dMax, vPeakTheory)).toBeLessThanOrEqual(0.02)
    expect(relErr(-dMin, vPeakTheory)).toBeLessThanOrEqual(0.02)
    expect(dMax - dMin).toBeGreaterThan(6.7)

    // 2. 积分电路：Rt=10 kΩ, Ct=0.1 µF (τ=1.005 ms), 2 kHz (tp=0.25 ms) 4 Vpp 对称方波 → ΔUc = 4*tanh(0.25 / (2*1.005)) ≈ 0.495 V
    const integ = await runTran(
      {
        title: 'DG-20 int',
        modules: [{ instanceId: 'rlc1', module: modRlc, subckt: cirRlc }],
        instruments: [
          defaultIns('generator1', funcGen, { ch1_wave: 1, ch1_freq: 2000, ch1_amp: 4, ch1_offset: 0 }),
          defaultIns('scope1', scope, { timebase: 0.0002 }),
        ],
        wires: [
          { a: 'generator1.CH1', b: 'rlc1.TR_1' },
          { a: 'rlc1.TR_2', b: 'rlc1.TC_1' },
          { a: 'rlc1.TC_2', b: 'generator1.GND' },
          { a: 'scope1.CH1', b: 'rlc1.TR_1' },
          { a: 'scope1.CH2', b: 'rlc1.TC_1' },
          { a: 'scope1.GND', b: 'rlc1.TC_2' },
        ],
        ground: 'generator1.GND',
        controlValues: { 'rlc1.SW_TAU_R': 10000, 'rlc1.SW_TAU_C': 1 },
        analysis: [],
      },
      0.012,
      { stepOverride: 0.000005 },
    )
    assertWiringClean(project, 'integrator', integ.plan)
    const chInt = defined(integ.channels['scope:scope1:CH2'], 'int_ch2')
    const idxI = integ.times.findIndex((t) => t >= 0.008)
    let iMin = Number.POSITIVE_INFINITY
    let iMax = Number.NEGATIVE_INFINITY
    for (let i = idxI; i < chInt.length; i++) {
      const v = chInt[i] ?? 0
      if (v < iMin) iMin = v
      if (v > iMax) iMax = v
    }
    const vppTheory = 4 * Math.tanh(0.00025 / (2 * 0.001005))
    expect(relErr(iMax - iMin, vppTheory)).toBeLessThanOrEqual(0.02)
  })
})
