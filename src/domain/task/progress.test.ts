import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, Module, Project } from '../../shared/schema/index.ts'
import { getInstrumentDefaults } from '../instruments/index.ts'
import { LongWindow } from '../instruments/long-window.ts'
import { buildMeasurementPlan } from '../measurement/plan.ts'
import { checkWiring } from '../wiring-check/index.ts'
import type { MeasurementSnapshot } from './measurements.ts'
import {
  completeTaskStep,
  createTaskState,
  currentTaskStep,
  recordCurrentReading,
  requiredMeasurements,
  scopedReference,
  tableRowComplete,
  writeTableCell,
} from './progress.ts'

const project = Project.parse({
  id: 'DG-05',
  group: 'dc',
  title: 'Kirchhoff',
  type: 'basic',
  modules: [{ instanceId: 'dc1', moduleId: 'mod-dc-circuit', slot: 'SLOT_BOX_L1' }],
  allowedInstruments: [],
  reference: {
    nets: [],
    measurePoints: [
      { id: 'i', kind: 'current', mode: 'dca', branch: ['dc1.KH_I1A', 'dc1.KH_I1B'] },
      { id: 'u', kind: 'voltage', mode: 'dcv', between: ['dc1.KH_F', 'dc1.KH_A'] },
    ],
  },
  steps: [
    { id: 'prepare', text: 'Prepare', measurePoints: [] },
    { id: 'wire', text: 'Wire', measurePoints: [], checkWiring: true },
    { id: 'i', text: 'Measure I', measurePoints: ['i'] },
    { id: 'u', text: 'Measure U', measurePoints: ['u'] },
    { id: 'analyse', text: 'Analyse', measurePoints: [], recordTable: 'readings' },
  ],
  dataTables: [
    {
      id: 'readings',
      title: 'Readings',
      rows: 2,
      columns: [
        { id: 'i', title: 'I', unit: 'mA', measurePoint: 'i' },
        { id: 'u', title: 'U', unit: 'V', measurePoint: 'u' },
      ],
      sanity: [{ column: 'i', min: -20, max: 20, message: 'Check current units and range' }],
    },
  ],
  questions: [],
})
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const module = Module.parse(load('content/modules/mod-dc-circuit/module.json'))
const subckt = readFileSync('content/modules/mod-dc-circuit/module.cir', 'utf8')
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))
const am = Instrument.parse(load('content/instruments/ins-dc-ammeter/instrument.json'))
const wiring: [string, string][] = [
  ['vm.POS', 'dc1.KH_F'],
  ['vm.NEG', 'dc1.KH_A'],
  ['am.POS', 'dc1.KH_I1A'],
  ['am.NEG', 'dc1.KH_I1B'],
]
function snapshot(pairs = wiring, voltage = 1.234, current = 0.0025): MeasurementSnapshot {
  return {
    current: true,
    readings: { vm: { status: 'ok', value: voltage }, am: { status: 'ok', value: current } },
    plan: buildMeasurementPlan(
      {
        title: 'Task test',
        modules: [{ instanceId: 'dc1', module, subckt }],
        instruments: [
          { instanceId: 'vm', instrument: vm, settings: getInstrumentDefaults(vm) },
          { instanceId: 'am', instrument: am, settings: getInstrumentDefaults(am) },
        ],
        wires: pairs.map(([a, b]) => ({ a, b })),
        controlValues: {},
        analysis: [],
      },
      true,
      'task',
    ),
  }
}
const atMeasurements = () => {
  const first = completeTaskStep(project, createTaskState(project), 'prepare')
  return completeTaskStep(project, first.state, 'wire', { wiringCorrect: true }).state
}

