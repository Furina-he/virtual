import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Instrument } from '../../shared/schema/instrument.ts'
import { buildMeasurementPlan, sameSimulation, scopeProbeId } from '../measurement/plan.ts'
import { detectDanger } from '../wiring-check/index.ts'
import {
  adjustableSources,
  findTrigger,
  formatFrequency,
  getInstrumentDefaults,
  measureSignal,
  resolveScope,
  resolveSource,
  scopeSampleStep,
  scopeSettingValid,
  shortestActivePeriod,
  signalSettingValid,
  signalSourceTemplate,
  triggerColumn,
  waveformSpec,
} from './index.ts'

const load = (name: string) =>
  Instrument.parse(JSON.parse(readFileSync(`content/instruments/${name}/instrument.json`, 'utf8')))
const gen = load('ins-func-gen')
const scope = load('ins-oscilloscope')

function sampled(fn: (t: number) => number, dt: number, count: number): Float32Array {
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = fn(i * dt)
  return out
}

describe('函数信号发生器模型（INS-08）', () => {
  it('内容提供两路可切换通道、五种波形和 TTL 同步口', () => {
    expect(adjustableSources(gen).map((source) => source.id)).toEqual(['CH1', 'CH2'])
    for (const source of adjustableSources(gen))
      expect(source.waveforms).toEqual(['sine', 'square', 'triangle', 'sawtooth', 'ttl'])
    expect(getInstrumentDefaults(gen)).toMatchObject({
      ch1_wave: 0,
      ch1_freq: 1000,
      ch1_amp: 2,
      ch1_offset: 0,
      ch1_duty: 50,
      ch1_on: 1,
      display_ch: 0,
    })
  })

  it('按设置生成 SIN/PULSE 源和 50 Ω 输出内阻', () => {
    const source = gen.signalSources?.[0]
    if (!source) throw new Error('missing CH1')
    const spec = (settings: Record<string, unknown>) => waveformSpec(resolveSource(gen, settings, source))
    expect(spec({ ch1_amp: 4, ch1_offset: 1, ch1_freq: 2000 })).toBe('SIN(1 2 2000)')
    // 方波：沿中点到沿中点的高电平时间 = 占空比 × 周期
    expect(spec({ ch1_wave: 1, ch1_freq: 1000, ch1_amp: 2, ch1_duty: 30 })).toBe(
      'PULSE(-1 1 0 0.000001 0.000001 0.000299 0.001)',
    )
    expect(spec({ ch1_wave: 2, ch1_freq: 1000 })).toBe('PULSE(-1 1 0 0.0004995 0.0004995 0.000001 0.001)')
    expect(spec({ ch1_wave: 3, ch1_freq: 1000 })).toBe('PULSE(-1 1 0 0.000998 0.000001 0.000001 0.001)')
    // TTL 不受幅值和偏置影响
    expect(spec({ ch1_wave: 4, ch1_amp: 10, ch1_offset: 3 })).toBe('PULSE(0 5 0 0.000001 0.000001 0.000499 0.001)')
    const lines = signalSourceTemplate(gen, {}).split('\n')
    expect(lines).toContain('Vsig_ch1_{X} s_ch1_{X} {J:GND} SIN(0 1 1000)')
    expect(lines).toContain('Rsig_ch1_{X} {J:CH1} s_ch1_{X} 50')
    expect(lines.filter((line) => line.startsWith('Vsig_'))).toHaveLength(3)
  })

  it('TTL 同步口跟随 CH1 的频率与占空比', () => {
    const ttl = gen.signalSources?.find((source) => source.syncTo)
    if (!ttl) throw new Error('missing TTL')
    expect(resolveSource(gen, { ch1_freq: 250, ch1_duty: 20 }, ttl)).toMatchObject({
      waveform: 'ttl',
      frequency: 250,
      duty: 0.2,
      amplitude: 5,
    })
    expect(signalSettingValid(gen, 'ttl_freq', 100)).toBe(undefined)
  })

  it('设置校验只接受内容声明的范围', () => {
    expect(signalSettingValid(gen, 'ch1_freq', 1e6)).toBe(true)
    expect(signalSettingValid(gen, 'ch1_freq', 2e6)).toBe(false)
    expect(signalSettingValid(gen, 'ch2_wave', 4)).toBe(true)
    expect(signalSettingValid(gen, 'ch2_wave', 5)).toBe(false)
    expect(signalSettingValid(gen, 'ch1_on', 2)).toBe(false)
    expect(signalSettingValid(gen, 'display_ch', 1)).toBe(true)
    expect(signalSettingValid(gen, 'display_ch', 2)).toBe(false)
    expect(signalSettingValid(gen, 'range', 'x')).toBe(undefined)
    // 示波器内置源只有四种波形
    expect(signalSettingValid(scope, 'out_wave', 3)).toBe(true)
    expect(signalSettingValid(scope, 'out_wave', 4)).toBe(false)
  })

  it('最短输出周期决定仿真步长；输出关闭不计入', () => {
    expect(shortestActivePeriod(gen, { ch1_freq: 1000, ch2_freq: 5000 })).toBeCloseTo(2e-4, 12)
    expect(shortestActivePeriod(gen, { ch1_freq: 1000, ch2_freq: 5000, ch2_on: 0 })).toBeCloseTo(1e-3, 12)
    expect(shortestActivePeriod(gen, { passive: true })).toBeUndefined()
  })

  it('频率显示取 4 位有效数字', () => {
    expect(formatFrequency(1000)).toEqual({ text: '1.000', unit: 'kHz' })
    expect(formatFrequency(50)).toEqual({ text: '50.00', unit: 'Hz' })
    expect(formatFrequency(250_000)).toEqual({ text: '250.0', unit: 'kHz' })
    expect(formatFrequency(1e6)).toEqual({ text: '1.000', unit: 'MHz' })
  })
})

