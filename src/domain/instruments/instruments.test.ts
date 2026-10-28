import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument } from '../../shared/schema/instrument.ts'
import { type AssembleInput, assembleNetlist } from '../circuit/assemble.ts'
import { AssembleError } from '../circuit/errors.ts'
import { detectDanger } from '../wiring-check/index.ts'
import {
  accuracyBound,
  activeInstrumentDefinition,
  checkInstrumentJacks,
  getInstrumentDefaults,
  getRangeSettings,
  InstrumentConfigurationError,
  instrumentProbe,
  instrumentTemplate,
  isCurrentMode,
  isMeasurementInstrument,
  isSelfPoweredMode,
  readInstrument,
  resolveInstrument,
  rms,
} from './index.ts'

const load = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))
const vm = load('ins-dc-voltmeter')
const am = load('ins-dc-ammeter')
const mm = load('ins-multimeter')
const ps = load('ins-dc-power')
const config = (range: string, settings: Record<string, unknown> = {}) => resolveInstrument(mm, { range, ...settings })

describe('instrument content and configuration', () => {
  it('uses content-owned defaults rather than the first range or an instrument ID branch', () => {
    expect(getInstrumentDefaults(vm).range).toBe('r20')
    expect(getInstrumentDefaults(am).range).toBe('r200m')
    expect(getInstrumentDefaults(mm).range).toBe('dcv20')
    expect(getInstrumentDefaults(ps)).toEqual({ range: 'out30', ch1_v: 6, ch2_v: 12 })
    const renamed = { ...vm, id: 'ins-another', ranges: [...vm.ranges].reverse() }
    expect(resolveInstrument(renamed).range.id).toBe('r20')
    expect(resolveInstrument(renamed).internalR).toBe(1e7)
  })

  it('covers the seven required multimeter modes and all prototype ranges', () => {
    expect(new Set(mm.ranges.map((range) => range.mode))).toEqual(
      new Set(['dcv', 'acv', 'dca', 'aca', 'ohm', 'diode', 'continuity']),
    )
    expect(mm.ranges).toHaveLength(25)
    for (const range of mm.ranges) {
      const resolved = resolveInstrument(mm, { range: range.id })
      expect(resolved.fullScale).toBe(range.full)
      expect(resolved.internalR).toBeGreaterThan(0)
      expect(resolved.negativeJack).toBe('COM')
      expect(instrumentTemplate(resolved)).not.toContain('undefined')
    }
  })

  it('keeps current and voltage full scale/resolution in SI, with a separate display scale', () => {
    expect(config('dca2m')).toMatchObject({
      fullScale: 0.002,
      resolution: 1e-6,
      displayScale: 0.001,
      unit: 'mA',
      internalR: 100,
    })
    expect(config('dcv200m')).toMatchObject({ fullScale: 0.2, resolution: 0.0001, displayScale: 0.001, unit: 'mV' })
    expect(config('ohm20k')).toMatchObject({ fullScale: 20000, resolution: 10, displayScale: 1000, unit: 'kΩ' })
    expect(config('dca10').positiveJack).toBe('A10')
    expect(config('dca10').internalR).toBe(0.01)
  })

  it('allows positive input resistance, resolution and deterministic calibration settings without mutating content', () => {
    const before = JSON.stringify(vm)
    const result = resolveInstrument(vm, { internalR: 1000, resolution: 0.1, accuracyClass: 1, accuracyOffset: -0.5 })
    expect(result).toMatchObject({
      internalR: 1000,
      resolution: 0.1,
      accuracy: { percentFullScale: 1 },
      accuracyOffset: -0.5,
    })
    expect(JSON.stringify(vm)).toBe(before)
    expect(vm.internalROptions).toEqual([1000, 10000, 10000000])
  })

  it.each([
    { range: 'missing' },
    { range: 20 },
    { internalR: 0 },
    { internalR: -1 },
    { internalR: Number.POSITIVE_INFINITY },
    { internalR: '1000' },
    { resolution: 0 },
    { resolution: 20 },
    { accuracyClass: -1 },
    { accuracyDigits: 0.5 },
    { accuracyOffset: -1.01 },
    { accuracyOffset: 1.01 },
  ])('rejects invalid settings %j', (settings) => {
    expect(() => resolveInstrument(vm, settings)).toThrow(InstrumentConfigurationError)
  })

  it('rejects invalid defaults, jack references, mode/unit mismatches and missing test source', () => {
    expect(Instrument.safeParse({ ...mm, defaultRange: 'missing' }).success).toBe(false)
    const range = mm.ranges[0]
    for (const patch of [
      { positiveJack: 'MISSING' },
      { negativeJack: 'VOHM' },
      { mode: undefined },
      { unit: 'mV' },
      { displayUnit: 'mA' },
      { resolution: 20 },
      { mode: 'ohm', unit: 'Ω', displayUnit: 'Ω', testSource: undefined },
    ])
      expect(Instrument.safeParse({ ...mm, defaultRange: range?.id, ranges: [{ ...range, ...patch }] }).success).toBe(
        false,
      )
    expect(Instrument.safeParse({ ...ps, settingsControls: [{ ...ps.settingsControls?.[0], min: 31 }] }).success).toBe(
      false,
    )
    expect(
      Instrument.safeParse({ ...ps, settingsControls: [{ ...ps.settingsControls?.[0], anchor: 'NO_KNOB' }] }).success,
    ).toBe(false)
  })

  it('does not claim a power supply or future scope is a supported measurement instrument', () => {
    expect(isMeasurementInstrument(vm)).toBe(true)
    expect(isMeasurementInstrument(mm)).toBe(true)
    expect(isMeasurementInstrument(ps)).toBe(false)
    expect(() => resolveInstrument(ps)).toThrow(/尚未实现/)
    expect(getRangeSettings(ps).internalR).toBe(0.01)
  })
})

