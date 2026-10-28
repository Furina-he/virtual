// 仿真声音输出（SIM-13，技术设计 §5.4）两种原型：
//   pcm   方案 A：扬声器节点波形 → AudioWorklet 重采样播放（要求仿真 ≥ 实时）
//   synth 方案 B：逐帧提取基频与包络 → OscillatorNode（PeriodicWave 音色）合成
// 采样块由 SimClient.onSamples 同步送入 feed()，不经过 React state。

import { harmonicTable, ToneTracker } from '@shared/audio/tone'
import pcmWorkletUrl from './pcm-worklet.ts?worker&url'

export type AudioMode = 'pcm' | 'synth'

export interface SimAudioOptions {
  /** 节点电压满幅（V），映射到 ±1 */
  fullScale?: number
  /** 起播前缓冲（秒），吸收仿真时间片抖动 */
  prebufferSec?: number
  /** 输出节点，默认 ctx.destination */
  destination?: AudioNode
}

/** 方案 B 合成音色用的谐波数 */
const HARMONICS = 16
/** 方案 B 每隔这么久（仿真时间）按最新波形更新一次音色 */
const TIMBRE_SEC = 0.5
/** 方案 B 保留的最近原始采样（秒），用于求音色 */
const KEEP_SEC = 0.05

export class SimAudioOutput {
  private node?: AudioWorkletNode
  private osc?: OscillatorNode
  private amp?: GainNode
  private tracker?: ToneTracker
  // 方案 B：仿真时间 → 音频时间的偏移
  private offset = Number.NaN
  private recent = new Float32Array(0)
  private recentFill = 0
  private lastTimbre = Number.NEGATIVE_INFINITY

  private constructor(
    readonly ctx: BaseAudioContext,
    readonly mode: AudioMode,
    private readonly fullScale: number,
    private readonly prebufferSec: number,
  ) {}

  /** srcRate 为仿真采样率（1/dt） */
  static async create(
    ctx: BaseAudioContext,
    mode: AudioMode,
    srcRate: number,
    options: SimAudioOptions = {},
  ): Promise<SimAudioOutput> {
    const out = new SimAudioOutput(ctx, mode, options.fullScale ?? 5, options.prebufferSec ?? 0.15)
    const dest = options.destination ?? ctx.destination
    if (mode === 'pcm') {
      await ctx.audioWorklet.addModule(pcmWorkletUrl)
      out.node = new AudioWorkletNode(ctx, 'sim-pcm', {
        numberOfInputs: 0,
        outputChannelCount: [1],
        processorOptions: { srcRate, prebufferSec: out.prebufferSec, gain: 1 / out.fullScale },
      })
      out.node.connect(dest)
    } else {
      out.tracker = new ToneTracker(0.01)
      out.recent = new Float32Array(Math.ceil(srcRate * KEEP_SEC))
      out.osc = new OscillatorNode(ctx, { type: 'square', frequency: 0 })
      out.amp = new GainNode(ctx, { gain: 0 })
      out.osc.connect(out.amp).connect(dest)
      out.osc.start()
    }
    return out
  }

  feed(samples: Float32Array, t0: number, dt: number): void {
    if (this.node) {
      const copy = samples.slice()
      this.node.port.postMessage({ samples: copy }, [copy.buffer])
      return
    }
    this.synth(samples, t0, dt)
  }

  /** 方案 A 播放统计（欠载次数等） */
  stats(): Promise<{ underruns: number; played: number; queued: number }> {
    const node = this.node
    if (!node) return Promise.resolve({ underruns: 0, played: 0, queued: 0 })
    return new Promise((resolve) => {
      node.port.onmessage = (e) => resolve(e.data)
      node.port.postMessage({ stats: true })
    })
  }

  stop(): void {
    this.node?.disconnect()
    this.osc?.stop()
    this.amp?.disconnect()
  }

  private keep(samples: Float32Array): void {
    const r = this.recent
    if (samples.length >= r.length) {
      r.set(samples.subarray(samples.length - r.length))
      this.recentFill = r.length
      return
    }
    r.copyWithin(0, samples.length)
    r.set(samples, r.length - samples.length)
    this.recentFill = Math.min(r.length, this.recentFill + samples.length)
  }

  private synth(samples: Float32Array, t0: number, dt: number): void {
    const { tracker, osc, amp, ctx } = this
    if (!tracker || !osc || !amp) return
    this.keep(samples)
    for (const f of tracker.push(samples, t0, dt)) {
      // 仿真慢于实时则整体后移，保证调度时刻在未来（音调正确，节奏随仿真放慢）
      const now = ctx.currentTime
      if (Number.isNaN(this.offset) || f.t + this.offset < now + 0.02) this.offset = now + this.prebufferSec - f.t
      const at = f.t + this.offset
      osc.frequency.linearRampToValueAtTime(f.f0, at)
      // 包络按去直流 RMS 近似（PeriodicWave 默认按峰值归一）
      amp.gain.linearRampToValueAtTime(f.f0 > 0 ? f.rms / this.fullScale : 0, at)
      if (f.f0 > 0 && f.t - this.lastTimbre >= TIMBRE_SEC && this.recentFill === this.recent.length) {
        const { real, imag } = harmonicTable(this.recent, dt, f.f0, HARMONICS, 8)
        osc.setPeriodicWave(new PeriodicWave(ctx, { real, imag }))
        this.lastTimbre = f.t
      }
    }
  }
}

/** e2e 用：把一段仿真采样经指定方案离线渲染成 44.1 kHz 音频 */
export async function renderOffline(mode: AudioMode, samples: Float32Array, dt: number): Promise<Float32Array> {
  const rate = 44100
  const seconds = samples.length * dt
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * rate) + rate, rate)
  const out = await SimAudioOutput.create(ctx, mode, 1 / dt, { prebufferSec: 0.1 })
  // 分块送入，模拟数据端口逐块到达
  const block = 2048
  for (let i = 0; i < samples.length; i += block) out.feed(samples.slice(i, i + block), i * dt, dt)
  const rendered = await ctx.startRendering()
  return rendered.getChannelData(0)
}
