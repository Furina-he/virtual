import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { classifyCurrentSource, classifyDcChannel } from '../../src/domain/instruments/index.ts'
import { RmsWindow } from '../../src/domain/instruments/rms-window.ts'
import { buildMeasurementPlan, METER_RMS_WINDOW } from '../../src/domain/measurement/plan.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// T1.2 金标准：真实 ngspice 验证直流稳压电源 CV/CC 限流、串联正负电源、固定 +5 V、三档恒流源与三相调压交流电源。
const loadIns = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))
const dc = loadIns('ins-dc-power')
const ac = loadIns('ins-ac-power')
const acv = loadIns('ins-ac-voltmeter')
const aca = loadIns('ins-ac-ammeter')

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

async function runTransientRms(input: AssembleInput, minSimTime = 0.25) {
  const plan = buildMeasurementPlan(input, true, 'tr')
  expect(plan.command.analysis.kind).toBe('tran')
  events.length = 0
  const rmsMap = new Map<string, RmsWindow>()
  for (const meter of plan.meters) {
    const probe = meter.config.mode === 'acv' ? meter.voltageProbe : meter.currentProbe
    if (probe) rmsMap.set(probe, new RmsWindow(METER_RMS_WINDOW))
  }
  session.handle(plan.command)
  session.handle({ type: 'setPacing', mode: 'window', windowSec: 0.3 })
  session.handle({ type: 'run' })
  let started = false
  let simTime = 0
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await wait(25)
    for (const event of events.splice(0)) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'loaded') {
        started = true
        for (const w of rmsMap.values()) w.clear()
      }
      if (event.type !== 'chunk' || !started) continue
      for (const [probe, win] of rmsMap) {
        const samples = event.data[probe]
        if (samples) win.push(samples, event.t0, event.dt)
      }
      const first = Object.values(event.data)[0]
      if (first) simTime = event.t0 + first.length * event.dt
    }
    if (simTime >= minSimTime && [...rmsMap.values()].every((w) => w.value !== undefined)) break
  }
  session.handle({ type: 'pause' })
  return { plan, rmsMap }
}

