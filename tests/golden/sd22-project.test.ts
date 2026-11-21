import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type AssembleInput, type AssembleOutput, assembleNetlist } from '../../src/domain/circuit/assemble.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import { checkWiring } from '../../src/domain/wiring-check/index.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'
import {
  formalFullInput,
  formalScopeLoadedInput,
  formalSd22Circuit,
  formalSd22Follower,
  formalSd22FollowerCircuit,
  formalSd22FollowerPlacement,
  formalSd22Input,
  formalSd22Module,
  formalSd22Placement,
  formalSd22Project,
  formalSd22Reference,
  formalSd22Scope,
  resetFormalSd22,
  withoutFormalSd22Jack,
} from './fixtures/sd22-project.ts'

const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))
const jacks = ['VCC1', 'T1_OUT', 'T1_TH', 'T1_CV', 'T2_OUT', 'T2_TH', 'T2_CV', 'SPK_P', 'SPK_N'] as const
type Jack = (typeof jacks)[number]
type Trace = {
  time: Float64Array
  voltage: Record<Jack, Float64Array>
  follower?: { supply: Float64Array; input: Float64Array; output: Float64Array }
  capture: { step: number; stop: number; start: number; wallMs: number; points: number }
}
const ref = (jack: string) => `${formalSd22Placement.instanceId}.${jack}`
const followerRef = (jack: string) => `${formalSd22FollowerPlacement.instanceId}.${jack}`
const runStamp = new Date().toISOString().replaceAll(/[:.]/g, '-')

function capture(input: AssembleInput, step: number, stop: number, start = 0, compiled?: AssembleOutput): Trace {
  const assembled = compiled ?? assembleNetlist(input)
  const nodes = Object.fromEntries([...jacks, 'GND1'].map((jack) => [jack, assembled.nodeOf[ref(jack)] as string]))
  const followerNodes = input.modules.some((module) => module.instanceId === formalSd22FollowerPlacement.instanceId)
    ? Object.fromEntries(
        ['VCC', 'GND', 'IN', 'OUT'].map((jack) => [jack, assembled.nodeOf[followerRef(jack)] as string]),
      )
    : undefined
  const saved = [...new Set([...Object.values(nodes), ...Object.values(followerNodes ?? {})])].filter(
    (node) => node !== '0',
  )
  const started = performance.now()
  ng.load(
    [
      assembled.netlist.replace(/\.end\s*$/, ''),
      `.save ${saved.map((node) => `v(${node})`).join(' ')}`,
      `.tran ${step} ${stop} ${start} ${step}`,
      '.end',
    ].join('\n'),
  )
  // Match the runtime: do not retain millions of unused XSPICE event-history points.
  ng.command('esave none')
  ng.run()
  const time = Float64Array.from(ng.readVector('time', 0))
  const zero = new Float64Array(time.length)
  const vectors = new Map<string, Float64Array>([['0', zero]])
  const vector = (node: string) => {
    let value = vectors.get(node)
    if (!value) {
      // readVector is reused by ngspice; copy before the next solve releases its plot.
      value = Float64Array.from(ng.readVector(node, 0))
      vectors.set(node, value)
    }
    return value
  }
  const relative = (node: string, groundNode: string) => {
    if (node === groundNode) return zero
    const values = vector(node)
    if (groundNode === '0') return values
    const ground = vector(groundNode)
    return Float64Array.from(values, (value, i) => value - (ground[i] as number))
  }
  const voltage = Object.fromEntries(
    jacks.map((jack) => [jack, relative(nodes[jack] as string, nodes.GND1 as string)]),
  ) as Trace['voltage']
  return {
    time,
    voltage,
    follower: followerNodes
      ? {
          supply: relative(followerNodes.VCC as string, followerNodes.GND as string),
          input: relative(followerNodes.IN as string, followerNodes.GND as string),
          output: relative(followerNodes.OUT as string, followerNodes.GND as string),
        }
      : undefined,
    capture: { step, stop, start, wallMs: performance.now() - started, points: time.length },
  }
}

