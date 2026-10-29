import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveScope } from '../../domain/instruments/index.ts'
import { scopeProbeId } from '../../domain/measurement/plan.ts'
import { Instrument } from '../../shared/schema/instrument.ts'
import { clearInstrumentReadings, setInstrumentReading } from './instrument-readings'
import { RingBuffer } from './ring-buffer'
import { acquireScope, resetScopeAcquisition, scopeSummary } from './scope-acquisition'

const scope = Instrument.parse(JSON.parse(readFileSync('content/instruments/ins-oscilloscope/instrument.json', 'utf8')))
const dt = 1e-6
const buffers = new Map<string, RingBuffer>()
const buffer = (id: string) => {
  let b = buffers.get(id)
  if (!b) {
    b = new RingBuffer(1 << 16)
    buffers.set(id, b)
  }
  return b
}
let t = 0
function feed(seconds: number, fn: (time: number) => number) {
  const count = Math.round(seconds / dt)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = fn(t + i * dt)
  buffer(scopeProbeId('s', 'CH1')).push(samples, t, dt)
  buffer(scopeProbeId('s', 'CH2')).push(
    samples.map((v) => v / 2),
    t,
    dt,
  )
  t += count * dt
}
const sine = (time: number) => Math.sin(2 * Math.PI * 1000 * time)
let clock = 0
const acquire = (settings: Record<string, unknown> = {}) => {
  clock += 200
  return acquireScope('s', scope, settings, clock, buffer)
}
const live = () => {
  for (const key of ['main', 'CH1', 'CH2']) setInstrumentReading('s', { text: '', unit: '', status: 'ok' }, key)
}

afterEach(() => {
  resetScopeAcquisition()
  clearInstrumentReadings()
  buffers.clear()
  t = 0
})

