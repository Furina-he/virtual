import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AssembleInput, assembleNetlist } from '../../src/domain/circuit/assemble'
import { AssembleError } from '../../src/domain/circuit/errors'
import { Instrument, Module } from '../../src/shared/schema/index'
import { NgSpice, NgSpiceError } from '../../src/sim/ngspice'

const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const mod = Module.parse(load('content/modules/mod-dc-circuit/module.json'))
const subckt = readFileSync('content/modules/mod-dc-circuit/module.cir', 'utf8')
const psu = Instrument.parse(load('content/instruments/ins-dc-power/instrument.json'))
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))
const am = Instrument.parse(load('content/instruments/ins-dc-ammeter/instrument.json'))

const AM_RANGE = 'r20m'
const AM_R = am.ranges.find((r) => r.id === AM_RANGE)?.internalR as number
const PSU_R = psu.ranges[0]?.internalR as number

// 独立的改进节点法求解（电阻 + 电压源），作为理论值
function solveMna(nodes: string[], rs: [string, string, number][], vs: [string, string, number][]) {
  const idx = new Map(nodes.map((n, i) => [n, i]))
  const n = nodes.length
  const size = n + vs.length
  const A = Array.from({ length: size }, () => new Array<number>(size).fill(0))
  const b = new Array<number>(size).fill(0)
  const at = (x: string) => (x === '0' ? -1 : (idx.get(x) as number))
  const add = (r: number, c: number, v: number) => {
    if (r >= 0 && c >= 0) (A[r] as number[])[c] = ((A[r] as number[])[c] as number) + v
  }
  for (const [p, q, r] of rs) {
    const [i, j] = [at(p), at(q)]
    add(i, i, 1 / r)
    add(j, j, 1 / r)
    add(i, j, -1 / r)
    add(j, i, -1 / r)
  }
  vs.forEach(([p, q, v], k) => {
    const row = n + k
    add(at(p), row, 1)
    add(at(q), row, -1)
    add(row, at(p), 1)
    add(row, at(q), -1)
    b[row] = v
  })
  // 高斯消元
  for (let c = 0; c < size; c++) {
    let piv = c
    for (let r = c + 1; r < size; r++)
      if (Math.abs((A[r] as number[])[c] as number) > Math.abs((A[piv] as number[])[c] as number)) piv = r
    ;[A[c], A[piv]] = [A[piv] as number[], A[c] as number[]]
    ;[b[c], b[piv]] = [b[piv] as number, b[c] as number]
    for (let r = 0; r < size; r++) {
      if (r === c) continue
      const f = ((A[r] as number[])[c] as number) / ((A[c] as number[])[c] as number)
      for (let k = c; k < size; k++)
        (A[r] as number[])[k] = ((A[r] as number[])[k] as number) - f * ((A[c] as number[])[k] as number)
      b[r] = (b[r] as number) - f * (b[c] as number)
    }
  }
  const x = b.map((v, i) => v / ((A[i] as number[])[i] as number))
  return new Map(nodes.map((nm, i) => [nm, x[i] as number]))
}

// DG-05：U1=6 V 接 F-E，U2=12 V 接 B-C，三个电流插座各插一块毫安表（20 mA 档）
const dg05Wires = [
  { a: 'ps.CH1P', b: 'dc1.KH_U1P' },
  { a: 'ps.CH1N', b: 'dc1.KH_U1N' },
  { a: 'ps.CH2P', b: 'dc1.KH_U2P' },
  { a: 'ps.CH2N', b: 'dc1.KH_U2N' },
  ...(['1', '2', '3'] as const).flatMap((k) => [
    { a: `a${k}.POS`, b: `dc1.KH_I${k}A` },
    { a: `a${k}.NEG`, b: `dc1.KH_I${k}B` },
  ]),
]

const dg05Input = (wires = dg05Wires): AssembleInput => ({
  title: 'DG-05',
  modules: [{ instanceId: 'dc1', module: mod, subckt }],
  instruments: [
    { instanceId: 'ps', instrument: psu, settings: { ch1_v: 6, ch2_v: 12 } },
    ...['a1', 'a2', 'a3'].map((id) => ({ instanceId: id, instrument: am, settings: { range: AM_RANGE } })),
  ],
  wires,
  controlValues: {},
  ground: 'dc1.KH_E',
  analysis: ['.op'],
})

