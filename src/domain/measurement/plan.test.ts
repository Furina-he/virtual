import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SimCommandSchema } from '../../shared/ipc/sim.ts'
import { Instrument } from '../../shared/schema/instrument.ts'
import type { AssembleInput } from '../circuit/assemble.ts'
import { checkInstrumentJacks } from '../instruments/index.ts'
import { detectDanger } from '../wiring-check/index.ts'
import { buildMeasurementPlan, connectedInstrumentJacks, METER_RMS_WINDOW, METER_SAMPLE_STEP } from './plan.ts'

const load = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))
const mm = load('ins-multimeter')
const ps = load('ins-dc-power')

function input(range = 'dcv20', positive = 'VOHM'): AssembleInput {
  return {
    title: 'Learner wiring plan',
    modules: [],
    instruments: [
      { instanceId: 'source', instrument: ps, settings: { ch1_v: 6 } },
      { instanceId: 'student-meter', instrument: mm, settings: { range } },
    ],
    wires: [
      { a: `student-meter.${positive}`, b: 'source.CH1P' },
      { a: 'student-meter.COM', b: 'source.CH1N' },
    ],
    ground: 'source.CH1N',
    controlValues: {},
    analysis: [],
  }
}

describe('measurement plan', () => {
  it('compiles actual wires/settings into valid probes without modifying the learner graph', () => {
    const learner = input()
    const snapshot = JSON.stringify(learner)
    const plan = buildMeasurementPlan(learner, true, 'test1')
    expect(JSON.stringify(learner)).toBe(snapshot)
    expect(SimCommandSchema.safeParse(plan.command).success).toBe(true)
    expect(plan.command.analysis).toEqual({ kind: 'op' })
    expect(plan.meters[0]).toMatchObject({ instanceId: 'student-meter', voltageProbe: 'test1:student-meter:v' })
    expect(plan.command.probes.find((probe) => probe.id === plan.meters[0]?.voltageProbe)).toEqual({
      id: 'test1:student-meter:v',
      kind: 'v',
      node: plan.assembled.nodeOf['student-meter.VOHM'],
      nodeRef: '0',
    })
    expect(plan.needsPreflight).toBe(false)
    expect(plan.meters[0]?.currentProbe).toBeUndefined()
  })

  it('derives connected jacks from wire endpoints, not a UI-selected measurement point', () => {
    const learner = input()
    learner.wires[0] = { a: 'source.CH1P', b: 'student-meter.VOHM' }
    expect(connectedInstrumentJacks(learner, 'student-meter', mm)).toEqual(['COM', 'VOHM'])
    expect(connectedInstrumentJacks(learner, 'not-placed', mm)).toEqual([])
  })

  it.each(['dca20m', 'aca20m'])('uses a real selected current branch for %s', (range) => {
    const plan = buildMeasurementPlan(input(range, 'MA'), true, 'series')
    const meter = plan.meters[0]
    expect(meter?.currentProbe).toBe('series:student-meter:i')
    expect(plan.command.probes.find((probe) => probe.id === meter?.currentProbe)).toEqual({
      id: 'series:student-meter:i',
      kind: 'i',
      source: 'vsense_student_meter',
    })
    expect(plan.assembled.netlist).toContain('Vsense_student_meter')
    expect(
      plan.checkInput.instruments.find((entry) => entry.instanceId === 'student-meter')?.instrument.measure,
    ).toEqual({
      series: [['MA', 'COM']],
      voltage: [],
    })
  })

  it('uses range-aware topology to flag a current range placed across a supply', () => {
    expect(detectDanger(buildMeasurementPlan(input('dca20m', 'MA'), true, 'danger').checkInput)[0]?.code).toBe(
      'ammeter-across-source',
    )
    expect(detectDanger(buildMeasurementPlan(input('dcv20'), true, 'voltage').checkInput)).toEqual([])
  })

  it('does not request any nonexistent current branch on an unwired meter', () => {
    const learner = input('dca20m', 'MA')
    learner.wires = []
    const plan = buildMeasurementPlan(learner, true, 'unwired')
    expect(plan.assembled.instrumentSuffix['student-meter']).toBeUndefined()
    expect(plan.command.probes).toEqual([])
    expect(plan.meters[0]?.voltageProbe).toBeUndefined()
    expect(plan.meters[0]?.currentProbe).toBeUndefined()
    expect(plan.assembled.netlist).not.toContain('Vsense_student_meter')
  })

  it('keeps single-lead meters passive and explicitly disconnected', () => {
    const learner = input('dca20m', 'MA')
    learner.wires = learner.wires.slice(0, 1)
    const plan = buildMeasurementPlan(learner, true, 'onelead')
    const meter = plan.meters[0]
    expect(plan.assembled.netlist).toContain('Rpassive_student_meter')
    expect(meter?.voltageProbe).toBeUndefined()
    expect(meter?.currentProbe).toBeUndefined()
    expect(meter && checkInstrumentJacks(meter.config, meter.connectedJacks)?.status).toBe('disconnected')
  })

  it('a current range with voltage jacks connected neither stamps a shunt nor produces a fake reading', () => {
    const plan = buildMeasurementPlan(input('dca20m', 'VOHM'), true, 'wrong')
    const meter = plan.meters[0]
    expect(meter && checkInstrumentJacks(meter.config, meter.connectedJacks)?.status).toBe('wrong-jacks')
    expect(plan.assembled.netlist).toContain('Rpassive_student_meter')
    expect(plan.assembled.netlist).not.toContain('Rsh_student_meter')
    expect(meter?.currentProbe).toBeUndefined()
    expect(meter?.voltageProbe).toBeUndefined()
  })

  it('turning off external power disconnects its outputs instead of shorting the circuit with DC 0 sources', () => {
    const powered = buildMeasurementPlan(input('ohm200'), true, 'on', { preflight: true })
    const off = buildMeasurementPlan(input('ohm200'), false, 'off', { preflight: true })
    expect(powered.assembled.netlist).toContain('Vch1_source')
    expect(off.assembled.netlist).not.toContain('Vch1_source')
    expect(off.assembled.netlist).not.toContain('Rch1_source')
    expect(off.assembled.nodeOf).toEqual(powered.assembled.nodeOf)
    expect(off.command.probes.every((probe) => probe.kind !== 'i')).toBe(true)
  })

  it.each(['ohm200', 'diode', 'continuity'])(
    'requires a passive external-voltage check before enabling %s',
    (range) => {
      const learner = input(range)
      const initial = buildMeasurementPlan(learner, false, 'initial')
      expect(initial.needsPreflight).toBe(true)
      const preflight = buildMeasurementPlan(learner, false, 'preflight', { preflight: true })
      expect(preflight.assembled.netlist).not.toContain('Btest_student_meter')
      expect(preflight.assembled.netlist).toContain('Rpassive_student_meter')
      expect(preflight.meters[0]?.voltageProbe).toBeDefined()
      expect(preflight.meters[0]?.currentProbe).toBeUndefined()
      expect(preflight.command.analysis.kind).toBe('op')
      const blocked = buildMeasurementPlan(learner, true, 'blocked', { blockedTestIds: new Set(['student-meter']) })
      expect(blocked.assembled.netlist).not.toContain('Btest_student_meter')
      expect(blocked.assembled.netlist).not.toContain('Vtest_sense_student_meter')
      const safe = buildMeasurementPlan(learner, false, 'safe', { blockedTestIds: new Set() })
      expect(safe.assembled.netlist).toContain('Btest_student_meter')
      expect(safe.meters[0]?.currentProbe).toBe('safe:student-meter:i')
    },
  )

  it('does not start an internal battery measurement for incomplete or wrong probe connections', () => {
    const learner = input('ohm200', 'MA')
    const wrong = buildMeasurementPlan(learner, false, 'wrong')
    expect(wrong.needsPreflight).toBe(false)
    expect(wrong.assembled.netlist).not.toContain('Btest_student_meter')
    learner.wires = []
    const disconnected = buildMeasurementPlan(learner, false, 'disconnected')
    expect(disconnected.needsPreflight).toBe(false)
    expect(disconnected.command.probes).toEqual([])
  })

  it('requests equal-step transient samples for connected AC modes, and keeps preflight a DC operating point', () => {
    const plan = buildMeasurementPlan(input('acv20'), true, 'rms')
    expect(plan.command.analysis).toEqual({ kind: 'tran', step: METER_SAMPLE_STEP, continuous: true })
    expect(METER_RMS_WINDOW / METER_SAMPLE_STEP).toBe(2000)
    expect(buildMeasurementPlan(input('acv20'), true, 'preflight', { preflight: true }).command.analysis.kind).toBe(
      'op',
    )
    const learner = input('acv20')
    learner.wires = []
    expect(buildMeasurementPlan(learner, true, 'none').command.analysis.kind).toBe('op')
  })

  it('derives actual supply screen voltages and preserves per-channel node references', () => {
    const plan = buildMeasurementPlan(input(), true, 'supply')
    expect(plan.supplies.map((supply) => supply.screenId)).toEqual(['CH1', 'CH2'])
    for (const [index, supply] of plan.supplies.entries()) {
      const output = ps.outputs?.[index]
      expect(plan.command.probes.find((probe) => probe.id === supply.voltageProbe)).toMatchObject({
        kind: 'v',
        node: plan.assembled.nodeOf[`source.${output?.[0]}`],
        nodeRef: plan.assembled.nodeOf[`source.${output?.[1]}`],
      })
    }
  })
})
