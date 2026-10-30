import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimCommand, SimEvent } from '../shared/ipc/sim.ts'
import type { NgSpiceOptions } from './ngspice.ts'
import { SimSession, type SimSliceProfile, TRIM_POINTS } from './session.ts'

const native = vi.hoisted(() => ({
  options: {} as NgSpiceOptions,
  vectors: new Map<string, Float64Array>(),
  commands: [] as string[],
  freeCommands: 0,
}))

vi.mock('./ngspice.ts', () => ({
  NgSpice: {
    open: (_dir: string, options: NgSpiceOptions) => {
      native.options = options
      return {
        load: () => {},
        command: (command: string) => {
          native.commands.push(command)
          if (command === 'bg_run' || command === 'bg_resume') native.options.onBgRunning?.(true)
        },
        readVector: (name: string) => native.vectors.get(name) ?? new Float64Array(),
        vectors: () => [...native.vectors.keys()],
        vectorLength: (name: string) => native.vectors.get(name)?.length ?? 0,
        freeCommandMemory: () => native.freeCommands++,
      }
    },
  },
  NgSpiceError: class extends Error {},
  classifyError: () => 'model',
}))

const load: SimCommand = {
  type: 'load',
  requestId: 'profile-load',
  netlist: 'Diagnostic stub\nVS a 0 1\nR1 a b 1k\nR2 b 0 1k\n.end',
  analysis: { kind: 'tran', step: 0.01, continuous: true },
  probes: [
    { id: 'a', kind: 'v', node: 'a' },
    { id: 'b', kind: 'v', node: 'b' },
    { id: 'differential', kind: 'v', node: 'a', nodeRef: 'b' },
  ],
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'performance',
    ],
  })
  native.commands.length = 0
  native.freeCommands = 0
  native.vectors = new Map([
    ['time', new Float64Array([0, 0.025, 0.05])],
    ['a', new Float64Array([1, 1, 1])],
    ['b', new Float64Array([0.5, 0.5, 0.5])],
  ])
})

afterEach(() => vi.useRealTimers())

async function finishSlice(session: SimSession, elapsedMs: number, pause = true) {
  await vi.advanceTimersByTimeAsync(elapsedMs)
  if (pause) session.handle({ type: 'pause' })
  native.options.onBgRunning?.(false)
  await vi.advanceTimersByTimeAsync(0)
}

describe('opt-in slice diagnostics use no native DLL', () => {
  it('is disabled by default and leaves the existing sample/command stream intact', async () => {
    const events: SimEvent[] = []
    const session = new SimSession(
      'stub',
      (event) => events.push(event),
      () => {},
    )
    try {
      session.handle(load)
      session.handle({ type: 'run' })
      await finishSlice(session, 20)
      expect(events.filter((event) => event.type === 'chunk')).toHaveLength(1)
      expect(events.find((event) => event.type === 'chunk')).toMatchObject({ seq: 0, t0: 0, dt: 0.01 })
      expect(native.commands).toEqual(['esave none', 'stop when time > 0.05', 'bg_run'])
      expect(native.freeCommands).toBe(1)
      expect(native.options.onData).toBeUndefined()
    } finally {
      session.dispose()
    }
  })

  it('correlates actual raw points, unique reads, differential blocks and callback timing', async () => {
    const events: SimEvent[] = []
    const profiles: SimSliceProfile[] = []
    const session = new SimSession(
      'stub',
      (event) => events.push(event),
      () => {},
      (profile) => profiles.push(profile),
    )
    try {
      session.handle(load)
      session.handle({ type: 'run' })
      await finishSlice(session, 20)
      expect(profiles).toHaveLength(1)
      const profile = profiles[0] as SimSliceProfile
      expect(profile).toMatchObject({
        loadId: 'profile-load',
        sliceSeq: 0,
        simFrom: 0,
        simTo: 0.05,
        rawPoints: 3,
        outputPoints: 6,
        probeCount: 3,
        readCalls: 5,
        distinctVectors: ['time', 'a', 'b'],
        readBytes: 5 * 3 * 8,
        outputBytes: 3 * 6 * 4,
        firstSeq: 0,
        lastSeq: 0,
        paceBefore: null,
      })
      expect(profile.circuitHash).toMatch(/^[a-f0-9]{64}$/)
      expect(profile.ms.bgObserved).toBe(20)
      expect(profile.ms.callbackQueue).toBeGreaterThanOrEqual(0)
      for (const value of Object.values(profile.ms)) expect(value).toBeGreaterThanOrEqual(0)
      const chunk = events.find((event) => event.type === 'chunk')
      expect(chunk?.type === 'chunk' && [...(chunk.data.differential ?? [])]).toEqual(Array(6).fill(0.5))
    } finally {
      session.dispose()
    }
  })

  it('attributes the real scheduled pacing wait to the next slice and restarts correlation on load', async () => {
    const profiles: SimSliceProfile[] = []
    const session = new SimSession(
      'stub',
      () => {},
      () => {},
      (profile) => profiles.push(profile),
    )
    try {
      session.handle(load)
      session.handle({ type: 'run' })
      await finishSlice(session, 20, false)
      await vi.advanceTimersByTimeAsync(30)
      native.vectors.set('time', new Float64Array([0.05, 0.075, 0.1]))
      await finishSlice(session, 20)
      expect(profiles[1]).toMatchObject({
        sliceSeq: 1,
        firstSeq: 1,
        lastSeq: 1,
        simFrom: 0.05,
        simTo: 0.1,
        paceBefore: { actualWaitMs: 30, latenessMs: 0 },
      })
      expect(profiles[1]?.paceBefore?.plannedWaitMs).toBeCloseTo(30, 9)
      session.handle({ ...load, requestId: 'second-load' })
      session.handle({ type: 'run' })
      await finishSlice(session, 20)
      expect(profiles[2]).toMatchObject({ loadId: 'second-load', sliceSeq: 0, firstSeq: 0, paceBefore: null })
    } finally {
      session.dispose()
    }
  })

  it('reports trim calls and isolates a diagnostic consumer exception', async () => {
    native.vectors = new Map(
      ['time', 'a', 'b'].map((name) => [
        name,
        Float64Array.from({ length: TRIM_POINTS }, (_, k) => (name === 'time' ? k * 1e-6 : 1)),
      ]),
    )
    const profiles: SimSliceProfile[] = []
    const events: SimEvent[] = []
    const session = new SimSession(
      'stub',
      (event) => events.push(event),
      () => {},
      (profile) => {
        profiles.push(profile)
        throw new Error('Read-only diagnostic failed')
      },
    )
    try {
      session.handle(load)
      session.handle({ type: 'run' })
      await finishSlice(session, 20)
      expect(profiles[0]).toMatchObject({ rawPoints: TRIM_POINTS, trimVectors: 3, trimCommands: 3 })
      expect(session.trims).toBe(1)
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(native.commands.filter((command) => command.startsWith('let '))).toHaveLength(3)
    } finally {
      session.dispose()
    }
  })
})
