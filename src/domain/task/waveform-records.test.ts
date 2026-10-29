import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument } from '../../shared/schema/instrument.ts'
import { Module } from '../../shared/schema/module.ts'
import { Project } from '../../shared/schema/project.ts'
import { buildMeasurementPlan } from '../measurement/plan.ts'
import { captureMeasurePoint, type MeasurementSnapshot, tableValue, type WaveformReading } from './measurements.ts'
import { createTaskState, recordCurrentReading, writeTableCell } from './progress.ts'

const scope = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-oscilloscope/instrument.json', 'utf8')))
const source = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-dc-power/instrument.json', 'utf8')))
const point = { id: 'output', kind: 'waveform' as const, between: ['source.CH1P', 'source.CH1N'] as [string, string] }
const plan = buildMeasurementPlan(
  {
    title: 'waveform',
    modules: [],
    instruments: [
      { instanceId: 'source', instrument: source, settings: {} },
      { instanceId: 'scope1', instrument: scope, settings: {} },
    ],
    wires: [
      { a: 'source.CH1P', b: 'scope1.CH1' },
      { a: 'source.CH1N', b: 'scope1.GND' },
    ],
    controlValues: {},
    analysis: [],
  },
  true,
  'wave',
)
const reading: WaveformReading = {
  instanceId: 'scope1',
  channelId: 'CH1',
  positiveRef: 'scope1.CH1',
  negativeRef: 'scope1.GND',
  current: true,
  coupling: 'dc',
  measurement: { mean: 2, min: 1, max: 3, vpp: 2, frequency: 1000, period: 0.001 },
}
const snapshot = (entry = reading): MeasurementSnapshot => ({ current: true, plan, readings: {}, waveforms: [entry] })

describe('actual scope recording', () => {
  it('does not merge real ammeter burden nodes when matching a scope ground', () => {
    const module = Module.parse(JSON.parse(readFileSync('content/modules/mod-dc-circuit/module.json', 'utf8')))
    const am = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-dc-ammeter/instrument.json', 'utf8')))
    const physical = buildMeasurementPlan(
      {
        title: 'actual burden nodes',
        modules: [
          { instanceId: 'dc1', module, subckt: readFileSync('content/modules/mod-dc-circuit/module.cir', 'utf8') },
        ],
        instruments: [
          { instanceId: 'am', instrument: am, settings: {} },
          { instanceId: 'scope1', instrument: scope, settings: {} },
        ],
        wires: [
          { a: 'am.POS', b: 'dc1.KH_I1A' },
          { a: 'am.NEG', b: 'dc1.KH_I1B' },
          { a: 'scope1.CH1', b: 'dc1.KH_I1A' },
          { a: 'scope1.GND', b: 'dc1.KH_I1A' },
        ],
        controlValues: {},
        analysis: [],
      },
      true,
      'burden',
    )
    expect(physical.assembled.nodeOf['dc1.KH_I1A']).not.toBe(physical.assembled.nodeOf['dc1.KH_I1B'])
    const input = {
      ...snapshot({ ...reading, measurement: { mean: 0, min: 0, max: 0, vpp: 0, frequency: null, period: null } }),
      plan: physical,
    }
    expect(captureMeasurePoint(input, { ...point, between: ['dc1.KH_I1A', 'dc1.KH_I1B'] })).toMatchObject({
      ok: false,
      reason: 'not-connected',
    })
  })
  it('maps canonical instrument references to their actual placed owner', () => {
    expect(captureMeasurePoint(snapshot(), { ...point, between: ['ins-dc-power.CH1P', 'ins-dc-power.CH1N'] }).ok).toBe(
      true,
    )
  })
  it('rejects unknown owners and jacks rather than inserting them into the matching partition', () => {
    const unknown = snapshot({ ...reading, positiveRef: 'ghost.A', negativeRef: 'ghost.B' })
    expect(captureMeasurePoint(unknown, { ...point, between: ['ghost.A', 'ghost.B'] }).ok).toBe(false)
    expect(captureMeasurePoint(snapshot({ ...reading, positiveRef: 'scope1.UNKNOWN' }), point).ok).toBe(false)
  })
  it.each(['mean', 'min', 'max', 'vpp', 'frequency', 'period'] as const)(
    'captures the actual %s quantity from its correctly connected channel',
    (quantity) => {
      const result = captureMeasurePoint(snapshot(), { ...point, quantity })
      expect(result.ok).toBe(true)
      if (result.ok)
        expect(result.measurement).toMatchObject({
          instanceId: 'scope1',
          channelId: 'CH1',
          referenceValueSI: reading.measurement?.[quantity],
        })
    },
  )
  it('requires current data, a meaningful coupling and sufficient periodic samples', () => {
    expect(captureMeasurePoint({ ...snapshot(), current: false }, point).ok).toBe(false)
    expect(captureMeasurePoint(snapshot({ ...reading, current: false }), point).ok).toBe(false)
    expect(captureMeasurePoint(snapshot({ ...reading, coupling: 'gnd' }), point).ok).toBe(false)
    expect(captureMeasurePoint(snapshot({ ...reading, coupling: 'ac' }), { ...point, quantity: 'mean' }).ok).toBe(false)
    expect(
      captureMeasurePoint(
        snapshot({
          ...reading,
          measurement: { ...(reading.measurement as NonNullable<WaveformReading['measurement']>), frequency: null },
        }),
        { ...point, quantity: 'frequency' },
      ).ok,
    ).toBe(false)
  })
  it('orients DC means and extrema but never invents negative Vpp or frequency on reverse leads', () => {
    const reversed = snapshot({ ...reading, positiveRef: 'scope1.GND', negativeRef: 'scope1.CH1' })
    for (const [quantity, expected] of [
      ['mean', -2],
      ['min', -3],
      ['max', -1],
      ['vpp', 2],
      ['frequency', 1000],
      ['period', 0.001],
    ] as const) {
      const result = captureMeasurePoint(reversed, { ...point, quantity })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.measurement.referenceValueSI).toBe(expected)
    }
  })
  it('selects an explicit channel when two physical channels match the point', () => {
    const multiple = { ...snapshot(), waveforms: [reading, { ...reading, channelId: 'CH2' }] }
    expect(captureMeasurePoint(multiple, point).ok).toBe(false)
    expect(captureMeasurePoint(multiple, point, 'scope1').ok).toBe(false)
    const result = captureMeasurePoint(multiple, point, 'scope1.CH2')
    expect(result.ok && result.measurement.channelId).toBe('CH2')
  })

  it('does not treat opposite signs of the same synchronous difference as two physical measurement sources', () => {
    const differential = { ...reading, channelId: 'CH1-CH2', positiveRef: 'scope1.CH1', negativeRef: 'scope1.GND' }
    const mirrored = {
      ...differential,
      channelId: 'CH2-CH1',
      positiveRef: differential.negativeRef,
      negativeRef: differential.positiveRef,
    }
    const measured = { ...snapshot(), waveforms: [differential, mirrored] }
    const result = captureMeasurePoint(measured, point)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.measurement.channelId).toBe('CH1-CH2')
  })
  it('converts quantity-compatible units only when writing a table', () => {
    const result = captureMeasurePoint(snapshot(), { ...point, quantity: 'frequency' })
    if (!result.ok) throw new Error('Missing capture')
    expect(tableValue({ ...point, quantity: 'frequency' }, result.measurement, 'kHz')).toBe(1)
    expect(tableValue({ ...point, quantity: 'frequency' }, result.measurement, 'mA')).toBeUndefined()
  })
})

