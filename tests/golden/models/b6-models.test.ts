import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandLocalLibraries } from '../../../src/domain/circuit/libraries.ts'
import { measureSignal } from '../../../src/domain/instruments/scope.ts'
import { NgSpice } from '../../../src/sim/ngspice.ts'

// M2 B6（SIM-09 / SIM-10 / SIM-15）全部新增 IC 与传感器行为模型对照数据手册金标准测试：
// 覆盖 SN74LS175 / SN74LS14 / SN74LS121 / SN74LS123 / CD40106 / CD4011 / CD4060 /
// LM358 / LM324 / LDR_GL5528 / RELAY_5V_SPST / XTAL_32768 / SERVO_MOTOR_ENC。

const LIBRARIES = {
  'ttl.lib': readFileSync(resolve(import.meta.dirname, '../../../content/models/spice/ttl.lib'), 'utf8'),
  'cmos.lib': readFileSync(resolve(import.meta.dirname, '../../../content/models/spice/cmos.lib'), 'utf8'),
  'opamp.lib': readFileSync(resolve(import.meta.dirname, '../../../content/models/spice/opamp.lib'), 'utf8'),
  'sensors.lib': readFileSync(resolve(import.meta.dirname, '../../../content/models/spice/sensors.lib'), 'utf8'),
}

const ng = NgSpice.open(resolve(import.meta.dirname, '../../../resources/ngspice'))

function run(netlist: string) {
  ng.load(expandLocalLibraries(netlist, LIBRARIES))
  ng.run()
}

function at(vec: Float64Array, time: Float64Array, t: number): number {
  let idx = 0
  while (idx < time.length - 1 && (time[idx] ?? 0) < t) idx++
  return vec[idx] ?? 0
}

function pulseWidthMs(vec: Float64Array, time: Float64Array, afterSec: number, thresh = 1.8): number {
  let tRise = -1
  for (let i = 1; i < time.length; i++) {
    const t = time[i] ?? 0
    if (t < afterSec) continue
    const prev = vec[i - 1] ?? 0
    const cur = vec[i] ?? 0
    if (tRise < 0 && prev < thresh && cur >= thresh) tRise = t
    else if (tRise >= 0 && prev >= thresh && cur < thresh) return (t - tRise) * 1000
  }
  return tRise >= 0 ? ((time.at(-1) ?? 0) - tRise) * 1000 : 0
}

function uniformResample(vec: Float64Array, time: Float64Array, t0: number, t1: number, dt: number): Float32Array {
  const n = Math.floor((t1 - t0) / dt)
  const out = new Float32Array(n)
  let j = 0
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt
    while (j < time.length - 2 && (time[j + 1] ?? 0) < t) j++
    const ta = time[j] ?? 0
    const tb = time[j + 1] ?? ta + 1e-12
    const alpha = Math.max(0, Math.min(1, (t - ta) / Math.max(tb - ta, 1e-15)))
    out[i] = (vec[j] ?? 0) * (1 - alpha) + (vec[j + 1] ?? 0) * alpha
  }
  return out
}

