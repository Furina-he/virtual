import { describe, expect, it } from 'vitest'
import { dev, lib, run } from './helpers'

describe('B1 器件模型（SIM-02 / SIM-10 / SIM-15）：2CW51、白炽灯、Cu50', () => {
  it('2CW51 稳压管：反向 5 mA 稳压 ≈ 3.30 V，低反压截止，正向导通 ≈ 0.72 V', () => {
    // 反向 5 mA 稳压点（电流从阴极流入阳极）
    const z5 = run([lib('diodes.lib'), 'I1 0 k DC 5m', 'D1 0 k D2CW51', '.op'])
    const vz5 = z5.getVector('k')[0] ?? 0
    expect(vz5).toBeGreaterThanOrEqual(3.15)
    expect(vz5).toBeLessThanOrEqual(3.45)
    expect(dev(vz5, 3.3)).toBeLessThanOrEqual(0.03)

    // 反向 10 mA：动态电阻 rz = (Vz10 - Vz5) / 5 mA 应处于合理小功率齐纳范围（10~35 Ω）
    const z10 = run([lib('diodes.lib'), 'I1 0 k DC 10m', 'D1 0 k D2CW51', '.op'])
    const vz10 = z10.getVector('k')[0] ?? 0
    const rz = (vz10 - vz5) / 0.005
    expect(vz10).toBeGreaterThan(vz5)
    expect(rz).toBeGreaterThan(10)
    expect(rz).toBeLessThan(35)

    // 低反压 2.0 V 处于击穿膝点前，漏电流 < 50 µA
    const revLeak = run([lib('diodes.lib'), 'V1 k 0 DC 2.0', 'D1 0 k D2CW51', '.op'])
    const iLeak = Math.abs(revLeak.getVector('v1#branch')[0] ?? 0)
    expect(iLeak).toBeLessThan(5e-5)

    // 正向 10 mA 呈典型硅二极管压降（0.65~0.85 V）
    const fwd = run([lib('diodes.lib'), 'I1 0 a DC 10m', 'D1 a 0 D2CW51', '.op'])
    const vf = fwd.getVector('a')[0] ?? 0
    expect(vf).toBeGreaterThan(0.65)
    expect(vf).toBeLessThan(0.85)
  })

  it('LAMP_12V_100MA 白炽灯：冷阻 12 Ω、额定 12 V / 100 mA（热阻 120 Ω）、凹曲线与极性对称', () => {
    // 1. 极低电压（0.02 V）下几乎无自热，阻值 ≈ 冷态 12.0 Ω
    const cold = run([lib('sensors.lib'), 'V1 p 0 DC 0.02', 'X1 p 0 LAMP_12V_100MA', '.op'])
    const iCold = -(cold.getVector('v1#branch')[0] ?? 0)
    const rCold = 0.02 / iCold
    expect(dev(rCold, 12.0)).toBeLessThanOrEqual(0.01)

    // 2. 扫描 2, 4, 6, 8, 10, 12 V：电阻随电压单调上升，额定 12 V 时 I = 0.100 A、R = 120 Ω（≤ 1%）
    const voltages = [2, 4, 6, 8, 10, 12]
    let prevR = rCold
    let prevI = iCold
    for (const u of voltages) {
      const s = run([lib('sensors.lib'), `V1 p 0 DC ${u}`, 'X1 p 0 LAMP_12V_100MA', '.op'])
      const i = -(s.getVector('v1#branch')[0] ?? 0)
      const r = u / i
      expect(i).toBeGreaterThan(prevI)
      expect(r).toBeGreaterThan(prevR)
      prevI = i
      prevR = r
      if (u === 12) {
        expect(dev(i, 0.1)).toBeLessThanOrEqual(0.01)
        expect(dev(r, 120)).toBeLessThanOrEqual(0.01)
      }
    }

    // 3. 反向 -12 V 对称性：I(-12 V) = -I(+12 V)
    const neg = run([lib('sensors.lib'), 'V1 p 0 DC -12', 'X1 p 0 LAMP_12V_100MA', '.op'])
    const iNeg = -(neg.getVector('v1#branch')[0] ?? 0)
    expect(dev(-iNeg, 0.1)).toBeLessThanOrEqual(0.01)

    // 4. 悬空未接（仅有 1 TΩ 泄放电阻）不发散且无漏流异常
    const floating = run([lib('sensors.lib'), 'X1 a b LAMP_12V_100MA', 'Rla a 0 1T', 'Rlb b 0 1T', '.op'])
    expect(Math.abs(floating.getVector('a')[0] ?? 0)).toBeLessThan(1e-9)
  })

  it('CU50 铜热电阻：0 ~ 100 °C 分度值（50.00 / 54.28 / 60.70 / 71.40 Ω）偏差 ≤ 0.2%', () => {
    const table: [number, number][] = [
      [0, 50.0],
      [20, 54.28],
      [50, 60.7],
      [100, 71.4],
    ]
    for (const [tempC, expectedOhm] of table) {
      const s = run([lib('sensors.lib'), 'I1 0 a DC 1m', `X1 a 0 CU50 params: temp_c=${tempC}`, '.op'])
      const r = (s.getVector('a')[0] ?? 0) / 1e-3
      expect(dev(r, expectedOhm)).toBeLessThanOrEqual(0.002)
    }
  })
})
