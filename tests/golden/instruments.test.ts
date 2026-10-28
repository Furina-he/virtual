import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AssembleInput, assembleNetlist } from '../../src/domain/circuit/assemble.ts'
import { instrumentProbe, readInstrument, resolveInstrument, rms } from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan, type MeasurementPlan } from '../../src/domain/measurement/plan.ts'
import { Instrument, Module } from '../../src/shared/schema/index.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'
import { buildNetlist } from '../../src/sim/session.ts'
import { at } from './models/helpers.ts'

const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))
const load = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))
const am = Instrument.parse(load('content/instruments/ins-dc-ammeter/instrument.json'))
const mm = Instrument.parse(load('content/instruments/ins-multimeter/instrument.json'))
const ps = Instrument.parse(load('content/instruments/ins-dc-power/instrument.json'))
const dc = Module.parse(load('content/modules/mod-dc-circuit/module.json'))
const dcSubckt = readFileSync('content/modules/mod-dc-circuit/module.cir', 'utf8')
const voltageAt = (node: string) => (node === '0' ? 0 : (ng.getVector(node)[0] as number))

function measure(input: AssembleInput, instrument: Instrument, settings: Record<string, unknown>, instance = 'meter') {
  const assembled = assembleNetlist(input)
  const config = resolveInstrument(instrument, settings)
  const probe = instrumentProbe(config, instance, assembled.nodeOf)
  ng.load(assembled.netlist)
  ng.run()
  const voltage = voltageAt(probe.positiveNode) - voltageAt(probe.negativeNode)
  const current = probe.currentVector ? (ng.getVector(probe.currentVector)[0] as number) : undefined
  return {
    assembled,
    config,
    probe,
    voltage,
    current,
    reading: readInstrument(config, { voltage, current, externalVoltage: 0 }),
  }
}

const fixture = Module.parse({
  id: 'mod-meter-fixture',
  name: 'Independent instrument test fixture',
  form: 'board',
  model: 'fixture.glb',
  netlist: 'fixture.cir',
  jacks: ['P', 'N'].map((id) => ({ id, label: id, kind: 'banana4' })),
})

function passiveFixture(range: string, device: string, settings: Record<string, unknown> = {}): AssembleInput {
  return {
    title: 'Self-powered meter golden',
    modules: [
      { instanceId: 'dut', module: fixture, subckt: `.subckt meter_fixture P N\n${device}\n.ends meter_fixture` },
    ],
    instruments: [{ instanceId: 'meter', instrument: mm, settings: { range, ...settings } }],
    wires: [
      { a: 'meter.VOHM', b: 'dut.P' },
      { a: 'meter.COM', b: 'dut.N' },
    ],
    ground: 'dut.N',
    controlValues: {},
    analysis: ['.op'],
  }
}

describe('DG-01 instrument validation on the existing DC module', () => {
  const scene = (settings: Record<string, unknown>, reverse = false): AssembleInput => ({
    title: 'DG-01 input loading validation',
    modules: [{ instanceId: 'dc1', module: dc, subckt: dcSubckt }],
    instruments: [
      { instanceId: 'source', instrument: ps, settings: { ch1_v: 6 } },
      { instanceId: 'meter', instrument: vm, settings },
    ],
    wires: [
      { a: 'source.CH1P', b: 'dc1.TH_USP' },
      { a: 'source.CH1N', b: 'dc1.TH_USN' },
      { a: 'meter.POS', b: reverse ? 'dc1.TH_B' : 'dc1.TH_A' },
      { a: 'meter.NEG', b: reverse ? 'dc1.TH_A' : 'dc1.TH_B' },
    ],
    ground: 'source.CH1N',
    controlValues: {},
    analysis: ['.op'],
  })

  it.each([1000, 10000, 10000000])('actual %i ohm meter loading agrees with Thevenin theory within 1%', (internalR) => {
    const settings = { range: 'r20', internalR }
    const result = measure(scene(settings), vm, settings)
    const openVoltage = (6 * 510) / (330.01 + 510)
    const theveninR = (330.01 * 510) / (330.01 + 510) + 10 + 510
    const expected = (openVoltage * internalR) / (theveninR + internalR)
    expect(Math.abs(result.voltage - expected) / expected).toBeLessThanOrEqual(0.01)
    expect(result.reading.text).toBe((Math.round(expected * 100) / 100).toFixed(2))
    expect(result.assembled.netlist).toContain(` ${internalR}\n`)
    console.log(
      `DG-01 Rin=${internalR} ohm: ngspice=${result.voltage.toFixed(8)} V; theory=${expected.toFixed(8)} V; display=${result.reading.text}`,
    )
  })

  it('changes sign with real reversed wires and displays OL. on the 2 V range', () => {
    const reversed = measure(scene({ range: 'r20' }, true), vm, { range: 'r20' })
    expect(reversed.voltage).toBeLessThan(-3.6)
    expect(reversed.reading).toMatchObject({ text: '-3.64', negative: true })
    const overload = measure(scene({ range: 'r2' }), vm, { range: 'r2' })
    expect(overload.voltage).toBeGreaterThan(3.6)
    expect(overload.reading).toMatchObject({ text: 'OL.', status: 'overload' })
  })
})

