import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimEvent } from '../shared/ipc/sim.ts'
import type { NgSpiceOptions } from './ngspice.ts'
import { SimSession } from './session.ts'

const mock = vi.hoisted(() => {
  const state = { options: undefined as NgSpiceOptions | undefined, vectors: {} as Record<string, Float64Array> }
  const ng = {
    load: vi.fn(),
    command: vi.fn(),
    run: vi.fn(),
    freeCommandMemory: vi.fn(),
    getVector: (name: string) => state.vectors[name] ?? new Float64Array(0),
    readVector: (name: string, start: number) => (state.vectors[name] ?? new Float64Array(0)).subarray(start),
  }
  return { state, ng }
})

vi.mock('./ngspice.ts', () => ({
  NgSpice: {
    open: (_dir: string, options: NgSpiceOptions) => {
      mock.state.options = options
      return mock.ng
    },
  },
  NgSpiceError: class extends Error {
    code: string
    detail: string
    constructor(code: string, detail: string) {
      super(detail)
      this.code = code
      this.detail = detail
    }
  },
  classifyError: () => 'model',
}))

const events: SimEvent[] = []
let session: SimSession

function load(kind: 'op' | 'tran', id = 'first'): void {
  session.handle({
    type: 'load',
    requestId: id,
    netlist: '* delayed native boundary stub\n.end',
    probes: [{ id: 'measurement', kind: 'v', node: 'value' }],
    analysis: kind === 'op' ? { kind: 'op' } : { kind: 'tran', step: 0.01, continuous: true },
  })
}

async function finishSlice(value: number): Promise<void> {
  mock.state.vectors = {
    time: Float64Array.from([0, 0.025, 0.050000001]),
    value: Float64Array.from([value, value, value]),
  }
  mock.state.options?.onBgRunning?.(false)
  await vi.advanceTimersByTimeAsync(0)
}

function expectSampleEvidence(): void {
  let sampleEnd: number | undefined
  for (const event of events) {
    if (event.type === 'loaded') sampleEnd = undefined
    if (event.type === 'chunk') {
      const count = event.data.measurement?.length ?? 0
      if (count) sampleEnd = event.t0 + (count - 1) * event.dt
    }
    if (event.type !== 'readings') continue
    expect(sampleEnd, 'A periodic reading must follow a real sample in its current load').toBeDefined()
    expect(event.simTime).toBeGreaterThan(0)
    expect(event.simTime).toBeGreaterThanOrEqual(sampleEnd as number)
  }
}

describe('periodic reading initialization boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    events.length = 0
    mock.state.vectors = {}
    session = new SimSession(
      'stub-only',
      (event) => events.push(event),
      () => {},
    )
  })

  afterEach(() => {
    session.dispose()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not publish initialized zero while the first native background slice is still pending', async () => {
    load('tran')
    session.handle({ type: 'run' })
    await vi.advanceTimersByTimeAsync(500)
    expect(events.some((event) => event.type === 'chunk')).toBe(false)
    expect(events.filter((event) => event.type === 'readings')).toEqual([])
    await finishSlice(5)
    await vi.advanceTimersByTimeAsync(100)
    expect(events.filter((event) => event.type === 'readings')).toHaveLength(1)
    expectSampleEvidence()
  })

  it('still publishes genuine zero-voltage transient readings after a native sample', async () => {
    load('tran')
    session.handle({ type: 'run' })
    await finishSlice(0)
    await vi.advanceTimersByTimeAsync(100)
    const readings = events.filter((event) => event.type === 'readings')
    expect(readings).toHaveLength(1)
    expect(readings[0]?.values.measurement).toBe(0)
    expectSampleEvidence()
  })

  it('does not carry sample readiness through another load', async () => {
    load('tran')
    session.handle({ type: 'run' })
    await finishSlice(5)
    await vi.advanceTimersByTimeAsync(100)
    session.handle({ type: 'pause' })
    load('tran', 'replacement')
    // Complete the old pending slice so the queued new load can become current.
    mock.state.options?.onBgRunning?.(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.at(-2)?.type).toBe('loaded')
    events.length = 0
    session.handle({ type: 'run' })
    await vi.advanceTimersByTimeAsync(500)
    expect(events.filter((event) => event.type === 'readings')).toEqual([])
    expectSampleEvidence()
  })

  it('keeps genuine zero-voltage working-point results valid at simulation time zero', async () => {
    mock.state.vectors.value = Float64Array.from([0])
    load('op')
    expect(events.find((event) => event.type === 'op')).toMatchObject({ type: 'op', values: { measurement: 0 } })
    await vi.advanceTimersByTimeAsync(500)
    expect(events.filter((event) => event.type === 'readings')).toEqual([])
  })
})
