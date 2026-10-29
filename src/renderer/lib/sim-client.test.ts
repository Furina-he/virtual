import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIM_PORT_MESSAGE } from '../../shared/ipc/sim'
import type { RingBuffer } from './ring-buffer'
import { type SamplesListener, SimClient } from './sim-client'

class TestPort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly start = vi.fn()
  readonly close = vi.fn()
  deliver(data: unknown) {
    this.onmessage?.({ data })
  }
}

function fixture() {
  type WindowMessage = { source: unknown; data: unknown; ports: TestPort[] }
  let message: (event: WindowMessage) => void = () => {}
  let restarted: () => void = () => {}
  const api = {
    requestPort: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    onRestarted: vi.fn((listener: () => void) => {
      restarted = listener
      return () => {}
    }),
  }
  const window = {
    addEventListener: vi.fn((_name: string, listener: (event: WindowMessage) => void) => {
      message = listener
    }),
    api: { sim: api },
  }
  vi.stubGlobal('window', window)
  const client = new SimClient()
  const port = new TestPort()
  const attach = (next: TestPort, source: unknown = window, marker: unknown = SIM_PORT_MESSAGE) =>
    message({ source, data: marker, ports: [next] })
  attach(port)
  return {
    client,
    port,
    api,
    attach,
    restart: () => restarted(),
    loaded: () => port.deliver({ type: 'loaded', vectors: ['v(n1)', 'i(vsense_meter)'] }),
    chunk: (id: string, samples = [1, 2, 3], seq = 0) =>
      port.deliver({ type: 'chunk', seq, t0: 0.25, dt: 0.001, data: { [id]: Float32Array.from(samples) } }),
  }
}

const buffers = (client: SimClient) => Reflect.get(client, 'buffers') as Map<string, RingBuffer>
const sampleGroups = (client: SimClient) => Reflect.get(client, 'sampleListeners') as Map<string, Set<SamplesListener>>
afterEach(() => vi.unstubAllGlobals())

describe('SimClient session buffers', () => {
  it('invalidates old handles and allocates fresh buffers for the next validated load', () => {
    const f = fixture()
    f.chunk('m1:meter:v')
    const old = f.client.buffer('m1:meter:v')
    expect(old.written).toBe(3)
    expect(old.data.byteLength).toBe(1 << 20)
    expect(f.client.buffer('m1:meter:v')).toBe(old)
    f.loaded()
    expect(old.written).toBe(0)
    expect(old.length).toBe(0)
    expect(buffers(f.client).size).toBe(0)
    const current = f.client.buffer('m1:meter:v')
    expect(current).not.toBe(old)
    f.chunk('m1:meter:v', [4, 5])
    expect(current.written).toBe(2)
    expect(current.latest()).toBe(5)
    expect(old.written).toBe(0)
  })

  it('bounds retained allocations across many revision-specific probe IDs', () => {
    const f = fixture()
    for (let revision = 0; revision < 48; revision++) {
      f.loaded()
      expect(buffers(f.client).size).toBe(0)
      f.chunk(`m${revision}:meter:v`)
      expect([...buffers(f.client).keys()]).toEqual([`m${revision}:meter:v`])
      expect([...buffers(f.client).values()].reduce((bytes, b) => bytes + b.data.byteLength, 0)).toBe(1 << 20)
    }
    expect(f.client.stats.sessions).toBe(48)
  })

  it('ignores malformed loaded/chunk events without invalidating current data', () => {
    const f = fixture()
    f.chunk('probe')
    const current = f.client.buffer('probe')
    f.port.deliver({ type: 'loaded', vectors: [1] })
    f.port.deliver({ type: 'chunk', seq: 1, t0: 0, dt: 0, data: { probe: Float32Array.of(4) } })
    expect(current.written).toBe(3)
    expect(f.client.stats.sessions).toBe(0)
    expect(f.client.stats.blocks).toBe(1)
    f.loaded()
    expect(current.written).toBe(0)
  })

  it('resets session counters but preserves cumulative loss/restart accounting', () => {
    const f = fixture()
    f.chunk('probe', [1, 2], 2)
    expect(f.client.stats).toMatchObject({ blocks: 1, points: 2, lastSeq: 2, lostBlocks: 2 })
    f.restart()
    f.loaded()
    expect(f.client.stats).toMatchObject({ blocks: 0, points: 0, lastSeq: -1, lostBlocks: 2, restarts: 1, sessions: 1 })
    f.chunk('probe', [3])
    expect(f.client.stats).toMatchObject({ blocks: 1, points: 1, lastSeq: 0, lostBlocks: 2 })
  })
})

