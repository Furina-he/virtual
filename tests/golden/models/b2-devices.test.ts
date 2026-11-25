import { describe, expect, it } from 'vitest'
import { lib, run } from './helpers'

// M2 B2 器件模型真实 ngspice 金标准验证（SIM-02 / SIM-10 / SIM-15）：
// 1. FLUOR_LAMP_30W（30 W 日光灯管稳态/未启辉行为模型）
// 2. LAMP_220V_25W（220 V / 25 W 白炽灯泡热电耦合模型）
// 3. DB3（32 V 双向触发二极管）+ BTA06（双向晶闸管）50 Hz 移相调光实测

function rms(values: Float64Array, startIdx: number): number {
  let sum = 0
  let count = 0
  for (let i = startIdx; i < values.length; i++) {
    const v = values[i] ?? 0
    sum += v * v
    count++
  }
  return Math.sqrt(sum / Math.max(1, count))
}

describe('M2 B2 器件模型库金标准（power.lib）', () => {
  it('FLUOR_LAMP_30W：未启辉呈高阻，启辉稳态管压 88 V 时等效阻值约 240 Ω', () => {
    // 1. 串联 60 Ω + 1.65 H 镇流器接 220 V 50 Hz
    const unlit = run([
      lib('power.lib'),
      'Vs in 0 SIN(0 311.12698 50)',
      'Rb in m1 60',
      'Lb m1 m2 1.65',
      'X1 m2 0 FLUOR_LAMP_30W ignited=0',
      '.tran 100u 100m',
    ])
    const vUnlit = unlit.getVector('m2')
    expect(rms(vUnlit, Math.floor(vUnlit.length * 0.6))).toBeGreaterThan(215)

    const lit = run([
      lib('power.lib'),
      'Vs in 0 SIN(0 311.12698 50)',
      'Rb in m1 60',
      'Lb m1 m2 1.65',
      'X1 m2 0 FLUOR_LAMP_30W ignited=1',
      '.tran 100u 120m',
    ])
    const vLamp = lit.getVector('m2')
    const iBranch = lit.getVector('vs#branch')
    const start = Math.floor(vLamp.length * 0.5)
    const uLampRms = rms(vLamp, start)
    const iRms = rms(iBranch, start)
    expect(uLampRms).toBeGreaterThan(84)
    expect(uLampRms).toBeLessThan(93)
    expect(iRms).toBeGreaterThan(0.35)
    expect(iRms).toBeLessThan(0.39)
  })

  it('LAMP_220V_25W：220 V 稳态功率约 25 W（1936 Ω），冷态与低电压阻值显著低于热态', () => {
    // 1. 冷态小信号 1 V DC：R_cold ≈ 242 Ω
    const cold = run([lib('power.lib'), 'V1 p 0 DC 1', 'X1 p 0 LAMP_220V_25W', '.op'])
    const rCold = 1 / Math.abs(cold.getVector('v1#branch')[0] ?? 1)
    expect(Math.abs(rCold - 242) / 242).toBeLessThan(0.02)

    // 2. 220 V DC 等效稳态：P = 25.0 W，I = 0.1136 A，R_hot = 1936 Ω
    const rated = run([lib('power.lib'), 'V1 p 0 DC 220', 'X1 p 0 LAMP_220V_25W', '.op'])
    const iRated = Math.abs(rated.getVector('v1#branch')[0] ?? 0)
    const rHot = 220 / iRated
    expect(Math.abs(iRated - 25 / 220) / (25 / 220)).toBeLessThan(0.01)
    expect(Math.abs(rHot - 1936) / 1936).toBeLessThan(0.01)

    // 3. 110 V 半压稳态阻值介于冷态与额定热态之间
    const mid = run([lib('power.lib'), 'V1 p 0 DC 110', 'X1 p 0 LAMP_220V_25W', '.op'])
    const rMid = 110 / Math.abs(mid.getVector('v1#branch')[0] ?? 1)
    expect(rMid).toBeGreaterThan(rCold * 3)
    expect(rMid).toBeLessThan(rHot * 0.85)
  })

  it('DB3 双向对称 32 V 转折特性与 BTA06 50 Hz 移相调光：阻值增大使导通角与灯泡有效电压单调下降', () => {
    // 1. DB3 正反向对称转折测试
    const db3 = run([lib('power.lib'), 'Vs a 0 DC 0', 'X1 a 0 DB3', '.dc Vs -40 40 2'])
    const vSweep = db3.getVector('v-sweep')
    const iSweep = db3.getVector('vs#branch')
    const findI = (vTarget: number) => {
      for (let i = 0; i < vSweep.length; i++) {
        if (Math.abs((vSweep[i] ?? 0) - vTarget) < 0.5) return Math.abs(iSweep[i] ?? 0)
      }
      throw new Error(`Missing voltage point ${vTarget}`)
    }
    // 未达转折电压（±20 V）漏流 < 50 µA；超过 32 V（±36 V）导通电流 > 50 mA
    expect(findI(20)).toBeLessThan(5e-5)
    expect(findI(-20)).toBeLessThan(5e-5)
    expect(findI(36)).toBeGreaterThan(0.05)
    expect(findI(-36)).toBeGreaterThan(0.05)
    expect(Math.abs(findI(36) - findI(-36)) / findI(36)).toBeLessThan(0.01)

    // 2. BTA06 + DB3 + 220 V 50 Hz 移相调光电路（4 档移相电阻扫描，灯泡有效电压严格单调下降）
    const rmsList: number[] = []
    for (const rDim of [10_000, 60_000, 150_000, 260_000]) {
      const sim = run([
        lib('power.lib'),
        'Vs ac_l 0 SIN(0 311.12698 50)',
        'Rlamp ac_l mt2 1936',
        `Rdim mt2 rc_mid ${rDim}`,
        'Cph rc_mid 0 0.1u',
        'Xdb rc_mid g DB3',
        'Xtr mt2 0 g BTA06',
        '.tran 100u 100m',
      ])
      const vAc = sim.getVector('ac_l')
      const vMt2 = sim.getVector('mt2')
      const vLamp = new Float64Array(vAc.length)
      for (let i = 0; i < vAc.length; i++) vLamp[i] = (vAc[i] ?? 0) - (vMt2[i] ?? 0)
      const uRms = rms(vLamp, Math.floor(vLamp.length * 0.4))
      rmsList.push(uRms)
    }
    // 10 kΩ 接近全导通（> 200 V），260 kΩ 大移相角深度调暗（< 120 V），且严格单调递减
    expect(rmsList[0] ?? 0).toBeGreaterThan(200)
    expect(rmsList[3] ?? 999).toBeLessThan(120)
    expect((rmsList[0] ?? 0) > (rmsList[1] ?? 0)).toBe(true)
    expect((rmsList[1] ?? 0) > (rmsList[2] ?? 0)).toBe(true)
    expect((rmsList[2] ?? 0) > (rmsList[3] ?? 0)).toBe(true)
  })
})
