import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, Module, Project } from '../../shared/schema/index.ts'
import { type CheckInput, checkWiring, detectDanger } from './index.ts'

const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const mod = Module.parse(load('content/modules/mod-dc-circuit/module.json'))
const ins = (id: string) => Instrument.parse(load(`content/instruments/${id}/instrument.json`))
const psu = ins('ins-dc-power')
const am = ins('ins-dc-ammeter')
const vm = ins('ins-dc-voltmeter')
const mm = ins('ins-multimeter')

// DG-05 参考：U1 接 F-E 一侧，U2 接 B-C 一侧；测 I1 与 U_FA
const reference = Project.shape.reference.parse({
  nets: [
    ['ins-dc-power.CH1P', 'dc1.KH_U1P'],
    ['ins-dc-power.CH1N', 'dc1.KH_U1N'],
    ['ins-dc-power.CH2P', 'dc1.KH_U2P'],
    ['ins-dc-power.CH2N', 'dc1.KH_U2N'],
  ],
  measurePoints: [
    { id: 'I1', kind: 'current', branch: ['dc1.KH_I1A', 'dc1.KH_I1B'] },
    { id: 'U_FA', kind: 'voltage', between: ['dc1.KH_F', 'dc1.KH_A'] },
  ],
})

const supplyWires = [
  { a: 'ins-dc-power.CH1P', b: 'dc1.KH_U1P' },
  { a: 'ins-dc-power.CH1N', b: 'dc1.KH_U1N' },
  { a: 'ins-dc-power.CH2P', b: 'dc1.KH_U2P' },
  { a: 'ins-dc-power.CH2N', b: 'dc1.KH_U2N' },
]
const ammeterInI1 = [
  { a: 'ins-dc-ammeter.POS', b: 'dc1.KH_I1A' },
  { a: 'ins-dc-ammeter.NEG', b: 'dc1.KH_I1B' },
]
const voltmeterOnFA = [
  { a: 'ins-dc-voltmeter.POS', b: 'dc1.KH_F' },
  { a: 'ins-dc-voltmeter.NEG', b: 'dc1.KH_A' },
]

const input = (wires: { a: string; b: string }[]): CheckInput => ({
  modules: [{ instanceId: 'dc1', module: mod }],
  instruments: [
    { instanceId: 'ins-dc-power', instrument: psu },
    { instanceId: 'ins-dc-ammeter', instrument: am },
    { instanceId: 'ins-dc-voltmeter', instrument: vm },
    { instanceId: 'mm1', instrument: mm },
  ],
  wires,
})

const codes = (issues: { code: string }[]) => issues.map((i) => i.code)

