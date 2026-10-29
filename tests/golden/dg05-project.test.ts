import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AssembleInput, type AssembleOutput, assembleNetlist } from '../../src/domain/circuit/assemble.ts'
import {
  getInstrumentDefaults,
  instrumentProbe,
  readInstrument,
  resolveInstrument,
} from '../../src/domain/instruments/index.ts'
import { checkWiring } from '../../src/domain/wiring-check/index.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'

const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))
const load = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const project = Project.parse(load('content/projects/DG-05/project.json'))
const placement = project.modules[0] as Project['modules'][number]
const moduleRoot = `content/modules/${placement.moduleId}`
const module = Module.parse(load(`${moduleRoot}/module.json`))
const subckt = readFileSync(`${moduleRoot}/${module.netlist}`, 'utf8')
const ps = Instrument.parse(load('content/instruments/ins-dc-power/instrument.json'))
const am = Instrument.parse(load('content/instruments/ins-dc-ammeter/instrument.json'))
const vm = Instrument.parse(load('content/instruments/ins-dc-voltmeter/instrument.json'))

type MeterCase = { id: string; instrument: Instrument; range: string; branch: number; text: string }
const currents: MeterCase[] = [
  { id: 'i1', instrument: am, range: 'r20m', branch: 0, text: '1.91' },
  { id: 'i2', instrument: am, range: 'r20m', branch: 1, text: '-5.95' },
  { id: 'i3', instrument: am, range: 'r20m', branch: 2, text: '7.84' },
]
const voltages: MeterCase[] = [
  { id: 'u-fa', instrument: vm, range: 'r2', branch: 0, text: '0.982' },
  { id: 'u-ad', instrument: vm, range: 'r20', branch: 2, text: '4.04' },
  { id: 'u-de', instrument: vm, range: 'r2', branch: 3, text: '0.982' },
]

function point(id: string) {
  const found = project.reference.measurePoints.find((entry) => entry.id === id)
  if (!found) throw new Error(`Missing DG-05 measurement point ${id}`)
  return found
}

function inputFor(test: MeterCase, reverse = false): AssembleInput {
  const p = point(test.id)
  const pair = p.branch ?? p.between
  if (!pair) throw new Error(`Missing DG-05 measurement pair ${test.id}`)
  return {
    title: `${project.id} single-meter ${test.id}`,
    modules: [{ instanceId: placement.instanceId, module, subckt }],
    instruments: [
      { instanceId: ps.id, instrument: ps, settings: getInstrumentDefaults(ps) },
      {
        instanceId: test.instrument.id,
        instrument: test.instrument,
        settings: { range: test.range, ...(test.instrument.kind === 'dcv' ? { internalR: 10_000_000 } : {}) },
      },
    ],
    wires: [
      ...project.reference.nets.flatMap((net) => net.slice(1).map((b) => ({ a: net[0] as string, b }))),
      { a: `${test.instrument.id}.POS`, b: pair[reverse ? 1 : 0] },
      { a: `${test.instrument.id}.NEG`, b: pair[reverse ? 0 : 1] },
    ],
    controlValues: Object.fromEntries(
      module.controls.map((control) => [`${placement.instanceId}.${control.id}`, control.default]),
    ),
    ground: `${placement.instanceId}.KH_E`,
    analysis: ['.op'],
  }
}

function voltageAt(node: string): number {
  return node === '0' ? 0 : (ng.getVector(node)[0] as number)
}

function jackVoltage(assembled: AssembleOutput, jack: string): number {
  const node = assembled.nodeOf[`${placement.instanceId}.${jack}`]
  if (!node) throw new Error(`Missing assembled jack ${jack}`)
  return voltageAt(node)
}

function measure(test: MeterCase, reverse = false) {
  const input = inputFor(test, reverse)
  const assembled = assembleNetlist(input)
  const meter = input.instruments[1] as AssembleInput['instruments'][number]
  const config = resolveInstrument(meter.instrument, meter.settings)
  const probe = instrumentProbe(config, meter.instanceId, assembled.nodeOf)
  ng.load(assembled.netlist)
  ng.run()
  const voltage = voltageAt(probe.positiveNode) - voltageAt(probe.negativeNode)
  const current = probe.currentVector ? (ng.getVector(probe.currentVector)[0] as number) : undefined
  return {
    input,
    assembled,
    config,
    voltage,
    current,
    reading: readInstrument(config, { voltage, current, connectedJacks: ['POS', 'NEG'] }),
  }
}

// Independent loop equations; copper links of 1 micro-ohm have negligible effect at the 1% limit.
function theory(test: MeterCase, meterR: number) {
  const resistance = [510, 1000, 510, 510, 330.001]
  const selected = resistance[test.branch] as number
  resistance[test.branch] = test.instrument.kind === 'dca' ? selected + meterR : 1 / (1 / selected + 1 / meterR)
  const [r1, r2, r3, r4, r5] = resistance as [number, number, number, number, number]
  const sourceR = (ps.ranges[0]?.internalR as number) + 0.001
  const defaults = getInstrumentDefaults(ps)
  const u1 = defaults.ch1_v as number
  const u2 = defaults.ch2_v as number
  const a = r1 + sourceR + r4 + r3
  const b = -r3
  const c = r3
  const d = -(r2 + sourceR + r5 + r3)
  const determinant = a * d - b * c
  const i1 = (u1 * d - b * u2) / determinant
  const i2 = (a * u2 - c * u1) / determinant
  const i3 = i1 - i2
  return { currents: [i1, i2, i3], voltages: [i1 * r1, i2 * r2, i3 * r3, i1 * r4] }
}

