import { describe, expect, it } from 'vitest'
import { clampKnobValue, knobAngle } from './rotary-knob-values'

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
})