describe('Immutable task tables', () => {
  it('starts every configured cell at null with independent rows', () => {
    const state = createTaskState(project)
    expect(state.completedSteps).toEqual([])
    expect(state.tables).toEqual({
      readings: [
        { i: null, u: null },
        { i: null, u: null },
      ],
    })
    expect(state.tables.readings?.[0]).not.toBe(state.tables.readings?.[1])
  })

  it('writes finite manual values immutably and permits clearing cells', () => {
    const state = createTaskState(project)
    const written = writeTableCell(project, state, 'readings', 0, 'u', 1.25)
    expect(written.ok).toBe(true)
    expect(state.tables.readings?.[0]?.u).toBeNull()
    expect(written.state.tables.readings?.[0]?.u).toBe(1.25)
    expect(written.state.tables.readings?.[1]).toBe(state.tables.readings?.[1])
    expect(writeTableCell(project, written.state, 'readings', 0, 'u', null).state.tables.readings?.[0]?.u).toBeNull()
  })

  it.each([
    ['absent', 0, 'u'],
    ['readings', -1, 'u'],
    ['readings', 0.5, 'u'],
    ['readings', 2, 'u'],
    ['readings', 0, 'absent'],
  ])('rejects invalid coordinate %s/%s/%s without state changes', (table, row, column) => {
    const state = createTaskState(project)
    const result = writeTableCell(project, state, table as string, row as number, column as string, 1)
    expect(result.ok).toBe(false)
    expect(result.state).toBe(state)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects nonfinite manual value %s',
    (value) => {
      const state = createTaskState(project)
      expect(writeTableCell(project, state, 'readings', 0, 'u', value)).toMatchObject({ ok: false, state })
    },
  )

  it('warns about unreasonable values without replacing or refusing the learner data', () => {
    const state = createTaskState(project)
    const result = writeTableCell(project, state, 'readings', 0, 'i', 25)
    expect(result.ok).toBe(true)
    expect(result.state.tables.readings?.[0]?.i).toBe(25)
    expect(result.warnings).toEqual(['Check current units and range'])
    expect(writeTableCell(project, result.state, 'readings', 0, 'i', -5).warnings).toEqual([])
  })

  it('does not manufacture a state update for identical input', () => {
    const state = createTaskState(project)
    expect(writeTableCell(project, state, 'readings', 0, 'i', null).state).toBe(state)
  })
})

describe('Current-step completion', () => {
  it('permits explicit manual confirmation but rejects skipped and repeated steps', () => {
    const state = createTaskState(project)
    expect(completeTaskStep(project, state, 'i').ok).toBe(false)
    const prepared = completeTaskStep(project, state, 'prepare')
    expect(prepared.ok).toBe(true)
    expect(currentTaskStep(project, prepared.state)?.id).toBe('wire')
    expect(completeTaskStep(project, prepared.state, 'prepare').ok).toBe(false)
  })

  it('requires fresh wiring evidence independently of runtime power/readiness', () => {
    const state = completeTaskStep(project, createTaskState(project), 'prepare').state
    expect(completeTaskStep(project, state, 'wire').ok).toBe(false)
    expect(completeTaskStep(project, state, 'wire', { wiringCorrect: false }).ok).toBe(false)
    expect(completeTaskStep(project, state, 'wire', { wiringCorrect: true }).ok).toBe(true)
  })

  it('requires a real current capture for measurePoints even without numeric expectations', () => {
    const state = writeTableCell(project, atMeasurements(), 'readings', 0, 'i', 2.5).state
    expect(completeTaskStep(project, state, 'i').ok).toBe(false)
    expect(completeTaskStep(project, state, 'i', { snapshot: { ...snapshot(), current: false } }).ok).toBe(false)
    expect(completeTaskStep(project, state, 'i', { snapshot: snapshot() }).ok).toBe(true)
  })

  it('requires every currently eligible captured point in a multi-point step', () => {
    const multi = Project.parse({
      ...project,
      steps: project.steps.map((step) => (step.id === 'i' ? { ...step, measurePoints: ['i', 'u'] } : step)),
    })
    const state = atMeasurements()
    const onlyCurrent = snapshot(wiring.slice(2))
    expect(completeTaskStep(multi, state, 'i', { snapshot: onlyCurrent }).ok).toBe(false)
    expect(completeTaskStep(multi, state, 'i', { snapshot: snapshot() }).ok).toBe(true)
  })

  it('applies optional numeric expectation to actual reference-oriented SI, not manually typed data', () => {
    const bounded = Project.parse({
      ...project,
      steps: project.steps.map((step) =>
        step.id === 'i' ? { ...step, expect: { measurePoint: 'i', min: -0.003, max: -0.002 } } : step,
      ),
    })
    const state = writeTableCell(bounded, atMeasurements(), 'readings', 0, 'i', -2.5).state
    expect(completeTaskStep(bounded, state, 'i').ok).toBe(false)
    expect(completeTaskStep(bounded, state, 'i', { snapshot: snapshot() }).ok).toBe(false)
    expect(completeTaskStep(bounded, state, 'i', { snapshot: snapshot(wiring, 1.234, -0.0025) }).ok).toBe(true)
  })

  it('requires both the legacy and additional ranges against one current SI snapshot', () => {
    const bounded = Project.parse({
      ...project,
      steps: [
        {
          id: 'measure',
          text: 'Measure',
          measurePoints: [],
          expect: { measurePoint: 'i', min: 0.002, max: 0.003 },
          expects: [{ measurePoint: 'u', min: 1, max: 1.5 }],
        },
      ],
    })
    let state = createTaskState(bounded)
    state = writeTableCell(bounded, state, 'readings', 0, 'i', 2.5).state
    state = writeTableCell(bounded, state, 'readings', 0, 'u', 1.234).state
    expect(completeTaskStep(bounded, state, 'measure').ok).toBe(false)
    expect(completeTaskStep(bounded, state, 'measure', { snapshot: snapshot(wiring, 0.5) }).ok).toBe(false)
    expect(completeTaskStep(bounded, state, 'measure', { snapshot: snapshot(wiring, 1.234, 0.001) }).ok).toBe(false)
    expect(completeTaskStep(bounded, state, 'measure', { snapshot: snapshot(wiring.slice(2)) }).ok).toBe(false)
    expect(completeTaskStep(bounded, state, 'measure', { snapshot: { ...snapshot(), current: false } }).ok).toBe(false)
    expect(completeTaskStep(bounded, state, 'measure', { snapshot: snapshot() }).ok).toBe(true)
    expect(state.completedSteps).toEqual([])
  })

  it('applies every overlapping range for a point and preserves reference-oriented polarity', () => {
    const bounded = Project.parse({
      ...project,
      steps: [
        {
          id: 'measure',
          text: 'Measure',
          expect: { measurePoint: 'u', min: 0.5, max: 2 },
          expects: [
            { measurePoint: 'u', min: 1, max: 1.5 },
            { measurePoint: 'u', min: 1.1, max: 1.3 },
          ],
        },
      ],
    })
    const state = createTaskState(bounded)
    for (const voltage of [0.4, 0.8, 1.4, 2.1])
      expect(completeTaskStep(bounded, state, 'measure', { snapshot: snapshot(wiring, voltage) }).ok).toBe(false)
    const reversed = snapshot(
      [
        ['vm.POS', 'dc1.KH_A'],
        ['vm.NEG', 'dc1.KH_F'],
      ],
      -1.234,
    )
    expect(completeTaskStep(bounded, state, 'measure', { snapshot: reversed }).ok).toBe(true)
    expect(requiredMeasurements(bounded.steps[0])).toEqual(['u'])
    expect(requiredMeasurements()).toEqual([])
  })

  it('allows a measured zero with an explicit zero range even when table sanity warns', () => {
    const bounded = Project.parse({
      ...project,
      steps: [{ id: 'zero', text: 'Measure zero', expects: [{ measurePoint: 'u', min: 0, max: 0 }] }],
      dataTables: project.dataTables.map((table) => ({
        ...table,
        sanity: [{ column: 'u', min: 1, max: 2, message: 'Check voltage range' }],
      })),
    })
    const result = recordCurrentReading(bounded, createTaskState(bounded), 'readings', 0, 'u', {
      snapshot: snapshot(wiring, 0),
    })
    expect(result.ok).toBe(true)
    expect(result.state.tables.readings?.[0]?.u).toBe(0)
    expect(result.warnings).toEqual(['Check voltage range'])
    expect(result.state.completedSteps).toEqual(['zero'])
  })

  it('requires a filled selected table row, permits zeros and ignores unfinished other rows', () => {
    let state = { ...createTaskState(project), completedSteps: ['prepare', 'wire', 'i', 'u'] }
    expect(completeTaskStep(project, state, 'analyse').ok).toBe(false)
    state = writeTableCell(project, state, 'readings', 0, 'i', 0).state
    state = writeTableCell(project, state, 'readings', 0, 'u', 1.234).state
    expect(tableRowComplete(project, state, 'readings')).toBe(true)
    expect(tableRowComplete(project, state, 'readings', 1)).toBe(false)
    expect(completeTaskStep(project, state, 'analyse', { row: 1 }).ok).toBe(false)
    const completed = completeTaskStep(project, state, 'analyse')
    expect(completed.ok).toBe(true)
    expect(currentTaskStep(project, completed.state)).toBeUndefined()
    expect(completeTaskStep(project, completed.state, 'analyse').ok).toBe(false)
  })
})

describe('Current reading records', () => {
  it('records only the valid current reading with unit conversion and advances one matching step', () => {
    const state = atMeasurements()
    const result = recordCurrentReading(project, state, 'readings', 0, 'i', { snapshot: snapshot() })
    expect(result.ok).toBe(true)
    expect(result.state.tables.readings?.[0]?.i).toBeCloseTo(2.5, 8)
    expect(result.measurement).toMatchObject({ displayValueSI: 0.0025, referenceValueSI: 0.0025, reversed: false })
    expect(result.state.completedSteps).toEqual(['prepare', 'wire', 'i'])
    expect(state.tables.readings?.[0]?.i).toBeNull()
  })

  it('can record another valid point without completing the current measured step', () => {
    const result = recordCurrentReading(project, atMeasurements(), 'readings', 0, 'u', { snapshot: snapshot() })
    expect(result.ok).toBe(true)
    expect(result.state.tables.readings?.[0]?.u).toBe(1.234)
    expect(result.state.completedSteps).toEqual(['prepare', 'wire'])
  })

  it('does not write stale, unmatched or incompatible-unit readings', () => {
    const state = atMeasurements()
    expect(
      recordCurrentReading(project, state, 'readings', 0, 'i', { snapshot: { ...snapshot(), current: false } }).ok,
    ).toBe(false)
    expect(
      recordCurrentReading(project, state, 'readings', 0, 'i', { snapshot: snapshot(wiring.slice(0, 2)) }).ok,
    ).toBe(false)
    const incompatible = Project.parse({
      ...project,
      dataTables: project.dataTables.map((table) => ({
        ...table,
        columns: table.columns.map((column) => (column.id === 'i' ? { ...column, unit: 'V' } : column)),
      })),
    })
    const result = recordCurrentReading(incompatible, state, 'readings', 0, 'i', { snapshot: snapshot() })
    expect(result.ok).toBe(false)
    expect(result.state).toBe(state)
  })

  it('retains reversed display sign but records the declared reference direction', () => {
    const reversed = snapshot(
      [...wiring.slice(0, 2), ['am.POS', 'dc1.KH_I1B'], ['am.NEG', 'dc1.KH_I1A']],
      1.234,
      -0.0025,
    )
    const result = recordCurrentReading(project, atMeasurements(), 'readings', 0, 'i', { snapshot: reversed })
    expect(result.measurement).toMatchObject({ displayValueSI: -0.0025, referenceValueSI: 0.0025, reversed: true })
    expect(result.state.tables.readings?.[0]?.i).toBeCloseTo(2.5, 8)
  })

  it('advances at most one duplicate-point step and supports batch advancement suppression', () => {
    const repeated = Project.parse({
      ...project,
      steps: [
        { id: 'first', text: 'First', measurePoints: ['i'] },
        { id: 'second', text: 'Second', measurePoints: ['i'] },
      ],
    })
    const state = createTaskState(repeated)
    const one = recordCurrentReading(repeated, state, 'readings', 0, 'i', { snapshot: snapshot() })
    expect(one.state.completedSteps).toEqual(['first'])
    const batch = recordCurrentReading(repeated, state, 'readings', 0, 'i', { snapshot: snapshot(), advance: false })
    expect(batch.state.completedSteps).toEqual([])
    expect(batch.state.tables.readings?.[0]?.i).toBeCloseTo(2.5, 8)
    expect(completeTaskStep(repeated, batch.state, 'first', { snapshot: snapshot() }).state.completedSteps).toEqual([
      'first',
    ])
  })
})

describe('Scoped current-step wiring references', () => {
  it('replaces rather than merges a step topology and preserves its measurement scope', () => {
    const configured = Project.parse({
      ...project,
      reference: { ...project.reference, nets: [['dc1.KH_A', 'dc1.KH_F']] },
      steps: [
        { id: 'first', text: 'First', measurePoints: [] },
        {
          id: 'second',
          text: 'Alternative',
          referenceNets: [['dc1.KH_A', 'dc1.KH_D']],
          measurePoints: ['i'],
        },
      ],
    })
    const scoped = scopedReference(configured, configured.steps[1])
    expect(scoped.nets).toEqual([['dc1.KH_A', 'dc1.KH_D']])
    expect(scoped.measurePoints.map((point) => point.id)).toEqual(['i'])
    expect(scopedReference(configured, configured.steps[0]).nets).toBe(configured.reference.nets)
    expect(configured.reference.nets).toEqual([['dc1.KH_A', 'dc1.KH_F']])
  })

  it('keeps the strict checker from accepting the default graph for an alternative step', () => {
    const defaultNets = [['dc1.KH_F', 'dc1.KH_A']]
    const alternateNets = [['dc1.KH_F', 'dc1.KH_D']]
    const configured = Project.parse({
      ...project,
      reference: { ...project.reference, nets: defaultNets },
      steps: [{ id: 'alternate', text: 'Alternative', referenceNets: alternateNets, measurePoints: [] }],
    })
    const input = snapshot([['dc1.KH_F', 'dc1.KH_A']]).plan.checkInput
    expect(checkWiring(input, scopedReference(configured, configured.steps[0])).circuitOk).toBe(false)
    const correct = snapshot([['dc1.KH_F', 'dc1.KH_D']]).plan.checkInput
    expect(checkWiring(correct, scopedReference(configured, configured.steps[0])).circuitOk).toBe(true)
  })

  it('filters only measurement points without changing the strict existing checker', () => {
    const state = snapshot(wiring.slice(2))
    const step = project.steps.find((item) => item.id === 'i')
    expect(checkWiring(state.plan.checkInput, project.reference).measurementsOk).toBe(false)
    const scoped = scopedReference(project, step)
    expect(scoped.measurePoints.map((point) => point.id)).toEqual(['i'])
    expect(scoped.nets).toBe(project.reference.nets)
    expect(checkWiring(state.plan.checkInput, scoped).measurementsOk).toBe(true)
  })

  it('includes expectation-only references in an explicit scope while deduplicating shared points', () => {
    const configured = Project.parse({
      ...project,
      steps: [
        {
          id: 'measure',
          text: 'Measure',
          measurePoints: ['i'],
          expect: { measurePoint: 'u', min: 1, max: 2 },
          expects: [
            { measurePoint: 'u', min: 1, max: 1.5 },
            { measurePoint: 'i', min: 0.002, max: 0.003 },
          ],
        },
      ],
    })
    expect(requiredMeasurements(configured.steps[0])).toEqual(['i', 'u'])
    const scoped = scopedReference(configured, configured.steps[0])
    expect(scoped.measurePoints.map((point) => point.id)).toEqual(['i', 'u'])
    expect(scoped.nets).toBe(configured.reference.nets)
    expect(checkWiring(snapshot(wiring.slice(2)).plan.checkInput, scoped).measurementsOk).toBe(false)
    expect(checkWiring(snapshot().plan.checkInput, scoped).measurementsOk).toBe(true)
    expect(configured.steps[0]?.measurePoints).toEqual(['i'])
  })

  it('preserves an undefined legacy scope even when additive expectations are present', () => {
    const configured = Project.parse({
      ...project,
      steps: [{ id: 'measure', text: 'Measure', expects: [{ measurePoint: 'u', min: 1, max: 2 }] }],
    })
    expect(scopedReference(configured, configured.steps[0])).toBe(configured.reference)
    expect(scopedReference(configured)).toBe(configured.reference)
  })

  it('uses topology only for explicit empty scopes and after sequential completion', () => {
    expect(scopedReference(project, project.steps[0]).measurePoints).toEqual([])
    expect(scopedReference(project).measurePoints).toEqual([])
  })

  it('preserves the full reference when old content has undefined scopes', () => {
    const legacy = Project.parse({ ...project, steps: [{ id: 'legacy', text: 'Legacy' }] })
    expect(scopedReference(legacy, legacy.steps[0])).toBe(legacy.reference)
    expect(scopedReference(legacy)).toBe(legacy.reference)
  })
})

describe('Explicit waveform phase expectations', () => {
  const scope = Instrument.parse(load('content/instruments/ins-oscilloscope/instrument.json'))
  const steadyProject = Project.parse({
    ...project,
    reference: {
      nets: [],
      measurePoints: [
        {
          id: 'frequency',
          kind: 'waveform',
          quantity: 'frequency',
          minCycles: 2,
          between: ['dc1.KH_F', 'dc1.KH_A'],
        },
        {
          id: 'minimum',
          kind: 'waveform',
          quantity: 'min',
          minCycles: 2,
          between: ['dc1.KH_F', 'dc1.KH_A'],
        },
      ],
    },
    steps: [
      {
        id: 'steady',
        text: 'Record steady waveform',
        measurePoints: ['frequency'],
        expect: { measurePoint: 'frequency', min: 0.99, max: 1.01 },
        expects: [{ measurePoint: 'minimum', min: 1.4, max: 1.9 }],
      },
    ],
    dataTables: [
      {
        id: 'readings',
        title: 'Waveform',
        rows: 1,
        columns: [{ id: 'minimum', title: 'Steady minimum', unit: 'V', measurePoint: 'minimum' }],
        sanity: [{ column: 'minimum', min: 1.4, max: 1.9, message: 'Check the measured minimum and window' }],
      },
    ],
  })

  function streamedSnapshot(window: LongWindow): MeasurementSnapshot {
    const observed = window.snapshot(4)
    return {
      current: true,
      readings: {},
      plan: buildMeasurementPlan(
        {
          title: 'Protocol-only waveform phase test',
          modules: [{ instanceId: 'dc1', module, subckt }],
          instruments: [{ instanceId: 'scope1', instrument: scope, settings: getInstrumentDefaults(scope) }],
          wires: [
            { a: 'scope1.CH1', b: 'dc1.KH_F' },
            { a: 'scope1.GND', b: 'dc1.KH_A' },
          ],
          controlValues: {},
          analysis: [],
        },
        true,
        'waveform-phase',
      ),
      waveforms: [
        {
          instanceId: 'scope1',
          channelId: 'CH1',
          positiveRef: 'scope1.CH1',
          negativeRef: 'scope1.GND',
          coupling: 'dc',
          current: true,
          measurement: observed.measurement,
          window: { ...observed.window, source: 'stream', revision: observed.revision, frozen: false },
        },
      ],
    }
  }

  function pushCapacitor(window: LongWindow, start: number, count: number): void {
    const dt = 1e-3
    const samples = Float32Array.from({ length: count }, (_, index) => {
      const time = start + index * dt
      return time < 1 ? (10 / 3) * time : 10 / 3 - (5 / 3) * (1 - Math.abs(2 * ((time - 1) % 1) - 1))
    })
    window.push(samples, start, dt)
  }

  it('retains real startup zero and its warning without claiming a steady phase from recent cycles', () => {
    const window = new LongWindow()
    pushCapacitor(window, 0, 3800)
    const snapshot = streamedSnapshot(window)
    expect(snapshot.waveforms?.[0]?.measurement).toMatchObject({ min: 0, completeCycles: 2 })
    expect(snapshot.waveforms?.[0]?.measurement?.frequency).toBeCloseTo(1, 5)
    const state = createTaskState(steadyProject)
    const recorded = recordCurrentReading(steadyProject, state, 'readings', 0, 'minimum', { snapshot })
    expect(recorded.ok).toBe(true)
    expect(recorded.state.tables.readings?.[0]?.minimum).toBe(0)
    expect(recorded.warnings).toEqual(['Check the measured minimum and window'])
    expect(recorded.state.completedSteps).toEqual([])
    expect(recorded.measurement?.window).toMatchObject({ start: 0, source: 'stream' })
    const manual = writeTableCell(steadyProject, recorded.state, 'readings', 0, 'minimum', 5 / 3)
    expect(manual.ok).toBe(true)
    expect(completeTaskStep(steadyProject, manual.state, 'steady', { snapshot }).ok).toBe(false)
    expect(window.snapshot(16).measurement?.min).toBe(0)
  })

  it('advances only after actual steady evidence fills the current window while preserving longer startup history', () => {
    const window = new LongWindow()
    pushCapacitor(window, 0, 6000)
    const snapshot = streamedSnapshot(window)
    const measured = snapshot.waveforms?.[0]
    expect(measured?.measurement?.min).toBeCloseTo(5 / 3, 5)
    expect(measured?.window?.start).toBeGreaterThan(1)
    expect(window.snapshot(16).measurement?.min).toBe(0)
    const recorded = recordCurrentReading(steadyProject, createTaskState(steadyProject), 'readings', 0, 'minimum', {
      snapshot,
    })
    expect(recorded.ok).toBe(true)
    expect(recorded.state.completedSteps).toEqual(['steady'])
    expect(recorded.measurement?.window).toEqual(measured?.window)
    expect(completeTaskStep(steadyProject, createTaskState(steadyProject), 'steady', { snapshot }).ok).toBe(true)
  })
})
