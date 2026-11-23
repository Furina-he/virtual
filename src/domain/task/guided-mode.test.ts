import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, Module, Project } from '../../shared/schema/index.ts'
import { getInstrumentDefaults } from '../instruments/index.ts'
import { buildMeasurementPlan } from '../measurement/plan.ts'
import {
  buildStepViewList,
  canToggleReferenceOverlay,
  effectiveReferenceNets,
  evaluateTableSanity,
  findNextIncompleteRow,
  normalizeQuestionAnswers,
  recordMultiRowReading,
  resolveFocusedStep,
  resolveGuideModePolicy,
  updateQuestionAnswer,
} from './guided-mode.ts'
import type { MeasurementSnapshot } from './measurements.ts'
import { completeTaskStep, createTaskState, writeTableCell } from './progress.ts'

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const ampMod = Module.parse(load('content/modules/mod-analog-amp/module.json'))
const ampCir = readFileSync('content/modules/mod-analog-amp/module.cir', 'utf8')
const psu = Instrument.parse(load('content/instruments/ins-dc-power/instrument.json'))
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))
const mm = Instrument.parse(load('content/instruments/ins-multimeter/instrument.json'))
const md07 = Project.parse(load('content/projects/MD-07/project.json'))

function makeSnapshot(ucValue: number, dualMeters = false): MeasurementSnapshot {
  const wires = [
    { a: 'ins-dc-power.CH1P', b: 'amp1.AMP_VCC' },
    { a: 'ins-dc-power.CH1N', b: 'amp1.AMP_GND1' },
    { a: 'ins-dc-voltmeter.POS', b: 'amp1.AMP_UC' },
    { a: 'ins-dc-voltmeter.NEG', b: 'amp1.AMP_GND1' },
    ...(dualMeters
      ? [
          { a: 'meter1.VOHM', b: 'amp1.AMP_UC' },
          { a: 'meter1.COM', b: 'amp1.AMP_GND1' },
        ]
      : []),
  ]
  const plan = buildMeasurementPlan(
    {
      title: 'guided-mode-test',
      modules: [{ instanceId: 'amp1', module: ampMod, subckt: ampCir }],
      instruments: [
        { instanceId: 'ins-dc-power', instrument: psu, settings: { ...getInstrumentDefaults(psu), ch1_v: 12 } },
        { instanceId: 'ins-dc-voltmeter', instrument: vm, settings: { ...getInstrumentDefaults(vm), range: 'r20' } },
        ...(dualMeters
          ? [{ instanceId: 'meter1', instrument: mm, settings: { ...getInstrumentDefaults(mm), range: 'dcv20' } }]
          : []),
      ],
      wires,
      controlValues: { 'amp1.RW': 22000, 'amp1.KCE': 1 },
      analysis: [],
    },
    true,
    'gm1',
  )
  return {
    current: true,
    plan,
    readings: {
      'ins-dc-voltmeter': { status: 'ok', value: ucValue },
      ...(dualMeters ? { meter1: { status: 'ok', value: ucValue } } : {}),
    },
  }
}

