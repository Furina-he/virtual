import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import { getInstrumentDefaults, readInstrument } from '../../src/domain/instruments/index.ts'
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

// M2 B3（MD-01~09，不含已有独立金标准的 MD-03 与 MD-07）真实 ngspice 全流程金标准验证。

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const loadIns = (id: string) => Instrument.parse(loadJson(`content/instruments/${id}/instrument.json`))
const loadMod = (id: string) => Module.parse(loadJson(`content/modules/${id}/module.json`))
const loadProject = (id: string) => Project.parse(loadJson(`content/projects/${id}/project.json`))

const LIBRARIES = {
  'bjt.lib': readFileSync('content/models/spice/bjt.lib', 'utf8'),
  'diodes.lib': readFileSync('content/models/spice/diodes.lib', 'utf8'),
  'fet.lib': readFileSync('content/models/spice/fet.lib', 'utf8'),
  'regulators.lib': readFileSync('content/models/spice/regulators.lib', 'utf8'),
  'sensors.lib': readFileSync('content/models/spice/sensors.lib', 'utf8'),
}

const loadModCir = (id: string) =>
  expandLocalLibraries(readFileSync(`content/modules/${id}/module.cir`, 'utf8'), LIBRARIES)

const modBase = loadMod('mod-analog-base')
const cirBase = loadModCir('mod-analog-base')
const modFb = loadMod('mod-analog-fb')
const cirFb = loadModCir('mod-analog-fb')
const modHa = loadMod('mod-app-hearing-aid')
const cirHa = loadModCir('mod-app-hearing-aid')
const modChg = loadMod('mod-app-charger')
const cirChg = loadModCir('mod-app-charger')
const modReg = loadMod('mod-power-reg')
const cirReg = loadModCir('mod-power-reg')

const dcPower = loadIns('ins-dc-power')
const acPower = loadIns('ins-ac-power')
const dcVolt = loadIns('ins-dc-voltmeter')
const dcAmp = loadIns('ins-dc-ammeter')
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
  const plan = buildMeasurementPlan(input, true, 'b3-op')
  const loadCmd = { ...plan.command, analysis: { kind: 'op' as const } }
  events.length = 0
  session.handle(loadCmd)
  let loaded = false
  const deadline = Date.now() + 15_000
  const logs: string[] = []
  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'log') logs.push(ev.line)
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})\n${logs.slice(-15).join('\n')}`)
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
  throw new Error(`Timed out waiting for .op result: ${input.title}`)
}

async function runTran(
  input: AssembleInput,
  durationSec: number,
  options: { settleSec?: number; stepOverride?: number } = {},
) {
  const plan = buildMeasurementPlan(input, true, 'b3-tran')
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
  const deadline = Date.now() + 25_000

  const logs: string[] = []
  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'log') logs.push(ev.line)
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})\n${logs.slice(-15).join('\n')}`)
      if (ev.type === 'loaded') {
        loaded = true
        session.handle({ type: 'run' })
      }
      if (ev.type === 'chunk' && loaded) {
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
            return { min: lo, max: hi, vpp: hi - lo, mean }
          }
          return { plan, times, channels, startIdx, endIdx, stats }
        }
      }
    }
  }
  await pauseAndIdle()
  throw new Error(`Timed out running transient simulation: ${input.title}`)
}

