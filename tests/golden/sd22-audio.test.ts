// T0.6 / SIM-13：SD-22 救护车报警两种音频方案的实测（技术设计 §5.4）。
// 跑真实 SD-22 网表（两片 NE555），测仿真速度/实时比与 CPU，并对扬声器波形做频谱与连续性分析：
//   方案 A：仿真波形本身即 44.1 kHz PCM，检查块连续、谐波外能量（混叠/噪声）
//   方案 B：逐帧提取基频与包络后用谐波表合成，比较合成音与仿真波形的音高轨迹与谐波结构
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeTone, harmonicTable, type ToneFrame } from '../../src/shared/audio/tone'
import type { SimEvent } from '../../src/shared/ipc/sim'
import { SimSession } from '../../src/sim/session'
import { SD22_SPEAKER, sd22Netlist } from './fixtures/sd22'
import { spice } from './models/helpers'

const dir = resolve(__dirname, '../../resources/ngspice')
const RATE = 44100
const DT = 1 / RATE
const RUN_MS = 8000

/** 若干谐波上的幅度（单频 DFT），返回 [幅度...] 与总 RMS² */
function harmonicAmps(x: Float32Array, f0: number, n: number): { amps: number[]; power: number } {
  let mean = 0
  for (const v of x) mean += v
  mean /= x.length
  let power = 0
  for (const v of x) power += (v - mean) ** 2
  power /= x.length
  const amps: number[] = []
  for (let h = 1; h <= n; h++) {
    let c = 0
    let s = 0
    const w = 2 * Math.PI * h * f0 * DT
    for (let i = 0; i < x.length; i++) {
      const v = (x[i] ?? 0) - mean
      c += v * Math.cos(w * i)
      s += v * Math.sin(w * i)
    }
    amps.push((2 * Math.hypot(c, s)) / x.length)
  }
  return { amps, power }
}

/** 方案 B 的离线等价：按帧基频/包络驱动谐波表振荡器 */
function synthesize(frames: ToneFrame[], n: number, table: { real: Float32Array; imag: Float32Array }): Float32Array {
  const out = new Float32Array(n)
  // 谐波表按峰值归一（与 PeriodicWave 默认归一一致）
  const H = table.real.length - 1
  const wave = (ph: number) => {
    let v = 0
    for (let h = 1; h <= H; h++) v += (table.real[h] ?? 0) * Math.cos(h * ph) + (table.imag[h] ?? 0) * Math.sin(h * ph)
    return v
  }
  let peak = 0
  for (let k = 0; k < 256; k++) peak = Math.max(peak, Math.abs(wave((2 * Math.PI * k) / 256)))
  let ph = 0
  let fi = 0
  for (let i = 0; i < n; i++) {
    const t = i * DT
    while (fi < frames.length - 1 && (frames[fi]?.t ?? 0) < t) fi++
    const f = frames[fi] as ToneFrame
    ph += 2 * Math.PI * f.f0 * DT
    out[i] = f.f0 > 0 ? (wave(ph) / peak) * f.rms * Math.SQRT2 : 0
  }
  return out
}

/** 非均匀仿真点 → 每个输出采样取 [t, t+DT) 内的平均（盒式抗混叠），n 个点 */
function boxResample(t: Float64Array, v: Float64Array, t0: number, n: number): Float32Array {
  const OS = 64
  const out = new Float32Array(n)
  let j = 1
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let m = 0; m < OS; m++) {
      const tq = t0 + (i + (m + 0.5) / OS) * DT
      while (j < t.length - 1 && (t[j] ?? 0) < tq) j++
      const ta = t[j - 1] ?? 0
      const tb = t[j] ?? 0
      const va = v[j - 1] ?? 0
      const vb = v[j] ?? 0
      acc += tb === ta ? vb : va + ((tq - ta) / (tb - ta)) * (vb - va)
    }
    out[i] = acc / OS
  }
  return out
}

function inharmonicDb(x: Float32Array, f0: number, H: number): number {
  const a = harmonicAmps(x, f0, H)
  const harm = a.amps.reduce((s, v) => s + (v * v) / 2, 0)
  return 10 * Math.log10(Math.max(1e-12, 1 - harm / a.power))
}

