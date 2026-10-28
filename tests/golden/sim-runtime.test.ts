// T0.6：连续运行的内存上界、运行中改参数（ADR-009）、数字状态跨截断/改参数保持。
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SimChunk, SimCommand, SimEvent } from '../../src/shared/ipc/sim'
import { SimSession } from '../../src/sim/session'
import { lib } from './models/helpers'

const dir = resolve(__dirname, '../../resources/ngspice')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const events: SimEvent[] = []
// 默认保存全部事件；内存测试改为流式校验，避免测试自身持有采样数据
let sink: (e: SimEvent) => void = (e) => events.push(e)
const session = new SimSession(
  dir,
  (e) => sink(e),
  () => {},
)
const chunks = () => events.filter((e): e is SimChunk => e.type === 'chunk')

function series(id: string): { t: Float64Array; v: Float32Array } {
  const cs = chunks()
  const n = cs.reduce((s, c) => s + (c.data[id]?.length ?? 0), 0)
  const t = new Float64Array(n)
  const v = new Float32Array(n)
  let k = 0
  for (const c of cs) {
    const d = c.data[id] ?? new Float32Array(0)
    v.set(d, k)
    for (let i = 0; i < d.length; i++) t[k + i] = c.t0 + i * c.dt
    k += d.length
  }
  return { t, v }
}

function expectContinuous(): void {
  const cs = chunks()
  expect(cs.map((c) => c.seq)).toEqual(cs.map((_, i) => i))
  cs.slice(1).forEach((c, i) => {
    const p = cs[i] as SimChunk
    const len = Object.values(p.data)[0]?.length ?? 0
    expect(c.t0).toBeCloseTo(p.t0 + len * p.dt, 9)
  })
}

function load(netlist: string[], probes: { id: string; node: string }[], step: number): void {
  events.length = 0
  const cmd: SimCommand = {
    type: 'load',
    netlist: netlist.join('\n'),
    probes: probes.map((p) => ({ ...p, kind: 'v' as const })),
    analysis: { kind: 'tran', step, continuous: true },
  }
  session.handle(cmd)
}