describe('M2 B3（MD-01~09）真实 ngspice 金标准验证', () => {
  it('MD-01：万用表二极管档正反向判别、2CW51 稳压特性与 1N4148 双向限幅', async () => {
    const project = loadProject('MD-01')

    // 1. 无源万用表二极管档正反测试
    const testDiode = async (a: string, k: string, expectedMin: number, expectedMax: number) => {
      const fwd = await solveOp({
        title: `MD-01 fwd ${a}`,
        modules: [{ instanceId: 'ab1', module: modBase, subckt: cirBase }],
        instruments: [defaultIns('meter1', multimeter, { range: 'diode' })],
        wires: [
          { a: 'meter1.VOHM', b: `ab1.${a}` },
          { a: 'meter1.COM', b: `ab1.${k}` },
        ],
        ground: 'meter1.COM',
        controlValues: {},
        analysis: [],
      })
      const rFwd = defined(fwd.readings.meter1, 'fwd reading')
      expect(rFwd.status).toBe('ok')
      expect(rFwd.value ?? 0).toBeGreaterThan(expectedMin)
      expect(rFwd.value ?? 9).toBeLessThan(expectedMax)

      const rev = await solveOp({
        title: `MD-01 rev ${a}`,
        modules: [{ instanceId: 'ab1', module: modBase, subckt: cirBase }],
        instruments: [defaultIns('meter1', multimeter, { range: 'diode' })],
        wires: [
          { a: 'meter1.VOHM', b: `ab1.${k}` },
          { a: 'meter1.COM', b: `ab1.${a}` },
        ],
        ground: 'meter1.COM',
        controlValues: {},
        analysis: [],
      })
      expect(rev.readings.meter1?.status).toBe('overload')
    }
    await testDiode('D4007_A', 'D4007_K', 0.5, 0.65)
    await testDiode('D4148_A', 'D4148_K', 0.54, 0.66)
    await testDiode('DZ_A', 'DZ_K', 0.45, 0.62)
    await testDiode('LED_A', 'LED_K', 1.65, 1.9)

    // 2. 2CW51 稳压电路（CH1 = 6, 9, 12 V）
    let task = { ...createTaskState(project), completedSteps: ['prepare', 'diode_check'] }
    const uzVals: number[] = []
    for (const [row, uin] of [6, 9, 12].entries()) {
      const res = await solveOp({
        title: `MD-01 zener ${uin}V`,
        modules: [{ instanceId: 'ab1', module: modBase, subckt: cirBase }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: uin }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'ab1.R470_1' },
          { a: 'ab1.R470_2', b: 'ab1.DZ_K' },
          { a: 'ab1.DZ_A', b: 'ins-dc-power.CH1N' },
          { a: 'ins-dc-voltmeter.POS', b: 'ab1.DZ_K' },
          { a: 'ins-dc-voltmeter.NEG', b: 'ab1.DZ_A' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      })
      if (row === 0) assertWiringClean(project, 'zener_reg', res.plan)
      const uz = defined(res.rawV['ins-dc-voltmeter'], 'uz')
      expect(uz).toBeGreaterThan(3.2)
      expect(uz).toBeLessThan(3.6)
      uzVals.push(uz)
      task = writeTableCell(project, task, 'zener_reg', row, 'u_in', uin).state
      const rec = recordCurrentReading(project, task, 'zener_reg', row, 'u_z', {
        snapshot: res.snapshot,
        row,
        advance: false,
      })
      expect(rec.ok, rec.message).toBe(true)
      task = rec.state
    }
    // 输入翻倍（6→12 V），稳压输出变动 < 0.35 V
    expect((uzVals[2] ?? 0) - (uzVals[0] ?? 0)).toBeLessThan(0.35)
    expect(extractChartDataset(project, task, defined(project.charts[0], 'zener chart')).points).toHaveLength(3)

    // 3. 1N4148 双向限幅电路（4 Vpp 正弦 → ~1.3 Vpp 对称限幅）
    const clip = await runTran(
      {
        title: 'MD-01 clipper',
        modules: [{ instanceId: 'ab1', module: modBase, subckt: cirBase }],
        instruments: [
          defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: 1000, ch1_amp: 4 }),
          defaultIns('scope1', scope, { timebase: 0.0005 }),
        ],
        wires: [
          { a: 'generator1.CH1', b: 'ab1.R470_1' },
          { a: 'ab1.R470_2', b: 'ab1.CLIP_A' },
          { a: 'ab1.CLIP_B', b: 'generator1.GND' },
          { a: 'scope1.CH1', b: 'ab1.R470_1' },
          { a: 'scope1.CH2', b: 'ab1.CLIP_A' },
          { a: 'scope1.GND', b: 'ab1.CLIP_B' },
        ],
        ground: 'generator1.GND',
        controlValues: {},
        analysis: [],
      },
      0.005,
      { settleSec: 0.002, stepOverride: 0.00001 },
    )
    assertWiringClean(project, 'clipper', clip.plan)
    const chIn = clip.stats('scope:scope1:CH1')
    const chOut = clip.stats('scope:scope1:CH2')
    expect(chIn.vpp).toBeGreaterThan(3.4)
    expect(chOut.vpp).toBeGreaterThan(1.1)
    expect(chOut.vpp).toBeLessThan(1.55)
    expect(Math.abs(chOut.max + chOut.min)).toBeLessThan(0.05)
  })

  it('MD-02：S9013 输出特性（饱和/放大区）、3DJ6 平方律夹断与 2N7000 开启特性', async () => {
    const project = loadProject('MD-02')

    // 1. BJT S9013
    const icCurve: number[] = []
    let task = { ...createTaskState(project), completedSteps: ['prepare'] }
    for (const [row, vceSet] of [0.06, 1, 5, 10].entries()) {
      const res = await solveOp({
        title: `MD-02 bjt vce=${vceSet}`,
        modules: [{ instanceId: 'ab1', module: modBase, subckt: cirBase }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 2.7, ch2_v: vceSet }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r20m' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'ab1.RB_1' },
          { a: 'ab1.RB_2', b: 'ab1.BJT_B' },
          { a: 'ins-dc-power.CH2P', b: 'ins-dc-ammeter.POS' },
          { a: 'ins-dc-ammeter.NEG', b: 'ab1.BJT_C' },
          { a: 'ab1.BJT_E', b: 'ins-dc-power.CH1N' },
          { a: 'ins-dc-power.CH1N', b: 'ins-dc-power.CH2N' },
          { a: 'ins-dc-voltmeter.POS', b: 'ab1.BJT_C' },
          { a: 'ins-dc-voltmeter.NEG', b: 'ab1.BJT_E' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: {},
        analysis: [],
      })
      if (row === 2) assertWiringClean(project, 'bjt_out', res.plan)
      icCurve.push(defined(res.rawI['ins-dc-ammeter'], 'ic'))
      task = recordCurrentReading(project, task, 'bjt_output', row, 'u_ce', {
        snapshot: res.snapshot,
        row,
        advance: false,
      }).state
      task = recordCurrentReading(project, task, 'bjt_output', row, 'i_c', {
        snapshot: res.snapshot,
        row,
        advance: false,
      }).state
    }
    expect((icCurve[2] ?? 0) > (icCurve[0] ?? 0) * 1.4).toBe(true)
    expect(icCurve[2] ?? 0).toBeGreaterThan(0.0028)
    expect(icCurve[2] ?? 1).toBeLessThan(0.0042)
    expect((icCurve[3] ?? 0) > (icCurve[2] ?? 0)).toBe(true)
    expect(extractChartDataset(project, task, defined(project.charts[0], 'bjt chart')).points).toHaveLength(4)

    // 2. JFET 3DJ6 负栅压转移特性
    const jIds: number[] = []
    for (const vch1 of [0, 1, 2, 3.2]) {
      const res = await solveOp({
        title: `MD-02 jfet vgs=-${vch1}`,
        modules: [{ instanceId: 'ab1', module: modBase, subckt: cirBase }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: vch1, ch2_v: 10 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r20m' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1N', b: 'ab1.JFET_G' },
          { a: 'ins-dc-power.CH1P', b: 'ab1.JFET_S' },
          { a: 'ab1.JFET_S', b: 'ins-dc-power.CH2N' },
          { a: 'ins-dc-power.CH2P', b: 'ins-dc-ammeter.POS' },
          { a: 'ins-dc-ammeter.NEG', b: 'ab1.JFET_D' },
          { a: 'ins-dc-voltmeter.POS', b: 'ab1.JFET_D' },
          { a: 'ins-dc-voltmeter.NEG', b: 'ab1.JFET_S' },
        ],
        ground: 'ab1.JFET_S',
        controlValues: {},
        analysis: [],
      })
      if (vch1 === 0) assertWiringClean(project, 'jfet_out', res.plan)
      jIds.push(defined(res.rawI['ins-dc-ammeter'], 'id_j'))
    }
    expect(jIds[0] ?? 0).toBeGreaterThan(0.0055)
    expect((jIds[1] ?? 0) < (jIds[0] ?? 0) * 0.55).toBe(true)
    expect((jIds[2] ?? 0) < (jIds[1] ?? 0) * 0.35).toBe(true)
    expect(jIds[3] ?? 1).toBeLessThan(1e-5)

    // 3. MOSFET 2N7000 正栅压转移特性
    const mIds: number[] = []
    for (const vgs of [1.5, 2.5, 3.0]) {
      const res = await solveOp({
        title: `MD-02 mos vgs=${vgs}`,
        modules: [{ instanceId: 'ab1', module: modBase, subckt: cirBase }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: vgs, ch2_v: 10 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r200m' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'ab1.MOS_G' },
          { a: 'ins-dc-power.CH2P', b: 'ins-dc-ammeter.POS' },
          { a: 'ins-dc-ammeter.NEG', b: 'ab1.MOS_D' },
          { a: 'ab1.MOS_S', b: 'ins-dc-power.CH1N' },
          { a: 'ins-dc-power.CH1N', b: 'ins-dc-power.CH2N' },
          { a: 'ins-dc-voltmeter.POS', b: 'ab1.MOS_D' },
          { a: 'ins-dc-voltmeter.NEG', b: 'ab1.MOS_S' },
        ],
        ground: 'ab1.MOS_S',
        controlValues: {},
        analysis: [],
      })
      if (vgs === 2.5) assertWiringClean(project, 'mos_out', res.plan)
      mIds.push(defined(res.rawI['ins-dc-ammeter'], 'id_m'))
    }
    expect(mIds[0] ?? 1).toBeLessThan(1e-5)
    expect(mIds[1] ?? 0).toBeGreaterThan(0.02)
    expect(mIds[2] ?? 0).toBeGreaterThan(0.08)
  })

  it('MD-04：两级阻容放大开环增益 > 110、电压串联负反馈深度降低增益并显著展宽通频带', async () => {
    const project = loadProject('MD-04')
    const baseWires = [
      { a: 'ins-dc-power.CH1P', b: 'fb1.FB_VCC' },
      { a: 'ins-dc-power.CH1N', b: 'fb1.FB_GND1' },
      { a: 'generator1.CH1', b: 'fb1.FB_US' },
      { a: 'generator1.GND', b: 'fb1.FB_GND2' },
      { a: 'scope1.CH1', b: 'fb1.FB_UI' },
      { a: 'scope1.CH2', b: 'fb1.FB_UO' },
      { a: 'scope1.GND', b: 'fb1.FB_GND2' },
    ]
    const measureGain = async (swFb: number, freq: number, amp: number) => {
      const res = await runTran(
        {
          title: `MD-04 fb=${swFb} f=${freq}`,
          modules: [{ instanceId: 'fb1', module: modFb, subckt: cirFb }],
          instruments: [
            defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
            defaultIns('generator1', funcGen, { ch1_wave: 0, ch1_freq: freq, ch1_amp: amp }),
            defaultIns('scope1', scope, { timebase: 0.0005 }),
          ],
          wires: baseWires,
          ground: 'ins-dc-power.CH1N',
          controlValues: { 'fb1.SW_FB': swFb, 'fb1.SW_RL': 1 },
          analysis: [],
        },
        12 / freq,
        { settleSec: 6 / freq, stepOverride: 1 / (freq * 40) },
      )
      return { res, gain: res.stats('scope:scope1:CH2').vpp / res.stats('scope:scope1:CH1').vpp }
    }

    const open1k = await measureGain(0, 1000, 0.03)
    assertWiringClean(project, 'wire', open1k.res.plan)
    const deep1k = await measureGain(1, 1000, 0.1)
    const shallow1k = await measureGain(2, 1000, 0.06)

    expect(open1k.gain).toBeGreaterThan(110)
    expect(shallow1k.gain).toBeGreaterThan(42)
    expect(shallow1k.gain).toBeLessThan(68)
    expect(deep1k.gain).toBeGreaterThan(18)
    expect(deep1k.gain).toBeLessThan(26)

    // 带宽展宽：50 kHz 时开环明显滚降，深负反馈仍保持平坦
    const open50k = await measureGain(0, 50000, 0.03)
    const deep50k = await measureGain(1, 50000, 0.1)
    expect(open50k.gain / open1k.gain).toBeLessThan(0.75)
    expect(deep50k.gain / deep1k.gain).toBeGreaterThan(0.88)
  })

  it('MD-05：助听器 +5 V 静态偏置中点正常、声压激励与音量电位器单调线性调控 32 Ω 耳机音频输出', async () => {
    const project = loadProject('MD-05')
    const baseWires = [
      { a: 'ins-dc-power.V5P', b: 'ha1.HA_VCC' },
      { a: 'ins-dc-power.V5N', b: 'ha1.HA_GND1' },
      { a: 'scope1.CH1', b: 'ha1.HA_Q1C' },
      { a: 'scope1.CH2', b: 'ha1.HA_SPK_P' },
      { a: 'scope1.GND', b: 'ha1.HA_GND2' },
    ]
    // 1. 静音静态直流工作点检查
    const dcRes = await solveOp({
      title: 'MD-05 static',
      modules: [{ instanceId: 'ha1', module: modHa, subckt: cirHa }],
      instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' })],
      wires: [
        { a: 'ins-dc-power.V5P', b: 'ha1.HA_VCC' },
        { a: 'ins-dc-power.V5N', b: 'ha1.HA_GND1' },
        { a: 'ins-dc-voltmeter.POS', b: 'ha1.HA_MIC' },
        { a: 'ins-dc-voltmeter.NEG', b: 'ha1.HA_GND1' },
      ],
      ground: 'ins-dc-power.V5N',
      controlValues: { 'ha1.MIC_SPL': 0, 'ha1.VOL_POT': 60 },
      analysis: [],
    })
    expect(dcRes.rawV['ins-dc-voltmeter'] ?? 0).toBeGreaterThan(2.2)
    expect(dcRes.rawV['ins-dc-voltmeter'] ?? 9).toBeLessThan(2.8)

    // 2. 正常语音下音量电位器 20% / 60% / 100% 单调调节
    const vpps: number[] = []
    for (const vol of [20, 60, 100]) {
      const tr = await runTran(
        {
          title: `MD-05 vol=${vol}`,
          modules: [{ instanceId: 'ha1', module: modHa, subckt: cirHa }],
          instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.0005 })],
          wires: baseWires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'ha1.MIC_SPL': 2, 'ha1.VOL_POT': vol },
          analysis: [],
        },
        0.014,
        { settleSec: 0.008, stepOverride: 0.000025 },
      )
      if (vol === 60) assertWiringClean(project, 'wire', tr.plan)
      vpps.push(tr.stats('scope:scope1:CH2').vpp)
    }
    expect(vpps[0] ?? 0).toBeGreaterThan(0.05)
    expect((vpps[1] ?? 0) > (vpps[0] ?? 0) * 1.8).toBe(true)
    expect((vpps[2] ?? 0) > (vpps[1] ?? 0) * 1.25).toBe(true)

    // 静音档输出归零
    const mute = await runTran(
      {
        title: 'MD-05 mute',
        modules: [{ instanceId: 'ha1', module: modHa, subckt: cirHa }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.0005 })],
        wires: baseWires,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'ha1.MIC_SPL': 0, 'ha1.VOL_POT': 100 },
        analysis: [],
      },
      0.01,
      { settleSec: 0.005, stepOverride: 0.00005 },
    )
    expect(mute.stats('scope:scope1:CH2').vpp).toBeLessThan(0.01)
  })

  it('MD-06：MOSFET 恒流充电器三档恒流（50/100/200 mA）、跨电池电压恒流稳定度 < 3% 与瞬态充电爬升', async () => {
    const project = loadProject('MD-06')
    const wires = [
      { a: 'ins-dc-power.CH1P', b: 'chg1.CHG_VIN' },
      { a: 'chg1.BAT_N', b: 'chg1.MOS_D' },
      { a: 'ins-dc-power.CH1N', b: 'chg1.CHG_GND1' },
      { a: 'ins-dc-ammeter.POS', b: 'chg1.ICHG_A' },
      { a: 'ins-dc-ammeter.NEG', b: 'chg1.ICHG_B' },
      { a: 'ins-dc-voltmeter.POS', b: 'chg1.BAT_P' },
      { a: 'ins-dc-voltmeter.NEG', b: 'chg1.BAT_N' },
    ]
    // 1. 三档恒流标定
    const currents: number[] = []
    for (const iSet of [0, 1, 2]) {
      const res = await solveOp({
        title: `MD-06 iSet=${iSet}`,
        modules: [{ instanceId: 'chg1', module: modChg, subckt: cirChg }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r2000m' }),
        ],
        wires,
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'chg1.I_SET': iSet, 'chg1.BAT_INIT': 3.2 },
        analysis: [],
      })
      if (iSet === 1) assertWiringClean(project, 'wire', res.plan)
      currents.push(defined(res.rawI['ins-dc-ammeter'], `ichg_${iSet}`))
    }
    expect(currents[0] ?? 0).toBeGreaterThan(0.044)
    expect(currents[0] ?? 1).toBeLessThan(0.056)
    expect(currents[1] ?? 0).toBeGreaterThan(0.09)
    expect(currents[1] ?? 1).toBeLessThan(0.112)
    expect(currents[2] ?? 0).toBeGreaterThan(0.18)
    expect(currents[2] ?? 1).toBeLessThan(0.225)

    // 2. 跨不同电池电压（3.2 V → 3.7 V → 4.1 V）恒流变动 < 3%
    const regI: number[] = []
    for (const vInit of [3.2, 3.7, 4.1]) {
      const res = await solveOp({
        title: `MD-06 bat=${vInit}`,
        modules: [{ instanceId: 'chg1', module: modChg, subckt: cirChg }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r2000m' }),
        ],
        wires: wires.slice(0, 5),
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'chg1.I_SET': 1, 'chg1.BAT_INIT': vInit },
        analysis: [],
      })
      regI.push(defined(res.rawI['ins-dc-ammeter'], `reg_${vInit}`))
    }
    const spread = (Math.max(...regI) - Math.min(...regI)) / (regI[0] ?? 1)
    expect(spread).toBeLessThan(0.03)

    // 3. 瞬态恒流充电：0.25 s 内锂电池电压由 ~3.22 V 单调上升 > 0.4 V
    const tr = await runTran(
      {
        title: 'MD-06 tran charge',
        modules: [{ instanceId: 'chg1', module: modChg, subckt: cirChg }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('ins-dc-ammeter', dcAmp, { range: 'r2000m' }),
        ],
        wires,
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'chg1.I_SET': 1, 'chg1.BAT_INIT': 3.2 },
        analysis: [],
      },
      0.25,
      { settleSec: 0, stepOverride: 0.0005 },
    )
    const vProbe = defined(tr.plan.meters.find((m) => m.instanceId === 'ins-dc-voltmeter')?.voltageProbe, 'bat probe')
    const arr = defined(tr.channels[vProbe], 'bat wave')
    expect((arr[arr.length - 1] ?? 0) - (arr[0] ?? 0)).toBeGreaterThan(0.4)
  })

  it('MD-08：半波/桥式整流、四档电容滤波纹波单调压缩与 LM317 线性调压（≤ 1.5%）及 >40 dB 纹波抑制', async () => {
    const project = loadProject('MD-08')
    const baseWires = [
      { a: 'ins-ac-power.U', b: 'ab1.AC_P1' },
      { a: 'ins-ac-power.N', b: 'ab1.AC_P2' },
      { a: 'ab1.AC_S1', b: 'reg1.AC_1' },
      { a: 'ab1.AC_CT', b: 'reg1.AC_2' },
      { a: 'reg1.RECT_N', b: 'reg1.REG_GND' },
      { a: 'reg1.RECT_P', b: 'reg1.REG317_IN' },
      { a: 'reg1.REG317_OUT', b: 'reg1.LOAD_IN' },
      { a: 'scope1.CH1', b: 'reg1.RECT_P' },
      { a: 'scope1.CH2', b: 'reg1.REG317_OUT' },
      { a: 'scope1.GND', b: 'reg1.REG_GND2' },
    ]
    const ripples: number[] = []
    const rectMeans: number[] = []
    for (const cIdx of [0, 1, 2, 3]) {
      const tr = await runTran(
        {
          title: `MD-08 c=${cIdx}`,
          modules: [
            { instanceId: 'ab1', module: modBase, subckt: cirBase },
            { instanceId: 'reg1', module: modReg, subckt: cirReg },
          ],
          instruments: [
            defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
            defaultIns('scope1', scope, { timebase: 0.005 }),
          ],
          wires: baseWires,
          ground: 'reg1.REG_GND',
          controlValues: { 'reg1.SW_CFILT': cIdx, 'reg1.R317_ADJ': 1200, 'reg1.SW_RLOAD': 1 },
          analysis: [],
        },
        0.16,
        { settleSec: 0.1, stepOverride: 0.0002 },
      )
      if (cIdx === 2) assertWiringClean(project, 'wire', tr.plan)
      const st = tr.stats('scope:scope1:CH1')
      ripples.push(st.vpp)
      rectMeans.push(st.mean)
    }
    expect(ripples[0] ?? 0).toBeGreaterThan(15)
    expect((ripples[1] ?? 99) < (ripples[0] ?? 0) * 0.4).toBe(true)
    expect((ripples[2] ?? 99) < (ripples[1] ?? 0) * 0.45).toBe(true)
    expect((ripples[3] ?? 99) < (ripples[2] ?? 0) * 0.7).toBe(true)
    expect((rectMeans[2] ?? 0) > (rectMeans[0] ?? 0) + 4).toBe(true)

    // 半波（50 Hz 脉动）与全波桥式（100 Hz 脉动）无滤波直流均值 1:2 对比
    const hwVsFw = await runTran(
      {
        title: 'MD-08 hw vs fw',
        modules: [
          { instanceId: 'ab1', module: modBase, subckt: cirBase },
          { instanceId: 'reg1', module: modReg, subckt: cirReg },
        ],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
          defaultIns('scope1', scope, { timebase: 0.005 }),
        ],
        wires: [
          ...baseWires.slice(0, 7),
          { a: 'scope1.CH1', b: 'reg1.HW_OUT' },
          { a: 'scope1.CH2', b: 'reg1.RECT_P' },
          { a: 'scope1.GND', b: 'reg1.REG_GND2' },
        ],
        ground: 'reg1.REG_GND',
        controlValues: { 'reg1.SW_CFILT': 0, 'reg1.R317_ADJ': 1200, 'reg1.SW_RLOAD': 1 },
        analysis: [],
      },
      0.1,
      { settleSec: 0.04, stepOverride: 0.0002 },
    )
    const hwMean = hwVsFw.stats('scope:scope1:CH1').mean
    const fwMean = hwVsFw.stats('scope:scope1:CH2').mean
    expect(hwMean).toBeGreaterThan(5.0)
    expect(fwMean / hwMean).toBeGreaterThan(1.85)
    expect(fwMean / hwMean).toBeLessThan(2.15)

    // LM317 三点调压与纹波抑制比验证
    for (const r2 of [400, 1200, 2000]) {
      const tr = await runTran(
        {
          title: `MD-08 lm317 r2=${r2}`,
          modules: [
            { instanceId: 'ab1', module: modBase, subckt: cirBase },
            { instanceId: 'reg1', module: modReg, subckt: cirReg },
          ],
          instruments: [
            defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
            defaultIns('scope1', scope, { timebase: 0.005 }),
          ],
          wires: baseWires,
          ground: 'reg1.REG_GND',
          controlValues: { 'reg1.SW_CFILT': 2, 'reg1.R317_ADJ': r2, 'reg1.SW_RLOAD': 1 },
          analysis: [],
        },
        0.16,
        { settleSec: 0.1, stepOverride: 0.0002 },
      )
      const expected = 1.25 * (1 + r2 / 240) + 50e-6 * r2
      const outSt = tr.stats('scope:scope1:CH2')
      const inSt = tr.stats('scope:scope1:CH1')
      expect(relErr(outSt.mean, expected)).toBeLessThanOrEqual(0.015)
      expect(outSt.vpp).toBeLessThan(inSt.vpp / 100) // > 40 dB ripple rejection
    }
  })

  it('MD-09：中心抽头双电源 LM7812 / LM7912 对称输出 ±12.00 V（≤ 1%）与 0→100 mA 负载调整率 < 1%', async () => {
    const project = loadProject('MD-09')
    const baseWires = [
      { a: 'ins-ac-power.U', b: 'ab1.AC_P1' },
      { a: 'ins-ac-power.N', b: 'ab1.AC_P2' },
      { a: 'ab1.AC_S1', b: 'reg1.AC_1' },
      { a: 'ab1.AC_S2', b: 'reg1.AC_2' },
      { a: 'ab1.AC_CT', b: 'reg1.REG_GND' },
      { a: 'reg1.RECT_P', b: 'reg1.REG78_IN' },
      { a: 'reg1.RECT_N', b: 'reg1.REG79_IN' },
      { a: 'reg1.REG78_OUT', b: 'reg1.LOAD_IN' },
      { a: 'scope1.CH1', b: 'reg1.REG78_OUT' },
      { a: 'scope1.CH2', b: 'reg1.REG79_OUT' },
      { a: 'scope1.GND', b: 'reg1.REG_GND2' },
    ]
    const posVals: number[] = []
    for (const loadIdx of [0, 1, 2]) {
      const tr = await runTran(
        {
          title: `MD-09 load=${loadIdx}`,
          modules: [
            { instanceId: 'ab1', module: modBase, subckt: cirBase },
            { instanceId: 'reg1', module: modReg, subckt: cirReg },
          ],
          instruments: [
            defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
            defaultIns('scope1', scope, { timebase: 0.005 }),
          ],
          wires: baseWires,
          controlValues: { 'reg1.SW_CFILT': 2, 'reg1.SW_RLOAD': loadIdx },
          analysis: [],
        },
        0.16,
        { settleSec: 0.1, stepOverride: 0.0002 },
      )
      if (loadIdx === 0) assertWiringClean(project, 'wire', tr.plan)
      const p = tr.stats('scope:scope1:CH1')
      const n = tr.stats('scope:scope1:CH2')
      expect(relErr(p.mean, 12.0), `load=${loadIdx} p=${p.mean} n=${n.mean}`).toBeLessThanOrEqual(0.01)
      expect(relErr(n.mean, -12.0), `load=${loadIdx} p=${p.mean} n=${n.mean}`).toBeLessThanOrEqual(0.01)
      expect(p.vpp, `load=${loadIdx} p=${JSON.stringify(p)} n=${JSON.stringify(n)}`).toBeLessThan(0.02)
      posVals.push(p.mean)
    }
    // 空载→满载 100 mA 负载调整率 < 1%
    expect(Math.abs((posVals[0] ?? 0) - (posVals[2] ?? 0)) / 12.0).toBeLessThan(0.01)

    // 验证无示波器、仅接直流电压表+万用表（默认以 ins-ac-power.N 为地）时的真实读数
    const metersTr = await runTran(
      {
        title: 'MD-09 meters only',
        modules: [
          { instanceId: 'ab1', module: modBase, subckt: cirBase },
          { instanceId: 'reg1', module: modReg, subckt: cirReg },
        ],
        instruments: [
          defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('meter1', multimeter, { range: 'dcv20' }),
        ],
        wires: [
          ...baseWires.slice(0, 8),
          { a: 'ins-dc-voltmeter.POS', b: 'reg1.REG78_OUT' },
          { a: 'ins-dc-voltmeter.NEG', b: 'reg1.REG_GND' },
          { a: 'meter1.VOHM', b: 'reg1.REG79_OUT' },
          { a: 'meter1.COM', b: 'reg1.REG_GND2' },
        ],
        controlValues: { 'reg1.SW_CFILT': 2, 'reg1.SW_RLOAD': 1 },
        analysis: [],
      },
      0.16,
      { settleSec: 0.1, stepOverride: 0.0002 },
    )
    const vmProbe = defined(metersTr.plan.meters.find((m) => m.instanceId === 'ins-dc-voltmeter')?.voltageProbe, 'vm')
    const mmProbe = defined(metersTr.plan.meters.find((m) => m.instanceId === 'meter1')?.voltageProbe, 'mm')
    const vmSt = metersTr.stats(vmProbe)
    const mmSt = metersTr.stats(mmProbe)
    expect(relErr(vmSt.mean, 12.0), `vm=${JSON.stringify(vmSt)} mm=${JSON.stringify(mmSt)}`).toBeLessThanOrEqual(0.01)
    expect(relErr(mmSt.mean, -12.0), `vm=${JSON.stringify(vmSt)} mm=${JSON.stringify(mmSt)}`).toBeLessThanOrEqual(0.01)
  }, 30_000)
})