describe('示波器采集', () => {
  it('未上电或通道未接入时不显示轨迹', () => {
    feed(0.01, sine)
    expect(acquire().state).toBe('off')
  })

  it('自动触发：触发点落在屏幕中心，水平位移移动触发点；测量来自真实采样', () => {
    live()
    feed(0.01, sine)
    const frame = acquire()
    expect(frame.state).toBe('triggered')
    expect(frame.pointsPerDiv).toBe(200)
    expect(frame.traces[0]?.length).toBe(2001)
    const summary = scopeSummary(frame, resolveScope(scope))
    expect(summary.channels[0]?.crossing).toBeCloseTo(5, 1)
    expect(summary.channels[0]?.vpp).toBeCloseTo(2, 2)
    expect(summary.channels[0]?.frequency).toBeCloseTo(1000, 0)
    expect(summary.channels[1]?.vpp).toBeCloseTo(1, 2)
    // 0.5 V/div：±1 V 对应 ±2 格；垂直位移 +1 格
    expect(summary.channels[0]?.top).toBeCloseTo(2, 1)
    const moved = { hpos: -2, ch1_pos: 1, ch1_vdiv: 1 }
    const shifted = scopeSummary(acquire(moved), resolveScope(scope, moved))
    expect(shifted.channels[0]?.crossing).toBeCloseTo(3, 1)
    expect(shifted.channels[0]?.top).toBeCloseTo(2, 1)
    expect(shifted.channels[0]?.bottom).toBeCloseTo(0, 1)
  })

  it('AC 耦合去掉直流，GND 耦合显示零电平且不测量', () => {
    live()
    feed(0.01, (time) => 3 + sine(time))
    const ac = { ch1_coupling: 1 }
    const summary = scopeSummary(acquire(ac), resolveScope(scope, ac))
    expect(summary.channels[0]?.top).toBeCloseTo(2, 1)
    expect(summary.channels[0]?.bottom).toBeCloseTo(-2, 1)
    const gnd = { ch1_coupling: 2 }
    const grounded = scopeSummary(acquire(gnd), resolveScope(scope, gnd))
    expect(grounded.channels[0]).toMatchObject({ top: 0, bottom: 0, vpp: null })
  })

  it('常规触发无触发时保留上一屏；自动触发无触发时滚动显示', () => {
    live()
    feed(0.01, sine)
    const first = acquire({ trig_mode: 1 })
    expect(first.state).toBe('triggered')
    feed(0.01, () => 0)
    const waiting = acquire({ trig_mode: 1 })
    expect(waiting.state).toBe('waiting')
    expect(waiting.traces).toBe(first.traces)
    const auto = acquire({ trig_mode: 0, trig_level: 5 })
    expect(auto.state).toBe('auto')
    expect(auto.traces[0]?.every((v) => v === 0)).toBe(true)
  })

  it('单次触发捕获后冻结，再次布防后重新捕获；停止时冻结', () => {
    live()
    feed(0.005, () => 0)
    expect(acquire({ trig_mode: 2, arm: 1 }).state).toBe('ready')
    feed(0.01, sine)
    const captured = acquire({ trig_mode: 2, arm: 1 })
    expect(captured.state).toBe('stopped')
    feed(0.01, (time) => 2 * sine(time))
    expect(acquire({ trig_mode: 2, arm: 1 }).traces).toBe(captured.traces)
    const waiting = acquire({ trig_mode: 2, arm: 2 })
    expect(waiting.state).toBe('ready')
    expect(waiting.traces).toBe(captured.traces)
    expect(acquire({ trig_mode: 2, arm: 2 })).toBe(waiting)
    feed(0.01, () => -1)
    expect(acquire({ trig_mode: 2, arm: 2 }).state).toBe('ready')
    feed(0.004, () => 3)
    const rearmed = acquire({ trig_mode: 2, arm: 2 })
    expect(rearmed.state).toBe('stopped')
    expect(rearmed.traces).not.toBe(captured.traces)
    expect(Math.max(...(rearmed.traces[0] ?? []))).toBeCloseTo(3, 1)
    expect(Math.min(...(rearmed.traces[0] ?? []))).toBeCloseTo(-1, 1)
    const stopped = acquire({ run: 0 })
    feed(0.01, sine)
    expect(acquire({ run: 0 })).toBe(stopped)
    expect(stopped.state).toBe('stopped')
  })

  it('从连续采集切到单次时不捕获已有历史，等待布防后的新边沿', () => {
    live()
    feed(0.01, sine)
    const continuous = acquire()
    expect(continuous.state).toBe('triggered')
    const waiting = acquire({ trig_mode: 2, arm: 1 })
    expect(waiting.state).toBe('ready')
    expect(waiting.traces).toBe(continuous.traces)
    feed(0.01, () => -1)
    expect(acquire({ trig_mode: 2, arm: 1 }).state).toBe('ready')
    feed(0.004, () => 1)
    const captured = acquire({ trig_mode: 2, arm: 1 })
    expect(captured.state).toBe('stopped')
    expect(Math.min(...(captured.traces[0] ?? []))).toBe(-1)
    expect(Math.max(...(captured.traces[0] ?? []))).toBe(1)
  })

  it('单次捕获在测量节流间隔内也冻结本屏读数，不沿用历史测量', () => {
    live()
    feed(0.01, (time) => 5 * sine(time))
    const initial = acquireScope('s', scope, {}, 0, buffer)
    expect(initial.measurements[0]?.vpp).toBe(10)
    const settings = { trig_mode: 2, arm: 1 }
    const waiting = acquireScope('s', scope, settings, 10, buffer)
    expect(waiting.measurements).toBe(initial.measurements)
    feed(0.01, () => -1)
    feed(0.004, () => 3)
    const captured = acquireScope('s', scope, settings, 50, buffer)
    expect(captured.state).toBe('stopped')
    expect(captured.measurements[0]).toMatchObject({ min: -1, max: 3, vpp: 4, frequency: null, period: null })
    expect(captured.measurements[1]?.vpp).toBe(2)
    expect(acquireScope('s', scope, settings, 200, buffer)).toBe(captured)
  })

  it('连续采集的自动测量仍按 10 Hz 节流', () => {
    live()
    feed(0.01, sine)
    const initial = acquireScope('s', scope, {}, 0, buffer)
    feed(0.01, (time) => 2 * sine(time))
    expect(acquireScope('s', scope, {}, 50, buffer).measurements).toBe(initial.measurements)
    feed(0.01, (time) => 2 * sine(time))
    const updated = acquireScope('s', scope, {}, 100, buffer)
    expect(updated.measurements).not.toBe(initial.measurements)
    expect(updated.measurements[0]?.vpp).toBe(4)
  })

  it('单次搜索保留历史并捕获 50 ms 数据块中最早的新尖峰', () => {
    live()
    feed(0.005, () => -1)
    const settings = { trig_mode: 2, arm: 1 }
    expect(acquire(settings).state).toBe('ready')
    feed(0.05, (time) => (time >= 0.01 && time < 0.0102 ? 1 : time >= 0.025 && time < 0.0252 ? 3 : -1))
    const captured = acquire(settings)
    expect(captured.state).toBe('stopped')
    expect(captured.measurements[0]).toMatchObject({ min: -1, max: 1, vpp: 2 })
    expect(captured.traces[0]?.length).toBe(2001)
    expect(scopeSummary(captured, resolveScope(scope, settings)).channels[0]?.crossing).toBeCloseTo(5, 1)
    feed(0.01, sine)
    expect(acquire(settings)).toBe(captured)
  })
})
