import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssembleInput } from '../../domain/circuit/assemble.ts'
import { getInstrumentDefaults } from '../../domain/instruments/index.ts'
import { buildMeasurementPlan } from '../../domain/measurement/plan.ts'
import { type MeasurementSnapshot, scopedReference } from '../../domain/task/index.ts'
import { checkWiring } from '../../domain/wiring-check/index.ts'
import { Instrument, Module, Project } from '../../shared/schema/index.ts'

const runtime = vi.hoisted(() => ({
  snapshot: vi.fn<() => MeasurementSnapshot | undefined>(),
  input: vi.fn<() => AssembleInput>(),
  powered: false,
}))

vi.mock('../lib/instrument-runtime', () => ({
  currentMeasurementSnapshot: runtime.snapshot,
  benchCircuitInput: runtime.input,
}))
vi.mock('../features/practice/wiring-state', () => ({
  circuitStore: { getState: () => ({ powered: runtime.powered }) },
}))

import {
  completeCurrentTaskStep,
  formatTaskCellValue,
  parseTaskCellDraft,
  recordTaskReadings,
  resetTask,
  selectTaskRow,
  selectTaskSource,
  selectTaskTable,
  taskCellKey,
  taskStore,
  writeTaskCell,
} from './task'

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const module = Module.parse(load('content/modules/mod-dc-circuit/module.json'))
const subckt = readFileSync('content/modules/mod-dc-circuit/module.cir', 'utf8')
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))
const am = Instrument.parse(load('content/instruments/ins-dc-ammeter/instrument.json'))
const supply = Instrument.parse(load('content/instruments/ins-dc-power/instrument.json'))
const sourceWires: [string, string][] = [
  ['ins-dc-power.CH1P', 'dc1.KH_U1P'],
  ['ins-dc-power.CH1N', 'dc1.KH_U1N'],
  ['ins-dc-power.CH2P', 'dc1.KH_U2P'],
  ['ins-dc-power.CH2N', 'dc1.KH_U2N'],
]
const meterWires: [string, string][] = [
  ['vm.POS', 'dc1.KH_F'],
  ['vm.NEG', 'dc1.KH_A'],
  ['am.POS', 'dc1.KH_I1A'],
  ['am.NEG', 'dc1.KH_I1B'],
]
const allWires = [...sourceWires, ...meterWires]

const project = Project.parse({
  id: 'DG-05',
  group: 'dc',
  title: 'Task UI fixture',
  type: 'basic',
  modules: [{ instanceId: 'dc1', moduleId: module.id, slot: 'SLOT_BOX_L1' }],
  allowedInstruments: [],
  reference: {
    nets: sourceWires,
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
      sanity: [
        { column: 'i', min: -20, max: 20, message: 'Check current units and range' },
        { column: 'u', min: -5, max: 5, message: 'Check voltage units and range' },
      ],
    },
  ],
  questions: [],
})

function input(pairs = allWires, extraVoltageMeter = false): AssembleInput {
  return {
    title: 'Task UI test',
    modules: [{ instanceId: 'dc1', module, subckt }],
    instruments: [
      { instanceId: 'ins-dc-power', instrument: supply, settings: getInstrumentDefaults(supply) },
      { instanceId: 'vm', instrument: vm, settings: { ...getInstrumentDefaults(vm), range: 'r2' } },
      { instanceId: 'am', instrument: am, settings: { ...getInstrumentDefaults(am), range: 'r20m' } },
      ...(extraVoltageMeter
        ? [{ instanceId: 'vm2', instrument: vm, settings: { ...getInstrumentDefaults(vm), range: 'r2' } }]
        : []),
    ],
    wires: pairs.map(([a, b]) => ({ a, b })),
    controlValues: {},
    analysis: [],
  }
}