describe('T1.2 golden: DC CV/CC supply, series tracking, constant current source, and 3-phase AC supply', () => {
  it('INS-07: regulates in CV mode (≤0.3%) and clamps current in CC mode (≤1%), plus series ±12 V and +5 V', async () => {
    // 1) CV mode: 12 V / 0.5 A into 100 Ω -> I ≈ 0.12 A, V ≈ 11.9988 V
    //    CC mode on CH2: 12 V / 0.5 A into 10 Ω -> I clamped to 0.500 A, V drops to 5.000 V
    //    Fixed +5 V into 50 Ω -> V ≈ 4.999 V, I ≈ 0.100 A
    const modLoads = testModule(
      'mod-dc-loads',
      ['A1', 'B1', 'A2', 'B2', 'A5', 'B5'],
      'R1 A1 B1 100\nR2 A2 B2 10\nR5 A5 B5 50',
    )
    const cvCc = await runOp({
      title: 'T1.2 CV and CC',
      modules: [{ instanceId: 'L', ...modLoads }],
      instruments: [{ instanceId: 'ps', instrument: dc, settings: { ch1_v: 12, ch1_i: 0.5, ch2_v: 12, ch2_i: 0.5 } }],
      wires: [
        { a: 'ps.CH1P', b: 'L.A1' },
        { a: 'ps.CH1N', b: 'L.B1' },
        { a: 'ps.CH2P', b: 'L.A2' },
        { a: 'ps.CH2N', b: 'L.B2' },
        { a: 'ps.V5P', b: 'L.A5' },
        { a: 'ps.V5N', b: 'L.B5' },
      ],
      ground: 'ps.CH1N',
      controlValues: {},
      analysis: [],
    })
    const sCh1 = defined(
      cvCc.plan.supplies.find((s) => s.screenId === 'CH1'),
      'CH1 plan',
    )
    const sCh2 = defined(
      cvCc.plan.supplies.find((s) => s.screenId === 'CH2'),
      'CH2 plan',
    )
    const sV5 = defined(
      cvCc.plan.supplies.find((s) => s.screenId === 'V5'),
      'V5 plan',
    )
    const v1 = defined(cvCc.values[sCh1.voltageProbe], 'v1')
    const i1 = defined(cvCc.values[sCh1.currentProbe], 'i1')
    expect(Math.abs(v1 - 12) / 12).toBeLessThan(0.003)
    expect(classifyDcChannel(defined(sCh1.channel, 'ch1'), v1, i1).mode).toBe('CV')

    const v2 = defined(cvCc.values[sCh2.voltageProbe], 'v2')
    const i2 = defined(cvCc.values[sCh2.currentProbe], 'i2')
    expect(Math.abs(i2 - 0.5) / 0.5).toBeLessThan(0.01)
    expect(Math.abs(v2 - 5) / 5).toBeLessThan(0.01)
    expect(classifyDcChannel(defined(sCh2.channel, 'ch2'), v2, i2).mode).toBe('CC')

    const v5 = defined(cvCc.values[sV5.voltageProbe], 'v5')
    expect(Math.abs(v5 - 5) / 5).toBeLessThan(0.003)

    // 2) Series ±12 V dual-rail with CH1N tied to CH2P as common GND and tracking=1
    const modDual = testModule('mod-dual-rail', ['VP', 'GND', 'VN'], 'Rp VP GND 1k\nRn GND VN 1k')
    const dual = await runOp({
      title: 'T1.2 series dual rail',
      modules: [{ instanceId: 'D', ...modDual }],
      instruments: [{ instanceId: 'ps', instrument: dc, settings: { ch1_v: 12, tracking: 1 } }],
      wires: [
        { a: 'ps.CH1P', b: 'D.VP' },
        { a: 'ps.CH1N', b: 'D.GND' },
        { a: 'ps.CH2P', b: 'D.GND' },
        { a: 'ps.CH2N', b: 'D.VN' },
      ],
      ground: 'D.GND',
      controlValues: {},
      analysis: [],
    })
    const vpNode = defined(dual.plan.assembled.nodeOf['D.VP'], 'VP node')
    const vnNode = defined(dual.plan.assembled.nodeOf['D.VN'], 'VN node')
    expect(vpNode).not.toBe('0')
    expect(vnNode).not.toBe('0')
    const ch1Dual = defined(
      dual.plan.supplies.find((s) => s.screenId === 'CH1'),
      'ch1 dual',
    )
    const ch2Dual = defined(
      dual.plan.supplies.find((s) => s.screenId === 'CH2'),
      'ch2 dual',
    )
    expect(defined(dual.values[ch1Dual.voltageProbe], 'v+')).toBeCloseTo(12, 2)
    expect(defined(dual.values[ch2Dual.voltageProbe], 'v-')).toBeCloseTo(12, 2)
  })

  it('INS-07: constant current source delivers accurate current across 2/20/500 mA ranges and clamps at 30 V open circuit', async () => {
    for (const [isRange, isMa, rLoad] of [
      [0, 1.5, 1000], // 1.5 mA into 1 kΩ => 1.5 V
      [1, 15, 500], // 15 mA into 500 Ω => 7.5 V
      [2, 250, 40], // 250 mA into 40 Ω => 10.0 V
    ] as const) {
      const mod = testModule('mod-is-load', ['P', 'N'], `R1 P N ${rLoad}`)
      const res = await runOp({
        title: `T1.2 IS ${isMa}mA`,
        modules: [{ instanceId: 'M', ...mod }],
        instruments: [{ instanceId: 'ps', instrument: dc, settings: { is_range: isRange, is_ma: isMa } }],
        wires: [
          { a: 'ps.ISP', b: 'M.P' },
          { a: 'ps.ISN', b: 'M.N' },
        ],
        ground: 'ps.ISN',
        controlValues: {},
        analysis: [],
      })
      const isPlan = defined(
        res.plan.supplies.find((s) => s.screenId === 'IS'),
        'IS plan',
      )
      const v = defined(res.values[isPlan.voltageProbe], 'v_is')
      const i = defined(res.values[isPlan.currentProbe], 'i_is')
      const expectedA = isMa * 1e-3
      expect(Math.abs(i - expectedA) / expectedA).toBeLessThan(0.01)
      expect(Math.abs(v - expectedA * rLoad) / (expectedA * rLoad)).toBeLessThan(0.01)
      expect(classifyCurrentSource(defined(isPlan.currentSource, 'cs'), v, i, true).state).toBe('CC')
    }

    // Open-circuit compliance protection: 20 mA into 10 MΩ clamps at 30 V
    const modOpen = testModule('mod-is-open', ['P', 'N'], 'R1 P N 10Meg')
    const openRes = await runOp({
      title: 'T1.2 IS open',
      modules: [{ instanceId: 'M', ...modOpen }],
      instruments: [{ instanceId: 'ps', instrument: dc, settings: { is_range: 1, is_ma: 20 } }],
      wires: [
        { a: 'ps.ISP', b: 'M.P' },
        { a: 'ps.ISN', b: 'M.N' },
      ],
      ground: 'ps.ISN',
      controlValues: {},
      analysis: [],
    })
    const openPlan = defined(
      openRes.plan.supplies.find((s) => s.screenId === 'IS'),
      'open IS plan',
    )
    const vOpen = defined(openRes.values[openPlan.voltageProbe], 'vOpen')
    const iOpen = defined(openRes.values[openPlan.currentProbe], 'iOpen')
    expect(vOpen).toBeCloseTo(30, 1)
    expect(classifyCurrentSource(defined(openPlan.currentSource, 'csOpen'), vOpen, iOpen, true).state).toBe('OPEN')
  })

  it('SIM-04: 3-phase AC supply verifies √3 line/phase voltage, balanced Y neutral current ≈ 0, and unbalanced neutral shift', async () => {
    // 1) Balanced Y load (220 Ω per phase): U_phase = 220 V, U_line = 220*sqrt(3) ≈ 381.05 V, I_N ≈ 0
    const modY = testModule('mod-3ph-y', ['U', 'V', 'W', 'N0', 'N'], 'Ru U N0 220\nRv V N0 220\nRw W N0 220')
    const balY = await runTransientRms({
      title: 'T1.2 balanced Y',
      modules: [{ instanceId: 'Y', ...modY }],
      instruments: [
        { instanceId: 'ac', instrument: ac, settings: { u_phase: 220 } },
        { instanceId: 'vPhase', instrument: acv, settings: { range: 'r500' } },
        { instanceId: 'vLine', instrument: acv, settings: { range: 'r500' } },
        { instanceId: 'iNeutral', instrument: aca, settings: { range: 'r100m' } },
      ],
      wires: [
        { a: 'ac.U', b: 'Y.U' },
        { a: 'ac.V', b: 'Y.V' },
        { a: 'ac.W', b: 'Y.W' },
        { a: 'Y.N0', b: 'iNeutral.I' },
        { a: 'iNeutral.STAR', b: 'Y.N' },
        { a: 'Y.N', b: 'ac.N' },
        { a: 'Y.U', b: 'vPhase.U' },
        { a: 'Y.N', b: 'vPhase.STAR' },
        { a: 'Y.U', b: 'vLine.U' },
        { a: 'Y.V', b: 'vLine.STAR' },
      ],
      ground: 'ac.N',
      controlValues: {},
      analysis: [],
    })
    const mPhase = defined(
      balY.plan.meters.find((m) => m.instanceId === 'vPhase'),
      'vPhase',
    )
    const mLine = defined(
      balY.plan.meters.find((m) => m.instanceId === 'vLine'),
      'vLine',
    )
    const mNeutral = defined(
      balY.plan.meters.find((m) => m.instanceId === 'iNeutral'),
      'iNeutral',
    )
    const uPhase = defined(balY.rmsMap.get(defined(mPhase.voltageProbe, 'vp'))?.value, 'uPhase')
    const uLine = defined(balY.rmsMap.get(defined(mLine.voltageProbe, 'vl'))?.value, 'uLine')
    const iNeutral = defined(balY.rmsMap.get(defined(mNeutral.currentProbe, 'in'))?.value, 'iNeutralVal')
    expect(Math.abs(uPhase - 220) / 220).toBeLessThan(0.01)
    expect(Math.abs(uLine - 220 * Math.sqrt(3)) / (220 * Math.sqrt(3))).toBeLessThan(0.01)
    expect(Math.abs(uLine / uPhase - Math.sqrt(3)) / Math.sqrt(3)).toBeLessThan(0.01)
    expect(iNeutral).toBeLessThan(1e-4)

    // 2) Unbalanced Y load with neutral disconnected (Ru=110 Ω, Rv=220 Ω, Rw=440 Ω):
    //    Gu = 1/110, Gv = 1/220, Gw = 1/440 => Gu : Gv : Gw = 4 : 2 : 1
    //    V_N0 = 220 * (4*1 + 2*e^{-j120°} + 1*e^{+j120°}) / 7 = 220 * (4 - 1.5 - j*sqrt(3)/2) / 7
    //    |V_N0| = 220 * sqrt(2.5^2 + 0.75) / 7 = 220 * sqrt(7) / 7 = 220 / sqrt(7) ≈ 83.152 Vrms
    const modUnbal = testModule('mod-3ph-unbal', ['U', 'V', 'W', 'N0', 'N'], 'Ru U N0 110\nRv V N0 220\nRw W N0 440')
    const unbal = await runTransientRms({
      title: 'T1.2 unbalanced open neutral',
      modules: [{ instanceId: 'Y', ...modUnbal }],
      instruments: [
        { instanceId: 'ac', instrument: ac, settings: { u_phase: 220 } },
        { instanceId: 'vShift', instrument: acv, settings: { range: 'r500' } },
      ],
      wires: [
        { a: 'ac.U', b: 'Y.U' },
        { a: 'ac.V', b: 'Y.V' },
        { a: 'ac.W', b: 'Y.W' },
        { a: 'Y.N0', b: 'vShift.U' },
        { a: 'ac.N', b: 'vShift.STAR' },
      ],
      ground: 'ac.N',
      controlValues: {},
      analysis: [],
    })
    const mShift = defined(
      unbal.plan.meters.find((m) => m.instanceId === 'vShift'),
      'vShift',
    )
    const uShift = defined(unbal.rmsMap.get(defined(mShift.voltageProbe, 'vs'))?.value, 'uShift')
    const expectedShift = 220 / Math.sqrt(7)
    expect(Math.abs(uShift - expectedShift) / expectedShift).toBeLessThan(0.01)
  })
})