describe('SD-22 音频方案（SIM-13）', () => {
  it('仿真速度、CPU 与两种方案的频谱/连续性分析', async () => {
    const events: SimEvent[] = []
    const session = new SimSession(
      dir,
      (e) => events.push(e),
      () => {},
    )
    session.handle({
      type: 'load',
      netlist: sd22Netlist(),
      probes: [
        { id: 'spk', kind: 'v', node: SD22_SPEAKER },
        { id: 'out1', kind: 'v', node: 'out1' },
      ],
      analysis: { kind: 'tran', step: DT, continuous: true },
    })
    // 不限速，测最大仿真速度
    session.handle({ type: 'setPacing', mode: 'window' })
    const cpu0 = process.cpuUsage()
    const w0 = performance.now()
    session.handle({ type: 'run' })
    await new Promise((r) => setTimeout(r, RUN_MS))
    session.handle({ type: 'pause' })
    await new Promise((r) => setTimeout(r, 300))
    const wall = (performance.now() - w0) / 1000
    const cpu = process.cpuUsage(cpu0)
    session.dispose()

    const chunks = events.filter((e) => e.type === 'chunk')
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i))
    const n = chunks.reduce((s, c) => s + (c.data.spk?.length ?? 0), 0)
    const spk = new Float32Array(n)
    const out1 = new Float32Array(n)
    let k = 0
    for (const c of chunks) {
      expect(c.dt).toBe(DT)
      spk.set(c.data.spk ?? [], k)
      out1.set(c.data.out1 ?? [], k)
      k += c.data.spk?.length ?? 0
    }
    const simSec = n * DT
    const ratio = simSec / wall
    const cpuPct = ((cpu.user + cpu.system) / 1e6 / wall) * 100

    // 音高：按 IC1 输出高/低两段分别统计
    const frames = analyzeTone(spk, 0, DT, 0.01)
    const hi: number[] = []
    const lo: number[] = []
    for (const f of frames) {
      if (f.t < 0.2 || f.f0 <= 0) continue
      ;((out1[Math.min(n - 1, Math.round(f.t / DT))] ?? 0) > 2 ? hi : lo).push(f.f0)
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0
    const fHi = median(hi)
    const fLo = median(lo)
    // IC1 周期（上升沿间隔）
    const rises: number[] = []
    for (let i = 1; i < n; i++) if ((out1[i - 1] ?? 0) < 2 && (out1[i] ?? 0) >= 2) rises.push(i * DT)
    const modPeriod = rises.length > 1 ? ((rises.at(-1) ?? 0) - (rises[0] ?? 0)) / (rises.length - 1) : Number.NaN

    // 稳态段：最后一个 IC1 高电平段中间 0.2 s
    const lastRise = rises.at(-1) ?? 0.5
    const seg0 = Math.round((lastRise + 0.2) / DT)
    const seg = spk.slice(seg0, seg0 + Math.round(0.2 / DT))
    const segF0 = median(frames.filter((f) => f.t > lastRise + 0.2 && f.t < lastRise + 0.4).map((f) => f.f0))
    const H = 20
    // 方案 A：谐波外能量占比（混叠、数值噪声、调制边带）
    const a = harmonicAmps(seg, segF0, H)
    const inharmDb = inharmonicDb(seg, segF0, H)
    // 参照：1 µs 步长批量仿真同一稳态段（IC1 首个高电平段 0.4~0.6 s），盒式平均到 44.1 kHz = 理想带限信号
    const ng = spice()
    ng.load(
      sd22Netlist().replace(
        '.end',
        `.save ${SD22_SPEAKER}
.tran 1e-6 0.6 0.4 1e-6
.end`,
      ),
    )
    ng.run()
    const rt = ng.getVector('time')
    const rv = ng.getVector(SD22_SPEAKER)
    const ideal = boxResample(rt, rv, 0.4, Math.round(0.2 / DT))
    const idealF0 = median(analyzeTone(ideal, 0, DT, 0.01).map((f) => f.f0))
    const idealDb = inharmonicDb(ideal, idealF0, H)

    // 方案 B：用稳态段求音色，整段合成后比较
    const table = harmonicTable(seg, DT, segF0, 16, 8)
    const synth = synthesize(frames, n, table)
    const sFrames = analyzeTone(synth, 0, DT, 0.01)
    const cents: number[] = []
    frames.forEach((f, i) => {
      const g = sFrames[i]
      if (f.t > 0.2 && f.f0 > 0 && g && g.f0 > 0) cents.push(Math.abs(1200 * Math.log2(g.f0 / f.f0)))
    })
    const b = harmonicAmps(synth.slice(seg0, seg0 + seg.length), segF0, 16)
    const ha = a.amps.slice(0, 16)
    const dot = ha.reduce((s, v, i) => s + v * (b.amps[i] ?? 0), 0)
    const cos = dot / (Math.hypot(...ha) * Math.hypot(...b.amps))
    const rmsRatio = Math.sqrt(b.power / a.power)

    console.log(
      [
        `SD-22 步长 1/44100 s：仿真 ${simSec.toFixed(2)} s / 墙钟 ${wall.toFixed(2)} s = ${ratio.toFixed(2)} 倍实时；进程 CPU ${cpuPct.toFixed(0)}%（单核=100%）`,
        `音高：IC1 高 ${fHi.toFixed(0)} Hz / 低 ${fLo.toFixed(0)} Hz，调制周期 ${modPeriod.toFixed(3)} s`,
        `方案 A：块序号连续，稳态段谐波外能量 ${inharmDb.toFixed(1)} dB（f0=${segF0.toFixed(1)} Hz，前 ${H} 次谐波）；1 µs 仿真盒式抗混叠参照 ${idealDb.toFixed(1)} dB（f0=${idealF0.toFixed(1)} Hz）`,
        `方案 B：音高误差中位 ${median(cents).toFixed(1)} 音分、95% 分位 ${[...cents].sort((x, y) => x - y)[Math.floor(cents.length * 0.95)]?.toFixed(1)} 音分；谐波幅度余弦相似 ${cos.toFixed(3)}；RMS 比 ${rmsRatio.toFixed(2)}`,
      ].join('\n'),
    )
    expect(simSec).toBeGreaterThan(2)
    // 两个音调交替，频率在可听范围
    expect(fHi).toBeGreaterThan(200)
    expect(fLo).toBeGreaterThan(200)
    expect(Math.max(fHi, fLo) / Math.min(fHi, fLo)).toBeGreaterThan(1.15)
    expect(modPeriod).toBeGreaterThan(1)
    expect(median(cents)).toBeLessThan(20)
    expect(cos).toBeGreaterThan(0.95)
  }, 120_000)
})
