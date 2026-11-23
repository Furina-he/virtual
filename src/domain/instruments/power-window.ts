export type LoadNature = 'R' | 'L' | 'C' | 'NONE'

export type PowerMetrics = {
  /** Active power P = mean(u * i) in W (negative if coil polarity is reversed). */
  P: number
  /** Reactive power Q in var (positive for inductive L, negative for capacitive C). */
  Q: number
  /** Apparent power S = U * I in VA. */
  S: number
  /** True power factor P / S in [-1, 1]. */
  pf: number
  /** True RMS voltage U in V. */
  U: number
  /** True RMS current I in A. */
  I: number
  /** Load nature inferred from reactive magnitude and phase lag/lead sign. */
  loadNature: LoadNature
}

const RESISTIVE_Q_RATIO = 0.02
const MIN_APPARENT_POWER = 1e-6

function finalizeMetrics(
  sumU2: number,
  sumI2: number,
  sumP: number,
  count: number,
  sumQuad: number,
  quadCount: number,
): PowerMetrics {
  const U = Math.sqrt(Math.max(0, sumU2 / count))
  const I = Math.sqrt(Math.max(0, sumI2 / count))
  const P = sumP / count
  const S = U * I
  if (S < MIN_APPARENT_POWER) {
    return { P: 0, Q: 0, S: 0, pf: 0, U, I, loadNature: 'NONE' }
  }
  const pf = Math.max(-1, Math.min(1, P / S))
  const absQ = Math.sqrt(Math.max(0, S * S - P * P))
  // For u = Um sin(wt), i = Im sin(wt - phi): -mean((du/dt) * i) = +w * U * I * sin(phi) = +w * Q.
  const quadMetric = quadCount > 0 ? -sumQuad / quadCount : 0
  if (absQ / S < RESISTIVE_Q_RATIO) {
    return { P, Q: 0, S, pf, U, I, loadNature: 'R' }
  }
  const inductive = quadMetric >= 0
  const Q = inductive ? absQ : -absQ
  return { P, Q, S, pf, U, I, loadNature: inductive ? 'L' : 'C' }
}

/** Batch power calculation over equally spaced synchronized voltage/current samples. */
export function computePowerMetrics(
  voltage: ArrayLike<number>,
  current: ArrayLike<number>,
  dt: number,
): PowerMetrics | undefined {
  const n = Math.min(voltage.length, current.length)
  if (n === 0 || !Number.isFinite(dt) || dt <= 0) return undefined
  let sumU2 = 0
  let sumI2 = 0
  let sumP = 0
  let sumQuad = 0
  let quadCount = 0
  let prevU = 0
  let prevI = 0
  for (let k = 0; k < n; k++) {
    const u = voltage[k] as number
    const i = current[k] as number
    if (!Number.isFinite(u) || !Number.isFinite(i)) return undefined
    sumU2 += u * u
    sumI2 += i * i
    sumP += u * i
    if (k > 0) {
      sumQuad += ((u - prevU) / dt) * 0.5 * (i + prevI)
      quadCount++
    }
    prevU = u
    prevI = i
  }
  return finalizeMetrics(sumU2, sumI2, sumP, n, sumQuad, quadCount)
}

type PendingChunk = { data: Float32Array; t0: number; dt: number }

/**
 * Constant-memory AC power accumulator over overlapping pairs of half-windows.
 * Synchronizes paired voltage and current sample chunks by (t0, dt, length).
 */
export class PowerWindow {
  private dt = 0
  private nextTime: number | undefined
  private count = 0
  private sumU2 = 0
  private sumI2 = 0
  private sumP = 0
  private sumQuad = 0
  private quadCount = 0
  private prevU: number | undefined
  private prevI: number | undefined

  private previousSumU2 = 0
  private previousSumI2 = 0
  private previousSumP = 0
  private previousSumQuad = 0
  private previousQuadCount = 0
  private hasPrevious = false

  private pendingVoltage: PendingChunk | undefined
  private pendingCurrent: PendingChunk | undefined
  private reading: PowerMetrics | undefined

