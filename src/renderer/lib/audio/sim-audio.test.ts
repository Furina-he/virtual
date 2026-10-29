import { afterEach, expect, it, vi } from 'vitest'
import { renderOffline, SimAudioOutput } from './sim-audio'

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
  disconnect(): void {}
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

it('stopping synth output cancels queued changes, mutes and disconnects once, then rejects late samples', async () => {
  const parameter = () => ({
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  })
  const oscillator = { frequency: parameter(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }
  const gain = { gain: parameter(), connect: vi.fn(), disconnect: vi.fn() }
  oscillator.connect.mockReturnValue(gain)
  class TestOscillator {
    constructor() {
      Object.assign(this, oscillator)
    }
  }
  class TestGain {
    constructor() {
      Object.assign(this, gain)
    }
  }
  vi.stubGlobal('OscillatorNode', TestOscillator)
  vi.stubGlobal('GainNode', TestGain)
  const context = { currentTime: 2, destination: {} } as unknown as BaseAudioContext
  const output = await SimAudioOutput.create(context, 'synth', 44_100)
  output.stop()
  output.stop()
  output.feed(new Float32Array(4096), 0, 1 / 44_100)
  expect(oscillator.stop).toHaveBeenCalledTimes(1)
  expect(oscillator.disconnect).toHaveBeenCalledTimes(1)
  expect(gain.disconnect).toHaveBeenCalledTimes(1)
  expect(oscillator.frequency.cancelScheduledValues).toHaveBeenCalledWith(2)
  expect(gain.gain.cancelScheduledValues).toHaveBeenCalledWith(2)
  expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 2)
  expect(gain.gain.linearRampToValueAtTime).not.toHaveBeenCalled()
})