describe('DG-05 single-fixed-meter teaching project', () => {
  it('binds the six SI columns and sequential steps to declared DC measurement points', () => {
    expect(project.allowedInstruments).toEqual([])
    expect(getInstrumentDefaults(ps)).toMatchObject({ ch1_v: 6, ch2_v: 12 })
    const table = project.dataTables.find((entry) => entry.id === 'kirchhoff')
    expect(table?.rows).toBe(1)
    expect(table?.columns.map((column) => [column.id, column.unit, column.measurePoint])).toEqual([
      ['i1', 'A', 'i1'],
      ['i2', 'A', 'i2'],
      ['i3', 'A', 'i3'],
      ['u-fa', 'V', 'u-fa'],
      ['u-ad', 'V', 'u-ad'],
      ['u-de', 'V', 'u-de'],
    ])
    for (const test of [...currents, ...voltages]) {
      expect(point(test.id).mode).toBe(test.instrument.kind === 'dca' ? 'dca' : 'dcv')
      expect(project.steps.find((step) => step.id === test.id)?.measurePoints).toEqual([test.id])
    }
    expect(project.steps.find((step) => step.id === 'wire')).toMatchObject({ measurePoints: [], checkWiring: true })
    expect(project.steps.at(-1)).toMatchObject({ id: 'analyse', measurePoints: [], recordTable: 'kirchhoff' })
  })

  it.each(currents)('measures $id through the one actual 20mA meter within 1% of independent theory', (test) => {
    const result = measure(test)
    const expected = theory(test, result.config.internalR as number).currents[test.branch] as number
    expect(result.config.internalR).toBe(10)
    expect(Math.abs((result.current as number) - expected) / Math.abs(expected)).toBeLessThanOrEqual(0.01)
    expect(result.reading).toMatchObject({ status: 'ok', text: test.text, unit: 'mA' })
    expect(result.input.instruments.filter((entry) => entry.instrument.kind === 'dca')).toHaveLength(1)
    const i1 = (jackVoltage(result.assembled, 'KH_F') - jackVoltage(result.assembled, 'KH_I1A')) / 510
    const i2 = (jackVoltage(result.assembled, 'KH_I2B') - jackVoltage(result.assembled, 'KH_B')) / 1000
    const i3 = (jackVoltage(result.assembled, 'KH_I3B') - jackVoltage(result.assembled, 'KH_D')) / 510
    expect(Math.abs(i1 - i2 - i3)).toBeLessThan(1e-8)
    const check = checkWiring(result.input, { ...project.reference, measurePoints: [point(test.id)] })
    expect(check).toMatchObject({ circuitOk: true, measurementsOk: true })
  })

  it.each(voltages)('measures $id with its specified range and 10M input within 1% of theory', (test) => {
    const result = measure(test)
    const expected = theory(test, result.config.internalR as number).voltages[test.branch] as number
    expect(result.config.internalR).toBe(10_000_000)
    expect(Math.abs(result.voltage - expected) / Math.abs(expected)).toBeLessThanOrEqual(0.01)
    expect(result.reading).toMatchObject({ status: 'ok', text: test.text, unit: 'V' })
    expect(result.input.instruments.some((entry) => entry.instrument.kind === 'dca')).toBe(false)
    const f = jackVoltage(result.assembled, 'KH_F')
    const a = jackVoltage(result.assembled, 'KH_A')
    const d = jackVoltage(result.assembled, 'KH_D')
    const e = jackVoltage(result.assembled, 'KH_E')
    expect(Math.abs(f - a + (a - d) + (d - e) - (f - e))).toBeLessThan(1e-9)
    expect(Math.abs(f - e - 6) / 6).toBeLessThanOrEqual(0.01)
    expect(checkWiring(result.input, { ...project.reference, measurePoints: [point(test.id)] })).toMatchObject({
      circuitOk: true,
      measurementsOk: true,
    })
  })

  it('preserves the negative I2 reading and a nonzero mixed-state recorded KCL residual', () => {
    const values = currents.map((test) => measure(test).reading.value as number)
    const expected = [0.00191, -0.00595, 0.00784]
    values.forEach((value, i) => {
      expect(value).toBeCloseTo(expected[i] as number, 12)
    })
    const residual = (values[0] as number) - (values[1] as number) - (values[2] as number)
    expect(residual).toBeCloseTo(0.00002, 12)
    expect(residual).toBeGreaterThan(0)
    const reversed = measure(currents[1] as MeterCase, true)
    expect(reversed.reading).toMatchObject({ text: '5.95', negative: false })
  })

  it('records real rounded voltages rather than correcting their sum to the known source setting', () => {
    const values = voltages.map((test) => measure(test).reading.value as number)
    expect(values).toEqual([0.982, 4.04, 0.982])
    const sum = values.reduce((total, value) => total + value, 0)
    expect(sum).toBeCloseTo(6.004, 12)
    expect(sum - 6).toBeCloseTo(0.004, 12)
  })

  it('ships a six-section guide and original local schematic with the actual upper jack IDs', () => {
    const guide = readFileSync('content/projects/DG-05/guide.md', 'utf8')
    const svg = readFileSync('content/projects/DG-05/schematic.svg', 'utf8')
    expect(guide.match(/^## /gm)).toHaveLength(6)
    expect(guide).toContain('0.02 mA')
    expect(guide).toContain('6.004 V')
    expect(svg).toContain('Original code-native teaching schematic')
    expect(svg).not.toMatch(/<script|<image|foreignObject|https:\/\//i)
    for (const jack of module.jacks.filter((entry) => entry.id.startsWith('KH_'))) {
      expect(svg).toContain(`id="JACK_${jack.id}"`)
      expect(svg).toContain(`data-jack="${placement.instanceId}.${jack.id}"`)
    }
  })
})
