import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { SimCommand } from '../../src/shared/ipc/sim'

const STEP = 2e-6
type Snapshot = {
  measurement: { frequency: number | null; period: number | null; completeCycles: number } | null
  window: { start: number; end: number; rawStep: number }
  revision: number
}
type Client = {
  stats: { sessions: number; blocks: number; lostBlocks: number; lastSeq: number; points: number }
  send(command: SimCommand): Promise<void>
  buffer(id: string): { capacity: number; length: number; data: Float32Array; lastTime: number }
  observation(id: string): {
    snapshot(seconds: number): Snapshot
    traces(seconds: number): { min: Float32Array; max: Float32Array } | null
  }
  onSamples(id: string, listener: (samples: Float32Array, t0: number, dt: number) => void): () => void
}

test('公共 IPC 同一真实时间流：2µs 原始采样、1Hz 长周期与音频共存且内存有界', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-long-window-')) },
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('region', { name: '3D 实训台', exact: true })).toHaveAttribute(
      'data-assets-state',
      'ready',
      { timeout: 30_000 },
    )
    const load: SimCommand = {
      type: 'load',
      requestId: 'shared-long-window',
      netlist:
        'Shared public realtime test\nVslow slow 0 SIN(0 1 1)\nVfast fast 0 SIN(0 1 1025)\nVref ref 0 0.5\nR1 slow 0 10k\nR2 fast ref 10k\n.end',
      probes: [
        { id: 'scope:shared:CH1', kind: 'v', node: 'slow', nodeRef: '0' },
        { id: 'scope:shared:CH2', kind: 'v', node: 'fast', nodeRef: '0' },
        { id: 'sound', kind: 'v', node: 'fast', nodeRef: 'ref' },
      ],
      analysis: { kind: 'tran', step: STEP, continuous: true },
    }
    await expect(page.getByRole('button', { name: '上电', exact: true })).toBeEnabled()
    await page.evaluate(async () => {
      const client = window.__simClient as unknown as Client
      const audio = await (
        window.__loadSimAudio as unknown as () => Promise<{
          SimAudioOutput: {
            create: (
              ctx: AudioContext,
              mode: string,
              rate: number,
              options: { destination: AudioNode },
            ) => Promise<{ feed: (samples: Float32Array, t0: number, dt: number) => void; stop: () => void }>
          }
        }>
      )()
      const ctx = new AudioContext()
      await ctx.resume()
      const mute = new GainNode(ctx, { gain: 0 })
      mute.connect(ctx.destination)
      const output = await audio.SimAudioOutput.create(ctx, 'synth', 1 / 2e-6, { destination: mute })
      const state = { feeds: 0, off: () => {}, stop: async () => {} }
      state.off = client.onSamples('sound', (samples, t0, dt) => {
        output.feed(samples, t0, dt)
        state.feeds++
      })
      state.stop = async () => {
        state.off()
        output.stop()
        await ctx.close()
      }
      Object.assign(window, { __boundedAudio: state })
    })
    // Audio-context initialization finishes before this running-stream benchmark starts.
    await page.evaluate(async (command) => {
      const client = window.__simClient as unknown as Client
      window.__longTasks = []
      const longDetails: { start: number; duration: number; name: string }[] = []
      Object.assign(window, { __boundedLongTasks: longDetails })
      new PerformanceObserver((list) => {
        for (const item of list.getEntries()) {
          window.__longTasks?.push(item.duration)
          longDetails.push({ start: item.startTime, duration: item.duration, name: item.name })
        }
      }).observe({ type: 'longtask', buffered: false })
      await client.send(command)
      await client.send({ type: 'setPacing', mode: 'realtime' })
      await client.send({ type: 'run' })
    }, load)
    const started = Date.now()
    await expect
      .poll(() => page.evaluate(() => (window.__simClient as unknown as Client).buffer('scope:shared:CH1').lastTime), {
        timeout: 5000,
      })
      .toBeGreaterThan(3.2)
    const result = await page.evaluate(() => {
      const client = window.__simClient as unknown as Client
      const slow = client.observation('scope:shared:CH1').snapshot(4)
      const fast = client.observation('scope:shared:CH2').snapshot(4)
      const buffer = client.buffer('scope:shared:CH1')
      const trace = client.observation('scope:shared:CH1').traces(4)
      return {
        slow,
        fast,
        stats: client.stats,
        capacity: buffer.capacity,
        bytes: buffer.data.byteLength,
        length: buffer.length,
        envelopePoints: trace?.min.length ?? 0,
        maxLongTask: Math.max(0, ...(window.__longTasks ?? [])),
        longDetails: (window as unknown as { __boundedLongTasks: unknown[] }).__boundedLongTasks,
      }
    })
    expect(result.stats.lostBlocks).toBe(0)
    expect(result.stats.lastSeq + 1).toBe(result.stats.blocks)
    expect(result.slow.window.rawStep).toBe(STEP)
    expect(Math.abs((result.slow.measurement?.frequency ?? 0) - 1)).toBeLessThan(0.01)
    expect(result.slow.measurement?.completeCycles).toBeGreaterThanOrEqual(2)
    expect(Math.abs((result.fast.measurement?.frequency ?? 0) / 1025 - 1)).toBeLessThan(0.01)
    expect(result.slow.window.end / ((Date.now() - started) / 1000)).toBeLessThan(1.1)
    expect(result.capacity).toBe(262_144)
    expect(result.bytes).toBe(1 << 20)
    expect(result.length).toBe(result.capacity)
    expect(result.envelopePoints).toBeLessThanOrEqual(2048)
    console.log(`Long-window diagnostics: ${JSON.stringify(result)}`)
    expect(result.maxLongTask).toBeLessThan(50)
    const stoppedFeeds = await page.evaluate(async () => {
      const state = (window as unknown as { __boundedAudio: { feeds: number; stop: () => Promise<void> } })
        .__boundedAudio
      await state.stop()
      await (window.__simClient as unknown as Client).send({ type: 'pause' })
      return state.feeds
    })
    await page.waitForTimeout(150)
    expect(
      await page.evaluate(() => (window as unknown as { __boundedAudio: { feeds: number } }).__boundedAudio.feeds),
    ).toBe(stoppedFeeds)
    expect(errors).toEqual([])
    console.log(
      `Bounded Electron stream: ${result.slow.window.end.toFixed(3)}s, 1Hz and1025Hz, ${result.stats.blocks} blocks, raw ring ${result.bytes}bytes, ${result.envelopePoints} envelope points, max task ${result.maxLongTask}ms`,
    )
  } finally {
    await app.close()
  }
})