describe('ngspice current inputs', () => {
  it.each([
    { instrument: am, range: 'r20m' },
    { instrument: mm, range: 'dca20m' },
    { instrument: mm, range: 'dca10' },
  ])('series $range includes its actual shunt voltage drop', ({ instrument, range }) => {
    const settings = { range }
    const config = resolveInstrument(instrument, settings)
    const input: AssembleInput = {
      title: 'Series current measurement',
      modules: [
        {
          instanceId: 'dut',
          module: fixture,
          subckt: '.subckt meter_fixture P N\nRload P N 1000\n.ends meter_fixture',
        },
      ],
      instruments: [
        { instanceId: 'source', instrument: ps, settings: { ch1_v: 6 } },
        { instanceId: 'meter', instrument, settings },
      ],
      wires: [
        { a: 'source.CH1P', b: `meter.${config.positiveJack}` },
        { a: `meter.${config.negativeJack}`, b: 'dut.P' },
        { a: 'dut.N', b: 'source.CH1N' },
      ],
      ground: 'source.CH1N',
      controlValues: {},
      analysis: ['.op'],
    }
    const result = measure(input, instrument, settings)
    const expected = 6 / (1000 + 0.01 + (config.internalR as number))
    expect(Math.abs((result.current as number) - expected) / expected).toBeLessThanOrEqual(0.01)
    expect(result.voltage).toBeCloseTo((result.current as number) * (config.internalR as number), 8)
  })
})

describe('ngspice self-powered meter modes', () => {
  it.each([
    ['ohm200', 100],
    ['ohm2k', 1000],
    ['ohm20k', 10000],
    ['ohm200k', 100000],
    ['ohm2M', 1000000],
    ['ohm20M', 10000000],
  ] as const)('%s measures %i ohm from voltage/current, with no external supply', (range, resistance) => {
    const result = measure(passiveFixture(range, `Rload P N ${resistance}`), mm, { range })
    expect(result.reading.status).toBe('ok')
    expect(Math.abs((result.reading.rawValue as number) - resistance) / resistance).toBeLessThanOrEqual(0.01)
    expect(result.current).toBeGreaterThan(0)
    expect(result.current).toBeLessThanOrEqual(result.config.testSource?.current as number)
    expect(result.voltage).toBeLessThanOrEqual(result.config.testSource?.voltage as number)
  })

  it('diode forward drop agrees with the Shockley equation and reverse bias gives OL.', () => {
    const range = 'diode'
    const model = '.model dtest D(IS=1e-12 N=1)'
    const forward = measure(passiveFixture(range, `Dtest P N dtest\n${model}`), mm, { range })
    const thermalVoltage = (1.380649e-23 * 300.15) / 1.602176634e-19
    let lo = 0
    let hi = 1
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2
      const diodeCurrent = 1e-12 * Math.expm1(mid / thermalVoltage)
      const sourceCurrent = 0.001 * (1 - mid / 2.8)
      if (diodeCurrent > sourceCurrent) hi = mid
      else lo = mid
    }
    const expected = (lo + hi) / 2
    expect(Math.abs(forward.voltage - expected) / expected).toBeLessThanOrEqual(0.01)
    expect(forward.reading.status).toBe('ok')
    const reverse = measure(passiveFixture(range, `Dtest N P dtest\n${model}`), mm, { range })
    expect(reverse.reading.text).toBe('OL.')
    expect(reverse.voltage).toBeLessThanOrEqual(2.8)
  })

  it.each([10, 100])('continuity beep follows the simulated %i ohm path', (resistance) => {
    const result = measure(passiveFixture('continuity', `Rload P N ${resistance}`), mm, { range: 'continuity' })
    expect(result.reading.beep).toBe(resistance === 10)
    expect(result.reading.rawValue).toBeCloseTo(resistance, 5)
  })

  it('open test leads stay within compliance and display OL.', () => {
    const result = measure(passiveFixture('ohm200', 'Ropen P N 1T'), mm, { range: 'ohm200' })
    expect(result.voltage).toBeLessThanOrEqual(2.8)
    expect(result.voltage).toBeGreaterThan(2.79)
    expect(result.reading.text).toBe('OL.')
  })

  it.each([12, -12])(
    'preflight sees %i V with no test source; the bounded source cannot draw destructive current',
    (externalVoltage) => {
      const range = 'diode'
      const device = `Vexternal P N DC ${externalVoltage}`
      const passive = measure(passiveFixture(range, device, { passive: true }), mm, { range, passive: true })
      expect(passive.voltage).toBeCloseTo(externalVoltage, 8)
      expect(passive.current).toBeUndefined()
      expect(passive.assembled.netlist).not.toContain('Btest_meter')
      const active = measure(passiveFixture(range, device), mm, { range })
      expect(Math.abs(active.current as number)).toBeLessThanOrEqual(0.001000001)
      if (externalVoltage > 0) expect(Math.abs(active.current as number)).toBeLessThan(1e-12)
      expect(
        readInstrument(active.config, { voltage: active.voltage, current: active.current, externalVoltage }).status,
      ).toBe('external-voltage')
    },
  )
})

