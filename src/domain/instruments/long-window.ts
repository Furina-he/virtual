import type { SignalMeasurement } from './scope.ts'

export const LONG_WINDOW_SECONDS = 16
export const LONG_WINDOW_BINS = 2048
export const LONG_WINDOW_BIN_SECONDS = LONG_WINDOW_SECONDS / LONG_WINDOW_BINS

export type LongWindowSnapshot = {
  measurement: SignalMeasurement | null
  /** completeCycles certifies the recent stable run; rawRises counts the current threshold generation. */
  window: { start: number; end: number; rawStep: number; completeCycles: number; rawRises: number }
  revision: number
}

export type LongWindowTrace = {
  min: Float32Array
  max: Float32Array
  /** Envelope bin width, not the raw sampling step. */
  dt: number
  start: number
  end: number
}

/** Bounded raw-sample statistics and crossing evidence; envelopes never drive frequency detection. */
export class LongWindow {
  private readonly counts = new Float64Array(LONG_WINDOW_BINS)
  private readonly sums = new Float64Array(LONG_WINDOW_BINS)
  private readonly minima = new Float32Array(LONG_WINDOW_BINS)
  private readonly maxima = new Float32Array(LONG_WINDOW_BINS)
  private readonly starts = new Float64Array(LONG_WINDOW_BINS)
  private readonly ends = new Float64Array(LONG_WINDOW_BINS)
  private readonly rises = new Float64Array(LONG_WINDOW_BINS)
  private readonly firstRises = new Float64Array(LONG_WINDOW_BINS)
  private readonly recentRises = new Float64Array(3)
  private recentCount = 0
  private stableCycles = 0
  private stablePeriod = 0
  private origin = 0
  private currentBin = -1
  private rawStep = 0
  private nextTime: number | undefined
  private lastTime = 0
  private level: number | undefined
  private hysteresis = 0
  private armed = false
  private previousValue: number | undefined
  private previousTime = 0
  private revision = 0
  private contextKey: string | undefined

  clear(): void {
    this.counts.fill(0)
    this.clearEdges()
    this.currentBin = -1
    this.rawStep = 0
    this.nextTime = undefined
    this.lastTime = 0
    this.level = undefined
    this.hysteresis = 0
    this.revision++
  }

  /** Call even for a repeated key: load/alter/display boundaries must not retain old evidence. */
  reset(contextKey?: string): void {
    this.contextKey = contextKey
    this.clear()
  }

  get context(): string | undefined {
    return this.contextKey
  }

  push(samples: Float32Array, t0: number, dt: number): void {
    if (samples.length === 0) return
    const nextTime = t0 + samples.length * dt
    const lastTime = t0 + (samples.length - 1) * dt
    if (
      !Number.isFinite(t0) ||
      !Number.isFinite(dt) ||
      dt <= 0 ||
      !Number.isFinite(nextTime) ||
      !Number.isFinite(lastTime) ||
      nextTime <= lastTime
    ) {
      this.clear()
      return
    }
    const tolerance = Math.max(
      dt * 1e-6,
      4 * Number.EPSILON * Math.max(dt, Math.abs(t0), Math.abs(this.nextTime ?? t0)),
    )
    if (dt !== this.rawStep || (this.nextTime !== undefined && Math.abs(t0 - this.nextTime) > tolerance)) {
      this.clear()
    }
    if (this.currentBin < 0) this.origin = t0
    this.rawStep = dt

    for (let i = 0; i < samples.length; i++) {
      const value = samples[i] as number
      if (!Number.isFinite(value)) {
        this.clear()
        return
      }
      const time = t0 + i * dt
      const bin = Math.floor((time - this.origin) / LONG_WINDOW_BIN_SECONDS)
      if (!Number.isSafeInteger(bin) || bin < 0) {
        this.clear()
        return
      }
      if (bin !== this.currentBin) this.enterBin(bin)
      const slot = bin % LONG_WINDOW_BINS
      const count = this.counts[slot] as number
      if (count === 0) {
        this.starts[slot] = time
        this.minima[slot] = value
        this.maxima[slot] = value
      } else {
        this.minima[slot] = Math.min(this.minima[slot] as number, value)
        this.maxima[slot] = Math.max(this.maxima[slot] as number, value)
      }
      this.counts[slot] = count + 1
      this.sums[slot] = (this.sums[slot] as number) + value
      this.ends[slot] = time
      this.crossing(value, time, slot)
      this.lastTime = time
    }
    this.nextTime = nextTime
    this.revision++
  }

