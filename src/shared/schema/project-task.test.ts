import { describe, expect, it } from 'vitest'
import { MeasurePoint, Project } from './project.ts'

const sample = () => ({
  id: 'DG-05',
  group: 'dc',
  title: 'Kirchhoff',
  type: 'basic',
  modules: [{ instanceId: 'dc1', moduleId: 'mod-dc-circuit', slot: 'SLOT_BOX_L1' }],
  allowedInstruments: [],
  reference: {
    nets: [],
    measurePoints: [
      { id: 'u', kind: 'voltage', mode: 'dcv', between: ['dc1.KH_F', 'dc1.KH_A'] },
      { id: 'i', kind: 'current', mode: 'dca', branch: ['dc1.KH_I1A', 'dc1.KH_I1B'] },
    ],
  },
  steps: [
    { id: 'wire', text: 'Wire', measurePoints: [], checkWiring: true },
    { id: 'measure', text: 'Measure', measurePoints: ['u'] },
    { id: 'analyse', text: 'Analyse', recordTable: 'table' },
  ],
  dataTables: [
    {
      id: 'table',
      title: 'Readings',
      columns: [{ id: 'u', title: 'U', unit: 'V', measurePoint: 'u' }],
      rows: 1,
      sanity: [{ column: 'u', min: -20, max: 20, message: 'Check range' }],
    },
  ],
  questions: [],
})
const paths = (value: unknown) => {
  const result = Project.safeParse(value)
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
}

