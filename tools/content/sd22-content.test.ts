import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { completeTaskStep, createTaskState } from '../../src/domain/task/index.ts'
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
const module = Module.parse(json('content/modules/mod-555-app/module.json'))
const supply = Instrument.parse(json('content/instruments/ins-dc-power/instrument.json'))
const guide = text('content/projects/SD-22/guide.md')
const schematic = text('content/projects/SD-22/schematic.svg')
const topologyText = text('content/projects/SD-22/reference-topologies.md')
const references = [...topologyText.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(
  (match) => Project.parse({ ...project, reference: JSON.parse(match[1] ?? '') }).reference,
)

function wires(nets: string[][], shape: 'star' | 'chain'): { a: string; b: string }[] {
  return nets.flatMap((net) =>
    net.slice(1).map((b, index) => ({ a: (shape === 'star' ? net[0] : net[index]) as string, b })),
  )
}

function input(reference: Project['reference'], shape: 'star' | 'chain' = 'star'): CheckInput {
  return {
    modules: [{ instanceId: 'timer1', module }],
    instruments: [{ instanceId: supply.id, instrument: supply }],
    wires: wires(reference.nets, shape),
  }
}

describe('SD-22 formal teaching content and integration boundaries', () => {
  it('uses only fields retained by the current project schema', () => {
    expect(project).toEqual(rawProject)
    expect(project.modules).toEqual([{ instanceId: 'timer1', moduleId: 'mod-555-app', slot: 'SLOT_BOX_L1' }])
    expect(project.validation?.limitations.join(' ')).toContain('原型消防车接法无法持续振荡')
  })

  it('contains all six guide sections and the same eight original questions', () => {
    for (const heading of ['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题'])
      expect(guide).toContain(`## ${heading}\n`)
    const questions = [...(guide.split('## 思考题\n')[1] ?? '').matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1])
    expect(questions).toEqual(project.questions)
    expect(questions).toHaveLength(8)
  })

  it('shows each physical jack exactly once in the original schematic', () => {
    const ids = [...schematic.matchAll(/data-jack-id="([^"]+)"/g)].map((match) => match[1])
    expect(ids).toHaveLength(36)
    expect(new Set(ids).size).toBe(36)
    expect([...ids].sort()).toEqual(module.jacks.map((jack) => jack.id).sort())
    expect(schematic).toContain('Original code-native teaching schematic')
    expect(schematic).toContain('消防车原型需缓冲修订')
    expect(schematic).not.toMatch(/(?:href|src)="https?:\/\//)
  })

  it('keeps the default ambulance reference and the complete fire prototype separate', () => {
    expect(references).toHaveLength(2)
    const [ambulance, fire] = references
    expect(ambulance).toEqual(project.reference)
    expect(fire?.measurePoints).toEqual(project.reference.measurePoints)
    const ambulanceSource = ambulance?.nets.find((net) => net.includes('timer1.R5_1'))
    const fireSource = fire?.nets.find((net) => net.includes('timer1.R5_1'))
    expect(ambulanceSource).toEqual(['timer1.T1_OUT', 'timer1.R5_1'])
    expect(fireSource).toContain('timer1.T1_TH')
    expect(fireSource).not.toContain('timer1.T1_OUT')
  })

  it.each([0, 1])('accepts equivalent star and chain wiring for reference %i', (index) => {
    const reference = references[index] as Project['reference']
    expect(checkTopology(input(reference, 'star'), reference)).toEqual([])
    expect(checkTopology(input(reference, 'chain'), reference)).toEqual([])
  })

  it('rejects both modulation sources connected at once', () => {
    const circuit = input(project.reference)
    circuit.wires.push({ a: 'timer1.T1_TH', b: 'timer1.R5_1' })
    expect(checkTopology(circuit, project.reference).some((issue) => issue.code === 'extra-connection')).toBe(true)
  })

  it('rejects using the ambulance topology as fire topology validation', () => {
    const fire = references[1] as Project['reference']
    expect(checkTopology(input(project.reference), fire).some((issue) => issue.severity === 'error')).toBe(true)
  })

  it('keeps supply, reset, electrolytic and speaker polarities consistent', () => {
    const ground = project.reference.nets.find((net) => net.includes('timer1.GND1'))
    const positive = project.reference.nets.find((net) => net.includes('timer1.VCC1'))
    expect(ground).toEqual(
      expect.arrayContaining(['ins-dc-power.CH1N', 'timer1.T1_CT_N', 'timer1.T2_CT_N', 'timer1.SPK_N']),
    )
    expect(positive).toEqual(expect.arrayContaining(['ins-dc-power.CH1P', 'timer1.T1_RST', 'timer1.T2_RST']))
    expect(project.reference.nets).toContainEqual(['timer1.T2_OUT', 'timer1.C5_P'])
    expect(project.reference.nets).toContainEqual(['timer1.C5_N', 'timer1.SPK_P'])
    expect(project.reference.measurePoints.find((point) => point.id === 'speaker')?.between).toEqual([
      'timer1.SPK_P',
      'timer1.SPK_N',
    ])
    for (const id of ['VCC1', 'T1_CT_P', 'C5_P', 'SPK_P'])
      expect(module.jacks.find((jack) => jack.id === id)?.polarityHint).toBe('+')
    for (const id of ['GND1', 'T1_CT_N', 'C5_N', 'SPK_N'])
      expect(module.jacks.find((jack) => jack.id === id)?.polarityHint).toBe('-')
    expect(module.jacks.find((jack) => jack.id === 'T2_CT_P')?.polarityHint).toBeUndefined()
    expect(module.jacks.find((jack) => jack.id === 'T2_CT_N')?.polarityHint).toBeUndefined()
  })

  it('starts empty and binds only the supported real voltage column', () => {
    const state = createTaskState(project)
    for (const rows of Object.values(state.tables))
      for (const row of rows) expect(Object.values(row).every((value) => value === null)).toBe(true)
    const bindings = project.dataTables.flatMap((table) => table.columns.filter((column) => column.measurePoint))
    expect(bindings).toEqual([{ id: 'u-vcc', title: '实测供电', unit: 'V', measurePoint: 'supply' }])
    expect(state.completedSteps).toEqual([])
  })

  it('cannot turn a hand-filled table into waveform measurement completion', () => {
    const stepIndex = project.steps.findIndex((step) => step.id === 'ambulance-lf')
    const state = createTaskState(project)
    state.completedSteps = project.steps.slice(0, stepIndex).map((step) => step.id)
    for (const rows of Object.values(state.tables))
      for (const row of rows) for (const key of Object.keys(row)) row[key] = 1
    const completed = completeTaskStep(project, state, 'ambulance-lf', { wiringCorrect: true })
    expect(completed.ok).toBe(false)
    expect(completed.state.completedSteps).not.toContain('ambulance-lf')
  })

  it('does not mark the fire prototype or T0.15 as completed in the guide', () => {
    expect(guide).toContain('原型消防车接法会因 NE555 CV 输入加载而停振')
    expect(guide).toContain('应用集成未完成')
    expect(topologyText).toContain('该原型不能实现持续音调渐变')
    expect(project.steps.filter((step) => step.id.includes('fire') && step.measurePoints?.length).length).toBe(2)
  })
})
