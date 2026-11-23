import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument, type Project } from '../../shared/schema/index.ts'
import type { AssembleInput } from '../circuit/assemble.ts'
import { buildMeasurementPlan, METER_SAMPLE_STEP, sameSimulation } from '../measurement/plan.ts'
import { captureMeasurePoint } from '../task/measurements.ts'
import { checkWiring, detectDanger } from '../wiring-check/index.ts'
import {
  activeInstrumentDefinition,
  checkInstrumentJacks,
  computePowerMetrics,
  getInstrumentDefaults,
  instrumentTemplate,
  PowerWindow,
  readInstrument,
  resolveInstrument,
} from './index.ts'

const load = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))

const acv = load('ins-ac-voltmeter')
const aca = load('ins-ac-ammeter')
const watt = load('ins-power-meter')
const acmv = load('ins-ac-millivoltmeter')
const galv = load('ins-galvanometer')
const ps = load('ins-dc-power')

function makeSinePair(
  uRms: number,
  iRms: number,
  freqHz: number,
  phaseLagRad: number,
  durationSec: number,
  dt: number,
) {
  const n = Math.round(durationSec / dt)
  const u = new Float32Array(n)
  const i = new Float32Array(n)
  const w = 2 * Math.PI * freqHz
  const uPeak = uRms * Math.SQRT2
  const iPeak = iRms * Math.SQRT2
  for (let k = 0; k < n; k++) {
    const t = k * dt
    u[k] = uPeak * Math.sin(w * t)
    i[k] = iPeak * Math.sin(w * t - phaseLagRad)
  }
  return { u, i }
}

describe('T1.1 INS-12 PowerWindow & computePowerMetrics', () => {
  it('computes P, Q, S, cosφ and R/L/C load nature within 0.1% for resistive, inductive, and capacitive loads', () => {
    const dt = 0.0001
    // Pure resistive: 220 V, 1 A, phi = 0
    const res = makeSinePair(220, 1, 50, 0, 0.2, dt)
    const mRes = computePowerMetrics(res.u, res.i, dt)
    expect(mRes).toBeDefined()
    expect(mRes?.U).toBeCloseTo(220, 2)
    expect(mRes?.I).toBeCloseTo(1, 3)
    expect(mRes?.P).toBeCloseTo(220, 1)
    expect(mRes?.S).toBeCloseTo(220, 1)
    expect(mRes?.pf).toBeCloseTo(1, 3)
    expect(mRes?.loadNature).toBe('R')

    // Inductive RL: 220 V, 2 A, phi = +acos(0.8) => current lags voltage
    const phiL = Math.acos(0.8)
    const ind = makeSinePair(220, 2, 50, phiL, 0.2, dt)
    const mInd = computePowerMetrics(ind.u, ind.i, dt)
    expect(mInd?.P).toBeCloseTo(352, 1)
    expect(mInd?.S).toBeCloseTo(440, 1)
    expect(mInd?.Q).toBeCloseTo(264, 1)
    expect(mInd?.pf).toBeCloseTo(0.8, 3)
    expect(mInd?.loadNature).toBe('L')

    // Capacitive RC: 220 V, 1 A, phi = -pi/3 => current leads voltage
    const cap = makeSinePair(220, 1, 50, -Math.PI / 3, 0.2, dt)
    const mCap = computePowerMetrics(cap.u, cap.i, dt)
    expect(mCap?.P).toBeCloseTo(110, 1)
    expect(mCap?.S).toBeCloseTo(220, 1)
    expect(mCap?.Q).toBeCloseTo(-220 * Math.sin(Math.PI / 3), 0)
    expect(mCap?.pf).toBeCloseTo(0.5, 3)
    expect(mCap?.loadNature).toBe('C')
  })

  it('accumulates synchronized out-of-order chunks in PowerWindow and clears on time gaps', () => {
    const dt = 0.0001
    const phi = Math.acos(0.6)
    const { u, i } = makeSinePair(100, 1.5, 50, phi, 0.3, dt)
    const win = new PowerWindow(0.2)
    const chunkLen = 500 // 50 ms
    for (let offset = 0; offset < u.length; offset += chunkLen) {
      const t0 = offset * dt
      const uSlice = u.subarray(offset, offset + chunkLen)
      const iSlice = i.subarray(offset, offset + chunkLen)
      if ((offset / chunkLen) % 2 === 0) {
        win.pushVoltage(uSlice, t0, dt)
        win.pushCurrent(iSlice, t0, dt)
      } else {
        win.pushCurrent(iSlice, t0, dt)
        win.pushVoltage(uSlice, t0, dt)
      }
    }
    expect(win.value).toBeDefined()
    expect(win.value?.P).toBeCloseTo(90, 1)
    expect(win.value?.pf).toBeCloseTo(0.6, 3)
    expect(win.value?.loadNature).toBe('L')

    // Discontinuity resets accumulated window
    win.pushVoltage(u.subarray(0, 500), 10.0, dt)
    win.pushCurrent(i.subarray(0, 500), 10.0, dt)
    expect(win.value).toBeUndefined()
  })
})