function snapshot(pairs = allWires, voltage = 1.234, current = 0.0025, extraVoltageMeter = false): MeasurementSnapshot {
  return {
    current: true,
    plan: buildMeasurementPlan(input(pairs, extraVoltageMeter), true, 'task-ui'),
    readings: {
      vm: { status: 'ok', value: voltage },
      am: { status: 'ok', value: current },
      ...(extraVoltageMeter ? { vm2: { status: 'ok', value: 1.25 } } : {}),
    },
  }
}

function measuredProject(point = 'i'): Project {
  return Project.parse({
    ...project,
    steps: [{ id: 'measure', text: 'Measure', measurePoints: [point] }],
    dataTables: project.dataTables.map((table) => ({
      ...table,
      columns: table.columns.filter((column) => column.measurePoint === point),
      sanity: table.sanity?.filter((rule) => rule.column === point),
    })),
  })
}

beforeEach(() => {
  runtime.snapshot.mockReset()
  runtime.input.mockReset().mockReturnValue(input())
  runtime.powered = false
  resetTask(project)
})

describe('manual task cell draft parsing', () => {
  it.each([
    ['0', 0],
    ['-1.25', -1.25],
    ['\u22120.00595', -0.00595],
    [' +.5 ', 0.5],
    ['1.', 1],
    ['1e3', 1000],
    ['\t-2.5E+2\n', -250],
    ['1e-3', 0.001],
    ['\u22122.5e\u22123', -0.0025],
  ] as const)('accepts finite decimal/scientific draft %j without changing task state', (draft, value) => {
    const state = taskStore.getState()
    const copy = structuredClone(state)
    expect(parseTaskCellDraft(draft)).toEqual({ ok: true, value })
    expect(taskStore.getState()).toBe(state)
    expect(taskStore.getState()).toEqual(copy)
    expect(runtime.snapshot).not.toHaveBeenCalled()
  })

  it.each(['', ' \t\n '])('treats empty draft %j as null without writing a cell', (draft) => {
    const state = taskStore.getState()
    const copy = structuredClone(state)
    expect(parseTaskCellDraft(draft)).toEqual({ ok: true, value: null })
    expect(taskStore.getState()).toBe(state)
    expect(taskStore.getState()).toEqual(copy)
  })

  it.each(['-', '\u2212', '+', '.', '-.', '1e', '1e-', '0x10', '1,2', 'NaN', 'Infinity', '1e309', '--1'])(
    'rejects partial or invalid draft %j without changing task state',
    (draft) => {
      const state = taskStore.getState()
      const copy = structuredClone(state)
      const parsed = parseTaskCellDraft(draft)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.message.trim()).not.toBe('')
      expect(taskStore.getState()).toBe(state)
      expect(taskStore.getState()).toEqual(copy)
    },
  )
})