describe('Project task content', () => {
  it('accepts complete step topology replacements while retaining the default reference', () => {
    const data = sample()
    const referenceNets = [['dc1.KH_F', 'dc1.KH_A']]
    const project = Project.parse({
      ...data,
      steps: [{ ...data.steps[0], referenceNets }, ...data.steps.slice(1)],
    })
    expect(project.steps[0]?.referenceNets).toEqual(referenceNets)
    expect(project.reference.nets).toEqual(data.reference.nets)
    expect(project.steps[1]?.referenceNets).toBeUndefined()
  })

  it('rejects malformed or multiply owned step topology jacks without combining modes', () => {
    const data = sample()
    expect(paths({ ...data, steps: [{ ...data.steps[0], referenceNets: [] }] })).toContain('steps.0.referenceNets')
    expect(paths({ ...data, steps: [{ ...data.steps[0], referenceNets: [['dc1.KH_F']] }] })).toContain(
      'steps.0.referenceNets.0',
    )
    expect(
      paths({
        ...data,
        steps: [{ ...data.steps[0], referenceNets: [['dc1.KH_F', 'unknown']] }],
      }),
    ).toContain('steps.0.referenceNets.0.1')
    expect(
      paths({
        ...data,
        steps: [
          {
            ...data.steps[0],
            referenceNets: [
              ['dc1.KH_F', 'dc1.KH_A'],
              ['dc1.KH_F', 'dc1.KH_D'],
            ],
          },
        ],
      }),
    ).toContain('steps.0.referenceNets.1.0')
  })

  it('accepts optional sequential scopes, wiring and table prerequisites', () => {
    const project = Project.parse(sample())
    expect(project.steps[0]).toMatchObject({ measurePoints: [], checkWiring: true })
    expect(project.steps[1]).toMatchObject({ measurePoints: ['u'] })
    expect(project.steps[2]?.recordTable).toBe('table')
  })

  it('retains undefined scopes and modes in legacy content', () => {
    const data = sample()
    const project = Project.parse({
      ...data,
      reference: {
        ...data.reference,
        measurePoints: [{ id: 'u', kind: 'voltage', between: ['dc1.KH_F', 'dc1.KH_A'] }],
      },
      steps: [{ id: 'measure', text: 'Measure' }],
    })
    expect(project.steps[0]?.measurePoints).toBeUndefined()
    expect(project.steps[0]?.expects).toBeUndefined()
    expect(project.reference.measurePoints[0]?.mode).toBeUndefined()
  })

  it('retains additive measurement expectations without replacing the legacy expectation', () => {
    const data = sample()
    const expectRange = { measurePoint: 'u', min: 0, max: 2 }
    const expects = [
      { measurePoint: 'u', min: 1, max: 1.5 },
      { measurePoint: 'i', min: 0.002, max: 0.003 },
    ]
    const project = Project.parse({
      ...data,
      steps: [{ id: 'measure', text: 'Measure', expect: expectRange, expects }],
    })
    expect(project.steps[0]?.expect).toEqual(expectRange)
    expect(project.steps[0]?.expects).toEqual(expects)
    expect(project.steps[0]?.measurePoints).toBeUndefined()
    expect(
      Project.parse({ ...data, steps: [{ id: 'measure', text: 'Measure', expect: expectRange, expects: [] }] }).steps[0]
        ?.expect,
    ).toEqual(expectRange)
  })

  it('rejects invalid additional ranges and missing measurement references at their own paths', () => {
    const data = sample()
    expect(
      paths({
        ...data,
        steps: [{ id: 'measure', text: 'Measure', expects: [{ measurePoint: 'absent', min: 0, max: 1 }] }],
      }),
    ).toContain('steps.0.expects.0.measurePoint')
    expect(
      paths({
        ...data,
        steps: [{ id: 'measure', text: 'Measure', expects: [{ measurePoint: 'u', min: 2, max: 1 }] }],
      }),
    ).toContain('steps.0.expects.0.max')
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        paths({
          ...data,
          steps: [{ id: 'measure', text: 'Measure', expects: [{ measurePoint: 'u', min: value, max: 1 }] }],
        }),
      ).toContain('steps.0.expects.0.min')
    }
    expect(
      Project.safeParse({
        ...data,
        steps: [{ id: 'measure', text: 'Measure', expects: [{ measurePoint: 'u', min: 0, max: 0 }] }],
      }).success,
    ).toBe(true)
  })

  it.each([
    ['voltage', 'dca'],
    ['current', 'acv'],
    ['waveform', 'dcv'],
  ])('rejects incompatible %s mode %s', (kind, mode) => {
    expect(
      MeasurePoint.safeParse({
        id: 'x',
        kind,
        mode,
        between: ['dc1.KH_F', 'dc1.KH_A'],
        branch: ['dc1.KH_I1A', 'dc1.KH_I1B'],
      }).success,
    ).toBe(false)
  })

  it('rejects missing step point/table, column point and sanity column references', () => {
    const data = sample()
    const issues = paths({
      ...data,
      steps: [{ id: 'missing', text: 'Missing', measurePoints: ['absent'], recordTable: 'absent' }],
      dataTables: [
        {
          ...data.dataTables[0],
          columns: [{ id: 'u', title: 'U', measurePoint: 'absent' }],
          sanity: [{ column: 'absent', message: 'Check' }],
        },
      ],
    })
    expect(issues).toEqual(
      expect.arrayContaining([
        'steps.0.measurePoints.0',
        'steps.0.recordTable',
        'dataTables.0.columns.0.measurePoint',
        'dataTables.0.sanity.0.column',
      ]),
    )
  })

  it('rejects inverted expectation and sanity ranges, but accepts equal endpoints', () => {
    const data = sample()
    expect(
      paths({ ...data, steps: [{ id: 'u', text: 'Measure', expect: { measurePoint: 'u', min: 2, max: 1 } }] }),
    ).toContain('steps.0.expect.max')
    expect(
      paths({
        ...data,
        dataTables: [{ ...data.dataTables[0], sanity: [{ column: 'u', min: 2, max: 1, message: 'Check' }] }],
      }),
    ).toContain('dataTables.0.sanity.0.max')
    expect(
      Project.safeParse({
        ...data,
        steps: [{ id: 'u', text: 'Measure', expect: { measurePoint: 'u', min: 1, max: 1 } }],
      }).success,
    ).toBe(true)
  })

  it('rejects duplicate required measurement points', () => {
    expect(paths({ ...sample(), steps: [{ id: 'u', text: 'Measure', measurePoints: ['u', 'u'] }] })).toContain(
      'steps.0.measurePoints',
    )
  })

  it('accepts explicit periodic evidence only for waveform points with at least two complete cycles', () => {
    const point = { id: 'f', kind: 'waveform', quantity: 'frequency', between: ['dc1.KH_F', 'dc1.KH_A'] }
    expect(MeasurePoint.parse({ ...point, minCycles: 3 }).minCycles).toBe(3)
    for (const value of [0, 1, 1.5, -1, Number.NaN])
      expect(MeasurePoint.safeParse({ ...point, minCycles: value }).success).toBe(false)
    expect(MeasurePoint.safeParse({ ...point, kind: 'voltage', quantity: undefined, minCycles: 2 }).success).toBe(false)
  })

  it('retains finite bounded observation windows only on waveform points', () => {
    const point = { id: 'platform', kind: 'waveform', quantity: 'mean', between: ['dc1.KH_F', 'dc1.KH_A'] }
    expect(MeasurePoint.parse({ ...point, windowSec: 0.2 }).windowSec).toBe(0.2)
    expect(MeasurePoint.parse({ ...point, windowSec: 16 }).windowSec).toBe(16)
    expect(MeasurePoint.parse(point).windowSec).toBeUndefined()
    for (const windowSec of [0, -1, 16.001, Infinity, -Infinity, Number.NaN, '0.2'])
      expect(MeasurePoint.safeParse({ ...point, windowSec }).success).toBe(false)
    expect(MeasurePoint.safeParse({ ...point, kind: 'voltage', quantity: undefined, windowSec: 0.2 }).success).toBe(
      false,
    )
  })
})
