import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, Module } from '../../shared/schema/index.ts'
import { type AssembleInput, assembleNetlist } from './assemble.ts'
import { AssembleError } from './errors.ts'

const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const mod = Module.parse(load('content/modules/mod-dc-circuit/module.json'))
const subckt = readFileSync('content/modules/mod-dc-circuit/module.cir', 'utf8')
const psu = Instrument.parse(load('content/instruments/ins-dc-power/instrument.json'))
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))
const am = Instrument.parse(load('content/instruments/ins-dc-ammeter/instrument.json'))

const base = (wires: { a: string; b: string }[], extra: Partial<AssembleInput> = {}): AssembleInput => ({
  title: 'test',
  modules: [{ instanceId: 'dc1', module: mod, subckt }],
  instruments: [
    { instanceId: 'ps', instrument: psu, settings: {} },
    { instanceId: 'vm', instrument: vm, settings: {} },
    { instanceId: 'am', instrument: am, settings: {} },
  ],
  wires,
  controlValues: {},
  analysis: ['.op'],
  ...extra,
})

describe('assembleNetlist', () => {
  it('等效接法（叠插顺序不同）得到相同的网络划分和网表', () => {
    const chain = assembleNetlist(
      base([
        { a: 'ps.CH1P', b: 'dc1.KH_U1P' },
        { a: 'vm.POS', b: 'dc1.KH_U1P' },
      ]),
    )
    const star = assembleNetlist(
      base([
        { a: 'dc1.KH_U1P', b: 'ps.CH1P' },
        { a: 'vm.POS', b: 'ps.CH1P' },
      ]),
    )
    expect(chain.nets).toEqual(star.nets)
    expect(chain.netlist).toEqual(star.netlist)
  })

  it('电流插座常闭；两端都插上导线时断开', () => {
    const closed = assembleNetlist(base([]))
    expect(closed.nodeOf['dc1.KH_I1A']).toBe(closed.nodeOf['dc1.KH_I1B'])
    const plugged = assembleNetlist(
      base([
        { a: 'am.POS', b: 'dc1.KH_I1A' },
        { a: 'am.NEG', b: 'dc1.KH_I1B' },
      ]),
    )
    expect(plugged.nodeOf['dc1.KH_I1A']).not.toBe(plugged.nodeOf['dc1.KH_I1B'])
    expect(plugged.netlist).toMatch(/^Vsense_am m_am n\d+ DC 0$/m)
  })

  it('接地插孔所在网络为节点 0，且不加泄放电阻', () => {
    const r = assembleNetlist(base([{ a: 'ps.CH1N', b: 'dc1.KH_E' }], { ground: 'dc1.KH_E' }))
    expect(r.nodeOf['ps.CH1N']).toBe('0')
    expect(r.netlist).not.toMatch(/^Rleak_0 /m)
    expect(r.netlist).toMatch(/^Rleak_n\d+ n\d+ 0 1T$/m)
  })

  it('没接线的仪表不进网表；控件值写成全局参数', () => {
    const r = assembleNetlist(base([], { controlValues: { 'dc1.K3': 1 } }))
    expect(r.netlist).not.toContain('Vch1_ps')
    expect(r.netlist).toContain('.param p_dc1_k3=1')
    expect(r.netlist).toContain('.param p_dc1_k1=1')
    expect(r.netlist).toMatch(/mod_dc_circuit k1=\{p_dc1_k1\} k2=\{p_dc1_k2\} k3=\{p_dc1_k3\}$/m)
  })

  it('仪表设置与档位进入模板', () => {
    const r = assembleNetlist({
      ...base([{ a: 'ps.CH1P', b: 'am.POS' }]),
      instruments: [
        { instanceId: 'ps', instrument: psu, settings: { ch1_v: 9 } },
        { instanceId: 'am', instrument: am, settings: { range: 'r20m' } },
      ],
    })
    expect(r.netlist).toMatch(/^Vch1_ps x1_ps n\d+ DC 9$/m)
    expect(r.netlist).toMatch(/^Rsh_am n\d+ m_am 10$/m)
  })

  it('故障注入只改写目标实例的子电路副本', () => {
    const fault = { id: 'f1', target: 'dc1.R1', kind: 'open' as const, symptom: '-', hint: '-' }
    const r = assembleNetlist(base([], { fault }))
    expect(r.netlist).toContain('.subckt mod_dc_circuit__dc1 ')
    expect(r.netlist).toContain('.ends mod_dc_circuit__dc1')
    expect(r.netlist).toMatch(/^R1 KH_F fault_open_R1 510$/m)
    expect(r.netlist).toMatch(/^Rfault_open_R1 fault_open_R1 KH_I1A 1G$/m)
    const short = assembleNetlist(base([], { fault: { ...fault, kind: 'short' } }))
    expect(short.netlist).toMatch(/^Rfault_short_R1 KH_F KH_I1A 1m$/m)
    const drift = assembleNetlist(base([], { fault: { ...fault, kind: 'drift', params: { value: '680' } } }))
    expect(drift.netlist).toMatch(/^R1 KH_F KH_I1A 680$/m)
  })

  it('导线连到不存在的插孔报接线错误', () => {
    expect(() => assembleNetlist(base([{ a: 'dc1.KH_X', b: 'ps.CH1P' }]))).toThrow(AssembleError)
  })

  it('子电路端口与 jacks 不一致报内容错误', () => {
    const bad = subckt.replace('KH_U1P KH_U1N', 'KH_U1N KH_U1P')
    const input = base([])
    input.modules = [{ instanceId: 'dc1', module: mod, subckt: bad }]
    expect(() => assembleNetlist(input)).toThrow(/端口与 jacks 顺序不一致/)
  })
})
