import type { SpeakerPlan } from '../../domain/measurement/plan'
import type { SimAudioOutput } from './audio/sim-audio'
import type { SamplesListener } from './sim-client'

type SampleSource = { onSamples: (probe: string, listener: SamplesListener) => () => void }
type AudioOutput = Pick<SimAudioOutput, 'feed' | 'stop'>
type SpeakerContext = Pick<AudioContext, 'resume' | 'close'>
type AudioFactories = {
  context: () => SpeakerContext
  output: (context: SpeakerContext, rate: number, fullScale: number) => Promise<AudioOutput>
}
const browserAudio: AudioFactories = {
  context: () => new AudioContext(),
  output: async (context, rate, fullScale) => {
    const { SimAudioOutput } = await import('./audio/sim-audio')
    return SimAudioOutput.create(context as AudioContext, 'synth', rate, { fullScale })
  },
}

/** The runtime activates after its matching native loaded event, not IPC acceptance; disposal cancels late resources. */
export function createModuleAudio(
  source: SampleSource,
  speakers: readonly SpeakerPlan[],
  step: number,
  factories: AudioFactories = browserAudio,
): { ready: Promise<void>; activate: () => void; dispose: () => void } {
  let disposed = false
  let activated = false
  let prepared = false
  let bound = false
  let context: SpeakerContext | undefined
  const outputs: AudioOutput[] = []
  const subscriptions: (() => void)[] = []

  const bind = () => {
    if (disposed || !activated || !prepared || bound) return
    bound = true
    outputs.forEach((output, index) => {
      subscriptions.push(
        source.onSamples((speakers[index] as SpeakerPlan).probe, (samples, t0, dt) => {
          if (!disposed) output.feed(samples, t0, dt)
        }),
      )
    })
  }
  const activate = () => {
    if (disposed) return
    activated = true
    bind()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const off of subscriptions) off()
    for (const output of outputs) output.stop()
    subscriptions.length = 0
    outputs.length = 0
    if (context) void context.close().catch(() => {})
  }

  const ready = (async () => {
    if (!speakers.length) return
    context = factories.context()
    await context.resume()
    if (disposed) return
    for (const speaker of speakers) {
      const output = await factories.output(context, 1 / step, speaker.fullScale)
      if (disposed) {
        output.stop()
        return
      }
      outputs.push(output)
    }
    prepared = true
    bind()
  })().catch((error) => {
    const cancelled = disposed
    dispose()
    if (!cancelled) throw error
  })

  return { ready, activate, dispose }
}
