import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, Module } from '../../shared/schema/index.ts'
import type { MeasurePoint } from '../../shared/schema/project.ts'
import type { InstrumentInput } from '../circuit/assemble.ts'
import { getInstrumentDefaults } from '../instruments/index.ts'
import { buildMeasurementPlan } from '../measurement/plan.ts'
import { captureMeasurePoint, type MeasurementSnapshot, type ReadingValue, tableValue } from './measurements.ts'

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const module = Module.parse(load('content/modules/mod-dc-circuit/module.json'))
const subckt = readFileSync('content/modules/mod-dc-circuit/module.cir', 'utf8')
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))
const am = Instrument.parse(load('content/instruments/ins-dc-ammeter/instrument.json'))
const mm = Instrument.parse(load('content/instruments/ins-multimeter/instrument.json'))
const instrument = (instanceId: string, definition: Instrument, range?: string): InstrumentInput => ({
  instanceId,
  instrument: definition,
  settings: { ...getInstrumentDefaults(definition), ...(range ? { range } : {}) },
})
const voltage: MeasurePoint = { id: 'u', kind: 'voltage', mode: 'dcv', between: ['dc1.KH_F', 'dc1.KH_A'] }
const current: MeasurePoint = { id: 'i', kind: 'current', mode: 'dca', branch: ['dc1.KH_I1A', 'dc1.KH_I1B'] }
const wires = (pairs: [string, string][]) => pairs.map(([a, b]) => ({ a, b }))
const vWires: [string, string][] = [
  ['vm.POS', 'dc1.KH_F'],
  ['vm.NEG', 'dc1.KH_A'],
]
const iWires: [string, string][] = [
  ['am.POS', 'dc1.KH_I1A'],
  ['am.NEG', 'dc1.KH_I1B'],
]
function snapshot(
  pairs: [string, string][],
  readings: Record<string, ReadingValue> = { vm: { status: 'ok', value: 1.234 }, am: { status: 'ok', value: 0.0025 } },
  instruments = [instrument('vm', vm), instrument('am', am)],
): MeasurementSnapshot {
  return {
    current: true,
    readings,
    plan: buildMeasurementPlan(
      {
        title: 'Task test',
        modules: [{ instanceId: 'dc1', module, subckt }],
        instruments,
        wires: wires(pairs),
        controlValues: {},
        analysis: [],
      },
      true,
      'task',
    ),
  }
}