describe('示波器模型（INS-09）', () => {
  it('解析默认设置与档位表', () => {
    const s = resolveScope(scope)
    expect(s.channels.map((channel) => [channel.id, channel.voltsPerDiv, channel.coupling])).toEqual([
      ['CH1', 0.5, 'dc'],
      ['CH2', 0.5, 'dc'],
    ])
    expect(s.secondsPerDiv).toBe(2e-4)
    expect(s.trigger).toEqual({ mode: 'auto', source: 0, slope: 'rise', level: 0 })
    expect(triggerColumn(s)).toBe(5)
    expect(triggerColumn(resolveScope(scope, { hpos: -2 }))).toBe(3)
  })

  it('设置校验', () => {
    expect(scopeSettingValid(scope, 'ch1_vdiv', 0.2)).toBe(true)
    expect(scopeSettingValid(scope, 'ch1_vdiv', 0.3)).toBe(false)
    expect(scopeSettingValid(scope, 'tdiv', 1e-3)).toBe(true)
    expect(scopeSettingValid(scope, 'hpos', 6)).toBe(false)
    expect(scopeSettingValid(scope, 'trig_mode', 2)).toBe(true)
    expect(scopeSettingValid(scope, 'trig_mode', 3)).toBe(false)
    expect(scopeSettingValid(scope, 'ch2_coupling', 2)).toBe(true)
    expect(scopeSettingValid(scope, 'arm', 1.5)).toBe(false)
    expect(scopeSettingValid(gen, 'tdiv', 1e-3)).toBe(undefined)
  })

  it('四种波形的 Vpp、频率、周期自动测量误差 ≤1%', () => {
    const f = 1000
    const dt = 1e-6
    const phase = (t: number) => (t * f) % 1
    const waves: Record<string, (t: number) => number> = {
      sine: (t) => Math.sin(2 * Math.PI * f * t),
      square: (t) => (phase(t) < 0.5 ? 1 : -1),
      triangle: (t) => (phase(t) < 0.5 ? 4 * phase(t) - 1 : 3 - 4 * phase(t)),
      sawtooth: (t) => 2 * phase(t) - 1,
    }
    for (const [name, fn] of Object.entries(waves)) {
      const m = measureSignal(sampled(fn, dt, 20_000), dt)
      expect(Math.abs((m?.vpp ?? 0) - 2) / 2, name).toBeLessThan(0.01)
      expect(Math.abs((m?.frequency ?? 0) - f) / f, name).toBeLessThan(0.01)
      expect(Math.abs((m?.period ?? 0) - 1e-3) / 1e-3, name).toBeLessThan(0.01)
    }
  })

  it('直流或不足一个周期时不给出频率，AC 耦合用整周期平均值', () => {
    expect(measureSignal(new Float32Array(100).fill(3), 1e-6)).toMatchObject({ vpp: 0, mean: 3, frequency: null })
    const m = measureSignal(
      sampled((t) => 2 + Math.sin(2 * Math.PI * 1000 * t), 1e-6, 4500),
      1e-6,
    )
    expect(m?.mean).toBeCloseTo(2, 2)
    expect(
      measureSignal(
        sampled((t) => Math.sin(2 * Math.PI * 100 * t), 1e-5, 500),
        1e-5,
      )?.frequency,
    ).toBeNull()
  })

  it('触发：边沿、电平、迟滞和搜索区间', () => {
    const data = sampled((t) => Math.sin(2 * Math.PI * 1000 * t), 1e-5, 500)
    const rise = findTrigger(data, 0.5, 'rise', 0.01)
    expect(Math.sin(2 * Math.PI * 1000 * rise * 1e-5)).toBeCloseTo(0.5, 2)
    expect(Math.cos(2 * Math.PI * 1000 * rise * 1e-5)).toBeGreaterThan(0)
    const fall = findTrigger(data, 0.5, 'fall', 0.01)
    expect(Math.cos(2 * Math.PI * 1000 * fall * 1e-5)).toBeLessThan(0)
    // 电平超出信号范围不触发
    expect(findTrigger(data, 2, 'rise', 0.01)).toBe(-1)
    // 只在区间内取最后一个
    expect(findTrigger(data, 0.5, 'rise', 0.01, 0, 150)).toBeLessThan(150)
    // 迟滞：小于迟滞的抖动不重复触发
    const noisy = Float32Array.from([0, 0.02, -0.02, 0.02, -0.02, 0.02, 1, -1, 1])
    expect(findTrigger(noisy, 0.01, 'rise', 0.5)).toBeCloseTo(7.505, 3)
  })

  it('搜索区间起点前的迟滞布防仍能触发区间内的边沿', () => {
    const ramp = Float32Array.from({ length: 20 }, (_, i) => (i - 10) / 10)
    expect(findTrigger(ramp, 0, 'rise', 0.3, 10, 19)).toBe(10)
    expect(
      findTrigger(
        ramp.map((v) => -v),
        0,
        'fall',
        0.3,
        10,
        19,
      ),
    ).toBe(10)
    expect(findTrigger(ramp, 0, 'rise', 0.3, 11, 19)).toBe(-1)
  })

  it('单次可选择最早边沿，连续采集默认仍选择最后边沿', () => {
    const pulses = Float32Array.from([-1, -1, 1, 1, -1, -1, 2, 2])
    expect(findTrigger(pulses, 0, 'rise', 0.1)).toBeCloseTo(5 + 1 / 3, 6)
    expect(findTrigger(pulses, 0, 'rise', 0.1, 1, 7, 'first')).toBe(1.5)
    expect(findTrigger(pulses, 0, 'rise', 0.1, 4, 7, 'first')).toBeCloseTo(5 + 1 / 3, 6)
  })

  it('步长：每屏至少 pointsPerScreen 点、每周期至少 1000 点，且有上限保护', () => {
    expect(scopeSampleStep([2e-3], 1000)).toBe(2e-6)
    expect(scopeSampleStep([2e-3], 1000, 1e-3)).toBe(1e-6)
    // 1 MHz 信号配 10 ms 屏：限制在每屏 5 万点
    expect(scopeSampleStep([1e-2], 1000, 1e-6)).toBe(2e-7)
  })
})

