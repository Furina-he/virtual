import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assembleNetlist } from '../../src/domain/circuit/assemble.ts'
import { injectFault } from '../../src/domain/circuit/fault.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import { measureSignal } from '../../src/domain/instruments/scope.ts'
import { type FaultDef, Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'

const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))
const project = Project.parse(JSON.parse(readFileSync('content/projects/MD-07/project.json', 'utf8')))
const ampMod = Module.parse(JSON.parse(readFileSync('content/modules/mod-analog-amp/module.json', 'utf8')))
const ampCir = expandLocalLibraries(readFileSync('content/modules/mod-analog-amp/module.cir', 'utf8'), {
  'bjt.lib': readFileSync('content/models/spice/bjt.lib', 'utf8'),
})
const psu = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-dc-power/instrument.json', 'utf8')))
const gen = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-func-gen/instrument.json', 'utf8')))

function runOp(fault?: FaultDef) {
  const assembled = assembleNetlist({
    title: `md07-op-${fault?.id ?? 'normal'}`,
    modules: [{ instanceId: 'amp1', module: ampMod, subckt: ampCir }],
    instruments: [{ instanceId: 'ps', instrument: psu, settings: { ch1_v: 12 } }],
    wires: [
      { a: 'ps.CH1P', b: 'amp1.AMP_VCC' },
      { a: 'ps.CH1N', b: 'amp1.AMP_GND1' },
    ],
    controlValues: { 'amp1.RW': 22000, 'amp1.KCE': 1 },
    ground: 'ps.CH1N',
    ...(fault ? { fault } : {}),
    analysis: ['.op'],
  })
  ng.load(assembled.netlist)
  ng.run()
  const v = (jack: string) => {
    const node = assembled.nodeOf[`amp1.${jack}`]
    if (!node || node === '0') return 0
    return ng.getVector(node)[0] ?? Number.NaN
  }
  return {
    vcc: v('AMP_VCC'),
    ub: v('AMP_UB'),
    uc: v('AMP_UC'),
    ue: v('AMP_UE'),
  }
}

function runTranVpp(fault?: FaultDef) {
  const assembled = assembleNetlist({
    title: `md07-tran-${fault?.id ?? 'normal'}`,
    modules: [{ instanceId: 'amp1', module: ampMod, subckt: ampCir }],
    instruments: [
      { instanceId: 'ps', instrument: psu, settings: { ch1_v: 12 } },
      {
        instanceId: 'gen1',
        instrument: gen,
        settings: { ch1_wave: 'sine', ch1_freq: 1000, ch1_amp: 0.1, ch1_offset: 0, ch1_on: 1, ch2_on: 0 },
      },
    ],
    wires: [
      { a: 'ps.CH1P', b: 'amp1.AMP_VCC' },
      { a: 'ps.CH1N', b: 'amp1.AMP_GND1' },
      { a: 'gen1.CH1', b: 'amp1.AMP_US' },
      { a: 'gen1.GND', b: 'amp1.AMP_GND2' },
      { a: 'amp1.AMP_UO', b: 'amp1.AMP_RL' },
    ],
    controlValues: { 'amp1.RW': 22000, 'amp1.KCE': 1 },
    ground: 'ps.CH1N',
    ...(fault ? { fault } : {}),
    analysis: ['.tran 20u 40m 30m 20u'],
  })
  ng.load(assembled.netlist)
  ng.run()
  const t = ng.getVector('time')
  const dt = t.length > 2 ? ((t[t.length - 1] ?? 0) - (t[0] ?? 0)) / (t.length - 1) : 20e-6
  const readVpp = (jack: string) => {
    const node = assembled.nodeOf[`amp1.${jack}`]
    if (!node) return 0
    const raw = ng.getVector(node)
    const f32 = Float32Array.from(raw)
    return measureSignal(f32, dt)?.vpp ?? 0
  }
  return {
    ucVpp: readVpp('AMP_UC'),
    uoVpp: readVpp('AMP_UO'),
  }
}