describe('step-scoped captures and computed data', () => {
  const project = Project.parse({
    id: 'MD-03',
    group: '测试',
    title: '测量',
    type: 'basic',
    modules: [{ instanceId: 'board', moduleId: 'mod-board', slot: 'SLOT_BOX_L1' }],
    allowedInstruments: [],
    reference: { nets: [], measurePoints: [point] },
    steps: [
      { id: 'open', text: '空载', measurePoints: ['output'], dataTable: 'load' },
      { id: 'loaded', text: '带载', measurePoints: ['output'], dataTable: 'load' },
    ],
    dataTables: [
      {
        id: 'load',
        title: '输出电阻',
        rows: 1,
        columns: [
          { id: 'open', title: '空载', unit: 'V', measurePoint: 'output', captureSteps: ['open'] },
          { id: 'loaded', title: '带载', unit: 'V', measurePoint: 'output', captureSteps: ['loaded'] },
          { id: 'ro', title: 'Ro', unit: 'Ω', computed: '2400*(open/loaded-1)' },
        ],
      },
    ],
    charts: [],
    questions: [],
  })
  it('never fills empty and loaded columns at once even when both use the same physical port', () => {
    const state = createTaskState(project)
    expect(recordCurrentReading(project, state, 'load', 0, 'loaded', { snapshot: snapshot(), advance: false }).ok).toBe(
      false,
    )
    const open = recordCurrentReading(project, state, 'load', 0, 'open', { snapshot: snapshot() })
    expect(open.state.tables.load?.[0]).toEqual({ open: 2, loaded: null, ro: null })
    const loaded = recordCurrentReading(project, open.state, 'load', 0, 'loaded', {
      snapshot: snapshot({
        ...reading,
        measurement: { ...(reading.measurement as NonNullable<WaveformReading['measurement']>), vpp: 1 },
      }),
    })
    expect(loaded.state.tables.load?.[0]).toEqual({ open: 2, loaded: 1, ro: 2400 })
  })
  it('recomputes same-row calculations from manual measured data without treating it as waveform evidence', () => {
    let state = createTaskState(project)
    state = writeTableCell(project, state, 'load', 0, 'open', 2).state
    state = writeTableCell(project, state, 'load', 0, 'loaded', 1).state
    expect(state.tables.load?.[0]?.ro).toBe(2400)
    expect(state.completedSteps).toEqual([])
    expect(writeTableCell(project, state, 'load', 0, 'loaded', 0).state.tables.load?.[0]?.ro).toBeNull()
  })
  it.each(['open.foo', 'eval(open)', 'missing/open', 'ro+1'])(
    'rejects invalid and cyclic calculated definitions %s',
    (computed) => {
      const copy = structuredClone(project)
      const column = copy.dataTables[0]?.columns.find((entry) => entry.id === 'ro')
      if (!column) throw new Error('Missing calculated column')
      column.computed = computed
      expect(Project.safeParse(copy).success).toBe(false)
    },
  )
})
