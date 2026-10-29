/** AC-coupled RMS over overlapping pairs of half-windows, retaining only scalar statistics. */
export class RmsWindow {
  private dt = 0
  private nextTime: number | undefined
  private count = 0
  private mean = 0
  private m2 = 0
  private previousMean = 0
  private previousM2 = 0
  private hasPrevious = false
  private reading: number | undefined

  constructor(private readonly windowSeconds = 0.2) {
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0)
      throw new RangeError('RMS window duration must be finite and positive')
  }

  get value(): number | undefined {
    return this.reading
  }

  push(samples: Float32Array, t0: number, dt: number): void {
    if (samples.length === 0) return
    const halfCount = Math.max(1, Math.round(this.windowSeconds / (2 * dt)))
    const nextTime = t0 + samples.length * dt
    if (
      !Number.isFinite(t0) ||
      !Number.isFinite(dt) ||
      dt <= 0 ||
      !Number.isSafeInteger(halfCount) ||
      !Number.isFinite(nextTime)
    ) {
      this.clear()
      return
    }

    const tolerance = Math.max(
      dt * 1e-6,
      4 * Number.EPSILON * Math.max(dt, Math.abs(t0), Math.abs(this.nextTime ?? t0)),
    )
    if (dt !== this.dt || (this.nextTime !== undefined && Math.abs(t0 - this.nextTime) > tolerance)) this.clear()
    this.dt = dt
    this.nextTime = nextTime

    for (const sample of samples) {
      if (!Number.isFinite(sample)) {
        this.clear()
        return
      }
      this.count++
      const delta = sample - this.mean
      this.mean += delta / this.count
      this.m2 += delta * (sample - this.mean)
      if (this.count !== halfCount) continue

      if (this.hasPrevious) {
        // Merging means preserves slow signal power that averaging half-window variances would discard.
        const meanDelta = this.mean - this.previousMean
        const variance = (this.previousM2 + this.m2) / (2 * halfCount) + (meanDelta * meanDelta) / 4
        this.reading = Math.sqrt(Math.max(0, variance))
      }
      this.previousMean = this.mean
      this.previousM2 = this.m2
      this.hasPrevious = true
      this.count = 0
      this.mean = 0
      this.m2 = 0
    }
  }

  clear(): void {
    this.dt = 0
    this.nextTime = undefined
    this.count = 0
    this.mean = 0
    this.m2 = 0
    this.previousMean = 0
    this.previousM2 = 0
    this.hasPrevious = false
    this.reading = undefined
  }
}