describe('task UI state', () => {
  it('resets tables, progress, UI selections and provenance outside the circuit history', () => {
    const version = taskStore.getState().resetVersion
    selectTaskRow(project, 1)
    selectTaskSource('vm')
    writeTaskCell(project, 'readings', 1, 'u', 8)
    taskStore.setState({ leftTab: 'steps', bottomTab: 'data', notice: 'old notice' })
    resetTask(project)
    expect(taskStore.getState()).toMatchObject({
      projectId: project.id,
      task: {
        completedSteps: [],
        tables: {
          readings: [
            { i: null, u: null },
            { i: null, u: null },
          ],
        },
      },
      selectedTable: 'readings',
      selectedRow: 0,
      selectedSource: 'auto',
      leftTab: 'guide',
      bottomTab: 'instruments',
      notice: null,
      warnings: [],
      captures: {},
    })
    expect(taskStore.getState().resetVersion).toBeGreaterThan(version)
    expect(taskStore).not.toHaveProperty('temporal')
    resetTask()
    expect(taskStore.getState()).toMatchObject({
      projectId: undefined,
      task: { completedSteps: [], tables: {} },
      selectedTable: '',
      captures: {},
    })
  })

  it('validates row/table choices and resets the selected row when changing tables', () => {
    const multiple = Project.parse({
      ...project,
      dataTables: [...project.dataTables, { id: 'other', title: 'Other', rows: 1, columns: [{ id: 'x', title: 'X' }] }],
    })
    resetTask(multiple)
    expect(selectTaskTable(multiple, 'missing')).toBe(false)
    expect(taskStore.getState().selectedTable).toBe('readings')
    for (const row of [-1, 2, 0.5]) expect(selectTaskRow(multiple, row)).toBe(false)
    expect(selectTaskRow(multiple, 1)).toBe(true)
    expect(selectTaskTable(multiple, 'other')).toBe(true)
    expect(taskStore.getState()).toMatchObject({ selectedTable: 'other', selectedRow: 0 })
    expect(selectTaskRow(multiple, 1)).toBe(false)
  })

  it('retains finite manual values, aggregates sanity warnings and permits clearing cells', () => {
    expect(writeTaskCell(project, 'readings', 0, 'i', 30)).toBe(true)
    expect(writeTaskCell(project, 'readings', 0, 'u', 10)).toBe(true)
    expect(taskStore.getState().task.tables.readings?.[0]).toEqual({ i: 30, u: 10 })
    const warnings = taskStore.getState().warnings
    expect(warnings).toHaveLength(2)
    expect(warnings.some((message) => message.includes('Check current units and range'))).toBe(true)
    expect(warnings.some((message) => message.includes('Check voltage units and range'))).toBe(true)
    expect(writeTaskCell(project, 'readings', 0, 'i', null)).toBe(true)
    expect(taskStore.getState().warnings).toHaveLength(1)
    expect(taskStore.getState().warnings[0]).toContain('Check voltage units and range')
    expect(taskStore.getState().task.completedSteps).toEqual([])
    for (const value of [NaN, Infinity, -Infinity])
      expect(writeTaskCell(project, 'readings', 0, 'u', value)).toBe(false)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBe(10)
  })

  it('clears capture provenance even for a same-valued committed manual edit', () => {
    const measured = measuredProject()
    resetTask(measured)
    runtime.snapshot.mockReturnValue(snapshot())
    expect(recordTaskReadings(measured)).toBe(true)
    const key = taskCellKey('readings', 0, 'i')
    expect(taskStore.getState().captures[key]?.instanceId).toBe('am')
    expect(writeTaskCell(measured, 'readings', 0, 'i', Infinity)).toBe(false)
    expect(taskStore.getState().captures[key]?.instanceId).toBe('am')
    expect(writeTaskCell(measured, 'readings', 0, 'i', 2.5)).toBe(true)
    expect(taskStore.getState().captures[key]).toBeUndefined()
    expect(taskStore.getState().task.tables.readings?.[0]?.i).toBe(2.5)
  })
})