describe('接线检查', () => {
  it('参考接法：电路与测量点都正确', () => {
    const r = checkWiring(input([...supplyWires, ...ammeterInI1, ...voltmeterOnFA]), reference)
    expect(r.issues).toEqual([])
    expect(r.circuitOk).toBe(true)
    expect(r.measurementsOk).toBe(true)
  })

  it('等效接法：负端接到同一铜箔上的 E、正端叠插在电源插孔上，均判对', () => {
    const r = checkWiring(
      input([
        { a: 'dc1.KH_U1P', b: 'ins-dc-power.CH1P' },
        { a: 'ins-dc-power.CH1N', b: 'dc1.KH_E' },
        { a: 'ins-dc-power.CH2P', b: 'dc1.KH_U2P' },
        { a: 'dc1.KH_C', b: 'ins-dc-power.CH2N' },
        ...ammeterInI1,
        // 电压表 + 端接到电压表另一根导线上（叠插）
        { a: 'ins-dc-voltmeter.POS', b: 'dc1.KH_F' },
        { a: 'ins-dc-voltmeter.NEG', b: 'dc1.KH_I2A' },
      ]),
      reference,
    )
    expect(r.issues).toEqual([])
  })

  it('仪表接法不同不影响电路判定：用万用表代替、或电流表接在别处', () => {
    const withMultimeter = checkWiring(
      input([
        ...supplyWires,
        { a: 'mm1.MA', b: 'dc1.KH_I1A' },
        { a: 'mm1.COM', b: 'dc1.KH_I1B' },
        { a: 'mm1.VOHM', b: 'dc1.KH_I2B' },
      ]),
      reference,
    )
    expect(withMultimeter.circuitOk).toBe(true)
    expect(codes(withMultimeter.issues)).not.toContain('extra-connection')

    const wrongMeters = checkWiring(
      input([
        ...supplyWires,
        { a: 'ins-dc-ammeter.POS', b: 'dc1.KH_I2A' },
        { a: 'ins-dc-ammeter.NEG', b: 'dc1.KH_I2B' },
      ]),
      reference,
    )
    expect(wrongMeters.circuitOk).toBe(true)
    expect(wrongMeters.measurementsOk).toBe(false)
    expect(wrongMeters.issues.map((i) => i.message)).toEqual([
      '测量 I1 需要把电流表串入 电路基础实验挂箱（一）的 I1 与 电路基础实验挂箱（一）的 I1 右 之间。',
      '测量 U_FA 需要把电压表接在 电路基础实验挂箱（一）的 F 与 电路基础实验挂箱（一）的 A 两端。',
    ])
  })

  it('少接、多接导线给出可读提示', () => {
    const missing = checkWiring(input(supplyWires.slice(1)), reference)
    expect(missing.circuitOk).toBe(false)
    expect(missing.issues[0]?.message).toBe('电路基础实验挂箱（一）的 U1+ 应与 直流稳压电源的 CH1 + 相连。')

    const extra = checkWiring(input([...supplyWires, { a: 'dc1.KH_F', b: 'dc1.KH_D' }]), reference)
    expect(codes(extra.issues)).toContain('extra-connection')
    expect(extra.issues.find((i) => i.code === 'extra-connection')?.message).toBe(
      '电路基础实验挂箱（一）的 F 与 电路基础实验挂箱（一）的 D 之间多了连线，这两点不应相连。',
    )
  })

  it('电表极性接反给警告，不判电路错误', () => {
    const r = checkWiring(
      input([
        ...supplyWires,
        { a: 'ins-dc-ammeter.POS', b: 'dc1.KH_I1B' },
        { a: 'ins-dc-ammeter.NEG', b: 'dc1.KH_I1A' },
        { a: 'ins-dc-voltmeter.POS', b: 'dc1.KH_A' },
        { a: 'ins-dc-voltmeter.NEG', b: 'dc1.KH_F' },
      ]),
      reference,
    )
    expect(r.circuitOk).toBe(true)
    expect(r.measurementsOk).toBe(true)
    expect(codes(r.issues)).toEqual(['measure-polarity', 'measure-polarity'])
  })

  it('电流插座未插电流表时测量点不成立', () => {
    const r = checkWiring(input([...supplyWires, { a: 'ins-dc-ammeter.POS', b: 'dc1.KH_I1A' }]), reference)
    expect(codes(r.issues)).toContain('measure-missing')
  })
})

describe('危险接法', () => {
  it('电流表并联在电源两端被识别', () => {
    const issues = detectDanger(
      input([
        { a: 'ins-dc-ammeter.POS', b: 'ins-dc-power.CH1P' },
        { a: 'ins-dc-ammeter.NEG', b: 'ins-dc-power.CH1N' },
      ]),
    )
    expect(codes(issues)).toEqual(['ammeter-across-source'])
    expect(issues[0]?.message).toBe(
      '直流数字毫安表并联在电源两端（直流稳压电源的 CH1 + 与 直流稳压电源的 CH1 −），熔断器已断开。断电后把电流表串入被测支路，再更换熔断器。',
    )
  })

  it('经挂箱导线绕一圈后仍跨在电源两端也能识别', () => {
    const issues = detectDanger(
      input([...supplyWires, { a: 'ins-dc-ammeter.POS', b: 'dc1.KH_U1P' }, { a: 'ins-dc-ammeter.NEG', b: 'dc1.KH_E' }]),
    )
    expect(codes(issues)).toEqual(['ammeter-across-source'])
  })

  it('电流表正常串入支路不报警', () => {
    expect(detectDanger(input([...supplyWires, ...ammeterInI1, ...voltmeterOnFA]))).toEqual([])
  })

  it('电源输出被导线短接', () => {
    const issues = detectDanger(input([{ a: 'ins-dc-power.CH2P', b: 'ins-dc-power.CH2N' }]))
    expect(codes(issues)).toEqual(['source-short'])
  })

  it('提示文案平实：句号结尾、无感叹号（PRD 15.4）', () => {
    const all = [
      ...detectDanger(input([{ a: 'ins-dc-power.CH2P', b: 'ins-dc-power.CH2N' }])),
      ...checkWiring(input([]), reference).issues,
    ]
    expect(all.length).toBeGreaterThan(0)
    for (const i of all) {
      expect(i.message.endsWith('。')).toBe(true)
      expect(i.message).not.toMatch(/[!！]/)
    }
  })
})