describe('测量计划中的示波器与信号源', () => {
  const input = (wires: [string, string][], powered: boolean, scopeSettings = {}) => ({
    plan: buildMeasurementPlan(
      {
        title: 't',
        modules: [],
        instruments: [
          { instanceId: 'gen1', instrument: gen, settings: getInstrumentDefaults(gen) },
          { instanceId: 'scope1', instrument: scope, settings: { ...getInstrumentDefaults(scope), ...scopeSettings } },
        ],
        wires: wires.map(([a, b]) => ({ a, b })),
        controlValues: {},
        analysis: [],
      },
      powered,
      't',
    ),
  })

  it('只为已接线通道建探针，固定探针 ID 供 2D/3D 共用', () => {
    const { plan } = input(
      [
        ['gen1.CH1', 'scope1.CH1'],
        ['gen1.GND', 'scope1.GND'],
      ],
      true,
    )
    expect(plan.command.probes.map((probe) => probe.id)).toEqual([scopeProbeId('scope1', 'CH1')])
    expect(plan.scopes[0]?.channels).toEqual([
      { id: 'CH1', probe: 'scope:scope1:CH1', groundWired: true },
      { id: 'CH2', groundWired: true },
    ])
    expect(plan.command.analysis).toEqual({ kind: 'tran', step: 1e-6, continuous: true })
    expect(plan.pacing).toEqual({ type: 'setPacing', mode: 'window', windowSec: 0.002 })
    // 发生器 GND 是唯一接线的输出负端，作参考地
    expect(plan.assembled.nodeOf['gen1.GND']).toBe('0')
  })

  it('改变时基会改变步长与窗口；断电时不输出信号', () => {
    const wires: [string, string][] = [
      ['gen1.CH1', 'scope1.CH1'],
      ['gen1.GND', 'scope1.GND'],
    ]
    const slow = input(wires, true, { tdiv: 0.01 }).plan
    expect(slow.pacing).toEqual({ type: 'setPacing', mode: 'window', windowSec: 0.1 })
    // 每屏 5 万点上限：1 kHz 仍有 500 点/周期
    expect(slow.command.analysis).toMatchObject({ step: 2e-6 })
    const off = input(wires, false).plan
    expect(off.command.netlist).not.toContain('Vsig_')
    expect(off.command.analysis).toEqual({ kind: 'op' })
  })

  it('示波器输入阻抗写入网表；信号源输出被短接时按危险接法拦截', () => {
    const { plan } = input([['scope1.OUT', 'scope1.CH2']], true)
    expect(plan.command.netlist).toMatch(/Rin2_scope1 n\d+ n\d+ 1Meg/)
    expect(plan.command.netlist).toContain('Vsig_out_scope1')
    const short = input([['gen1.CH1', 'gen1.GND']], true).plan
    expect(detectDanger(short.checkInput).map((issue) => issue.code)).toContain('source-short')
  })
})