  /** Edge bins are included whole; start/end report the actual retained raw-sample coverage. */
  snapshot(windowSec = LONG_WINDOW_SECONDS): LongWindowSnapshot {
    const first = this.firstBin(windowSec)
    let count = 0
    let sum = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let start = this.lastTime
    let rawRises = 0
    for (let bin = first; bin <= this.currentBin; bin++) {
      const slot = bin % LONG_WINDOW_BINS
      const n = this.counts[slot] as number
      if (n === 0) continue
      if (count === 0) start = this.starts[slot] as number
      count += n
      sum += this.sums[slot] as number
      min = Math.min(min, this.minima[slot] as number)
      max = Math.max(max, this.maxima[slot] as number)
      rawRises += this.rises[slot] as number
      if ((this.rises[slot] as number) > 0 && (this.firstRises[slot] as number) < start) rawRises--
    }
    const mean = count > 0 ? sum / count : 0
    const vpp = max - min
    let period: number | null = null
    if (count >= 2 && vpp > Math.max(1e-3, Math.abs(mean) * 1e-3) && this.recentCount === 3) {
      const firstRise = this.recentRises[0] as number
      const middleRise = this.recentRises[1] as number
      const lastRise = this.recentRises[2] as number
      const a = middleRise - firstRise
      const b = lastRise - middleRise
      const candidate = (a + b) / 2
      if (
        firstRise >= start &&
        a > 0 &&
        b > 0 &&
        Math.abs(a - b) <= candidate * 0.01 &&
        this.lastTime - lastRise <= candidate * 1.01 + this.rawStep * 2
      ) {
        period = candidate
      }
    }
    // Bound the certified stable run by actual same-generation crossings inside the requested window.
    const completeCycles = period === null ? 0 : Math.min(this.stableCycles, Math.max(0, rawRises - 1))
    return {
      measurement:
        count >= 2
          ? { min, max, vpp, mean, period, frequency: period === null ? null : 1 / period, completeCycles }
          : null,
      window: {
        start: count > 0 ? start : 0,
        end: count > 0 ? this.lastTime : 0,
        rawStep: this.rawStep,
        completeCycles,
        rawRises,
      },
      revision: this.revision,
    }
  }

