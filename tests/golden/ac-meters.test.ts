import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { PowerWindow, readInstrument, resolveInstrument } from '../../src/domain/instruments/index.ts'
import { RmsWindow } from '../../src/domain/instruments/rms-window.ts'
import { buildMeasurementPlan, METER_RMS_WINDOW } from '../../src/domain/measurement/plan.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// T1.1 金标准：真实 ngspice 瞬态/工作点验证交流电压表、交流电流表、功率表、交流毫伏表、检流计。
const loadIns = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))
const acv = loadIns('ins-ac-voltmeter')
const aca = loadIns('ins-ac-ammeter')
const watt = loadIns('ins-power-meter')
const acmv = loadIns('ins-ac-millivoltmeter')
const galv = loadIns('ins-galvanometer')
const ps = loadIns('ins-dc-power')
const gen = loadIns('ins-func-gen')

const events: SimEvent[] = []
const session = new SimSession(
  resolve(import.meta.dirname, '../../resources/ngspice'),
  (event) => events.push(event),
  () => {},
)
afterAll(() => session.dispose())
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing expected value: ${label}`)
  return value
}

function testModule(id: string, jacks: string[], body: string) {
  const module = Module.parse({
    id,
    name: id,
    form: 'box',
    model: 'm.glb',
    netlist: 'm.cir',
    jacks: jacks.map((j) => ({ id: j, label: j, kind: 'banana4' })),
    controls: [],
    indicators: [],
  })
  const subckt = `.subckt ${id.replaceAll('-', '_')} ${jacks.join(' ')}\n${body}\n.ends`
  return { module, subckt }
}

async function runTransientWindows(input: AssembleInput, minSimTime = 0.42) {
  const plan = buildMeasurementPlan(input, true, 'g')
  expect(plan.command.analysis.kind).toBe('tran')
  events.length = 0
  const rmsMap = new Map<string, RmsWindow>()
  const powerMap = new Map<string, PowerWindow>()
  for (const meter of plan.meters) {
    if (meter.config.mode === 'power' && meter.voltageProbe && meter.currentProbe) {
      powerMap.set(meter.instanceId, new PowerWindow(METER_RMS_WINDOW))
    } else if (meter.config.mode === 'acv' && meter.voltageProbe) {
      rmsMap.set(meter.voltageProbe, new RmsWindow(METER_RMS_WINDOW))
    } else if (meter.config.mode === 'aca' && meter.currentProbe) {
      rmsMap.set(meter.currentProbe, new RmsWindow(METER_RMS_WINDOW))
    }
  }
  session.handle(plan.command)
  session.handle({ type: 'setPacing', mode: 'window', windowSec: 0.5 })
  session.handle({ type: 'run' })
  let started = false
  let simTime = 0
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await wait(30)
    for (const event of events.splice(0)) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'loaded') {
        started = true
        for (const w of rmsMap.values()) w.clear()
        for (const w of powerMap.values()) w.clear()
      }
      if (event.type !== 'chunk' || !started) continue
      for (const meter of plan.meters) {
        if (meter.config.mode === 'power' && meter.voltageProbe && meter.currentProbe) {
          const pw = powerMap.get(meter.instanceId)
          const u = event.data[meter.voltageProbe]
          const i = event.data[meter.currentProbe]
          if (pw && u && i) {
            pw.pushVoltage(u, event.t0, event.dt)
            pw.pushCurrent(i, event.t0, event.dt)
          }
        } else if (meter.config.mode === 'acv' && meter.voltageProbe) {
          const u = event.data[meter.voltageProbe]
          if (u) rmsMap.get(meter.voltageProbe)?.push(u, event.t0, event.dt)
        } else if (meter.config.mode === 'aca' && meter.currentProbe) {
          const i = event.data[meter.currentProbe]
          if (i) rmsMap.get(meter.currentProbe)?.push(i, event.t0, event.dt)
        }
      }
      const first = Object.values(event.data)[0]
      if (first) simTime = event.t0 + first.length * event.dt
    }
    const allReady =
      simTime >= minSimTime &&
      [...rmsMap.values()].every((w) => w.value !== undefined) &&
      [...powerMap.values()].every((w) => w.value !== undefined)
    if (allReady) break
  }
  session.handle({ type: 'pause' })
  return { plan, rmsMap, powerMap }
}

async function runOp(input: AssembleInput) {
  const plan = buildMeasurementPlan(input, true, 'op')
  expect(plan.command.analysis.kind).toBe('op')
  events.length = 0
  session.handle(plan.command)
  let started = false
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await wait(20)
    for (const event of events.splice(0)) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'loaded') started = true
      if (event.type === 'op' && started) return { plan, values: event.values }
    }
  }
  throw new Error('Timed out waiting for .op result')
}

describe('T1.1 golden: AC meters, wattmeter, AC millivoltmeter, and galvanometer in real ngspice', () => {
  it('INS-05 / INS-12: measures resistive, inductive (RL), and capacitive (RC) 50 Hz loads within 1%', async () => {
    const uPeak = 220 * Math.SQRT2
    // 1) Pure resistive: R = 220 Ω -> U = 220 V, I = 1 A, P = 220 W, cosφ = 1.000
    const modR = testModule('mod-ac-r', ['L', 'N', 'LOAD_IN'], `Vs L N SIN(0 ${uPeak} 50)\nRload LOAD_IN N 220`)
    const resR = await runTransientWindows({
      title: 'T1.1 resistive',
      modules: [{ instanceId: 'm', ...modR }],
      instruments: [
        { instanceId: 'acv', instrument: acv, settings: { range: 'r500' } },
        { instanceId: 'aca', instrument: aca, settings: { range: 'r5' } },
        { instanceId: 'watt', instrument: watt, settings: { displayMode: 'P' } },
      ],
      wires: [
        { a: 'm.L', b: 'aca.I' },
        { a: 'aca.STAR', b: 'watt.I' },
        { a: 'watt.I_STAR', b: 'm.LOAD_IN' },
        { a: 'm.LOAD_IN', b: 'watt.U' },
        { a: 'm.N', b: 'watt.U_STAR' },
        { a: 'm.LOAD_IN', b: 'acv.U' },
        { a: 'm.N', b: 'acv.STAR' },
      ],
      ground: 'm.N',
      controlValues: {},
      analysis: [],
    })
    const mAcvR = defined(
      resR.plan.meters.find((m) => m.instanceId === 'acv'),
      'acv meter',
    )
    const mAcaR = defined(
      resR.plan.meters.find((m) => m.instanceId === 'aca'),
      'aca meter',
    )
    const uR = defined(resR.rmsMap.get(defined(mAcvR.voltageProbe, 'acv probe'))?.value, 'uR')
    const iR = defined(resR.rmsMap.get(defined(mAcaR.currentProbe, 'aca probe'))?.value, 'iR')
    const pR = defined(resR.powerMap.get('watt')?.value, 'pR')
    expect(Math.abs(uR - 220) / 220).toBeLessThan(0.01)
    expect(Math.abs(iR - 1) / 1).toBeLessThan(0.01)
    expect(Math.abs(pR.P - 220) / 220).toBeLessThan(0.01)
    expect(Math.abs(pR.pf - 1)).toBeLessThan(0.01)
    expect(pR.loadNature).toBe('R')

    // 2) Inductive RL: R = 100 Ω, L = 75 / (2*pi*50) => Z = 125 Ω, I = 1.76 A, P = 309.76 W, cosφ = 0.800
    const L = 75 / (2 * Math.PI * 50)
    const modRL = testModule(
      'mod-ac-rl',
      ['L', 'N', 'LOAD_IN'],
      `Vs L N SIN(0 ${uPeak} 50)\nRload LOAD_IN mid 100\nLload mid N ${L}`,
    )
    const resRL = await runTransientWindows(
      {
        title: 'T1.1 inductive RL',
        modules: [{ instanceId: 'm', ...modRL }],
        instruments: [
          { instanceId: 'acv', instrument: acv, settings: { range: 'r500' } },
          { instanceId: 'aca', instrument: aca, settings: { range: 'r5' } },
          { instanceId: 'watt', instrument: watt, settings: { displayMode: 'pf' } },
        ],
        wires: [
          { a: 'm.L', b: 'aca.I' },
          { a: 'aca.STAR', b: 'watt.I' },
          { a: 'watt.I_STAR', b: 'm.LOAD_IN' },
          { a: 'm.LOAD_IN', b: 'watt.U' },
          { a: 'm.N', b: 'watt.U_STAR' },
          { a: 'm.LOAD_IN', b: 'acv.U' },
          { a: 'm.N', b: 'acv.STAR' },
        ],
        ground: 'm.N',
        controlValues: {},
        analysis: [],
      },
      0.5,
    )
    const pRL = defined(resRL.powerMap.get('watt')?.value, 'pRL')
    expect(Math.abs(pRL.U - 220) / 220).toBeLessThan(0.01)
    expect(Math.abs(pRL.I - 1.76) / 1.76).toBeLessThan(0.01)
    expect(Math.abs(pRL.P - 309.76) / 309.76).toBeLessThan(0.01)
    expect(Math.abs(pRL.pf - 0.8)).toBeLessThan(0.01)
    expect(pRL.Q).toBeGreaterThan(220)
    expect(pRL.loadNature).toBe('L')

    // 3) Capacitive RC: R = 100 Ω, Xc = 173.20508 Ω => Z = 200 Ω, I = 1.1 A, P = 121 W, cosφ = 0.500, Q = -209.58 var
    const C = 1 / (2 * Math.PI * 50 * (100 * Math.sqrt(3)))
    const modRC = testModule(
      'mod-ac-rc',
      ['L', 'N', 'LOAD_IN'],
      `Vs L N SIN(0 ${uPeak} 50)\nRload LOAD_IN mid 100\nCload mid N ${C}`,
    )
    const resRC = await runTransientWindows(
      {
        title: 'T1.1 capacitive RC',
        modules: [{ instanceId: 'm', ...modRC }],
        instruments: [{ instanceId: 'watt', instrument: watt, settings: { displayMode: 'pf' } }],
        wires: [
          { a: 'm.L', b: 'watt.I' },
          { a: 'watt.I_STAR', b: 'm.LOAD_IN' },
          { a: 'm.LOAD_IN', b: 'watt.U' },
          { a: 'm.N', b: 'watt.U_STAR' },
        ],
        ground: 'm.N',
        controlValues: {},
        analysis: [],
      },
      0.5,
    )
    const pRC = defined(resRC.powerMap.get('watt')?.value, 'pRC')
    expect(Math.abs(pRC.U - 220) / 220).toBeLessThan(0.01)
    expect(Math.abs(pRC.I - 1.1) / 1.1).toBeLessThan(0.01)
    expect(Math.abs(pRC.P - 121) / 121).toBeLessThan(0.01)
    expect(Math.abs(pRC.pf - 0.5)).toBeLessThan(0.01)
    expect(pRC.Q).toBeLessThan(-200)
    expect(pRC.loadNature).toBe('C')
  })

  it('INS-13: dual-channel AC millivoltmeter measures mV/V signals with realistic 1 MΩ ∥ 50 pF loading', async () => {
    const modDiv = testModule('mod-div', ['IN', 'MID', 'GND'], 'R1 IN MID 100k\nR2 MID GND 100k')
    const base = (channel: 'CH1' | 'CH2'): AssembleInput => ({
      title: `T1.1 acmv ${channel}`,
      modules: [{ instanceId: 'd', ...modDiv }],
      instruments: [
        {
          instanceId: 'gen',
          instrument: gen,
          settings: { ch1_wave: 'sine', ch1_freq: 1000, ch1_amp: 0.2, ch1_offset: 0, ch1_on: true },
        },
        { instanceId: 'mv', instrument: acmv, settings: { channel, range: 'r100m' } },
      ],
      wires: [
        { a: 'gen.CH1', b: 'd.IN' },
        { a: 'gen.GND', b: 'd.GND' },
        { a: 'd.IN', b: 'mv.CH1' },
        { a: 'd.MID', b: 'mv.CH2' },
        { a: 'd.GND', b: 'mv.GND' },
      ],
      ground: 'gen.GND',
      controlValues: {},
      analysis: [],
    })
    const resCh1 = await runTransientWindows(base('CH1'), 0.22)
    const mv1 = defined(
      resCh1.plan.meters.find((m) => m.instanceId === 'mv'),
      'mv ch1',
    )
    const v1 = defined(resCh1.rmsMap.get(defined(mv1.voltageProbe, 'mv1 probe'))?.value, 'v1')
    expect(Math.abs(v1 - 0.07071) / 0.07071).toBeLessThan(0.01)

    const resCh2 = await runTransientWindows(base('CH2'), 0.22)
    const mv2 = defined(
      resCh2.plan.meters.find((m) => m.instanceId === 'mv'),
      'mv ch2',
    )
    const v2 = defined(resCh2.rmsMap.get(defined(mv2.voltageProbe, 'mv2 probe'))?.value, 'v2')
    expect(Math.abs(v2 - 0.03365) / 0.03365).toBeLessThan(0.01)
  })

  it('INS-14: galvanometer indicates zero at Wheatstone bridge balance and accurate signed deflection when unbalanced', async () => {
    const bridge = (r4: number): AssembleInput => {
      const mod = testModule(
        'mod-bridge',
        ['VP', 'VN', 'GA', 'GB'],
        `R1 VP GA 10k\nR2 GA VN 10k\nR3 VP GB 10k\nR4 GB VN ${r4}`,
      )
      return {
        title: `T1.1 bridge ${r4}`,
        modules: [{ instanceId: 'b', ...mod }],
        instruments: [
          { instanceId: 'ps', instrument: ps, settings: { ch1_v: 10 } },
          { instanceId: 'g', instrument: galv, settings: {} },
        ],
        wires: [
          { a: 'ps.CH1P', b: 'b.VP' },
          { a: 'ps.CH1N', b: 'b.VN' },
          { a: 'b.GA', b: 'g.POS' },
          { a: 'b.GB', b: 'g.NEG' },
        ],
        ground: 'ps.CH1N',
        controlValues: {},
        analysis: [],
      }
    }

    const bal = await runOp(bridge(10_000))
    const gBal = defined(bal.plan.meters[0], 'gBal')
    const rBal = readInstrument(resolveInstrument(galv), {
      current: bal.values[defined(gBal.currentProbe, 'gBal probe')],
      connectedJacks: ['POS', 'NEG'],
    })
    expect(rBal.status).toBe('ok')
    expect(Math.abs(rBal.value ?? 1)).toBeLessThan(1e-7)
    expect(rBal.deflection).toBeCloseTo(0, 4)

    const unbalNeg = await runOp(bridge(10_200))
    const gNeg = defined(unbalNeg.plan.meters[0], 'gNeg')
    const iNeg = defined(unbalNeg.values[defined(gNeg.currentProbe, 'gNeg probe')], 'iNeg')
    expect(Math.abs(iNeg - -4.4803e-6) / 4.4803e-6).toBeLessThan(0.01)
    const rNeg = readInstrument(resolveInstrument(galv), { current: iNeg, connectedJacks: ['POS', 'NEG'] })
    expect(rNeg.negative).toBe(true)
    expect(rNeg.deflection).toBeCloseTo(-0.045, 2)

    const unbalPos = await runOp(bridge(9_800))
    const gPos = defined(unbalPos.plan.meters[0], 'gPos')
    const iPos = defined(unbalPos.values[defined(gPos.currentProbe, 'gPos probe')], 'iPos')
    expect(iPos).toBeGreaterThan(4.4e-6)
    const rPos = readInstrument(resolveInstrument(galv), { current: iPos, connectedJacks: ['POS', 'NEG'] })
    expect(rPos.negative).toBe(false)
    expect(rPos.deflection).toBeGreaterThan(0.04)
  })
})
