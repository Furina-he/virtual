import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type AssembleInput, assembleNetlist } from '../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import { moduleParameters } from '../../src/domain/circuit/module-controls.ts'
import {
  evaluateSegment7,
  getInstrumentDefaults,
  PowerWindow,
  readInstrument,
  resolveInstrument,
} from '../../src/domain/instruments/index.ts'
import { RmsWindow } from '../../src/domain/instruments/rms-window.ts'
import { measureSignal } from '../../src/domain/instruments/scope.ts'
import { buildMeasurementPlan, METER_RMS_WINDOW, type MeasurementPlan } from '../../src/domain/measurement/plan.ts'
import {
  captureMeasurePoint,
  completeTaskStep,
  createFaultFlowState,
  createTaskState,
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
import type { Probe, SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// T1.11 金标准：真实 ngspice（全程经 SimSession）端到端验证 M1 三个代表项目（DG-12、MD-07、SD-10）。

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const loadIns = (id: string) => Instrument.parse(loadJson(`content/instruments/${id}/instrument.json`))
const loadMod = (id: string) => Module.parse(loadJson(`content/modules/${id}/module.json`))
const loadProject = (id: string) => Project.parse(loadJson(`content/projects/${id}/project.json`))

const LIBRARIES = {
  'bjt.lib': readFileSync('content/models/spice/bjt.lib', 'utf8'),
  'ttl.lib': readFileSync('content/models/spice/ttl.lib', 'utf8'),
  'cmos.lib': readFileSync('content/models/spice/cmos.lib', 'utf8'),
}

const loadModCir = (id: string) =>
  expandLocalLibraries(readFileSync(`content/modules/${id}/module.cir`, 'utf8'), LIBRARIES)

const acPower = loadIns('ins-ac-power')
const acVolt = loadIns('ins-ac-voltmeter')
const acAmp = loadIns('ins-ac-ammeter')
const watt = loadIns('ins-power-meter')
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
    await wait(15)
    for (const ev of events.splice(0)) {
      if (ev.type === 'status' && (ev.state === 'paused' || ev.state === 'idle')) return
    }
  }
}

async function runSessionOp(cmd: Parameters<SimSession['handle']>[0]): Promise<Record<string, number>> {
  events.length = 0
  session.handle(cmd)
  let loaded = false
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await wait(10)
    for (const ev of events.splice(0)) {
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
      if (ev.type === 'loaded') loaded = true
      if (ev.type === 'op' && loaded) return ev.values
    }
  }
  throw new Error('Timed out waiting for SimSession .op result')
}

