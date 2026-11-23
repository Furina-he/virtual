import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument } from '../../shared/schema/instrument.ts'
import { buildMeasurementPlan, sameSimulation } from '../measurement/plan.ts'
import {
  buildXyTrace,
  getInstrumentDefaults,
  measureCursors,
  measureSignal,
  resolveScope,
  scopeSettingValid,
} from './index.ts'

const load = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))
const scope = load('ins-oscilloscope')
const gen = load('ins-func-gen')

describe('T1.3 INS-11 oscilloscope enhancements: X-Y mode, dual cursors, and freeze semantics', () => {
  it('pairs synchronized CH1/CH2 samples into X-Y Lissajous figures and transfer characteristics', () => {
    const dt = 1e-6
    const n = 2000
    const settings = resolveScope(scope, { xy: 1, ch1_vdiv: 1, ch2_vdiv: 1 })
    expect(settings.displayMode).toBe('xy')

    // 1. In-phase 1 kHz sine waves (0° phase shift -> diagonal line y = x, correlation = +1, areaRatio ≈ 0)
    const ch1 = Float32Array.from({ length: n }, (_, i) => 2 * Math.sin(2 * Math.PI * 1000 * i * dt))
    const ch2InPhase = Float32Array.from({ length: n }, (_, i) => 2 * Math.sin(2 * Math.PI * 1000 * i * dt))
    const inPhase = buildXyTrace(settings, ch1, ch2InPhase)
    expect(inPhase.points).toHaveLength(n)
    expect(inPhase.summary).not.toBeNull()
    expect(inPhase.summary?.xVpp).toBeCloseTo(4, 2)
    expect(inPhase.summary?.yVpp).toBeCloseTo(4, 2)
    expect(inPhase.summary?.correlation).toBeCloseTo(1, 3)
    expect(inPhase.summary?.areaRatio).toBeLessThan(0.02)

    // 2. Quadrature 90° phase shift (Lissajous circle: correlation ≈ 0, areaRatio ≈ 1)
    const ch2Quad = Float32Array.from({ length: n }, (_, i) => 2 * Math.cos(2 * Math.PI * 1000 * i * dt))
    const quadrature = buildXyTrace(settings, ch1, ch2Quad)
    expect(Math.abs(quadrature.summary?.correlation ?? 1)).toBeLessThan(0.02)
    expect(quadrature.summary?.areaRatio).toBeGreaterThan(0.95)

    // 3. Inverting comparator / clipping transfer characteristic (180° inversion with ±1.5 V saturation)
    const ch2Transfer = Float32Array.from({ length: n }, (_, i) =>
      Math.max(-1.5, Math.min(1.5, -1.5 * (ch1[i] as number))),
    )
    const transfer = buildXyTrace(settings, ch1, ch2Transfer)
    expect(transfer.summary?.xVpp).toBeCloseTo(4, 2)
    expect(transfer.summary?.yVpp).toBeCloseTo(3, 2)
    expect(transfer.summary?.correlation).toBeLessThan(-0.95)
    expect(transfer.summary?.areaRatio).toBeLessThan(0.02)
  })

  it('computes accurate time-cursor (Δt, 1/Δt, trace ΔV) and voltage-cursor (V1, V2, ΔV) measurements', () => {
    const dt = 1e-6
    const n = 2001 // 10 divisions * 200 points/div + 1, tdiv = 200 µs/div (total screen = 2 ms)
    const ramp = Float32Array.from({ length: n }, (_, i) => -2 + (4 * i) / (n - 1))
    const m = measureSignal(ramp, dt)

    const timeScope = resolveScope(scope, {
      tdiv: 2e-4,
      cursor_mode: 1,
      cursor_src: 0,
      cursor_a: -2.5,
      cursor_b: 2.5,
    })
    const timeResult = measureCursors(timeScope, [ramp, null], [m, null])
    expect(timeResult).not.toBeNull()
    expect(timeResult?.mode).toBe('time')
    expect(timeResult?.t1).toBeCloseTo(-5e-4, 8)
    expect(timeResult?.t2).toBeCloseTo(5e-4, 8)
    expect(timeResult?.deltaT).toBeCloseTo(1e-3, 8)
    expect(timeResult?.frequency).toBeCloseTo(1000, 5)
    expect(timeResult?.v1).toBeCloseTo(-1, 5)
    expect(timeResult?.v2).toBeCloseTo(1, 5)
    expect(timeResult?.deltaV).toBeCloseTo(2, 5)

    const voltScope = resolveScope(scope, {
      ch2_vdiv: 0.5,
      ch2_pos: 1,
      cursor_mode: 2,
      cursor_src: 1,
      cursor_a: -1,
      cursor_b: 3,
    })
    const voltResult = measureCursors(voltScope, [ramp, ramp])
    expect(voltResult).toMatchObject({
      mode: 'voltage',
      sourceChannelId: 'CH2',
      v1: -1,
      v2: 1,
      deltaV: 2,
      deltaT: null,
      frequency: null,
    })

    expect(scopeSettingValid(scope, 'xy', 1)).toBe(true)
    expect(scopeSettingValid(scope, 'xy', 2)).toBe(false)
    expect(scopeSettingValid(scope, 'cursor_mode', 2)).toBe(true)
    expect(scopeSettingValid(scope, 'cursor_mode', 3)).toBe(false)
    expect(scopeSettingValid(scope, 'cursor_a', -5)).toBe(true)
    expect(scopeSettingValid(scope, 'cursor_a', -6)).toBe(false)
  })

  it('keeps simulation session unchanged when switching X-Y mode, cursors, or manual freeze', () => {
    const planWith = (scopeSettings: Record<string, unknown>) =>
      buildMeasurementPlan(
        {
          title: 'scope settings',
          modules: [],
          instruments: [
            { instanceId: 'gen1', instrument: gen, settings: getInstrumentDefaults(gen) },
            {
              instanceId: 'scope1',
              instrument: scope,
              settings: { ...getInstrumentDefaults(scope), ...scopeSettings },
            },
          ],
          wires: [
            { a: 'gen1.CH1', b: 'scope1.CH1' },
            { a: 'gen1.CH2', b: 'scope1.CH2' },
            { a: 'gen1.GND', b: 'scope1.GND' },
          ],
          controlValues: {},
          analysis: [],
        },
        true,
        'scope',
      )

    const base = planWith({})
    const enhanced = planWith({ xy: 1, cursor_mode: 2, cursor_src: 1, cursor_a: -1.5, cursor_b: 2.5, run: 0 })
    expect(sameSimulation(base, enhanced)).toBe(true)
  })
})