describe('ngspice AC readings', () => {
  it('ACV derives RMS from an actual sine transient and rejects its DC offset', () => {
    const range = 'acv20'
    const input = passiveFixture(range, 'Vsignal P N SIN(7 2 50)')
    input.analysis = ['.tran 10u 120m']
    const assembled = assembleNetlist(input)
    const config = resolveInstrument(mm, { range })
    const probe = instrumentProbe(config, 'meter', assembled.nodeOf)
    ng.load(assembled.netlist)
    ng.run()
    const times = ng.getVector('time')
    const values = ng.getVector(probe.positiveNode)
    const samples = Float64Array.from({ length: 2000 }, (_, i) => at(times, values, 0.02 + (i * 0.1) / 2000))
    const actual = rms(samples)
    expect(Math.abs(actual - Math.SQRT2) / Math.SQRT2).toBeLessThanOrEqual(0.01)
    expect(readInstrument(config, { rmsVoltage: actual })).toMatchObject({ text: '1.41', status: 'ok' })
  })

  it('ACA uses the real series current waveform, not the voltage magnitude', () => {
    const range = 'aca20m'
    const config = resolveInstrument(mm, { range })
    const input = passiveFixture(range, 'Vsignal signal N SIN(3 2 50)\nRload signal P 990')
    input.wires = [
      { a: 'meter.MA', b: 'dut.P' },
      { a: 'meter.COM', b: 'dut.N' },
    ]
    input.analysis = ['.tran 10u 120m']
    const assembled = assembleNetlist(input)
    const probe = instrumentProbe(config, 'meter', assembled.nodeOf)
    ng.load(assembled.netlist)
    ng.run()
    const times = ng.getVector('time')
    const values = ng.getVector(probe.currentVector as string)
    const samples = Float64Array.from({ length: 2000 }, (_, i) => at(times, values, 0.02 + (i * 0.1) / 2000))
    const expected = Math.SQRT2 / (990 + (config.internalR as number))
    const actual = rms(samples)
    expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(0.01)
    expect(readInstrument(config, { rmsCurrent: actual })).toMatchObject({ text: '1.41', unit: 'mA' })
  })
})

