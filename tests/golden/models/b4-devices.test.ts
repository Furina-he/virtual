import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { run } from './helpers.ts'

const bjtLib = readFileSync('content/models/spice/bjt.lib', 'utf8')
const opampLib = readFileSync('content/models/spice/opamp.lib', 'utf8')
const sensorsLib = readFileSync('content/models/spice/sensors.lib', 'utf8')

const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / Math.max(1e-12, Math.abs(expected))

describe('M2 B4 器件模型金标准（S9012 / TIP41C / TIP42C / LM386 / LM324 / LM393 / MQ-2 / 有源蜂鸣器）', () => {
  it('S9012 / TIP41C / TIP42C 互补晶体管放大倍数与极性符合手册目标', () => {
    // S9012 (PNP): VEC = 5 V, IB = -100 uA -> |IC| ≈ 16 mA (hFE ≈ 160)
    const ng1 = run([
      '* S9012 check',
      bjtLib,
      'Ve e 0 DC 5',
      'Ib b 0 DC 100u',
      'Vc c 0 DC 0',
      'Q1 c b e S9012',
      '.op',
      '.end',
    ])
    const ic9012 = ng1.getVector('vc#branch')[0] ?? 0
    expect(ic9012).toBeGreaterThan(0.013)
    expect(ic9012).toBeLessThan(0.022)

    // TIP41C (NPN) 与 TIP42C (PNP) 对称功率放大倍数（IB = 5 mA -> IC ≈ 0.35~0.50 A）
    const ng2 = run([
      '* TIP41C/42C check',
      bjtLib,
      'Vc1 c1 0 DC 5',
      'Ib1 0 b1 DC 5m',
      'Q1 c1 b1 0 TIP41C',
      'Ve2 e2 0 DC 5',
      'Ib2 b2 0 DC 5m',
      'Vc2 c2 0 DC 0',
      'Q2 c2 b2 e2 TIP42C',
      '.op',
      '.end',
    ])
    const ic41 = -(ng2.getVector('vc1#branch')[0] ?? 0)
    const ic42 = ng2.getVector('vc2#branch')[0] ?? 0
    expect(ic41).toBeGreaterThan(0.32)
    expect(ic41).toBeLessThan(0.5)
    expect(relErr(ic42, ic41)).toBeLessThan(0.02)
  })

  it('LM324_UNIT 反相比例放大误差 ≤ 1%、单电源 +5 V 正常工作、隔离地零偏移、未供电不放大', () => {
    const ng = run([
      '* LM324 inverting -2x with floating reference +3 V',
      opampLib,
      'Vref ref 0 DC 3',
      'Vpp vp ref DC 12',
      'Vmm ref vm DC 12',
      'Vin in ref DC 1.5',
      'R1 in inv 10k',
      'Rf inv out 20k',
      'X1 ref inv vp vm out LM324_UNIT',
      'Rl out ref 10k',
      '.op',
      '.end',
    ])
    const vOut = (ng.getVector('out')[0] ?? 0) - (ng.getVector('ref')[0] ?? 0)
    expect(relErr(vOut, -3.0)).toBeLessThan(0.01)

    // 未供电（VP = VM = 0）时输入 1 V 不放大
    const offNg = run([
      '* LM324 unpowered',
      opampLib,
      'Vin in 0 DC 1',
      'X1 in 0 0 0 out LM324_UNIT',
      'Rl out 0 10k',
      '.op',
      '.end',
    ])
    expect(Math.abs(offNg.getVector('out')[0] ?? 9)).toBeLessThan(0.05)
  })

  it('LM393_UNIT 开集电极比较器翻转清晰：INP > INM 高阻上拉至 +5 V，INP < INM 饱和下拉 < 0.25 V', () => {
    const ng = run([
      '* LM393 comparator check',
      opampLib,
      'Vcc vp 0 DC 5',
      'Vref ref 0 DC 2.5',
      'Vhi hi 0 DC 3.0',
      'Vlo lo 0 DC 2.0',
      'Xhi hi ref vp 0 out_hi LM393_UNIT',
      'Rpu1 vp out_hi 4.7k',
      'Xlo lo ref vp 0 out_lo LM393_UNIT',
      'Rpu2 vp out_lo 4.7k',
      '.op',
      '.end',
    ])
    expect(ng.getVector('out_hi')[0] ?? 0).toBeGreaterThan(4.9)
    expect(ng.getVector('out_lo')[0] ?? 9).toBeLessThan(0.25)
  })

  it('LM386 静态中点 VS/2、1–8 开路增益 20×、1–8 接 10 µF 增益 200×（驱动 8 Ω 扬声器）且未供电归零', () => {
    const run386 = (cap: boolean, vinPeak: number) =>
      run([
        '* LM386 gain check',
        opampLib,
        'Vs vs 0 DC 9',
        `Vin in 0 SIN(0 ${vinPeak} 1000)`,
        'X1 g1 0 in 0 out vs byp g8 LM386',
        'Cbyp byp 0 10u',
        ...(cap ? ['Cg g1 g8 10u'] : []),
        'Cout out spk 220u',
        'Rspk spk 0 8',
        '.tran 20u 12m 0 20u',
        '.end',
      ])

    const g20 = run386(false, 0.05) // 100 mVpp -> ~2.0 Vpp (Av ≈ 20)
    const t20 = g20.getVector('time')
    const out20 = g20.getVector('out')
    const spk20 = g20.getVector('spk')
    let lo20 = Number.POSITIVE_INFINITY
    let hi20 = Number.NEGATIVE_INFINITY
    let dcSum = 0
    let count = 0
    for (let i = 0; i < t20.length; i++) {
      if ((t20[i] ?? 0) < 0.006) continue
      const s = spk20[i] ?? 0
      if (s < lo20) lo20 = s
      if (s > hi20) hi20 = s
      dcSum += out20[i] ?? 0
      count++
    }
    const dcMid = dcSum / Math.max(1, count)
    const gain20 = (hi20 - lo20) / 0.1
    expect(relErr(dcMid, 4.5)).toBeLessThan(0.03)
    expect(gain20).toBeGreaterThan(18.0)
    expect(gain20).toBeLessThan(22.0)

    const g200 = run386(true, 0.01) // 20 mVpp -> ~4.0 Vpp (Av ≈ 200)
    const t200 = g200.getVector('time')
    const spk200 = g200.getVector('spk')
    let lo200 = Number.POSITIVE_INFINITY
    let hi200 = Number.NEGATIVE_INFINITY
    for (let i = 0; i < t200.length; i++) {
      if ((t200[i] ?? 0) < 0.006) continue
      const s = spk200[i] ?? 0
      if (s < lo200) lo200 = s
      if (s > hi200) hi200 = s
    }
    const gain200 = (hi200 - lo200) / 0.02
    expect(gain200).toBeGreaterThan(175)
    expect(gain200).toBeLessThan(215)
  })

  it('MQ2_GAS 烟雾浓度升高阻值单调下降，BUZZER_ACTIVE 阈值门控 2.4 kHz 音频输出', () => {
    const resAt = (ppm: number) => {
      const ng = run([
        `* MQ2 ${ppm}`,
        sensorsLib,
        'V1 a 0 DC 5',
        `X1 a b MQ2_GAS ppm=${ppm}`,
        'Rl b 0 4.7k',
        '.op',
        '.end',
      ])
      return ng.getVector('b')[0] ?? 0
    }
    const v0 = resAt(0)
    const v200 = resAt(200)
    const v500 = resAt(500)
    const v1000 = resAt(1000)
    expect(v0).toBeGreaterThan(0.85)
    expect(v0).toBeLessThan(1.05)
    expect(v200).toBeGreaterThan(1.9)
    expect(v500).toBeGreaterThan(2.9)
    expect(v1000).toBeGreaterThan(3.7)

    // 有源蜂鸣器：0.5 V 静音，5.0 V 输出 2.4 kHz 约 4 Vpp 蜂鸣声
    const buz = run([
      '* BUZZER_ACTIVE check',
      sensorsLib,
      'Von on_p 0 DC 5',
      'Xon on_p 0 sp_on 0 BUZZER_ACTIVE',
      'Voff off_p 0 DC 0.5',
      'Xoff off_p 0 sp_off 0 BUZZER_ACTIVE',
      '.tran 20u 3m 0 20u',
      '.end',
    ])
    const spOn = buz.getVector('sp_on')
    const spOff = buz.getVector('sp_off')
    const vpp = (arr: Float64Array) => {
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i] ?? 0
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      return hi - lo
    }
    expect(vpp(spOn)).toBeGreaterThan(3.5)
    expect(vpp(spOff)).toBeLessThan(0.05)
  })
})
