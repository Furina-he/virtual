import { describe, expect, it } from 'vitest'
import { analyzeTone, harmonicTable, type ToneFrame, ToneTracker } from './tone'

const RATE = 44100
const DT = 1 / RATE

function wave(f: (t: number) => number, sec: number): Float32Array {
  return Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => f(i * DT))
}

describe('基频/包络提取', () => {
  it('正弦 440 Hz：基频 ±0.5%，RMS = A/√2', () => {
    const frames = analyzeTone(
      wave((t) => 2 * Math.sin(2 * Math.PI * 440 * t), 0.5),
      0,
      DT,
    )
    for (const f of frames.slice(10)) {
      expect(f.f0).toBeGreaterThan(440 * 0.995)
      expect(f.f0).toBeLessThan(440 * 1.005)
      expect(f.rms).toBeCloseTo(Math.SQRT2, 1)
    }
  })

  it('带直流偏置的方波跳频 600→900 Hz：一帧内跟上', () => {
    const sq = (f: number, t: number) => 3 + (Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1)
    const x = wave((t) => (t < 0.3 ? sq(600, t) : sq(900, t)), 0.6)
    // 分块送入，与数据端口逐块到达一致
    const tr = new ToneTracker()
    const frames: ToneFrame[] = []
    for (let i = 0; i < x.length; i += 2048) frames.push(...tr.push(x.subarray(i, i + 2048), i * DT, DT))
    const at = (t: number) => frames.find((f) => f.t >= t)?.f0 ?? 0
    expect(at(0.2)).toBeCloseTo(600, -1)
    expect(at(0.35)).toBeCloseTo(900, -1)
  })

  it('静音帧 f0 = 0', () => {
    const frames = analyzeTone(new Float32Array(RATE / 5), 0, DT)
    expect(frames.every((f) => f.f0 === 0 && f.rms === 0)).toBe(true)
  })

  it('方波谐波表：只有奇次谐波，幅度约 1/n', () => {
    const f0 = 441
    const { real, imag } = harmonicTable(
      wave((t) => (Math.sin(2 * Math.PI * f0 * t) >= 0 ? 1 : -1), 0.1),
      DT,
      f0,
      7,
    )
    const amp = (h: number) => Math.hypot(real[h] ?? 0, imag[h] ?? 0)
    expect(amp(1)).toBeCloseTo(1, 5)
    expect(amp(2)).toBeLessThan(0.02)
    expect(amp(3)).toBeCloseTo(1 / 3, 1)
    expect(amp(5)).toBeCloseTo(1 / 5, 1)
  })
})