describe('T1.4 FLT-01~04 MD-07 四类故障真实 ngspice 注入与修复恢复金标准', () => {
  const byId = (id: string) => {
    const fault = project.faults?.find((f) => f.id === id)
    if (!fault) throw new Error(`Missing fault ${id}`)
    return fault
  }

  it('MD-07 全部 6 个故障注入后电气现象准确，撤除故障后精确恢复正常基准', () => {
    const normal = runOp()
    expect(normal.ub).toBeCloseTo(3.294, 2)
    expect(normal.uc).toBeCloseTo(5.87, 2)
    expect(normal.ue).toBeCloseTo(2.597, 2)

    // 1. RB1 开路：三极管截止，UB≈0, UE≈0, UC≈12 V
    const rb1Open = runOp(byId('f-rb1-open'))
    expect(rb1Open.ub).toBeLessThan(0.05)
    expect(rb1Open.ue).toBeLessThan(0.05)
    expect(rb1Open.uc).toBeGreaterThan(11.9)

    // 2. RB2 开路：深度饱和，UB≈4.2 V, UE≈3.5 V, UC≈3.56 V (UCE < 0.15 V)
    const rb2Open = runOp(byId('f-rb2-open'))
    expect(rb2Open.ub).toBeGreaterThan(4.0)
    expect(rb2Open.ue).toBeGreaterThan(3.3)
    expect(Math.abs(rb2Open.uc - rb2Open.ue)).toBeLessThan(0.15)

    // 3. RC 短路：UB、UE 维持正常，UC 被钳位至 12 V
    const rcShort = runOp(byId('f-rc-short'))
    expect(rcShort.ub).toBeCloseTo(normal.ub, 1)
    expect(rcShort.ue).toBeCloseTo(normal.ue, 1)
    expect(rcShort.uc).toBeGreaterThan(11.95)

    // 4. RE 参数漂移至 10 kΩ：UB≈3.75 V, UE≈3.08 V，IC 骤降至 ~0.3 mA，UC≈11.27 V
    const reDrift = runOp(byId('f-re-drift'))
    expect(reDrift.ub).toBeGreaterThan(3.6)
    expect(reDrift.ue).toBeGreaterThan(2.9)
    expect(reDrift.uc).toBeGreaterThan(11.0)
    expect(reDrift.uc).toBeLessThan(11.6)

    // 5. QVT1 C-E 击穿损坏（bjt_ce_short）：UC≈UE≈3.53 V，UB≈3.87 V（纯电阻分压）
    const vt1Dead = runOp(byId('f-vt1-dead'))
    expect(Math.abs(vt1Dead.uc - vt1Dead.ue)).toBeLessThan(0.05)
    expect(vt1Dead.uc).toBeCloseTo(3.53, 1)
    expect(vt1Dead.ub).toBeCloseTo(3.87, 1)

    // 6. C2 输出耦合电容开路：静态点正常且 C 点有放大波形（~1.2 Vpp），但 Uo 端无交流输出
    const normalTran = runTranVpp()
    expect(normalTran.ucVpp).toBeGreaterThan(1.0)
    expect(normalTran.uoVpp).toBeGreaterThan(1.0)

    const c2Open = runTranVpp(byId('f-c2-open'))
    expect(c2Open.ucVpp).toBeGreaterThan(1.5)
    expect(c2Open.uoVpp).toBeLessThan(0.01)

    // 撤除故障修复后，静态点与动态输出均完全恢复至基准
    const restoredOp = runOp()
    expect(restoredOp.ub).toBeCloseTo(normal.ub, 4)
    expect(restoredOp.uc).toBeCloseTo(normal.uc, 4)
    expect(restoredOp.ue).toBeCloseTo(normal.ue, 4)
    const restoredTran = runTranVpp()
    expect(restoredTran.uoVpp).toBeCloseTo(normalTran.uoVpp, 2)
  })

  it('同型号双实例中仅故障实例受影响，未故障实例静态工作点保持不变', () => {
    const assembled = assembleNetlist({
      title: 'md07-dual-isolation',
      modules: [
        { instanceId: 'amp1', module: ampMod, subckt: ampCir },
        { instanceId: 'amp2', module: ampMod, subckt: ampCir },
      ],
      instruments: [{ instanceId: 'ps', instrument: psu, settings: { ch1_v: 12 } }],
      wires: [
        { a: 'ps.CH1P', b: 'amp1.AMP_VCC' },
        { a: 'ps.CH1N', b: 'amp1.AMP_GND1' },
        { a: 'ps.CH1P', b: 'amp2.AMP_VCC' },
        { a: 'ps.CH1N', b: 'amp2.AMP_GND1' },
      ],
      controlValues: { 'amp1.RW': 22000, 'amp1.KCE': 1, 'amp2.RW': 22000, 'amp2.KCE': 1 },
      ground: 'ps.CH1N',
      fault: byId('f-vt1-dead'),
      analysis: ['.op'],
    })
    ng.load(assembled.netlist)
    ng.run()
    const uc1 = ng.getVector(assembled.nodeOf['amp1.AMP_UC'] as string)[0] ?? 0
    const ue1 = ng.getVector(assembled.nodeOf['amp1.AMP_UE'] as string)[0] ?? 0
    const uc2 = ng.getVector(assembled.nodeOf['amp2.AMP_UC'] as string)[0] ?? 0
    const ue2 = ng.getVector(assembled.nodeOf['amp2.AMP_UE'] as string)[0] ?? 0
    expect(Math.abs(uc1 - ue1)).toBeLessThan(0.05)
    expect(uc2).toBeCloseTo(5.87, 2)
    expect(ue2).toBeCloseTo(2.597, 2)
  })

  it('二极管击穿/开路与电容漏电损坏模型在真实 ngspice 下响应准确', () => {
    const diodesLib = readFileSync('content/models/spice/diodes.lib', 'utf8')
    const baseSubckt = `.subckt test_d IN OUT\nR1 IN mid 1k\nD1 mid OUT D1N4007\n.ends test_d\n${diodesLib}`
    const runDiode = (subcktText: string) => {
      ng.load(`* diode fault\n${subcktText}\nV1 in 0 DC 5\nX1 in 0 test_d\n.op\n.end`)
      ng.run()
      return ng.getVector('x1.mid')[0] ?? Number.NaN
    }
    const normalVf = runDiode(baseSubckt)
    expect(normalVf).toBeGreaterThan(0.55)
    expect(normalVf).toBeLessThan(0.75)

    const shortedSubckt = injectFault(baseSubckt, 'D1', {
      id: 'd-short',
      target: 'x1.D1',
      kind: 'dead',
      params: { model: 'diode_short' },
      symptom: 's',
      hint: 'h',
    })
    expect(runDiode(shortedSubckt)).toBeLessThan(0.01)

    const openSubckt = injectFault(baseSubckt, 'D1', {
      id: 'd-open',
      target: 'x1.D1',
      kind: 'dead',
      params: { model: 'diode_open' },
      symptom: 's',
      hint: 'h',
    })
    expect(runDiode(openSubckt)).toBeGreaterThan(4.9)
  })
})
