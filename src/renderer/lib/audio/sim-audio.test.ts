import { afterEach, expect, it, vi } from 'vitest'
import { renderOffline } from './sim-audio'

type PlaybackStats = { underruns: number; played: number; queued: number }
const events: string[] = []
const acknowledgements: PlaybackStats[] = []

class QueuedWorkletNode {
  readonly samples: Float32Array[] = []
  readonly gain: number
  readonly port = {
    onmessage: null as ((event: { data: PlaybackStats }) => void) | null,
    postMessage: (message: { samples?: Float32Array; stats?: true }) => {
      // Worklet messages arrive asynchronously in FIFO order, independently of rendering.
      queueMicrotask(() => {
        if (message.samples) this.samples.push(message.samples)
        if (message.stats) {
          events.push('acknowledge')
          const data = { underruns: 0, played: 0, queued: this.samples.reduce((n, chunk) => n + chunk.length, 0) }
          acknowledgements.push(data)
          this.port.onmessage?.({ data })
        }
      })
    },
  }

  constructor(ctx: TestOfflineContext, _name: string, options: { processorOptions: { gain: number } }) {
    this.gain = options.processorOptions.gain
    ctx.node = this
  }

  connect(_destination: unknown): void {}
}

class TestOfflineContext {
  readonly destination = {}
  readonly audioWorklet = { addModule: async (_url: string) => {} }
  node?: QueuedWorkletNode

  constructor(
    _channels: number,
    readonly length: number,
    _rate: number,
  ) {}

  startRendering() {
    events.push('render')
    const rendered = new Float32Array(this.length)
    let offset = 0
    for (const samples of this.node?.samples ?? []) {
      rendered.set(
        samples.map((v) => v * (this.node?.gain ?? 1)),
        offset,
      )
      offset += samples.length
    }
    return Promise.resolve({ getChannelData: () => rendered })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  events.length = 0
  acknowledgements.length = 0
})

it('PCM offline rendering waits for every queued sample before starting the render', async () => {
  vi.stubGlobal('OfflineAudioContext', TestOfflineContext)
  vi.stubGlobal('AudioWorkletNode', QueuedWorkletNode)
  const rate = 44100
  const samples = Float32Array.from(
    { length: Math.round(rate * 0.2) },
    (_, i) => 0.3 + 2 * Math.sin((2 * Math.PI * 997 * i) / rate),
  )
  const rendered = await renderOffline('pcm', samples, 1 / rate)
  let maxDiff = 0
  for (let i = 0; i < samples.length - 2; i++)
    maxDiff = Math.max(maxDiff, Math.abs((rendered[i] ?? 0) * 5 - (samples[i] ?? 0)))
  expect(maxDiff).toBeLessThan(1e-3)
  expect(acknowledgements).toEqual([{ underruns: 0, played: 0, queued: samples.length }])
  expect(events).toEqual(['acknowledge', 'render'])
})
