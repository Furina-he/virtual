import { describe, expect, it } from 'vitest'
import { at, dev, lib, run } from './helpers'

describe('分立器件与运放模型', () => {
  it('1N4007 正向 I-V 3 点与数据手册偏差 ≤5%', () => {
    // 数据手册典型正向特性曲线读数（见 diodes.lib 文件头）
    const points: [number, number][] = [
      [0.01, 0.66],
      [0.1, 0.78],
      [1, 0.95],
    ]
    for (const [i, vf] of points) {
      const s = run([lib('diodes.lib'), `I1 0 a DC ${i}`, 'D1 a 0 D1N4007', '.op'])
      const v = s.getVector('a')[0] ?? 0
      console.log(`1N4007 IF=${i} A VF=${v.toFixed(4)} V 偏差 ${(dev(v, vf) * 100).toFixed(2)}%`)
      expect(dev(v, vf)).toBeLessThanOrEqual(0.05)
    }
  })

  it('S9013 hFE（VCE=1 V，IC=50 mA）与数据手册 H 档典型值 160 偏差 ≤5%', () => {
    const s = run([lib('bjt.lib'), 'IB 0 b DC 0', 'VCE c 0 DC 1', 'Q1 c b 0 S9013', '.dc IB 100u 600u 1u'])
    const ib = s.getVector('i-sweep')
    const ic = Array.from(s.getVector('vce#branch'), (x) => -x)
    const k = ic.findIndex((x) => x >= 0.05)
    const ibAt = at(ic.slice(k - 1, k + 1), Array.from(ib.slice(k - 1, k + 1)), 0.05)
    const beta = 0.05 / ibAt
    console.log(`S9013 hFE=${beta.toFixed(1)} 偏差 ${(dev(beta, 160) * 100).toFixed(2)}%`)
    expect(dev(beta, 160)).toBeLessThanOrEqual(0.05)
  })

  it('μA741 反相放大 Av=-10 增益偏差 ≤5%', () => {
    const s = run([
      lib('opamp.lib'),
      'VP vp 0 DC 15',
      'VN vn 0 DC -15',
      'VI in 0 SIN(0 0.5 1k)',
      'R1 in inm 10k',
      'RF inm out 100k',
      'RL out 0 10k',
      // DIP-8：1 调零 2 IN- 3 IN+ 4 V- 5 调零 6 OUT 7 V+ 8 NC
      'X1 0 inm 0 vn 0 out vp 0 UA741',
      '.tran 2u 3m 0 2u',
    ])
    const t = s.getVector('time')
    const vin = s.getVector('in')
    const vout = s.getVector('out')
    // 取最后一个周期的峰值比
    let pin = 0
    let pout = 0
    for (let i = 0; i < t.length; i++) {
      if ((t[i] ?? 0) < 2e-3) continue
      pin = Math.max(pin, Math.abs(vin[i] ?? 0))
      pout = Math.max(pout, Math.abs(vout[i] ?? 0))
    }
    const gain = pout / pin
    // 有限开环增益下的理论值：-Rf/Ri / (1 + (1+Rf/Ri)/A0)
    console.log(`μA741 |Av|=${gain.toFixed(4)} 偏差 ${(dev(gain, 10) * 100).toFixed(3)}%`)
    expect(dev(gain, 10)).toBeLessThanOrEqual(0.05)
    // 相位：输入正峰时输出为负
    const iPk = Array.from(vin).findIndex((x, i) => (t[i] ?? 0) > 2e-3 && x > 0.49)
    expect(vout[iPk] ?? 0).toBeLessThan(-4.5)
  })

  it('μA741 未接电源时不放大', () => {
    const s = run([
      lib('opamp.lib'),
      'VI in 0 DC 0.5',
      'R1 in inm 10k',
      'RF inm out 100k',
      'RL out 0 10k',
      'X1 0 inm 0 vn 0 out vp 0 UA741',
      'Rvp vp 0 1G',
      'Rvn vn 0 1G',
      '.op',
    ])
    expect(Math.abs(s.getVector('out')[0] ?? 0)).toBeLessThan(1)
  })
})