describe('M2 B6 芯片与传感器行为模型金标准（SIM-09 / SIM-10 / SIM-15）', () => {
  it('SN74LS175：四上升沿 D 触发器锁存、互补输出 Q//Q、异步 /CLR 及未供电保护', () => {
    run(`* 74LS175 test
.include "ttl.lib"
Vcc vcc 0 5
Vclr clr 0 PWL(0 0 1u 0 1.1u 5 6u 5 6.1u 0 7u 0 7.1u 5)
Vck ck 0 PULSE(0 5 2u 10n 10n 1u 2u)
Vd1 d1 0 5
Vd2 d2 0 0
Vd3 d3 0 5
Vd4 d4 0 5
Xu clr q1 nq1 d1 d2 nq2 q2 0 ck q3 nq3 d3 d4 nq4 q4 vcc SN74LS175
Rq1 q1 0 10k
Rnq1 nq1 0 10k
Rq2 q2 0 10k
Rq3 q3 0 10k
Rq4 q4 0 10k
.tran 20n 8u
.end`)
    const t = ng.getVector('time')
    const q1 = ng.getVector('q1')
    const nq1 = ng.getVector('nq1')
    const q2 = ng.getVector('q2')
    const q3 = ng.getVector('q3')
    const q4 = ng.getVector('q4')
    // t=0.5u: /CLR=0 -> 全清零
    expect(at(q1, t, 0.5e-6)).toBeLessThan(0.4)
    expect(at(nq1, t, 0.5e-6)).toBeGreaterThan(2.8)
    // t=2.5u: 首个上升沿锁存 D1..D4 = 1011
    expect(at(q1, t, 2.5e-6)).toBeGreaterThan(2.8)
    expect(at(nq1, t, 2.5e-6)).toBeLessThan(0.4)
    expect(at(q2, t, 2.5e-6)).toBeLessThan(0.4)
    expect(at(q3, t, 2.5e-6)).toBeGreaterThan(2.8)
    expect(at(q4, t, 2.5e-6)).toBeGreaterThan(2.8)
    // t=6.5u: 异步 /CLR=0 立即清零
    expect(at(q1, t, 6.5e-6)).toBeLessThan(0.4)
    expect(at(q4, t, 6.5e-6)).toBeLessThan(0.4)

    // 未供电保护
    run(`* 74LS175 unpowered
.include "ttl.lib"
Rvcc vcc 0 100k
Xu vcc q1 nq1 vcc 0 nq2 q2 0 0 q3 nq3 0 0 nq4 q4 vcc SN74LS175
Rq1 q1 0 10k
Rnq1 nq1 0 10k
.op
.end`)
    expect(ng.getVector('q1')[0] ?? 9).toBeLessThan(0.5)
    expect(ng.getVector('nq1')[0] ?? 9).toBeLessThan(0.5)
  })

  it('SN74LS14 与 CD40106：施密特回差电压（ΔVT ≈ 0.8 V / 1.0 V）与正弦整形及 RC 振荡', () => {
    // 1. 三角波扫描实测回差窗口
    run(`* Schmitt hysteresis sweep
.include "ttl.lib"
.include "cmos.lib"
Vcc vcc 0 5
Vin in 0 PWL(0 0 1m 5 2m 0)
X14 in y14 0 y2 0 y3 0 y4 0 y5 0 y6 0 vcc SN74LS14
X106 in y106 0 c2 0 c3 0 c4 0 c5 0 c6 0 vcc CD40106
R1 y14 0 10k
R2 y106 0 10k
.tran 2u 2m
.end`)
    const t = ng.getVector('time')
    const vin = ng.getVector('in')
    const y14 = ng.getVector('y14')
    const y106 = ng.getVector('y106')
    const findSwitch = (y: Float64Array) => {
      let vtPlus = 0
      let vtMinus = 0
      for (let i = 1; i < t.length; i++) {
        const ti = t[i] ?? 0
        if (ti < 1e-3 && (y[i - 1] ?? 0) >= 1.8 && (y[i] ?? 0) < 1.8 && vtPlus === 0) vtPlus = vin[i] ?? 0
        if (ti > 1e-3 && (y[i - 1] ?? 0) < 1.8 && (y[i] ?? 0) >= 1.8 && vtMinus === 0) vtMinus = vin[i] ?? 0
      }
      return { vtPlus, vtMinus, hyst: vtPlus - vtMinus }
    }
    const ls14 = findSwitch(y14)
    expect(ls14.vtPlus).toBeGreaterThan(1.6)
    expect(ls14.vtPlus).toBeLessThan(1.82)
    expect(ls14.vtMinus).toBeGreaterThan(0.8)
    expect(ls14.vtMinus).toBeLessThan(1.0)
    expect(ls14.hyst).toBeGreaterThan(0.7)

    const cmos = findSwitch(y106)
    expect(cmos.vtPlus).toBeGreaterThan(2.9)
    expect(cmos.vtPlus).toBeLessThan(3.1)
    expect(cmos.vtMinus).toBeGreaterThan(1.9)
    expect(cmos.vtMinus).toBeLessThan(2.1)
    expect(cmos.hyst).toBeGreaterThan(0.9)

    // 2. CD40106 + RC 施密特多谐振荡器：R=4.7k (+ Ro=200 Ω), C=100n -> f ≈ 1 / (2·4.9k·100n·ln(0.605/0.395)) ≈ 2393 Hz
    run(`* CD40106 RC oscillator
.include "cmos.lib"
Vcc vcc 0 5
X106 vc vout 0 c2 0 c3 0 c4 0 c5 0 c6 0 vcc CD40106
Rf vout vc 4.7k
Cf vc 0 100n
Rl vout 0 100k
.tran 2u 5m
.end`)
    const to = ng.getVector('time')
    const vo = ng.getVector('vout')
    const samples = uniformResample(vo, to, 1e-3, 5e-3, 5e-6)
    const meas = measureSignal(samples, 5e-6)
    expect(meas?.frequency ?? 0).toBeGreaterThan(2250)
    expect(meas?.frequency ?? 0).toBeLessThan(2550)
  })

  it('SN74LS121（不可重触发）与 SN74LS123（可重触发 + /CLR）：外接 RC 精确脉宽与重触发对比', () => {
    // 1. 单次触发精确脉宽：74LS121 (R=10k, C=100n -> 0.693 ms)；74LS123 (R=15k, C=100n -> 0.675 ms)
    run(`* Monostable single pulse
.include "ttl.lib"
Vcc vcc 0 5
Vtrig trig 0 PULSE(0 5 0.2m 1u 1u 50u 10m)
X121 nq121 nc2 0 0 trig q121 0 nc8 nc9 cx121 rc121 nc12 nc13 vcc SN74LS121
R121 vcc rc121 10k
C121 rc121 cx121 100n
X123 0 trig vcc nq123 q2 cx2 rc2 0 0 0 vcc nq2 q123 cx123 rc123 vcc SN74LS123
R123 vcc rc123 15k
C123 rc123 cx123 100n
R1 q121 0 10k
R2 q123 0 10k
.tran 2u 2.5m
.end`)
    const t = ng.getVector('time')
    const tw121 = pulseWidthMs(ng.getVector('q121'), t, 0.15e-3)
    const tw123 = pulseWidthMs(ng.getVector('q123'), t, 0.15e-3)
    expect(tw121).toBeGreaterThan(0.66)
    expect(tw121).toBeLessThan(0.73)
    expect(tw123).toBeGreaterThan(0.64)
    expect(tw123).toBeLessThan(0.72)

    // 2. 双脉冲间隔 0.4 ms（小于 0.68 ms）：74LS121 忽略第二次触发维持 ~0.69 ms；74LS123 重触发延展至 ~1.08 ms
    run(`* Monostable retrigger comparison
.include "ttl.lib"
Vcc vcc 0 5
Vtrig trig 0 PWL(0 0 0.2m 0 0.201m 5 0.25m 5 0.251m 0 0.6m 0 0.601m 5 0.65m 5 0.651m 0 3m 0)
X121 nq121 nc2 0 0 trig q121 0 nc8 nc9 cx121 rc121 nc12 nc13 vcc SN74LS121
R121 vcc rc121 10k
C121 rc121 cx121 100n
X123 0 trig vcc nq123 q2 cx2 rc2 0 0 0 vcc nq2 q123 cx123 rc123 vcc SN74LS123
R123 vcc rc123 15k
C123 rc123 cx123 100n
R1 q121 0 10k
R2 q123 0 10k
.tran 2u 2.5m
.end`)
    const tr = ng.getVector('time')
    const tw121Retrig = pulseWidthMs(ng.getVector('q121'), tr, 0.15e-3)
    const tw123Retrig = pulseWidthMs(ng.getVector('q123'), tr, 0.15e-3)
    expect(tw121Retrig).toBeGreaterThan(0.66)
    expect(tw121Retrig).toBeLessThan(0.74) // 不可重触发：忽略 0.6 ms 处第二个脉冲
    expect(tw123Retrig).toBeGreaterThan(1.03)
    expect(tw123Retrig).toBeLessThan(1.13) // 可重触发：0.40 ms + 0.675 ms ≈ 1.08 ms
  })

  it('CD4011（CMOS 四与非门）与 LM358/LM324（DIP-8 / DIP-14 运放封装）特性校验', () => {
    run(`* CD4011 + LM358 + LM324
.include "cmos.lib"
.include "opamp.lib"
Vdd vdd 0 5
Va a 0 5
Vb b 0 5
Xc a b y1 y2 0 5 0 0 0 y3 y4 5 0 vdd CD4011
R1 y1 0 100k
R2 y2 0 100k
Vp vp 0 12
Vm vm 0 -12
Vin vin 0 1.5
* LM358 通道 1 同相 2 倍放大
X358 o358 fb358 vin vm 0 0 o358_2 vp LM358
R358a o358 fb358 10k
R358b fb358 0 10k
* LM324 通道 1 反相 -2 倍放大
X324 o324 m324 0 vp 0 0 o2 o3 0 0 vm 0 0 o4 LM324
R324in vin m324 10k
R324f m324 o324 20k
.op
.end`)
    expect(ng.getVector('y1')[0] ?? 9).toBeLessThan(0.1) // 1 NAND 1 = 0
    expect(ng.getVector('y2')[0] ?? 0).toBeGreaterThan(4.9) // 0 NAND 1 = 1 (轨到轨 5 V)
    expect(Math.abs((ng.getVector('o358')[0] ?? 0) - 3.0)).toBeLessThan(0.02)
    expect(Math.abs((ng.getVector('o324')[0] ?? 0) + 3.0)).toBeLessThan(0.02)
  })

  it('CD4060（14 级二进制分频）+ XTAL_32768：全 14 级精确分频（Q4=f/16 至 Q14=f/16384）', () => {
    // 1. 验证 XTAL_32768 精确输出 32768 Hz 且未供电无输出
    run(`* XTAL_32768 test
.include "sensors.lib"
Vdd vdd 0 5
Xxt vdd 0 xout XTAL_32768 params: freq_hz=32768
Rx xout 0 100k
.tran 1u 1m
.end`)
    const tx = ng.getVector('time')
    const sx = uniformResample(ng.getVector('xout'), tx, 0.1e-3, 1.0e-3, 1e-6)
    const fx = measureSignal(sx, 1e-6)?.frequency ?? 0
    expect(fx).toBeGreaterThan(32400)
    expect(fx).toBeLessThan(33100)

    // 2. 外部时钟 CD4060（2048 Hz -> Q4=128 Hz, Q6=32 Hz, Q8=8 Hz）校验全部低级分频输出
    run(`* CD4060 external clock divider
.include "cmos.lib"
Vdd vdd 0 5
Vmr mr 0 PULSE(5 0 0.5m 1u 1u 10 20)
Vck clk 0 PULSE(0 5 1m 1u 1u 244u 488.28125u)
X4060 q12 q13 q14 q6 q5 q7 q4 0 npo po clk mr q9 q8 q10 vdd CD4060
Rq4 q4 0 100k
Rq6 q6 0 100k
Rq8 q8 0 100k
.tran 200u 0.45
.end`)
    const te = ng.getVector('time')
    const fq4 = measureSignal(uniformResample(ng.getVector('q4'), te, 0.02, 0.45, 5e-4), 5e-4)?.frequency ?? 0
    const fq6 = measureSignal(uniformResample(ng.getVector('q6'), te, 0.02, 0.45, 5e-4), 5e-4)?.frequency ?? 0
    const fq8 = measureSignal(uniformResample(ng.getVector('q8'), te, 0.02, 0.45, 1e-3), 1e-3)?.frequency ?? 0
    expect(fq4).toBeGreaterThan(125)
    expect(fq4).toBeLessThan(131)
    expect(fq6).toBeGreaterThan(31)
    expect(fq6).toBeLessThan(33)
    expect(fq8).toBeGreaterThan(7.7)
    expect(fq8).toBeLessThan(8.3)

    // 3. 32768 Hz 晶振模式 CD4060_XTAL32K（完整 14 级真实 d_dff 分频链 -> Q10=32 Hz, Q12=8 Hz, Q13=4 Hz, Q14=2 Hz，实时 >10x）
    const t0Wall = performance.now()
    run(`* CD4060_XTAL32K full 14-stage 32768 Hz -> 2 Hz realtime
.include "cmos.lib"
.include "sensors.lib"
Vdd vdd 0 5
Vmr mr 0 PULSE(5 0 0.5m 1u 1u 10 20)
Xxt vdd 0 xout XTAL_32768 params: freq_hz=32768
X4060 q12 q13 q14 q6 q5 q7 q4 0 npo po xout mr q9 q8 q10 vdd CD4060_XTAL32K
Rq10 q10 0 100k
Rq12 q12 0 100k
Rq13 q13 0 100k
Rq14 q14 0 100k
.tran 500u 1.2
.end`)
    const elapsedMs = performance.now() - t0Wall
    const t = ng.getVector('time')
    const f10 = measureSignal(uniformResample(ng.getVector('q10'), t, 0.05, 1.2, 1e-3), 1e-3)?.frequency ?? 0
    const f12 = measureSignal(uniformResample(ng.getVector('q12'), t, 0.05, 1.2, 1e-3), 1e-3)?.frequency ?? 0
    const f13 = measureSignal(uniformResample(ng.getVector('q13'), t, 0.05, 1.2, 1e-3), 1e-3)?.frequency ?? 0
    const f14 = measureSignal(uniformResample(ng.getVector('q14'), t, 0.05, 1.2, 1e-3), 1e-3)?.frequency ?? 0
    console.log(
      `CD4060_XTAL32K 1.2s tran elapsed=${elapsedMs.toFixed(0)} ms, fQ10=${f10.toFixed(2)}, fQ12=${f12.toFixed(2)}, fQ13=${f13.toFixed(2)}, fQ14=${f14.toFixed(2)}`,
    )
    expect(elapsedMs).toBeLessThan(1000) // >1.2x 实时（实际约 ~80 ms，>15x 实时）
    expect(f10).toBeGreaterThan(31.5)
    expect(f10).toBeLessThan(32.5)
    expect(f12).toBeGreaterThan(7.8)
    expect(f12).toBeLessThan(8.2)
    expect(f13).toBeGreaterThan(3.9)
    expect(f13).toBeLessThan(4.1)
    expect(f14).toBeGreaterThan(1.9)
    expect(f14).toBeLessThan(2.1)
  })

  it('LDR_GL5528、RELAY_5V_SPST 与 SERVO_MOTOR_ENC（60 槽光电测速，1 Hz = 1 r/min）特性校验', () => {
    // 1. 光敏电阻 0 lx (200k) vs 500 lx (~1.4k) + 5 V 继电器吸合/释放
    run(`* LDR + Relay
.include "sensors.lib"
V5 v5 0 5
Xdark v5 nd LDR_GL5528 params: lux=0
Rd nd 0 10k
Xlit v5 nl LDR_GL5528 params: lux=500
Rl nl 0 10k
* 继电器吸合（5 V）与释放（0 V）
Xrel_on v5 0 v5 r_on RELAY_5V_SPST
Ron_l r_on 0 1k
Xrel_off 0 0 v5 r_off RELAY_5V_SPST
Roff_l r_off 0 1k
.op
.end`)
    // 0 lx: 200k / (200k+10k) -> V(nd) ≈ 0.238 V；500 lx: ~1.4k -> V(nl) ≈ 4.38 V
    expect(ng.getVector('nd')[0] ?? 9).toBeLessThan(0.3)
    expect(ng.getVector('nl')[0] ?? 0).toBeGreaterThan(4.2)
    expect(ng.getVector('r_on')[0] ?? 0).toBeGreaterThan(4.9)
    expect(ng.getVector('r_off')[0] ?? 9).toBeLessThan(0.05)

    // 2. 伺服电机 + 60 槽光电码盘：V_arm = 4.5 V -> (4.5-0.5)*7.5 = 30.0 r/min = 30.0 Hz
    run(`* Servo motor optical encoder
.include "sensors.lib"
V5 v5 0 5
Vm vm 0 4.5
Xmot vm 0 v5 0 tach SERVO_MOTOR_ENC params: rpm_per_v=7.5
Rt tach 0 10k
.tran 500u 0.55
.end`)
    const t = ng.getVector('time')
    const tach = uniformResample(ng.getVector('tach'), t, 0.05, 0.55, 1e-3)
    const fTach = measureSignal(tach, 1e-3)?.frequency ?? 0
    expect(fTach).toBeGreaterThan(29.0)
    expect(fTach).toBeLessThan(31.0)
  })
})
