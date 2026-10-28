import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NgSpice, NgSpiceError } from '../../src/sim/ngspice'

// 真实 DLL，经 koffi 加载；整个测试进程只初始化一次
const ng = NgSpice.open(resolve(__dirname, '../../resources/ngspice'))

function expectNgError(f: () => void): NgSpiceError {
  try {
    f()
  } catch (e) {
    expect(e).toBeInstanceOf(NgSpiceError)
    return e as NgSpiceError
  }
  throw new Error('应当报错')
}

describe('ngspice 集成', () => {
  it('电阻分压 .op 偏差 ≤0.1%', () => {
    ng.load(['divider', 'V1 in 0 DC 10', 'R1 in out 1k', 'R2 out 0 3k', '.op', '.end'].join('\n'))
    ng.run()
    const vout = ng.getVector('out')[0] ?? 0
    const theory = (10 * 3) / 4
    console.log(`分压偏差 ${((Math.abs(vout - theory) / theory) * 100).toExponential(2)}%`)
    expect(Math.abs(vout - theory) / theory).toBeLessThanOrEqual(0.001)
    expect(ng.vectors()).toContain('out')
  })

  it('RC .tran 完整向量，τ 偏差 ≤1%', () => {
    // R=1k C=1u，τ=1ms；阶跃 0→1V
    ng.load(
      ['rc', 'V1 in 0 PULSE(0 1 0 1n 1n 1 2)', 'R1 in out 1k', 'C1 out 0 1u', '.tran 10u 5m 0 10u', '.end'].join('\n'),
    )
    ng.run()
    const t = ng.getVector('time')
    const v = ng.getVector('out')
    expect(t.length).toBe(v.length)
    expect(t.length).toBeGreaterThan(400)
    expect(t[t.length - 1]).toBeCloseTo(5e-3, 6)
    // 线性插值求 v = 1-1/e 的时刻
    const target = 1 - Math.exp(-1)
    const i = v.findIndex((x) => x >= target)
    const t0 = t[i - 1] ?? 0
    const t1 = t[i] ?? 0
    const v0 = v[i - 1] ?? 0
    const v1 = v[i] ?? 0
    const tau = t0 + ((target - v0) / (v1 - v0)) * (t1 - t0)
    console.log(`τ 偏差 ${((Math.abs(tau - 1e-3) / 1e-3) * 100).toFixed(4)}%`)
    expect(Math.abs(tau - 1e-3) / 1e-3).toBeLessThanOrEqual(0.01)
  })

  it('语法错误网表返回错误', () => {
    const e = expectNgError(() => {
      ng.load(['bad', 'V1 in 0 DC 10', 'R1 in out', 'Q9 a b', '.op', '.end'].join('\n'))
      ng.run()
    })
    expect(e.code).toBe('model')
    expect(e.message).toMatch(/[一-龥]/)
    expect(e.detail.length).toBeGreaterThan(0)
  })

  it('电压源直接并联返回错误', () => {
    const e = expectNgError(() => {
      ng.load(['parallel', 'V1 a 0 DC 5', 'V2 a 0 DC 3', 'R1 a 0 1k', '.op', '.end'].join('\n'))
      ng.run()
    })
    expect(e.code).toBe('singular')
  })

  it('不收敛电路返回错误', () => {
    const e = expectNgError(() => {
      ng.load(
        [
          'diverge',
          // 关闭 gmin/源步进，50 V 直加二极管，牛顿迭代发散
          '.options gminsteps=0 srcsteps=0 noopiter itl1=3',
          'V1 a 0 DC 50',
          'D1 a 0 dm',
          '.model dm D',
          '.op',
          '.end',
        ].join('\n'),
      )
      ng.run()
    })
    expect(e.code).toBe('no-convergence')
  })

  it('出错后仍可继续仿真', () => {
    ng.load(['again', 'V1 in 0 DC 2', 'R1 in 0 1k', '.op', '.end'].join('\n'))
    ng.run()
    expect(ng.getVector('in')[0]).toBeCloseTo(2, 9)
  })

  it('XSPICE digital.cm 可用（d_inverter）', () => {
    ng.load(
      [
        'xspice',
        'V1 in 0 DC 0',
        'A1 [in] [din] adc1',
        'A2 din dout inv1',
        'A3 [dout] [out] dac1',
        'R1 out 0 1k',
        '.model adc1 adc_bridge(in_low=0.8 in_high=2.0)',
        '.model inv1 d_inverter',
        '.model dac1 dac_bridge(out_low=0 out_high=5)',
        '.tran 1u 10u',
        '.end',
      ].join('\n'),
    )
    ng.run()
    const out = ng.getVector('out')
    expect(out[out.length - 1]).toBeCloseTo(5, 3)
  })

  // 须放最后：ControlledExit 后实例作废，只能靠重启 sim 进程恢复
  it('ControlledExit 转为 crash 错误，不退出进程', () => {
    const e = expectNgError(() => ng.command('quit'))
    expect(e.code).toBe('crash')
    expect(expectNgError(() => ng.run()).code).toBe('crash')
  })
})
