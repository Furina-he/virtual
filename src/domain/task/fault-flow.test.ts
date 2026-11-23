import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, Module, Project } from '../../shared/schema/index.ts'
import { buildMeasurementPlan } from '../measurement/plan.ts'
import {
  createFaultFlowState,
  faultCandidateTargets,
  faultStepStatuses,
  observeFaultSymptom,
  recordFaultMeasurement,
  repairFault,
  startFaultSession,
  submitFaultDiagnosis,
  verifyFaultRepair,
} from './fault-flow.ts'
import type { MeasurementSnapshot } from './measurements.ts'

const project = Project.parse(JSON.parse(readFileSync('content/projects/MD-07/project.json', 'utf8')))
const ampMod = Module.parse(JSON.parse(readFileSync('content/modules/mod-analog-amp/module.json', 'utf8')))
const ampCir = readFileSync('content/modules/mod-analog-amp/module.cir', 'utf8')
const psu = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-dc-power/instrument.json', 'utf8')))
const vm = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-dc-voltmeter/instrument.json', 'utf8')))

function makeSnapshot(ucValue: number, current = true): MeasurementSnapshot {
  const plan = buildMeasurementPlan(
    {
      title: 'md07-test',
      modules: [{ instanceId: 'amp1', module: ampMod, subckt: ampCir }],
      instruments: [
        { instanceId: 'ins-dc-power', instrument: psu, settings: { ch1_v: 12 } },
        { instanceId: 'ins-dc-voltmeter', instrument: vm, settings: { range: 'r20' } },
      ],
      wires: [
        { a: 'ins-dc-power.CH1P', b: 'amp1.AMP_VCC' },
        { a: 'ins-dc-power.CH1N', b: 'amp1.AMP_GND1' },
        { a: 'ins-dc-voltmeter.POS', b: 'amp1.AMP_UC' },
        { a: 'ins-dc-voltmeter.NEG', b: 'amp1.AMP_GND1' },
      ],
      controlValues: { 'amp1.RW': 22000, 'amp1.KCE': 1 },
      analysis: [],
    },
    true,
    't1',
  )
  return {
    current,
    plan,
    readings: {
      'ins-dc-voltmeter': { status: 'ok', value: ucValue },
    },
  }
}

