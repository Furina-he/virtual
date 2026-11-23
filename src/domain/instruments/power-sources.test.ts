import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument } from '../../shared/schema/index.ts'
import type { AssembleInput } from '../circuit/assemble.ts'
import { buildMeasurementPlan } from '../measurement/plan.ts'
import { detectDanger } from '../wiring-check/index.ts'
import {
  classifyCurrentSource,
  classifyDcChannel,
  getInstrumentDefaults,
  powerSettingValid,
  powerSourceTemplate,
  resolveAcSupply,
  resolveDcSupply,
} from './index.ts'

const load = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))

const dc = load('ins-dc-power')
const ac = load('ins-ac-power')
const dca = load('ins-dc-ammeter')
const aca = load('ins-ac-ammeter')

describe('T1.2 INS-07 / SIM-04 DC CV/CC supply, current source, and 3-phase AC supply domain model', () => {
  it('resolves DC CV/CC channels, series tracking, fixed +5 V, and 3-range constant current source', () => {
    const defaults = getInstrumentDefaults(dc)
    expect(defaults).toMatchObject({
      ch1_v: 6,
      ch1_i: 1,
      ch2_v: 12,
      ch2_i: 1,
      is_ma: 20,
      is_range: 1,
      tracking: 0,
    })
    const independent = resolveDcSupply(dc, { ch1_v: 15, ch1_i: 0.4, ch2_v: 9, ch2_i: 0.8, is_range: 0, is_ma: 5 })
    expect(independent.tracking).toBe(false)
    expect(independent.ch1).toMatchObject({ voltageSet: 15, currentLimit: 0.4 })
    expect(independent.ch2).toMatchObject({ voltageSet: 9, currentLimit: 0.8 })
    expect(independent.v5).toMatchObject({ voltageSet: 5, currentLimit: 1 })
    // 2 mA range clamps requested 5 mA down to 2 mA
    expect(independent.currentSource).toMatchObject({
      rangeMa: 2,
      currentSetMa: 2,
      currentSetA: 0.002,
      complianceV: 30,
    })

    // Series tracking locks CH2 voltage and current limit to CH1
    const tracked = resolveDcSupply(dc, { ch1_v: 12, ch1_i: 0.25, ch2_v: 5, ch2_i: 1, tracking: 1 })
    expect(tracked.tracking).toBe(true)
    expect(tracked.ch2).toMatchObject({ voltageSet: 12, currentLimit: 0.25 })

    // Template uses native SPICE3f5 I+D+V+R clamping with zero ASRC (B) and zero XSPICE (A) devices
    const tpl = powerSourceTemplate(dc, { ch1_v: 10, ch1_i: 0.5 }) ?? ''
    expect(tpl).toContain('Vch1_{X}')
    expect(tpl).toContain('Ich1_{X}')
    expect(tpl).toContain('Dch1_{X}')
    expect(tpl).toContain('Dv5_{X}')
    expect(tpl).toContain('Dis_{X}')
    expect(tpl).not.toMatch(/^\s*[AB]/m)
  })

  it('classifies CV vs CC mode and constant-current compliance protection accurately', () => {
    const resolved = resolveDcSupply(dc, { ch1_v: 10, ch1_i: 0.5, is_range: 1, is_ma: 15 })
    expect(classifyDcChannel(resolved.ch1, 9.998, 0.2)).toEqual({
      mode: 'CV',
      voltage: 9.998,
      current: 0.2,
    })
    expect(classifyDcChannel(resolved.ch1, 4.99, 0.5)).toEqual({
      mode: 'CC',
      voltage: 4.99,
      current: 0.5,
    })
    const cs = resolved.currentSource
    expect(cs).toBeDefined()
    if (!cs) throw new Error('Missing currentSource')
    expect(classifyCurrentSource(cs, 7.5, 0.015, true)).toEqual({
      state: 'CC',
      currentMa: 15,
      voltage: 7.5,
    })
    expect(classifyCurrentSource(cs, 30.0, 0.00001, true)).toEqual({
      state: 'OPEN',
      currentMa: 0.01,
      voltage: 30.0,
    })
    expect(classifyCurrentSource(cs, 30.0, 0, false).state).toBe('OFF')
  })

  it('allows ammeter across constant-current source (ISP/ISN) while flagging voltage source shorts', () => {
    const isShortInput: AssembleInput = {
      title: 'IS ammeter test',
      modules: [],
      instruments: [
        { instanceId: 'ps', instrument: dc, settings: { is_range: 1, is_ma: 10 } },
        { instanceId: 'am', instrument: dca, settings: { range: 'r20m' } },
      ],
      wires: [
        { a: 'ps.ISP', b: 'am.POS' },
        { a: 'ps.ISN', b: 'am.NEG' },
      ],
      controlValues: {},
      analysis: [],
    }
    const isPlan = buildMeasurementPlan(isShortInput, true, 'is')
    expect(detectDanger(isPlan.checkInput)).toEqual([])
    expect(isPlan.supplies.map((s) => s.screenId)).toEqual(['CH1', 'CH2', 'V5', 'IS'])

    const v5ShortInput: AssembleInput = {
      ...isShortInput,
      wires: [
        { a: 'ps.V5P', b: 'am.POS' },
        { a: 'ps.V5N', b: 'am.NEG' },
      ],
    }
    expect(detectDanger(buildMeasurementPlan(v5ShortInput, true, 'v5').checkInput)[0]?.code).toBe(
      'ammeter-across-source',
    )
  })

  it('resolves 3-phase AC supply √3 line-to-phase ratio, requests transient analysis, and detects phase-to-phase shorts', () => {
    const resolved = resolveAcSupply(ac, { u_phase: 220 })
    expect(resolved.phaseVoltageRms).toBe(220)
    expect(resolved.lineVoltageRms).toBeCloseTo(220 * Math.sqrt(3), 6)
    expect(powerSettingValid(ac, 'u_phase', 250)).toBe(true)
    expect(powerSettingValid(ac, 'u_phase', 300)).toBe(false)

    const tpl = powerSourceTemplate(ac, { u_phase: 220 }) ?? ''
    expect(tpl).toContain('SIN(0 311.1269837220809 50 0 0 0)')
    expect(tpl).toContain('SIN(0 311.1269837220809 50 0 0 -120)')
    expect(tpl).toContain('SIN(0 311.1269837220809 50 0 0 120)')

    // Connected AC supply automatically requests continuous transient analysis
    const lineShort: AssembleInput = {
      title: '3-phase line short',
      modules: [],
      instruments: [
        { instanceId: 'ac', instrument: ac, settings: { u_phase: 220 } },
        { instanceId: 'aca', instrument: aca, settings: { range: 'r5' } },
      ],
      wires: [
        { a: 'ac.U', b: 'aca.I' },
        { a: 'ac.V', b: 'aca.STAR' },
      ],
      controlValues: {},
      analysis: [],
    }
    const plan = buildMeasurementPlan(lineShort, true, 'ac3')
    expect(plan.command.analysis).toEqual({ kind: 'tran', step: 1 / 50 / 1000, continuous: true })
    expect(detectDanger(plan.checkInput)[0]?.code).toBe('ammeter-across-source')
  })
})