function lowerBound(time: Float64Array, value: number): number {
  let low = 0
  let high = time.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((time[mid] as number) < value) low = mid + 1
    else high = mid
  }
  return low
}

function at(trace: Trace, values: Float64Array, time: number): number {
  const next = Math.min(lowerBound(trace.time, time), trace.time.length - 1)
  if (!next) return values[0] as number
  const previous = next - 1
  const t0 = trace.time[previous] as number
  const t1 = trace.time[next] as number
  const fraction = t1 === t0 ? 1 : (time - t0) / (t1 - t0)
  return (values[previous] as number) + fraction * ((values[next] as number) - (values[previous] as number))
}

function edges(trace: Trace, jack: Jack, level: number, from: number, to: number): number[] {
  const { time, voltage } = trace
  const v = voltage[jack]
  const result: number[] = []
  for (let i = Math.max(1, lowerBound(time, from)); i < Math.min(time.length, lowerBound(time, to) + 1); i++) {
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
  for (let i = lowerBound(trace.time, from); i < Math.min(trace.time.length, lowerBound(trace.time, to) + 1); i++) {
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

function scopeLoadedLowFrequencyTheory(supply: number): { high: number; low: number; frequency: number } {
  const ra = 10e3
  const rb = 150e3
  const scopeR = 1e6
  const capacitance = 4.7e-6 + 20e-12
  const lowThreshold = supply / 3
  const highThreshold = (2 * supply) / 3
  const chargeFinal = (supply * scopeR) / (ra + rb + scopeR)
  const chargeR = 1 / (1 / (ra + rb) + 1 / scopeR)
  const high = chargeR * capacitance * Math.log((chargeFinal - lowThreshold) / (chargeFinal - highThreshold))
  const dischargeVoltage = (supply * 10) / (ra + 10)
  const dischargePath = rb + 1 / (1 / ra + 1 / 10)
  const dischargeFinal = (dischargeVoltage * scopeR) / (dischargePath + scopeR)
  const dischargeR = 1 / (1 / dischargePath + 1 / scopeR)
  const low = dischargeR * capacitance * Math.log((highThreshold - dischargeFinal) / (lowThreshold - dischargeFinal))
  return { high, low, frequency: 1 / (high + low) }
}

type CarrierCycle = { time: number; frequency: number; control: number; expected: number; relativeError: number }

function carrierCycles(trace: Trace, from: number, to: number, excludeSwitching = false): CarrierCycle[] {
  const rises = edges(trace, 'T2_OUT', 1.65, from, to)
  const cycles: CarrierCycle[] = []
  let settlingCycles = 0
  for (let i = 1; i < rises.length; i++) {
    const start = rises[i - 1] as number
    const end = rises[i] as number
    const before = at(trace, trace.voltage.T2_CV, start)
    const after = at(trace, trace.voltage.T2_CV, end)
    if (excludeSwitching && Math.abs(after - before) > 0.001) {
      settlingCycles = 2
      continue
    }
    if (settlingCycles > 0) {
      settlingCycles--
      continue
    }
    const time = (start + end) / 2
    const control = at(trace, trace.voltage.T2_CV, time)
    const frequency = 1 / (end - start)
    const expected = carrierTheory(at(trace, trace.voltage.VCC1, time), control)
    cycles.push({ time, frequency, control, expected, relativeError: Math.abs(frequency - expected) / expected })
  }
  return cycles
}

function saveNaturalDiagnostic(
  mode: 'ambulance' | 'fire-buffered' | 'ambulance-loaded' | 'fire-buffered-loaded',
  trace: Trace,
  details: Record<string, unknown> = {},
): void {
  const cycles = carrierCycles(trace, 1.4, trace.capture.stop, mode.startsWith('ambulance'))
  const lowRises = edges(trace, 'T1_OUT', 1.65, 0.8, trace.capture.stop)
  const sourceFiles = [
    'content/modules/mod-555-app/module.cir',
    'content/modules/mod-voltage-follower/module.cir',
    'content/models/spice/timers.lib',
    'content/models/spice/opamp.lib',
    ...(mode.endsWith('-loaded') ? ['content/instruments/ins-oscilloscope/instrument.json'] : []),
  ]
  const root = resolve(import.meta.dirname, '../..')
  const build = resolve(root, 'build')
  mkdirSync(build, { recursive: true })
  const path = resolve(build, `sd22-buffered-${mode}-${runStamp}.json`)
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        mode,
        details,
        capture: trace.capture,
        note: 'Actual synchronous ngspice facts; not application realtime/audio acceptance or pre-recorded input.',
        sources: Object.fromEntries(
          sourceFiles.map((file) => [
            file,
            createHash('sha256')
              .update(readFileSync(resolve(root, file)))
              .digest('hex'),
          ]),
        ),
        lowFrequencyRises: lowRises,
        lowFrequencyHz: (lowRises.length - 1) / ((lowRises.at(-1) as number) - (lowRises[0] as number)),
        capacitorRange: range(trace, 'T1_TH', 1.4, trace.capture.stop),
        controlRange: range(trace, 'T2_CV', 1.4, trace.capture.stop),
        speakerMeanPowerW: speakerPower(trace),
        carrierCycles: cycles.length,
        carrierRangeHz: [
          Math.min(...cycles.map((cycle) => cycle.frequency)),
          Math.max(...cycles.map((cycle) => cycle.frequency)),
        ],
        maximumCarrierRelativeError: Math.max(...cycles.map((cycle) => cycle.relativeError)),
        trajectory: cycles.filter((_, i) => i % Math.max(1, Math.floor(cycles.length / 160)) === 0),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`Formal natural ${mode} diagnostic: ${path}; wall=${trace.capture.wallMs.toFixed(0)} ms`)
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
    expect(formalSd22Module.simulation).toMatchObject({ analysis: 'tran', pacing: 'realtime' })
    expect(formalSd22Module.simulation?.maxStep).toBeLessThanOrEqual(20e-6)
    expect(formalSd22Module.indicators).toContainEqual({
      id: 'LS1',
      kind: 'speaker',
      between: ['SPK_P', 'SPK_N'],
      audio: { fullScale: 5 },
    })
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
      return { measured, control }
    })
    expect(carriers[0]?.control).toBeCloseTo(3.325, 2)
    expect(carriers[1]?.control).toBeCloseTo(2.5006, 2)
    expect((carriers[1]?.measured as number) / (carriers[0]?.measured as number)).toBeGreaterThan(1.3)
    // The long natural trace reaches both of those CV states, not only reset diagnostics.
    expect(range(alternating, 'T2_CV', 1, 4)[0]).toBeCloseTo(carriers[1]?.control as number, 2)
    expect(range(alternating, 'T2_CV', 1, 4)[1]).toBeCloseTo(carriers[0]?.control as number, 2)
    // This historical coarse trace verifies continuity/order, not 1% carrier accuracy.
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

  it('keeps both loaded carrier plateaus within 1% at both 2 us and the 20 us adaptive maximum-step ceiling', () => {
    for (const step of [2e-6, formalSd22Module.simulation?.maxStep ?? 20e-6]) {
      for (const input of [formalSd22Input(), resetFormalSd22(formalSd22Input(), 'T1')]) {
        const trace = capture(input, step, 0.04, 0.01)
        const measured = frequency(trace, 'T2_OUT', 1.65, 0.01, 0.04)
        const expected = carrierTheory(mean(trace, 'VCC1'), mean(trace, 'T2_CV'))
        expect(Math.abs(measured - expected) / expected).toBeLessThanOrEqual(0.01)
      }
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
    const modes = ['ambulance', 'fire-prototype'] as const
    for (const actual of modes)
      for (const expected of modes)
        expect(
          checkWiring(formalSd22Input(actual), { ...formalSd22Reference(expected), measurePoints: [] }).circuitOk,
        ).toBe(actual === expected)
    const ambulance = formalSd22Input()
    const mixed = { ...ambulance, wires: [...ambulance.wires, { a: ref('T1_TH'), b: ref('R5_1') }] }
    for (const mode of modes) {
      expect(checkWiring(mixed, { ...formalSd22Reference(mode), measurePoints: [] }).circuitOk).toBe(false)
    }
  })
})

