// 音频方案 A（技术设计 §5.4，SIM-13）：仿真波形按 AudioContext 采样率线性重采样后直接播放。
// AudioWorklet 模块，经 `?worker&url` 打包成同源文件（CSP 只允许 'self'）。
// 主线程经 port 送 { samples: Float32Array }；队列不足时输出静音并计欠载，重新预缓冲。

export {}

// AudioWorkletGlobalScope 不在 TS dom 库中，按需声明
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

interface Options {
  processorOptions: { srcRate: number; prebufferSec: number; gain: number }
}

class SimPcmProcessor extends AudioWorkletProcessor {
  private readonly queue: Float32Array[] = []
  private head = 0
  /** 当前块内的小数读位置 */
  private pos = 0
  private queued = 0
  private readonly step: number
  private readonly prebuffer: number
  private readonly gain: number
  private playing = false
  private underruns = 0
  private played = 0
  private last = 0

  constructor(options: Options) {
    super()
    const o = options.processorOptions
    this.step = o.srcRate / sampleRate
    this.prebuffer = Math.round(o.srcRate * o.prebufferSec)
    this.gain = o.gain
    this.port.onmessage = (e: MessageEvent<{ samples?: Float32Array; stats?: true }>) => {
      if (e.data.samples) {
        this.queue.push(e.data.samples)
        this.queued += e.data.samples.length
      }
      if (e.data.stats)
        this.port.postMessage({ underruns: this.underruns, played: this.played, queued: this.queued - this.pos })
    }
  }

  // 取源序列中相对当前读位置偏移 k 的点
  private peek(k: number): number {
    let i = this.head
    let off = Math.floor(this.pos) + k
    for (;;) {
      const b = this.queue[i]
      if (!b) return this.last
      if (off < b.length) return b[off] ?? 0
      off -= b.length
      i++
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    if (!this.playing && this.queued >= this.prebuffer) this.playing = true
    for (let n = 0; n < out.length; n++) {
      if (!this.playing || this.queued - this.pos < 2) {
        if (this.playing) {
          this.underruns++
          this.playing = false
        }
        out[n] = 0
        continue
      }
      const frac = this.pos - Math.floor(this.pos)
      const a = this.peek(0)
      const b = this.peek(1)
      this.last = a
      out[n] = (a + (b - a) * frac) * this.gain
      this.pos += this.step
      this.played++
      // 丢弃已读完的块
      for (let b0 = this.queue[this.head]; b0 && this.pos >= b0.length; b0 = this.queue[this.head]) {
        this.pos -= b0.length
        this.queued -= b0.length
        this.head++
      }
      if (this.head > 64) {
        this.queue.splice(0, this.head)
        this.head = 0
      }
    }
    for (let ch = 1; ch < (outputs[0]?.length ?? 0); ch++) outputs[0]?.[ch]?.set(out)
    return true
  }
}

registerProcessor('sim-pcm', SimPcmProcessor)
