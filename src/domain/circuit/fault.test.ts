import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, Module } from '../../shared/schema/index.ts'
import { assembleNetlist } from './assemble.ts'
import { AssembleError } from './errors.ts'
import { injectFault, listSubcktElements } from './fault.ts'
import { expandLocalLibraries } from './libraries.ts'

const ampMod = Module.parse(JSON.parse(readFileSync('content/modules/mod-analog-amp/module.json', 'utf8')))
const ampCir = expandLocalLibraries(readFileSync('content/modules/mod-analog-amp/module.cir', 'utf8'), {
  'bjt.lib': readFileSync('content/models/spice/bjt.lib', 'utf8'),
})
const psu = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-dc-power/instrument.json', 'utf8')))

describe('T1.4 FLT-01 故障注入与子电路副本隔离', () => {
  it('提取模块主子电路元件位号并排除铜箔短接与开关辅助电阻', () => {
    const names = listSubcktElements(ampCir).map((item) => item.name)
    expect(names).toEqual(
      expect.arrayContaining(['R1', 'C1', 'RW', 'RB1', 'RB2', 'QVT1', 'RC', 'RE', 'CE', 'C2', 'RL']),
    )
    expect(names).not.toContain('Rcu_ground')
    expect(names).not.toContain('RKCE')
  })

  it('支持开路、短路、参数漂移与三极管/二极管/电容/芯片损坏模型改写', () => {
    const open = injectFault(ampCir, 'RB1', {
      id: 'f-open',
      target: 'amp1.RB1',
      kind: 'open',
      symptom: 's',
      hint: 'h',
    })
    expect(open).toMatch(/^RB1 n_rw fault_open_RB1 20k$/m)
    expect(open).toMatch(/^Rfault_open_RB1 fault_open_RB1 AMP_UB 1G$/m)

    const short = injectFault(ampCir, 'RC', {
      id: 'f-short',
      target: 'amp1.RC',
      kind: 'short',
      symptom: 's',
      hint: 'h',
    })
    expect(short).toMatch(/^Rfault_short_RC AMP_VCC AMP_UC 1m$/m)

    const drift = injectFault(ampCir, 'RE', {
      id: 'f-drift',
      target: 'amp1.RE',
      kind: 'drift',
      params: { value: '10k' },
      symptom: 's',
      hint: 'h',
    })
    expect(drift).toMatch(/^RE AMP_UE AMP_GND1 10k$/m)

    const deadBjt = injectFault(ampCir, 'QVT1', {
      id: 'f-dead-bjt',
      target: 'amp1.QVT1',
      kind: 'dead',
      params: { model: 'bjt_ce_short' },
      symptom: 's',
      hint: 'h',
    })
    expect(deadBjt).toMatch(/^QVT1 AMP_UC fault_dead_QVT1_b AMP_UE bjt_ce_short$/m)
    expect(deadBjt).toContain('.model bjt_ce_short NPN(')
    expect(deadBjt).toMatch(/^Rfault_dead_QVT1 AMP_UC AMP_UE 1$/m)

    const deadCap = injectFault(ampCir, 'C2', {
      id: 'f-dead-cap',
      target: 'amp1.C2',
      kind: 'dead',
      params: { model: 'cap_leak', r: '150' },
      symptom: 's',
      hint: 'h',
    })
    expect(deadCap).toMatch(/^C2 AMP_UC AMP_UO 1n$/m)
    expect(deadCap).toMatch(/^Rfault_dead_C2 AMP_UC AMP_UO 150$/m)

    const diodeSubckt = `.subckt mod_d A K\nD1 A K D1N4007\n.ends mod_d`
    const deadDiode = injectFault(diodeSubckt, 'D1', {
      id: 'f-dead-diode',
      target: 'd1.D1',
      kind: 'dead',
      params: { model: 'diode_short' },
      symptom: 's',
      hint: 'h',
    })
    expect(deadDiode).toMatch(/^D1 A K diode_short$/m)
    expect(deadDiode).toMatch(/^Rfault_dead_D1 A K 1m$/m)

    const icSubckt = `.subckt mod_ic IN1 IN2 OUT1 GND VCC\nXU1 IN1 IN2 OUT1 GND VCC SN74LS00\n.ends mod_ic`
    const deadIc = injectFault(icSubckt, 'XU1', {
      id: 'f-dead-ic',
      target: 'ic1.XU1',
      kind: 'dead',
      params: { model: 'ic_stuck_low', pin: 3, rail: 'GND' },
      symptom: 's',
      hint: 'h',
    })
    expect(deadIc).toMatch(/^XU1 IN1 IN2 fault_dead_XU1_p3 GND VCC SN74LS00$/m)
    expect(deadIc).toMatch(/^Rfault_dead_XU1 OUT1 GND 20$/m)
  })

  it('三端晶体管支持按引脚开路、按电极对短路及 β 漂移，且缺少必要参数报错', () => {
    const bjtOpenE = injectFault(ampCir, 'QVT1', {
      id: 'f-q-open-e',
      target: 'amp1.QVT1',
      kind: 'open',
      params: { terminal: 'e' },
      symptom: 's',
      hint: 'h',
    })
    expect(bjtOpenE).toMatch(/^QVT1 AMP_UC AMP_UB fault_open_QVT1 NPN_3DG6_EST$/m)
    expect(bjtOpenE).toMatch(/^Rfault_open_QVT1 fault_open_QVT1 AMP_UE 1G$/m)

    const bjtShortBe = injectFault(ampCir, 'QVT1', {
      id: 'f-q-short-be',
      target: 'amp1.QVT1',
      kind: 'short',
      params: { pair: 'be' },
      symptom: 's',
      hint: 'h',
    })
    expect(bjtShortBe).toMatch(/^Rfault_short_QVT1 AMP_UB AMP_UE 1m$/m)

    const bjtDrift = injectFault(ampCir, 'QVT1', {
      id: 'f-q-drift',
      target: 'amp1.QVT1',
      kind: 'drift',
      params: { value: 5 },
      symptom: 's',
      hint: 'h',
    })
    expect(bjtDrift).toMatch(/^QVT1 AMP_UC AMP_UB AMP_UE NPN_3DG6_EST__drift_QVT1$/m)
    expect(bjtDrift).toContain('BF=5')

    expect(() =>
      injectFault(ampCir, 'NO_SUCH', {
        id: 'f-missing',
        target: 'amp1.NO_SUCH',
        kind: 'open',
        symptom: 's',
        hint: 'h',
      }),
    ).toThrow(AssembleError)
    expect(() =>
      injectFault(ampCir, 'RE', { id: 'f-no-val', target: 'amp1.RE', kind: 'drift', symptom: 's', hint: 'h' }),
    ).toThrow(AssembleError)
    expect(() =>
      injectFault(ampCir, 'QVT1', { id: 'f-no-mod', target: 'amp1.QVT1', kind: 'dead', symptom: 's', hint: 'h' }),
    ).toThrow(AssembleError)
  })

  it('同型号双实例中仅改写目标实例子电路副本，不影响另一实例与原始模型', () => {
    const out = assembleNetlist({
      title: 'dual-amp-fault-isolation',
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
      controlValues: {},
      ground: 'ps.CH1N',
      fault: {
        id: 'f-vt1-dead',
        target: 'amp1.QVT1',
        kind: 'dead',
        params: { model: 'bjt_ce_short' },
        symptom: 's',
        hint: 'h',
      },
      analysis: ['.op'],
    })
    expect(out.netlist).toContain('.subckt mod_analog_amp__amp1 ')
    expect(out.netlist).toContain('.subckt mod_analog_amp ')
    expect(out.netlist).toMatch(/^Xamp1 .* mod_analog_amp__amp1 /m)
    expect(out.netlist).toMatch(/^Xamp2 .* mod_analog_amp /m)
    expect(out.netlist).toContain('.model NPN_3DG6_EST NPN(')
  })
})
