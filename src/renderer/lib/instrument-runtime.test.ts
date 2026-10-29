import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstrumentInput } from '../../domain/circuit/assemble'
import { getInstrumentDefaults } from '../../domain/instruments'
import type { SimCommand, SimEvent } from '../../shared/ipc/sim'
import type { CircuitState } from '../../shared/schema/circuit'
import { Instrument } from '../../shared/schema/instrument'
import { Module } from '../../shared/schema/module'
import { getInstrumentReading, instrumentReadings } from './instrument-readings'
import { connectInstrumentRuntime, currentMeasurementSnapshot } from './instrument-runtime'
import { RingBuffer } from './ring-buffer'

type LowFreqEvent = Exclude<SimEvent, { type: 'chunk' }>
type SamplesListener = (samples: Float32Array, t0: number, dt: number) => void

const fixture = vi.hoisted(() => ({
  state: undefined as unknown as CircuitState,
  instruments: [] as InstrumentInput[],
  modules: [] as { id: string }[],
  netlist: '',
  events: new Set<(event: LowFreqEvent) => void>(),
  restarts: new Set<() => void>(),
  changes: new Set<(state: CircuitState) => void>(),
  samples: new Map<string, Set<SamplesListener>>(),
  sim: undefined as unknown as {
    send: (command: SimCommand) => Promise<void>
    buffer: (id: string) => RingBuffer
    onEvent: (listener: (event: LowFreqEvent) => void) => () => void
    onRestarted: (listener: () => void) => () => void
    onSamples: (id: string, listener: SamplesListener) => () => void
  },
}))

vi.mock('./sim-client', () => ({ getSimClient: () => fixture.sim }))
vi.mock('../features/practice/practice-content', () => ({
  moduleCatalog: fixture.modules,
  moduleNetlist: () => fixture.netlist,
}))
vi.mock('../features/practice/instrument-settings', () => ({
  benchInstruments: () => fixture.instruments,
  setBenchInstrumentSettings: vi.fn(),
}))
vi.mock('../features/practice/wiring-state', () => ({
  getActivePlacements: () => fixture.modules.map((module) => ({ instanceId: 'box1', assetId: module.id })),
  circuitStore: {
    getState: () => fixture.state,
    subscribe: (listener: (state: CircuitState) => void) => {
      fixture.changes.add(listener)
      return () => fixture.changes.delete(listener)
    },
    setState: (patch: Partial<CircuitState>) => {
      fixture.state = { ...fixture.state, ...patch }
      for (const listener of fixture.changes) listener(fixture.state)
    },
  },
}))
vi.mock('../stores/instrument-panels', () => ({ connectInstrumentPanels: () => () => {} }))

