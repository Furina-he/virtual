import { describe, expect, it } from 'vitest'
import { CircuitState, Instrument, Module, Project, SaveFile, Settings } from './index.ts'

const pathsOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.error?.issues.map((i) => i.path.join('.')) ?? []

const jack = (id: string) => ({ id, label: id, kind: 'banana4' })

const validModule = {
  id: 'mod-dc-circuit',
  name: '电路基础实验挂箱（一）',
  form: 'box',
  model: 'module.glb',
  netlist: 'module.cir',
  jacks: [jack('KH_A'), jack('KH_B')],
  controls: [{ id: 'K1', kind: 'switch', param: 'k1', steps: [0, 1], unit: '', default: 0 }],
  internalJumpers: [{ id: 'J1', a: 'KH_A', b: 'KH_B' }],
}

const validInstrument = {
  id: 'ins-dc-voltmeter',
  name: '直流数字电压表',
  kind: 'dcv',
  mounting: 'fixed',
  fixedSlot: 'SLOT_INS_DCV',
  model: 'instrument.glb',
  jacks: [jack('POS'), jack('NEG')],
  ranges: [{ id: 'r20', full: 20, unit: 'V', internalR: 1e7, resolution: 0.01 }],
  accuracyClass: 0.5,
  spiceTemplate: 'instrument.cir',
}

const validProject = {
  id: 'DG-05',
  group: '直流',
  title: '基尔霍夫定律的验证与应用',
  type: 'basic',
  modules: [{ instanceId: 'dc1', moduleId: 'mod-dc-circuit', slot: 'SLOT_BOX_L1' }],
  allowedInstruments: ['ins-multimeter'],
  reference: {
    nets: [['dc1.KH_A', 'dc1.KH_B']],
    measurePoints: [
      { id: 'U_AB', kind: 'voltage', between: ['dc1.KH_A', 'dc1.KH_B'] },
      { id: 'I1', kind: 'current', branch: ['dc1.KH_I1A', 'dc1.KH_I1B'] },
    ],
  },
  steps: [{ id: 's1', text: '测量 U_AB', expect: { measurePoint: 'U_AB', min: 0.9, max: 1.1 } }],
  dataTables: [
    {
      id: 't1',
      title: '电压',
      columns: [
        { id: 'n', title: '序号' },
        { id: 'u', title: 'U', unit: 'V', measurePoint: 'U_AB' },
      ],
      rows: 3,
    },
  ],
  charts: [{ id: 'c1', table: 't1', x: 'n', y: ['u'], kind: 'line' }],
  faults: [{ id: 'f1', target: 'dc1.R1', kind: 'open', symptom: 'I1 为零', hint: '检查 R1' }],
  questions: ['KCL 是否成立？'],
}

const validCircuit = {
  placedInstruments: [{ instanceId: 'mm1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_1', settings: {} }],
  wires: [{ id: 'w1', a: 'dc1.KH_A', b: 'mm1.VOHM', color: 'red' }],
  controlValues: { 'dc1.K1': 1 },
  powered: false,
}

describe('Module', () => {
  it('合法样例通过', () => expect(Module.safeParse(validModule).success).toBe(true))
  it('插孔 ID 重复、跳线指向不存在的插孔、default 不在 steps 中', () => {
    const r = Module.safeParse({
      ...validModule,
      jacks: [jack('KH_A'), jack('KH_A')],
      controls: [{ ...validModule.controls[0], default: 2 }],
      internalJumpers: [{ id: 'J1', a: 'KH_A', b: 'KH_X' }],
    })
    expect(pathsOf(r)).toEqual(expect.arrayContaining(['jacks.1.id', 'controls.0.default', 'internalJumpers.0.b']))
  })
  it('插孔 ID 必须能当网表端口名', () => {
    expect(pathsOf(Module.safeParse({ ...validModule, jacks: [jack('a-1')] }))).toContain('jacks.0.id')
  })
})

