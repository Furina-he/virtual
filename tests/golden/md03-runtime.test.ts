import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import { getInstrumentDefaults, measureSignal } from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan, moduleControlChanges, scopeProbeId } from '../../src/domain/measurement/plan.ts'
import type { Probe, SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const board = Module.parse(load('content/modules/mod-analog-amp/module.json'))
const subckt = expandLocalLibraries(readFileSync('content/modules/mod-analog-amp/module.cir', 'utf8'), {
  'bjt.lib': readFileSync('content/models/spice/bjt.lib', 'utf8'),
})
const instrument = (id: string) => Instrument.parse(load(`content/instruments/${id}/instrument.json`))
const power = instrument('ins-dc-power')
const generator = instrument('ins-func-gen')
const scope = instrument('ins-oscilloscope')

function plan(rw: number, kce: number) {
  const next = buildMeasurementPlan(
    {
      title: 'MD03 production parameter continuity',
      modules: [{ instanceId: 'amp1', module: board, subckt }],
      instruments: [
        { instanceId: 'power', instrument: power, settings: { ...getInstrumentDefaults(power), ch1_v: 12 } },
        {
          instanceId: 'gen',
          instrument: generator,
          settings: { ...getInstrumentDefaults(generator), ch1_freq: 1000, ch1_amp: 0.1, ch2_on: 0 },
        },
        { instanceId: 'scope1', instrument: scope, settings: { ...getInstrumentDefaults(scope), out_on: 0 } },
      ],
      wires: [
        { a: 'power.CH1P', b: 'amp1.AMP_VCC' },
        { a: 'power.CH1N', b: 'amp1.AMP_GND1' },
        { a: 'gen.CH1', b: 'amp1.AMP_US' },
        { a: 'gen.GND', b: 'amp1.AMP_GND2' },
        { a: 'amp1.AMP_UO', b: 'amp1.AMP_RL' },
        { a: 'scope1.CH1', b: 'amp1.AMP_UC' },
        { a: 'scope1.CH2', b: 'amp1.AMP_UE' },
        { a: 'scope1.GND', b: 'amp1.AMP_GND2' },
      ],
      controlValues: { 'amp1.RW': rw, 'amp1.KCE': kce },
      ground: 'amp1.AMP_GND1',
      analysis: [],
    },
    true,
    'md03-runtime',
  )
  const ground = next.assembled.nodeOf['amp1.AMP_GND1'] as string
  const diagnostics: Probe[] = [
    { id: 'diag:b', kind: 'v', node: next.assembled.nodeOf['amp1.AMP_UB'], nodeRef: ground },
    { id: 'diag:ui', kind: 'v', node: next.assembled.nodeOf['amp1.AMP_UI'], nodeRef: ground },
    // These are actual ngspice nodes, test-only diagnostics rather than learner measurement records.
    { id: 'diag:ce', kind: 'v', node: 'xamp1.n_ce', nodeRef: ground },
    { id: 'diag:sin', kind: 'v', node: 's_ch1_gen', nodeRef: next.assembled.nodeOf['gen.GND'] },
  ]
  return { ...next, command: { ...next.command, probes: [...next.command.probes, ...diagnostics] } }
}

it('MD03 actual RW/KCE targets preserve one production session, capacitor voltages and absolute source phase', async () => {
  let current = plan(22000, 1)
  let loaded = 0
  let expectedSeq = 0
  let expectedTime = 0
  let maxPhaseError = 0
  let initialCaps: { c1: number; ce: number } | undefined
  let lastCaps: { c1: number; ce: number } | undefined
  let boundary: { requestId: string; before: { c1: number; ce: number } } | undefined
  const failures: string[] = []
  const acknowledgements: string[] = []
  const jumps: { requestId: string; c1: number; ce: number }[] = []
  const caps = (data: Record<string, Float32Array>, index: number) => ({
    c1: (data['diag:b']?.[index] ?? Number.NaN) - (data['diag:ui']?.[index] ?? Number.NaN),
    ce: data['diag:ce']?.[index] ?? Number.NaN,
  })
  const session = new SimSession(
    resolve(import.meta.dirname, '../../resources/ngspice'),
    (event: SimEvent) => {
      if (event.type === 'error') failures.push(event.message)
      if (event.type === 'loaded') loaded++
      if (event.type === 'altered') {
        acknowledgements.push(event.requestId ?? '')
        if (lastCaps) boundary = { requestId: event.requestId ?? '', before: lastCaps }
      }
      if (event.type !== 'chunk') return
      const count = event.data['diag:sin']?.length ?? 0
      if (event.seq !== expectedSeq || Math.abs(event.t0 - expectedTime) > 1e-9)
        failures.push('Noncontinuous chunk sequence/time')
      expectedSeq = event.seq + 1
      expectedTime = event.t0 + count * event.dt
      if (boundary) {
        const after = caps(event.data, 0)
        jumps.push({
          requestId: boundary.requestId,
          c1: Math.abs(after.c1 - boundary.before.c1),
          ce: Math.abs(after.ce - boundary.before.ce),
        })
        boundary = undefined
      }
      lastCaps = caps(event.data, count - 1)
      initialCaps ??= lastCaps
      for (let i = 0; i < count; i++) {
        const expected = 0.05 * Math.sin(2 * Math.PI * 1000 * (event.t0 + i * event.dt))
        maxPhaseError = Math.max(maxPhaseError, Math.abs((event.data['diag:sin']?.[i] ?? Number.NaN) - expected))
      }
      const c = event.data[scopeProbeId('scope1', 'CH1')]
      const e = event.data[scopeProbeId('scope1', 'CH2')]
      if (c && e) {
        const differential = c.map((value, i) => value - (e[i] as number))
        if (!measureSignal(differential, event.dt)) failures.push('Invalid same-time physical C/E differential')
      }
    },
    () => failures.push('Native simulator exited'),
  )
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 8000
    while (!predicate()) {
      if (failures.length) throw new Error(failures.join('; '))
      if (Date.now() > deadline) throw new Error('MD03 production simulation did not return expected samples')
      await new Promise((done) => setTimeout(done, 5))
    }
  }
  try {
    session.handle(current.command)
    session.handle(current.pacing)
    session.handle({ type: 'run' })
    await waitFor(() => initialCaps !== undefined)
    expect(initialCaps?.c1).toBeGreaterThan(2.5)
    expect(initialCaps?.ce).toBeGreaterThan(1)
    for (const [index, settings] of [
      [18000, 1],
      [100000, 1],
      [100000, 0],
      [100000, 1],
    ].entries()) {
      const next = plan(settings[0] as number, settings[1] as number)
      const changes = moduleControlChanges(current, next)
      expect(changes?.length).toBe(1)
      expect(changes?.[0]?.targets?.length).toBe(1)
      const requestId = `md03-direct-${index}`
      session.handle({ type: 'alter', requestId, changes: changes as NonNullable<typeof changes> })
      await waitFor(() => jumps.some((jump) => jump.requestId === requestId))
      current = next
    }
    expect(loaded).toBe(1)
    expect(acknowledgements).toEqual(['md03-direct-0', 'md03-direct-1', 'md03-direct-2', 'md03-direct-3'])
    expect(failures).toEqual([])
    expect(maxPhaseError).toBeLessThan(1e-5)
    for (const jump of jumps) {
      expect(jump.c1).toBeLessThan(0.02)
      expect(jump.ce).toBeLessThan(0.02)
    }
    console.log(
      `MD03 production direct R proof: loaded=${loaded}, chunks=${expectedSeq}, end=${expectedTime}, phaseMaxError=${maxPhaseError}, capJumps=${JSON.stringify(jumps)}`,
    )
  } finally {
    session.handle({ type: 'pause' })
    const deadline = Date.now() + 3000
    while (Reflect.get(session, 'bgRunning') && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
    await new Promise<void>((done) => setImmediate(done))
    session.dispose()
  }
}, 20000)
