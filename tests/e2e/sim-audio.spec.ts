// T0.6 / SIM-13：SD-22 在真实应用中实时运行，两种音频原型同时接上（静音输出）：
//   方案 A pcm：AudioWorklet（同源打包文件，验证 CSP 'self' 可加载）统计欠载
//   方案 B synth：OscillatorNode 合成
// 并测 sim 进程 CPU、实时比；最后把采到的扬声器波形离线渲染两种方案，回到 Node 做频谱比较。
import { mkdtempSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { analyzeTone } from '../../src/shared/audio/tone'
import type { SimCommand } from '../../src/shared/ipc/sim'
import { SD22_SPEAKER, sd22Netlist } from '../golden/fixtures/sd22'

const RATE = 44100
const RUN_SEC = Number(process.env.SD22_SEC ?? 8)

interface AudioOut {
  feed(s: Float32Array, t0: number, dt: number): void
  stats(): Promise<{ underruns: number; played: number; queued: number }>
}
interface AudioModule {
  SimAudioOutput: {
    create(
      ctx: BaseAudioContext,
      mode: 'pcm' | 'synth',
      srcRate: number,
      o?: { destination?: AudioNode },
    ): Promise<AudioOut>
  }
  renderOffline(mode: 'pcm' | 'synth', samples: Float32Array, dt: number): Promise<Float32Array>
}
interface Client {
  stats: { points: number; lostBlocks: number; lastSeq: number; blocks: number }
  send(c: SimCommand): Promise<void>
  onSamples(id: string, l: (s: Float32Array, t0: number, dt: number) => void): () => void
}
declare global {
  interface Window {
    __loadSimAudio?: () => Promise<AudioModule>
    __sd22?: { chunks: Float32Array[]; pcm?: AudioOut; ctxState?: string }
  }
}

// Electron 的 percentCPUUsage 按整机（全部逻辑核）归一
const CORES = cpus().length
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0

test('SD-22 实时运行：两种音频原型、CPU 与实时比', async () => {
  test.setTimeout((RUN_SEC + 90) * 1000)
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-e2e-')) },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => window.__simClient !== undefined)
    // Cold GPU warmup belongs to scene loading, not to an already-running audio stream.
    await expect(win.getByRole('region', { name: '3D 实训台' })).toHaveAttribute('data-assets-state', 'ready', {
      timeout: 30_000,
    })
    await expect(win.getByRole('button', { name: '上电', exact: true })).toBeEnabled()
    const load: SimCommand = {
      type: 'load',
      netlist: sd22Netlist(),
      probes: [{ id: 'spk', kind: 'v', node: SD22_SPEAKER }],
      analysis: { kind: 'tran', step: 1 / RATE, continuous: true },
    }
    // 接上两种输出（经 0 增益节点，测试时不出声）
    const ctxState = await win.evaluate(async (rate) => {
      const client = window.__simClient as unknown as Client
      const mod = await (window.__loadSimAudio as () => Promise<AudioModule>)()
      const ctx = new AudioContext({ sampleRate: rate })
      await ctx.resume()
      const mute = new GainNode(ctx, { gain: 0 })
      mute.connect(ctx.destination)
      const pcm = await mod.SimAudioOutput.create(ctx, 'pcm', rate, { destination: mute })
      const synth = await mod.SimAudioOutput.create(ctx, 'synth', rate, { destination: mute })
      const state = { chunks: [] as Float32Array[], pcm }
      window.__sd22 = state
      client.onSamples('spk', (s, t0, dt) => {
        state.chunks.push(s.slice())
        pcm.feed(s, t0, dt)
        synth.feed(s, t0, dt)
      })
      return ctx.state
    }, RATE)
    expect(ctxState).toBe('running')

    const simCpu = () =>
      app.evaluate(
        ({ app }) =>
          app.getAppMetrics().find((p) => p.type === 'Utility' && p.name === 'virtual-sim')?.cpu.percentCPUUsage ?? -1,
      )
    await win.evaluate(async (cmd) => {
      const c = window.__simClient as unknown as Client
      await c.send(cmd)
      await c.send({ type: 'setPacing', mode: 'realtime' })
      await c.send({ type: 'run' })
    }, load)
    await expect
      .poll(() => win.evaluate(() => (window.__simClient as unknown as Client).stats.points), { timeout: 5000 })
      .toBeGreaterThan(0)
    // 起点：重置 CPU 统计
    await simCpu()
    const p0 = await win.evaluate(() => (window.__simClient as unknown as Client).stats.points)
    const t0 = Date.now()
    await win.waitForTimeout(RUN_SEC * 1000)
    const cpuRealtime = await simCpu()
    const p1 = await win.evaluate(() => (window.__simClient as unknown as Client).stats.points)
    const wall = (Date.now() - t0) / 1000
    const realtimeRatio = (p1 - p0) / RATE / wall
    const pcmStats = await win.evaluate(() => window.__sd22?.pcm?.stats())

    // 不限速：测最大速度与 CPU
    await win.evaluate(() => (window.__simClient as unknown as Client).send({ type: 'setPacing', mode: 'window' }))
    await win.waitForTimeout(500)
    await simCpu()
    const q0 = await win.evaluate(() => (window.__simClient as unknown as Client).stats.points)
    const u0 = Date.now()
    await win.waitForTimeout(5000)
    const cpuFree = await simCpu()
    const q1 = await win.evaluate(() => (window.__simClient as unknown as Client).stats.points)
    const freeRatio = (q1 - q0) / RATE / ((Date.now() - u0) / 1000)
    await win.evaluate(() => (window.__simClient as unknown as Client).send({ type: 'pause' }))
    const s = await win.evaluate(() => (window.__simClient as unknown as Client).stats)

    // 离线渲染前 4 s 波形：A 应与仿真波形逐点一致（同采样率、仅有预缓冲延迟），B 音高一致
    const rendered = await win.evaluate(async (rate) => {
      const mod = await (window.__loadSimAudio as () => Promise<AudioModule>)()
      const all = window.__sd22?.chunks ?? []
      const n = Math.min(
        rate * 4,
        all.reduce((m, c) => m + c.length, 0),
      )
      const x = new Float32Array(n)
      let k = 0
      for (const c of all) {
        if (k >= n) break
        x.set(c.subarray(0, n - k), k)
        k += c.length
      }
      const a = await mod.renderOffline('pcm', x, 1 / rate)
      const b = await mod.renderOffline('synth', x, 1 / rate)
      return { x: Array.from(x), a: Array.from(a), b: Array.from(b) }
    }, RATE)
    const x = Float32Array.from(rendered.x)
    const a = Float32Array.from(rendered.a)
    const b = Float32Array.from(rendered.b)
    // A：找延迟后比较（输出已按 1/5 V 缩放）
    // 在 0~0.3 s 内搜索使两者最吻合的延迟（预缓冲）
    let delay = 0
    let best = Number.POSITIVE_INFINITY
    for (let d = 0; d < 0.3 * RATE; d++) {
      let e = 0
      for (let i = RATE; i < RATE + 2000; i++) e += Math.abs((a[i + d] ?? 0) * 5 - (x[i] ?? 0))
      if (e < best) {
        best = e
        delay = d
      }
    }
    let maxDiff = 0
    // 末尾两点不足插值，不比较
    for (let i = 0; i < x.length - 2 && i + delay < a.length; i++)
      maxDiff = Math.max(maxDiff, Math.abs((a[i + delay] ?? 0) * 5 - (x[i] ?? 0)))
    const fx = analyzeTone(x, 0, 1 / RATE).filter((f) => f.t > 0.3 && f.f0 > 0)
    const fb = analyzeTone(b, 0, 1 / RATE).filter((f) => f.t > 0.4 && f.f0 > 0)
    console.log(
      [
        `SD-22 实时节奏 ${wall.toFixed(1)} s：仿真/墙钟 ${realtimeRatio.toFixed(3)}，sim 进程 CPU ${(cpuRealtime * CORES).toFixed(0)}% 单核（整机 ${cpuRealtime.toFixed(1)}%）`,
        `不限速：${freeRatio.toFixed(2)} 倍实时，sim 进程 CPU ${(cpuFree * CORES).toFixed(0)}% 单核（整机 ${cpuFree.toFixed(1)}%）；块 ${s.blocks}，丢块 ${s.lostBlocks}`,
        `方案 A（AudioWorklet）实时播放 ${((pcmStats?.played ?? 0) / RATE).toFixed(1)} s，欠载 ${pcmStats?.underruns} 次，队列余 ${((pcmStats?.queued ?? 0) / RATE).toFixed(2)} s；` +
          `离线渲染与仿真波形最大偏差 ${maxDiff.toExponential(2)} V，延迟 ${((delay / RATE) * 1000).toFixed(0)} ms`,
        `方案 B（OscillatorNode）离线渲染基频中位 ${median(fb.map((f) => f.f0)).toFixed(0)} Hz，仿真 ${median(fx.map((f) => f.f0)).toFixed(0)} Hz`,
      ].join('\n'),
    )
    expect(s.lostBlocks).toBe(0)
    expect(realtimeRatio).toBeGreaterThan(0.95)
    expect(pcmStats?.underruns).toBe(0)
    expect(maxDiff).toBeLessThan(1e-3)
    expect(Math.abs(median(fb.map((f) => f.f0)) / median(fx.map((f) => f.f0)) - 1)).toBeLessThan(0.02)
  } finally {
    await app.close()
  }
})