// A separate offline budget does not relax the original 20 s hook or any realtime gate.
describe('Offline full-project natural ambulance accuracy (not realtime acceptance)', () => {
  it('measures both natural carrier states in one unchanged 2 us / 4.1 s circuit within 1% of theory', () => {
    const natural = capture(formalFullInput('ambulance'), 2e-6, 4.1, 0.8)
    saveNaturalDiagnostic('ambulance', natural)
    expect(natural.capture.step).toBeLessThanOrEqual(2e-6)
    const cycles = carrierCycles(natural, 1.4, 4.1, true)
    expect(cycles.length).toBeGreaterThan(2000)
    expect(Math.max(...cycles.map((cycle) => cycle.relativeError))).toBeLessThanOrEqual(0.01)
    const lowControl = cycles.filter((cycle) => cycle.control < 2.6)
    const highControl = cycles.filter((cycle) => cycle.control > 3.3)
    for (const group of [lowControl, highControl]) expect(group.length).toBeGreaterThan(500)
    const average = (group: CarrierCycle[]) => group.reduce((sum, cycle) => sum + cycle.frequency, 0) / group.length
    expect(average(lowControl) / average(highControl)).toBeGreaterThan(1.3)
    const lowFrequency = frequency(natural, 'T1_OUT', 1.65, 0.8, 4.1)
    const expected = 1.44 / ((10e3 + 2 * 150e3) * 4.7e-6)
    expect(Math.abs(lowFrequency - expected) / expected).toBeLessThanOrEqual(0.01)
    expect(speakerPower(natural)).toBeLessThan(0.5)
    console.log(
      `Offline natural ambulance LF=${lowFrequency} Hz, two carriers=${average(highControl)}/${average(lowControl)} Hz`,
    )
  }, 60_000)
})

