import { describe, expect, it } from 'vitest'
import { lib, run } from './helpers'

// M2 B3 器件模型真实 ngspice 金标准验证（SIM-02 / SIM-15）：
// 1. diodes.lib 扩展：1N4148（高速开关二极管）与 LED_RED（红色发光二极管）
// 2. fet.lib：J3DJ6（N 沟道 JFET）与 NMOS_2N7000（N 沟道增强型 MOSFET）
// 3. regulators.lib：LM7805 / LM7812 / LM7905 / LM7912 / LM317 稳压精度、压差跌落与负载调整率
// 4. sensors.lib 扩展：ELECTRET_MIC（偏置门控驻极体话筒）与 LI_CELL_3V7（恒流充电电压单调上升）

describe('M2 B3 模拟电子器件模型金标准（diodes / fet / regulators / sensors）', () => {
  it('1N4148 与 LED_RED：1 mA 二极管档与 10 mA 工作点正向压降符合手册', () => {
    const ng = run([
      lib('diodes.lib'),
      'I1 0 a1 DC 1m',
      'D1 a1 0 D1N4148',
      'I2 0 a2 DC 10m',
      'D2 a2 0 D1N4148',
      'I3 0 l1 DC 1m',
      'D3 l1 0 DLED_RED',
      'I4 0 l2 DC 10m',
      'D4 l2 0 DLED_RED',
      '.op',
    ])
    const a1 = ng.getVector('a1')[0] ?? 0
    const a2 = ng.getVector('a2')[0] ?? 0
    const l1 = ng.getVector('l1')[0] ?? 0
    const l2 = ng.getVector('l2')[0] ?? 0
    expect(a1).toBeGreaterThan(0.54)
    expect(a1).toBeLessThan(0.66)
    expect(a2).toBeGreaterThan(0.66)
    expect(a2).toBeLessThan(0.76)
    expect(l1).toBeGreaterThan(1.65)
    expect(l1).toBeLessThan(1.9)
    expect(l2).toBeGreaterThan(1.82)
    expect(l2).toBeLessThan(2.02)
  })

  it('J3DJ6（JFET）平方律夹断特性与 NMOS_2N7000（增强型 MOSFET）阈值导通特性', () => {
    const jfetIds: number[] = []
    for (const vgs of [0, -1, -2, -3.2]) {
      const ng = run([lib('fet.lib'), 'Vds d 0 DC 10', `Vgs g 0 DC ${vgs}`, 'J1 d g 0 J3DJ6', '.op'])
      jfetIds.push(-(ng.getVector('vds#branch')[0] ?? 0))
    }
    expect(jfetIds[0] ?? 0).toBeGreaterThan(0.0055)
    expect(jfetIds[0] ?? 1).toBeLessThan(0.008)
    expect((jfetIds[1] ?? 0) < (jfetIds[0] ?? 0) * 0.55).toBe(true)
    expect((jfetIds[2] ?? 0) < (jfetIds[1] ?? 0) * 0.35).toBe(true)
    expect(jfetIds[3] ?? 1).toBeLessThan(1e-5)

    const mosIds: number[] = []
    for (const vgs of [1.5, 2.5, 3.0, 3.5]) {
      const ng = run([lib('fet.lib'), 'Vds d 0 DC 10', `Vgs g 0 DC ${vgs}`, 'M1 d g 0 0 NMOS_2N7000', '.op'])
      mosIds.push(-(ng.getVector('vds#branch')[0] ?? 0))
    }
    expect(mosIds[0] ?? 1).toBeLessThan(1e-6)
    expect(mosIds[1] ?? 0).toBeGreaterThan(0.02)
    expect(mosIds[2] ?? 0).toBeGreaterThan(0.08)
    expect(mosIds[3] ?? 0).toBeGreaterThan(0.18)
  })

  it('LM7805 / LM7812 / LM7905 / LM7912 / LM317：额定稳压精度 ≤ 1%、压差跌落与带载调整', () => {
    const ng = run([
      lib('regulators.lib'),
      'Vp15 vp15 0 DC 16',
      'Vm15 vm15 0 DC -16',
      'VpLow vlow 0 DC 10',
      'X7805 vp15 0 o7805 LM7805',
      'R7805 o7805 0 100',
      'X7812 vp15 0 o7812 LM7812',
      'R7812 o7812 0 120',
      'X7812drop vlow 0 o7812d LM7812',
      'R7812d o7812d 0 120',
      'X7905 vm15 0 o7905 LM7905',
      'R7905 o7905 0 100',
      'X7912 vm15 0 o7912 LM7912',
      'R7912 o7912 0 120',
      'X317 vp15 adj o317 LM317',
      'R317_1 o317 adj 240',
      'R317_2 adj 0 1.2k',
      'R317_L o317 0 150',
      '.op',
    ])
    expect(Math.abs((ng.getVector('o7805')[0] ?? 0) - 5.0)).toBeLessThan(0.05)
    expect(Math.abs((ng.getVector('o7812')[0] ?? 0) - 12.0)).toBeLessThan(0.1)
    expect(ng.getVector('o7812d')[0] ?? 99).toBeLessThan(8.5)
    expect(Math.abs((ng.getVector('o7905')[0] ?? 0) + 5.0)).toBeLessThan(0.05)
    expect(Math.abs((ng.getVector('o7912')[0] ?? 0) + 12.0)).toBeLessThan(0.1)
    // LM317: 1.25 * (1 + 1200/240) + 50u * 1200 = 7.56 V
    expect(Math.abs((ng.getVector('o317')[0] ?? 0) - 7.56)).toBeLessThan(0.08)
  })

  it('ELECTRET_MIC 偏置门控音频输出与 LI_CELL_3V7 恒流充电电压线性爬升', () => {
    const micNg = run([
      lib('sensors.lib'),
      'Vcc vcc 0 DC 5',
      'Rbias vcc m_on 2.2k',
      'Xm1 m_on 0 ELECTRET_MIC spl_mv=10 freq_hz=1000',
      'Roff m_off 0 2.2k',
      'Xm2 m_off 0 ELECTRET_MIC spl_mv=10 freq_hz=1000',
      '.tran 50u 5m',
    ])
    const on = micNg.getVector('m_on')
    const off = micNg.getVector('m_off')
    const span = (arr: Float64Array) => {
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      for (const v of arr) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      return hi - lo
    }
    expect(span(on)).toBeGreaterThan(0.008)
    expect(span(off)).toBeLessThan(0.0005)

    // 锂电池 100 mA 恒流充电 0.2 s（c_eq = 0.05 F -> ΔV ≈ 0.40 V）
    const batNg = run([
      lib('sensors.lib'),
      'I_cc 0 bp DC 0.1',
      'Xbat bp 0 LI_CELL_3V7 v_init=3.4 c_eq=0.05 r_int=0.15',
      '.tran 1m 0.2',
    ])
    const vBat = batNg.getVector('bp')
    const v0 = vBat[0] ?? 0
    const vEnd = vBat[vBat.length - 1] ?? 0
    expect(Math.abs(v0 - 3.415)).toBeLessThan(0.02)
    expect(vEnd - v0).toBeGreaterThan(0.35)
    expect(vEnd - v0).toBeLessThan(0.45)
  })
})