describe('Capture actual project measurement points', () => {
  it('uses only the finite display-rounded SI value, never rawValue or screen text', () => {
    const reading = { status: 'ok', value: 1.234, rawValue: 123, text: '999' }
    const capture = captureMeasurePoint(snapshot(vWires, { vm: reading }), voltage)
    expect(capture).toMatchObject({
      ok: true,
      measurement: { displayValueSI: 1.234, referenceValueSI: 1.234, reversed: false, instanceId: 'vm' },
    })
  })

  it('accepts equivalent leads through common copper nets', () => {
    expect(
      captureMeasurePoint(
        snapshot([
          ['vm.POS', 'dc1.KH_F'],
          ['vm.NEG', 'dc1.KH_I2A'],
        ]),
        voltage,
      ).ok,
    ).toBe(true)
    const alias: MeasurePoint = { ...current, branch: ['dc1.KH_I1A', 'dc1.KH_A'] }
    expect(captureMeasurePoint(snapshot(iWires), alias).ok).toBe(true)
  })

  it('accepts stacked leads through an unused meter jack without selecting its disconnected reading', () => {
    const state = snapshot(
      [
        ['mm.VOHM', 'dc1.KH_F'],
        ['vm.POS', 'mm.VOHM'],
        ['vm.NEG', 'dc1.KH_I2A'],
      ],
      { vm: { status: 'ok', value: 1.234 }, mm: { status: 'disconnected', value: 999 } },
      [instrument('vm', vm), instrument('mm', mm)],
    )
    expect(captureMeasurePoint(state, voltage)).toMatchObject({
      ok: true,
      measurement: { instanceId: 'vm', referenceValueSI: 1.234 },
    })
  })

  it('preserves reversed voltage display sign while orienting the recorded value', () => {
    const capture = captureMeasurePoint(
      snapshot(
        [
          ['vm.POS', 'dc1.KH_A'],
          ['vm.NEG', 'dc1.KH_F'],
        ],
        { vm: { status: 'ok', value: -1.234 } },
      ),
      voltage,
    )
    expect(capture).toMatchObject({
      ok: true,
      measurement: { displayValueSI: -1.234, referenceValueSI: 1.234, reversed: true },
    })
  })

  it('preserves genuinely negative branch currents and reversed current leads separately', () => {
    const point: MeasurePoint = { ...current, branch: ['dc1.KH_I2A', 'dc1.KH_I2B'] }
    const forward = captureMeasurePoint(
      snapshot(
        [
          ['am.POS', 'dc1.KH_I2A'],
          ['am.NEG', 'dc1.KH_I2B'],
        ],
        { am: { status: 'ok', value: -0.00595 } },
      ),
      point,
    )
    expect(forward).toMatchObject({
      ok: true,
      measurement: { displayValueSI: -0.00595, referenceValueSI: -0.00595, reversed: false },
    })
    const reversed = captureMeasurePoint(
      snapshot(
        [
          ['am.POS', 'dc1.KH_I2B'],
          ['am.NEG', 'dc1.KH_I2A'],
        ],
        { am: { status: 'ok', value: 0.00595 } },
      ),
      point,
    )
    expect(reversed).toMatchObject({
      ok: true,
      measurement: { displayValueSI: 0.00595, referenceValueSI: -0.00595, reversed: true },
    })
  })

  it('rejects partial leads, wrong branch and an unopened socket bypass', () => {
    for (const pairs of [
      iWires.slice(0, 1),
      [
        ['am.POS', 'dc1.KH_I3A'],
        ['am.NEG', 'dc1.KH_I3B'],
      ],
      [
        ['am.POS', 'dc1.KH_I1A'],
        ['am.NEG', 'dc1.KH_A'],
      ],
    ] as [string, string][][])
      expect(captureMeasurePoint(snapshot(pairs), current)).toMatchObject({ ok: false, reason: 'not-connected' })
  })

  it('rejects parallel ammeters because neither measures the whole branch', () => {
    const state = snapshot(
      [...iWires, ['mm.MA', 'dc1.KH_I1A'], ['mm.COM', 'dc1.KH_I1B']],
      { am: { status: 'ok', value: 0.001 }, mm: { status: 'ok', value: 0.001 } },
      [instrument('am', am), instrument('mm', mm, 'dca20m')],
    )
    expect(captureMeasurePoint(state, current)).toMatchObject({ ok: false, reason: 'not-connected' })
  })

  it('does not accept a shorted voltage probe as measuring across a real ammeter burden', () => {
    const state = snapshot([...iWires, ['vm.POS', 'dc1.KH_I1A'], ['vm.NEG', 'dc1.KH_I1A']], {
      vm: { status: 'ok', value: 0 },
    })
    const point: MeasurePoint = { id: 'burden', kind: 'voltage', mode: 'dcv', between: ['dc1.KH_I1A', 'dc1.KH_I1B'] }
    expect(state.plan.assembled.nodeOf['dc1.KH_I1A']).not.toBe(state.plan.assembled.nodeOf['dc1.KH_I1B'])
    expect(captureMeasurePoint(state, point)).toMatchObject({ ok: false, reason: 'not-connected' })
  })

  it('requires explicit selection when multiple voltage meters match', () => {
    const state = snapshot(
      [...vWires, ['mm.VOHM', 'dc1.KH_F'], ['mm.COM', 'dc1.KH_A']],
      { vm: { status: 'ok', value: 1.234 }, mm: { status: 'ok', value: 1.235 } },
      [instrument('vm', vm), instrument('mm', mm, 'dcv20')],
    )
    expect(captureMeasurePoint(state, voltage)).toMatchObject({
      ok: false,
      reason: 'ambiguous',
      candidates: ['vm', 'mm'],
    })
    expect(captureMeasurePoint(state, voltage, 'mm')).toMatchObject({
      ok: true,
      measurement: { instanceId: 'mm', displayValueSI: 1.235 },
    })
    expect(captureMeasurePoint(state, voltage, 'absent')).toMatchObject({ ok: false, reason: 'not-connected' })
  })

  it('rejects stale snapshots before ambiguity and never substitutes a selected pending meter', () => {
    const state = snapshot(
      [...vWires, ['mm.VOHM', 'dc1.KH_F'], ['mm.COM', 'dc1.KH_A']],
      { vm: { status: 'ok', value: 1.234 }, mm: { status: 'pending', value: 1.235 } },
      [instrument('vm', vm), instrument('mm', mm)],
    )
    expect(captureMeasurePoint({ ...state, current: false }, voltage)).toMatchObject({
      ok: false,
      reason: 'not-current',
    })
    expect(captureMeasurePoint(state, voltage)).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(captureMeasurePoint(state, voltage, 'mm')).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(captureMeasurePoint(state, voltage, 'vm')).toMatchObject({ ok: true, measurement: { instanceId: 'vm' } })
  })

  it('requires declared DC/AC mode and does not treat resistance or diode modes as voltage', () => {
    const pairs: [string, string][] = [
      ['mm.VOHM', 'dc1.KH_F'],
      ['mm.COM', 'dc1.KH_A'],
    ]
    const ac = snapshot(pairs, { mm: { status: 'ok', value: 1.1 } }, [instrument('mm', mm, 'acv2')])
    expect(captureMeasurePoint(ac, voltage)).toMatchObject({ ok: false, reason: 'not-connected' })
    expect(captureMeasurePoint(ac, { ...voltage, mode: 'acv' }).ok).toBe(true)
    expect(captureMeasurePoint(ac, { ...voltage, mode: undefined }).ok).toBe(true)
    for (const range of ['ohm200', 'diode'])
      expect(
        captureMeasurePoint(snapshot(pairs, { mm: { status: 'ok', value: 1 } }, [instrument('mm', mm, range)]), voltage)
          .ok,
      ).toBe(false)
  })

  it.each(['acv', 'aca'] as const)('keeps reversed %s RMS magnitude nonnegative', (mode) => {
    const point = mode === 'acv' ? { ...voltage, mode } : { ...current, mode }
    const pairs: [string, string][] =
      mode === 'acv'
        ? [
            ['mm.VOHM', 'dc1.KH_A'],
            ['mm.COM', 'dc1.KH_F'],
          ]
        : [
            ['mm.MA', 'dc1.KH_I1B'],
            ['mm.COM', 'dc1.KH_I1A'],
          ]
    const value = mode === 'acv' ? 1.1 : 0.001
    const result = captureMeasurePoint(
      snapshot(pairs, { mm: { status: 'ok', value } }, [instrument('mm', mm, mode === 'acv' ? 'acv2' : 'aca20m')]),
      point,
    )
    expect(result).toMatchObject({
      ok: true,
      measurement: { displayValueSI: value, referenceValueSI: value, reversed: true },
    })
    if (result.ok) expect(result.message).toContain('有效值')
  })

  it.each(['acv', 'aca'] as const)('rejects impossible negative %s RMS data', (mode) => {
    const point = mode === 'acv' ? { ...voltage, mode } : { ...current, mode }
    const pairs: [string, string][] =
      mode === 'acv'
        ? [
            ['mm.VOHM', 'dc1.KH_F'],
            ['mm.COM', 'dc1.KH_A'],
          ]
        : [
            ['mm.MA', 'dc1.KH_I1A'],
            ['mm.COM', 'dc1.KH_I1B'],
          ]
    const state = snapshot(pairs, { mm: { status: 'ok', value: -0.001 } }, [
      instrument('mm', mm, mode === 'acv' ? 'acv2' : 'aca20m'),
    ])
    expect(captureMeasurePoint(state, point)).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it.each(['pending', 'off', 'error', 'overload', 'invalid', 'disconnected', 'wrong-jacks', 'external-voltage'])(
    'rejects %s readings',
    (status) => {
      expect(captureMeasurePoint(snapshot(vWires, { vm: { status, value: 1.234 } }), voltage)).toMatchObject({
        ok: false,
        reason: 'unavailable',
      })
    },
  )

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid value %s',
    (value) => {
      expect(captureMeasurePoint(snapshot(vWires, { vm: { status: 'ok', value } }), voltage)).toMatchObject({
        ok: false,
        reason: 'unavailable',
      })
    },
  )

  it('rejects stale/missing snapshots and plans without actual meter probes', () => {
    const state = snapshot(vWires)
    expect(captureMeasurePoint({ ...state, current: false }, voltage)).toMatchObject({
      ok: false,
      reason: 'not-current',
    })
    expect(captureMeasurePoint(undefined, voltage)).toMatchObject({ ok: false, reason: 'not-current' })
    const noProbe = {
      ...state,
      plan: { ...state.plan, meters: state.plan.meters.map((meter) => ({ ...meter, voltageProbe: undefined })) },
    }
    expect(captureMeasurePoint(noProbe, voltage)).toMatchObject({ ok: false, reason: 'not-connected' })
  })

  it('does not claim waveform recording and rejects unknown reference owners', () => {
    expect(captureMeasurePoint(snapshot(vWires), { ...voltage, kind: 'waveform', mode: undefined })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    })
    expect(captureMeasurePoint(snapshot(vWires), { ...voltage, between: ['missing.KH_F', 'dc1.KH_A'] }).ok).toBe(false)
  })

  it('normalizes zero without inventing a negative-zero recorded current', () => {
    const result = captureMeasurePoint(
      snapshot(
        [
          ['am.POS', 'dc1.KH_I1B'],
          ['am.NEG', 'dc1.KH_I1A'],
        ],
        { am: { status: 'ok', value: 0 } },
      ),
      current,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.is(result.measurement.referenceValueSI, 0)).toBe(true)
  })

  it('converts SI only into compatible column units and preserves the reference sign', () => {
    const measurement = {
      measurePoint: 'i',
      instanceId: 'am',
      displayValueSI: 0.00595,
      referenceValueSI: -0.00595,
      reversed: true,
    }
    expect(tableValue(current, measurement, 'A')).toBe(-0.00595)
    expect(tableValue(current, measurement, 'mA')).toBeCloseTo(-5.95, 8)
    expect(tableValue(current, measurement, 'uA')).toBeCloseTo(-5950, 8)
    expect(tableValue(current, measurement)).toBe(-0.00595)
    expect(tableValue(current, measurement, 'V')).toBeUndefined()
    expect(tableValue(voltage, measurement, 'V')).toBeUndefined()
  })
})