describe('recording current task measurements', () => {
  it('records and advances at most one expects-only step from a single current snapshot', () => {
    const measured = Project.parse({
      ...measuredProject('u'),
      steps: [
        { id: 'first', text: 'First', expects: [{ measurePoint: 'u', min: 1, max: 1.5 }] },
        { id: 'second', text: 'Second', expects: [{ measurePoint: 'u', min: 1, max: 1.5 }] },
      ],
    })
    resetTask(measured)
    runtime.snapshot.mockReturnValue(snapshot())
    expect(recordTaskReadings(measured)).toBe(true)
    expect(runtime.snapshot).toHaveBeenCalledTimes(1)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBe(1.234)
    expect(taskStore.getState().task.completedSteps).toEqual(['first'])
    expect(taskStore.getState().captures[taskCellKey('readings', 0, 'u')]?.referenceValueSI).toBe(1.234)
  })

  it('keeps genuine zero records and manual edits when an expects-only phase is not yet in range', () => {
    const measured = Project.parse({
      ...measuredProject('u'),
      steps: [{ id: 'measure', text: 'Measure', expects: [{ measurePoint: 'u', min: 1, max: 1.5 }] }],
      dataTables: [
        {
          id: 'readings',
          title: 'Readings',
          rows: 1,
          columns: [{ id: 'u', title: 'U', unit: 'V', measurePoint: 'u' }],
          sanity: [{ column: 'u', min: 1, max: 1.5, message: 'Check measured voltage' }],
        },
      ],
    })
    resetTask(measured)
    runtime.snapshot.mockReturnValue(snapshot(allWires, 0))
    expect(recordTaskReadings(measured)).toBe(true)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBe(0)
    expect(taskStore.getState().task.completedSteps).toEqual([])
    expect(taskStore.getState().notice).toContain('尚未满足步骤范围')
    expect(taskStore.getState().warnings.join(' ')).toContain('Check measured voltage')
    expect(writeTaskCell(measured, 'readings', 0, 'u', 1.234)).toBe(true)
    expect(completeCurrentTaskStep(measured)).toBe(false)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBe(1.234)
    expect(taskStore.getState().task.completedSteps).toEqual([])
  })

  it('reports an unavailable expects-only measurement without overwriting prior data', () => {
    const measured = Project.parse({
      ...measuredProject('u'),
      steps: [{ id: 'measure', text: 'Measure', expects: [{ measurePoint: 'u', min: 1, max: 1.5 }] }],
    })
    resetTask(measured)
    writeTaskCell(measured, 'readings', 0, 'u', 1.234)
    const current = snapshot()
    runtime.snapshot.mockReturnValue({
      ...current,
      readings: { ...current.readings, vm: { status: 'overload', value: null } },
    })
    expect(recordTaskReadings(measured)).toBe(false)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBe(1.234)
    expect(taskStore.getState().task.completedSteps).toEqual([])
    expect(taskStore.getState().notice).toContain('有效读数')
  })

  it('uses stage-selected tables without overwriting another phase at the same measurement point', () => {
    const phased = Project.parse({
      ...project,
      steps: [
        { id: 'open', text: '空载', measurePoints: ['u'], dataTable: 'phases' },
        { id: 'loaded', text: '带载', measurePoints: ['u'], dataTable: 'phases' },
      ],
      dataTables: [
        { id: 'unused', title: 'Other', rows: 2, columns: [{ id: 'value', title: 'Value' }] },
        {
          id: 'phases',
          title: 'Ro',
          rows: 1,
          columns: [
            { id: 'open', title: '空载', unit: 'V', measurePoint: 'u', captureSteps: ['open'] },
            { id: 'loaded', title: '带载', unit: 'V', measurePoint: 'u', captureSteps: ['loaded'] },
            { id: 'ro', title: 'Ro', unit: 'Ω', computed: '2400*(open/loaded-1)' },
          ],
        },
      ],
    })
    resetTask(phased)
    selectTaskRow(phased, 1)
    runtime.snapshot.mockReturnValue(snapshot(allWires, 2))
    expect(recordTaskReadings(phased)).toBe(true)
    expect(taskStore.getState().task.tables.phases?.[0]).toEqual({ open: 2, loaded: null, ro: null })
    expect(taskStore.getState().selectedTable).toBe('phases')
    expect(taskStore.getState().selectedRow).toBe(0)
    runtime.snapshot.mockReturnValue(snapshot(allWires, 1))
    expect(recordTaskReadings(phased)).toBe(true)
    expect(taskStore.getState().task.tables.phases?.[0]).toEqual({ open: 2, loaded: 1, ro: 2400 })
    expect(taskStore.getState().task.completedSteps).toEqual(['open', 'loaded'])
  })

  it('uses one snapshot and advances at most one original matching step across duplicate bound columns', () => {
    const repeated = Project.parse({
      ...project,
      steps: [
        { id: 'first', text: 'First', measurePoints: ['i'] },
        { id: 'second', text: 'Second', measurePoints: ['i'] },
      ],
      dataTables: project.dataTables.map((table) => ({
        ...table,
        columns: [...table.columns, { id: 'i-copy', title: 'I copy', unit: 'mA', measurePoint: 'i' }],
      })),
    })
    resetTask(repeated)
    const current = snapshot()
    runtime.snapshot.mockReturnValueOnce(current).mockReturnValueOnce({ ...current, current: false })
    expect(recordTaskReadings(repeated)).toBe(true)
    expect(runtime.snapshot).toHaveBeenCalledTimes(1)
    expect(taskStore.getState().task.tables.readings?.[0]).toEqual({ i: 2.5, u: 1.234, 'i-copy': 2.5 })
    expect(taskStore.getState().task.completedSteps).toEqual(['first'])
    expect(taskStore.getState()).toMatchObject({ bottomTab: 'data', leftTab: 'steps' })
  })

  it('records valid cells without auto-completing unconditional preparation', () => {
    runtime.snapshot.mockReturnValue(snapshot())
    expect(recordTaskReadings(project)).toBe(true)
    expect(taskStore.getState().task.tables.readings?.[0]).toEqual({ i: 2.5, u: 1.234 })
    expect(taskStore.getState().task.completedSteps).toEqual([])
    expect(completeCurrentTaskStep(project)).toBe(true)
    expect(taskStore.getState().task.completedSteps).toEqual(['prepare'])
  })

  it('keeps a valid record when the matching measured step fails its fresh wiring prerequisite', () => {
    const measured = Project.parse({
      ...measuredProject(),
      steps: [{ id: 'measure', text: 'Measure', measurePoints: ['i'], checkWiring: true }],
    })
    resetTask(measured)
    const wrong: [string, string][] = [...allWires, ['dc1.KH_D', 'dc1.KH_C']]
    runtime.snapshot.mockReturnValue(snapshot(wrong))
    runtime.input.mockReturnValue(input(wrong))
    expect(recordTaskReadings(measured)).toBe(true)
    expect(taskStore.getState().task.tables.readings?.[0]?.i).toBe(2.5)
    expect(taskStore.getState().captures[taskCellKey('readings', 0, 'i')]?.instanceId).toBe('am')
    expect(taskStore.getState().task.completedSteps).toEqual([])
    expect(taskStore.getState().notice).toContain('检查当前接线')
  })

  it('does not mutate another project task when actions receive an uninitialized project', () => {
    writeTaskCell(project, 'readings', 0, 'u', 1.234)
    const previous = taskStore.getState().task
    const other = Project.parse({ ...project, id: 'DG-06' })
    runtime.snapshot.mockReturnValue(snapshot())
    expect(recordTaskReadings(other)).toBe(false)
    expect(taskStore.getState().task).toBe(previous)
    expect(taskStore.getState().projectId).toBe(project.id)
    expect(taskStore.getState()).toMatchObject({ bottomTab: 'data', leftTab: 'steps' })
    expect(runtime.snapshot).not.toHaveBeenCalled()
  })

  it('retains partial successes without skipping an unmatched current measured step', () => {
    const measured = Project.parse({ ...project, steps: [{ id: 'i', text: 'I', measurePoints: ['i'] }] })
    resetTask(measured)
    runtime.snapshot.mockReturnValue(snapshot([...sourceWires, ...meterWires.slice(0, 2)]))
    expect(recordTaskReadings(measured)).toBe(true)
    expect(taskStore.getState().task.tables.readings?.[0]).toEqual({ i: null, u: 1.234 })
    expect(taskStore.getState().task.completedSteps).toEqual([])
    expect(taskStore.getState().captures[taskCellKey('readings', 0, 'u')]?.instanceId).toBe('vm')
  })

  it('does not overwrite manual data or advance on stale, unavailable or wrong-mode readings', () => {
    const measured = measuredProject()
    resetTask(measured)
    writeTaskCell(measured, 'readings', 0, 'i', 7)
    const current = snapshot()
    for (const invalid of [
      { ...current, current: false },
      { ...current, readings: { ...current.readings, am: { status: 'overload', value: 0.0025 } } },
    ]) {
      runtime.snapshot.mockReturnValue(invalid)
      expect(recordTaskReadings(measured)).toBe(false)
      expect(taskStore.getState().task.tables.readings?.[0]?.i).toBe(7)
      expect(taskStore.getState().task.completedSteps).toEqual([])
      expect(taskStore.getState()).toMatchObject({ bottomTab: 'data', leftTab: 'steps' })
    }
    const wrongMode = Project.parse({
      ...measured,
      reference: {
        ...measured.reference,
        measurePoints: measured.reference.measurePoints.map((point) =>
          point.id === 'i' ? { ...point, mode: 'aca' } : point,
        ),
      },
    })
    resetTask(wrongMode)
    runtime.snapshot.mockReturnValue(current)
    expect(recordTaskReadings(wrongMode)).toBe(false)
    expect(taskStore.getState().task.tables.readings?.[0]?.i).toBeNull()
  })

  it('requires a source choice for ambiguous voltage meters and uses the chosen reading', () => {
    const measured = measuredProject('u')
    resetTask(measured)
    runtime.snapshot.mockReturnValue(
      snapshot([...allWires, ['vm2.POS', 'dc1.KH_F'], ['vm2.NEG', 'dc1.KH_A']], 1.234, 0.0025, true),
    )
    expect(recordTaskReadings(measured)).toBe(false)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBeNull()
    expect(taskStore.getState().notice).toMatch(/选择.*仪表/)
    selectTaskSource('vm2')
    expect(recordTaskReadings(measured)).toBe(true)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBe(1.25)
    expect(taskStore.getState().captures[taskCellKey('readings', 0, 'u')]?.instanceId).toBe('vm2')
  })

  it('records reference-oriented values while retaining reversed display polarity and SI feedback', () => {
    const measured = measuredProject()
    resetTask(measured)
    runtime.snapshot.mockReturnValue(
      snapshot(
        [...sourceWires, ...meterWires.slice(0, 2), ['am.POS', 'dc1.KH_I1B'], ['am.NEG', 'dc1.KH_I1A']],
        1.234,
        -0.0025,
      ),
    )
    expect(recordTaskReadings(measured)).toBe(true)
    expect(taskStore.getState().task.tables.readings?.[0]?.i).toBe(2.5)
    expect(taskStore.getState().captures[taskCellKey('readings', 0, 'i')]).toMatchObject({
      displayValueSI: -0.0025,
      referenceValueSI: 0.0025,
      reversed: true,
    })
    expect(taskStore.getState().notice).toMatch(/接反|反接/)
    expect(taskStore.getState().notice).toMatch(/显示|表屏/)
    expect(taskStore.getState().notice).toContain('参考')
  })
})