describe('连续运行（T0.6）', () => {
  it('内存有上界：向量定期截断，块序号与波形跨截断连续', async () => {
    load(['sine', 'V1 in 0 SIN(0 1 1k)', 'R1 in out 1k', 'R2 out 0 1k', '.end'], [{ id: 'out', node: 'out' }], 5e-6)
    let maxErr = 0
    let nextSeq = 0
    let nextT0 = 0
    let gaps = 0
    let simEnd = 0
    sink = (e) => {
      if (e.type !== 'chunk') return
      const d = e.data.out ?? new Float32Array(0)
      if (e.seq !== nextSeq || Math.abs(e.t0 - nextT0) > 1e-9) gaps++
      nextSeq = e.seq + 1
      nextT0 = e.t0 + d.length * e.dt
      for (let i = 0; i < d.length; i++) {
        const t = e.t0 + i * e.dt
        maxErr = Math.max(maxErr, Math.abs((d[i] ?? 0) - 0.5 * Math.sin(2 * Math.PI * 1000 * t)))
      }
      simEnd = nextT0
    }
    session.handle({ type: 'setPacing', mode: 'window' })
    const trims0 = session.trims
    session.handle({ type: 'run' })
    await wait(2000)
    const rss0 = process.memoryUsage().rss
    await wait(8000)
    session.handle({ type: 'pause' })
    await wait(200)
    const rss1 = process.memoryUsage().rss
    sink = (e) => events.push(e)
    const trims = session.trims - trims0
    console.log(
      `仿真 ${simEnd.toFixed(2)} s，截断 ${trims} 次，后 8 s RSS ${(rss0 / 2 ** 20).toFixed(0)} → ${(rss1 / 2 ** 20).toFixed(0)} MB，波形最大误差 ${maxErr.toExponential(2)}`,
    )
    expect(trims).toBeGreaterThan(10)
    expect(maxErr).toBeLessThan(2e-3)
    expect(gaps).toBe(0)
    // 未截断时 8 s 内约增长 70 MB（5 µs 步长，T0.4 实测 ≈ 1 GB/10 min）
    expect(rss1 - rss0).toBeLessThan(10 * 2 ** 20)
  }, 30_000)

  it('电位器改参数 ≤0.5 s 读数变化，电容电压不中断', async () => {
    load(
      [
        'pot',
        '.param p_rp1_k=0.25',
        '.subckt POT a w b params: k=0.5',
        'R1 a w {10k*(1-k)+1}',
        'R2 w b {10k*k+1}',
        '.ends',
        'V1 vcc 0 DC 10',
        'X1 vcc w 0 POT params: k={p_rp1_k}',
        'RL w 0 1meg',
        // τ = 1 s 的 RC，0.1 s 起充电；改参数若导致重启，电容电压会跳变
        'V2 s 0 PULSE(0 10 0.1 1u 1u 1e3 2e3)',
        'R3 s c 100k',
        'C1 c 0 10u',
        '.end',
      ],
      [
        { id: 'w', node: 'w' },
        { id: 'c', node: 'c' },
      ],
      1e-3,
    )
    session.handle({ type: 'setPacing', mode: 'realtime' })
    session.handle({ type: 'run' })
    await wait(1000)
    const sent = performance.now()
    let changedAt = Number.NaN
    const watch = setInterval(() => {
      const r = events.filter((e) => e.type === 'readings').at(-1)
      if (Number.isNaN(changedAt) && r?.type === 'readings' && (r.values.w ?? 0) > 5) changedAt = performance.now()
    }, 5)
    // 0.25 → 0.75：w 从 2.5 V 变为 7.5 V
    session.handle({ type: 'alter', changes: [{ param: 'p_rp1_k', value: 0.75 }] })
    await wait(1000)
    clearInterval(watch)
    session.handle({ type: 'pause' })
    await wait(200)
    const latency = (changedAt - sent) / 1000
    const { t, v } = series('c')
    let maxErr = 0
    for (let i = 0; i < v.length; i++) {
      const ti = t[i] ?? 0
      const ideal = ti < 0.1 ? 0 : 10 * (1 - Math.exp(-(ti - 0.1)))
      maxErr = Math.max(maxErr, Math.abs((v[i] ?? 0) - ideal))
    }
    const w = series('w').v
    console.log(`改参数到读数变化 ${(latency * 1000).toFixed(0)} ms；RC 电压与理论最大偏差 ${maxErr.toFixed(4)} V`)
    expect(latency).toBeLessThanOrEqual(0.5)
    expect(w[0]).toBeCloseTo(2.5, 1)
    expect(w.at(-1)).toBeCloseTo(7.5, 1)
    expect(maxErr).toBeLessThan(0.02)
    expectContinuous()
  }, 30_000)

  it('74LS90 计数状态跨向量截断与改参数保持', async () => {
    const PERIOD = 1e-3
    load(
      [
        'ls90',
        lib('ttl.lib'),
        '.param p_x_r=1k',
        'VCC vcc 0 DC 5',
        `VCK cka 0 PULSE(0 5 ${PERIOD / 2} 1u 1u ${PERIOD / 2 - 1e-6} ${PERIOD})`,
        'VR0 r0 0 PWL(0 5 1e-4 5 1.1e-4 0)',
        'VR9 r9 0 DC 0',
        'X1 qa r0 r0 nc4 vcc r9 r9 qc qb 0 qd qa nc13 cka SN74LS90',
        'RLA qa 0 10k',
        'RLB qb 0 10k',
        'RLC qc 0 10k',
        'RLD qd 0 10k',
        'RX vcc x {p_x_r}',
        'RX2 x 0 1k',
        '.end',
      ],
      ['qa', 'qb', 'qc', 'qd'].map((id) => ({ id, node: id })),
      1e-5,
    )
    session.handle({ type: 'setPacing', mode: 'window' })
    const trims0 = session.trims
    session.handle({ type: 'run' })
    await wait(1500)
    session.handle({ type: 'alter', changes: [{ param: 'p_x_r', value: 2000 }] })
    await wait(1500)
    session.handle({ type: 'pause' })
    await wait(200)
    const bits = ['qa', 'qb', 'qc', 'qd'].map((id) => series(id))
    const t = bits[0]?.t ?? new Float64Array(0)
    // 第 k 个下降沿在 (k+1)·PERIOD 附近，取其后 0.4 周期采样，应为 k+1 (mod 10)
    const bad: number[] = []
    let k = 0
    for (; (k + 1.4) * PERIOD < (t.at(-1) ?? 0); k++) {
      const i = Math.round(((k + 1.4) * PERIOD - (t[0] ?? 0)) / 1e-5)
      const n = bits.reduce((s, b, j) => s + ((b.v[i] ?? 0) > 2 ? 1 << j : 0), 0)
      if (n !== (k + 1) % 10) bad.push(k)
    }
    console.log(`74LS90 检查 ${k} 个时钟，截断 ${session.trims - trims0} 次，计数错误 ${bad.length}`)
    expect(k).toBeGreaterThan(500)
    expect(session.trims - trims0).toBeGreaterThan(0)
    expect(bad).toEqual([])
    expectContinuous()
    session.dispose()
  }, 30_000)
})
