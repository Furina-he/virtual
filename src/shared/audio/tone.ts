// 音频方案 B（技术设计 §5.4，SIM-13）：从仿真波形逐帧提取基频与包络，供渲染端 OscillatorNode 合成。
// 纯 TS，不依赖 Web Audio，便于在 Node 中对真实仿真数据做金标准分析。

export interface ToneFrame {
  /** 帧结束时刻（仿真时间，秒） */
  t: number
  /** 基频（Hz），无法判定时为 0 */
  f0: number
  /** 去直流后的 RMS（与输入同单位） */
  rms: number
}

/** 去直流的一阶高通截止频率（Hz）：耦合电容充放电等慢变化不算音调 */
const HP_HZ = 20
/** 超过这么久没有过零就认为无音调 */
const HOLD_SEC = 0.05

/**
 * 流式基频/包络跟踪：一阶高通去直流，统计上穿零点（线性插值定位），
 * 帧内基频 = 帧内完整周期数 / 首末上穿点间隔。
 */
export class ToneTracker {
  private hpPrevIn = 0
  private hpPrevOut = 0
  private started = false
  private prev = 0
  private prevT = 0
  private lastCross = Number.NaN
  private frameEnd = Number.NaN
  private firstCross = Number.NaN
  private crosses = 0
  private sumSq = 0
  private count = 0
  private f0 = 0

  constructor(readonly frameSec = 0.01) {}

  /** 送入一段等间隔采样，返回本段内完成的帧 */
  push(samples: ArrayLike<number>, t0: number, dt: number): ToneFrame[] {
    const out: ToneFrame[] = []
    const a = 1 / (1 + 2 * Math.PI * HP_HZ * dt)
    if (Number.isNaN(this.frameEnd)) this.frameEnd = t0 + this.frameSec
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] ?? 0
      const t = t0 + i * dt
      if (!this.started) {
        this.hpPrevIn = x
        this.started = true
      }
      const y = a * (this.hpPrevOut + x - this.hpPrevIn)
      this.hpPrevIn = x
      this.hpPrevOut = y
      if (this.prev < 0 && y >= 0) {
        const tc = this.prevT + (dt * -this.prev) / (y - this.prev)
        if (Number.isNaN(this.firstCross)) this.firstCross = tc
        else this.crosses++
        this.lastCross = tc
      }
      this.prev = y
      this.prevT = t
      this.sumSq += y * y
      this.count++
      if (t >= this.frameEnd) {
        out.push(this.endFrame(t))
        this.frameEnd += this.frameSec
      }
    }
    return out
  }

  private endFrame(t: number): ToneFrame {
    if (this.crosses > 0) this.f0 = this.crosses / (this.lastCross - this.firstCross)
    else if (Number.isNaN(this.lastCross) || t - this.lastCross > HOLD_SEC) this.f0 = 0
    const frame = { t, f0: this.f0, rms: Math.sqrt(this.sumSq / Math.max(1, this.count)) }
    // 下一帧从本帧最后一个上穿点起算，周期不丢
    this.firstCross = this.lastCross
    this.crosses = 0
    this.sumSq = 0
    this.count = 0
    return frame
  }
}

/** 整段分析（金标准测试用） */
export function analyzeTone(samples: ArrayLike<number>, t0: number, dt: number, frameSec = 0.01): ToneFrame[] {
  return new ToneTracker(frameSec).push(samples, t0, dt)
}

/**
 * 取以 tEnd 结尾的若干完整周期，求前 n 次谐波的傅里叶系数（PeriodicWave 的 real/imag，下标 0 为直流置 0），
 * 作为合成音色；幅度按基波归一。
 */
export function harmonicTable(
  samples: ArrayLike<number>,
  dt: number,
  f0: number,
  n = 16,
  periods = 8,
): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(n + 1)
  const imag = new Float32Array(n + 1)
  const len = Math.min(samples.length, Math.round(periods / f0 / dt))
  if (f0 <= 0 || len < 4) {
    imag[1] = 1
    return { real, imag }
  }
  const start = samples.length - len
  let mean = 0
  for (let i = start; i < samples.length; i++) mean += samples[i] ?? 0
  mean /= len
  for (let h = 1; h <= n; h++) {
    let c = 0
    let s = 0
    const w = 2 * Math.PI * h * f0 * dt
    for (let i = 0; i < len; i++) {
      const x = (samples[start + i] ?? 0) - mean
      c += x * Math.cos(w * i)
      s += x * Math.sin(w * i)
    }
    real[h] = (2 * c) / len
    imag[h] = (2 * s) / len
  }
  const fund = Math.hypot(real[1] ?? 0, imag[1] ?? 0) || 1
  for (let h = 1; h <= n; h++) {
    real[h] = (real[h] ?? 0) / fund
    imag[h] = (imag[h] ?? 0) / fund
  }
  return { real, imag }
}