describe('Approved buffered SD-22 fire circuit (both real NE555 units and actual speaker)', () => {
  let natural: Trace
  let trajectory: CarrierCycle[]

  beforeAll(() => {
    natural = capture(formalFullInput('fire-buffered'), 2e-6, 4.1, 0.8)
    trajectory = carrierCycles(natural, 1.4, 4.1)
    saveNaturalDiagnostic('fire-buffered', natural)
  }, 60_000)

  it('uses the approved separate four-jack feedback adapter and the actual complete step topology', () => {
    expect(formalSd22FollowerPlacement.instanceId).toBe('follower1')
    expect(formalSd22Follower.jacks.map((jack) => jack.id)).toEqual(['VCC', 'GND', 'IN', 'OUT'])
    expect(formalSd22FollowerCircuit).toContain('XBUF OUT GND IN OUT VCC TLV9001_EST')
    expect(formalSd22FollowerCircuit).toContain('Cdecouple VCC GND 100n')
    expect(formalSd22FollowerCircuit).toContain('.include "opamp.lib"')
    const input = formalFullInput('fire-buffered')
    const assembled = assembleNetlist(input)
    for (const [timer, follower] of [
      ['VCC1', 'VCC'],
      ['GND1', 'GND'],
      ['T1_TH', 'IN'],
      ['R5_1', 'OUT'],
    ])
      expect(assembled.nodeOf[ref(timer as string)]).toBe(assembled.nodeOf[followerRef(follower as string)])
    expect(assembled.nodeOf[ref('R5_1')]).not.toBe(assembled.nodeOf[ref('T1_OUT')])
    expect(assembled.nodeOf[ref('R5_1')]).not.toBe(assembled.nodeOf[ref('T1_TH')])
    expect(assembled.nodeOf[ref('R5_2')]).toBe(assembled.nodeOf[ref('T2_CV')])
    expect(assembled.nodeOf[ref('T2_CC_1')]).toBe(assembled.nodeOf[ref('T2_CV')])
    expect(assembled.netlist.match(/^\.subckt NE555\b/gm)).toHaveLength(1)
    expect(assembled.netlist.match(/^\.subckt TLV9001_EST\b/gm)).toHaveLength(1)
    expect(assembled.netlist).not.toMatch(/^\s*\.include\b/m)
    const step = formalSd22Project.steps.find((entry) => entry.id === 'wire-fire-buffered')
    expect(formalSd22Reference('fire-buffered').nets).toEqual(step?.referenceNets)
  })

  it('accepts only the selected complete full-project mode and rejects simultaneous modulation sources', () => {
    const modes = ['ambulance', 'fire-buffered', 'fire-prototype'] as const
    for (const actual of modes)
      for (const expected of modes)
        expect(
          checkWiring(formalFullInput(actual), { ...formalSd22Reference(expected), measurePoints: [] }).circuitOk,
        ).toBe(actual === expected)
    const buffered = formalFullInput('fire-buffered')
    const mixed = { ...buffered, wires: [...buffered.wires, { a: ref('T1_OUT'), b: ref('R5_1') }] }
    for (const mode of modes)
      expect(checkWiring(mixed, { ...formalSd22Reference(mode), measurePoints: [] }).circuitOk).toBe(false)
  })

  it('keeps the original 0.99 Hz oscillator charging through both thresholds with the CV divider load attached', () => {
    expect(natural.capture.step).toBeLessThanOrEqual(2e-6)
    expect(natural.capture.stop).toBeGreaterThanOrEqual(4)
    const measured = frequency(natural, 'T1_OUT', 1.65, 0.8, 4.1)
    const expected = 1.44 / ((10e3 + 2 * 150e3) * 4.7e-6)
    expect(Math.abs(measured - expected) / expected).toBeLessThanOrEqual(0.01)
    const [min, max] = range(natural, 'T1_TH', 1.4, 4.1)
    expect(Math.abs(min - 5 / 3) / (5 / 3)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(max - 10 / 3) / (10 / 3)).toBeLessThanOrEqual(0.01)
    console.log(`Approved natural fire LF=${measured.toFixed(6)} Hz, C1=${min.toFixed(6)}..${max.toFixed(6)} V`)
  })

  it('follows the real capacitor voltage without loading it and preserves the original gradual 2.917..3.333 V control', () => {
    const follower = natural.follower
    if (!follower) throw new Error('Approved adapter was not part of the natural circuit')
    let trackingError = 0
    let controlError = 0
    const occupied = new Set<number>()
    const [min, max] = range(natural, 'T2_CV', 1.4, 4.1)
    for (let i = lowerBound(natural.time, 1.4); i < natural.time.length; i++) {
      trackingError = Math.max(
        trackingError,
        Math.abs((follower.output[i] as number) - (natural.voltage.T1_TH[i] as number)),
      )
      controlError = Math.max(
        controlError,
        Math.abs(
          (natural.voltage.T2_CV[i] as number) -
            ((natural.voltage.VCC1[i] as number) / 2 + (follower.output[i] as number) / 4),
        ),
      )
      occupied.add(Math.floor(((natural.voltage.T2_CV[i] as number) - min) / 0.02))
    }
    expect(trackingError).toBeLessThan(0.002)
    expect(controlError).toBeLessThan(0.002)
    expect(Math.abs(min - 35 / 12) / (35 / 12)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(max - 10 / 3) / (10 / 3)).toBeLessThanOrEqual(0.01)
    expect(max - min).toBeGreaterThan(0.4)
    expect(occupied.size).toBeGreaterThanOrEqual(20)
    console.log(`Approved natural fire CV=${min.toFixed(6)}..${max.toFixed(6)} V; buffer error=${trackingError} V`)
  })

  it("measures every natural carrier period against that period's actual CV and independent RC theory within 1%", () => {
    expect(trajectory.length).toBeGreaterThan(2500)
    expect(Math.max(...trajectory.map((cycle) => cycle.relativeError))).toBeLessThanOrEqual(0.01)
    const lowControl = trajectory.filter((cycle) => cycle.control < 3)
    const highControl = trajectory.filter((cycle) => cycle.control > 3.27)
    expect(lowControl.length).toBeGreaterThan(100)
    expect(highControl.length).toBeGreaterThan(100)
    const average = (cycles: CarrierCycle[]) => cycles.reduce((sum, cycle) => sum + cycle.frequency, 0) / cycles.length
    expect(average(lowControl)).toBeGreaterThan(average(highControl) * 1.1)
    for (const [low, high] of [
      [1020, 1060],
      [1090, 1140],
      [1170, 1230],
    ])
      expect(
        trajectory.some((cycle) => cycle.frequency >= (low as number) && cycle.frequency <= (high as number)),
      ).toBe(true)
    console.log(
      `Approved natural fire carrier=${Math.min(...trajectory.map((cycle) => cycle.frequency)).toFixed(3)}..${Math.max(...trajectory.map((cycle) => cycle.frequency)).toFixed(3)} Hz; max theory error=${Math.max(...trajectory.map((cycle) => cycle.relativeError))}`,
    )
  })

  it('supplies both boards from the same real 5 V/GND and drives the original differential 8 ohm speaker below 0.5 W', () => {
    const follower = natural.follower
    if (!follower) throw new Error('Approved adapter was not part of the natural circuit')
    const supply = mean(natural, 'VCC1')
    expect(Math.abs(supply - 5) / 5).toBeLessThanOrEqual(0.01)
    let supplyError = 0
    for (let i = 0; i < natural.time.length; i++)
      supplyError = Math.max(
        supplyError,
        Math.abs((follower.supply[i] as number) - (natural.voltage.VCC1[i] as number)),
      )
    expect(supplyError).toBeLessThan(1e-6)
    const power = speakerPower(natural)
    expect(power).toBeGreaterThan(0.04)
    expect(power).toBeLessThan(0.5)
    const [min, max] = range(natural, 'SPK_P', 1.4, 4.1)
    expect(min).toBeLessThan(0)
    expect(max).toBeGreaterThan(0)
    expect(max - min).toBeLessThan(3.3)
    console.log(`Approved natural fire speaker power=${power.toFixed(6)} W, Vpp=${(max - min).toFixed(6)} V`)
  })

  it('keeps intrinsic oscillation and speaker pacing real-time even without a connected scope', () => {
    const input = formalFullInput('fire-buffered')
    const plan = buildMeasurementPlan(input, true, 'fire-golden')
    expect(plan.command.analysis.kind).toBe('tran')
    if (plan.command.analysis.kind === 'tran') expect(plan.command.analysis.step).toBeLessThanOrEqual(20e-6)
    expect(plan.pacing).toEqual({ type: 'setPacing', mode: 'realtime' })
    expect(plan.command.probes).toContainEqual({
      id: 'indicator:timer1:LS1',
      kind: 'v',
      node: plan.assembled.nodeOf[ref('SPK_P')],
      nodeRef: plan.assembled.nodeOf[ref('SPK_N')],
    })
  })

  it('stops gradual modulation under a real IC1 reset and stops sound voltage under IC2 reset', () => {
    const lowReset = capture(resetFormalSd22(formalFullInput('fire-buffered'), 'T1'), 2e-6, 0.04, 0.01)
    expect(range(lowReset, 'T1_OUT', 0.01, 0.04)[1]).toBeLessThan(0.1)
    const [cvMin, cvMax] = range(lowReset, 'T2_CV', 0.01, 0.04)
    expect(cvMax - cvMin).toBeLessThan(0.001)
    const highReset = capture(resetFormalSd22(formalFullInput('fire-buffered'), 'T2'), 2e-6, 0.04, 0.01)
    expect(range(highReset, 'T2_OUT', 0.01, 0.04)[1]).toBeLessThan(0.1)
    expect(speakerPower(highReset)).toBeLessThan(1e-6)
  })

  it('has no active timer/audio output after the common application supply is disconnected', () => {
    const input = formalFullInput('fire-buffered')
    const passive = {
      ...input,
      instruments: input.instruments.map((entry) => ({
        ...entry,
        instrument: { ...entry.instrument, spiceTemplate: '* supply disconnected' },
      })),
    }
    const off = capture(passive, 2e-6, 0.04, 0.01)
    for (const jack of ['T1_OUT', 'T2_OUT', 'VCC1'] as const) {
      const [min, max] = range(off, jack, 0.01, 0.04)
      expect(Math.max(Math.abs(min), Math.abs(max))).toBeLessThan(0.1)
    }
    expect(speakerPower(off)).toBeLessThan(1e-6)
  })
})

