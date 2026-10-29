import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AssembleOutput, assembleNetlist } from '../../src/domain/circuit/assemble.ts'
import { getInstrumentDefaults, readInstrument, resolveInstrument } from '../../src/domain/instruments/index.ts'
import { Instrument, Module } from '../../src/shared/schema/index.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'
import { lib } from './models/helpers.ts'

// All transistor parameters are the explicit M0 estimates in bjt.lib, not a 3DG6 datasheet oracle.
const BETA = 60
const IS = 5e-15
const VT = 8.617333262e-5 * (273.15 + 27)
const RC = 2400
const RE = 1000
const RB2 = 20000
const RS = 5100
const RL = 2400
const SCOPE_R = 1e6
const moduleRoot = 'content/modules/mod-analog-amp'
const rawModule = JSON.parse(readFileSync(`${moduleRoot}/module.json`, 'utf8'))
const module = Module.parse(rawModule)
const subckt = readFileSync(`${moduleRoot}/module.cir`, 'utf8').replace(/^\.include\s+"bjt\.lib"\s*$/m, lib('bjt.lib'))
const loadInstrument = (id: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${id}/instrument.json`, 'utf8')))
const supply = loadInstrument('ins-dc-power')
const generator = loadInstrument('ins-func-gen')
const scope = loadInstrument('ins-oscilloscope')
const meter = loadInstrument('ins-multimeter')
const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))

type Options = {
  rw?: number
  kce?: number
  loaded?: boolean
  vpp?: number
  frequency?: number
  inputPair?: boolean
  dcJack?: string
  duration?: number
}
function bench(options: Options = {}, transient = false): AssembleOutput {
  const {
    rw = 22000,
    kce = 1,
    loaded = true,
    vpp = 0.1,
    frequency = 1000,
    inputPair = false,
    dcJack,
    duration = 0.15,
  } = options
  return assembleNetlist({
    title: 'MD-03 real estimated-3DG6 board',
    modules: [{ instanceId: 'amp1', module, subckt }],
    instruments: [
      { instanceId: 'power', instrument: supply, settings: { ...getInstrumentDefaults(supply), ch1_v: 12 } },
      ...(dcJack ? [{ instanceId: 'meter', instrument: meter, settings: { range: 'dcv20' } }] : []),
      ...(transient
        ? [
            {
              instanceId: 'gen',
              instrument: generator,
              settings: { ...getInstrumentDefaults(generator), ch1_freq: frequency, ch1_amp: vpp, ch2_on: 0 },
            },
            { instanceId: 'scope', instrument: scope, settings: { ...getInstrumentDefaults(scope), out_on: 0 } },
          ]
        : []),
    ],
    wires: [
      { a: 'power.CH1P', b: 'amp1.AMP_VCC' },
      { a: 'power.CH1N', b: 'amp1.AMP_GND1' },
      ...(loaded ? [{ a: 'amp1.AMP_UO', b: 'amp1.AMP_RL' }] : []),
      ...(dcJack
        ? [
            { a: 'meter.VOHM', b: `amp1.${dcJack}` },
            { a: 'meter.COM', b: 'amp1.AMP_GND2' },
          ]
        : []),
      ...(transient
        ? [
            { a: 'gen.CH1', b: 'amp1.AMP_US' },
            { a: 'gen.GND', b: 'amp1.AMP_GND2' },
            { a: 'scope.CH1', b: inputPair ? 'amp1.AMP_US' : 'amp1.AMP_UI' },
            { a: 'scope.CH2', b: inputPair ? 'amp1.AMP_UI' : 'amp1.AMP_UO' },
            { a: 'scope.GND', b: 'amp1.AMP_GND2' },
          ]
        : []),
    ],
    controlValues: { 'amp1.RW': rw, 'amp1.KCE': kce },
    ground: 'amp1.AMP_GND1',
    analysis: transient ? ['.save all @q.xamp1.qvt1[ic]', `.tran 1u ${duration} ${duration - 0.02} 1u`] : ['.op'],
  })
}

function node(assembled: AssembleOutput, jack: string): string {
  const found = assembled.nodeOf[`amp1.${jack}`]
  if (!found) throw new Error(`Missing board jack ${jack}`)
  return found
}
function voltage(assembled: AssembleOutput, jack: string): number {
  const id = node(assembled, jack)
  return id === '0' ? 0 : (ng.getVector(id)[0] as number)
}
function operatingPoint(rw: number, kce = 1) {
  const assembled = bench({ rw, kce })
  ng.load(assembled.netlist)
  ng.run()
  const vcc = voltage(assembled, 'AMP_VCC')
  const b = voltage(assembled, 'AMP_UB')
  const c = voltage(assembled, 'AMP_UC')
  const e = voltage(assembled, 'AMP_UE')
  return { vcc, b, c, e, vbe: b - e, vce: c - e, ic: (vcc - c) / RC, ie: e / RE }
}

/** Independent divider KCL + Shockley/constant-beta estimate; use only in forward-active operation. */
function theory(rw: number, dcJack?: string) {
  const top = 20000 + Math.max(rw, 0.001)
  const inputR = 1e7
  const emitterR = dcJack === 'AMP_UE' ? 1 / (1 / RE + 1 / inputR) : RE
  const lowerBiasR = dcJack === 'AMP_UB' ? 1 / (1 / RB2 + 1 / inputR) : RB2
  let lo = 1e-12
  let hi = 0.02
  for (let i = 0; i < 100; i++) {
    const ic = (lo + hi) / 2
    const b = VT * Math.log(ic / IS + 1) + ic * (1 + 1 / BETA) * emitterR
    const residual = (12 - b) / top - b / lowerBiasR - ic / BETA
    if (residual > 0) lo = ic
    else hi = ic
  }
  const ic = (lo + hi) / 2
  const e = ic * (1 + 1 / BETA) * emitterR
  const b = e + VT * Math.log(ic / IS + 1)
  const c = (12 - ic * RC) / (dcJack === 'AMP_UC' ? 1 + RC / inputR : 1)
  return { ic, e, b, c, vce: c - e, gm: ic / VT, rpi: (BETA * VT) / ic, top }
}

type Complex = { re: number; im: number }
const z = (re: number, im = 0): Complex => ({ re, im })
const add = (a: Complex, b: Complex): Complex => z(a.re + b.re, a.im + b.im)
const mul = (a: Complex, b: Complex): Complex => z(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
const div = (a: Complex, b: Complex): Complex => {
  const norm = b.re * b.re + b.im * b.im
  return z((a.re * b.re + a.im * b.im) / norm, (a.im * b.re - a.re * b.im) / norm)
}
const parallel = (a: Complex, b: Complex): Complex => div(mul(a, b), add(a, b))
const magnitude = (value: Complex) => Math.hypot(value.re, value.im)

/** Independent hybrid-pi circuit includes C1/C2/CE and actual scope loading at the selected measurement jacks. */
function acTheory(options: Options = {}) {
  const { rw = 22000, kce = 1, frequency = 1000, loaded = true, inputPair = false } = options
  const q = theory(rw)
  const omega = 2 * Math.PI * frequency
  const capacitor = (c: number) => z(0, -1 / (omega * c))
  const emitter = parallel(z(RE), add(z(kce ? 0.001 : 1e12), capacitor(47e-6)))
  const transistorInput = add(z(q.rpi), mul(z(BETA + 1), emitter))
  const bias = parallel(z(q.top), z(RB2))
  const base = parallel(transistorInput, bias)
  const boardInput = add(capacitor(10e-6), base)
  const uiLoad = parallel(boardInput, z(SCOPE_R))
  const uiOverUs = div(uiLoad, add(z(RS), uiLoad))
  const outputLoad = inputPair ? (loaded ? z(RL) : z(1e12)) : z(loaded ? 1 / (1 / RL + 1 / SCOPE_R) : SCOPE_R)
  const collectorLoad = parallel(z(RC), add(capacitor(10e-6), outputLoad))
  const baseOverUi = div(base, boardInput)
  const vbeOverBase = div(z(q.rpi), transistorInput)
  const outputOverCollector = div(outputLoad, add(capacitor(10e-6), outputLoad))
  const gain = mul(mul(mul(z(-q.gm), vbeOverBase), collectorLoad), mul(baseOverUi, outputOverCollector))
  // The table's amplitude method is an apparent input resistance; do not silently treat phasors as scalars.
  const inputRatio = magnitude(uiOverUs)
  const apparentRi = (RS * inputRatio) / (1 - inputRatio)
  return { gain, uiOverUs, apparentRi, boardInput, q }
}

function steadySamples(t: Float64Array, values: Float64Array, frequency: number) {
  const count = Math.round(0.01 * frequency)
  const end = Math.floor(((t.at(-1) as number) - 1e-9) * frequency) / frequency
  const start = end - count / frequency
  if (start < (t[0] as number)) throw new Error('Transient capture does not contain the complete measurement window')
  // Linear interpolation avoids giving adaptive points near clipped edges extra statistical weight.
  let index = 1
  const dt = 1e-6
  const samples = new Float64Array(Math.round((end - start) / dt))
  for (let i = 0; i < samples.length; i++) {
    const time = start + i * dt
    while (index < t.length - 1 && (t[index] as number) < time) index++
    const ta = t[index - 1] as number
    const tb = t[index] as number
    const va = values[index - 1] as number
    const vb = values[index] as number
    samples[i] = va + ((time - ta) / (tb - ta)) * (vb - va)
  }
  return { samples, start, dt }
}
function phasor(t: Float64Array, values: Float64Array, frequency: number): Complex {
  const { samples, start, dt } = steadySamples(t, values, frequency)
  let re = 0
  let im = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number
    const time = start + i * dt
    re += v * Math.cos(2 * Math.PI * frequency * time)
    im -= v * Math.sin(2 * Math.PI * frequency * time)
  }
  return z((2 * re) / samples.length, (2 * im) / samples.length)
}
function transient(options: Options = {}) {
  const assembled = bench(options, true)
  ng.load(assembled.netlist)
  ng.run()
  const t = ng.getVector('time')
  const samples = (jack: string) => ng.getVector(node(assembled, jack))
  const us = samples('AMP_US')
  const ui = samples('AMP_UI')
  const uo = samples('AMP_UO')
  const b = samples('AMP_UB')
  const c = samples('AMP_UC')
  const e = samples('AMP_UE')
  const ic = ng.getVector('@q.xamp1.qvt1[ic]')
  const frequency = options.frequency ?? 1000
  return {
    assembled,
    t,
    us,
    ui,
    uo,
    b,
    c,
    e,
    ic,
    usPh: phasor(t, us, frequency),
    uiPh: phasor(t, ui, frequency),
    uoPh: phasor(t, uo, frequency),
  }
}

function distortion(result: ReturnType<typeof transient>, frequency = 1000) {
  const uo = steadySamples(result.t, result.uo, frequency).samples
  const b = steadySamples(result.t, result.b, frequency).samples
  const c = steadySamples(result.t, result.c, frequency).samples
  const e = steadySamples(result.t, result.e, frequency).samples
  const ic = steadySamples(result.t, result.ic, frequency).samples
  const vce = c.map((value, i) => value - (e[i] as number))
  const vbe = b.map((value, i) => value - (e[i] as number))
  const span = (values: ArrayLike<number>) => Math.max(...Array.from(values)) - Math.min(...Array.from(values))
  const uoVpp = span(uo)
  const saturated = uo.filter((_, i) => (vce[i] as number) < 0.2)
  const cutoff = uo.filter((_, i) => Math.abs(ic[i] as number) < 1e-6)
  const fundamental = magnitude(result.uoPh)
  let harmonics = 0
  for (let h = 2; h <= 8; h++) harmonics += magnitude(phasor(result.t, result.uo, frequency * h)) ** 2
  return {
    minVce: Math.min(...vce),
    minVbe: Math.min(...vbe),
    minIc: Math.min(...ic),
    maxIc: Math.max(...ic),
    uoVpp,
    satFraction: saturated.length / uo.length,
    cutoffFraction: cutoff.length / uo.length,
    satPlateauSpread: saturated.length ? span(saturated) / uoVpp : 1,
    cutoffPlateauSpread: cutoff.length ? span(cutoff) / uoVpp : 1,
    thd: Math.sqrt(harmonics) / fundamental,
  }
}

describe('MD-03 distinct estimated-3DG6 teaching board', () => {
  it('retains the ten prototype jacks, externally selected RL and a separately named transistor model', () => {
    expect(module.jacks.map((jack) => jack.id)).toEqual([
      'AMP_VCC',
      'AMP_GND1',
      'AMP_GND2',
      'AMP_US',
      'AMP_UI',
      'AMP_UB',
      'AMP_UC',
      'AMP_UE',
      'AMP_UO',
      'AMP_RL',
    ])
    expect(rawModule.simulation).toEqual({ analysis: 'tran', maxStep: 1e-6, pacing: 'window' })
    expect(module.commonNets).toEqual([['AMP_GND1', 'AMP_GND2']])
    expect(subckt).toContain('QVT1 AMP_UC AMP_UB AMP_UE NPN_3DG6_EST')
    expect(subckt).not.toMatch(/^R\w+\s+AMP_UO\s+AMP_RL/m)
    const library = readFileSync('content/models/spice/bjt.lib', 'utf8')
    expect(library).toContain('.model S9013 NPN(IS=3e-14 BF=175')
    expect(library).toContain('.model NPN_3DG6_EST NPN(IS=5e-15 BF=60')
    expect(library).toContain('NOT a vendor model')
  })

  it('implements the explicitly estimated forward beta and room-temperature VBE, not a vendor fit', () => {
    ng.load(
      [
        'Estimated model check',
        lib('bjt.lib'),
        'IB 0 b DC 20u',
        'VCE c 0 DC 5',
        'Q1 c b 0 NPN_3DG6_EST',
        '.op',
        '.end',
      ].join('\n'),
    )
    ng.run()
    const ic = -(ng.getVector('vce#branch')[0] as number)
    const beta = ic / 20e-6
    const vbe = ng.getVector('b')[0] as number
    expect(Math.abs(beta / BETA - 1)).toBeLessThan(0.01)
    expect(vbe).toBeGreaterThan(0.65)
    expect(vbe).toBeLessThan(0.75)
    console.log(`MD03 estimated model: beta=${beta.toFixed(4)}, VBE=${vbe.toFixed(6)} V`)
  })

  it('matches independent active-region divider/diode theory and logs candidate operating points', () => {
    for (const rw of [18000, 20000, 21000, 22000, 23000, 24000, 40000, 100000]) {
      const actual = operatingPoint(rw)
      const expected = theory(rw)
      for (const field of ['b', 'c', 'e', 'ic', 'vce'] as const)
        expect(Math.abs(actual[field] / expected[field] - 1), `${rw}/${field}`).toBeLessThan(0.01)
      expect(actual.vce).toBeGreaterThan(0.2)
      console.log(
        `MD03 RW=${rw}: B=${actual.b.toFixed(6)}, C=${actual.c.toFixed(6)}, E=${actual.e.toFixed(6)}, VCE=${actual.vce.toFixed(6)} V, IC=${(actual.ic * 1000).toFixed(6)} mA`,
      )
    }
  })

  it('does not claim DC cutoff at the upper bias resistance and keeps CE out of the DC bias equation', () => {
    const on = operatingPoint(22000, 1)
    const off = operatingPoint(22000, 0)
    expect(Math.abs(on.ic - off.ic)).toBeLessThan(1e-9)
    expect(operatingPoint(100000).ic).toBeGreaterThan(0.5e-3)
    const saturated = operatingPoint(0)
    expect(saturated.vce).toBeLessThan(0.2)
    console.log(
      `MD03 RW=0 saturated estimate: VCE=${saturated.vce.toFixed(6)} V, IC=${(saturated.ic * 1000).toFixed(6)} mA`,
    )
  })

  it('measures loaded inverting gain from real 1kHz samples within 1% of independent complex small-signal theory', () => {
    const result = transient()
    const actualGain = div(result.uoPh, result.uiPh)
    const expected = acTheory().gain
    expect(magnitude(add(actualGain, mul(z(-1), expected))) / magnitude(expected)).toBeLessThan(0.01)
    expect(actualGain.re).toBeLessThan(0)
    console.log(
      `MD03 1kHz 0.1Vpp: Us=${(2 * magnitude(result.usPh)).toFixed(9)} Vpp, Ui=${(2 * magnitude(result.uiPh)).toFixed(9)} Vpp, Uo=${(2 * magnitude(result.uoPh)).toFixed(9)} Vpp, |Au|=${magnitude(actualGain).toFixed(6)}, phase=${((Math.atan2(actualGain.im, actualGain.re) * 180) / Math.PI).toFixed(3)}deg`,
    )
  })

  it('measures apparent Ri at 5kHz and load/open Ro without treating the input phase as zero', () => {
    const input = transient({ frequency: 5000, inputPair: true })
    const apparentRi = (RS * magnitude(input.uiPh)) / (magnitude(input.usPh) - magnitude(input.uiPh))
    const expected = acTheory({ frequency: 5000, inputPair: true })
    expect(Math.abs(apparentRi / expected.apparentRi - 1)).toBeLessThan(0.01)
    const open = transient({ frequency: 5000, loaded: false })
    const load = transient({ frequency: 5000, loaded: true })
    const apparentRo = RL * (magnitude(div(open.uoPh, open.uiPh)) / magnitude(div(load.uoPh, load.uiPh)) - 1)
    const theoreticalRo =
      RL *
      (magnitude(acTheory({ frequency: 5000, loaded: false }).gain) /
        magnitude(acTheory({ frequency: 5000, loaded: true }).gain) -
        1)
    expect(Math.abs(apparentRo / theoreticalRo - 1)).toBeLessThan(0.01)
    console.log(
      `MD03 metrology5k: Us=${(2 * magnitude(input.usPh)).toFixed(9)}, Ui=${(2 * magnitude(input.uiPh)).toFixed(9)} Vpp, Ri(apparent)=${apparentRi.toFixed(6)} ohm; Uo(open)=${(2 * magnitude(open.uoPh)).toFixed(9)}, Uo(load)=${(2 * magnitude(load.uoPh)).toFixed(9)} Vpp, Ro(gain-normalized)=${apparentRo.toFixed(6)} ohm`,
    )
  })

  it('reduces actual gain when CE is disconnected rather than substituting a display waveform', () => {
    const on = transient({ kce: 1 })
    const off = transient({ kce: 0 })
    const onGain = magnitude(div(on.uoPh, on.uiPh))
    const offGain = magnitude(div(off.uoPh, off.uiPh))
    expect(Math.abs(offGain / magnitude(acTheory({ kce: 0 }).gain) - 1)).toBeLessThan(0.01)
    expect(onGain / offGain).toBeGreaterThan(50)
    console.log(
      `MD03 CE off: Us=${(2 * magnitude(off.usPh)).toFixed(9)}, Ui=${(2 * magnitude(off.uiPh)).toFixed(9)}, Uo=${(2 * magnitude(off.uoPh)).toFixed(9)} Vpp, |Au|=${offGain.toFixed(6)}`,
    )
  })

  it('measures B/C/E through the actual 10M multimeter and reports its rounded SI readings', () => {
    const config = resolveInstrument(meter, { range: 'dcv20' })
    for (const [jack, field] of [
      ['AMP_UB', 'b'],
      ['AMP_UC', 'c'],
      ['AMP_UE', 'e'],
    ] as const) {
      const assembled = bench({ dcJack: jack })
      ng.load(assembled.netlist)
      ng.run()
      const value = voltage(assembled, jack) - voltage(assembled, 'AMP_GND2')
      const expected = theory(22000, jack)[field]
      expect(Math.abs(value / expected - 1)).toBeLessThan(0.01)
      const reading = readInstrument(config, { voltage: value, connectedJacks: ['VOHM', 'COM'] })
      expect(reading.status).toBe('ok')
      console.log(
        `MD03 DMM10M ${jack}: raw=${value.toFixed(9)} V, display=${reading.text} ${reading.unit}, valueSI=${reading.value}`,
      )
    }
  })

  it('shows genuine low-bias saturation clipping from collector/emitter vectors and flat output portions', () => {
    const nominal = distortion(transient({ rw: 18000, vpp: 0.1 }))
    const clipped = distortion(transient({ rw: 18000, vpp: 1, duration: 0.6 }))
    console.log(`MD03 SAT RW18000 1Vpp: ${JSON.stringify(clipped)}; nominalTHD=${nominal.thd}`)
    expect(nominal.minVce).toBeGreaterThan(0.5)
    expect(clipped.minVce).toBeLessThan(0.2)
    expect(clipped.satFraction).toBeGreaterThan(0.05)
    expect(clipped.satPlateauSpread).toBeLessThan(0.1)
    expect(clipped.thd).toBeGreaterThan(0.08)
    expect(clipped.thd / nominal.thd).toBeGreaterThan(3)
  })

  it('shows genuine high-bias-resistance cutoff clipping from near-zero collector current, not a static-zero claim', () => {
    const nominal = distortion(transient({ rw: 100000, vpp: 0.1 }))
    const clipped = distortion(transient({ rw: 100000, vpp: 2, duration: 0.6 }))
    console.log(`MD03 CUT RW100000 2Vpp: ${JSON.stringify(clipped)}; nominalTHD=${nominal.thd}`)
    expect(nominal.cutoffFraction).toBe(0)
    expect(clipped.minVbe).toBeLessThan(0.5)
    expect(clipped.cutoffFraction).toBeGreaterThan(0.05)
    expect(clipped.cutoffPlateauSpread).toBeLessThan(0.1)
    expect(clipped.thd).toBeGreaterThan(0.08)
    expect(clipped.thd / nominal.thd).toBeGreaterThan(3)
  })
})
