import { describe, expect, it } from 'vitest'
import { rms } from './reading.ts'
import { RmsWindow } from './rms-window.ts'

function wave(length: number, dt: number, frequency = 50, offset = 7, amplitude = 2): Float32Array {
  return Float32Array.from({ length }, (_, i) => offset + amplitude * Math.sin(2 * Math.PI * frequency * i * dt))
}

function feed(window: RmsWindow, samples: Float32Array, dt: number, sizes: number[], origin = 0): void {
  let offset = 0
  let chunk = 0
  while (offset < samples.length) {
    const end = Math.min(samples.length, offset + (sizes[chunk++ % sizes.length] as number))
    window.push(samples.subarray(offset, end), origin + offset * dt, dt)
    offset = end
  }
}

describe('RmsWindow', () => {
  it('waits for two complete half-windows before publishing a reading', () => {
    const window = new RmsWindow()
    const samples = wave(20, 0.01, 5)
    expect(window.value).toBeUndefined()
    window.push(samples.subarray(0, 10), 0, 0.01)
    expect(window.value).toBeUndefined()
    window.push(samples.subarray(10, 19), 0.1, 0.01)
    expect(window.value).toBeUndefined()
    window.push(samples.subarray(19), 0.19, 0.01)
    expect(window.value).toBeCloseTo(rms(samples), 12)
  })

  it('computes true sine RMS while rejecting the DC offset', () => {
    const dt = 1e-5
    const samples = wave(20_000, dt)
    const window = new RmsWindow()
    feed(window, samples, dt, [137, 4096, 23])
    expect(window.value).toBeCloseTo(Math.SQRT2, 7)
    expect(window.value).toBeCloseTo(rms(samples), 11)
  })

  it('returns zero for a constant DC signal', () => {
    const window = new RmsWindow()
    window.push(new Float32Array(20).fill(3), 0, 0.01)
    expect(window.value).toBe(0)
  })

  it('preserves small AC variation riding on a large DC offset', () => {
    const dt = 1e-5
    const samples = wave(20_000, dt, 50, 1e9, 128)
    const window = new RmsWindow()
    feed(window, samples, dt, [997, 4096])
    expect(window.value).toBeCloseTo(rms(samples), 6)
    expect(window.value).toBeGreaterThan(80)
  })

  it('accumulates a million raw samples instead of requiring a ring-sized window', () => {
    const dt = 2e-7
    const count = Math.round(0.2 / dt)
    const window = new RmsWindow()
    expect(count).toBe(1_000_000)
    for (let offset = 0; offset < count; offset += 4096) {
      const size = Math.min(4096, count - offset)
      const samples = Float32Array.from(
        { length: size },
        (_, i) => 3 + 2 * Math.sin(2 * Math.PI * 1000 * (offset + i) * dt),
      )
      window.push(samples, offset * dt, dt)
      if (offset + size < count) expect(window.value).toBeUndefined()
    }
    expect(window.value).toBeCloseTo(Math.SQRT2, 7)
  })

  it('includes both fast and slow components and their complete-window DC level', () => {
    const dt = 2e-7
    const samples = Float32Array.from({ length: 1_000_000 }, (_, i) => {
      const t = i * dt
      return 7 + 1.5 * Math.sin(2 * Math.PI * 312_500 * t) + 2 * Math.sin(2 * Math.PI * 3.25 * t)
    })
    const window = new RmsWindow()
    feed(window, samples, dt, [17, 4096, 65_537, 9973, 23])
    expect(window.value).toBeCloseTo(rms(samples), 8)
  })

  it('handles chunks larger than the visualization ring capacity without dropping samples', () => {
    const dt = 2e-7
    const samples = wave(1_000_000, dt, 1000)
    const window = new RmsWindow()
    window.push(samples, 0, dt)
    expect(window.value).toBeCloseTo(rms(samples), 10)
  })

  it('holds the latest reading until the next half-window completes, then uses overlapping blocks', () => {
    const window = new RmsWindow()
    const samples = Float32Array.from({ length: 30 }, (_, i) => (i < 10 ? 0 : i < 20 ? 2 : 8))
    window.push(samples.subarray(0, 20), 0, 0.01)
    expect(window.value).toBe(1)
    window.push(samples.subarray(20, 29), 0.2, 0.01)
    expect(window.value).toBe(1)
    window.push(samples.subarray(29), 0.29, 0.01)
    expect(window.value).toBe(3)
  })

  it('is independent of arbitrary chunk segmentation and ignores an incomplete trailing half-window', () => {
    const dt = 1e-4
    const samples = Float32Array.from(
      { length: 6101 },
      (_, i) => 3 + Math.sin(2 * Math.PI * 5.5 * i * dt) + 0.4 * Math.cos(2 * Math.PI * 31.3 * i * dt),
    )
    const whole = new RmsWindow()
    const fragmented = new RmsWindow()
    whole.push(samples, 0, dt)
    feed(fragmented, samples, dt, [1, 37, 1024, 300, 3])
    expect(whole.value).toBeCloseTo(rms(samples.subarray(4000, 6000)), 11)
    expect(fragmented.value).toBe(whole.value)
  })

  it('rounds the half-window sample count and supports a custom duration', () => {
    const window = new RmsWindow(0.3)
    const samples = Float32Array.from({ length: 8 }, (_, i) => (i % 2 ? 2 : -2))
    window.push(samples.subarray(0, 7), 0, 0.04)
    expect(window.value).toBeUndefined()
    window.push(samples.subarray(7), 0.28, 0.04)
    expect(window.value).toBe(2)
  })

  it('uses at least one sample per half-window for coarse sampling', () => {
    const window = new RmsWindow()
    window.push(Float32Array.of(2), 0, 0.2)
    expect(window.value).toBeUndefined()
    window.push(Float32Array.of(6), 0.2, 0.2)
    expect(window.value).toBe(2)
  })

  it('resets both the completed reading and partial blocks when dt changes', () => {
    const window = new RmsWindow()
    window.push(wave(20, 0.01, 5), 0, 0.01)
    expect(window.value).toBeDefined()
    window.push(new Float32Array(5).fill(2), 0.2, 0.02)
    expect(window.value).toBeUndefined()
    window.push(new Float32Array(5).fill(6), 0.3, 0.02)
    expect(window.value).toBe(2)
  })

  it.each([0.21, 0.1, 0, -1])('resets on a gap, overlap, or restarted timeline at %s', (nextTime) => {
    const window = new RmsWindow()
    window.push(wave(20, 0.01, 5), 0, 0.01)
    expect(window.value).toBeDefined()
    window.push(new Float32Array(10).fill(3), nextTime, 0.01)
    expect(window.value).toBeUndefined()
    window.push(new Float32Array(10).fill(5), nextTime + 0.1, 0.01)
    expect(window.value).toBe(1)
  })

  it('tolerates only floating-point roundoff between adjacent chunk timestamps', () => {
    const dt = 2e-7
    const samples = wave(1_000_000, dt, 1000)
    const window = new RmsWindow()
    feed(window, samples, dt, [4096, 9973], 1e6)
    expect(window.value).toBeCloseTo(Math.SQRT2, 7)
  })

  it('does not hide missing samples behind an absolute timestamp tolerance', () => {
    const dt = 1e-20
    const window = new RmsWindow(2 * dt)
    window.push(Float32Array.of(0, 2), 0, dt)
    expect(window.value).toBe(1)
    window.push(Float32Array.of(4), 3 * dt, dt)
    expect(window.value).toBeUndefined()
    window.push(Float32Array.of(6), 4 * dt, dt)
    expect(window.value).toBe(1)
  })

  it('clear discards completed and partial measurements and permits a new load at time zero', () => {
    const window = new RmsWindow()
    window.push(wave(25, 0.01, 5), 0, 0.01)
    expect(window.value).toBeDefined()
    window.clear()
    expect(window.value).toBeUndefined()
    window.push(new Float32Array(10).fill(3), 0, 0.01)
    expect(window.value).toBeUndefined()
    window.push(new Float32Array(10).fill(7), 0.1, 0.01)
    expect(window.value).toBe(2)
  })

  it('treats empty chunks as a no-op without disturbing the completed reading', () => {
    const window = new RmsWindow()
    window.push(wave(20, 0.01, 5), 0, 0.01)
    const value = window.value
    window.push(new Float32Array(), Number.NaN, 0)
    expect(window.value).toBe(value)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'clears the entire measurement on a nonfinite sample (%s) and recovers with fresh data',
    (invalid) => {
      const window = new RmsWindow()
      window.push(wave(20, 0.01, 5), 0, 0.01)
      window.push(Float32Array.of(3, invalid, 5), 0.2, 0.01)
      expect(window.value).toBeUndefined()
      window.push(new Float32Array(20).fill(3), 0.23, 0.01)
      expect(window.value).toBe(0)
    },
  )

  it('does not publish a prefix from a chunk containing invalid samples', () => {
    const window = new RmsWindow()
    const samples = wave(21, 0.01, 5)
    samples[20] = Number.NaN
    window.push(samples, 0, 0.01)
    expect(window.value).toBeUndefined()
  })

  it.each([0, -0.01, Number.NaN, Number.POSITIVE_INFINITY, Number.MIN_VALUE])(
    'clears invalid or unrepresentable sampling intervals (%s)',
    (dt) => {
      const window = new RmsWindow()
      window.push(wave(20, 0.01, 5), 0, 0.01)
      window.push(Float32Array.of(1), 0.2, dt)
      expect(window.value).toBeUndefined()
      window.push(new Float32Array(20).fill(3), 0, 0.01)
      expect(window.value).toBe(0)
    },
  )

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('clears invalid starting timestamps (%s)', (t0) => {
    const window = new RmsWindow()
    window.push(wave(20, 0.01, 5), 0, 0.01)
    window.push(Float32Array.of(1), t0, 0.01)
    expect(window.value).toBeUndefined()
  })

  it.each([0, -0.2, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid window durations (%s)', (duration) => {
    expect(() => new RmsWindow(duration)).toThrow(RangeError)
  })
})