describe('T1.11 M1 三项目真实 ngspice 金标准（DG-12 / MD-07 / SD-10）', () => {
  it('DG-12：并联电容提高功率因数五档实时切换、功率表/交流表误差 ≤ 1% 且任务记表通过', async () => {
    const project = loadProject('DG-12')
    const acMod = loadMod('mod-ac-fluorescent')
    const acCir = loadModCir('mod-ac-fluorescent')

    const input: AssembleInput = {
      title: 'T1.11 DG-12 power factor',
      modules: [{ instanceId: 'ac1', module: acMod, subckt: acCir }],
      instruments: [
        defaultIns('ins-ac-power', acPower, { u_phase: 220 }),
        defaultIns('ins-ac-voltmeter', acVolt, { range: 'r500' }),
        defaultIns('ins-ac-ammeter', acAmp, { range: 'r1' }),
        defaultIns('ins-power-meter', watt, { displayMode: 'pf' }),
      ],
      wires: [
        { a: 'ins-ac-power.U', b: 'ac1.AC_L' },
        { a: 'ins-ac-power.N', b: 'ac1.AC_N' },
        { a: 'ac1.LOAD_IN', b: 'ac1.CAP_IN' },
        { a: 'ins-ac-ammeter.I', b: 'ac1.I_LINE_A' },
        { a: 'ins-ac-ammeter.STAR', b: 'ac1.I_LINE_B' },
        { a: 'ins-power-meter.I', b: 'ac1.I_TOT_A' },
        { a: 'ins-power-meter.I_STAR', b: 'ac1.I_TOT_B' },
        { a: 'ins-power-meter.U', b: 'ac1.LOAD_IN' },
        { a: 'ins-power-meter.U_STAR', b: 'ac1.AC_N' },
        { a: 'ins-ac-voltmeter.U', b: 'ac1.LOAD_IN' },
        { a: 'ins-ac-voltmeter.STAR', b: 'ac1.AC_N' },
      ],
      ground: 'ins-ac-power.N',
      controlValues: { 'ac1.KC1': 0, 'ac1.KC2': 0, 'ac1.KC3': 0 },
      analysis: [],
    }

    const plan = buildMeasurementPlan(input, true, 'dg12')
    expect(plan.command.analysis.kind).toBe('tran')

    // 1. 接线检查与安全检查
    const wireStep = project.steps.find((s) => s.id === 'wire')
    const wiringReport = checkWiring(plan.checkInput, scopedReference(project, wireStep))
    expect(wiringReport.circuitOk).toBe(true)
    expect(wiringReport.measurementsOk).toBe(true)
    expect(wiringReport.issues).toEqual([])
    expect(detectDanger(plan.checkInput)).toEqual([])

    const mAcv = defined(
      plan.meters.find((m) => m.instanceId === 'ins-ac-voltmeter'),
      'acv meter',
    )
    const mAca = defined(
      plan.meters.find((m) => m.instanceId === 'ins-ac-ammeter'),
      'aca meter',
    )
    const mWatt = defined(
      plan.meters.find((m) => m.instanceId === 'ins-power-meter'),
      'watt meter',
    )

    const rmsU = new RmsWindow(METER_RMS_WINDOW)
    const rmsI = new RmsWindow(METER_RMS_WINDOW)
    const pw = new PowerWindow(METER_RMS_WINDOW)

    events.length = 0
    session.handle(plan.command)
    session.handle({ type: 'setPacing', mode: 'window', windowSec: 0.6 })
    session.handle({ type: 'run' })

    let loaded = false
    let simTime = 0
    const pumpUntil = async (targetSimTime: number, resetAfterSimTime: number) => {
      let cleared = false
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        await wait(20)
        for (const ev of events.splice(0)) {
          if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
          if (ev.type === 'loaded') loaded = true
          if (ev.type !== 'chunk' || !loaded) continue
          const u = ev.data[defined(mAcv.voltageProbe, 'uProbe')]
          const i = ev.data[defined(mAca.currentProbe, 'iProbe')]
          const pu = ev.data[defined(mWatt.voltageProbe, 'puProbe')]
          const pi = ev.data[defined(mWatt.currentProbe, 'piProbe')]
          if (u) rmsU.push(u, ev.t0, ev.dt)
          if (i) rmsI.push(i, ev.t0, ev.dt)
          if (pu && pi) {
            pw.pushVoltage(pu, ev.t0, ev.dt)
            pw.pushCurrent(pi, ev.t0, ev.dt)
          }
          const first = Object.values(ev.data)[0]
          if (first) simTime = ev.t0 + first.length * ev.dt
          if (!cleared && simTime >= resetAfterSimTime) {
            rmsU.clear()
            rmsI.clear()
            pw.clear()
            cleared = true
          }
        }
        if (
          cleared &&
          simTime >= targetSimTime &&
          rmsU.value !== undefined &&
          rmsI.value !== undefined &&
          pw.value !== undefined
        )
          return
      }
      throw new Error(`DG-12 timed out at simTime=${simTime} targeting ${targetSimTime}`)
    }

    // 任务推进器：走完 prepare -> wire -> c0 -> c22 -> c32 -> c47 -> c79 -> analyse
    let task = createTaskState(project)
    task = completeTaskStep(project, task, 'prepare').state
    expect(task.completedSteps).toContain('prepare')
    task = completeTaskStep(project, task, 'wire', { wiringCorrect: true }).state
    expect(task.completedSteps).toContain('wire')

    const omega = 2 * Math.PI * 50
    const R = 300
    const L = 1.65
    const XL = omega * L
    const Z2 = R * R + XL * XL
    const G = R / Z2
    const BL = XL / Z2

    const cases = [
      { row: 0, stepId: 'c0', cUf: 0, kc1: 0, kc2: 0, kc3: 0, nature: 'L' as const },
      { row: 1, stepId: 'c22', cUf: 2.2, kc1: 0, kc2: 1, kc3: 0, nature: 'L' as const },
      { row: 2, stepId: 'c32', cUf: 3.2, kc1: 1, kc2: 1, kc3: 0, nature: 'L' as const },
      { row: 3, stepId: 'c47', cUf: 4.7, kc1: 0, kc2: 0, kc3: 1, nature: 'C' as const },
      { row: 4, stepId: 'c79', cUf: 7.9, kc1: 1, kc2: 1, kc3: 1, nature: 'C' as const },
    ]

    for (const [idx, c] of cases.entries()) {
      if (idx > 0) {
        const changes = moduleParameters([{ instanceId: 'ac1', module: acMod }], {
          'ac1.KC1': c.kc1,
          'ac1.KC2': c.kc2,
          'ac1.KC3': c.kc3,
        }).map(({ param, value, targets }) => ({ param, value, ...(targets ? { targets } : {}) }))
        const reqId = `dg12-${c.stepId}`
        session.handle({ type: 'alter', requestId: reqId, changes })
        const alterDeadline = Date.now() + 10_000
        let altered = false
        while (Date.now() < alterDeadline && !altered) {
          await wait(15)
          for (const ev of events.splice(0)) {
            if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
            if (ev.type === 'altered' && ev.requestId === reqId) {
              simTime = ev.simTime
              altered = true
            }
          }
        }
        expect(altered).toBe(true)
      }

      const startT = simTime
      // 0.28 s 暂态衰减 + 0.27 s 稳态 10 周期积分窗口
      await pumpUntil(startT + 0.55, startT + 0.28)

      const uVal = defined(rmsU.value, `uVal@${c.cUf}`)
      const iVal = defined(rmsI.value, `iVal@${c.cUf}`)
      const metrics = defined(pw.value, `power@${c.cUf}`)

      // 用实测负载端电压代入精确解析导纳，检验仿真物理误差 ≤ 1%
      const cF = c.cUf * 1e-6
      const B = BL - omega * cF
      const yMag = Math.hypot(G, B)
      const iTheory = uVal * yMag
      const pTheory = uVal * uVal * G
      const qTheory = uVal * uVal * B
      const pfTheory = G / yMag

      expect(
        Math.abs(uVal - 220) / 220,
        `${c.stepId} uVal=${uVal} iVal=${iVal} P=${metrics.P} Q=${metrics.Q} pf=${metrics.pf}`,
      ).toBeLessThan(0.01)
      expect(Math.abs(iVal - iTheory) / iTheory).toBeLessThan(0.01)
      expect(Math.abs(metrics.P - pTheory) / pTheory).toBeLessThan(0.01)
      expect(Math.abs(metrics.pf - pfTheory)).toBeLessThan(0.01)
      expect(Math.abs(metrics.Q - qTheory)).toBeLessThan(1.2)
      expect(metrics.loadNature).toBe(c.nature)
      // 并联电容不改变感性负载有功功率 P ≈ 40.48 W
      expect(Math.abs(metrics.P - 40.48) / 40.48).toBeLessThan(0.015)

      // 走通数据表记录与步骤自动推进（含 power 单位 W / var / '' 与计算列 s_calc）
      const acvReading = readInstrument(mAcv.config, { rmsVoltage: uVal, connectedJacks: mAcv.connectedJacks })
      const acaReading = readInstrument(mAca.config, { rmsCurrent: iVal, connectedJacks: mAca.connectedJacks })
      const wattReading = readInstrument(mWatt.config, { power: metrics, connectedJacks: mWatt.connectedJacks })
      const snapshot: MeasurementSnapshot = {
        current: true,
        plan,
        readings: {
          'ins-ac-voltmeter': acvReading,
          'ins-ac-ammeter': acaReading,
          'ins-power-meter': wattReading,
        },
      }

      task = writeTableCell(project, task, 'compensation', c.row, 'c_uf', c.cUf).state
      for (const col of ['u_load', 'i_line', 'p_active', 'q_reactive', 'pf'] as const) {
        const res = recordCurrentReading(project, task, 'compensation', c.row, col, {
          snapshot,
          row: c.row,
          advance: false,
        })
        expect(res.ok, `${c.stepId}.${col}: ${res.message}`).toBe(true)
        task = res.state
      }
      const stepRes = completeTaskStep(project, task, c.stepId, { snapshot, row: c.row })
      expect(stepRes.ok, `${c.stepId}: ${stepRes.message}`).toBe(true)
      task = stepRes.state
      const recordedRow = task.tables.compensation?.[c.row]
      expect(recordedRow?.s_calc).toBeCloseTo((recordedRow?.u_load ?? 0) * (recordedRow?.i_line ?? 0), 2)
    }

    await pauseAndIdle()
    const finalRes = completeTaskStep(project, task, 'analyse', { row: 4 })
    expect(finalRes.ok).toBe(true)
    expect(finalRes.state.completedSteps).toHaveLength(project.steps.length)
  }, 60_000)

  it('MD-07：三极管放大电路 6 个故障全流程六步闭环（抽题→观察→测量→误判/正确判定→断电修复→上电验证结项）', async () => {
    const project = loadProject('MD-07')
    const ampMod = loadMod('mod-analog-amp')
    const ampCir = loadModCir('mod-analog-amp')

    const buildOpSnapshot = async (fault?: NonNullable<Project['faults']>[number]): Promise<MeasurementSnapshot> => {
      const input: AssembleInput = {
        title: `T1.11 MD-07 op ${fault?.id ?? 'normal'}`,
        modules: [{ instanceId: 'amp1', module: ampMod, subckt: ampCir }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'amp1.AMP_VCC' },
          { a: 'ins-dc-power.CH1N', b: 'amp1.AMP_GND1' },
          { a: 'ins-dc-voltmeter.POS', b: 'amp1.AMP_UC' },
          { a: 'ins-dc-voltmeter.NEG', b: 'amp1.AMP_GND1' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'amp1.RW': 22000, 'amp1.KCE': 1 },
        ...(fault ? { fault } : {}),
        analysis: [],
      }
      const plan = buildMeasurementPlan(input, true, `md07-${fault?.id ?? 'normal'}`)
      const values = await runSessionOp({ ...plan.command, analysis: { kind: 'op' } })
      const vm = defined(
        plan.meters.find((m) => m.instanceId === 'ins-dc-voltmeter'),
        'dcVolt',
      )
      const uc = values[defined(vm.voltageProbe, 'uc probe')] ?? Number.NaN
      const vmReading = readInstrument(vm.config, { voltage: uc, connectedJacks: vm.connectedJacks })
      return { current: true, plan, readings: { 'ins-dc-voltmeter': vmReading } }
    }

    const buildTranSnapshot = async (fault?: NonNullable<Project['faults']>[number]): Promise<MeasurementSnapshot> => {
      const input: AssembleInput = {
        title: `T1.11 MD-07 tran ${fault?.id ?? 'normal'}`,
        modules: [{ instanceId: 'amp1', module: ampMod, subckt: ampCir }],
        instruments: [
          defaultIns('ins-dc-power', dcPower, { ch1_v: 12 }),
          defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
          defaultIns('gen1', funcGen, { ch1_wave: 'sine', ch1_freq: 1000, ch1_amp: 0.1, ch1_offset: 0, ch1_on: 1 }),
          defaultIns('osc1', scope, {}),
        ],
        wires: [
          { a: 'ins-dc-power.CH1P', b: 'amp1.AMP_VCC' },
          { a: 'ins-dc-power.CH1N', b: 'amp1.AMP_GND1' },
          { a: 'gen1.CH1', b: 'amp1.AMP_US' },
          { a: 'gen1.GND', b: 'amp1.AMP_GND2' },
          { a: 'amp1.AMP_UO', b: 'amp1.AMP_RL' },
          { a: 'ins-dc-voltmeter.POS', b: 'amp1.AMP_UC' },
          { a: 'ins-dc-voltmeter.NEG', b: 'amp1.AMP_GND1' },
          { a: 'osc1.CH1', b: 'amp1.AMP_UO' },
          { a: 'osc1.GND', b: 'amp1.AMP_GND2' },
        ],
        ground: 'ins-dc-power.CH1N',
        controlValues: { 'amp1.RW': 22000, 'amp1.KCE': 1 },
        ...(fault ? { fault } : {}),
        analysis: [],
      }
      const plan = buildMeasurementPlan(input, true, `md07-tran-${fault?.id ?? 'normal'}`)
      const ch1Probe = defined(plan.scopes[0]?.channels.find((c) => c.id === 'CH1')?.probe, 'osc1 CH1')
      const ucProbe = defined(
        plan.meters.find((m) => m.instanceId === 'ins-dc-voltmeter')?.voltageProbe,
        'dcVolt probe',
      )
      events.length = 0
      session.handle(plan.command)
      session.handle({ type: 'setPacing', mode: 'window', windowSec: 0.5 })
      session.handle({ type: 'run' })
      let loaded = false
      let simTime = 0
      let dt = 20e-6
      const uoTail: number[] = []
      let lastUc = Number.NaN
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && simTime < 0.045) {
        await wait(15)
        for (const ev of events.splice(0)) {
          if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
          if (ev.type === 'loaded') loaded = true
          if (ev.type !== 'chunk' || !loaded) continue
          const uo = ev.data[ch1Probe]
          const uc = ev.data[ucProbe]
          if (!uo || !uc) continue
          dt = ev.dt
          for (let k = 0; k < uo.length; k++) {
            const t = ev.t0 + k * ev.dt
            if (t >= 0.03) uoTail.push(uo[k] ?? 0)
          }
          lastUc = uc[uc.length - 1] ?? lastUc
          simTime = ev.t0 + uo.length * ev.dt
        }
      }
      await pauseAndIdle()
      const uoSignal = measureSignal(Float32Array.from(uoTail), dt)
      const vmReading = readInstrument(resolveInstrument(dcVolt, { range: 'r20' }), {
        voltage: lastUc,
        connectedJacks: ['POS', 'NEG'],
      })
      return {
        current: true,
        plan,
        readings: { 'ins-dc-voltmeter': vmReading },
        waveforms: [
          {
            instanceId: 'osc1',
            channelId: 'CH1',
            positiveRef: 'osc1.CH1',
            negativeRef: 'osc1.GND',
            coupling: 'dc',
            current: true,
            measurement: uoSignal,
          },
        ],
      }
    }

    // 接线检查：wire 步骤通过
    const normalOp = await buildOpSnapshot()
    const wireStep = project.steps.find((s) => s.id === 'wire')
    const wireReport = checkWiring(normalOp.plan.checkInput, scopedReference(project, wireStep))
    expect(wireReport.circuitOk).toBe(true)
    expect(wireReport.measurementsOk).toBe(true)
    expect(detectDanger(normalOp.plan.checkInput)).toEqual([])

    let flow = createFaultFlowState()
    const faults = defined(project.faults, 'MD-07 faults')
    expect(faults).toHaveLength(6)

    for (const [idx, fault] of faults.entries()) {
      const t0 = 10_000 + idx * 5_000
      // 1. 断电抽题
      const started = startFaultSession(project, flow, { mode: 'preset', faultId: fault.id, powered: false, nowMs: t0 })
      expect(started.ok).toBe(true)
      flow = started.state

      // 2. 上电观察现象
      const observed = observeFaultSymptom(project, flow, { powered: true, nowMs: t0 + 500 })
      expect(observed.ok).toBe(true)
      flow = observed.state

      // 3. 真实 ngspice 测量异常点并记录排故测量
      const faultSnap = fault.id === 'f-c2-open' ? await buildTranSnapshot(fault) : await buildOpSnapshot(fault)
      const ucFault = faultSnap.readings['ins-dc-voltmeter']?.value ?? Number.NaN
      if (fault.id === 'f-c2-open') {
        expect(faultSnap.waveforms?.[0]?.measurement?.vpp ?? 99).toBeLessThan(0.02)
      } else {
        // 其余 5 个直流故障均使 UC 明显偏离正常 5.87 V（超出 [5.2, 6.6] V）
        expect(ucFault < 5.2 || ucFault > 6.6, `${fault.id} UC=${ucFault}`).toBe(true)
      }
      const measured = recordFaultMeasurement(project, flow, { snapshot: faultSnap, nowMs: t0 + 1000 })
      expect(measured.ok).toBe(true)
      flow = measured.state

      // 4. 误判分支返回排查提示，再提交正确故障点与类型
      const wrongKind = fault.kind === 'open' ? 'short' : 'open'
      const wrong = submitFaultDiagnosis(project, flow, { target: fault.target, kind: wrongKind, nowMs: t0 + 1500 })
      expect(wrong.ok).toBe(false)
      expect(wrong.state.lastVerdict?.hint).toBe(fault.hint)
      flow = wrong.state

      const judged = submitFaultDiagnosis(project, flow, { target: fault.target, kind: fault.kind, nowMs: t0 + 2000 })
      expect(judged.ok).toBe(true)
      expect(judged.state.stage).toBe('repair')
      flow = judged.state

      // 5. 带电禁止修复，断电成功撤除故障
      expect(repairFault(project, flow, { powered: true, nowMs: t0 + 2300 }).ok).toBe(false)
      const repaired = repairFault(project, flow, { powered: false, nowMs: t0 + 2500 })
      expect(repaired.ok).toBe(true)
      expect(repaired.state.stage).toBe('verify')
      flow = repaired.state

      // 6. 上电验证恢复正常范围并结项（未恢复时拦截，恢复后通过）
      const blockedVerify = verifyFaultRepair(project, flow, { powered: true, snapshot: faultSnap, nowMs: t0 + 2800 })
      expect(blockedVerify.ok).toBe(false)

      const restoredSnap = fault.id === 'f-c2-open' ? await buildTranSnapshot() : await buildOpSnapshot()
      const verified = verifyFaultRepair(project, flow, { powered: true, snapshot: restoredSnap, nowMs: t0 + 3500 })
      expect(verified.ok, `${fault.id}: ${verified.message}`).toBe(true)
      expect(verified.state.stage).toBe('completed')
      flow = verified.state
    }

    expect(flow.resolvedFaultIds).toHaveLength(6)
    expect(flow.history).toHaveLength(6)
  }, 60_000)

  it('SD-10：74LS90×2 + CD4511×2 真实 ngspice 00→99→00 级联计数、实时清零与十分频测量', async () => {
    const project = loadProject('SD-10')
    const digMod = loadMod('mod-digital-logic')
    const digCir = loadModCir('mod-digital-logic')

    const sd10Wires = [
      { a: 'ins-dc-power.V5P', b: 'dig1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'dig1.GND' },
      { a: 'dig1.CLK_OUT', b: 'dig1.U1_CP0' },
      { a: 'dig1.U1_Q0', b: 'dig1.U1_CP1' },
      { a: 'dig1.U1_Q0', b: 'dig1.D1_A' },
      { a: 'dig1.U1_Q1', b: 'dig1.D1_B' },
      { a: 'dig1.U1_Q2', b: 'dig1.D1_C' },
      { a: 'dig1.U1_Q3', b: 'dig1.U2_CP0' },
      { a: 'dig1.U1_Q3', b: 'dig1.D1_D' },
      { a: 'dig1.U2_Q0', b: 'dig1.U2_CP1' },
      { a: 'dig1.U2_Q0', b: 'dig1.D2_A' },
      { a: 'dig1.U2_Q1', b: 'dig1.D2_B' },
      { a: 'dig1.U2_Q2', b: 'dig1.D2_C' },
      { a: 'dig1.U2_Q3', b: 'dig1.D2_D' },
      { a: 'dig1.RST_OUT', b: 'dig1.U1_R0' },
      { a: 'dig1.RST_OUT', b: 'dig1.U2_R0' },
      { a: 'ins-dc-voltmeter.POS', b: 'dig1.VCC' },
      { a: 'ins-dc-voltmeter.NEG', b: 'dig1.GND' },
      { a: 'osc1.CH1', b: 'dig1.U1_CP0' },
      { a: 'osc1.CH2', b: 'dig1.U1_Q3' },
      { a: 'osc1.GND', b: 'dig1.GND' },
    ]

    const input: AssembleInput = {
      title: 'T1.11 SD-10 counter session',
      modules: [{ instanceId: 'dig1', module: digMod, subckt: digCir }],
      instruments: [
        defaultIns('ins-dc-power', dcPower, {}),
        defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' }),
        defaultIns('osc1', scope, { tdiv: 0.5, out_on: 0 }),
      ],
      wires: sd10Wires,
      ground: 'ins-dc-power.V5N',
      controlValues: { 'dig1.CLK_RATE': 10, 'dig1.RST_SW': 0 },
      analysis: [],
    }

    const plan = buildMeasurementPlan(input, true, 'sd10')
    expect(plan.command.analysis.kind).toBe('tran')
    expect(plan.segment7s).toHaveLength(2)

    // 1. 接线检查与危险检查
    const wireStep = project.steps.find((s) => s.id === 'wire')
    const wireReport = checkWiring(plan.checkInput, scopedReference(project, wireStep))
    expect(wireReport.circuitOk).toBe(true)
    expect(wireReport.measurementsOk).toBe(true)
    expect(wireReport.issues).toEqual([])
    expect(detectDanger(plan.checkInput)).toEqual([])

    const tensPlan = defined(
      plan.segment7s.find((s) => s.indicatorId === 'DISP_TENS'),
      'DISP_TENS plan',
    )
    const onesPlan = defined(
      plan.segment7s.find((s) => s.indicatorId === 'DISP_ONES'),
      'DISP_ONES plan',
    )
    const ch1Probe = defined(plan.scopes[0]?.channels.find((c) => c.id === 'CH1')?.probe, 'scope CH1')
    const ch2Probe = defined(plan.scopes[0]?.channels.find((c) => c.id === 'CH2')?.probe, 'scope CH2')
    const vccProbe = defined(plan.meters.find((m) => m.instanceId === 'ins-dc-voltmeter')?.voltageProbe, 'vcc probe')

    // 2. 真实 SimSession 10 Hz 连续运行：采集 2.45 s 波形并校验 00→10+ 级联进位、十分频、清零与恢复
    events.length = 0
    session.handle(plan.command)
    session.handle({ type: 'setPacing', mode: 'window', windowSec: 1.5 })
    session.handle({ type: 'run' })

    const ch1Samples: number[] = []
    const ch2Samples: number[] = []
    let sampleDt = 0
    let lastVcc = 0
    const seenDigits: string[] = []
    let latestDisplay = ''
    let simTime = 0
    let loaded = false

    let firstSample: { t: number; tens: number[]; ones: number[]; text: string } | undefined
    const decodeAtIndex = (data: Record<string, Float32Array>, idx: number, t = 0) => {
      const readSeg = (segPlan: MeasurementPlan['segment7s'][number]) => {
        const voltages = segPlan.probes.map((id) => data[id]?.[idx] ?? 0) as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ]
        return { voltages, text: evaluateSegment7(voltages, segPlan.threshold).char }
      }
      const tens = readSeg(tensPlan)
      const ones = readSeg(onesPlan)
      const text = `${tens.text}${ones.text}`
      if (!firstSample && t >= 0.02) firstSample = { t, tens: tens.voltages, ones: ones.voltages, text }
      return text
    }

    const drainUntil = async (targetSec: number, collectWaveforms: boolean) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await wait(20)
        for (const ev of events.splice(0)) {
          if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
          if (ev.type === 'loaded') loaded = true
          if (ev.type !== 'chunk' || !loaded) continue
          const c1 = ev.data[ch1Probe]
          const c2 = ev.data[ch2Probe]
          const vc = ev.data[vccProbe]
          if (!c1 || !c2 || !vc || c1.length === 0) continue
          sampleDt = ev.dt
          lastVcc = vc[vc.length - 1] ?? lastVcc
          if (collectWaveforms) {
            for (let k = 0; k < c1.length; k++) {
              ch1Samples.push(c1[k] ?? 0)
              ch2Samples.push(c2[k] ?? 0)
            }
          }
          const stride = Math.max(1, Math.round(0.02 / ev.dt))
          for (let k = 0; k < c1.length; k += stride) {
            const t = ev.t0 + k * ev.dt
            if (t < 0.015) continue
            const text = decodeAtIndex(ev.data, k, t)
            if (/^\d\d$/.test(text)) {
              latestDisplay = text
              if (seenDigits[seenDigits.length - 1] !== text) seenDigits.push(text)
            }
          }
          simTime = ev.t0 + c1.length * ev.dt
        }
        if (simTime >= targetSec) return
      }
      throw new Error(`SD-10 timed out at simTime=${simTime} targeting ${targetSec}`)
    }

    // 推进至 2.95 s（10 Hz 下覆盖 00..28，且 U1_Q3 在 0.8 / 1.8 / 2.8 s 产生 ≥ 3 个上升沿即 ≥ 2 个完整周期）
    await drainUntil(2.95, true)
    expect(lastVcc).toBeGreaterThan(4.9)
    expect(lastVcc).toBeLessThan(5.1)

    // 验证 00 -> 01 -> ... -> 09 -> 10 -> 11 -> ... 严格按十进制级联递增
    const expectedPrefix = Array.from({ length: 15 }, (_, i) => String(i).padStart(2, '0'))
    const startIdx = seenDigits.indexOf('00')
    expect(
      startIdx,
      `seenDigits=${JSON.stringify(seenDigits)} firstSample=${JSON.stringify(firstSample)}`,
    ).toBeGreaterThanOrEqual(0)
    expect(seenDigits.slice(startIdx, startIdx + expectedPrefix.length)).toEqual(expectedPrefix)

    // 验证示波器十分频测量（f_clk ≈ 10 Hz, f_carry ≈ 1 Hz, 分频比 ≈ 10）
    const sigClk = measureSignal(Float32Array.from(ch1Samples), sampleDt)
    const sigCarry = measureSignal(Float32Array.from(ch2Samples), sampleDt)
    expect(sigClk?.frequency).toBeDefined()
    expect(sigCarry?.frequency).toBeDefined()
    expect(Math.abs((sigClk?.frequency ?? 0) - 10) / 10).toBeLessThan(0.02)
    expect(Math.abs((sigCarry?.frequency ?? 0) - 1) / 1).toBeLessThan(0.02)
    expect(sigCarry?.completeCycles ?? 0).toBeGreaterThanOrEqual(2)
    expect(Math.abs((sigClk?.frequency ?? 0) / (sigCarry?.frequency ?? 1) - 10)).toBeLessThan(0.2)

    const sdSnap: MeasurementSnapshot = {
      current: true,
      plan,
      readings: {
        'ins-dc-voltmeter': readInstrument(resolveInstrument(dcVolt, { range: 'r20' }), {
          voltage: lastVcc,
          connectedJacks: ['POS', 'NEG'],
        }),
      },
      waveforms: [
        {
          instanceId: 'osc1',
          channelId: 'CH1',
          positiveRef: 'osc1.CH1',
          negativeRef: 'osc1.GND',
          coupling: 'dc',
          current: true,
          measurement: sigClk,
        },
        {
          instanceId: 'osc1',
          channelId: 'CH2',
          positiveRef: 'osc1.CH2',
          negativeRef: 'osc1.GND',
          coupling: 'dc',
          current: true,
          measurement: sigCarry,
        },
      ],
    }
    const capClk = captureMeasurePoint(
      sdSnap,
      defined(
        project.reference.measurePoints.find((p) => p.id === 'f_clk'),
        'f_clk',
      ),
    )
    const capCarry = captureMeasurePoint(
      sdSnap,
      defined(
        project.reference.measurePoints.find((p) => p.id === 'f_carry'),
        'f_carry',
      ),
    )
    expect(capClk.ok).toBe(true)
    expect(capCarry.ok).toBe(true)

    // 3. 运行中 ADR-009 live alter 清零（RST_SW=1）应立即归零 00；释放后恢复计数
    const alterRst = async (rstVal: 0 | 1, reqId: string) => {
      const changes = moduleParameters([{ instanceId: 'dig1', module: digMod }], {
        'dig1.CLK_RATE': 10,
        'dig1.RST_SW': rstVal,
      })
        .filter((p) => p.controlRef === 'dig1.RST_SW')
        .map(({ param, value, targets }) => ({ param, value, ...(targets ? { targets } : {}) }))
      session.handle({ type: 'alter', requestId: reqId, changes })
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        await wait(15)
        for (const ev of events.splice(0)) {
          if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})`)
          if (ev.type === 'altered' && ev.requestId === reqId) {
            simTime = ev.simTime
            return
          }
        }
      }
      throw new Error(`Timed out waiting for alter ${reqId}`)
    }

    await alterRst(1, 'sd10-rst-on')
    await drainUntil(simTime + 0.25, false)
    expect(latestDisplay).toBe('00')

    await alterRst(0, 'sd10-rst-off')
    seenDigits.length = 0
    await drainUntil(simTime + 0.45, false)
    expect(seenDigits).toContain('01')
    expect(seenDigits).toContain('02')

    // 4. 验证实时节奏速度（SD-10 在 realtime 模式下应稳定维持 ≥ 0.7x 实时推进）
    session.handle({ type: 'setPacing', mode: 'realtime' })
    const wall0 = performance.now()
    const sim0 = simTime
    await drainUntil(sim0 + 0.4, false)
    const wallSec = (performance.now() - wall0) / 1000
    const simAdvance = simTime - sim0
    expect(simAdvance / wallSec).toBeGreaterThan(0.7)
    await pauseAndIdle()

    // 5. 完整 00 → 01 → ... → 99 → 00 百态真值校验（经 SimSession + 1 kHz 外接时钟跑满 101 态）
    const fastAssembled = assembleNetlist({
      title: 'T1.11 SD-10 full 00..99..00 cascade',
      modules: [{ instanceId: 'dig1', module: digMod, subckt: digCir }],
      instruments: [defaultIns('ins-dc-power', dcPower, {})],
      wires: [
        { a: 'ins-dc-power.V5P', b: 'dig1.VCC' },
        { a: 'ins-dc-power.V5N', b: 'dig1.GND' },
        { a: 'dig1.U1_Q0', b: 'dig1.U1_CP1' },
        { a: 'dig1.U1_Q0', b: 'dig1.D1_A' },
        { a: 'dig1.U1_Q1', b: 'dig1.D1_B' },
        { a: 'dig1.U1_Q2', b: 'dig1.D1_C' },
        { a: 'dig1.U1_Q3', b: 'dig1.U2_CP0' },
        { a: 'dig1.U1_Q3', b: 'dig1.D1_D' },
        { a: 'dig1.U2_Q0', b: 'dig1.U2_CP1' },
        { a: 'dig1.U2_Q0', b: 'dig1.D2_A' },
        { a: 'dig1.U2_Q1', b: 'dig1.D2_B' },
        { a: 'dig1.U2_Q2', b: 'dig1.D2_C' },
        { a: 'dig1.U2_Q3', b: 'dig1.D2_D' },
        { a: 'dig1.RST_OUT', b: 'dig1.U1_R0' },
        { a: 'dig1.RST_OUT', b: 'dig1.U2_R0' },
      ],
      ground: 'ins-dc-power.V5N',
      controlValues: { 'dig1.CLK_RATE': 2, 'dig1.RST_SW': 0 },
      analysis: [],
    })
    const cp0Node = defined(fastAssembled.nodeOf['dig1.U1_CP0'], 'U1_CP0 node')
    const bodyLines = fastAssembled.netlist.split(/\r?\n/).filter((l) => !/^\s*\.end\b/i.test(l))
    const segNodes = [
      'xdig1.seg2_a',
      'xdig1.seg2_b',
      'xdig1.seg2_c',
      'xdig1.seg2_d',
      'xdig1.seg2_e',
      'xdig1.seg2_f',
      'xdig1.seg2_g',
      'xdig1.seg1_a',
      'xdig1.seg1_b',
      'xdig1.seg1_c',
      'xdig1.seg1_d',
      'xdig1.seg1_e',
      'xdig1.seg1_f',
      'xdig1.seg1_g',
    ]
    const fastProbes: Probe[] = segNodes.map((node, i) => ({ id: `s${i}`, kind: 'v', node }))
    const fastNetlist = [
      ...bodyLines,
      'Vclk_fast clk_fast_src 0 PULSE(0 5 3m 1u 1u 0.5m 1m)',
      `Rclk_fast clk_fast_src ${cp0Node} 50`,
      '.end',
    ].join('\n')

    events.length = 0
    const fastLogs: string[] = []
    session.handle({
      type: 'load',
      requestId: 'sd10-fast',
      netlist: fastNetlist,
      probes: fastProbes,
      analysis: { kind: 'tran', step: 50e-6, continuous: true },
    })
    session.handle({ type: 'setPacing', mode: 'window', windowSec: 1.0 })
    session.handle({ type: 'run' })

    const fastBuffers: number[][] = Array.from({ length: 14 }, () => [])
    let fastLoaded = false
    let fastT = 0
    let fastDt = 50e-6
    const fastDeadline = Date.now() + 25_000
    while (Date.now() < fastDeadline && fastT < 0.106) {
      await wait(15)
      for (const ev of events.splice(0)) {
        if (ev.type === 'log') fastLogs.push(ev.line)
        if (ev.type === 'error')
          throw new Error(`${ev.message} (${ev.detail ?? ''}) logs=${fastLogs.slice(-10).join(' | ')}`)
        if (ev.type === 'loaded') fastLoaded = true
        if (ev.type !== 'chunk' || !fastLoaded) continue
        fastDt = ev.dt
        const s0 = ev.data.s0
        if (!s0) continue
        for (let ch = 0; ch < 14; ch++) {
          const arr = ev.data[`s${ch}`]
          const buf = fastBuffers[ch]
          if (arr && buf) for (let k = 0; k < arr.length; k++) buf.push(arr[k] ?? 0)
        }
        fastT = ev.t0 + s0.length * ev.dt
      }
    }
    await pauseAndIdle()

    for (let n = 0; n <= 100; n++) {
      const sampleIdx = Math.round(((2.8 + n) * 1e-3) / fastDt)
      const tens = evaluateSegment7(
        [
          fastBuffers[0]?.[sampleIdx] ?? 0,
          fastBuffers[1]?.[sampleIdx] ?? 0,
          fastBuffers[2]?.[sampleIdx] ?? 0,
          fastBuffers[3]?.[sampleIdx] ?? 0,
          fastBuffers[4]?.[sampleIdx] ?? 0,
          fastBuffers[5]?.[sampleIdx] ?? 0,
          fastBuffers[6]?.[sampleIdx] ?? 0,
        ],
        1.8,
      ).char
      const ones = evaluateSegment7(
        [
          fastBuffers[7]?.[sampleIdx] ?? 0,
          fastBuffers[8]?.[sampleIdx] ?? 0,
          fastBuffers[9]?.[sampleIdx] ?? 0,
          fastBuffers[10]?.[sampleIdx] ?? 0,
          fastBuffers[11]?.[sampleIdx] ?? 0,
          fastBuffers[12]?.[sampleIdx] ?? 0,
          fastBuffers[13]?.[sampleIdx] ?? 0,
        ],
        1.8,
      ).char
      expect(`${tens}${ones}`, `count state #${n} at ${(2.8 + n).toFixed(1)} ms`).toBe(String(n % 100).padStart(2, '0'))
    }

    // 6. 未供电（去掉 +5V 连线）时数码管 14 段全灭
    const unpoweredAssembled = assembleNetlist({
      title: 'T1.11 SD-10 unpowered',
      modules: [{ instanceId: 'dig1', module: digMod, subckt: digCir }],
      instruments: [defaultIns('ins-dc-power', dcPower, {})],
      wires: [{ a: 'ins-dc-power.V5N', b: 'dig1.GND' }],
      ground: 'ins-dc-power.V5N',
      controlValues: { 'dig1.CLK_RATE': 2, 'dig1.RST_SW': 0 },
      analysis: [],
    })
    const offValues = await runSessionOp({
      type: 'load',
      requestId: 'sd10-off',
      netlist: unpoweredAssembled.netlist,
      probes: fastProbes,
      analysis: { kind: 'op' },
    })
    const offOnes = [7, 8, 9, 10, 11, 12, 13].map((i) => offValues[`s${i}`] ?? 0) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    expect(evaluateSegment7(offOnes, 1.8).mask).toBe(0)
  }, 60_000)
})