describe('SimClient sample subscriptions', () => {
  it('preserves active subscriptions across loads and forwards low-frequency events in order', () => {
    const f = fixture()
    const order: string[] = []
    const received: number[][] = []
    f.client.onSamples('spk', (samples, t0, dt) => {
      order.push('first')
      received.push([...samples])
      expect(t0).toBe(0.25)
      expect(dt).toBe(0.001)
      expect(f.client.buffer('spk').written).toBe(samples.length)
    })
    f.client.onSamples('spk', () => order.push('second'))
    f.client.onEvent((event) => order.push(event.type))
    f.loaded()
    f.chunk('spk', [1, 2])
    f.port.deliver({ type: 'readings', simTime: 0.5, values: { spk: 2 } })
    f.loaded()
    f.chunk('spk', [3, 4])
    expect(order).toEqual(['loaded', 'first', 'second', 'readings', 'loaded', 'first', 'second'])
    expect(received).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(sampleGroups(f.client).get('spk')?.size).toBe(2)
  })

  it('removes only an empty subscription group after its last listener unsubscribes', () => {
    const f = fixture()
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = f.client.onSamples('probe', first)
    const offSecond = f.client.onSamples('probe', second)
    offFirst()
    expect(sampleGroups(f.client).get('probe')?.size).toBe(1)
    f.chunk('probe')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    offSecond()
    expect(sampleGroups(f.client).size).toBe(0)
  })

  it('does not retain empty groups for discarded revision IDs', () => {
    const f = fixture()
    for (let revision = 0; revision < 64; revision++) {
      const unsubscribe = f.client.onSamples(`m${revision}:meter:v`, () => {})
      unsubscribe()
    }
    expect(sampleGroups(f.client).size).toBe(0)
  })

  it('does not let stale or double unsubscribe delete a replacement group', () => {
    const f = fixture()
    const old = vi.fn()
    const current = vi.fn()
    const offOld = f.client.onSamples('probe', old)
    offOld()
    const offCurrent = f.client.onSamples('probe', current)
    offOld()
    expect(sampleGroups(f.client).get('probe')?.size).toBe(1)
    f.chunk('probe')
    expect(current).toHaveBeenCalledTimes(1)
    expect(old).not.toHaveBeenCalled()
    offCurrent()
    offCurrent()
    expect(sampleGroups(f.client).size).toBe(0)
  })
})

describe('SimClient port lifecycle', () => {
  it('accepts only the window marker and replaces/starts data ports without changing event forwarding', async () => {
    const f = fixture()
    expect(f.api.requestPort).toHaveBeenCalledTimes(1)
    expect(f.port.start).toHaveBeenCalledTimes(1)
    const next = new TestPort()
    f.attach(next, {})
    f.attach(next, undefined, 'invalid-marker')
    expect(next.start).not.toHaveBeenCalled()
    f.attach(next)
    expect(f.port.close).toHaveBeenCalledTimes(1)
    expect(next.start).toHaveBeenCalledTimes(1)
    const listener = vi.fn()
    f.client.onEvent(listener)
    next.deliver({ type: 'loaded', vectors: ['v(n1)'] })
    expect(listener).toHaveBeenCalledWith({ type: 'loaded', vectors: ['v(n1)'] })
    await f.client.send({ type: 'pause' })
    expect(f.api.send).toHaveBeenCalledWith({ type: 'pause' })
  })
})