describe('instrument readings', () => {
  it('rounds using selected resolution and preserves reverse polarity, not absolute values', () => {
    expect(readInstrument(config('dcv20'), { voltage: 6.004 })).toMatchObject({
      status: 'ok',
      text: '6.00',
      unit: 'V',
      negative: false,
    })
    expect(readInstrument(config('dcv20'), { voltage: -6.126 })).toMatchObject({
      status: 'ok',
      text: '-6.13',
      negative: true,
    })
    expect(readInstrument(config('dca20m'), { current: -0.012346 })).toMatchObject({
      text: '-12.35',
      unit: 'mA',
      negative: true,
    })
    expect(readInstrument(config('dcv20'), { voltage: -0.00001 })).toMatchObject({
      text: '0.00',
      negative: false,
      value: 0,
    })
  })

  it('shows full-scale minus one count, then OL. for either polarity or rounding past the last count', () => {
    expect(readInstrument(config('dcv20'), { voltage: 19.99 }).text).toBe('19.99')
    for (const voltage of [20, -20, 22, 19.999, -19.999]) {
      const reading = readInstrument(config('dcv20'), { voltage })
      expect(reading.status).toBe('overload')
      expect(reading.text).toBe('OL.')
      expect(reading.value).toBeNull()
    }
  })

  it('applies prototype accuracy as an explicit deterministic bound instead of random fake measurements', () => {
    const nominal = config('dcv20')
    expect(accuracyBound(nominal, 10)).toBeCloseTo(0.06)
    expect(readInstrument(nominal, { voltage: 10 }).value).toBe(10)
    expect(readInstrument(config('dcv20', { accuracyOffset: 1 }), { voltage: 10 }).value).toBeCloseTo(10.06)
    expect(readInstrument(config('dcv20', { accuracyOffset: -1 }), { voltage: 10 }).value).toBeCloseTo(9.94)
    expect(accuracyBound(resolveInstrument(vm), 10)).toBeCloseTo(0.1)
  })

  it('formats configurable decimal resolutions, not just powers of ten', () => {
    expect(readInstrument(config('dcv20', { resolution: 0.25 }), { voltage: 3.14 }).text).toBe('3.25')
    expect(readInstrument(config('dcv200m'), { voltage: 0.01234 }).text).toBe('12.3')
  })

  it('does not invent a static zero or use a DC operating point for AC ranges', () => {
    expect(readInstrument(config('dcv20'), {}).status).toBe('invalid')
    expect(readInstrument(config('dcv20'), { voltage: Number.NaN }).status).toBe('invalid')
    expect(readInstrument(config('dcv20'), { voltage: Number.POSITIVE_INFINITY }).status).toBe('invalid')
    expect(readInstrument(config('dca20m'), { current: Number.NEGATIVE_INFINITY }).status).toBe('invalid')
    expect(readInstrument(config('ohm200'), { voltage: Number.POSITIVE_INFINITY, current: 0 }).status).toBe('invalid')
    expect(readInstrument(config('acv20'), { voltage: 6 }).status).toBe('invalid')
    expect(readInstrument(config('aca20m'), { current: 0.01 }).status).toBe('invalid')
    expect(readInstrument(config('acv20'), { rmsVoltage: 3.536 }).text).toBe('3.54')
    expect(readInstrument(config('aca20m'), { rmsCurrent: 0.0042 }).text).toBe('4.20')
    expect(readInstrument(config('acv20'), { rmsVoltage: -1 }).status).toBe('invalid')
  })

  it('never displays negative RMS or resistance due solely to a calibration offset', () => {
    expect(readInstrument(config('acv20', { accuracyOffset: -1 }), { rmsVoltage: 0 }).text).toBe('0.00')
    expect(readInstrument(config('ohm200', { accuracyOffset: -1 }), { voltage: 0, current: 0.001 }).text).toBe('0.0')
    expect(readInstrument(config('diode', { accuracyOffset: -1 }), { voltage: 0 }).text).toBe('0.000')
  })

  it('distinguishes a disconnected probe from wrong jacks and current-range voltage measurement', () => {
    expect(checkInstrumentJacks(config('dcv20'), [])?.status).toBe('disconnected')
    expect(checkInstrumentJacks(config('dcv20'), ['COM'])?.status).toBe('disconnected')
    expect(checkInstrumentJacks(config('dcv20'), ['COM', 'VOHM'])).toBeUndefined()
    expect(checkInstrumentJacks(config('dca20m'), ['COM', 'VOHM'])).toMatchObject({
      status: 'wrong-jacks',
      message: expect.stringContaining('电流档'),
    })
    expect(checkInstrumentJacks(config('dcv20'), ['COM', 'VOHM', 'MA'])?.status).toBe('wrong-jacks')
    expect(checkInstrumentJacks(config('dca10'), ['COM', 'MA'])?.status).toBe('wrong-jacks')
    expect(readInstrument(config('dcv20'), { voltage: 6, connectedJacks: [] }).text).toBe('----')
    expect(readInstrument(config('dca20m'), { current: 6 }).message).toContain('勿将电流档并联')
  })

  it('uses actual source current and terminal voltage in resistance and continuity modes', () => {
    const ohm = config('ohm20k')
    const reading = readInstrument(ohm, {
      voltage: 0.1,
      current: 0.1 / 10000 + 0.1 / (ohm.internalR as number),
      externalVoltage: 0,
    })
    expect(reading).toMatchObject({ status: 'ok', text: '10.00', unit: 'kΩ', value: 10000 })
    expect(readInstrument(config('ohm20k'), { voltage: 2.8, current: 0, externalVoltage: 0 }).text).toBe('OL.')
    expect(readInstrument(config('continuity'), { voltage: 0.01, current: 0.001, externalVoltage: 0 }).beep).toBe(true)
    expect(readInstrument(config('continuity'), { voltage: 0.1, current: 0.001, externalVoltage: 0 }).beep).toBe(false)
  })

  it('shows diode forward voltage and reverse/open overload rather than pretending it measures resistance', () => {
    expect(readInstrument(config('diode'), { voltage: 0.624, current: 0.0008, externalVoltage: 0 }).text).toBe('0.624')
    expect(readInstrument(config('diode'), { voltage: 2.8, current: 0, externalVoltage: 0 }).text).toBe('OL.')
  })

  it.each(['ohm200', 'diode', 'continuity'])('protects %s against either polarity of external voltage', (range) => {
    for (const externalVoltage of [0.1, 12, -12, Number.NaN])
      expect(readInstrument(config(range), { voltage: 0.5, current: 0.001, externalVoltage }).status).toBe(
        'external-voltage',
      )
    expect(readInstrument(config(range, { passive: true }), { voltage: 0, externalVoltage: 0 }).status).toBe('invalid')
  })

  it('computes true AC-coupled RMS with DC rejection and explicit invalid windows', () => {
    const samples = Float64Array.from({ length: 1000 }, (_, i) => 7 + 2 * Math.sin((2 * Math.PI * i) / 1000))
    expect(rms(samples)).toBeCloseTo(Math.sqrt(2), 12)
    expect(rms(samples, false)).toBeCloseTo(Math.sqrt(51), 12)
    expect(rms([3, 3, 3])).toBe(0)
    expect(rms([])).toBeNaN()
    expect(rms([1, Number.NaN])).toBeNaN()
  })
})

