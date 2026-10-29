import { describe, expect, it } from 'vitest'
import { Module } from './module.ts'

const base = {
  id: 'mod-live',
  name: '可调电路',
  form: 'board',
  model: 'module.glb',
  netlist: 'module.cir',
  jacks: [
    { id: 'OUT', label: '输出', kind: 'banana4' },
    { id: 'GND', label: '地', kind: 'banana4' },
  ],
  controls: [
    {
      id: 'RW',
      label: '偏置电阻',
      param: 'rw',
      kind: 'pot',
      range: [0, 100000],
      step: 1000,
      unit: 'Ω',
      default: 50000,
    },
  ],
  simulation: { analysis: 'tran', maxStep: 1e-6, pacing: 'realtime' },
  indicators: [{ id: 'SPK', kind: 'speaker', between: ['OUT', 'GND'], audio: { fullScale: 5 } }],
}

describe('shared module runtime content', () => {
  it('accepts data-driven controls, transient constraints and real speaker terminals', () => {
    const module = Module.parse(base)
    expect(module.simulation).toEqual(base.simulation)
    expect(module.indicators[0]).toEqual(base.indicators[0])
    expect(module.controls[0]?.label).toBe('偏置电阻')
  })

  it.each([
    { simulation: { analysis: 'op', maxStep: 1e-6 } },
    { simulation: { analysis: 'tran', maxStep: 0 } },
    { simulation: { analysis: 'tran', maxStep: Number.POSITIVE_INFINITY } },
    { simulation: { analysis: 'tran', maxStep: 1e-6, pacing: 'fast' } },
    { indicators: [{ id: 'SPK', kind: 'speaker', probe: 'arbitrary-command' }] },
    { indicators: [{ id: 'SPK', kind: 'speaker', between: ['OUT', 'UNKNOWN'], audio: { fullScale: 5 } }] },
    { indicators: [{ id: 'SPK', kind: 'speaker', between: ['OUT', 'OUT'], audio: { fullScale: 5 } }] },
    { indicators: [{ id: 'SPK', kind: 'speaker', between: ['OUT', 'GND'], audio: { fullScale: 0 } }] },
    { controls: [{ ...base.controls[0], range: undefined }] },
    { controls: [{ ...base.controls[0], stepLabels: ['开', '关'] }] },
    { controls: [{ ...base.controls[0], steps: [0, 0], default: 0, step: undefined, range: undefined }] },
    { controls: [{ ...base.controls[0] }, { ...base.controls[0], id: 'OTHER' }] },
  ])('rejects invalid runtime declarations %#', (patch) => {
    expect(Module.safeParse({ ...base, ...patch }).success).toBe(false)
  })

  it('keeps existing non-speaker probe declarations and optional runtime fields compatible', () => {
    const module = Module.parse({
      ...base,
      simulation: undefined,
      controls: [],
      indicators: [{ id: 'LED', kind: 'led', probe: 'out' }],
    })
    expect(module.indicators).toEqual([{ id: 'LED', kind: 'led', probe: 'out' }])
    expect(module.simulation).toBeUndefined()
  })

  it('requires switch labels to correspond to their unique content values', () => {
    const control = {
      id: 'SW',
      kind: 'switch',
      param: 'sw',
      steps: [0, 1],
      stepLabels: ['断开', '接入'],
      default: 0,
      unit: '',
    }
    expect(Module.safeParse({ ...base, controls: [control] }).success).toBe(true)
    expect(Module.safeParse({ ...base, controls: [{ ...control, stepLabels: ['断开'] }] }).success).toBe(false)
  })

  it('accepts explicit positive resistor mappings and rejects ambiguous targets', () => {
    const control = { ...base.controls[0], targets: [{ element: 'RW', min: 0.001 }] }
    expect(Module.safeParse({ ...base, controls: [control] }).success).toBe(true)
    expect(Module.safeParse({ ...base, controls: [control, { ...control, id: 'OTHER', param: 'RW' }] }).success).toBe(
      false,
    )
    expect(Module.safeParse({ ...base, controls: [{ ...control, targets: [{ element: 'quit;RW' }] }] }).success).toBe(
      false,
    )
    expect(
      Module.safeParse({ ...base, controls: [{ ...control, targets: [{ element: 'RW', values: [1, 2] }] }] }).success,
    ).toBe(false)
    const switchControl = {
      id: 'SW',
      kind: 'switch',
      param: 'sw',
      steps: [0, 1],
      default: 0,
      unit: '',
      targets: [{ element: 'R_SW', values: [1e12, 0.001] }],
    }
    expect(Module.safeParse({ ...base, controls: [switchControl] }).success).toBe(true)
  })
})