describe('T1.5 TSK-01/TSK-03/TSK-07/WIR-08 步骤引导、多行数据表记录与引导/自主模式策略', () => {
  it('TSK-07 / WIR-08 引导模式开放参考接线虚线与过程提示，自主模式强制隐藏参考虚线但保留安全与手动检查', () => {
    const state = createTaskState(md07)
    const guided = resolveGuideModePolicy('guided')
    expect(guided.allowReferenceOverlay).toBe(true)
    expect(guided.showProcessHints).toBe(true)
    expect(guided.retainSafetyAlerts).toBe(true)
    expect(guided.allowManualWiringCheck).toBe(true)
    expect(effectiveReferenceNets(md07, state, 'guided')?.length).toBeGreaterThan(0)
    expect(canToggleReferenceOverlay('guided', effectiveReferenceNets(md07, state, 'guided'))).toEqual({
      allowed: true,
    })

    const free = resolveGuideModePolicy('free')
    expect(free.allowReferenceOverlay).toBe(false)
    expect(free.showProcessHints).toBe(false)
    expect(free.retainSafetyAlerts).toBe(true)
    expect(free.allowManualWiringCheck).toBe(true)
    expect(effectiveReferenceNets(md07, state, 'free')).toBeUndefined()
    const denied = canToggleReferenceOverlay('free', md07.reference.nets)
    expect(denied.allowed).toBe(false)
    if (!denied.allowed) expect(denied.message).toContain('自主模式')
  })

  it('TSK-07 支持步骤高亮、顺序推进与任意历史步骤聚焦回看', () => {
    let state = createTaskState(md07)
    const initialViews = buildStepViewList(md07, state)
    expect(initialViews[0]?.status).toBe('current')
    expect(initialViews[0]?.focused).toBe(true)
    expect(initialViews[1]?.status).toBe('pending')

    state = completeTaskStep(md07, state, 'wire', { wiringCorrect: true }).state
    state = completeTaskStep(md07, state, 'draw-fault').state
    const progressedViews = buildStepViewList(md07, state)
    expect(progressedViews[0]?.status).toBe('completed')
    expect(progressedViews[1]?.status).toBe('completed')
    expect(progressedViews[2]?.status).toBe('current')
    expect(progressedViews[2]?.focused).toBe(true)

    // 回看已完成的第一步 wire
    const reviewed = buildStepViewList(md07, state, 'wire')
    expect(reviewed[0]?.focused).toBe(true)
    expect(reviewed[2]?.focused).toBe(false)
    expect(resolveFocusedStep(md07, state, 'wire')?.id).toBe('wire')
  })

  it('TSK-03 支持多行数据表下一空行自动定位、连续快捷记录、多来源歧义提示与合理性超界校验', () => {
    let state = createTaskState(md07)
    state = completeTaskStep(md07, state, 'wire', { wiringCorrect: true }).state
    state = completeTaskStep(md07, state, 'draw-fault').state

    expect(findNextIncompleteRow(md07, state, 'fault_points', 0)).toBe(0)

    // 第 1 次快捷记录到下一空行（第 0 行）并自动推进建议行到第 1 行
    const r0 = recordMultiRowReading(md07, state, 'fault_points', {
      targetRow: 'next',
      currentRow: 0,
      snapshot: makeSnapshot(5.87),
      advanceRow: true,
    })
    expect(r0.ok).toBe(true)
    expect(r0.recordedRow).toBe(0)
    expect(r0.nextSelectedRow).toBe(1)
    expect(r0.state.tables.fault_points?.[0]?.uc).toBeCloseTo(5.87, 5)
    state = r0.state

    // 第 2 次快捷记录到下一空行（第 1 行）并自动推进建议行到第 2 行
    const r1 = recordMultiRowReading(md07, state, 'fault_points', {
      targetRow: 'next',
      currentRow: 0,
      snapshot: makeSnapshot(11.98),
      advanceRow: true,
      advanceStep: false,
    })
    expect(r1.ok).toBe(true)
    expect(r1.recordedRow).toBe(1)
    expect(r1.nextSelectedRow).toBe(2)
    expect(r1.state.tables.fault_points?.[1]?.uc).toBeCloseTo(11.98, 5)
    state = r1.state

    // 多来源连接同一测点且未指定来源时返回歧义候选
    const ambiguous = recordMultiRowReading(md07, state, 'fault_points', {
      targetRow: 2,
      snapshot: makeSnapshot(3.53, true),
    })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ambiguousCandidates).toEqual(['ins-dc-voltmeter', 'meter1'])

    // 指定来源仪表后成功写入第 2 行
    const resolved = recordMultiRowReading(md07, state, 'fault_points', {
      targetRow: 2,
      snapshot: makeSnapshot(3.53, true),
      selectedMeters: { uc: 'meter1' },
    })
    expect(resolved.ok).toBe(true)
    expect(resolved.state.tables.fault_points?.[2]?.uc).toBeCloseTo(3.53, 5)
    state = resolved.state

    // 手填明显不合理数值触发 sanity 超界告警
    const badWrite = writeTableCell(md07, state, 'fault_points', 0, 'vcc', 24)
    expect(badWrite.ok).toBe(true)
    const violations = evaluateTableSanity(md07, badWrite.state, 'fault_points')
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableId: 'fault_points',
          row: 0,
          columnId: 'vcc',
        }),
      ]),
    )
  })

  it('TSK-01 支持思考题作答初始化、更新与越界拒绝', () => {
    const initial = normalizeQuestionAnswers(md07)
    expect(Object.keys(initial)).toHaveLength(md07.questions.length)
    const updated = updateQuestionAnswer(md07, initial, 0, '需要结合 UB 和 UE 区分上偏置断路与 RC 短路。')
    expect(updated.ok).toBe(true)
    expect(updated.answers['0']).toContain('UB 和 UE')
    expect(updateQuestionAnswer(md07, updated.answers, 99, '越界').ok).toBe(false)
  })
})