describe('仿真重载判定', () => {
  const vm = load('ins-dc-voltmeter')
  const plan = (vmSettings: Record<string, unknown>, scopeSettings: Record<string, unknown>) =>
    buildMeasurementPlan(
      {
        title: 't',
        modules: [],
        instruments: [
          { instanceId: 'vm', instrument: vm, settings: { range: 'r20', ...vmSettings } },
          { instanceId: 'gen1', instrument: gen, settings: getInstrumentDefaults(gen) },
          { instanceId: 'scope1', instrument: scope, settings: { ...getInstrumentDefaults(scope), ...scopeSettings } },
        ],
        wires: [
          { a: 'gen1.CH1', b: 'scope1.CH1' },
          { a: 'gen1.GND', b: 'scope1.GND' },
          { a: 'vm.POS', b: 'gen1.CH1' },
          { a: 'vm.NEG', b: 'gen1.GND' },
        ],
        controlValues: {},
        analysis: [],
      },
      true,
      't',
    )

  it('只改示波器显示设置不重载；换量程或时基必须重载', () => {
    const base = plan({}, {})
    expect(sameSimulation(base, plan({}, { ch1_vdiv: 2, ch1_pos: 1, trig_level: 0.5, trig_mode: 1, hpos: -1 }))).toBe(
      true,
    )
    // 换量程网表不变（内阻相同），但读数换算变了
    expect(plan({ range: 'r2' }, {}).command.netlist).toBe(base.command.netlist)
    expect(sameSimulation(base, plan({ range: 'r2' }, {}))).toBe(false)
    expect(sameSimulation(base, plan({}, { tdiv: 1e-3 }))).toBe(false)
  })
})