describe('measurement-plan safety flow with real ngspice', () => {
  function solvePlan(plan: MeasurementPlan): Record<string, number> {
    ng.load(buildNetlist(plan.command))
    ng.run()
    return Object.fromEntries(
      plan.command.probes.map((probe) => [
        probe.id,
        probe.kind === 'i'
          ? (ng.getVector(`${probe.source}#branch`)[0] as number)
          : voltageAt(probe.node as string) - voltageAt(probe.nodeRef as string),
      ]),
    )
  }

  const sourceFixture = (): AssembleInput => {
    const input = passiveFixture('ohm2k', 'Rload P N 1000')
    input.instruments.push({ instanceId: 'source', instrument: ps, settings: { ch1_v: 6 } })
    input.wires.push({ a: 'source.CH1P', b: 'dut.P' }, { a: 'source.CH1N', b: 'dut.N' })
    return input
  }

  it('a live voltage found in the passive phase keeps the internal test source disconnected in phase two', () => {
    const input = sourceFixture()
    const passive = buildMeasurementPlan(input, true, 'passive', { preflight: true })
    const first = solvePlan(passive)
    const meter = passive.meters[0]
    const external = first[meter?.voltageProbe as string] as number
    expect(external).toBeGreaterThan(5.99)
    const active = buildMeasurementPlan(input, true, 'active', { blockedTestIds: new Set(['meter']) })
    expect(active.assembled.netlist).not.toContain('Btest_meter')
    expect(active.meters[0]?.currentProbe).toBeUndefined()
    const second = solvePlan(active)
    const measured = second[active.meters[0]?.voltageProbe as string]
    const reading = readInstrument(resolveInstrument(mm, { range: 'ohm2k' }), {
      voltage: measured,
      externalVoltage: external,
      connectedJacks: ['VOHM', 'COM'],
    })
    expect(reading.status).toBe('external-voltage')
    expect(reading.value).toBeNull()
  })

  it('turning the external supply off opens it, then the internal battery really measures the unshorted 1k resistor', () => {
    const input = sourceFixture()
    const passive = buildMeasurementPlan(input, false, 'off-passive', { preflight: true })
    const first = solvePlan(passive)
    const external = first[passive.meters[0]?.voltageProbe as string] as number
    expect(Math.abs(external)).toBeLessThan(1e-8)
    const active = buildMeasurementPlan(input, false, 'off-active', { blockedTestIds: new Set() })
    expect(active.assembled.netlist).not.toContain('Vch1_source')
    expect(active.assembled.netlist).not.toContain('Rch1_source')
    const values = solvePlan(active)
    const meter = active.meters[0]
    const reading = readInstrument(resolveInstrument(mm, { range: 'ohm2k' }), {
      voltage: values[meter?.voltageProbe as string],
      current: values[meter?.currentProbe as string],
      externalVoltage: external,
      connectedJacks: ['VOHM', 'COM'],
    })
    expect(reading.status).toBe('ok')
    expect(Math.abs((reading.rawValue as number) - 1000) / 1000).toBeLessThanOrEqual(0.01)
    expect(reading.text).toBe('1.000')
  })

  it('selected series inputs use the ngspice source probe named by the runtime plan', () => {
    const input = sourceFixture()
    const meter = input.instruments[0]
    if (meter) meter.settings = { range: 'dca20m' }
    input.wires = [
      { a: 'source.CH1P', b: 'meter.MA' },
      { a: 'meter.COM', b: 'dut.P' },
      { a: 'dut.N', b: 'source.CH1N' },
    ]
    input.ground = 'source.CH1N'
    const plan = buildMeasurementPlan(input, true, 'series-plan')
    const values = solvePlan(plan)
    const current = values[plan.meters[0]?.currentProbe as string] as number
    expect(Math.abs(current - 6 / 1010.01) / (6 / 1010.01)).toBeLessThanOrEqual(0.01)
    expect(plan.command.probes.find((probe) => probe.id === plan.meters[0]?.currentProbe)?.source).toBe('vsense_meter')
  })

  it('disconnected and wrong-jack meters never cause nonexistent-vector requests', () => {
    const disconnected = sourceFixture()
    disconnected.wires = disconnected.wires.filter(
      (wire) => !wire.a.startsWith('meter.') && !wire.b.startsWith('meter.'),
    )
    const first = buildMeasurementPlan(disconnected, true, 'disconnected')
    expect(() => solvePlan(first)).not.toThrow()
    expect(first.meters[0]?.voltageProbe).toBeUndefined()
    const wrong = sourceFixture()
    const meter = wrong.instruments[0]
    if (meter) meter.settings = { range: 'dca20m' }
    const second = buildMeasurementPlan(wrong, true, 'wrong')
    expect(() => solvePlan(second)).not.toThrow()
    expect(second.meters[0]?.currentProbe).toBeUndefined()
    expect(second.assembled.netlist).not.toContain('Rsh_meter')
  })
})
