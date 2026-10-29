import { describe, expect, it } from 'vitest'
import { LONG_WINDOW_BIN_SECONDS, LONG_WINDOW_BINS, LongWindow } from './long-window.ts'

function stream(
  window: LongWindow,
  from: number,
  until: number,
  dt: number,
  value: (time: number) => number,
  sizes = [4096],
): void {
  const count = Math.round((until - from) / dt)
  for (let offset = 0, chunk = 0; offset < count; chunk++) {
    const size = Math.min(count - offset, sizes[chunk % sizes.length] as number)
    const samples = Float32Array.from({ length: size }, (_, i) => value(from + (offset + i) * dt))
    window.push(samples, from + offset * dt, dt)
    offset += size
  }
}

const square = (time: number) => (time % 1 < 0.5 ? 0 : 5)

function ready(): LongWindow {
  const window = new LongWindow()
  stream(window, 0, 3.6, 1e-3, square)
  expect(window.snapshot().measurement?.frequency).toBeCloseTo(1, 6)
  return window
}

describe('LongWindow', () => {
  it('measures real 1 Hz at a 2 us raw step across arbitrary chunk boundaries', () => {
    const window = new LongWindow()
    stream(window, 0, 3.25, 2e-6, (t) => 7 + 2 * Math.sin(2 * Math.PI * t), [23, 4096, 65_537])
    const snapshot = window.snapshot(4)
    expect(snapshot.measurement?.frequency).toBeCloseTo(1, 5)
    expect(snapshot.measurement?.period).toBeCloseTo(1, 5)
    expect(snapshot.measurement?.vpp).toBeCloseTo(4, 5)
    expect(snapshot.window.rawStep).toBe(2e-6)
    expect(snapshot.window.start).toBe(0)
    expect(snapshot.window.end).toBeCloseTo(3.25 - 2e-6, 10)
    expect(snapshot.window.completeCycles).toBe(2)
    expect(snapshot.window.rawRises).toBeGreaterThanOrEqual(3)
  })

  it('does not certify one complete period from only two real rising edges', () => {
    const window = new LongWindow()
    stream(window, 0, 2.6, 2e-6, square)
    const incomplete = window.snapshot()
    expect(incomplete.window.rawRises).toBe(2)
    expect(incomplete.window.completeCycles).toBe(0)
    expect(incomplete.measurement?.frequency).toBeNull()
    expect(incomplete.measurement?.period).toBeNull()
    stream(window, 2.6, 3.6, 2e-6, square)
    expect(window.snapshot().measurement?.frequency).toBeCloseTo(1, 5)
    expect(window.snapshot().measurement?.completeCycles).toBe(2)
  })

  it('rolls away a 1.315 s startup interval and certifies the latest two 1.011 s intervals', () => {
    const window = new LongWindow()
    const rises = [0.1, 1.415, 2.426, 3.437]
    const wave = (t: number) => ((t >= 0.02 && t < 0.04) || rises.some((rise) => t >= rise && t < rise + 0.1) ? 5 : 0)
    stream(window, 0, 2.6, 1e-4, wave)
    expect(window.snapshot().window.rawRises).toBe(3)
    expect(window.snapshot().measurement?.frequency).toBeNull()
    stream(window, 2.6, 3.6, 1e-4, wave)
    expect(window.snapshot().measurement?.period).toBeCloseTo(1.011, 4)
    expect(window.snapshot().measurement?.frequency).toBeCloseTo(1 / 1.011, 4)
  })

  it('certifies three or more consistent intervals without counting irregular history or expired edges', () => {
    const window = new LongWindow()
    stream(window, 0, 5.6, 1e-3, square)
    expect(window.snapshot(6).measurement?.completeCycles).toBeGreaterThanOrEqual(3)
    expect(window.snapshot(3).measurement?.completeCycles).toBe(2)
    expect(window.snapshot(1).measurement?.completeCycles).toBe(0)
    stream(window, 5.6, 6.6, 1e-3, () => 3)
    expect(window.snapshot().measurement?.completeCycles).toBe(0)
  })

  it('withdraws stale periodic evidence after an oscillation stops, without inventing zero Hz', () => {
    const window = ready()
    stream(window, 3.6, 5.1, 1e-3, () => 5)
    const snapshot = window.snapshot()
    expect(snapshot.measurement?.vpp).toBe(5)
    expect(snapshot.measurement?.frequency).toBeNull()
    expect(snapshot.measurement?.period).toBeNull()
    expect(snapshot.window.completeCycles).toBe(0)
    expect(window.snapshot(1).measurement).toMatchObject({ mean: 5, min: 5, max: 5, frequency: null })
  })

  it('preserves platforms and fixed storage while old transients expire from the real window', () => {
    const window = new LongWindow()
    const arrays = Object.values(window).filter(
      (value): value is Float32Array | Float64Array => value instanceof Float32Array || value instanceof Float64Array,
    )
    expect(arrays.every((array) => array.length <= LONG_WINDOW_BINS)).toBe(true)
    expect(arrays.reduce((bytes, array) => bytes + array.byteLength, 0)).toBeLessThan(128 * 1024)
    stream(window, 0, 60, 1e-3, (t) => (t < 1 ? -50 : 3))
    const snapshot = window.snapshot(4)
    expect(snapshot.measurement).toEqual({
      mean: 3,
      min: 3,
      max: 3,
      vpp: 0,
      frequency: null,
      period: null,
      completeCycles: 0,
    })
    expect(snapshot.window.start).toBeGreaterThanOrEqual(56 - LONG_WINDOW_BIN_SECONDS - 1e-3)
    expect(snapshot.window.end - snapshot.window.start).toBeLessThanOrEqual(4 + LONG_WINDOW_BIN_SECONDS)
    expect(window.snapshot(16).window.end - window.snapshot(16).window.start).toBeLessThanOrEqual(16)
    const retained = Object.values(window).filter((value) => ArrayBuffer.isView(value))
    expect(retained).toHaveLength(arrays.length)
    retained.forEach((array, index) => {
      expect(array).toBe(arrays[index])
    })
    expect(window.traces(16)?.min.length).toBeLessThanOrEqual(LONG_WINDOW_BINS)
  })

  it('cannot alias a 10 s, 1025 Hz carrier into 1 Hz through the 128 Hz envelope bins', () => {
    const window = new LongWindow()
    stream(window, 0, 10, 2e-6, (t) => 5 * Math.sin(2 * Math.PI * 1025 * t))
    const snapshot = window.snapshot(10)
    expect(snapshot.window.rawRises).toBeGreaterThan(10_000)
    expect(snapshot.measurement?.frequency).toBeCloseTo(1025, 3)
    expect(window.traces(10)?.dt).toBe(LONG_WINDOW_BIN_SECONDS)
    expect(window.traces(10)?.min.length).toBeLessThanOrEqual(LONG_WINDOW_BINS)
  })

  it('uses raw carrier crossings for mixed signals and rejects the silent gap between repeated bursts', () => {
    const mixed = new LongWindow()
    stream(mixed, 0, 1.1, 2e-6, (t) => 4 * Math.sin(2 * Math.PI * 1025 * t) + 0.4 * Math.sin(2 * Math.PI * t))
    expect(mixed.snapshot().measurement?.frequency).toBeGreaterThan(1000)
    expect(mixed.snapshot().measurement?.frequency).toBeLessThan(1050)
    const bursts = new LongWindow()
    const burst = (t: number) => (t % 1 < 0.12 ? 5 * Math.sin(2 * Math.PI * 1025 * t) : 0)
    stream(bursts, 0, 2.08, 2e-6, burst)
    expect(bursts.snapshot().measurement?.frequency).toBeCloseTo(1025, 3)
    stream(bursts, 2.08, 2.3, 2e-6, burst)
    expect(bursts.snapshot().measurement?.frequency).toBeNull()
    expect(bursts.snapshot().window.completeCycles).toBe(0)
  })

  it('does not reuse the latest three edges when they lie outside the requested real window', () => {
    const window = ready()
    expect(window.snapshot(0.1).measurement?.frequency).toBeNull()
    expect(window.snapshot(0.1).window.completeCycles).toBe(0)
    expect(window.snapshot(4).measurement?.frequency).toBeCloseTo(1, 6)
  })

  it('returns true extrema envelopes, including single-raw-sample spikes, with a bounded point limit', () => {
    const samples = new Float32Array(8192).fill(2)
    samples[10] = 7
    samples[3905] = -3
    samples[6000] = 8
    const window = new LongWindow()
    window.push(samples, 0, 2e-6)
    const trace = window.traces()
    expect(trace?.min[0]).toBe(-3)
    expect(trace?.max[0]).toBe(7)
    expect(trace?.max[1]).toBe(8)
    expect(trace?.dt).toBe(LONG_WINDOW_BIN_SECONDS)
    expect(trace?.start).toBe(0)
    const merged = window.traces(16, 1)
    expect(merged?.min).toEqual(Float32Array.of(-3))
    expect(merged?.max).toEqual(Float32Array.of(8))
    expect(merged?.dt).toBe(3 * LONG_WINDOW_BIN_SECONDS)
    expect(window.snapshot().measurement).toMatchObject({ min: -3, max: 8, mean: 2 + 6 / 8192 })
  })

  it('leaves skipped envelope bins empty rather than fabricating interpolated samples', () => {
    const window = new LongWindow()
    window.push(Float32Array.of(1, 2, 3, 4), 0, LONG_WINDOW_BIN_SECONDS * 2)
    const trace = window.traces()
    expect(trace?.min.length).toBe(7)
    expect(trace?.min[0]).toBe(1)
    expect(trace?.min[2]).toBe(2)
    expect(Number.isNaN(trace?.min[1])).toBe(true)
    expect(window.snapshot().measurement?.frequency).toBeNull()
  })

  it.each([3.601, 3.59, 0, -1])('clears evidence and history on a gap/overlap/restart at %s', (t0) => {
    const window = ready()
    const revision = window.snapshot().revision
    window.push(new Float32Array(20).fill(9), t0, 1e-3)
    const snapshot = window.snapshot()
    expect(snapshot.measurement).toMatchObject({ min: 9, max: 9, mean: 9, frequency: null })
    expect(snapshot.window.start).toBe(t0)
    expect(snapshot.window.rawRises).toBe(0)
    expect(snapshot.revision).toBeGreaterThan(revision)
  })

  it('clears every previous window when the raw step changes', () => {
    const window = ready()
    window.push(new Float32Array(20).fill(11), 3.6, 2e-3)
    expect(window.snapshot().measurement).toMatchObject({ mean: 11, vpp: 0, frequency: null })
    expect(window.snapshot().window).toMatchObject({ start: 3.6, rawStep: 2e-3, rawRises: 0, completeCycles: 0 })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects an entire broken chunk containing %s',
    (value) => {
      const window = ready()
      window.push(Float32Array.of(2, value, 3), 3.6, 1e-3)
      expect(window.snapshot().measurement).toBeNull()
      expect(window.traces()).toBeNull()
      window.push(Float32Array.of(4, 4), 4, 1e-3)
      expect(window.snapshot().measurement).toMatchObject({ mean: 4, min: 4, max: 4, frequency: null })
      expect(window.snapshot().window.start).toBe(4)
    },
  )

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid raw step %s', (dt) => {
    const window = ready()
    window.push(Float32Array.of(1, 2), 3.6, dt)
    expect(window.snapshot().measurement).toBeNull()
    expect(window.snapshot().window.completeCycles).toBe(0)
  })

  it('rejects nonfinite timestamps and timestamps too large to represent the raw step', () => {
    const window = ready()
    window.push(Float32Array.of(1, 2), Number.NaN, 1e-3)
    expect(window.snapshot().measurement).toBeNull()
    window.push(Float32Array.of(1, 2), 1e30, 2e-6)
    expect(window.snapshot().measurement).toBeNull()
  })

  it('retains chunk-boundary interpolation and tolerates only timestamp roundoff', () => {
    const whole = new LongWindow()
    const fragmented = new LongWindow()
    const dt = 1e-4
    const origin = 1e6
    const samples = Float32Array.from({ length: 36_000 }, (_, i) => square(i * dt))
    whole.push(samples, origin, dt)
    for (let offset = 0; offset < samples.length; offset += 137) {
      fragmented.push(samples.subarray(offset, Math.min(offset + 137, samples.length)), origin + offset * dt, dt)
    }
    expect(fragmented.snapshot().measurement?.mean).toBe(whole.snapshot().measurement?.mean)
    expect(fragmented.snapshot().measurement?.frequency).toBeCloseTo(
      whole.snapshot().measurement?.frequency as number,
      10,
    )
    fragmented.push(Float32Array.of(8, 8), origin + samples.length * dt + dt, dt)
    expect(fragmented.snapshot().measurement).toMatchObject({ mean: 8, frequency: null })
  })

  it('does not combine old edges after a material threshold change but ignores small drift', () => {
    const window = ready()
    stream(window, 3.6, 3.7, 1e-3, () => 5.1)
    expect(window.snapshot().measurement?.frequency).toBeCloseTo(1, 6)
    stream(window, 3.7, 3.8, 1e-3, () => 50)
    expect(window.snapshot().measurement?.frequency).toBeNull()
    expect(window.snapshot().window.rawRises).toBe(0)
    stream(window, 3.8, 5.9, 1e-3, (t) => (t % 1 < 0.5 ? 0 : 50))
    expect(window.snapshot().measurement?.frequency).toBeNull()
    stream(window, 5.9, 6.6, 1e-3, (t) => (t % 1 < 0.5 ? 0 : 50))
    expect(window.snapshot().measurement?.frequency).toBeCloseTo(1, 6)
  })

  it('isolates explicit reset/load/alter/display boundaries even when the context key repeats', () => {
    const window = ready()
    for (const context of ['load:1', 'alter:2', 'display:3', 'display:3']) {
      const revision = window.snapshot().revision
      window.reset(context)
      expect(window.context).toBe(context)
      expect(window.snapshot().measurement).toBeNull()
      expect(window.snapshot().revision).toBeGreaterThan(revision)
      expect(window.traces()).toBeNull()
      stream(window, 0, 3.6, 1e-3, square)
      expect(window.snapshot().measurement?.frequency).toBeCloseTo(1, 6)
    }
    window.clear()
    expect(window.snapshot().measurement).toBeNull()
  })

  it('has no observation before two raw samples and rejects out-of-contract window/point sizes', () => {
    const window = new LongWindow()
    expect(window.snapshot().measurement).toBeNull()
    expect(window.traces()).toBeNull()
    window.push(Float32Array.of(2), 0, 2e-6)
    expect(window.snapshot().measurement).toBeNull()
    for (const seconds of [0, -1, 17, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => window.snapshot(seconds)).toThrow(RangeError)
      expect(() => window.traces(seconds)).toThrow(RangeError)
    }
    for (const points of [0, -1, 2.5, 2049, Number.NaN]) {
      expect(() => window.traces(16, points)).toThrow(RangeError)
    }
  })
})