describe('current task step completion', () => {
  it('does not allow manually typed expected data to replace fresh capture evidence', () => {
    const measured = Project.parse({
      ...measuredProject(),
      steps: [{ id: 'measure', text: 'Measure', expect: { measurePoint: 'i', min: 0.002, max: 0.003 } }],
    })
    resetTask(measured)
    writeTaskCell(measured, 'readings', 0, 'i', 2.5)
    expect(completeCurrentTaskStep(measured)).toBe(false)
    runtime.snapshot.mockReturnValue({ ...snapshot(), current: false })
    expect(completeCurrentTaskStep(measured)).toBe(false)
    expect(taskStore.getState().task.completedSteps).toEqual([])
    runtime.snapshot.mockReturnValue(snapshot())
    expect(completeCurrentTaskStep(measured)).toBe(true)
    expect(taskStore.getState().task.completedSteps).toEqual(['measure'])
  })

  it('checks the current powered-off graph instead of an old published measurement plan', () => {
    const wired = Project.parse({
      ...project,
      steps: [{ id: 'wire', text: 'Wire', checkWiring: true, measurePoints: [] }],
    })
    resetTask(wired)
    runtime.powered = false
    runtime.snapshot.mockReturnValue(snapshot())
    runtime.input.mockReturnValue(input(allWires.filter(([a]) => a !== 'ins-dc-power.CH2N')))
    expect(completeCurrentTaskStep(wired)).toBe(false)
    expect(taskStore.getState().task.completedSteps).toEqual([])
    runtime.input.mockReturnValue(input())
    expect(completeCurrentTaskStep(wired)).toBe(true)
    expect(runtime.input).toHaveBeenCalledTimes(2)
  })

  it('rejects a source short while powered off even when unsafe reference topology matches it', () => {
    const unsafe = Project.parse({
      ...project,
      reference: {
        ...project.reference,
        nets: [['ins-dc-power.CH1P', 'ins-dc-power.CH1N', 'dc1.KH_U1P', 'dc1.KH_U1N'], sourceWires[2], sourceWires[3]],
      },
      steps: [{ id: 'wire', text: 'Wire', checkWiring: true, measurePoints: [] }],
    })
    const unsafeInput = input([...allWires, ['ins-dc-power.CH1P', 'ins-dc-power.CH1N']])
    const plan = buildMeasurementPlan(unsafeInput, false, 'unsafe-test')
    expect(checkWiring(plan.checkInput, scopedReference(unsafe, unsafe.steps[0])).circuitOk).toBe(true)
    resetTask(unsafe)
    runtime.powered = false
    runtime.input.mockReturnValue(unsafeInput)
    expect(completeCurrentTaskStep(unsafe)).toBe(false)
    expect(taskStore.getState().task.completedSteps).toEqual([])
  })

  it('requires the selected table row to be complete before explicit analysis completion', () => {
    const analysis = Project.parse({
      ...project,
      steps: [{ id: 'analyse', text: 'Analyse', measurePoints: [], recordTable: 'readings' }],
    })
    resetTask(analysis)
    writeTaskCell(analysis, 'readings', 0, 'i', 2.5)
    writeTaskCell(analysis, 'readings', 0, 'u', 1.234)
    selectTaskRow(analysis, 1)
    expect(completeCurrentTaskStep(analysis)).toBe(false)
    expect(taskStore.getState().task.completedSteps).toEqual([])
    selectTaskRow(analysis, 0)
    expect(completeCurrentTaskStep(analysis)).toBe(true)
    expect(taskStore.getState().task.completedSteps).toEqual(['analyse'])
  })
})

