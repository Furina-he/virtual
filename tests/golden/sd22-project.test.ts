import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type AssembleInput, assembleNetlist } from '../../src/domain/circuit/assemble.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import { checkWiring } from '../../src/domain/wiring-check/index.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'
import {
  formalSd22Circuit,
  formalSd22Input,
  formalSd22Module,
  formalSd22Placement,
  formalSd22Project,
  formalSd22Reference,
  resetFormalSd22,
  withoutFormalSd22Jack,
} from './fixtures/sd22-project.ts'

const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))
const jacks = ['VCC1', 'T1_OUT', 'T1_TH', 'T1_CV', 'T2_OUT', 'T2_TH', 'T2_CV', 'SPK_P', 'SPK_N'] as const
type Jack = (typeof jacks)[number]
type Trace = { time: Float64Array; voltage: Record<Jack, Float64Array> }
const ref = (jack: string) => `${formalSd22Placement.instanceId}.${jack}`

function capture(input: AssembleInput, step: number, stop: number, start = 0): Trace {
  const assembled = assembleNetlist(input)
  const nodes = Object.fromEntries([...jacks, 'GND1'].map((jack) => [jack, assembled.nodeOf[ref(jack)] as string]))
  const saved = [...new Set(Object.values(nodes))].filter((node) => node !== '0')
  ng.load(
    [
      assembled.netlist.replace(/\.end\s*$/, ''),
      `.save ${saved.map((node) => `v(${node})`).join(' ')}`,
      `.tran ${step} ${stop} ${start} ${step}`,
      '.end',
    ].join('\n'),
  )
  ng.run()
  const time = ng.getVector('time')
  const ground = nodes.GND1 === '0' ? new Float64Array(time.length) : ng.getVector(nodes.GND1 as string)
  const voltage = Object.fromEntries(
    jacks.map((jack) => {
      const node = nodes[jack] as string
      const vector = node === '0' ? new Float64Array(time.length) : ng.getVector(node)
      return [jack, Float64Array.from(vector, (value, i) => value - (ground[i] as number))]
    }),
  ) as Trace['voltage']
  return { time, voltage }
}

function edges(trace: Trace, jack: Jack, level: number, from: number, to: number): number[] {
  const { time, voltage } = trace
  const v = voltage[jack]
  const result: number[] = []
  for (let i = 1; i < time.length; i++) {
    const a = v[i - 1] as number
    const b = v[i] as number
    if (a >= level || b < level) continue
    const at = (time[i - 1] as number) + ((level - a) / (b - a)) * ((time[i] as number) - (time[i - 1] as number))
    if (at >= from && at <= to) result.push(at)
  }
  return result
}

function frequency(trace: Trace, jack: Jack, level: number, from: number, to: number): number {
  const crossings = edges(trace, jack, level, from, to)
  expect(crossings.length).toBeGreaterThanOrEqual(3)
  return (crossings.length - 1) / ((crossings.at(-1) as number) - (crossings[0] as number))
}

function range(trace: Trace, jack: Jack, from: number, to: number): [number, number] {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < trace.time.length; i++) {
    const time = trace.time[i] as number
    if (time < from || time > to) continue
    const value = trace.voltage[jack][i] as number
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true)
  return [min, max]
}

function mean(trace: Trace, jack: Jack): number {
  const v = trace.voltage[jack]
  return v.reduce((sum, value) => sum + value, 0) / v.length
}

// Independent RC equations use the real supply/CV levels, not a hard-coded sound frequency.
function carrierTheory(supply: number, control: number): number {
  const charge = (10e3 + 10e3) * 47e-9 * Math.log((supply - control / 2) / (supply - control))
  const dischargeVoltage = (supply * 10) / (10e3 + 10)
  const dischargeR = 10e3 + 1 / (1 / 10e3 + 1 / 10)
  const discharge = dischargeR * 47e-9 * Math.log((control - dischargeVoltage) / (control / 2 - dischargeVoltage))
  return 1 / (charge + discharge)
}

