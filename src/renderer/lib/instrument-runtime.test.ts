import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstrumentInput } from '../../domain/circuit/assemble'
import { getInstrumentDefaults } from '../../domain/instruments'
import { LongWindow } from '../../domain/instruments/long-window'
import type { MeasurementSnapshot } from '../../domain/task'
import type { SimCommand, SimEvent } from '../../shared/ipc/sim'
import type { CircuitState } from '../../shared/schema/circuit'
import { Instrument } from '../../shared/schema/instrument'
import { Module } from '../../shared/schema/module'
import { getInstrumentReading, instrumentReadings } from './instrument-readings'
import { connectInstrumentRuntime, currentMeasurementSnapshot, type RuntimeStatus } from './instrument-runtime'
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
  buffers: new Map<string, RingBuffer>(),
  observations: new Map<string, LongWindow>(),
  sim: undefined as unknown as {
    send: (command: SimCommand) => Promise<void>
    buffer: (id: string) => RingBuffer
    observation?: (id: string) => LongWindow
    onEvent: (listener: (event: LowFreqEvent) => void) => () => void
    onRestarted: (listener: () => void) => () => void
    onSamples: (id: string, listener: SamplesListener) => () => void
  },
}))
const sound = vi.hoisted(() => ({
  outputs: [] as { feed: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
  contexts: [] as { resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
  create: vi.fn(),
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
vi.mock('./audio/sim-audio', () => ({ SimAudioOutput: { create: sound.create } }))

const load = (id: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${id}/instrument.json`, 'utf8')))
const gen = load('ins-func-gen')
const scope = load('ins-oscilloscope')
const meter = load('ins-multimeter')
let disconnect: (() => void) | undefined

function useModule(transient = true, speaker = false) {
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
      ...(speaker
        ? { indicators: [{ id: 'sound', kind: 'speaker', between: ['P', 'N'], audio: { fullScale: 5 } }] }
        : {}),
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
  if (fixture.sim.observation) {
    if (event.type === 'loaded') {
      for (const buffer of fixture.buffers.values()) buffer.clear()
      fixture.buffers.clear()
      for (const observation of fixture.observations.values()) observation.clear()
      fixture.observations.clear()
    } else if (event.type === 'altered') {
      for (const observation of fixture.observations.values()) observation.clear()
    }
  }
  for (const listener of fixture.events) listener(event)
}

function chunk(id: string, data: Float32Array, t0: number, dt: number) {
  fixture.sim.buffer(id).push(data, t0, dt)
  if (id.startsWith('scope:')) fixture.sim.observation?.(id).push(data, t0, dt)
  for (const listener of fixture.samples.get(id) ?? []) listener(data, t0, dt)
}

async function start() {
  disconnect = connectInstrumentRuntime(vi.fn())
  await vi.advanceTimersByTimeAsync(40)
  const command = vi.mocked(fixture.sim.send).mock.calls.find(([entry]) => entry.type === 'load')?.[0]
  if (command?.type !== 'load') throw new Error('Missing measurement load')
  emit({ type: 'loaded', requestId: command.requestId, vectors: command.probes.map((probe) => probe.id) })
  await vi.advanceTimersByTimeAsync(0)
  return command
}

function latestLoad() {
  const command = vi
    .mocked(fixture.sim.send)
    .mock.calls.filter(([entry]) => entry.type === 'load')
    .at(-1)?.[0]
  if (command?.type !== 'load') throw new Error('Missing measurement load')
  return command
}

function acknowledgeLoad(command: Extract<SimCommand, { type: 'load' }>) {
  emit({ type: 'loaded', requestId: command.requestId, vectors: command.probes.map((probe) => probe.id) })
}

function withWindowObservations() {
  fixture.sim.observation = (id) => {
    let observation = fixture.observations.get(id)
    if (!observation) {
      observation = new LongWindow()
      fixture.observations.set(id, observation)
    }
    return observation
  }
  fixture.instruments = fixture.instruments.map((entry) => ({
    ...entry,
    settings: {
      ...entry.settings,
      ...(entry.instanceId === 'gen1' ? { ch1_freq: 500, ch2_on: 0 } : {}),
      ...(entry.instanceId === 'scope1' ? { out_on: 0 } : {}),
    },
  }))
}

function feedScope(
  command: Extract<SimCommand, { type: 'load' }>,
  seconds: number,
  value: (time: number) => number,
  from = 0,
  channel = 'CH1',
) {
  if (command.analysis.kind !== 'tran') throw new Error('Missing transient sample grid')
  const dt = command.analysis.step
  const count = Math.round(seconds / dt)
  for (let offset = 0; offset < count; offset += 25_000) {
    const size = Math.min(25_000, count - offset)
    chunk(
      `scope:scope1:${channel}`,
      Float32Array.from({ length: size }, (_, index) => value(from + (offset + index) * dt)),
      from + offset * dt,
      dt,
    )
  }
  return from + count * dt
}

function publishScope(command: Extract<SimCommand, { type: 'load' }>, simTime: number) {
  emit({ type: 'readings', simTime, values: Object.fromEntries(command.probes.map((probe) => [probe.id, 0])) })
}

function requested(snapshot: MeasurementSnapshot | undefined, seconds: number, channel = 'CH1') {
  return snapshot?.waveforms?.find((reading) => reading.channelId === channel && reading.requestedWindowSec === seconds)
}

beforeEach(() => {
  vi.useFakeTimers()
  fixture.events.clear()
  fixture.restarts.clear()
  fixture.changes.clear()
  fixture.samples.clear()
  fixture.buffers.clear()
  fixture.observations.clear()
  fixture.modules.length = 0
  fixture.netlist = ''
  sound.outputs.length = 0
  sound.contexts.length = 0
  sound.create.mockReset().mockImplementation(async () => {
    const output = { feed: vi.fn(), stop: vi.fn() }
    sound.outputs.push(output)
    return output
  })
  vi.stubGlobal(
    'AudioContext',
    class {
      resume = vi.fn(async () => {})
      close = vi.fn(async () => {})
      constructor() {
        sound.contexts.push(this)
      }
    },
  )
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
  fixture.sim = {
    send: vi.fn(async () => {}),
    buffer(id) {
      let buffer = fixture.buffers.get(id)
      if (!buffer) {
        buffer = new RingBuffer(1 << 18)
        fixture.buffers.set(id, buffer)
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
  vi.unstubAllGlobals()
})

describe('instrument runtime integration', () => {
  it('waits for the matching native load before starting or feeding a prepared speaker', async () => {
    useModule(true, true)
    disconnect = connectInstrumentRuntime(vi.fn())
    await vi.advanceTimersByTimeAsync(40)
    const command = latestLoad()
    if (command.analysis.kind !== 'tran') throw new Error('Missing transient')
    const probe = 'indicator:box1:sound'
    const output = sound.outputs[0]
    expect(output).toBeDefined()
    expect(command.requestId).toMatch(/^measurement-load-/)
    const samples = Float32Array.of(1, 2, 3)
    chunk(probe, samples, 10, command.analysis.step)
    emit({ type: 'readings', simTime: 10, values: Object.fromEntries(command.probes.map((entry) => [entry.id, 1])) })
    expect(output?.feed).not.toHaveBeenCalled()
    expect(currentMeasurementSnapshot()?.current).toBe(false)
    expect(vi.mocked(fixture.sim.send).mock.calls.map(([entry]) => entry.type)).toEqual(['load'])
    emit({ type: 'loaded', requestId: 'superseded-load', vectors: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.samples.get(probe)?.size ?? 0).toBe(0)
    acknowledgeLoad(command)
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.samples.get(probe)?.size).toBe(1)
    chunk(probe, samples, 0, command.analysis.step)
    expect(output?.feed).toHaveBeenCalledExactlyOnceWith(samples, 0, command.analysis.step)
    expect(vi.mocked(fixture.sim.send).mock.calls.map(([entry]) => entry.type)).toEqual(['load', 'setPacing', 'run'])
  })

  it('ignores superseded load acknowledgements, tails and errors without starting the latest speaker early', async () => {
    useModule(true, true)
    await start()
    const probe = 'indicator:box1:sound'
    const reload = async (frequency: number) => {
      fixture.instruments = fixture.instruments.map((entry) =>
        entry.instanceId === 'gen1' ? { ...entry, settings: { ...entry.settings, ch1_freq: frequency } } : entry,
      )
      changeControl(1000)
      await vi.advanceTimersByTimeAsync(40)
      return latestLoad()
    }
    const superseded = await reload(1000)
    const latest = await reload(2000)
    expect(superseded.requestId).not.toBe(latest.requestId)
    expect(sound.outputs[0]?.stop).toHaveBeenCalledTimes(1)
    expect(sound.outputs[1]?.stop).toHaveBeenCalledTimes(1)
    acknowledgeLoad(superseded)
    emit({ type: 'error', requestId: superseded.requestId, code: 'model', message: 'Old queued load failed' })
    chunk(probe, Float32Array.of(9), 10, 1e-4)
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.state.powered).toBe(true)
    expect(fixture.samples.get(probe)?.size ?? 0).toBe(0)
    expect(sound.outputs[2]?.feed).not.toHaveBeenCalled()
    expect(vi.mocked(fixture.sim.send).mock.calls.filter(([entry]) => entry.type === 'run')).toHaveLength(1)
    acknowledgeLoad(latest)
    await vi.advanceTimersByTimeAsync(0)
    chunk(probe, Float32Array.of(2), 0, 1e-4)
    expect(sound.outputs[2]?.feed).toHaveBeenCalledExactlyOnceWith(Float32Array.of(2), 0, 1e-4)
    expect(vi.mocked(fixture.sim.send).mock.calls.filter(([entry]) => entry.type === 'run')).toHaveLength(2)
    expect(fixture.samples.get(probe)?.size).toBe(1)
  })

  it('replaces the speaker timebase on an actual replay of the same load request', async () => {
    useModule(true, true)
    const command = await start()
    const probe = 'indicator:box1:sound'
    chunk(probe, Float32Array.of(1), 10, 1e-4)
    expect(sound.outputs[0]?.feed).toHaveBeenCalledTimes(1)
    acknowledgeLoad(command)
    await vi.advanceTimersByTimeAsync(0)
    expect(sound.outputs[0]?.stop).toHaveBeenCalledTimes(1)
    expect(sound.contexts[0]?.close).toHaveBeenCalledTimes(1)
    chunk(probe, Float32Array.of(2), 0, 1e-4)
    expect(sound.outputs[0]?.feed).toHaveBeenCalledTimes(1)
    expect(sound.outputs[1]?.feed).toHaveBeenCalledExactlyOnceWith(Float32Array.of(2), 0, 1e-4)
    expect(fixture.samples.get(probe)?.size).toBe(1)
  })

  it('waits for a replayed speaker that replaced the ready group while pacing was in flight', async () => {
    useModule(true, true)
    let releasePacing!: () => void
    vi.mocked(fixture.sim.send).mockImplementation((command) =>
      command.type === 'setPacing'
        ? new Promise<void>((resolve) => {
            releasePacing = resolve
          })
        : Promise.resolve(),
    )
    const command = await start()
    const replacement = { feed: vi.fn(), stop: vi.fn() }
    let prepareReplacement!: (output: typeof replacement) => void
    sound.create.mockImplementationOnce(
      () =>
        new Promise<typeof replacement>((resolve) => {
          prepareReplacement = resolve
        }),
    )
    acknowledgeLoad(command)
    await vi.advanceTimersByTimeAsync(0)
    expect(sound.outputs[0]?.stop).toHaveBeenCalledTimes(1)
    releasePacing()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(fixture.sim.send).mock.calls.filter(([entry]) => entry.type === 'run')).toHaveLength(0)
    expect(fixture.samples.get('indicator:box1:sound')?.size ?? 0).toBe(0)
    prepareReplacement(replacement)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(fixture.sim.send).mock.calls.filter(([entry]) => entry.type === 'run')).toHaveLength(1)
    chunk('indicator:box1:sound', Float32Array.of(2), 0, 1e-4)
    expect(replacement.feed).toHaveBeenCalledExactlyOnceWith(Float32Array.of(2), 0, 1e-4)
  })

  it('visibly releases an active speaker if an unrelated actual native session replaces it', async () => {
    useModule(true, true)
    await start()
    emit({ type: 'loaded', requestId: 'unrelated-session', vectors: [] })
    expect(fixture.state.powered).toBe(false)
    expect(currentMeasurementSnapshot()).toBeUndefined()
    expect(sound.outputs[0]?.stop).toHaveBeenCalledTimes(1)
    expect(sound.contexts[0]?.close).toHaveBeenCalledTimes(1)
    expect(fixture.samples.get('indicator:box1:sound')?.size ?? 0).toBe(0)
  })

  it('releases a prepared speaker on disposal and cannot resume from its late load acknowledgement', async () => {
    useModule(true, true)
    disconnect = connectInstrumentRuntime(vi.fn())
    await vi.advanceTimersByTimeAsync(40)
    const command = latestLoad()
    disconnect()
    disconnect = undefined
    acknowledgeLoad(command)
    await vi.advanceTimersByTimeAsync(0)
    chunk('indicator:box1:sound', Float32Array.of(2), 0, 1e-4)
    expect(sound.outputs[0]?.feed).not.toHaveBeenCalled()
    expect(sound.outputs[0]?.stop).toHaveBeenCalledTimes(1)
    expect(sound.contexts[0]?.close).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fixture.sim.send).mock.calls.filter(([entry]) => entry.type === 'run')).toHaveLength(0)
  })

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
    acknowledgeLoad(next)
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
    acknowledgeLoad(command)
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
    expect(vi.mocked(fixture.sim.send).mock.calls.map(([entry]) => entry.type)).toEqual(['load'])
    acknowledgeLoad(latestLoad())
    await vi.advanceTimersByTimeAsync(0)
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

describe('requested waveform windows', () => {
  it('keeps the default raw reading and adds a complete no-cycle stream window without enlarging raw storage', async () => {
    withWindowObservations()
    const command = await start()
    const end = feedScope(command, 0.7, () => 3)
    publishScope(command, end)
    const legacy = currentMeasurementSnapshot()
    const snapshot = currentMeasurementSnapshot([0.2])
    expect(snapshot?.waveforms?.filter((reading) => reading.requestedWindowSec === undefined)).toEqual(
      legacy?.waveforms,
    )
    expect(legacy?.waveforms?.[0]?.window?.source).toBe('raw')
    const capture = requested(snapshot, 0.2)
    expect(capture).toMatchObject({
      current: true,
      requestedWindowSec: 0.2,
      measurement: { min: 3, max: 3, mean: 3, completeCycles: 0, frequency: null },
      window: { rawStep: 2e-6, source: 'stream', frozen: false },
    })
    if (!capture?.window) throw new Error('Missing real requested window')
    expect(capture.window.end - capture.window.start + capture.window.rawStep).toBeGreaterThanOrEqual(0.2)
    const raw = fixture.sim.buffer('scope:scope1:CH1')
    expect(raw.written).toBeGreaterThan(raw.capacity)
    expect(raw.data.byteLength).toBe(1 << 20)
    expect(legacy?.waveforms?.[0]?.window?.end ?? 0).toBe(capture.window.end)
    expect((legacy?.waveforms?.[0]?.window?.end ?? 0) - (legacy?.waveforms?.[0]?.window?.start ?? 0)).toBeLessThan(
      65_536 * capture.window.rawStep,
    )
  })

  it('deduplicates numeric requests and keeps different windows on the same probe separate', async () => {
    withWindowObservations()
    const command = await start()
    const end = feedScope(command, 0.62, (time) => (time < 0.5 ? -5 : 2))
    publishScope(command, end)
    const observed = fixture.sim.observation?.('scope:scope1:CH1')
    if (!observed) throw new Error('Missing source observation')
    const stats = vi.spyOn(observed, 'snapshot')
    const snapshot = currentMeasurementSnapshot([0.3, 0.1, 0.3])
    const longer = requested(snapshot, 0.3)
    const shorter = requested(snapshot, 0.1)
    expect(
      snapshot?.waveforms?.filter((reading) => reading.channelId === 'CH1' && reading.requestedWindowSec === 0.3),
    ).toHaveLength(1)
    expect(stats.mock.calls.filter(([seconds]) => seconds === 0.3)).toHaveLength(1)
    const result = stats.mock.results[stats.mock.calls.findIndex(([seconds]) => seconds === 0.3)]?.value
    expect(longer?.measurement).toBe(result?.measurement)
    expect(longer).toMatchObject({ current: true, measurement: { min: -5, max: 2 } })
    expect(shorter).toMatchObject({ current: true, measurement: { min: 2, max: 2, mean: 2, completeCycles: 0 } })
    expect(longer?.window?.start).toBeLessThan(shorter?.window?.start ?? 0)
    expect(longer?.window?.end).toBe(shorter?.window?.end)
    expect(longer?.window?.revision).toBe(shorter?.window?.revision)
  })

  it('shares same-probe same-window measurement and provenance objects with a chosen default stream reading', async () => {
    withWindowObservations()
    const command = await start()
    const end = feedScope(command, 0.5, (time) => Math.sin(2 * Math.PI * 40 * time))
    publishScope(command, end)
    const snapshot = currentMeasurementSnapshot([0.2, 0.2])
    const legacy = snapshot?.waveforms?.find(
      (reading) => reading.channelId === 'CH1' && reading.requestedWindowSec === undefined,
    )
    const capture = requested(snapshot, 0.2)
    expect(legacy?.window?.source).toBe('stream')
    expect(capture?.current).toBe(true)
    expect(capture?.measurement).toBe(legacy?.measurement)
    expect(capture?.window).toBe(legacy?.window)
  })

  it('marks an incomplete real observation unavailable rather than padding or using a shorter raw window', async () => {
    withWindowObservations()
    const command = await start()
    const end = feedScope(command, 0.199, () => 2)
    publishScope(command, end)
    const capture = requested(currentMeasurementSnapshot([0.2]), 0.2)
    expect(capture).toMatchObject({ current: false, requestedWindowSec: 0.2, measurement: null })
    if (!capture?.window) throw new Error('Incomplete coverage must report its actual available window')
    expect(capture.window.end - capture.window.start + capture.window.rawStep).toBeLessThan(0.2)
  })

  it('does not certify a full 16 seconds from bins that only retain a partial 16-second raw span', async () => {
    withWindowObservations()
    fixture.instruments = fixture.instruments
      .filter((entry) => entry.instanceId !== 'meter1')
      .map((entry) => ({
        ...entry,
        settings: {
          ...entry.settings,
          ...(entry.instanceId === 'gen1' ? { ch1_freq: 1 } : {}),
          ...(entry.instanceId === 'scope1' ? { tdiv: 0.1 } : {}),
        },
      }))
    fixture.state.wires = fixture.state.wires.filter(
      (wire) => !wire.a.startsWith('meter1.') && !wire.b.startsWith('meter1.'),
    )
    const command = await start()
    const end = feedScope(command, 16, () => 4)
    publishScope(command, end)
    expect(requested(currentMeasurementSnapshot([16]), 16)?.current).toBe(true)
    const next = feedScope(command, 0.005, () => 4, end)
    publishScope(command, next)
    const snapshot = currentMeasurementSnapshot([16, 15.9])
    const capture = requested(snapshot, 16)
    expect(capture).toMatchObject({ current: false, measurement: null })
    if (!capture?.window) throw new Error('Missing bounded available span')
    expect(capture.window.end - capture.window.start + capture.window.rawStep).toBeLessThan(16)
    expect(requested(snapshot, 15.9)?.current).toBe(true)
    const observed = fixture.sim.observation?.('scope:scope1:CH1')
    expect(observed?.traces(16)?.min.length).toBeLessThanOrEqual(2048)
    expect(fixture.sim.buffer('scope:scope1:CH1').data.byteLength).toBe(1 << 20)
  })

  it('does not fall back to raw samples when the requested source observation is unavailable', async () => {
    const command = await start()
    const end = feedScope(command, 0.002, () => 5)
    publishScope(command, end)
    expect(currentMeasurementSnapshot()?.waveforms?.[0]?.current).toBe(true)
    expect(requested(currentMeasurementSnapshot([0.001]), 0.001)).toMatchObject({ current: false, measurement: null })
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 16.000001])(
    'rejects out-of-contract window %s without clamping',
    async (seconds) => {
      await start()
      expect(() => currentMeasurementSnapshot([seconds])).toThrow(RangeError)
    },
  )

  it('waits for the matching load, full fresh coverage and a current publication, including replay', async () => {
    withWindowObservations()
    disconnect = connectInstrumentRuntime(vi.fn())
    await vi.advanceTimersByTimeAsync(40)
    const command = latestLoad()
    feedScope(command, 0.25, () => 9, 10)
    publishScope(command, 10.25)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
    emit({ type: 'loaded', requestId: 'superseded-load', vectors: [] })
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
    acknowledgeLoad(command)
    const partial = feedScope(command, 0.1, () => 3)
    publishScope(command, partial)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
    const complete = feedScope(command, 0.11, () => 3, partial)
    publishScope(command, complete)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)).toMatchObject({ current: true, measurement: { mean: 3 } })
    acknowledgeLoad(command)
    publishScope(command, 0)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)).toMatchObject({ current: false, measurement: null })
  })

  it('requires full post-correlated-alter coverage and never mixes the old stream or in-flight tail', async () => {
    withWindowObservations()
    useModule()
    const command = await start()
    const oldEnd = feedScope(command, 0.25, () => -7)
    publishScope(command, oldEnd)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(true)
    changeControl(2000)
    const update = latestAlter()
    const tailEnd = feedScope(command, 0.05, () => -7, oldEnd)
    publishScope(command, tailEnd)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
    emit({ type: 'altered', requestId: 'older-request', changes: update.changes, simTime: oldEnd })
    publishScope(command, tailEnd)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
    emit({ type: 'altered', requestId: update.requestId, changes: update.changes, simTime: tailEnd })
    publishScope(command, tailEnd)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
    if (command.analysis.kind !== 'tran') throw new Error('Missing transient sample grid')
    const first = tailEnd + command.analysis.step
    const partial = feedScope(command, 0.1, () => 2, first)
    publishScope(command, partial)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
    const complete = feedScope(command, 0.11, () => 2, partial)
    publishScope(command, complete)
    const capture = requested(currentMeasurementSnapshot([0.2]), 0.2)
    expect(capture).toMatchObject({ current: true, measurement: { min: 2, max: 2, mean: 2 } })
    expect(capture?.window?.start).toBeGreaterThan(tailEnd)
  })

  it.each(['paused', 'idle'] as const)(
    'rejects native %s evidence and requires a full post-resume request window',
    async (state) => {
      withWindowObservations()
      const command = await start()
      const oldEnd = feedScope(command, 0.25, () => 4)
      publishScope(command, oldEnd)
      expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(true)
      emit({ type: 'status', state, simTime: oldEnd })
      expect(requested(currentMeasurementSnapshot([0.2]), 0.2)).toMatchObject({ current: false, measurement: null })
      expect(currentMeasurementSnapshot()?.waveforms?.[0]?.current).toBe(true)
      const tailEnd = feedScope(command, 0.3, () => 9, oldEnd)
      publishScope(command, tailEnd)
      expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
      emit({ type: 'status', state: 'running', simTime: tailEnd })
      expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
      if (command.analysis.kind !== 'tran') throw new Error('Missing transient sample grid')
      const partial = feedScope(command, 0.1, () => 3, tailEnd + command.analysis.step)
      publishScope(command, partial)
      expect(requested(currentMeasurementSnapshot([0.2]), 0.2)?.current).toBe(false)
      const complete = feedScope(command, 0.11, () => 3, partial)
      publishScope(command, complete)
      const capture = requested(currentMeasurementSnapshot([0.2]), 0.2)
      expect(capture).toMatchObject({ current: true, measurement: { min: 3, max: 3, mean: 3 } })
      expect(capture?.window?.start).toBeGreaterThan(tailEnd)
    },
  )

  it.each([{ run: 0 }, { ch1_on: 0 }, { ch1_coupling: 2 }])(
    'rejects stopped, disabled or GND requested acquisition %j',
    async (settings) => {
      withWindowObservations()
      const command = await start()
      const end = feedScope(command, 0.3, (time) => Math.sin(2 * Math.PI * 1000 * time))
      publishScope(command, end)
      fixture.instruments = fixture.instruments.map((entry) =>
        entry.instanceId === 'scope1' ? { ...entry, settings: { ...entry.settings, ...settings } } : entry,
      )
      changeControl(1000)
      expect(requested(currentMeasurementSnapshot([0.2]), 0.2)).toMatchObject({ current: false, measurement: null })
    },
  )

  it('does not replace a genuinely single-frozen acquisition with a live requested stream', async () => {
    withWindowObservations()
    fixture.instruments = fixture.instruments.map((entry) =>
      entry.instanceId === 'scope1'
        ? { ...entry, settings: { ...entry.settings, trig_mode: 2, trig_level: 0 } }
        : entry,
    )
    const command = await start()
    publishScope(command, 0)
    currentMeasurementSnapshot([0.2])
    const end = feedScope(command, 0.3, (time) => Math.sin(2 * Math.PI * 1000 * time))
    publishScope(command, end)
    expect(requested(currentMeasurementSnapshot([0.2]), 0.2)).toMatchObject({ current: false, measurement: null })
  })

  it('measures a requested short DC difference from one synchronized raw window, including its full-window mean', async () => {
    withWindowObservations()
    fixture.state.wires.push({ id: 'scope2', a: 'scope1.CH2', b: 'gen1.CH1', color: 'red' })
    const command = await start()
    const end = feedScope(command, 0.04, (time) => 3.2 + 0.3 * Math.sin(2 * Math.PI * 1000 * time))
    feedScope(command, 0.04, (time) => 2.8 + 0.2 * Math.sin(2 * Math.PI * 1000 * time), 0, 'CH2')
    publishScope(command, end)
    const capture = requested(currentMeasurementSnapshot([0.0035]), 0.0035, 'CH1-CH2')
    expect(capture).toMatchObject({
      current: true,
      negativeRef: 'scope1.CH2',
      window: { source: 'raw', frozen: false },
    })
    const a = fixture.sim.buffer('scope:scope1:CH1')
    const b = fixture.sim.buffer('scope:scope1:CH2')
    const count = Math.ceil(0.0035 / a.dt)
    const actual = Float32Array.from(
      { length: count },
      (_, index) => a.latest(count - 1 - index) - b.latest(count - 1 - index),
    )
    const mean = actual.reduce((sum, sample) => sum + sample, 0) / count
    expect(capture?.measurement?.mean).toBeCloseTo(mean, 8)
    expect(Math.abs(mean - 0.4)).toBeGreaterThan(0.001)
    expect(capture?.measurement?.min).toBeCloseTo(Math.min(...actual), 6)
    expect(capture?.measurement?.max).toBeCloseTo(Math.max(...actual), 6)
    expect(capture?.window?.end).toBe(a.lastTime)
    expect(capture?.window?.start).toBe(a.lastTime - (count - 1) * a.dt)
  })

  it('retains the connected identity but refuses a long difference instead of subtracting channel envelopes', async () => {
    withWindowObservations()
    fixture.state.wires.push({ id: 'scope2', a: 'scope1.CH2', b: 'gen1.CH1', color: 'red' })
    const command = await start()
    const end = feedScope(command, 0.3, () => 4)
    feedScope(command, 0.3, () => 3, 0, 'CH2')
    publishScope(command, end)
    const snapshot = currentMeasurementSnapshot([0.2])
    expect(requested(snapshot, 0.2, 'CH1')?.current).toBe(true)
    expect(requested(snapshot, 0.2, 'CH2')?.current).toBe(true)
    expect(requested(snapshot, 0.2, 'CH1-CH2')).toMatchObject({
      current: false,
      measurement: null,
      positiveRef: 'scope1.CH1',
      negativeRef: 'scope1.CH2',
    })
    expect(requested(snapshot, 0.2, 'CH1-CH2')?.window).toBeUndefined()
    expect(
      snapshot?.waveforms?.find(
        (reading) => reading.channelId === 'CH1-CH2' && reading.requestedWindowSec === undefined,
      )?.current,
    ).toBe(true)
  })

  it('rejects requested differences across missing raw continuity even when old ring tails and latest grids align', async () => {
    withWindowObservations()
    fixture.state.wires.push({ id: 'scope2', a: 'scope1.CH2', b: 'gen1.CH1', color: 'red' })
    const command = await start()
    feedScope(command, 0.22, () => 8)
    feedScope(command, 0.22, () => 2, 0, 'CH2')
    const end = feedScope(command, 0.03, () => 4, 0.3)
    feedScope(command, 0.03, () => 3, 0.3, 'CH2')
    publishScope(command, end)
    const snapshot = currentMeasurementSnapshot([0.04, 0.02])
    expect(fixture.sim.buffer('scope:scope1:CH1').length).toBeGreaterThan(0.04 / 2e-6)
    expect(requested(snapshot, 0.04, 'CH1-CH2')).toMatchObject({ current: false, measurement: null })
    expect(requested(snapshot, 0.02, 'CH1-CH2')).toMatchObject({
      current: true,
      measurement: { min: 1, max: 1, mean: 1 },
    })
  })

  it('refuses a requested raw difference when two complete channel windows have different latest times', async () => {
    withWindowObservations()
    fixture.state.wires.push({ id: 'scope2', a: 'scope1.CH2', b: 'gen1.CH1', color: 'red' })
    const command = await start()
    const end = feedScope(command, 0.04, () => 4)
    feedScope(command, 0.04, () => 3, 0.001, 'CH2')
    publishScope(command, end + 0.001)
    const snapshot = currentMeasurementSnapshot([0.02])
    expect(requested(snapshot, 0.02, 'CH1')?.current).toBe(true)
    expect(requested(snapshot, 0.02, 'CH2')?.current).toBe(true)
    expect(requested(snapshot, 0.02, 'CH1-CH2')).toMatchObject({ current: false, measurement: null })
  })
})

describe('slow-simulation pace status', () => {
  async function startTracking() {
    const statuses: RuntimeStatus[] = []
    disconnect = connectInstrumentRuntime((status) => statuses.push(status))
    await vi.advanceTimersByTimeAsync(40)
    const command = latestLoad()
    acknowledgeLoad(command)
    await vi.advanceTimersByTimeAsync(0)
    return { command, statuses }
  }

  it('stays quiet on healthy 1.0x transient runs without spamming status callbacks', async () => {
    fixture.instruments = fixture.instruments.filter((entry) => entry.instanceId !== 'meter1')
    fixture.state.wires = fixture.state.wires.filter(
      (wire) => !wire.a.startsWith('meter1.') && !wire.b.startsWith('meter1.'),
    )
    const { command, statuses } = await startTracking()
    const values = Object.fromEntries(command.probes.map((probe) => [probe.id, 0]))
    for (let tick = 0; tick <= 30; tick++) {
      emit({ type: 'readings', simTime: 0.05 + tick * 0.1, values })
      await vi.advanceTimersByTimeAsync(100)
    }
    const ready = statuses.filter((entry) => entry.state === 'ready')
    expect(ready).toHaveLength(1)
    expect(ready[0]?.pace?.slow).toBe(false)
  })

  it('raises a throttled slow-simulation warning from actual simTime/wall ratio and clears on recovery', async () => {
    fixture.instruments = fixture.instruments.filter((entry) => entry.instanceId !== 'meter1')
    fixture.state.wires = fixture.state.wires.filter(
      (wire) => !wire.a.startsWith('meter1.') && !wire.b.startsWith('meter1.'),
    )
    const { command, statuses } = await startTracking()
    const values = Object.fromEntries(command.probes.map((probe) => [probe.id, 0]))
    let simTime = 0.05
    emit({ type: 'readings', simTime, values })

    // 1.4 s of slow progress is still below the 1.5 s observation minimum
    for (let tick = 1; tick <= 14; tick++) {
      await vi.advanceTimersByTimeAsync(100)
      simTime += 0.017
      emit({ type: 'readings', simTime, values })
    }
    expect(statuses.some((entry) => entry.pace?.slow)).toBe(false)

    // Reaching 1.5 s triggers slow alert immediately
    await vi.advanceTimersByTimeAsync(100)
    simTime += 0.017
    emit({ type: 'readings', simTime, values })
    const firstSlow = statuses.at(-1)
    expect(firstSlow?.pace?.slow).toBe(true)
    expect(firstSlow?.pace?.realtimeRatio).toBeCloseTo(0.17, 2)

    // Varying slow ratio over 1 s should not spam every 100 ms tick (throttled to <= 2 Hz)
    const countBefore = statuses.length
    for (let tick = 1; tick <= 10; tick++) {
      await vi.advanceTimersByTimeAsync(100)
      simTime += 0.01 + tick * 0.002
      emit({ type: 'readings', simTime, values })
    }
    expect(statuses.length - countBefore).toBeLessThanOrEqual(2)

    // Recovering to 1.0x clears the slow alert once the sliding window crosses exit threshold
    for (let tick = 1; tick <= 25; tick++) {
      await vi.advanceTimersByTimeAsync(100)
      simTime += 0.1
      emit({ type: 'readings', simTime, values })
    }
    expect(statuses.at(-1)?.pace?.slow).toBe(false)
    expect(statuses.at(-1)?.pace?.realtimeRatio).toBeGreaterThanOrEqual(0.92)
  })

  it('clears the slow warning on pause, parameter alter, and power-off, and never triggers on OP', async () => {
    useModule(true)
    fixture.instruments = fixture.instruments.filter((entry) => entry.instanceId !== 'meter1')
    fixture.state.wires = fixture.state.wires.filter(
      (wire) => !wire.a.startsWith('meter1.') && !wire.b.startsWith('meter1.'),
    )
    const { command, statuses } = await startTracking()
    const values = Object.fromEntries(command.probes.map((probe) => [probe.id, 0]))

    const driveSlow = async (fromSim: number) => {
      let simTime = fromSim
      emit({ type: 'readings', simTime, values })
      for (let tick = 1; tick <= 16; tick++) {
        await vi.advanceTimersByTimeAsync(100)
        simTime += 0.015
        emit({ type: 'readings', simTime, values })
      }
      return simTime
    }

    let simTime = await driveSlow(0.05)
    expect(statuses.at(-1)?.pace?.slow).toBe(true)

    // Pause clears slow warning immediately
    emit({ type: 'status', state: 'paused', simTime })
    expect(statuses.at(-1)?.pace?.slow ?? false).toBe(false)

    // Resume + slow again, then live alter clears slow warning
    emit({ type: 'status', state: 'running', simTime })
    simTime = await driveSlow(simTime)
    expect(statuses.at(-1)?.pace?.slow).toBe(true)
    changeControl(2000)
    expect(statuses.at(-1)?.pace?.slow ?? false).toBe(false)
    const update = latestAlter()
    emit({ type: 'altered', requestId: update.requestId, changes: update.changes, simTime })
    simTime = await driveSlow(simTime + 0.05)
    expect(statuses.at(-1)?.pace?.slow).toBe(true)

    // Power-off clears slow warning
    fixture.state = { ...fixture.state, powered: false }
    for (const listener of fixture.changes) listener(fixture.state)
    expect(statuses.at(-1)).toEqual({ state: 'off', message: '未运行' })

    // DC OP analysis never emits pace or slow
    disconnect?.()
    disconnect = undefined
    fixture.modules.length = 0
    useModule(false)
    fixture.instruments = [{ instanceId: 'meter1', instrument: meter, settings: { range: 'dcv20' } }]
    fixture.state = {
      powered: true,
      placedInstruments: [],
      controlValues: {},
      wires: [
        { id: 'w1', a: 'box1.P', b: 'meter1.VOHM', color: 'red' },
        { id: 'w2', a: 'box1.N', b: 'meter1.COM', color: 'black' },
      ],
    }
    const op = await startTracking()
    emit({ type: 'op', values: Object.fromEntries(op.command.probes.map((probe) => [probe.id, 5])) })
    expect(op.statuses.at(-1)).toEqual({ state: 'ready', message: '直流工作点已更新' })
  })
})
