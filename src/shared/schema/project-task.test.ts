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
    expect(project.reference.measurePoints[0]?.mode).toBeUndefined()
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
})