function speakerPower(trace: Trace): number {
  let energy = 0
  for (let i = 1; i < trace.time.length; i++) {
    const previous = (trace.voltage.SPK_P[i - 1] as number) - (trace.voltage.SPK_N[i - 1] as number)
    const next = (trace.voltage.SPK_P[i] as number) - (trace.voltage.SPK_N[i] as number)
    energy += ((previous ** 2 + next ** 2) / 2) * ((trace.time[i] as number) - (trace.time[i - 1] as number))
  }
  return energy / ((trace.time.at(-1) as number) - (trace.time[0] as number)) / 8
}

describe('Formal SD-22 module and ambulance circuit (real ngspice)', () => {
  let alternating: Trace
  let highControl: Trace
  let lowControl: Trace
  let unmodulated: Trace

  beforeAll(() => {
    alternating = capture(formalSd22Input(), 20e-6, 4, 0.8)
    // Short, fine captures isolate steady plateaus. Reset is a real rewiring diagnostic,
    // not a pre-recorded carrier; natural alternation is proved by the long trace.
    highControl = capture(formalSd22Input(), 1e-6, 0.04, 0.01)
    lowControl = capture(resetFormalSd22(formalSd22Input(), 'T1'), 1e-6, 0.04, 0.01)
    unmodulated = capture(withoutFormalSd22Jack(formalSd22Input(), ref('R5_1')), 1e-6, 0.04, 0.01)
  }, 20_000)

  it('preserves all 36 prototype jack IDs, DIP wiring and separate passive endpoints', () => {
    const ports = formalSd22Circuit.match(/^\.subckt mod_555_app (.+)$/m)?.[1]?.split(' ')
    expect(ports).toEqual(formalSd22Module.jacks.map((jack) => jack.id))
    expect(ports).toHaveLength(36)
    expect(formalSd22Circuit).toContain('.include "timers.lib"')
    expect(formalSd22Circuit.indexOf('.include')).toBeGreaterThan(formalSd22Circuit.indexOf('.ends mod_555_app'))
    expect(formalSd22Circuit).toContain('XIC1 GND1 T1_TR T1_OUT T1_RST T1_CV T1_TH T1_DIS VCC1 NE555')
    expect(formalSd22Circuit).toContain('XIC2 GND1 T2_TR T2_OUT T2_RST T2_CV T2_TH T2_DIS VCC1 NE555')
    for (const line of [
      'RA1 T1_RA_1 T1_RA_2 10k',
      'RB1 T1_RB_1 T1_RB_2 150k',
      'C1 T1_CT_P T1_CT_N 4.7u',
      'RA2 T2_RA_1 T2_RA_2 10k',
      'RB2 T2_RB_1 T2_RB_2 10k',
      'C2 T2_CT_P T2_CT_N 47n',
      'R5 R5_1 R5_2 10k',
      'C5 C5_P C5_N 100u',
      'RLS1 SPK_P SPK_N 8',
    ])
      expect(formalSd22Circuit).toContain(line)
    expect(formalSd22Module.controls).toEqual([])
    expect(formalSd22Module.commonNets ?? []).toEqual([])
    expect(formalSd22Module.internalJumpers ?? []).toEqual([])
    expect(formalSd22Project.validation?.limitations.join(' ')).toContain('消防车')
  })

  it('uses a real 5 V supply with the timer/speaker load present', () => {
    const supply = mean(highControl, 'VCC1')
    expect(Math.abs(supply - 5) / 5).toBeLessThanOrEqual(0.01)
    expect(range(highControl, 'T2_OUT', 0.01, 0.04)[1]).toBeLessThan(3.4)
  })

  it('sustains approximately 0.99 Hz modulation with 1/3 and 2/3 supply capacitor thresholds', () => {
    const measured = frequency(alternating, 'T1_OUT', 1.65, 1, 4)
    const theory = 1.44 / ((10e3 + 2 * 150e3) * 4.7e-6)
    expect(Math.abs(measured - theory) / theory).toBeLessThanOrEqual(0.01)
    const [min, max] = range(alternating, 'T1_TH', 1.4, 3.6)
    expect(Math.abs(min - 5 / 3) / (5 / 3)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(max - (2 * 5) / 3) / ((2 * 5) / 3)).toBeLessThanOrEqual(0.01)
    console.log(`Formal SD-22 LF=${measured.toFixed(6)} Hz, C1=${min.toFixed(6)}..${max.toFixed(6)} V`)
  })

  it('produces both ambulance carrier plateaus within 1% of independent CV-dependent theory', () => {
    const carriers = [highControl, lowControl].map((trace) => {
      const control = mean(trace, 'T2_CV')
      const measured = frequency(trace, 'T2_OUT', 1.65, 0.01, 0.04)
      const theory = carrierTheory(mean(trace, 'VCC1'), control)
      expect(Math.abs(measured - theory) / theory).toBeLessThanOrEqual(0.01)
      console.log(
        `Formal SD-22 CV=${control.toFixed(6)} V, HF=${measured.toFixed(3)} Hz, theory=${theory.toFixed(3)} Hz`,
      )
      return { measured, control }
    })
    expect(carriers[0]?.control).toBeCloseTo(3.325, 2)
    expect(carriers[1]?.control).toBeCloseTo(2.5006, 2)
    expect((carriers[1]?.measured as number) / (carriers[0]?.measured as number)).toBeGreaterThan(1.3)
    // The long natural trace reaches both of those CV states, not only reset diagnostics.
    expect(range(alternating, 'T2_CV', 1, 4)[0]).toBeCloseTo(carriers[1]?.control as number, 2)
    expect(range(alternating, 'T2_CV', 1, 4)[1]).toBeCloseTo(carriers[0]?.control as number, 2)
    // The existing long trace must also keep the carrier running in both natural
    // modulation states. Its coarse step is not used for the 1% frequency check.
    const naturalHighTone = frequency(alternating, 'T2_OUT', 1.65, 1, 1.1)
    const naturalLowTone = frequency(alternating, 'T2_OUT', 1.65, 1.5, 1.6)
    expect(range(alternating, 'T1_OUT', 1, 1.1)[1]).toBeLessThan(0.1)
    expect(range(alternating, 'T1_OUT', 1.5, 1.6)[0]).toBeGreaterThan(3)
    expect(naturalHighTone / naturalLowTone).toBeGreaterThan(1.3)
  })

  it('returns the approximately 1.02 kHz unmodulated RC carrier after the modulation wire is removed', () => {
    const control = mean(unmodulated, 'T2_CV')
    expect(control).toBeCloseTo(10 / 3, 2)
    const measured = frequency(unmodulated, 'T2_OUT', 1.65, 0.01, 0.04)
    expect(Math.abs(measured - carrierTheory(mean(unmodulated, 'VCC1'), control)) / measured).toBeLessThanOrEqual(0.01)
  })

  it('keeps both loaded carrier plateaus within 1% at the 2 us maximum-step integration boundary', () => {
    for (const input of [formalSd22Input(), resetFormalSd22(formalSd22Input(), 'T1')]) {
      const trace = capture(input, 2e-6, 0.04, 0.01)
      const measured = frequency(trace, 'T2_OUT', 1.65, 0.01, 0.04)
      const expected = carrierTheory(mean(trace, 'VCC1'), mean(trace, 'T2_CV'))
      expect(Math.abs(measured - expected) / expected).toBeLessThanOrEqual(0.01)
    }
  })

  it('drives the actual differential 8 ohm load below its 0.5 W rating, not an ideal 5 V sound source', () => {
    for (const trace of [highControl, lowControl]) {
      const power = speakerPower(trace)
      expect(power).toBeGreaterThan(0.04)
      expect(power).toBeLessThan(0.5)
      const [min, max] = range(trace, 'SPK_P', 0.01, 0.04)
      expect(min).toBeLessThan(0)
      expect(max).toBeGreaterThan(0)
      expect(max - min).toBeLessThan(3.3)
      console.log(`Formal SD-22 speaker mean power=${power.toFixed(6)} W, Vpp=${(max - min).toFixed(6)} V`)
    }
  })

  it('stops the audio output when the high-frequency chip RESET is grounded', () => {
    const stopped = capture(resetFormalSd22(formalSd22Input(), 'T2'), 20e-6, 0.04, 0.01)
    expect(range(stopped, 'T2_OUT', 0.01, 0.04)[1]).toBeLessThan(0.1)
    expect(speakerPower(stopped)).toBeLessThan(1e-6)
  })

  it('does not oscillate with the application supply disconnected', () => {
    const input = formalSd22Input()
    const off = buildMeasurementPlan(input, false, 'formal-off')
    const passive = {
      ...input,
      instruments: input.instruments.map((entry) => ({
        ...entry,
        instrument: { ...entry.instrument, spiceTemplate: '* supply disconnected' },
      })),
    }
    expect(off.command.netlist).not.toContain('Vch1_')
    const trace = capture(passive, 20e-6, 0.04, 0.01)
    for (const jack of ['T1_OUT', 'T2_OUT'] as const) {
      const [min, max] = range(trace, jack, 0.01, 0.04)
      expect(Math.max(Math.abs(min), Math.abs(max))).toBeLessThan(0.1)
    }
    expect(speakerPower(trace)).toBeLessThan(1e-6)
  })

  it.each(['CH1P', 'CH1N'])('does not work when supply jack %s is disconnected', (jack) => {
    const broken = withoutFormalSd22Jack(formalSd22Input(), `ins-dc-power.${jack}`)
    const trace = capture(broken, 20e-6, 0.04, 0.01)
    for (const output of ['T1_OUT', 'T2_OUT'] as const) {
      const [min, max] = range(trace, output, 0.01, 0.04)
      expect(Math.max(Math.abs(min), Math.abs(max))).toBeLessThan(0.1)
    }
    expect(speakerPower(trace)).toBeLessThan(1e-6)
  })

  it('accepts each separate complete reference topology but rejects their simultaneous modulation wires', () => {
    const ambulance = formalSd22Input()
    const fire = formalSd22Input('fire-prototype')
    for (const [input, mode] of [
      [ambulance, 'ambulance'],
      [fire, 'fire-prototype'],
    ] as const) {
      const reference = { ...formalSd22Reference(mode), measurePoints: [] }
      expect(checkWiring(input, reference).circuitOk).toBe(true)
    }
    expect(checkWiring(fire, { ...formalSd22Reference('ambulance'), measurePoints: [] }).circuitOk).toBe(false)
    const mixed = { ...ambulance, wires: [...ambulance.wires, { a: ref('T1_TH'), b: ref('R5_1') }] }
    for (const mode of ['ambulance', 'fire-prototype'] as const)
      expect(checkWiring(mixed, { ...formalSd22Reference(mode), measurePoints: [] }).circuitOk).toBe(false)
  })
})

