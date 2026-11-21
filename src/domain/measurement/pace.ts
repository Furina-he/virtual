// 公共仿真速度观测（技术设计 §5.4）：按实际仿真时间与单调墙钟计算实时比，不按项目编号分支。

export const PACE_WINDOW_SEC = 2
export const PACE_MIN_OBSERVATION_SEC = 1.5
export const PACE_ENTER_SLOW_RATIO = 0.85
export const PACE_EXIT_SLOW_RATIO = 0.92
export const PACE_MAX_GAP_SEC = 3

export type SimulationPace = {
  /** 实际仿真推进与墙钟之比（ΔsimTime / ΔwallTime）；观测时长不足时为 null */
  realtimeRatio: number | null
  /** 实际推进持续慢于实时（含滞回防抖） */
  slow: boolean
  /** 当前统计窗口的墙钟跨度（秒） */
  wallSec: number
  /** 当前统计窗口内推进的仿真时长（秒） */
  simSec: number
}

export type SimulationPaceOptions = {
  windowSec: number
  minObservationSec: number
  enterSlowRatio: number
  exitSlowRatio: number
  maxGapSec: number
}

type PaceSample = { wallSec: number; simSec: number }

const EMPTY_PACE: SimulationPace = { realtimeRatio: null, slow: false, wallSec: 0, simSec: 0 }

export function formatRealtimeRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return '--'
  if (ratio === 0) return '0.00×'
  if (ratio < 0.01) return '<0.01×'
  return `${ratio.toFixed(2)}×`
}

export class SimulationPaceMonitor {
  private readonly windowSec: number
  private readonly minObservationSec: number
  private readonly enterSlowRatio: number
  private readonly exitSlowRatio: number
  private readonly maxGapSec: number
  private samples: PaceSample[] = []
  private slow = false
  private current: SimulationPace = EMPTY_PACE

  constructor(options: Partial<SimulationPaceOptions> = {}) {
    this.windowSec = options.windowSec ?? PACE_WINDOW_SEC
    this.minObservationSec = options.minObservationSec ?? PACE_MIN_OBSERVATION_SEC
    this.enterSlowRatio = options.enterSlowRatio ?? PACE_ENTER_SLOW_RATIO
    this.exitSlowRatio = options.exitSlowRatio ?? PACE_EXIT_SLOW_RATIO
    this.maxGapSec = options.maxGapSec ?? PACE_MAX_GAP_SEC
    if (
      !Number.isFinite(this.windowSec) ||
      this.windowSec <= 0 ||
      !Number.isFinite(this.minObservationSec) ||
      this.minObservationSec <= 0 ||
      this.minObservationSec > this.windowSec ||
      !Number.isFinite(this.enterSlowRatio) ||
      !Number.isFinite(this.exitSlowRatio) ||
      this.enterSlowRatio <= 0 ||
      this.enterSlowRatio >= this.exitSlowRatio ||
      !Number.isFinite(this.maxGapSec) ||
      this.maxGapSec <= 0
    ) {
      throw new RangeError('Invalid SimulationPaceMonitor thresholds')
    }
  }

  reset(): void {
    this.samples = []
    this.slow = false
    this.current = EMPTY_PACE
  }

  snapshot(): SimulationPace {
    return this.current
  }

  record(simTimeSec: number, wallTimeMs: number): SimulationPace {
    if (!Number.isFinite(simTimeSec) || !Number.isFinite(wallTimeMs) || simTimeSec < 0) return this.current
    const wallSec = wallTimeMs / 1000
    const last = this.samples.at(-1)
    if (last) {
      if (wallSec < last.wallSec || simTimeSec < last.simSec || wallSec - last.wallSec > this.maxGapSec) {
        this.reset()
        this.samples.push({ wallSec, simSec: simTimeSec })
      } else if (wallSec === last.wallSec) {
        last.simSec = simTimeSec
      } else {
        this.samples.push({ wallSec, simSec: simTimeSec })
      }
    } else {
      this.samples.push({ wallSec, simSec: simTimeSec })
    }

    while (this.samples.length >= 2 && wallSec - (this.samples[1] as PaceSample).wallSec >= this.windowSec) {
      this.samples.shift()
    }

    const first = this.samples[0] as PaceSample
    const deltaWall = wallSec - first.wallSec
    const deltaSim = Math.max(0, simTimeSec - first.simSec)
    if (deltaWall < this.minObservationSec) {
      this.current = { realtimeRatio: null, slow: false, wallSec: deltaWall, simSec: deltaSim }
      return this.current
    }

    const ratio = deltaSim / deltaWall
    if (this.slow) {
      if (ratio >= this.exitSlowRatio) this.slow = false
    } else if (ratio < this.enterSlowRatio) {
      this.slow = true
    }
    this.current = { realtimeRatio: ratio, slow: this.slow, wallSec: deltaWall, simSec: deltaSim }
    return this.current
  }
}
