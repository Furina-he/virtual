import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument } from '../../shared/schema/instrument.ts'
import { Module } from '../../shared/schema/module.ts'
import type { AssembleInput } from '../circuit/assemble.ts'
import { moduleControlValid, moduleParameterName, moduleParameters } from '../circuit/module-controls.ts'
import { getInstrumentDefaults } from '../instruments/index.ts'
import { buildMeasurementPlan, moduleControlChanges, SPEAKER_MAX_STEP } from './plan.ts'

const load = (id: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${id}/instrument.json`, 'utf8')))
const source = load('ins-dc-power')
const scope = load('ins-oscilloscope')
const module = Module.parse({
  id: 'mod-parameter',
  name: '公共参数电路',
  form: 'board',
  model: 'module.glb',
  netlist: 'module.cir',
  jacks: [
    { id: 'VCC', label: '电源', kind: 'banana4' },
    { id: 'OUT', label: '输出', kind: 'banana4' },
    { id: 'GND', label: '地', kind: 'banana4' },
  ],
  controls: [
    { id: 'RW', param: 'rw', kind: 'pot', label: '电位器', range: [1000, 10000], step: 1000, unit: 'Ω', default: 5000 },
  ],
  simulation: { analysis: 'tran', maxStep: 1e-6, pacing: 'window' },
})
const subckt = '.subckt PARAMETER VCC OUT GND params: rw=5000\nR1 VCC OUT {rw}\nR2 OUT GND 1000\n.ends PARAMETER'
function input(): AssembleInput {
  return {
    title: 'Public module runtime',
    modules: [{ instanceId: 'board-1', module, subckt }],
    instruments: [{ instanceId: 'source', instrument: source, settings: { ch1_v: 6 } }],
    wires: [
      { a: 'source.CH1P', b: 'board-1.VCC' },
      { a: 'source.CH1N', b: 'board-1.GND' },
    ],
    controlValues: {},
    analysis: [],
  }
}

describe('module runtime plan', () => {
  it('declares continuous analysis without requiring a placed scope or generator', () => {
    const plan = buildMeasurementPlan(input(), true, 'live')
    expect(plan.command.analysis).toEqual({ kind: 'tran', step: 1e-6, continuous: true })
    expect(plan.parameters).toEqual([{ controlRef: 'board-1.RW', param: 'p_board_1_rw', value: 5000 }])
    expect(plan.command.netlist).toContain('.param p_board_1_rw=5000')
    expect(plan.speakers).toEqual([])
  })

  it('maps declared numeric changes to alter values with no project-ID behavior', () => {
    const previous = input()
    const next = { ...previous, controlValues: { 'board-1.RW': 8000 } }
    const a = buildMeasurementPlan(previous, true, 'live')
    const b = buildMeasurementPlan(next, true, 'live')
    expect(moduleControlChanges(a, b)).toEqual([{ param: 'p_board_1_rw', value: 8000 }])
    expect(moduleControlChanges(a, a)).toEqual([])
    expect(a.command.probes).toEqual(b.command.probes)
    expect(moduleParameterName('board-1', 'rw')).toBe('p_board_1_rw')
  })

  it.each(['wires', 'source', 'step', 'definition', 'preflight'] as const)(
    'requires a load for %s changes',
    (change) => {
      const previous = input()
      const next = structuredClone(previous)
      const board = next.modules[0]
      const supply = next.instruments[0]
      if (!board?.module.simulation || !supply) throw new Error('Missing module fixture')
      next.controlValues['board-1.RW'] = 8000
      if (change === 'wires') next.wires.push({ a: 'board-1.OUT', b: 'board-1.VCC' })
      if (change === 'source') supply.settings.ch1_v = 12
      if (change === 'step') board.module.simulation.maxStep = 5e-7
      if (change === 'definition') board.subckt = subckt.replace('1000\n.ends', '2000\n.ends')
      const a = buildMeasurementPlan(previous, true, 'live')
      const b = buildMeasurementPlan(next, true, 'live', change === 'preflight' ? { preflight: true } : {})
      expect(moduleControlChanges(a, b)).toBeUndefined()
    },
  )

  it('gives a real speaker and realtime modules priority over a long scope window', () => {
    const learner = input()
    const board = learner.modules[0]
    if (!board) throw new Error('Missing module fixture')
    board.module = Module.parse({
      ...module,
      indicators: [{ id: 'SPK', kind: 'speaker', between: ['OUT', 'GND'], audio: { fullScale: 5 } }],
      simulation: { analysis: 'tran', maxStep: 1e-4, pacing: 'window' },
    })
    learner.instruments.push({
      instanceId: 'scope1',
      instrument: scope,
      settings: { ...getInstrumentDefaults(scope), tdiv: 1 },
    })
    learner.wires.push({ a: 'scope1.CH1', b: 'board-1.OUT' }, { a: 'scope1.GND', b: 'board-1.GND' })
    const plan = buildMeasurementPlan(learner, true, 'live')
    expect(plan.pacing).toEqual({ type: 'setPacing', mode: 'realtime' })
    expect(plan.command.analysis.kind).toBe('tran')
    if (plan.command.analysis.kind === 'tran') expect(plan.command.analysis.step).toBeLessThanOrEqual(SPEAKER_MAX_STEP)
    expect(plan.speakers).toEqual([
      { instanceId: 'board-1', indicatorId: 'SPK', probe: 'indicator:board-1:SPK', fullScale: 5 },
    ])
    expect(plan.command.probes.find((probe) => probe.id === plan.speakers[0]?.probe)).toEqual({
      id: 'indicator:board-1:SPK',
      kind: 'v',
      node: plan.assembled.nodeOf['board-1.OUT'],
      nodeRef: '0',
    })
    const off = buildMeasurementPlan(learner, false, 'live')
    expect(off.speakers).toEqual([])
    expect(off.command.analysis.kind).toBe('op')
  })

  it('retains explicit low-frequency realtime pacing with a scope and respects hard module step limits', () => {
    const learner = input()
    const board = learner.modules[0]
    if (!board) throw new Error('Missing module fixture')
    board.module = Module.parse({ ...module, simulation: { analysis: 'tran', maxStep: 5e-7 } })
    learner.instruments.push({
      instanceId: 'scope1',
      instrument: scope,
      settings: { ...getInstrumentDefaults(scope), tdiv: 1 },
    })
    learner.wires.push({ a: 'scope1.CH1', b: 'board-1.OUT' }, { a: 'scope1.GND', b: 'board-1.GND' })
    const plan = buildMeasurementPlan(learner, true, 'live')
    expect(plan.pacing.mode).toBe('realtime')
    expect(plan.command.analysis).toMatchObject({ step: 5e-7 })
  })

  it('validates declared ranges, finite values, quantization and safe mapping collisions before compilation', () => {
    const control = module.controls[0]
    if (!control) throw new Error('Missing control fixture')
    for (const value of [0, 10001, 5500, Number.NaN, Number.POSITIVE_INFINITY, '5000'])
      expect(moduleControlValid(control, value)).toBe(false)
    expect(moduleControlValid(control, 5000)).toBe(true)
    expect(() => moduleParameters(input().modules, { 'board-1.RW': 5500 })).toThrow('设置无效')
    const modules = [...input().modules, { instanceId: 'board_1', module, subckt }]
    expect(() => moduleParameters(modules, {})).toThrow('映射重复')
  })

  it('expands complementary and switched resistor targets without evaluating arbitrary circuit expressions', () => {
    const controlled = Module.parse({
      ...module,
      controls: [
        {
          id: 'POT',
          param: 'pot',
          kind: 'pot',
          range: [0, 1],
          default: 0.5,
          unit: '',
          targets: [
            { element: 'R_TOP', scale: -10000, offset: 10000.001, min: 0.001 },
            { element: 'R_BOTTOM', scale: 10000, min: 0.001 },
          ],
        },
        {
          id: 'SW',
          param: 'sw',
          kind: 'switch',
          steps: [0, 1],
          default: 1,
          unit: '',
          targets: [{ element: 'R_SW', values: [1e12, 0.001] }],
        },
      ],
    })
    const parameters = moduleParameters([{ instanceId: 'box1', module: controlled }], { 'box1.POT': 0, 'box1.SW': 0 })
    expect(parameters[0]?.targets).toEqual([
      { element: 'r.xbox1.r_top', value: 10000.001 },
      { element: 'r.xbox1.r_bottom', value: 0.001 },
    ])
    expect(parameters[1]?.targets).toEqual([{ element: 'r.xbox1.r_sw', value: 1e12 }])
    const invalid = Module.parse({
      ...module,
      controls: [{ ...module.controls[0], targets: [{ element: 'RW', scale: -1 }] }],
    })
    expect(() => moduleParameters([{ instanceId: 'box1', module: invalid }], {})).toThrow('电阻目标无效')
  })
})