describe('DG-05 网表拼装 + ngspice', () => {
  it('三条支路电流与理论值偏差 ≤1%', () => {
    const { netlist } = assembleNetlist(dg05Input())
    ng.load(netlist)
    ng.run()
    const sim = ['a1', 'a2', 'a3'].map((id) => ng.getVector(`vsense_${id}#branch`)[0] as number)

    // 理论：E 为参考点；I1 从 I1A 流向 I1B（F→A），I2 从 A 流向 B 侧，I3 从 A 流向 D 侧
    const v = solveMna(
      ['P1', 'F', 'I1n', 'A', 'I2n', 'B', 'I3n', 'D', 'C', 'P2'],
      [
        ['P1', 'F', PSU_R],
        ['F', 'I1n', 510],
        ['I1n', 'A', AM_R],
        ['A', 'I2n', AM_R],
        ['I2n', 'B', 1000],
        ['A', 'I3n', AM_R],
        ['I3n', 'D', 510],
        ['0', 'D', 510],
        ['D', 'C', 330],
        ['P2', 'B', PSU_R],
      ],
      [
        ['P1', '0', 6],
        ['P2', 'C', 12],
      ],
    )
    const g = (x: string) => v.get(x) as number
    const theory = [(g('I1n') - g('A')) / AM_R, (g('A') - g('I2n')) / AM_R, (g('A') - g('I3n')) / AM_R]
    sim.forEach((s, i) => {
      const t = theory[i] as number
      console.log(`I${i + 1} 仿真 ${(s * 1e3).toFixed(4)} mA，理论 ${(t * 1e3).toFixed(4)} mA`)
      expect(Math.abs(s - t) / Math.abs(t)).toBeLessThanOrEqual(0.01)
    })
    // KCL：流入 A 的电流 = 流出
    expect(Math.abs((sim[0] as number) - (sim[1] as number) - (sim[2] as number))).toBeLessThan(1e-6)
  })

  it('两种等效接法拼出的节点划分相同，读数相同', () => {
    // 接法二：电压表 + 端叠插在电源插孔上，而不是挂箱插孔上
    const withVm = (vmPos: string) => {
      const input = dg05Input([...dg05Wires, { a: 'vm.POS', b: vmPos }, { a: 'vm.NEG', b: 'dc1.KH_U1N' }])
      input.instruments.push({ instanceId: 'vm', instrument: vm, settings: { range: 'r20' } })
      return assembleNetlist(input)
    }
    const r1 = withVm('dc1.KH_U1P')
    const r2 = withVm('ps.CH1P')
    expect(r1.nets).toEqual(r2.nets)
    ng.load(r1.netlist)
    ng.run()
    const i1 = ng.getVector('vsense_a1#branch')[0]
    ng.load(r2.netlist)
    ng.run()
    expect(ng.getVector('vsense_a1#branch')[0]).toBeCloseTo(i1 as number, 12)
  })

  it('随机接线 50 次（含短路、浮空、空电路）均返回结果或可读错误', () => {
    const jacks = [
      ...mod.jacks.map((j) => `dc1.${j.id}`),
      ...psu.jacks.map((j) => `ps.${j.id}`),
      ...am.jacks.map((j) => `a1.${j.id}`),
      ...vm.jacks.map((j) => `vm.${j.id}`),
    ]
    // 固定种子的线性同余随机数，失败可复现
    let seed = 20261028
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    let ok = 0
    let errors = 0
    for (let k = 0; k < 50; k++) {
      const count = k === 0 ? 0 : rand(16)
      const wires = Array.from({ length: count }, () => ({
        a: jacks[rand(jacks.length)] as string,
        b: jacks[rand(jacks.length)] as string,
      })).filter((w) => w.a !== w.b)
      const input: AssembleInput = {
        title: `random ${k}`,
        modules: [{ instanceId: 'dc1', module: mod, subckt }],
        instruments: [
          { instanceId: 'ps', instrument: psu, settings: {} },
          { instanceId: 'a1', instrument: am, settings: {} },
          { instanceId: 'vm', instrument: vm, settings: {} },
        ],
        wires,
        controlValues: { 'dc1.K1': rand(2), 'dc1.K2': rand(2), 'dc1.K3': rand(2) },
        ground: rand(2) ? 'dc1.KH_E' : undefined,
        analysis: ['.op'],
      }
      try {
        ng.load(assembleNetlist(input).netlist)
        ng.run()
        ok++
      } catch (e) {
        if (!(e instanceof NgSpiceError || e instanceof AssembleError)) throw e
        expect(e.message.length).toBeGreaterThan(0)
        errors++
      }
    }
    console.log(`随机接线：${ok} 次得到结果，${errors} 次返回错误`)
    expect(ok + errors).toBe(50)
  })
})
