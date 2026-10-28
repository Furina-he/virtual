import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../../src/shared/ipc/sim'
import { SimSession } from '../../src/sim/session'

const dir = resolve(__dirname, '../../resources/ngspice')
const SINE = ['sine', 'V1 in 0 SIN(0 1 1k)', 'R1 in out 1k', 'R2 out 0 1k', '.end'].join('\n')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('仿真会话', () => {
  const events: SimEvent[] = []
  const session = new SimSession(
    dir,
    (e) => events.push(e),
    () => {},
  )

  it('.op 返回探针值', () => {
    events.length = 0
    session.handle({
      type: 'load',
      netlist: ['div', 'V1 in 0 DC 10', 'R1 in out 1k', 'R2 out 0 3k', '.end'].join('\n'),
      probes: [
        { id: 'vout', kind: 'v', node: 'out' },
        { id: 'i', kind: 'i', source: 'V1' },
      ],
      analysis: { kind: 'op' },
    })
    const op = events.find((e) => e.type === 'op')
    expect(op?.type === 'op' && op.values.vout).toBeCloseTo(7.5, 6)
    expect(op?.type === 'op' && op.values.i).toBeCloseTo(-2.5e-3, 9)
  })

  it('1 kHz 正弦连续 tran：实时推进、块序号连续、波形正确、可暂停', async () => {
    events.length = 0
    session.handle({
      type: 'load',
      netlist: SINE,
      probes: [
        { id: 'out', kind: 'v', node: 'out' },
        { id: 'diff', kind: 'v', node: 'in', nodeRef: 'out' },
      ],
      analysis: { kind: 'tran', step: 20e-6, continuous: true },
    })
    session.handle({ type: 'run' })
    await wait(1500)
    session.handle({ type: 'pause' })
    await wait(200)
    const chunks = events.filter((e) => e.type === 'chunk')
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i))
    const n = chunks.reduce((s, c) => s + (c.data.out?.length ?? 0), 0)
    // 实时节奏：1.5 s 墙钟约 1.5 s 仿真时间（20 µs 一点）
    expect(n * 20e-6).toBeGreaterThan(1.2)
    expect(n * 20e-6).toBeLessThan(1.7)
    // 块之间时间连续
    chunks.slice(1).forEach((c, i) => {
      const p = chunks[i] as typeof c
      expect(c.t0).toBeCloseTo(p.t0 + (p.data.out?.length ?? 0) * p.dt, 9)
    })
    // v(out) = 0.5 sin(2π·1k·t)，in-out 同值
    for (const c of chunks.slice(0, 5)) {
      c.data.out?.forEach((v, k) => {
        const t = c.t0 + k * c.dt
        expect(Math.abs(v - 0.5 * Math.sin(2 * Math.PI * 1000 * t))).toBeLessThan(2e-3)
        expect(Math.abs((c.data.diff?.[k] ?? 0) - v)).toBeLessThan(1e-4)
      })
    }
    expect(events.some((e) => e.type === 'readings')).toBe(true)
    const last = events.filter((e) => e.type === 'status').at(-1)
    expect(last?.type === 'status' && last.state).toBe('paused')
    // 暂停后无新块
    const count = events.length
    await wait(300)
    expect(events.filter((e) => e.type === 'chunk').length).toBe(chunks.length)
    expect(events.length).toBe(count)
  })

  it('运行中重新载入网表：新会话块序号从 0 开始', async () => {
    session.handle({ type: 'run' })
    await wait(200)
    events.length = 0
    session.handle({
      type: 'load',
      netlist: SINE,
      probes: [{ id: 'out', kind: 'v', node: 'out' }],
      analysis: { kind: 'tran', step: 50e-6, continuous: true },
    })
    session.handle({ type: 'run' })
    await wait(500)
    session.handle({ type: 'stop' })
    await wait(100)
    // 旧会话的尾块在 loaded 之前发出，之后才是新会话
    const start = events.findIndex((e) => e.type === 'loaded')
    expect(start).toBeGreaterThanOrEqual(0)
    const chunks = events.slice(start).filter((e) => e.type === 'chunk')
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks[0]?.seq).toBe(0)
    expect(chunks[0]?.t0).toBe(0)
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i))
    session.dispose()
  })
})
