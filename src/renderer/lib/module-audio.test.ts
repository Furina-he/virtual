import { describe, expect, it, vi } from 'vitest'
import { createModuleAudio } from './module-audio'
import type { SamplesListener } from './sim-client'

const speaker = { instanceId: 'box1', indicatorId: 'speaker', probe: 'indicator:box1:speaker', fullScale: 5 }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  const off = vi.fn()
  const source = { onSamples: vi.fn((_probe: string, _listener: SamplesListener) => off) }
  const context = { resume: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const output = { feed: vi.fn(), stop: vi.fn() }
  const factories = { context: vi.fn(() => context), output: vi.fn(async () => output) }
  return { source, context, output, factories, off }
}

describe('declared module audio lifecycle', () => {
  it('creates synth output before running and feeds only the declared probe', async () => {
    const f = fixture()
    const group = createModuleAudio(f.source, [speaker], 1 / 44_100, f.factories)
    await group.ready
    expect(f.factories.output).toHaveBeenCalledWith(f.context, 44_100, 5)
    expect(f.source.onSamples).toHaveBeenCalledWith(speaker.probe, expect.any(Function))
    const samples = Float32Array.of(1, 2)
    const callback = f.source.onSamples.mock.calls[0]?.[1]
    if (!callback) throw new Error('Missing speaker subscription')
    callback(samples, 1, 1 / 44_100)
    expect(f.output.feed).toHaveBeenCalledWith(samples, 1, 1 / 44_100)
    group.dispose()
    group.dispose()
    callback(samples, 2, 1 / 44_100)
    expect(f.output.feed).toHaveBeenCalledTimes(1)
    expect(f.off).toHaveBeenCalledTimes(1)
    expect(f.output.stop).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)
  })

  it('stops an asynchronously created output if its owning load was superseded', async () => {
    const f = fixture()
    const late = deferred<typeof f.output>()
    f.factories.output.mockImplementation(() => late.promise)
    const group = createModuleAudio(f.source, [speaker], 1e-5, f.factories)
    await Promise.resolve()
    group.dispose()
    late.resolve(f.output)
    await group.ready
    expect(f.source.onSamples).not.toHaveBeenCalled()
    expect(f.output.stop).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)
  })

  it('does not create outputs after disposal while context resume is pending', async () => {
    const f = fixture()
    const late = deferred<void>()
    f.context.resume.mockImplementation(() => late.promise)
    const group = createModuleAudio(f.source, [speaker], 1e-5, f.factories)
    group.dispose()
    late.resolve()
    await group.ready
    expect(f.factories.output).not.toHaveBeenCalled()
    expect(f.context.close).toHaveBeenCalledTimes(1)
  })

  it('closes the context and reports actual creation failures', async () => {
    const f = fixture()
    f.factories.output.mockRejectedValue(new Error('unavailable'))
    const group = createModuleAudio(f.source, [speaker], 1e-5, f.factories)
    await expect(group.ready).rejects.toThrow('unavailable')
    expect(f.context.close).toHaveBeenCalledTimes(1)
    expect(f.source.onSamples).not.toHaveBeenCalled()
  })

  it('does not allocate browser audio for modules without speakers', async () => {
    const f = fixture()
    const group = createModuleAudio(f.source, [], 1e-5, f.factories)
    await group.ready
    group.dispose()
    expect(f.factories.context).not.toHaveBeenCalled()
  })
})