describe('Offline actual scope-loaded SD-22 low-frequency measurement (not realtime acceptance)', () => {
  it.each(['ambulance', 'fire-buffered'] as const)(
    '%s uses the actual two-channel instrument template and stays within 1% of loaded RC theory',
    (mode) => {
      const input = formalScopeLoadedInput(mode)
      const plan = buildMeasurementPlan(input, true, `loaded-${mode}`)
      expect(formalSd22Scope.spiceTemplate).toContain('Rin2_{X} {J:CH2} {J:GND} 1Meg')
      expect(formalSd22Scope.spiceTemplate).toContain('Cin2_{X} {J:CH2} {J:GND} 20p')
      expect(plan.command.netlist).toContain('Rin2_scope1')
      expect(plan.command.netlist).toContain('Cin2_scope1')
      expect(plan.pacing).toEqual({ type: 'setPacing', mode: 'realtime' })
      expect(plan.command.analysis.kind).toBe('tran')
      if (plan.command.analysis.kind !== 'tran')
        throw new Error('Actual scope measurement did not select transient analysis')
      expect(plan.command.analysis.step).toBeLessThanOrEqual(20e-6)
      expect(plan.command.probes).toContainEqual({
        id: 'scope:scope1:CH2',
        kind: 'v',
        node: plan.assembled.nodeOf[ref('T1_TH')],
        nodeRef: plan.assembled.nodeOf[ref('GND1')],
      })
      const natural = capture(input, plan.command.analysis.step, 4.5, 0.8, plan.assembled)
      const actual = frequency(natural, 'T1_OUT', 1.65, 0.8, 4.5)
      const expected = scopeLoadedLowFrequencyTheory(mean(natural, 'VCC1'))
      saveNaturalDiagnostic(mode === 'ambulance' ? 'ambulance-loaded' : 'fire-buffered-loaded', natural, {
        scope: 'scope1',
        channels: { CH1: ref('T1_OUT'), CH2: ref('T1_TH'), GND: ref('GND1') },
        actualLowFrequencyHz: actual,
        independentLoadedTheory: expected,
        inputResistanceOhms: 1e6,
        parallelInputCapacitanceF: 20e-12,
      })
      expect(Math.abs(actual - expected.frequency) / expected.frequency).toBeLessThanOrEqual(0.01)
      const cycles = carrierCycles(natural, 1.4, 4.5, mode === 'ambulance')
      expect(cycles.length).toBeGreaterThan(2000)
      expect(Math.max(...cycles.map((cycle) => cycle.relativeError))).toBeLessThanOrEqual(0.01)
      const [min, max] = range(natural, 'T1_TH', 1.4, 4.5)
      expect(Math.abs(min - 5 / 3) / (5 / 3)).toBeLessThanOrEqual(0.01)
      expect(Math.abs(max - 10 / 3) / (10 / 3)).toBeLessThanOrEqual(0.01)
      console.log(
        `Actual ${mode} scope-loaded LF=${actual.toFixed(9)} Hz, loaded theory=${expected.frequency.toFixed(9)} Hz, wall=${natural.capture.wallMs.toFixed(0)} ms`,
      )
    },
    90_000,
  )
})

// The approved adapter does not retroactively make the original direct-CV connection work.
describe('Original unbuffered fire-prototype defect (retained historical circuit)', () => {
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
    console.log(
      `Original unbuffered fire prototype: C1=${capacitor.toFixed(9)} V, CV=${cvMin.toFixed(9)} V, no LF edges`,
    )
  })
})