// This regression documents a physical prototype defect. It is NOT fire-mode delivery acceptance.
describe('Formal fire-prototype loading diagnosis (mode remains undelivered)', () => {
  it('shows the CV loading locks C1 above the lower threshold, rather than sustaining a sweep', () => {
    const trace = capture(formalSd22Input('fire-prototype'), 20e-6, 4, 0.8)
    const supply = mean(trace, 'VCC1')
    const source = supply * (10e3 / (5e3 + 10e3))
    const sourceR = 10e3 + 1 / (1 / 5e3 + 1 / 10e3)
    const dischargeVoltage = (supply * 10) / (10e3 + 10)
    const dischargeR = 150e3 + 1 / (1 / 10e3 + 1 / 10)
    const equilibrium = (source / sourceR + dischargeVoltage / dischargeR) / (1 / sourceR + 1 / dischargeR)
    const capacitor = mean(trace, 'T1_TH')
    expect(equilibrium).toBeGreaterThan(5 / 3)
    expect(Math.abs(capacitor - equilibrium) / equilibrium).toBeLessThanOrEqual(0.01)
    expect(range(trace, 'T1_TH', 1, 4)[1] - range(trace, 'T1_TH', 1, 4)[0]).toBeLessThan(1e-3)
    expect(range(trace, 'T1_OUT', 1, 4)[1]).toBeLessThan(0.1)
    expect(edges(trace, 'T1_OUT', 1.65, 1, 4)).toEqual([])
    const [cvMin, cvMax] = range(trace, 'T2_CV', 1, 4)
    expect(cvMax - cvMin).toBeLessThan(1e-3)
    expect(cvMin).toBeCloseTo(3.2654, 2)
    const first = frequency(trace, 'T2_OUT', 1.65, 1, 1.2)
    const last = frequency(trace, 'T2_OUT', 1.65, 3.7, 3.9)
    expect(Math.abs(last - first) / first).toBeLessThanOrEqual(0.01)
    console.log(`Undelivered fire prototype: C1=${capacitor.toFixed(9)} V, CV=${cvMin.toFixed(9)} V, no LF edges`)
  })
})