describe('T1.4 FLT-01~05 排故流程状态机与过程记录', () => {
  it('FLT-01/FLT-02 支持系统预设、随机抽取与教师指定，上电时拒绝热切换故障', () => {
    expect(project.faults?.length).toBeGreaterThanOrEqual(5)
    expect(faultCandidateTargets(project)).toContain('amp1.RB1')
    expect(faultCandidateTargets(project)).toContain('amp1.QVT1')

    const initial = createFaultFlowState()
    const hotSwap = startFaultSession(project, initial, { mode: 'preset', faultId: 'f-rb1-open', powered: true })
    expect(hotSwap.ok).toBe(false)
    expect(hotSwap.state.stage).toBe('idle')

    const preset = startFaultSession(project, initial, {
      mode: 'preset',
      faultId: 'f-rc-short',
      powered: false,
      nowMs: 1000,
    })
    expect(preset.ok).toBe(true)
    expect(preset.state.stage).toBe('observe')
    expect(preset.state.activeFaultId).toBe('f-rc-short')
    expect(preset.state.injectedFaultId).toBe('f-rc-short')

    const teacher = startFaultSession(project, initial, {
      mode: 'teacher',
      faultId: 'f-vt1-dead',
      powered: false,
      nowMs: 2000,
    })
    expect(teacher.ok).toBe(true)
    expect(teacher.state.mode).toBe('teacher')
    expect(teacher.state.activeFaultId).toBe('f-vt1-dead')

    const random = startFaultSession(project, initial, {
      mode: 'random',
      powered: false,
      random: () => 0.99,
      nowMs: 3000,
    })
    expect(random.ok).toBe(true)
    expect(random.state.mode).toBe('random')
    expect(random.state.activeFaultId).toBe(project.faults?.at(-1)?.id)
  })

  it('FLT-03/FLT-05 完整走通六步状态机：禁止未测盲猜、统计误判/测量次数/用时、未上电验证不可结项', () => {
    let flow = createFaultFlowState()
    const started = startFaultSession(project, flow, {
      mode: 'preset',
      faultId: 'f-rb1-open',
      powered: false,
      nowMs: 10_000,
    })
    expect(started.ok).toBe(true)
    flow = started.state
    expect(faultStepStatuses(flow).find((s) => s.id === 'observe')?.status).toBe('current')

    // 未上电不能确认观察现象
    expect(observeFaultSymptom(project, flow, { powered: false, nowMs: 11_000 }).ok).toBe(false)
    const observed = observeFaultSymptom(project, flow, { powered: true, nowMs: 11_000 })
    expect(observed.ok).toBe(true)
    flow = observed.state
    expect(flow.stage).toBe('measure')

    // 未记录任何测量前拒绝提交故障判定
    const blindSubmit = submitFaultDiagnosis(project, flow, { target: 'amp1.RB1', kind: 'open', nowMs: 12_000 })
    expect(blindSubmit.ok).toBe(false)
    expect(blindSubmit.state.wrongAttempts).toBe(0)

    // 记录一次异常测量（UC=12.0 V）
    const m1 = recordFaultMeasurement(project, flow, { snapshot: makeSnapshot(12.0), nowMs: 13_000 })
    expect(m1.ok).toBe(true)
    flow = m1.state
    expect(flow.measurementCount).toBe(1)

    // 提交错误故障点/类型 -> 误判次数 +1，仍保持注入且不可修复
    const wrong1 = submitFaultDiagnosis(project, flow, { target: 'amp1.RC', kind: 'short', nowMs: 15_000 })
    expect(wrong1.ok).toBe(false)
    flow = wrong1.state
    expect(flow.wrongAttempts).toBe(1)
    expect(flow.lastVerdict?.correct).toBe(false)
    expect(flow.lastVerdict?.hint).toContain('RB1')
    expect(flow.injectedFaultId).toBe('f-rb1-open')
    expect(faultStepStatuses(flow).find((s) => s.id === 'judge')?.status).toBe('failed')
    expect(repairFault(project, flow, { powered: false, nowMs: 15_500 }).ok).toBe(false)

    // 提交正确故障点与类型 -> 进入 repair，但故障注入仍未撤除
    const right = submitFaultDiagnosis(project, flow, { target: 'amp1.RB1', kind: 'open', nowMs: 17_000 })
    expect(right.ok).toBe(true)
    flow = right.state
    expect(flow.stage).toBe('repair')
    expect(flow.injectedFaultId).toBe('f-rb1-open')
    expect(verifyFaultRepair(project, flow, { powered: true, snapshot: makeSnapshot(5.87), nowMs: 17_500 }).ok).toBe(
      false,
    )

    // 带电时禁止更换修复
    expect(repairFault(project, flow, { powered: true, nowMs: 18_000 }).ok).toBe(false)

    // 断电修复 -> 撤除故障注入，进入 verify，但仍未结项！
    const repaired = repairFault(project, flow, { powered: false, nowMs: 19_000 })
    expect(repaired.ok).toBe(true)
    flow = repaired.state
    expect(flow.stage).toBe('verify')
    expect(flow.injectedFaultId).toBeUndefined()
    expect(flow.resolvedFaultIds).not.toContain('f-rb1-open')
    expect(flow.history).toHaveLength(0)

    // 未上电或读数仍异常（如 UC=12.0 V）均不可验证结项
    expect(verifyFaultRepair(project, flow, { powered: false, snapshot: makeSnapshot(5.87), nowMs: 20_000 }).ok).toBe(
      false,
    )
    expect(verifyFaultRepair(project, flow, { powered: true, snapshot: makeSnapshot(11.95), nowMs: 21_000 }).ok).toBe(
      false,
    )

    // 上电且实测恢复正常（UC=5.87 V） -> 验证通过并结项
    const verified = verifyFaultRepair(project, flow, {
      powered: true,
      snapshot: makeSnapshot(5.87),
      nowMs: 24_500,
    })
    expect(verified.ok).toBe(true)
    flow = verified.state
    expect(flow.stage).toBe('completed')
    expect(flow.resolvedFaultIds).toEqual(['f-rb1-open'])
    expect(flow.measurementCount).toBe(2)
    expect(flow.wrongAttempts).toBe(1)
    expect(flow.elapsedMs).toBe(14_500)
    expect(flow.history).toHaveLength(1)
    expect(flow.history[0]).toMatchObject({
      faultId: 'f-rb1-open',
      target: 'amp1.RB1',
      kind: 'open',
      measurementCount: 2,
      wrongAttempts: 1,
      elapsedMs: 14_500,
    })
    expect(faultStepStatuses(flow).every((step) => step.status === 'completed')).toBe(true)
  })

  it('MD-07 全部 6 个故障依次随机抽取不重复且均可完整走通结项', () => {
    let flow = createFaultFlowState()
    const faults = project.faults ?? []
    expect(faults.length).toBe(6)
    let now = 1000
    for (let i = 0; i < faults.length; i++) {
      const start = startFaultSession(project, flow, {
        mode: 'random',
        powered: false,
        random: () => 0,
        nowMs: now,
      })
      expect(start.ok).toBe(true)
      flow = start.state
      const active = faults.find((f) => f.id === flow.activeFaultId)
      expect(active).toBeDefined()
      if (!active) break
      now += 1000
      flow = recordFaultMeasurement(project, flow, { snapshot: makeSnapshot(11.5), nowMs: now }).state
      now += 1000
      const judged = submitFaultDiagnosis(project, flow, {
        target: active.target,
        kind: active.kind,
        nowMs: now,
      })
      expect(judged.ok).toBe(true)
      now += 1000
      flow = repairFault(project, judged.state, { powered: false, nowMs: now }).state
      now += 1000
      const done = verifyFaultRepair(project, flow, {
        powered: true,
        snapshot: makeSnapshot(5.87),
        nowMs: now,
      })
      expect(done.ok).toBe(true)
      flow = done.state
    }
    expect(flow.resolvedFaultIds).toHaveLength(6)
    expect(new Set(flow.resolvedFaultIds).size).toBe(6)
    expect(flow.history).toHaveLength(6)
  })
})