describe('netlist and topology integration', () => {
  const input = (range: string, settings: Record<string, unknown> = {}): AssembleInput => ({
    title: 'meter equivalent',
    modules: [],
    instruments: [
      { instanceId: 'ps', instrument: ps, settings: {} },
      { instanceId: 'meter-1', instrument: mm, settings: { range, ...settings } },
    ],
    wires: [
      { a: 'ps.CH1P', b: `meter-1.${config(range).positiveJack}` },
      { a: 'ps.CH1N', b: 'meter-1.COM' },
    ],
    ground: 'ps.CH1N',
    controlValues: {},
    analysis: ['.op'],
  })

  it('puts selectable resistance in the real voltage-meter element', () => {
    const assembled = assembleNetlist(input('dcv20', { internalR: 1000 }))
    expect(assembled.netlist).toMatch(/^Rin_meter_1 n\d+ 0 1000$/m)
    expect(assembled.instrumentSuffix['meter-1']).toBe('meter_1')
  })

  it.each(['dca20m', 'aca20m', 'dca10', 'aca10'])(
    'creates only the selected shunt and a correctly oriented branch for %s',
    (range) => {
      const assembled = assembleNetlist(input(range))
      const resolved = config(range)
      expect(isCurrentMode(resolved.mode)).toBe(true)
      expect(assembled.netlist).toContain(`m_meter_1 ${resolved.internalR}`)
      expect(assembled.netlist).toContain('Vsense_meter_1 m_meter_1 0 DC 0')
      expect(instrumentProbe(resolved, 'meter-1', assembled.nodeOf)).toMatchObject({
        negativeNode: '0',
        currentVector: 'vsense_meter_1#branch',
      })
      expect(assembled.netlist).not.toContain('Rin_meter_1')
    },
  )

  it.each(['ohm200', 'diode', 'continuity'])('generates limited test source and sensing branch for %s', (range) => {
    const assembled = assembleNetlist(input(range))
    expect(isSelfPoweredMode(config(range).mode)).toBe(true)
    expect(assembled.netlist).toContain('I=max(0,min(0.001,(2.8-v(')
    expect(assembled.netlist).toContain('Vtest_sense_meter_1 mt_meter_1')
    expect(instrumentProbe(config(range), 'meter-1', assembled.nodeOf).currentVector).toBe('vtest_sense_meter_1#branch')
  })

  it('passive safety checks disconnect shunts/test sources and never ask for nonexistent current vectors', () => {
    for (const range of ['dcv20', 'dca20m', 'ohm200', 'diode', 'continuity']) {
      const resolved = config(range, { passive: true })
      const assembled = assembleNetlist(input(range, { passive: true }))
      expect(assembled.netlist).toMatch(/^Rpassive_meter_1 n\d+ 0 1T$/m)
      expect(assembled.netlist).not.toContain('Vsense_meter_1')
      expect(assembled.netlist).not.toContain('Vtest_sense_meter_1')
      expect(instrumentProbe(resolved, 'meter-1', assembled.nodeOf).currentVector).toBeUndefined()
    }
    expect(config('diode', { testSourceEnabled: false }).passive).toBe(true)
  })

  it('active topology reflects the actual mode, not every current jack of a multimeter', () => {
    const voltage = activeInstrumentDefinition(config('dcv20'))
    const current = activeInstrumentDefinition(config('dca20m'))
    expect(voltage.measure).toEqual({ voltage: [['VOHM', 'COM']], series: [] })
    expect(current.measure).toEqual({ voltage: [], series: [['MA', 'COM']] })
    const definition = (instrument: Instrument, positiveJack: string) => ({
      modules: [],
      instruments: [
        { instanceId: 'ps', instrument: ps },
        { instanceId: 'mm', instrument },
      ],
      wires: [
        { a: `mm.${positiveJack}`, b: 'ps.CH1P' },
        { a: 'mm.COM', b: 'ps.CH1N' },
      ],
    })
    expect(detectDanger(definition(voltage, 'VOHM'))).toEqual([])
    expect(detectDanger(definition(current, 'MA')).map((issue) => issue.code)).toEqual(['ammeter-across-source'])
    expect(mm.measure?.series).toHaveLength(2)
  })

  it('refuses invalid source controls and netlist-string injection', () => {
    for (const ch1_v of [31, -1, Number.NaN, '6\nRbad 1 0 1']) {
      const bad = input('dcv20')
      const supply = bad.instruments[0]
      if (supply) supply.settings = { ch1_v }
      expect(() => assembleNetlist(bad)).toThrow(AssembleError)
    }
  })
})