describe('T1.1 INS-05 / INS-12 / INS-13 / INS-14 instrument configs, readings and wiring rules', () => {
  it('resolves AC voltmeter/ammeter and switches wattmeter display modes without restarting simulation', () => {
    const acvCfg = resolveInstrument(acv, { range: 'r500' })
    expect(acvCfg.mode).toBe('acv')
    expect(readInstrument(acvCfg, { rmsVoltage: 220.4, connectedJacks: ['U', 'STAR'] })).toMatchObject({
      status: 'ok',
      text: '220.4',
      unit: 'V',
    })
    expect(readInstrument(acvCfg, { rmsVoltage: 505, connectedJacks: ['U', 'STAR'] })).toMatchObject({
      status: 'overload',
      text: 'OL.',
    })

    const acaCfg = resolveInstrument(aca, { range: 'r100m' })
    expect(acaCfg.internalR).toBe(2)
    expect(readInstrument(acaCfg, { rmsCurrent: 0.0452, connectedJacks: ['I', 'STAR'] })).toMatchObject({
      status: 'ok',
      text: '45.2',
      unit: 'mA',
    })

    const wattDefaults = getInstrumentDefaults(watt)
    expect(wattDefaults.displayMode).toBe('P')
    const baseInput = (displayMode: string): AssembleInput => ({
      title: 'watt-test',
      modules: [],
      instruments: [
        { instanceId: 'ps', instrument: ps, settings: { ch1_v: 10 } },
        { instanceId: 'w', instrument: watt, settings: { displayMode } },
      ],
      wires: [
        { a: 'w.U', b: 'ps.CH1P' },
        { a: 'w.U_STAR', b: 'ps.CH1N' },
        { a: 'w.I', b: 'ps.CH1P' },
        { a: 'w.I_STAR', b: 'ps.CH1N' },
      ],
      controlValues: {},
      analysis: [],
    })
    const planP = buildMeasurementPlan(baseInput('P'), true, 't')
    const planPf = buildMeasurementPlan(baseInput('pf'), true, 't')
    expect(planP.command.analysis).toEqual({ kind: 'tran', step: METER_SAMPLE_STEP, continuous: true })
    expect(sameSimulation(planP, planPf)).toBe(true)
    // Current coil wired directly across supply triggers danger check
    expect(detectDanger(planP.checkInput)[0]?.code).toBe('ammeter-across-source')
  })

  it('formats wattmeter P/pf/S/Q/U/I, flags coil reversal and overload, and supports power measurePoints', () => {
    const metrics = { P: 176, Q: 132, S: 220, pf: 0.8, U: 220, I: 1, loadNature: 'L' as const }
    const jacks = ['U', 'U_STAR', 'I', 'I_STAR']
    expect(
      readInstrument(resolveInstrument(watt, { displayMode: 'P' }), { power: metrics, connectedJacks: jacks }),
    ).toMatchObject({ status: 'ok', text: '176.0', unit: 'W' })
    expect(
      readInstrument(resolveInstrument(watt, { displayMode: 'pf' }), { power: metrics, connectedJacks: jacks }),
    ).toMatchObject({ status: 'ok', text: '0.800', unit: 'cosφ' })
    expect(
      readInstrument(resolveInstrument(watt, { displayMode: 'Q' }), { power: metrics, connectedJacks: jacks }),
    ).toMatchObject({ status: 'ok', text: '132.0', unit: 'var' })
    expect(
      readInstrument(resolveInstrument(watt, { displayMode: 'I' }), { power: metrics, connectedJacks: jacks }),
    ).toMatchObject({ status: 'ok', text: '1.000', unit: 'A' })

    // Reversed polarity produces negative power and warning message
    const rev = readInstrument(resolveInstrument(watt, { displayMode: 'P' }), {
      power: { ...metrics, P: -176, pf: -0.8 },
      connectedJacks: jacks,
    })
    expect(rev.negative).toBe(true)
    expect(rev.message).toContain('极性')

    // Missing current coil => disconnected
    expect(checkInstrumentJacks(resolveInstrument(watt), ['U', 'U_STAR'])?.status).toBe('disconnected')

    // Over-voltage or over-current => overload
    expect(
      readInstrument(resolveInstrument(watt), {
        power: { ...metrics, U: 460 },
        connectedJacks: jacks,
      }).status,
    ).toBe('overload')
    expect(
      readInstrument(resolveInstrument(watt), {
        power: { ...metrics, I: 5.2 },
        connectedJacks: jacks,
      }).status,
    ).toBe('overload')

    // Wiring check & captureMeasurePoint for kind === 'power'
    const ref: Project['reference'] = {
      nets: [
        ['ps.CH1P', 'load.IN'],
        ['ps.CH1N', 'load.OUT'],
      ],
      measurePoints: [
        {
          id: 'p-load',
          kind: 'power',
          powerQuantity: 'pf',
          between: ['load.IN', 'load.OUT'],
          branch: ['ps.CH1P', 'load.IN'],
        },
      ],
    }
    const mod = {
      id: 'mod-dummy',
      name: '负载模块',
      form: 'box' as const,
      model: 'm.glb',
      netlist: 'm.cir',
      jacks: [
        { id: 'IN', label: 'IN', kind: 'banana4' as const },
        { id: 'OUT', label: 'OUT', kind: 'banana4' as const },
      ],
      controls: [],
      indicators: [],
    }
    const circuit: AssembleInput = {
      title: 'power-capture',
      modules: [{ instanceId: 'load', module: mod, subckt: '.subckt mod_dummy IN OUT\nR1 IN OUT 100\n.ends' }],
      instruments: [
        { instanceId: 'ps', instrument: ps, settings: { ch1_v: 10 } },
        { instanceId: 'ins-power-meter', instrument: watt, settings: { displayMode: 'P' } },
      ],
      wires: [
        { a: 'ps.CH1P', b: 'ins-power-meter.I' },
        { a: 'ins-power-meter.I_STAR', b: 'load.IN' },
        { a: 'load.IN', b: 'ins-power-meter.U' },
        { a: 'load.OUT', b: 'ins-power-meter.U_STAR' },
        { a: 'load.OUT', b: 'ps.CH1N' },
      ],
      controlValues: {},
      analysis: [],
    }
    const plan = buildMeasurementPlan(circuit, true, 'p')
    const check = checkWiring(plan.checkInput, ref)
    expect(check.circuitOk).toBe(true)
    expect(check.measurementsOk).toBe(true)
    const powerPoint = ref.measurePoints[0]
    expect(powerPoint).toBeDefined()
    if (!powerPoint) throw new Error('Missing power measure point')
    const captured = captureMeasurePoint(
      {
        current: true,
        plan,
        readings: { 'ins-power-meter': { status: 'ok', value: 176, metrics } },
      },
      powerPoint,
    )
    expect(captured.ok).toBe(true)
    if (captured.ok) {
      expect(captured.measurement.referenceValueSI).toBeCloseTo(0.8, 6)
    }
  })

  it('supports dual-channel AC millivoltmeter (12 ranges, 1 MΩ ∥ 50 pF, simultaneous CH1/CH2 wiring)', () => {
    expect(acmv.ranges).toHaveLength(12)
    expect(acmv.ranges[0]?.label).toBe('1 mV')
    expect(acmv.ranges[11]?.label).toBe('300 V')
    const ch1 = resolveInstrument(acmv, { channel: 'CH1', range: 'r10m' })
    const ch2 = resolveInstrument(acmv, { channel: 'CH2', range: 'r3' })
    expect(ch1.positiveJack).toBe('CH1')
    expect(ch2.positiveJack).toBe('CH2')
    // Wiring both CH1 and CH2 simultaneously is valid on a dual-channel millivoltmeter
    expect(checkInstrumentJacks(ch1, ['CH1', 'CH2', 'GND'])).toBeUndefined()
    expect(checkInstrumentJacks(ch2, ['CH1', 'CH2', 'GND'])).toBeUndefined()
    expect(checkInstrumentJacks(ch2, ['CH1', 'GND'])?.status).toBe('disconnected')
    // Equivalent netlist models 1 MΩ ∥ 50 pF on both input channels
    const tpl = instrumentTemplate(ch1)
    expect(tpl).toContain('Rin_ch1_{X} {J:CH1} {J:GND} 1000000')
    expect(tpl).toContain('Cin_ch1_{X} {J:CH1} {J:GND} 5e-11')
    expect(tpl).toContain('Rin_ch2_{X} {J:CH2} {J:GND} 1000000')
    expect(tpl).toContain('Cin_ch2_{X} {J:CH2} {J:GND} 5e-11')
    expect(readInstrument(ch1, { rmsVoltage: 0.00425, connectedJacks: ['CH1', 'GND'] })).toMatchObject({
      status: 'ok',
      text: '4.25',
      unit: 'mV',
    })
  })

  it('computes center-zero galvanometer deflection, sign, and overload clamping (INS-14)', () => {
    const cfg = resolveInstrument(galv)
    expect(cfg.fullScale).toBeCloseTo(100e-6, 12)
    expect(cfg.internalR).toBe(1000)
    expect(activeInstrumentDefinition(cfg).measure?.series).toEqual([['POS', 'NEG']])
    const zero = readInstrument(cfg, { current: 0, connectedJacks: ['POS', 'NEG'] })
    expect(zero).toMatchObject({ status: 'ok', text: '0.0', unit: 'uA', deflection: 0 })
    const pos = readInstrument(cfg, { current: 50e-6, connectedJacks: ['POS', 'NEG'] })
    expect(pos.status).toBe('ok')
    expect(pos.deflection).toBeCloseTo(0.5, 4)
    const neg = readInstrument(cfg, { current: -75e-6, connectedJacks: ['POS', 'NEG'] })
    expect(neg.status).toBe('ok')
    expect(neg.negative).toBe(true)
    expect(neg.deflection).toBeCloseTo(-0.75, 4)
    const over = readInstrument(cfg, { current: -120e-6, connectedJacks: ['POS', 'NEG'] })
    expect(over).toMatchObject({ status: 'overload', text: 'OL.', deflection: -1 })
  })
})
