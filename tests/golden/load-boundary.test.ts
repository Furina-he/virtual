import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SimChunk, SimCommand, SimEvent } from '../../src/shared/ipc/sim'
import { SimSession } from '../../src/sim/session'

type Load = Extract<SimCommand, { type: 'load' }>
type Loaded = Extract<SimEvent, { type: 'loaded' }>
const STEP = 1e-4
const PROBE = 'shared-output'
const events: SimEvent[] = []
let fatalExits = 0
const session = new SimSession(
  resolve(import.meta.dirname, '../../resources/ngspice'),
  (event) => events.push(event),
  () => {
    fatalExits++
  },
)

function load(requestId: string, offset: number, amplitude = 0.25, frequency = 100): Load {
  return {
    type: 'load',
    requestId,
    netlist: `Generic load boundary\nV1 out 0 SIN(${offset} ${amplitude} ${frequency})\nR1 out 0 1000\n.end`,
    // Reusing a probe ID makes old/new contamination observable through real voltage, not renamed channels.
    probes: [{ id: PROBE, kind: 'v', node: 'out' }],
    analysis: { kind: 'tran', step: STEP, continuous: true },
  }
}

function chunks(list: readonly SimEvent[] = events): SimChunk[] {
  return list.filter((event): event is SimChunk => event.type === 'chunk')
}

function loaded(list: readonly SimEvent[] = events): Loaded[] {
  return list.filter((event): event is Loaded => event.type === 'loaded')
}

function endTime(chunk?: SimChunk): number {
  return chunk ? chunk.t0 + (chunk.data[PROBE]?.length ?? 0) * chunk.dt : 0
}

async function waitLoaded(requestId: string): Promise<number> {
  await expect.poll(() => loaded().some((event) => event.requestId === requestId)).toBe(true)
  return events.findIndex((event) => event.type === 'loaded' && event.requestId === requestId)
}

function expectSignal(data: readonly SimChunk[], offset: number, amplitude = 0.25, frequency = 100): void {
  expect(data.length).toBeGreaterThan(0)
  expect(data[0]).toMatchObject({ seq: 0, t0: 0, dt: STEP })
  let maxError = 0
  data.forEach((chunk, index) => {
    expect(chunk.seq).toBe(index)
    expect(chunk.dt).toBe(STEP)
    if (index) expect(chunk.t0).toBeCloseTo(endTime(data[index - 1]), 9)
    const samples = chunk.data[PROBE]
    expect(samples?.length ?? 0).toBeGreaterThan(0)
    for (const [i, value] of (samples ?? new Float32Array(0)).entries()) {
      const time = chunk.t0 + i * chunk.dt
      const expected = offset + amplitude * Math.sin(2 * Math.PI * frequency * time)
      maxError = Math.max(maxError, Math.abs(value - expected))
    }
  })
  expect(maxError).toBeLessThan(0.002)
}

beforeEach(() => {
  events.length = 0
  fatalExits = 0
})

afterEach(async () => {
  session.handle({ type: 'pause' })
  // The queued load is a native slice-completion barrier before the next test or disposal.
  session.handle(load('cleanup', 0, 0))
  await waitLoaded('cleanup')
  expect(events.filter((event) => event.type === 'error')).toEqual([])
  expect(fatalExits).toBe(0)
})

afterAll(() => session.dispose())

describe('real ngspice queued load boundaries', () => {
  it('drains the old running slice before its matching new loaded event and restarts time and sequence', async () => {
    session.handle(load('load-old', 2))
    session.handle({ type: 'setPacing', mode: 'realtime' })
    session.handle({ type: 'run' })
    await expect.poll(() => endTime(chunks().at(-1))).toBeGreaterThan(0.05)

    // Same-stack pause/run starts or queues another old slice before the reload, without private-state hooks.
    session.handle({ type: 'pause' })
    session.handle({ type: 'run' })
    const requestedAt = events.length
    session.handle(load('load-new', -2, 0.5, 200))
    const boundary = await waitLoaded('load-new')
    const previous = chunks(events.slice(0, boundary))
    expect(loaded().map((event) => event.requestId)).toEqual(['load-old', 'load-new'])
    expect(chunks(events.slice(requestedAt, boundary)).length).toBeGreaterThan(0)
    expect(endTime(previous.at(-1))).toBeGreaterThan(0.05)
    expectSignal(previous, 2)

    // Start the new run only after its own acknowledgement, never after an old queued loaded event.
    session.handle({ type: 'run' })
    await expect.poll(() => endTime(chunks(events.slice(boundary + 1)).at(-1))).toBeGreaterThan(0.05)
    session.handle({ type: 'pause' })
    const current = chunks(events.slice(boundary + 1))
    expectSignal(current, -2, 0.5, 200)
    expect(events[boundary]).toMatchObject({ type: 'loaded', requestId: 'load-new', vectors: ['v(out)'] })
    expect(loaded()[0]?.requestId).not.toBe(loaded()[1]?.requestId)
    expect(events.filter((event) => event.type === 'error')).toEqual([])
  })

  it('preserves FIFO load acknowledgements without confusing a superseded load with the final session', async () => {
    session.handle(load('queue-old', 2))
    session.handle({ type: 'setPacing', mode: 'realtime' })
    session.handle({ type: 'run' })
    await expect.poll(() => endTime(chunks().at(-1))).toBeGreaterThan(0.05)
    session.handle({ type: 'pause' })
    session.handle({ type: 'run' })
    const requestedAt = events.length
    session.handle(load('queue-superseded', 7))
    session.handle(load('queue-latest', -3))
    const finalBoundary = await waitLoaded('queue-latest')
    const supersededBoundary = events.findIndex(
      (event) => event.type === 'loaded' && event.requestId === 'queue-superseded',
    )
    expect(supersededBoundary).toBeGreaterThanOrEqual(requestedAt)
    expect(finalBoundary).toBeGreaterThan(supersededBoundary)
    expect(loaded().map((event) => event.requestId)).toEqual(['queue-old', 'queue-superseded', 'queue-latest'])
    expect(chunks(events.slice(requestedAt, supersededBoundary)).length).toBeGreaterThan(0)
    expect(chunks(events.slice(supersededBoundary + 1, finalBoundary))).toEqual([])
    expect(events[supersededBoundary]).not.toMatchObject({ requestId: 'queue-latest' })
    expectSignal(chunks(events.slice(0, supersededBoundary)), 2)

    session.handle({ type: 'run' })
    await expect.poll(() => endTime(chunks(events.slice(finalBoundary + 1)).at(-1))).toBeGreaterThan(0.05)
    session.handle({ type: 'pause' })
    expectSignal(chunks(events.slice(finalBoundary + 1)), -3)
    expect(events.filter((event) => event.type === 'error')).toEqual([])
  })
})
