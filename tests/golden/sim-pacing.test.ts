// T0.6 验收：realtime 节奏下 74LS90 接 1 Hz 脉冲，计 60 次与墙钟误差 <2%；window 节奏不受实时限制。
// 真实运行约 62 s。
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../../src/shared/ipc/sim'
import { SimSession } from '../../src/sim/session'
import { lib } from './models/helpers'

const dir = resolve(__dirname, '../../resources/ngspice')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let sink: (e: SimEvent) => void = () => {}
const session = new SimSession(
  dir,
  (e) => sink(e),
  () => {},
)

describe('节奏控制（SIM-11）', () => {
  it('realtime：74LS90 接 1 Hz 脉冲，60 次计数与墙钟误差 <2%', async () => {
    const step = 1e-3
    // 每次计数（时钟下降沿）记录：BCD 值、仿真时刻、所在块到达的墙钟时刻
    const counts: { n: number; sim: number; wall: number }[] = []
    let prev = -1
    sink = (e) => {
      if (e.type !== 'chunk') return
      const wall = performance.now() / 1000
      const [qa, qb, qc, qd] = ['qa', 'qb', 'qc', 'qd'].map((id) => e.data[id] ?? new Float32Array(0))
      for (let i = 0; i < (qa?.length ?? 0); i++) {
        const bit = (a: Float32Array | undefined) => ((a?.[i] ?? 0) > 2 ? 1 : 0)
        const n = bit(qa) + 2 * bit(qb) + 4 * bit(qc) + 8 * bit(qd)
        if (prev >= 0 && n !== prev) counts.push({ n, sim: e.t0 + i * e.dt, wall })
        prev = n
      }
    }
    session.handle({
      type: 'load',
      netlist: [
        'ls90 1hz',
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        // 1 Hz 秒脉冲，下降沿在 1.001 s + k
        'VCK cka 0 PULSE(0 5 0.5 1m 1m 0.499 1)',
        'VR0 r0 0 PWL(0 5 0.1 5 0.11 0)',
        'VR9 r9 0 DC 0',
        'X1 qa r0 r0 nc4 vcc r9 r9 qc qb 0 qd qa nc13 cka SN74LS90',
        'RLA qa 0 10k',
        'RLB qb 0 10k',
        'RLC qc 0 10k',
        'RLD qd 0 10k',
        '.end',
      ].join('\n'),
      probes: ['qa', 'qb', 'qc', 'qd'].map((id) => ({ id, kind: 'v' as const, node: id })),
      analysis: { kind: 'tran', step, continuous: true },
    })
    session.handle({ type: 'setPacing', mode: 'realtime' })
    session.handle({ type: 'run' })
    await wait(62_500)
    session.handle({ type: 'pause' })
    await wait(200)
    expect(counts.length).toBeGreaterThanOrEqual(61)
    // 计数序列 1,2,…,9,0,1,…
    counts.forEach((c, k) => {
      expect(c.n).toBe((k + 1) % 10)
    })
    const first = counts[0] as (typeof counts)[0]
    const last = counts[60] as (typeof counts)[0]
    const wall = last.wall - first.wall
    const sim = last.sim - first.sim
    const err = Math.abs(wall - 60) / 60
    console.log(`60 次计数：仿真 ${sim.toFixed(3)} s，墙钟 ${wall.toFixed(3)} s，误差 ${(err * 100).toFixed(2)}%`)
    expect(sim).toBeCloseTo(60, 2)
    expect(err).toBeLessThan(0.02)
  }, 90_000)

  it('window：windowSec=0.5 时仿真速度约为实时的 5 倍；不设窗口则不受限', async () => {
    let simTime = 0
    sink = (e) => {
      if (e.type === 'status' || e.type === 'readings') simTime = e.simTime
    }
    session.handle({
      type: 'load',
      netlist: ['rc', 'V1 in 0 SIN(0 1 50)', 'R1 in out 1k', 'C1 out 0 1u', '.end'].join('\n'),
      probes: [{ id: 'out', kind: 'v', node: 'out' }],
      analysis: { kind: 'tran', step: 1e-3, continuous: true },
    })
    session.handle({ type: 'setPacing', mode: 'window', windowSec: 0.5 })
    session.handle({ type: 'run' })
    await wait(2000)
    session.handle({ type: 'pause' })
    await wait(200)
    const windowed = simTime
    session.handle({ type: 'setPacing', mode: 'window' })
    session.handle({ type: 'run' })
    await wait(2000)
    session.handle({ type: 'pause' })
    await wait(200)
    const free = (simTime - windowed) / 2
    console.log(`window 0.5 s：2 s 墙钟推进 ${windowed.toFixed(2)} s；不限速：${free.toFixed(1)} 倍实时`)
    expect(windowed / 2).toBeGreaterThan(4.5)
    expect(windowed / 2).toBeLessThan(5.5)
    expect(free).toBeGreaterThan(10)
    session.dispose()
  }, 30_000)
})
