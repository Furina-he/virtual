import { describe, expect, it } from 'vitest'
import scopeJson from '../../../../content/instruments/ins-oscilloscope/instrument.json'
import { computeScopeAutoSet, resolveScope } from '../../../domain/instruments/scope'
import { Instrument } from '../../../shared/schema/instrument'
import { clampKnobValue, formatEngineeringValue, knobAngle, stepKnobValue } from './rotary-knob-values'

const scopeInstrument = Instrument.parse(scopeJson)

describe('rotary knob values', () => {
  it('clamps at both stops and snaps to the configured step', () => {
    expect(clampKnobValue(-1, 0, 30, 0.1)).toBe(0)
    expect(clampKnobValue(40, 0, 30, 0.1)).toBe(30)
    expect(clampKnobValue(12.26, 0, 30, 0.1)).toBe(12.3)
    expect(clampKnobValue(0.1 + 0.2, 0, 30, 0.1)).toBe(0.3)
    expect(clampKnobValue(3.7, 0, 6, 1)).toBe(4)
  })

  it('does not produce invalid geometry for a single range or invalid input', () => {
    expect(knobAngle(0, 0, 0)).toBe(-135)
    expect(knobAngle(Number.NaN, 0, 5)).toBe(-135)
    expect(clampKnobValue(Number.NaN, 0, 30, 0.1)).toBe(0)
    expect(clampKnobValue(20, 0, 30, 0)).toBe(0)
  })

  it('shares the same 270-degree scale with the 3D control', () => {
    expect(knobAngle(0, 0, 10)).toBe(-135)
    expect(knobAngle(5, 0, 10)).toBe(0)
    expect(knobAngle(10, 0, 10)).toBe(135)
    expect(knobAngle(20, 0, 10)).toBe(135)
  })

  it('T1.9A INS-09 steps by 1x fine and 5x coarse increments within stops', () => {
    expect(stepKnobValue(5, 0, 30, 0.1, 1, false)).toBe(5.1)
    expect(stepKnobValue(5, 0, 30, 0.1, -1, false)).toBe(4.9)
    expect(stepKnobValue(5, 0, 30, 0.1, 1, true)).toBe(5.5)
    expect(stepKnobValue(29.8, 0, 30, 0.1, 1, true)).toBe(30)
    expect(stepKnobValue(0.2, 0, 30, 0.1, -1, true)).toBe(0)
  })

  it('T1.9A INS-09 formats SI base units into readable engineering units', () => {
    expect(formatEngineeringValue(470, 'Ω')).toBe('470 Ω')
    expect(formatEngineeringValue(4700, 'Ω')).toBe('4.7 kΩ')
    expect(formatEngineeringValue(2_200_000, 'Ω')).toBe('2.2 MΩ')
    expect(formatEngineeringValue(500, 'Hz')).toBe('500 Hz')
    expect(formatEngineeringValue(1000, 'Hz')).toBe('1 kHz')
    expect(formatEngineeringValue(1_500_000, 'Hz')).toBe('1.5 MHz')
    expect(formatEngineeringValue(0.025, 'A')).toBe('25 mA')
    expect(formatEngineeringValue(0.0005, 'A')).toBe('500 µA')
    expect(formatEngineeringValue(0.15, 'V')).toBe('150 mV')
    expect(formatEngineeringValue(12, 'V')).toBe('12 V')
  })
})

describe('T1.9A INS-09 scope auto-set calculation', () => {
  it('matches V/div, ~2.5-cycle s/div, centered offset and trigger level from real measured signal', () => {
    const settings = resolveScope(scopeInstrument, {
      ch1_on: 1,
      ch2_on: 0,
      ch1_vdiv: 5,
      tdiv: 0.01,
      ch1_pos: 2,
      hpos: 3,
      run: 0,
    })
    const patch = computeScopeAutoSet(settings, [
      { vpp: 4.0, min: 1.0, max: 5.0, mean: 3.0, frequency: 1000, period: 0.001, completeCycles: 4 },
      null,
    ])
    expect(patch).not.toBeNull()
    expect(patch?.ch1_vdiv).toBe(1) // 4.0 / 4.8 = 0.833 -> next discrete step 1 V/div
    expect(patch?.ch1_pos).toBe(-3) // midpoint +3 V centered down by -3 div
    expect(patch?.tdiv).toBe(0.0002) // 2.5 ms / 10 div = 0.25 ms/div -> nearest log step 200 us/div
    expect(patch?.trig_src).toBe(0)
    expect(patch?.trig_level).toBe(3)
    expect(patch?.hpos).toBe(0)
    expect(patch?.run).toBe(1)
  })

  it('centers AC-coupled signal at 0 div and returns null when no channel has active signal', () => {
    const acSettings = resolveScope(scopeInstrument, { ch1_on: 1, ch1_coupling: 1, ch2_on: 0 })
    const acPatch = computeScopeAutoSet(acSettings, [
      { vpp: 0.4, min: 4.8, max: 5.2, mean: 5.0, frequency: 500, period: 0.002, completeCycles: 2 },
      null,
    ])
    expect(acPatch?.ch1_vdiv).toBe(0.1)
    expect(acPatch?.ch1_pos).toBe(0)
    expect(acPatch?.trig_level).toBe(0)

    const gndSettings = resolveScope(scopeInstrument, { ch1_on: 1, ch1_coupling: 2, ch2_on: 0 })
    expect(
      computeScopeAutoSet(gndSettings, [
        { vpp: 2, min: -1, max: 1, mean: 0, frequency: 1000, period: 0.001, completeCycles: 2 },
        null,
      ]),
    ).toBeNull()
    expect(computeScopeAutoSet(acSettings, [null, null])).toBeNull()
  })
})
