import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { measureSignal, signalSourceTemplate } from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan, scopeProbeId } from '../../src/domain/measurement/plan.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

// T0.12：信号发生器 → 示波器全部走真实 ngspice 瞬态，按运行时同一条路径（测量计划、时间片、重采样块）取数。
const load = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))
const gen = load('ins-func-gen')
const scope = load('ins-oscilloscope')
const events: SimEvent[] = []
const session = new SimSession(
  resolve(import.meta.dirname, '../../resources/ngspice'),
  (event) => events.push(event),
  () => {},
)
afterAll(() => session.dispose())
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function bench(genSettings: Record<string, unknown>, wires: [string, string][], scopeSettings = {}): AssembleInput {
  return {
    title: 'T0.12 golden',
    modules: [],
    instruments: [
      { instanceId: 'gen', instrument: gen, settings: genSettings },
      { instanceId: 'scope', instrument: scope, settings: scopeSettings },
    ],
    wires: wires.map(([a, b]) => ({ a, b })),
    controlValues: {},
    analysis: [],
  }
}

/** 运行直到每个探针收到 points 点，返回各探针按时间顺序拼接的采样 */
async function capture(input: AssembleInput, points: number) {
  const plan = buildMeasurementPlan(input, true, 'g')
  events.length = 0
  session.handle(plan.command)
  session.handle(plan.pacing)
  session.handle({ type: 'run' })
  const ids = plan.command.probes.map((probe) => probe.id)
  const data = new Map<string, number[]>(ids.map((id) => [id, []]))
  let dt = 0
  // 与渲染端一致：以 loaded 事件为会话分界，之前到达的是上一会话最后一片
  let started = false
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await wait(50)
    for (const event of events.splice(0)) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'loaded') started = true
      if (event.type !== 'chunk' || !started) continue
      dt = event.dt
      for (const [id, samples] of Object.entries(event.data)) data.get(id)?.push(...samples)
    }
    if (ids.every((id) => (data.get(id)?.length ?? 0) >= points)) break
  }
  session.handle({ type: 'pause' })
  await wait(100)
  events.length = 0
  return { plan, dt, data }
}

const channel = (result: Awaited<ReturnType<typeof capture>>, id: string, points: number) => {
  const all = result.data.get(scopeProbeId('scope', id)) ?? []
  // 舍去起始段，取稳态
  return measureSignal(all.slice(-points), result.dt)
}

// 50 Ω 输出内阻与 1 MΩ 输入电阻分压
const loaded = (vpp: number) => (vpp * 1e6) / (1e6 + 50)

describe('函数信号发生器 → 示波器（真实 ngspice）', () => {
  const wires: [string, string][] = [
    ['gen.CH1', 'scope.CH1'],
    ['gen.GND', 'scope.GND'],
  ]

  for (const [index, name] of ['sine', 'square', 'triangle', 'sawtooth'].entries()) {
    it(`${name} 1 kHz / 2 Vpp：Vpp 与频率误差 ≤1%`, async () => {
      const result = await capture(bench({ ch1_wave: index, ch1_freq: 1000, ch1_amp: 2 }, wires), 8000)
      expect(result.plan.command.analysis).toEqual({ kind: 'tran', step: 1e-6, continuous: true })
      expect(result.plan.pacing).toEqual({ type: 'setPacing', mode: 'window', windowSec: 0.002 })
      const m = channel(result, 'CH1', 6000)
      expect(m).not.toBeNull()
      expect(Math.abs((m?.vpp ?? 0) - loaded(2)) / loaded(2)).toBeLessThan(0.01)
      expect(Math.abs((m?.frequency ?? 0) - 1000) / 1000).toBeLessThan(0.01)
      expect(Math.abs((m?.period ?? 0) - 1e-3) / 1e-3).toBeLessThan(0.01)
    })
  }

  it('偏置、占空比和第二通道独立设置；TTL 同步口为 0~5 V 脉冲', async () => {
    const result = await capture(
      bench(
        {
          ch1_wave: 1,
          ch1_freq: 2000,
          ch1_amp: 4,
          ch1_offset: 1,
          ch1_duty: 30,
          ch2_wave: 0,
          ch2_freq: 5000,
          ch2_amp: 1,
        },
        [
          ['gen.CH1', 'scope.CH1'],
          ['gen.CH2', 'scope.CH2'],
          ['gen.GND', 'scope.GND'],
        ],
      ),
      10_000,
    )
    const all = result.data.get(scopeProbeId('scope', 'CH1')) ?? []
    // 整 3 个 2 kHz 周期，避免非整周期窗口偏置占空比统计
    const recent = all.slice(-Math.round(3 / 2000 / result.dt))
    const ch1 = measureSignal(recent, result.dt)
    expect(Math.abs((ch1?.frequency ?? 0) - 2000) / 2000).toBeLessThan(0.01)
    expect(ch1?.max).toBeCloseTo(1 + loaded(4) / 2, 2)
    expect(ch1?.min).toBeCloseTo(1 - loaded(4) / 2, 2)
    const high = recent.filter((v) => v > 1).length / recent.length
    expect(Math.abs(high - 0.3)).toBeLessThan(0.01)
    const ch2 = channel(result, 'CH2', 8000)
    expect(Math.abs((ch2?.frequency ?? 0) - 5000) / 5000).toBeLessThan(0.01)
    expect(Math.abs((ch2?.vpp ?? 0) - loaded(1)) / loaded(1)).toBeLessThan(0.01)

    const ttl = await capture(
      bench({ ch1_freq: 1000, ch1_duty: 25 }, [
        ['gen.TTL', 'scope.CH1'],
        ['gen.GND', 'scope.GND'],
      ]),
      6000,
    )
    const t = channel(ttl, 'CH1', 5000)
    expect(t?.min).toBeCloseTo(0, 2)
    expect(t?.max).toBeCloseTo(loaded(5), 2)
    expect(Math.abs((t?.frequency ?? 0) - 1000) / 1000).toBeLessThan(0.01)
  })

  it('示波器内置 OUT 输出四种波形，接到本机 CH2 即可测量（共用 GND）', async () => {
    for (const [index, name] of scope.signalSources?.[0]?.waveforms.entries() ?? []) {
      const result = await capture(
        {
          ...bench({ ch1_on: 0, ch2_on: 0 }, [['scope.OUT', 'scope.CH2']], {
            out_wave: index,
            out_freq: 500,
            out_amp: 3,
          }),
        },
        8000,
      )
      const m = channel(result, 'CH2', 6000)
      expect(m, name).not.toBeNull()
      expect(Math.abs((m?.vpp ?? 0) - loaded(3)) / loaded(3), name).toBeLessThan(0.01)
      expect(Math.abs((m?.frequency ?? 0) - 500) / 500, name).toBeLessThan(0.01)
    }
  })

  it('未上电或关闭输出时不生成信号源', () => {
    expect(signalSourceTemplate(gen, { passive: true })).toBe('')
    expect(signalSourceTemplate(gen, { ch1_on: 0 })).not.toContain('Vsig_ch1_')
    // TTL 跟随 CH1，CH1 关闭时同步口也关闭
    expect(signalSourceTemplate(gen, { ch1_on: 0 })).not.toContain('Vsig_ttl_')
    const off = buildMeasurementPlan(bench({}, wires), false, 'off')
    expect(off.command.netlist).not.toContain('Vsig_')
    expect(off.command.analysis.kind).toBe('op')
  })
})
