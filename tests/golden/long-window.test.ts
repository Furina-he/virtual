import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { LongWindow } from '../../src/domain/instruments/long-window.ts'
import { buildMeasurementPlan, scopeProbeId } from '../../src/domain/measurement/plan.ts'
import { ToneTracker } from '../../src/shared/audio/tone.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// Generic real sources verify the public sampling contract, not either project's dedicated siren content.
const module = Module.parse({
  id: 'mod-long-cycle-fixture',
  name: 'Shared long-cycle fixture',
  form: 'board',
  model: 'fixture.glb',
  netlist: 'fixture.cir',
  jacks: ['SLOW', 'FAST', 'REF', 'GND'].map((id) => ({ id, label: id, kind: 'banana4' })),
  simulation: { analysis: 'tran', maxStep: 2e-6, pacing: 'realtime' },
  indicators: [{ id: 'sound', kind: 'speaker', between: ['FAST', 'REF'], audio: { fullScale: 5 } }],
})
const scope = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-oscilloscope/instrument.json', 'utf8')))

it('observes genuine 1 Hz and audio on one realtime <=2us session with fixed memory and two complete cycles', async () => {
  const plan = buildMeasurementPlan(
    {
      title: 'Shared realtime long-cycle metrology',
      modules: [
        {
          instanceId: 'box1',
          module,
          subckt:
            '.subckt LONG_FIXTURE SLOW FAST REF GND\nVslow SLOW GND SIN(0 1 1)\nVfast FAST GND SIN(0 1 1025)\nVref REF GND 0.5\n.ends LONG_FIXTURE',
        },
      ],
      instruments: [{ instanceId: 'scope1', instrument: scope, settings: { tdiv: 0.2 } }],
      wires: [
        { a: 'box1.SLOW', b: 'scope1.CH1' },
        { a: 'box1.FAST', b: 'scope1.CH2' },
        { a: 'box1.GND', b: 'scope1.GND' },
      ],
      controlValues: {},
      ground: 'box1.GND',
      analysis: [],
    },
    true,
    'bounded',
  )
  expect(plan.command.analysis).toEqual({ kind: 'tran', step: 2e-6, continuous: true })
  expect(plan.pacing).toEqual({ type: 'setPacing', mode: 'realtime' })
  const slowId = scopeProbeId('scope1', 'CH1')
  const fastId = scopeProbeId('scope1', 'CH2')
  const speakerId = plan.speakers[0]?.probe as string
  expect(plan.command.probes.find((probe) => probe.id === speakerId)?.nodeRef).not.toBe('0')
  const slow = new LongWindow()
  const fast = new LongWindow()
  const tracker = new ToneTracker()
  let lastTone = 0
  let end = 0
  let chunks = 0
  let loaded = 0
  const errors: string[] = []
  const began = performance.now()
  const session = new SimSession(
    resolve(import.meta.dirname, '../../resources/ngspice'),
    (event: SimEvent) => {
      if (event.type === 'error') errors.push(event.message)
      if (event.type === 'loaded') loaded++
      if (event.type !== 'chunk') return
      expect(event.seq).toBe(chunks++)
      const low = event.data[slowId] as Float32Array
      const high = event.data[fastId] as Float32Array
      slow.push(low, event.t0, event.dt)
      fast.push(high, event.t0, event.dt)
      const frames = tracker.push(event.data[speakerId] as Float32Array, event.t0, event.dt)
      if (frames.length) lastTone = frames.at(-1)?.f0 ?? 0
      end = event.t0 + low.length * event.dt
    },
    () => errors.push('Native session exited'),
  )
  try {
    session.handle(plan.command)
    session.handle(plan.pacing)
    session.handle({ type: 'run' })
    await expect.poll(() => end, { timeout: 4000 }).toBeGreaterThan(3.2)
    session.handle({ type: 'pause' })
    await new Promise((done) => setTimeout(done, 60))
    expect(errors).toEqual([])
    expect(loaded).toBe(1)
    expect(end / ((performance.now() - began) / 1000)).toBeLessThan(1.05)
    expect(Math.abs((slow.snapshot(4).measurement?.frequency ?? 0) - 1)).toBeLessThan(0.01)
    expect(slow.snapshot(4).window.completeCycles).toBeGreaterThanOrEqual(2)
    expect(Math.abs((fast.snapshot(4).measurement?.frequency ?? 0) / 1025 - 1)).toBeLessThan(0.01)
    expect(Math.abs(lastTone / 1025 - 1)).toBeLessThan(0.01)
    const arrays = Object.values(slow).filter((value) => ArrayBuffer.isView(value))
    expect(arrays.reduce((bytes, array) => bytes + array.byteLength, 0)).toBeLessThan(128 * 1024)
    expect(slow.traces(4)?.min.length).toBeLessThanOrEqual(2048)
    console.log(
      `Bounded native metrology: ${chunks} chunks, sim ${end.toFixed(3)}s, slow ${slow.snapshot(4).measurement?.frequency}Hz, audio ${lastTone.toFixed(3)}Hz, observation below128KiB`,
    )
  } finally {
    session.handle({ type: 'pause' })
    session.dispose()
  }
})
