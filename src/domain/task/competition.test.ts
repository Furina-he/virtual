import { describe, expect, it } from 'vitest'
import { Project } from '../../shared/schema/project.ts'
import { createCompetitionState, evaluateCompetition, startCompetition, tickCompetition } from './competition.ts'
import type { MeasurementSnapshot } from './measurements.ts'

const demoProject = Project.parse({
  id: 'MD-18',
  group: '波形发生',
  title: '竞赛测试',
  type: 'basic',
  modules: [{ instanceId: 'oa1', moduleId: 'mod-opamp', slot: 'SLOT_BOX_L1' }],
  allowedInstruments: ['ins-oscilloscope'],
  reference: {
    nets: [['ins-dc-power.CH1P', 'oa1.OA_VP']],
    measurePoints: [
      { id: 'f_sq', kind: 'waveform', quantity: 'frequency', between: ['oa1.FG_SQ', 'oa1.OA_GND1'] },
      { id: 'u_sin', kind: 'waveform', quantity: 'vpp', between: ['oa1.FG_SIN', 'oa1.OA_GND1'] },
    ],
  },
  steps: [{ id: 's1', text: '调试输出' }],
  competition: {
    title: '函数发生器竞赛指标',
    timeLimitSec: 600,
    brief: '输出 1.5 kHz、4.0 Vpp 正弦波',
    criteria: [
      { id: 'c_freq', label: '振荡频率', measurePoint: 'f_sq', unit: 'Hz', target: 1500, min: 1350, max: 1650 },
      { id: 'c_amp', label: '正弦幅值', measurePoint: 'u_sin', unit: 'V', target: 4.0, min: 3.4, max: 4.6 },
    ],
  },
  questions: ['Q1'],
})

const makeSnapshot = (freq: number | null, vpp: number | null): MeasurementSnapshot => ({
  current: true,
  plan: {
    command: { type: 'load', netlist: '', probes: [], analysis: { kind: 'op' } },
    pacing: { type: 'setPacing', mode: 'realtime' },
    parameters: [],
    speakers: [],
    segment7s: [],
    scopes: [],
    assembled: { netlist: '', nodeOf: {}, nets: [], instrumentSuffix: {} },
    meters: [],
    supplies: [],
    checkInput: {
      modules: [
        {
          instanceId: 'oa1',
          module: {
            id: 'mod-opamp',
            name: '运放',
            form: 'box',
            model: 'm.glb',
            netlist: 'm.cir',
            jacks: [
              { id: 'FG_SQ', label: 'SQ', kind: 'banana4' },
              { id: 'FG_SIN', label: 'SIN', kind: 'banana4' },
              { id: 'OA_GND1', label: 'GND', kind: 'banana4' },
            ],
            controls: [],
            indicators: [],
          },
        },
      ],
      instruments: [],
      wires: [],
    },
    needsPreflight: false,
  },
  readings: {},
  waveforms: [
    ...(freq !== null
      ? [
          {
            instanceId: 'scope1',
            channelId: 'CH1',
            positiveRef: 'oa1.FG_SQ',
            negativeRef: 'oa1.OA_GND1',
            coupling: 'dc' as const,
            current: true,
            measurement: {
              vpp: 20,
              min: -10,
              max: 10,
              mean: 0,
              frequency: freq,
              period: 1 / freq,
              completeCycles: 4,
            },
          },
        ]
      : []),
    ...(vpp !== null
      ? [
          {
            instanceId: 'scope1',
            channelId: 'CH2',
            positiveRef: 'oa1.FG_SIN',
            negativeRef: 'oa1.OA_GND1',
            coupling: 'dc' as const,
            current: true,
            measurement: {
              vpp,
              min: -vpp / 2,
              max: vpp / 2,
              mean: 0,
              frequency: 1500,
              period: 1 / 1500,
              completeCycles: 4,
            },
          },
        ]
      : []),
  ],
})

describe('TSK-08 竞赛任务领域状态机（competition.ts）', () => {
  it('按真实实测快照逐项核验达成度、支持限时倒计时与超时判定', () => {
    const spec = demoProject.competition
    if (!spec) throw new Error('missing competition spec')
    const idle = createCompetitionState(spec)
    expect(idle.status).toBe('idle')
    expect(idle.remainingSec).toBe(600)

    const running = startCompetition(spec, 10_000)
    expect(running.status).toBe('running')

    // 仅频率超标、幅值达标 -> 1/2 (50%)
    const partial = evaluateCompetition(demoProject, running, makeSnapshot(1000, 4.0), 40_000)
    expect(partial.status).toBe('running')
    expect(partial.passedCount).toBe(1)
    expect(partial.scorePct).toBe(50)
    expect(partial.elapsedSec).toBe(30)

    // 调频至 1510 Hz 后再次核验 -> 2/2 (100%, passed)
    const passed = evaluateCompetition(demoProject, partial, makeSnapshot(1510, 4.05), 70_000)
    expect(passed.status).toBe('passed')
    expect(passed.passedCount).toBe(2)
    expect(passed.scorePct).toBe(100)

    // 超时未达标 -> expired
    const expired = tickCompetition(spec, partial, 10_000 + 601_000)
    expect(expired.status).toBe('expired')
    expect(expired.remainingSec).toBe(0)
  })
})