  traces(windowSec = LONG_WINDOW_SECONDS, maxPoints = LONG_WINDOW_BINS): LongWindowTrace | null {
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > LONG_WINDOW_BINS) {
      throw new RangeError(`Envelope point limit must be an integer from 1 to ${LONG_WINDOW_BINS}`)
    }
    const first = this.firstBin(windowSec)
    if (this.currentBin < 0) return null
    const stride = Math.ceil((this.currentBin - first + 1) / maxPoints)
    const length = Math.ceil((this.currentBin - first + 1) / stride)
    const min = new Float32Array(length).fill(Number.NaN)
    const max = new Float32Array(length).fill(Number.NaN)
    for (let bin = first; bin <= this.currentBin; bin++) {
      const slot = bin % LONG_WINDOW_BINS
      if ((this.counts[slot] as number) === 0) continue
      const point = Math.floor((bin - first) / stride)
      min[point] = Number.isNaN(min[point])
        ? (this.minima[slot] as number)
        : Math.min(min[point] as number, this.minima[slot] as number)
      max[point] = Number.isNaN(max[point])
        ? (this.maxima[slot] as number)
        : Math.max(max[point] as number, this.maxima[slot] as number)
    }
    return {
      min,
      max,
      dt: LONG_WINDOW_BIN_SECONDS * stride,
      start: this.origin + first * LONG_WINDOW_BIN_SECONDS,
      end: this.lastTime,
    }
  }

  private firstBin(windowSec: number): number {
    if (!Number.isFinite(windowSec) || windowSec <= 0 || windowSec > LONG_WINDOW_SECONDS) {
      throw new RangeError(`Observation window must be finite and in (0, ${LONG_WINDOW_SECONDS}]`)
    }
    let first = Math.max(0, this.currentBin - LONG_WINDOW_BINS + 1)
    while (first < this.currentBin) {
      const slot = first % LONG_WINDOW_BINS
      if ((this.counts[slot] as number) > 0 && (this.ends[slot] as number) >= this.lastTime - windowSec) break
      first++
    }
    return first
  }

  private enterBin(bin: number): void {
    // Coarse raw steps may skip bins; clear each skipped slot without allocating a time-sized array.
    const from = Math.max(this.currentBin + 1, bin - LONG_WINDOW_BINS + 1)
    for (let n = from; n <= bin; n++) {
      const slot = n % LONG_WINDOW_BINS
      this.counts[slot] = 0
      this.sums[slot] = 0
      this.rises[slot] = 0
    }
    this.currentBin = bin
    let count = 0
    let sum = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let n = Math.max(0, bin - LONG_WINDOW_BINS + 1); n < bin; n++) {
      const slot = n % LONG_WINDOW_BINS
      const size = this.counts[slot] as number
      if (size === 0) continue
      count += size
      sum += this.sums[slot] as number
      min = Math.min(min, this.minima[slot] as number)
      max = Math.max(max, this.maxima[slot] as number)
    }
    const vpp = max - min
    if (count === 0 || !(vpp > Math.max(1e-3, Math.abs(sum / count) * 1e-3))) {
      if (this.level !== undefined) this.clearEdges()
      this.level = undefined
      return
    }
    const level = (max + min) / 2
    const hysteresis = vpp * 0.1
    if (
      this.level === undefined ||
      Math.abs(level - this.level) > vpp * 0.1 ||
      Math.abs(hysteresis - this.hysteresis) > this.hysteresis * 0.5
    ) {
      // Ignore small drift until it accumulates: each generation uses one unchanged raw crossing level.
      this.clearEdges()
      this.level = level
      this.hysteresis = hysteresis
    }
  }

  private clearEdges(): void {
    this.rises.fill(0)
    this.recentCount = 0
    this.stableCycles = 0
    this.stablePeriod = 0
    this.armed = false
    this.previousValue = undefined
  }

  private crossing(value: number, time: number, slot: number): void {
    const previous = this.previousValue
    const level = this.level
    if (level !== undefined && previous !== undefined) {
      if (previous < level - this.hysteresis) this.armed = true
      if (this.armed && previous < level && value >= level) {
        const at = this.previousTime + ((level - previous) / (value - previous)) * (time - this.previousTime)
        if ((this.rises[slot] as number) === 0) this.firstRises[slot] = at
        this.rises[slot] = (this.rises[slot] as number) + 1
        if (this.recentCount < 3) {
          this.recentRises[this.recentCount++] = at
        } else {
          this.recentRises[0] = this.recentRises[1] as number
          this.recentRises[1] = this.recentRises[2] as number
          this.recentRises[2] = at
        }
        if (this.recentCount === 3) {
          const a = (this.recentRises[1] as number) - (this.recentRises[0] as number)
          const b = (this.recentRises[2] as number) - (this.recentRises[1] as number)
          const period = (a + b) / 2
          if (a > 0 && b > 0 && Math.abs(a - b) <= period * 0.01) {
            if (this.stableCycles >= 2 && Math.abs(b - this.stablePeriod) <= this.stablePeriod * 0.01)
              this.stableCycles++
            else {
              this.stableCycles = 2
              this.stablePeriod = period
            }
          } else {
            this.stableCycles = 0
            this.stablePeriod = 0
          }
        }
        this.armed = false
      }
    }
    this.previousValue = value
    this.previousTime = time
  }
}