  constructor(private readonly windowSeconds = 0.2) {
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0)
      throw new RangeError('Power window duration must be finite and positive')
  }

  get value(): PowerMetrics | undefined {
    return this.reading
  }

  pushVoltage(samples: Float32Array, t0: number, dt: number): void {
    this.pendingVoltage = { data: samples, t0, dt }
    this.tryIngest()
  }

  pushCurrent(samples: Float32Array, t0: number, dt: number): void {
    this.pendingCurrent = { data: samples, t0, dt }
    this.tryIngest()
  }

  private tryIngest(): void {
    const v = this.pendingVoltage
    const c = this.pendingCurrent
    if (!v || !c) return
    const tolerance = Math.max(v.dt * 1e-6, 4 * Number.EPSILON * Math.max(v.dt, Math.abs(v.t0), Math.abs(c.t0)))
    if (v.dt !== c.dt || v.data.length !== c.data.length || Math.abs(v.t0 - c.t0) > tolerance) {
      // Keep the newer chunk and discard the stale mismatched partner.
      if (v.t0 < c.t0) this.pendingVoltage = undefined
      else if (c.t0 < v.t0) this.pendingCurrent = undefined
      else {
        this.pendingVoltage = undefined
        this.pendingCurrent = undefined
      }
      return
    }
    this.pendingVoltage = undefined
    this.pendingCurrent = undefined
    this.pushPair(v.data, c.data, v.t0, v.dt)
  }

  pushPair(voltage: Float32Array, current: Float32Array, t0: number, dt: number): void {
    const length = Math.min(voltage.length, current.length)
    if (length === 0) return
    const halfCount = Math.max(1, Math.round(this.windowSeconds / (2 * dt)))
    const nextTime = t0 + length * dt
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
    if (dt !== this.dt || (this.nextTime !== undefined && Math.abs(t0 - this.nextTime) > tolerance)) {
      this.resetAccumulators()
    }
    this.dt = dt
    this.nextTime = nextTime

    for (let k = 0; k < length; k++) {
      const u = voltage[k] as number
      const i = current[k] as number
      if (!Number.isFinite(u) || !Number.isFinite(i)) {
        this.clear()
        return
      }
      this.count++
      this.sumU2 += u * u
      this.sumI2 += i * i
      this.sumP += u * i
      if (this.prevU !== undefined && this.prevI !== undefined) {
        this.sumQuad += ((u - this.prevU) / dt) * 0.5 * (i + this.prevI)
        this.quadCount++
      }
      this.prevU = u
      this.prevI = i
      if (this.count !== halfCount) continue

      if (this.hasPrevious) {
        this.reading = finalizeMetrics(
          this.previousSumU2 + this.sumU2,
          this.previousSumI2 + this.sumI2,
          this.previousSumP + this.sumP,
          2 * halfCount,
          this.previousSumQuad + this.sumQuad,
          this.previousQuadCount + this.quadCount,
        )
      }
      this.previousSumU2 = this.sumU2
      this.previousSumI2 = this.sumI2
      this.previousSumP = this.sumP
      this.previousSumQuad = this.sumQuad
      this.previousQuadCount = this.quadCount
      this.hasPrevious = true
      this.count = 0
      this.sumU2 = 0
      this.sumI2 = 0
      this.sumP = 0
      this.sumQuad = 0
      this.quadCount = 0
    }
  }

  private resetAccumulators(): void {
    this.dt = 0
    this.nextTime = undefined
    this.count = 0
    this.sumU2 = 0
    this.sumI2 = 0
    this.sumP = 0
    this.sumQuad = 0
    this.quadCount = 0
    this.prevU = undefined
    this.prevI = undefined
    this.previousSumU2 = 0
    this.previousSumI2 = 0
    this.previousSumP = 0
    this.previousSumQuad = 0
    this.previousQuadCount = 0
    this.hasPrevious = false
    this.reading = undefined
  }

  clear(): void {
    this.resetAccumulators()
    this.pendingVoltage = undefined
    this.pendingCurrent = undefined
  }
}