describe('Instrument', () => {
  it('合法样例通过', () => expect(Instrument.safeParse(validInstrument).success).toBe(true))
  it('固定仪表缺 fixedSlot、台式仪表带 fixedSlot 都报错', () => {
    const { fixedSlot: _, ...noSlot } = validInstrument
    expect(pathsOf(Instrument.safeParse(noSlot))).toContain('fixedSlot')
    expect(pathsOf(Instrument.safeParse({ ...validInstrument, mounting: 'desktop' }))).toContain('fixedSlot')
  })
  it('未知仪表类型与非正内阻', () => {
    const r = Instrument.safeParse({
      ...validInstrument,
      kind: 'ohmmeter',
      ranges: [{ ...validInstrument.ranges[0], internalR: 0 }],
    })
    expect(pathsOf(r)).toEqual(expect.arrayContaining(['kind', 'ranges.0.internalR']))
  })
})

describe('Project', () => {
  it('合法样例通过', () => expect(Project.safeParse(validProject).success).toBe(true))
  it('项目编号、插孔引用格式错误', () => {
    const r = Project.safeParse({
      ...validProject,
      id: 'DG5',
      reference: { ...validProject.reference, nets: [['dc1.KH_A', 'KH_B']] },
    })
    expect(pathsOf(r)).toEqual(expect.arrayContaining(['id', 'reference.nets.0.1']))
  })
  it('同一插孔属于两个网络、步骤引用不存在的测量点、曲线引用不存在的列', () => {
    const r = Project.safeParse({
      ...validProject,
      reference: {
        ...validProject.reference,
        nets: [
          ['dc1.KH_A', 'dc1.KH_B'],
          ['dc1.KH_A', 'dc1.KH_C'],
        ],
      },
      steps: [{ id: 's1', text: 'x', expect: { measurePoint: 'U_XX', min: 0, max: 1 } }],
      charts: [{ id: 'c1', table: 't1', x: 'n', y: ['p'], kind: 'line' }],
    })
    expect(pathsOf(r)).toEqual(
      expect.arrayContaining(['reference.nets.1.0', 'steps.0.expect.measurePoint', 'charts.0.y.0']),
    )
  })
  it('电流测量点缺 branch', () => {
    const r = Project.safeParse({
      ...validProject,
      reference: { ...validProject.reference, measurePoints: [{ id: 'I1', kind: 'current' }] },
      steps: [{ id: 's1', text: 'x' }],
    })
    expect(pathsOf(r)).toContain('reference.measurePoints.0.branch')
  })
})

describe('CircuitState', () => {
  it('合法样例通过', () => expect(CircuitState.safeParse(validCircuit).success).toBe(true))
  it('导线两端为同一插孔、未知颜色', () => {
    const r = CircuitState.safeParse({
      ...validCircuit,
      wires: [{ id: 'w1', a: 'dc1.KH_A', b: 'dc1.KH_A', color: 'purple' }],
    })
    expect(pathsOf(r)).toEqual(expect.arrayContaining(['wires.0.color']))
    const r2 = CircuitState.safeParse({
      ...validCircuit,
      wires: [{ id: 'w1', a: 'dc1.KH_A', b: 'dc1.KH_A', color: 'red' }],
    })
    expect(pathsOf(r2)).toContain('wires.0.b')
  })
})

describe('SaveFile', () => {
  const { powered: _, ...circuit } = validCircuit
  const validSave = {
    schemaVersion: 1,
    projectId: 'DG-05',
    updatedAt: '2026-10-28T08:00:00Z',
    circuit,
    completedSteps: ['s1'],
    tables: { t1: [{ n: 1, u: null }] },
  }
  it('合法样例通过', () => expect(SaveFile.safeParse(validSave).success).toBe(true))
  it('版本号不对、时间格式错误', () => {
    const r = SaveFile.safeParse({ ...validSave, schemaVersion: 2, updatedAt: '昨天' })
    expect(pathsOf(r)).toEqual(expect.arrayContaining(['schemaVersion', 'updatedAt']))
  })
})

describe('Settings', () => {
  it('空对象取默认值', () => {
    expect(Settings.parse({})).toEqual({ quality: 'medium', theme: 'light', fontScale: 1, guideMode: 'guided' })
  })
  it('非法画质档与字号倍率', () => {
    expect(pathsOf(Settings.safeParse({ quality: 'ultra', fontScale: 2 }))).toEqual(['quality', 'fontScale'])
  })
})
