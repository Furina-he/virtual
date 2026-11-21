import { describe, expect, it } from 'vitest'
import {
  formatRealtimeRatio,
  PACE_ENTER_SLOW_RATIO,
  PACE_EXIT_SLOW_RATIO,
  PACE_MIN_OBSERVATION_SEC,
  SimulationPaceMonitor,
} from './pace.ts'

describe('SimulationPaceMonitor', () => {
  it('waits for the minimum observation span before reporting a realtime ratio or slow alert', () => {
    const monitor = new SimulationPaceMonitor()
    for (let step = 0; step < 15; step++) {
      const wallMs = step * 100
      const pace = monitor.record(step * 0.015, wallMs)
      expect(pace.realtimeRatio).toBeNull()
      expect(pace.slow).toBe(false)
    }
    const pace = monitor.record(15 * 0.015, PACE_MIN_OBSERVATION_SEC * 1000)
    expect(pace.slow).toBe(true)
    expect(pace.realtimeRatio).toBeCloseTo(0.15, 6)
  })

  it('stays clear on healthy 1.0x realtime runs with 50 ms slice quantization', () => {
    const monitor = new SimulationPaceMonitor()
    // 50 ms slices advancing every 50 ms, polled by 100 ms readings with realistic phase jitter
    for (let tick = 0; tick <= 60; tick++) {
      const wallMs = tick * 100 + (tick % 3 === 1 ? 15 : 0)
      const slices = Math.floor(wallMs / 50)
      const pace = monitor.record(slices * 0.05, wallMs)
      expect(pace.slow).toBe(false)
      if (tick >= 16) {
        expect(pace.realtimeRatio).not.toBeNull()
        expect(pace.realtimeRatio as number).toBeGreaterThanOrEqual(PACE_ENTER_SLOW_RATIO)
      }
    }
  })

  it('detects sustained slow progression and stalled slices with hysteresis', () => {
    const monitor = new SimulationPaceMonitor()
    let wallMs = 0
    let simSec = 0.05
    monitor.record(simSec, wallMs)

    // 1.5 s at 0.17x realtime (like a fine-step heavy circuit)
    for (let tick = 1; tick <= 20; tick++) {
      wallMs += 100
      simSec += 0.017
      monitor.record(simSec, wallMs)
    }
    expect(monitor.snapshot().slow).toBe(true)
    expect(monitor.snapshot().realtimeRatio).toBeCloseTo(0.17, 2)

    // Recovering to 0.88x stays slow because it is below the 0.92x hysteresis exit threshold
    for (let tick = 1; tick <= 25; tick++) {
      wallMs += 100
      simSec += 0.088
      monitor.record(simSec, wallMs)
    }
    expect(monitor.snapshot().realtimeRatio).toBeCloseTo(0.88, 2)
    expect(monitor.snapshot().slow).toBe(true)

    // Recovering to >= 0.92x clears the slow alert once the sliding window flushes old slow samples
    for (let tick = 1; tick <= 25; tick++) {
      wallMs += 100
      simSec += 0.098
      monitor.record(simSec, wallMs)
    }
    expect(monitor.snapshot().realtimeRatio).toBeGreaterThanOrEqual(PACE_EXIT_SLOW_RATIO)
    expect(monitor.snapshot().slow).toBe(false)
  })

  it('flags a stalled slice where readings repeat the same simTime past the observation span', () => {
    const monitor = new SimulationPaceMonitor()
    for (let tick = 0; tick <= 16; tick++) {
      monitor.record(0.05, tick * 100)
    }
    expect(monitor.snapshot().slow).toBe(true)
    expect(monitor.snapshot().realtimeRatio).toBe(0)
  })

  it('resets cleanly on explicit reset, session restart (simTime drop), or sleep/wake wall gap', () => {
    const monitor = new SimulationPaceMonitor()
    for (let tick = 0; tick <= 20; tick++) monitor.record(0.05 + tick * 0.01, tick * 100)
    expect(monitor.snapshot().slow).toBe(true)

    // Session restart: simTime drops back to 0.05
    const restarted = monitor.record(0.05, 2100)
    expect(restarted.slow).toBe(false)
    expect(restarted.realtimeRatio).toBeNull()

    for (let tick = 1; tick <= 20; tick++) monitor.record(0.05 + tick * 0.01, 2100 + tick * 100)
    expect(monitor.snapshot().slow).toBe(true)

    // Large wall-clock gap (e.g. system sleep > 3 s) resets window instead of inventing a fake stall
    const afterWake = monitor.record(0.25, 10_000)
    expect(afterWake.slow).toBe(false)
    expect(afterWake.realtimeRatio).toBeNull()

    // Explicit reset clears everything
    for (let tick = 1; tick <= 20; tick++) monitor.record(0.25 + tick * 0.01, 10_000 + tick * 100)
    expect(monitor.snapshot().slow).toBe(true)
    monitor.reset()
    expect(monitor.snapshot()).toEqual({ realtimeRatio: null, slow: false, wallSec: 0, simSec: 0 })
  })

  it('formats realtime ratios clearly for display', () => {
    expect(formatRealtimeRatio(0)).toBe('0.00×')
    expect(formatRealtimeRatio(0.004)).toBe('<0.01×')
    expect(formatRealtimeRatio(0.01)).toBe('0.01×')
    expect(formatRealtimeRatio(0.174)).toBe('0.17×')
    expect(formatRealtimeRatio(1)).toBe('1.00×')
    expect(formatRealtimeRatio(Number.NaN)).toBe('--')
    expect(formatRealtimeRatio(-0.5)).toBe('--')
  })
})