describe('compact task-cell display', () => {
  it.each([
    [null, ''],
    [0, '0'],
    [-0, '0'],
    [191 * 1e-5, '0.00191'],
    [784 * 1e-5, '0.00784'],
    [-0.005950000000000001, '-0.00595'],
    [1e-20, '1e-20'],
    [1.23456789012, '1.23456789012'],
    [0.0019100000004, '0.0019100000004'],
    [0.0078400000001, '0.0078400000001'],
  ] as const)('formats %s as %s without tightening meaningful precision', (value, expected) => {
    expect(formatTaskCellValue(value)).toBe(expected)
  })

  it('does not change stored numbers, captures or progress while formatting a display draft', () => {
    runtime.snapshot.mockReturnValue(snapshot())
    expect(recordTaskReadings(project)).toBe(true)
    const precise = 1.2345678901234567
    writeTaskCell(project, 'readings', 0, 'u', precise)
    const before = taskStore.getState()
    const copy = structuredClone(before)
    expect(formatTaskCellValue(before.task.tables.readings?.[0]?.u ?? null)).toBe('1.23456789012')
    expect(taskStore.getState()).toBe(before)
    expect(taskStore.getState()).toEqual(copy)
    expect(taskStore.getState().task.tables.readings?.[0]?.u).toBe(precise)
    expect(taskStore.getState().captures[taskCellKey('readings', 0, 'i')]).toBeDefined()
  })
})