const load = (id: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${id}/instrument.json`, 'utf8')))
const gen = load('ins-func-gen')
const scope = load('ins-oscilloscope')
const meter = load('ins-multimeter')
let disconnect: (() => void) | undefined

function useModule(transient = true) {
  fixture.modules.push(
    Module.parse({
      id: 'mod-runtime-test',
      name: 'Runtime parameter fixture',
      form: 'board',
      model: 'test.glb',
      netlist: 'test.cir',
      jacks: [
        { id: 'P', label: '+', kind: 'banana4' },
        { id: 'N', label: '-', kind: 'banana4' },
      ],
      controls: [
        {
          id: 'RP',
          kind: 'pot',
          param: 'rp',
          range: [1, 10_000],
          unit: 'Ω',
          default: 1000,
          targets: [{ element: 'R1' }],
        },
      ],
      ...(transient ? { simulation: { analysis: 'tran', maxStep: 1e-4 } } : {}),
    }),
  )
  fixture.netlist = '.subckt runtime_test P N params: rp=1000\nR1 P N {rp}\n.ends runtime_test'
}

function changeControl(value: number) {
  fixture.state = { ...fixture.state, controlValues: { ...fixture.state.controlValues, 'box1.RP': value } }
  for (const listener of fixture.changes) listener(fixture.state)
}

function latestAlter() {
  const command = vi
    .mocked(fixture.sim.send)
    .mock.calls.filter(([entry]) => entry.type === 'alter')
    .at(-1)?.[0]
  if (command?.type !== 'alter') throw new Error('Missing live module alteration')
  return command
}

function emit(event: LowFreqEvent) {
  for (const listener of fixture.events) listener(event)
}

function chunk(id: string, data: Float32Array, t0: number, dt: number) {
  fixture.sim.buffer(id).push(data, t0, dt)
  for (const listener of fixture.samples.get(id) ?? []) listener(data, t0, dt)
}

async function start() {
  disconnect = connectInstrumentRuntime(vi.fn())
  await vi.advanceTimersByTimeAsync(40)
  const command = vi.mocked(fixture.sim.send).mock.calls.find(([entry]) => entry.type === 'load')?.[0]
  if (command?.type !== 'load') throw new Error('Missing measurement load')
  emit({ type: 'loaded', vectors: command.probes.map((probe) => probe.id) })
  return command
}

beforeEach(() => {
  vi.useFakeTimers()
  fixture.events.clear()
  fixture.restarts.clear()
  fixture.changes.clear()
  fixture.samples.clear()
  fixture.modules.length = 0
  fixture.netlist = ''
  fixture.instruments = [
    { instanceId: 'gen1', instrument: gen, settings: { ...getInstrumentDefaults(gen), ch1_freq: 5000 } },
    { instanceId: 'scope1', instrument: scope, settings: getInstrumentDefaults(scope) },
    { instanceId: 'meter1', instrument: meter, settings: { range: 'acv20' } },
  ]
  fixture.state = {
    powered: true,
    placedInstruments: [],
    controlValues: {},
    wires: [
      { id: 'w1', a: 'gen1.CH1', b: 'scope1.CH1', color: 'red' },
      { id: 'w2', a: 'gen1.GND', b: 'scope1.GND', color: 'black' },
      { id: 'w3', a: 'gen1.CH1', b: 'meter1.VOHM', color: 'red' },
      { id: 'w4', a: 'gen1.GND', b: 'meter1.COM', color: 'black' },
    ],
  }
  const buffers = new Map<string, RingBuffer>()
  fixture.sim = {
    send: vi.fn(async () => {}),
    buffer(id) {
      let buffer = buffers.get(id)
      if (!buffer) {
        buffer = new RingBuffer(1 << 18)
        buffers.set(id, buffer)
      }
      return buffer
    },
    onEvent(listener) {
      fixture.events.add(listener)
      return () => fixture.events.delete(listener)
    },
    onRestarted(listener) {
      fixture.restarts.add(listener)
      return () => fixture.restarts.delete(listener)
    },
    onSamples(id, listener) {
      let listeners = fixture.samples.get(id)
      if (!listeners) {
        listeners = new Set()
        fixture.samples.set(id, listeners)
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})

afterEach(() => {
  disconnect?.()
  disconnect = undefined
  instrumentReadings.dispose()
  vi.useRealTimers()
})

describe('instrument runtime integration', () => {
  it('updates only numeric module parameters without reloading or replacing live subscriptions', async () => {
    useModule()
    const command = await start()
    const values = Object.fromEntries(command.probes.map((probe) => [probe.id, 1]))
    emit({ type: 'readings', simTime: 0.2, values })
    const originalPlan = currentMeasurementSnapshot()?.plan
    const originalListeners = [...fixture.samples.values()].map((group) => [...group])
    changeControl(2000)
    const update = latestAlter()
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    expect(update.changes).toEqual([
      { param: 'p_box1_rp', value: 2000, targets: [{ element: 'r.xbox1.r1', value: 2000 }] },
    ])
    expect(vi.mocked(fixture.sim.send).mock.calls.filter(([entry]) => entry.type === 'load')).toHaveLength(1)
    expect(currentMeasurementSnapshot()?.plan.command.probes).toEqual(originalPlan?.command.probes)
    expect([...fixture.samples.values()].map((group) => [...group])).toEqual(originalListeners)
    emit({ type: 'readings', simTime: 0.3, values })
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    emit({ type: 'altered', requestId: update.requestId, changes: update.changes, simTime: 0.3 })
    emit({ type: 'readings', simTime: 0.3, values })
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    emit({ type: 'readings', simTime: 0.35, values })
    expect(currentMeasurementSnapshot()?.current).toBe(true)
    expect(getInstrumentReading('meter1').status).toBe('pending')
  })

  it('uses a correlated acknowledgement followed by OP output for a DC module alteration', async () => {
    useModule(false)
    fixture.instruments = [{ instanceId: 'meter1', instrument: meter, settings: { range: 'dcv20' } }]
    fixture.state.wires = [
      { id: 'w1', a: 'box1.P', b: 'meter1.VOHM', color: 'red' },
      { id: 'w2', a: 'box1.N', b: 'meter1.COM', color: 'black' },
    ]
    const command = await start()
    expect(command.analysis.kind).toBe('op')
    const values = Object.fromEntries(command.probes.map((probe) => [probe.id, 2]))
    emit({ type: 'op', values })
    expect(currentMeasurementSnapshot()?.current).toBe(true)
    changeControl(2000)
    const update = latestAlter()
    emit({ type: 'op', values })
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    emit({ type: 'altered', requestId: update.requestId, changes: update.changes, simTime: 0 })
    emit({ type: 'op', values: Object.fromEntries(command.probes.map((probe) => [probe.id, 3])) })
    expect(currentMeasurementSnapshot()?.current).toBe(true)
    expect(currentMeasurementSnapshot()?.readings.meter1).toMatchObject({ status: 'ok', value: 3 })
    expect(vi.mocked(fixture.sim.send).mock.calls.filter(([entry]) => entry.type === 'load')).toHaveLength(1)
  })

  it('never allows an old successful request to acknowledge a newer control change', async () => {
    useModule()
    const command = await start()
    const values = Object.fromEntries(command.probes.map((probe) => [probe.id, 1]))
    changeControl(2000)
    const first = latestAlter()
    changeControl(3000)
    const second = latestAlter()
    emit({ type: 'altered', requestId: first.requestId, changes: first.changes, simTime: 0.1 })
    emit({ type: 'readings', simTime: 0.2, values })
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    emit({ type: 'altered', requestId: second.requestId, changes: second.changes, simTime: 0.2 })
    emit({ type: 'readings', simTime: 0.25, values })
    expect(currentMeasurementSnapshot()?.current).toBe(true)
  })

  it('clears a current stopped session even when an older in-flight request reports the failure', async () => {
    useModule()
    await start()
    changeControl(2000)
    const first = latestAlter()
    changeControl(3000)
    emit({ type: 'error', requestId: first.requestId, code: 'model', message: 'Parameter failed' })
    expect(fixture.state.powered).toBe(false)
    expect(currentMeasurementSnapshot()).toBeUndefined()
    expect([...fixture.samples.values()].every((group) => group.size === 0)).toBe(true)
  })

  it('captures a live wired scope channel only from post-ack samples and rejects disabled/frozen acquisition', async () => {
    useModule()
    const command = await start()
    if (command.analysis.kind !== 'tran') throw new Error('Missing transient')
    const probe = command.probes.find((entry) => entry.id === 'scope:scope1:CH1')
    if (!probe) throw new Error('Missing scope probe')
    const dt = command.analysis.step
    chunk(
      probe.id,
      Float32Array.from({ length: 20_000 }, (_, i) => 4 + Math.sin(2 * Math.PI * 5000 * i * dt)),
      0,
      dt,
    )
    const values = Object.fromEntries(command.probes.map((entry) => [entry.id, 1]))
    emit({ type: 'readings', simTime: 0.1, values })
    expect(currentMeasurementSnapshot()?.waveforms?.[0]).toMatchObject({
      current: true,
      positiveRef: 'scope1.CH1',
      negativeRef: 'scope1.GND',
      measurement: { vpp: 2 },
    })
    changeControl(2000)
    const update = latestAlter()
    emit({ type: 'altered', requestId: update.requestId, changes: update.changes, simTime: 0.1 })
    emit({ type: 'readings', simTime: 0.11, values })
    expect(currentMeasurementSnapshot()?.waveforms?.[0]?.current).toBe(false)
    chunk(
      probe.id,
      Float32Array.from({ length: 20_000 }, (_, i) => 1 + 3 * Math.sin(2 * Math.PI * 5000 * i * dt)),
      0.12,
      dt,
    )
    emit({ type: 'readings', simTime: 0.13, values })
    expect(currentMeasurementSnapshot()?.waveforms?.[0]).toMatchObject({ current: true, measurement: { vpp: 6 } })
    fixture.instruments = fixture.instruments.map((entry) =>
      entry.instanceId === 'scope1' ? { ...entry, settings: { ...entry.settings, run: 0 } } : entry,
    )
    changeControl(2000)
    expect(currentMeasurementSnapshot()?.waveforms?.[0]?.current).toBe(false)
  })

  it('records synchronized DC channel differences without moving the scope ground away from circuit ground', async () => {
    useModule()
    fixture.state.wires.push({ id: 'scope2', a: 'scope1.CH2', b: 'gen1.CH1', color: 'red' })
    const command = await start()
    if (command.analysis.kind !== 'tran') throw new Error('Missing transient')
    const dt = command.analysis.step
    const count = 20000
    const ripple = (i: number) => Math.sin(2 * Math.PI * 5000 * i * dt)
    chunk(
      'scope:scope1:CH1',
      Float32Array.from({ length: count }, (_, i) => 3 + 0.5 * ripple(i)),
      0,
      dt,
    )
    chunk(
      'scope:scope1:CH2',
      Float32Array.from({ length: count }, (_, i) => 2.8 + 0.4 * ripple(i)),
      0,
      dt,
    )
    emit({ type: 'readings', simTime: 0.1, values: Object.fromEntries(command.probes.map((entry) => [entry.id, 1])) })
    const difference = currentMeasurementSnapshot()?.waveforms?.find((entry) => entry.channelId === 'CH1-CH2')
    expect(difference).toMatchObject({
      current: true,
      coupling: 'dc',
      positiveRef: 'scope1.CH1',
      negativeRef: 'scope1.CH2',
    })
    expect(difference?.measurement?.min).toBeCloseTo(0.1, 5)
    expect(difference?.measurement?.max).toBeCloseTo(0.3, 5)
    fixture.instruments = fixture.instruments.map((entry) =>
      entry.instanceId === 'scope1' ? { ...entry, settings: { ...entry.settings, ch2_coupling: 1 } } : entry,
    )
    changeControl(1000)
    expect(currentMeasurementSnapshot()?.waveforms?.some((entry) => entry.channelId === 'CH1-CH2')).toBe(false)
  })

  it('exposes only the currently published job and invalidates captures synchronously on a range change', async () => {
    const command = await start()
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    emit({ type: 'readings', simTime: 0.1, values: Object.fromEntries(command.probes.map((probe) => [probe.id, 0])) })
    expect(currentMeasurementSnapshot()?.current).toBe(true)
    expect(currentMeasurementSnapshot()?.readings.meter1?.status).toBe('pending')

    fixture.instruments = fixture.instruments.map((entry) =>
      entry.instanceId === 'meter1' ? { ...entry, settings: { range: 'dcv20' } } : entry,
    )
    fixture.state = { ...fixture.state, controlValues: { changed: 1 } }
    for (const listener of fixture.changes) listener(fixture.state)
    expect(currentMeasurementSnapshot()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(40)
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    const next = vi
      .mocked(fixture.sim.send)
      .mock.calls.filter(([entry]) => entry.type === 'load')
      .at(-1)?.[0]
    if (next?.type !== 'load') throw new Error('Missing reloaded measurement plan')
    emit({ type: 'loaded', vectors: next.probes.map((probe) => probe.id) })
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    const values = Object.fromEntries(next.probes.map((probe) => [probe.id, 3]))
    emit({ type: 'readings', simTime: 0.1, values })
    expect(currentMeasurementSnapshot()?.current).toBe(true)
    expect(currentMeasurementSnapshot()?.readings.meter1).toMatchObject({ status: 'ok', value: 3 })
    disconnect?.()
    disconnect = undefined
    expect(currentMeasurementSnapshot()).toBeUndefined()
  })

  it('publishes a full AC RMS window even when it exceeds the waveform ring capacity', async () => {
    const command = await start()
    expect(command.analysis).toMatchObject({ kind: 'tran', step: 2e-7 })
    const probe = command.probes.find((entry) => entry.id.includes('meter1') && entry.kind === 'v')
    if (!probe || command.analysis.kind !== 'tran') throw new Error('Missing AC voltage probe')
    const dt = command.analysis.step
    const values = Object.fromEntries(command.probes.map((entry) => [entry.id, 0]))
    const size = Math.round(0.05 / dt)
    for (let block = 0; block < 4; block++) {
      const t0 = block * size * dt
      chunk(
        probe.id,
        Float32Array.from({ length: size }, (_, i) => 3 + Math.sin(2 * Math.PI * 5000 * (t0 + i * dt))),
        t0,
        dt,
      )
      emit({ type: 'readings', simTime: (block + 1) * 0.05, values })
      if (block < 3) expect(getInstrumentReading('meter1').status).toBe('pending')
    }
    expect(fixture.sim.buffer(probe.id).written).toBe(1_000_000)
    expect(fixture.sim.buffer(probe.id).length).toBe(262_144)
    expect(getInstrumentReading('meter1')).toMatchObject({ status: 'ok', text: '0.71', unit: 'V' })
    expect(getInstrumentReading('meter1').rawValue).toBeCloseTo(Math.SQRT1_2, 5)
    emit({ type: 'loaded', vectors: command.probes.map((entry) => entry.id) })
    emit({ type: 'readings', simTime: 0, values })
    expect(getInstrumentReading('meter1').status).toBe('pending')
    disconnect?.()
    disconnect = undefined
    expect([...fixture.samples.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })

  it('replays scope window pacing after the simulation process restarts', async () => {
    const command = await start()
    expect(command.analysis.kind).toBe('tran')
    vi.mocked(fixture.sim.send).mockClear()
    for (const listener of fixture.restarts) listener()
    await vi.advanceTimersByTimeAsync(40)
    expect(vi.mocked(fixture.sim.send).mock.calls.map(([entry]) => entry.type)).toEqual(['load', 'setPacing', 'run'])
    expect(fixture.sim.send).toHaveBeenCalledWith({ type: 'setPacing', mode: 'window', windowSec: 0.002 })
  })

  it('shows connection guidance for a placed scope with no connected jacks', async () => {
    fixture.state.wires = fixture.state.wires.filter(
      (wire) => !wire.a.startsWith('scope1.') && !wire.b.startsWith('scope1.'),
    )
    const command = await start()
    expect(command.probes.some((probe) => probe.id.startsWith('scope:'))).toBe(false)
    expect(getInstrumentReading('scope1')).toMatchObject({ status: 'disconnected' })
    expect(getInstrumentReading('scope1').message).toContain('GND')
    emit({ type: 'readings', simTime: 0, values: Object.fromEntries(command.probes.map((probe) => [probe.id, 0])) })
    expect(getInstrumentReading('scope1', 'CH1').status).toBe('disconnected')
    expect(getInstrumentReading('scope1', 'CH2').status).toBe('disconnected')
    expect(getInstrumentReading('scope1').message).toContain('GND')
  })
})
