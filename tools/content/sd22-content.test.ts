import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { getInstrumentDefaults } from '../../src/domain/instruments/index.ts'
import type { SignalMeasurement } from '../../src/domain/instruments/scope.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import {
  captureMeasurePoint,
  completeTaskStep,
  createTaskState,
  type MeasurementSnapshot,
  recordCurrentReading,
  scopedReference,
} from '../../src/domain/task/index.ts'
import { type CheckInput, checkTopology } from '../../src/domain/wiring-check/index.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'

function text(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

function json(path: string): unknown {
  return JSON.parse(text(path))
}

const rawProject = json('content/projects/SD-22/project.json')
const project = Project.parse(rawProject)
const timer = Module.parse(json('content/modules/mod-555-app/module.json'))
const follower = Module.parse(json('content/modules/mod-voltage-follower/module.json'))
const supply = Instrument.parse(json('content/instruments/ins-dc-power/instrument.json'))
const scope = Instrument.parse(json('content/instruments/ins-oscilloscope/instrument.json'))
const guide = text('content/projects/SD-22/guide.md')
const schematic = text('content/projects/SD-22/schematic.svg')
const topologyText = text('content/projects/SD-22/reference-topologies.md')
const references = [...topologyText.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((match) =>
  Project.shape.reference.parse(JSON.parse(match[1] ?? '')),
)

function step(id: string): Project['steps'][number] {
  const result = project.steps.find((entry) => entry.id === id)
  if (!result) throw new Error(`Unknown content step: ${id}`)
  return result
}

function point(id: string): Project['reference']['measurePoints'][number] {
  const result = project.reference.measurePoints.find((entry) => entry.id === id)
  if (!result) throw new Error(`Unknown content point: ${id}`)
  return result
}

function wires(nets: string[][], shape: 'star' | 'chain'): { a: string; b: string }[] {
  return nets.flatMap((net) =>
    net.slice(1).map((b, index) => ({ a: (shape === 'star' ? net[0] : net[index]) as string, b })),
  )
}

function input(reference: Project['reference'], shape: 'star' | 'chain' = 'star'): CheckInput {
  return {
    modules: [
      { instanceId: 'timer1', module: timer },
      { instanceId: 'follower1', module: follower },
    ],
    instruments: [{ instanceId: supply.id, instrument: supply }],
    wires: wires(reference.nets, shape),
  }
}

function stateAt(stepId: string) {
  const index = project.steps.findIndex((entry) => entry.id === stepId)
  if (index < 0) throw new Error(`Unknown step: ${stepId}`)
  return { ...createTaskState(project), completedSteps: project.steps.slice(0, index).map((entry) => entry.id) }
}

// Protocol-only samples exercise content gates; real circuit evidence lives in the ngspice golden suite.
function snapshot(
  reference: Project['reference'],
  jack: string,
  measurement: SignalMeasurement,
  second?: { jack: string; measurement: SignalMeasurement },
): MeasurementSnapshot {
  const channels = [{ id: 'CH1', jack, measurement }, ...(second ? [{ id: 'CH2', ...second }] : [])]
  const circuit: AssembleInput = {
    title: 'SD-22 protocol-only content evidence',
    modules: [
      { instanceId: 'timer1', module: timer, subckt: text('content/modules/mod-555-app/module.cir') },
      {
        instanceId: 'follower1',
        module: follower,
        subckt: text('content/modules/mod-voltage-follower/module.cir'),
      },
    ],
    instruments: [
      { instanceId: supply.id, instrument: supply, settings: { ...getInstrumentDefaults(supply), ch1_v: 5 } },
      { instanceId: 'scope1', instrument: scope, settings: getInstrumentDefaults(scope) },
    ],
    wires: [
      ...wires(reference.nets, 'star'),
      ...channels.map((channel) => ({ a: `scope1.${channel.id}`, b: `timer1.${channel.jack}` })),
      { a: 'scope1.GND', b: 'timer1.GND1' },
    ],
    controlValues: {},
    analysis: [],
  }
  const plan = buildMeasurementPlan(circuit, true, 'content-only')
  return {
    current: true,
    plan,
    readings: {},
    waveforms: channels.map((channel) => ({
      instanceId: 'scope1',
      channelId: channel.id,
      positiveRef: `scope1.${channel.id}`,
      negativeRef: 'scope1.GND',
      coupling: 'dc',
      current: true,
      measurement: channel.measurement,
      window: {
        start: 1,
        end: 1.2,
        rawStep: 2e-6,
        completeCycles: channel.measurement.completeCycles ?? 0,
        source: 'raw',
        revision: 1,
        frozen: false,
      },
    })),
  }
}

const carrier: SignalMeasurement = {
  mean: 1.5,
  min: 0,
  max: 3,
  vpp: 3,
  frequency: 1100,
  period: 1 / 1100,
  completeCycles: 2,
}

describe('SD-22 approved two-mode content and evidence contracts', () => {
  it('retains every configured field and uses two compatible independent module slots', () => {
    expect(project).toEqual(rawProject)
    expect(project.modules).toEqual([
      { instanceId: 'timer1', moduleId: 'mod-555-app', slot: 'SLOT_BOX_L1' },
      { instanceId: 'follower1', moduleId: 'mod-voltage-follower', slot: 'SLOT_BOX_L2' },
    ])
    const catalog = json('assets/layouts/catalog.json') as {
      assets: { kind: string; slots?: { id: string; kind: string }[] }[]
    }
    const slots = catalog.assets.find((asset) => asset.kind === 'bench')?.slots ?? []
    for (const placement of project.modules)
      expect(slots.find((slot) => slot.id === placement.slot)?.kind).toBe('module')
  })

  it('contains all six complete guide sections and the same ten original questions', () => {
    for (const heading of ['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题'])
      expect(guide).toContain(`## ${heading}\n`)
    const questions = [...(guide.split('## 思考题\n')[1] ?? '').matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1])
    expect(questions).toEqual(project.questions)
    expect(questions).toHaveLength(10)
  })

  it('shows all original 36 jacks and each of the four independent follower jacks', () => {
    const original = [...schematic.matchAll(/data-jack-id="([^"]+)"/g)].map((match) => match[1])
    const adapter = [...schematic.matchAll(/data-jack-id="([^"]+)" data-module-id="follower1"/g)].map(
      (match) => match[1],
    )
    expect(original).toHaveLength(40)
    expect(new Set(original).size).toBe(40)
    expect(original.filter((id) => !adapter.includes(id as string)).sort()).toEqual(
      timer.jacks.map((jack) => jack.id).sort(),
    )
    expect(adapter.sort()).toEqual(follower.jacks.map((jack) => jack.id).sort())
    expect(schematic).toContain('Original code-native teaching schematic')
    expect(schematic).toContain('已批准缓冲')
    expect(schematic).not.toMatch(/(?:href|src)="https?:\/\//)
  })

  it('keeps approved fire and historical failing prototype networks distinct', () => {
    expect(references).toHaveLength(3)
    const [ambulance, fire, prototype] = references
    expect(ambulance).toEqual(project.reference)
    expect(fire?.nets).toEqual(step('wire-fire-buffered').referenceNets)
    expect(prototype?.nets.find((net) => net.includes('timer1.R5_1'))).toContain('timer1.T1_TH')
    expect(fire?.nets.find((net) => net.includes('timer1.R5_1'))).toEqual(['follower1.OUT', 'timer1.R5_1'])
    expect(fire?.nets.find((net) => net.includes('timer1.T1_TH'))).toContain('follower1.IN')
    expect(topologyText).toContain('## 消防车原型参考拓扑')
    expect(project.steps.some((entry) => entry.id.includes('prototype'))).toBe(false)
  })

  it('supplies every step with a complete explicitly selected topology', () => {
    const switchIndex = project.steps.findIndex((entry) => entry.id === 'wire-fire-buffered')
    project.steps.forEach((entry, index) => {
      const selected = index < switchIndex ? references[0] : references[1]
      expect(entry.referenceNets).toEqual(selected?.nets)
      expect(scopedReference(project, entry).nets).toEqual(selected?.nets)
    })
    expect(project.steps).toHaveLength(17)
  })

  it.each([0, 1, 2])('accepts equivalent star and chain wiring for network %i', (index) => {
    const reference = references[index] as Project['reference']
    expect(checkTopology(input(reference, 'star'), reference)).toEqual([])
    expect(checkTopology(input(reference, 'chain'), reference)).toEqual([])
  })

  it.each(['timer1.T1_OUT', 'timer1.T1_TH'])('rejects %s connected to the approved buffer output network', (source) => {
    const fire = references[1] as Project['reference']
    const circuit = input(fire)
    circuit.wires.push({ a: source, b: 'timer1.R5_1' })
    expect(checkTopology(circuit, fire).some((issue) => issue.code === 'extra-connection')).toBe(true)
  })

  it('rejects replacing approved buffer wiring with the historical prototype', () => {
    const fire = references[1] as Project['reference']
    expect(
      checkTopology(input(references[2] as Project['reference']), fire).some((issue) => issue.severity === 'error'),
    ).toBe(true)
  })

  it('uses the original source and ground for the approved adapter', () => {
    const fire = references[1] as Project['reference']
    expect(fire.nets.find((net) => net.includes('follower1.VCC'))).toEqual(
      expect.arrayContaining(['ins-dc-power.CH1P', 'timer1.VCC1']),
    )
    expect(fire.nets.find((net) => net.includes('follower1.GND'))).toEqual(
      expect.arrayContaining(['ins-dc-power.CH1N', 'timer1.GND1']),
    )
    expect(project.reference.nets.flat().some((ref) => ref.startsWith('follower1.'))).toBe(false)
    expect(fire.nets.find((net) => net.includes('timer1.T2_CV'))).toEqual([
      'timer1.R5_2',
      'timer1.T2_CV',
      'timer1.T2_CC_1',
    ])
  })

  it('keeps supply, reset, electrolytic, nonpolar C2 and speaker polarities consistent', () => {
    const ground = project.reference.nets.find((net) => net.includes('timer1.GND1'))
    const positive = project.reference.nets.find((net) => net.includes('timer1.VCC1'))
    expect(ground).toEqual(
      expect.arrayContaining(['ins-dc-power.CH1N', 'timer1.T1_CT_N', 'timer1.T2_CT_N', 'timer1.SPK_N']),
    )
    expect(positive).toEqual(expect.arrayContaining(['ins-dc-power.CH1P', 'timer1.T1_RST', 'timer1.T2_RST']))
    expect(project.reference.nets).toContainEqual(['timer1.T2_OUT', 'timer1.C5_P'])
    expect(project.reference.nets).toContainEqual(['timer1.C5_N', 'timer1.SPK_P'])
    expect(point('speaker-vpp').between).toEqual(['timer1.SPK_P', 'timer1.SPK_N'])
    for (const id of ['VCC1', 'T1_CT_P', 'C5_P', 'SPK_P'])
      expect(timer.jacks.find((jack) => jack.id === id)?.polarityHint).toBe('+')
    for (const id of ['GND1', 'T1_CT_N', 'C5_N', 'SPK_N'])
      expect(timer.jacks.find((jack) => jack.id === id)?.polarityHint).toBe('-')
    expect(timer.jacks.find((jack) => jack.id === 'T2_CT_P')?.polarityHint).toBeUndefined()
    expect(timer.jacks.find((jack) => jack.id === 'T2_CT_N')?.polarityHint).toBeUndefined()
  })

  it('binds each numeric column to an explicit point and isolated capture stage', () => {
    const units: Record<string, string> = { frequency: 'Hz', period: 's', mean: 'V', vpp: 'V', min: 'V', max: 'V' }
    for (const table of project.dataTables)
      for (const column of table.columns) {
        expect(column.measurePoint).toBeTruthy()
        expect(column.captureSteps?.length).toBe(1)
        const bound = point(column.measurePoint as string)
        expect(column.unit).toBe(bound.kind === 'waveform' ? units[bound.quantity as string] : 'V')
        expect(step(column.captureSteps?.[0] as string).dataTable).toBe(table.id)
      }
    expect(project.dataTables).toHaveLength(6)
  })

  it('requires real cycles for periodic metrics without blocking static CV platform means', () => {
    for (const bound of project.reference.measurePoints.filter((entry) => entry.kind === 'waveform')) {
      expect(bound.quantity).toBeTruthy()
      expect(bound.minCycles).toBe(bound.id === 'control-mean' ? undefined : 2)
    }
    const measurement = {
      ...carrier,
      mean: 3.325,
      min: 3.325,
      max: 3.325,
      vpp: 0,
      frequency: null,
      period: null,
      completeCycles: 0,
    }
    const result = captureMeasurePoint(snapshot(project.reference, 'T2_CV', measurement), point('control-mean'))
    expect(result).toMatchObject({ ok: true, measurement: { referenceValueSI: 3.325 } })
  })

  it('adds only the four explicit steady-phase gate sets without replacing original single-point ranges', () => {
    const lowFrequency = { measurePoint: 'lf-frequency', min: 0.9243085, max: 0.9429814 }
    const extrema = [
      { measurePoint: 'lf-cap-min', min: 1.64, max: 1.9 },
      { measurePoint: 'lf-cap-max', min: 3.1, max: 3.6 },
    ]
    for (const id of ['ambulance-lf', 'fire-buffered-lf']) {
      expect(step(id).expect).toEqual(lowFrequency)
      expect(step(id).expects).toEqual(extrema)
    }
    expect(step('ambulance-tone-low').expect).toEqual({
      measurePoint: 'carrier-frequency',
      min: 1013.202,
      max: 1033.67,
    })
    expect(step('ambulance-tone-low').expects).toEqual([{ measurePoint: 'control-mean', min: 3.31, max: 3.34 }])
    expect(step('ambulance-tone-high').expect).toEqual({
      measurePoint: 'carrier-frequency',
      min: 1394.168,
      max: 1422.334,
    })
    expect(step('ambulance-tone-high').expects).toEqual([{ measurePoint: 'control-mean', min: 2.49, max: 2.51 }])
    expect(project.steps.filter((entry) => entry.expects?.length).map((entry) => entry.id)).toEqual([
      'ambulance-lf',
      'ambulance-tone-low',
      'ambulance-tone-high',
      'fire-buffered-lf',
    ])
  })

  it('keeps startup zero recordable in both low-frequency modes without completing a steady-extrema phase', () => {
    const low = { ...carrier, frequency: 0.933625, period: 1 / 0.933625, completeCycles: 2 }
    const capacitor = { ...low, min: 0, max: 3.3333, vpp: 3.3333, mean: 2.2 }
    for (const id of ['ambulance-lf', 'fire-buffered-lf']) {
      const entry = step(id)
      const evidence = snapshot(scopedReference(project, entry), 'T1_OUT', low, {
        jack: 'T1_TH',
        measurement: capacitor,
      })
      for (const reading of evidence.waveforms ?? [])
        reading.window = {
          start: 0,
          end: 4,
          rawStep: 2e-6,
          completeCycles: 2,
          source: 'stream',
          revision: 1,
          frozen: false,
        }
      const recorded = recordCurrentReading(project, stateAt(id), entry.dataTable as string, 0, 'ct-min', {
        snapshot: evidence,
        wiringCorrect: true,
      })
      expect(recorded.ok).toBe(true)
      expect(recorded.state.tables[entry.dataTable as string]?.[0]?.['ct-min']).toBe(0)
      expect(recorded.warnings.join(' ')).toContain('C1 下阈值')
      expect(recorded.measurement?.window).toMatchObject({ start: 0, end: 4, source: 'stream', completeCycles: 2 })
      expect(recorded.state.completedSteps).not.toContain(id)
      expect(completeTaskStep(project, recorded.state, id, { snapshot: evidence, wiringCorrect: true }).ok).toBe(false)
      expect(evidence.waveforms?.[1]?.measurement?.min).toBe(0)
    }
  })

  it('completes both low-frequency modes only when current steady minimum and maximum both satisfy their gates', () => {
    const low = { ...carrier, frequency: 0.933625, period: 1 / 0.933625, completeCycles: 3 }
    const capacitor = { ...low, min: 1.66664, max: 3.33329, vpp: 3.33329 - 1.66664, mean: 2.55 }
    for (const id of ['ambulance-lf', 'fire-buffered-lf']) {
      const entry = step(id)
      const reference = scopedReference(project, entry)
      const evidence = snapshot(reference, 'T1_OUT', low, { jack: 'T1_TH', measurement: capacitor })
      for (const reading of evidence.waveforms ?? [])
        reading.window = {
          start: 1.5,
          end: 5.5,
          rawStep: 2e-6,
          completeCycles: 3,
          source: 'stream',
          revision: 1,
          frozen: false,
        }
      const completed = completeTaskStep(project, stateAt(id), id, { snapshot: evidence, wiringCorrect: true })
      expect(completed.ok).toBe(true)
      expect(completed.state.completedSteps).toContain(id)
      const recorded = recordCurrentReading(project, stateAt(id), entry.dataTable as string, 0, 'ct-max', {
        snapshot: evidence,
        wiringCorrect: true,
        advance: false,
      })
      expect(recorded.ok).toBe(true)
      expect(recorded.measurement?.window).toMatchObject({ start: 1.5, end: 5.5, source: 'stream' })
      for (const invalid of [
        { ...capacitor, min: 2 },
        { ...capacitor, max: 2.9 },
      ]) {
        const wrongRange = snapshot(reference, 'T1_OUT', low, { jack: 'T1_TH', measurement: invalid })
        expect(completeTaskStep(project, stateAt(id), id, { snapshot: wrongRange, wiringCorrect: true }).ok).toBe(false)
      }
    }
  })

  it('rejects mixed CV means despite a matched recent carrier and accepts each actual static tone plateau', () => {
    for (const [id, frequency, voltage] of [
      ['ambulance-tone-low', 1023.436, 3.325],
      ['ambulance-tone-high', 1408.251, 2.5006],
    ] as const) {
      const entry = step(id)
      const matchedCarrier = { ...carrier, frequency, period: 1 / frequency }
      const mixed = { ...carrier, min: 2.5006, max: 3.325, mean: 3.1, vpp: 3.325 - 2.5006 }
      const reference = scopedReference(project, entry)
      const evidence = snapshot(reference, 'T2_OUT', matchedCarrier, { jack: 'T2_CV', measurement: mixed })
      expect(captureMeasurePoint(evidence, point('carrier-frequency')).ok).toBe(true)
      expect(captureMeasurePoint(evidence, point('control-mean')).ok).toBe(true)
      expect(completeTaskStep(project, stateAt(id), id, { snapshot: evidence, wiringCorrect: true }).ok).toBe(false)
      const plateau = {
        ...mixed,
        min: voltage,
        max: voltage,
        mean: voltage,
        vpp: 0,
        frequency: null,
        period: null,
        completeCycles: 0,
      }
      const current = snapshot(reference, 'T2_OUT', matchedCarrier, { jack: 'T2_CV', measurement: plateau })
      const completed = completeTaskStep(project, stateAt(id), id, { snapshot: current, wiringCorrect: true })
      expect(completed.ok).toBe(true)
      expect(completed.state.completedSteps).toContain(id)
      expect(current.waveforms?.[1]?.measurement).toMatchObject({ mean: voltage, completeCycles: 0 })
    }
  })

  it('keeps the three gradual-tone gate ranges non-overlapping', () => {
    const ranges = ['low', 'mid', 'high'].map((id) => step(`fire-buffered-tone-${id}`).expect)
    expect(ranges.map((range) => [range?.min, range?.max])).toEqual([
      [1020, 1060],
      [1090, 1140],
      [1170, 1230],
    ])
    expect((ranges[0]?.max ?? 0) < (ranges[1]?.min ?? 0)).toBe(true)
    expect((ranges[1]?.max ?? 0) < (ranges[2]?.min ?? 0)).toBe(true)
    for (const range of ranges) expect(range?.measurePoint).toBe('carrier-frequency')
  })

  it('starts every table empty and cannot advance on hand-filled values plus wiring only', () => {
    const initial = createTaskState(project)
    for (const rows of Object.values(initial.tables))
      for (const row of rows) expect(Object.values(row).every((value) => value === null)).toBe(true)
    for (const entry of project.steps.filter((item) => item.measurePoints?.length)) {
      const state = stateAt(entry.id)
      for (const rows of Object.values(state.tables))
        for (const row of rows) for (const key of Object.keys(row)) row[key] = 1
      expect(completeTaskStep(project, state, entry.id, { wiringCorrect: true }).ok).toBe(false)
    }
  })

  it('does not allow a fixed middle carrier to complete low and high tone gates', () => {
    const fire = references[1] as Project['reference']
    const state = snapshot(fire, 'T2_OUT', carrier)
    for (const phase of ['low', 'high']) {
      const id = `fire-buffered-tone-${phase}`
      const entry = step(id)
      const onlyCarrier = Project.parse({
        ...project,
        steps: project.steps.map((item) =>
          item.id === id ? { ...entry, measurePoints: ['carrier-frequency'], recordTable: undefined } : item,
        ),
      })
      expect(completeTaskStep(onlyCarrier, stateAt(id), id, { snapshot: state, wiringCorrect: true }).ok).toBe(false)
    }
  })

  it('rejects a CV extremum window that still contains startup despite two recent cycles', () => {
    const entry = step('fire-buffered-cv')
    expect(entry.expect).toEqual({ measurePoint: 'control-min', min: 2.9, max: 2.94 })
    const measured = {
      ...carrier,
      min: 2.5,
      max: 3.3333,
      vpp: 0.8333,
      mean: 3.05,
      frequency: 0.9891,
      period: 1 / 0.9891,
      completeCycles: 2,
    }
    const evidence = snapshot(references[1] as Project['reference'], 'T2_CV', measured)
    const reading = evidence.waveforms?.[0]
    if (!reading) throw new Error('Missing protocol-only CV evidence')
    reading.window = {
      start: 0,
      end: 4,
      rawStep: 2e-6,
      completeCycles: 2,
      source: 'stream',
      revision: 1,
      frozen: false,
    }
    const result = completeTaskStep(project, stateAt(entry.id), entry.id, {
      snapshot: evidence,
      wiringCorrect: true,
      row: 0,
    })
    expect(result.ok).toBe(false)
    expect(result.state.completedSteps).not.toContain(entry.id)
    expect(reading.measurement?.min).toBe(2.5)
    expect(reading.window.start).toBe(0)
  })

  it('accepts current steady CV extrema only with the required real-cycle evidence', () => {
    const entry = step('fire-buffered-cv')
    const measured = {
      ...carrier,
      min: 2.9166,
      max: 3.3333,
      vpp: 3.3333 - 2.9166,
      mean: 3.125,
      frequency: 0.9891,
      period: 1 / 0.9891,
      completeCycles: 2,
    }
    const evidence = snapshot(references[1] as Project['reference'], 'T2_CV', measured)
    const reading = evidence.waveforms?.[0]
    if (!reading) throw new Error('Missing protocol-only CV evidence')
    reading.window = {
      start: 1.5,
      end: 5.5,
      rawStep: 2e-6,
      completeCycles: 2,
      source: 'stream',
      revision: 1,
      frozen: false,
    }
    const result = completeTaskStep(project, stateAt(entry.id), entry.id, {
      snapshot: evidence,
      wiringCorrect: true,
      row: 0,
    })
    expect(result.ok).toBe(true)
    expect(result.state.completedSteps).toContain(entry.id)
    expect(reading.measurement?.min).toBe(2.9166)
    expect(reading.window).toMatchObject({ start: 1.5, end: 5.5, source: 'stream' })
  })

  it('rejects insufficient or stale waveform evidence before content progression', () => {
    const fire = references[1] as Project['reference']
    const enough = snapshot(fire, 'T2_OUT', carrier)
    const insufficient = snapshot(fire, 'T2_OUT', { ...carrier, completeCycles: 1 })
    expect(captureMeasurePoint(insufficient, point('carrier-frequency'))).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(captureMeasurePoint({ ...enough, current: false }, point('carrier-frequency'))).toMatchObject({
      ok: false,
      reason: 'not-current',
    })
  })

  it('prevents out-of-stage capture from overwriting a previously recorded tone', () => {
    const state = stateAt('ambulance-tone-high')
    const row = state.tables.ambulance?.[0]
    if (!row) throw new Error('Missing ambulance row')
    row['f-tone-low'] = 1023.436
    const result = recordCurrentReading(project, state, 'ambulance', 0, 'f-tone-low', {
      snapshot: snapshot(project.reference, 'T2_OUT', { ...carrier, frequency: 1408.251, period: 1 / 1408.251 }),
    })
    expect(result.ok).toBe(false)
    expect(result.state.tables.ambulance?.[0]?.['f-tone-low']).toBe(1023.436)
  })

  it('states independent estimated modelling, preserved diagnosis and unfinished runtime acceptance', () => {
    expect(guide).toContain('不是 TI SPICE 模型或厂商最坏条件保证')
    expect(guide).toContain('原型停振诊断补充')
    expect(guide).toContain('不能宣称严格对应同一瞬间')
    expect(guide).toContain('应用集成未完成')
    expect(guide).toContain('应用集成验收未完成')
    expect(guide).toContain('0.175/0.137')
    expect(guide).toContain('3/17')
    expect(guide).toContain('不剪裁样本、不自动删除启动')
    expect(project.validation?.limitations.join(' ')).toContain('正式双模式实时性能')
    expect(guide).not.toContain('缓冲修订待审批')
  })
})
