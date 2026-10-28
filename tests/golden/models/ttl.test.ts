import { describe, expect, it } from 'vitest'
import { at, lib, run } from './helpers'

const VOH_MIN = 2.7
const VOL_MAX = 0.5

// 74LS00 DIP-14：1 1A 2 1B 3 1Y 4 2A 5 2B 6 2Y 7 GND 8 3Y 9 3A 10 3B 11 4Y 12 4A 13 4B 14 VCC
function ls00(a: number, b: number, vcc: boolean) {
  const lv = (x: number) => (x ? 5 : 0)
  return run([
    lib('ttl.lib'),
    vcc ? 'VCC vcc 0 DC 5' : 'Rvcc vcc 0 1G',
    `VA a 0 PWL(0 0 100n 0 101n ${lv(a)})`,
    `VB b 0 PWL(0 0 100n 0 101n ${lv(b)})`,
    'X1 a b y1 a b y2 0 y3 a b y4 a b vcc SN74LS00',
    'RL1 y1 0 10k',
    'RL2 y2 0 10k',
    'RL3 y3 0 10k',
    'RL4 y4 0 10k',
    '.tran 1n 300n 0 1n',
  ])
}

describe('74LS00', () => {
  it('四个门真值表全部正确', () => {
    for (const [a, b] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      const s = ls00(a, b, true)
      const expectHigh = !(a && b)
      for (const y of ['y1', 'y2', 'y3', 'y4']) {
        const v = s.getVector(y).at(-1) ?? 0
        if (expectHigh) expect(v, `${a}${b} ${y}`).toBeGreaterThan(VOH_MIN)
        else expect(v, `${a}${b} ${y}`).toBeLessThan(VOL_MAX)
      }
    }
  })

  it('传输延迟 tPHL 在 5~20 ns（手册典型 10 ns）', () => {
    const s = ls00(1, 1, true)
    const t = s.getVector('time')
    const y = s.getVector('y1')
    const i = Array.from(y).findIndex((v, k) => (t[k] ?? 0) > 100e-9 && v < 1.7)
    const tpd = (t[i] ?? 0) - 100.5e-9
    console.log(`74LS00 tPHL=${(tpd * 1e9).toFixed(1)} ns`)
    expect(tpd).toBeGreaterThan(5e-9)
    expect(tpd).toBeLessThan(20e-9)
  })

  it('VCC 未接时输出不是有效高电平', () => {
    const s = ls00(0, 0, false)
    for (const y of ['y1', 'y2', 'y3', 'y4']) expect(s.getVector(y).at(-1) ?? 0).toBeLessThan(VOL_MAX)
  })
})

// 74LS90 DIP-14：1 CKB 2 R0(1) 3 R0(2) 4 NC 5 VCC 6 R9(1) 7 R9(2) 8 QC 9 QB 10 GND 11 QD 12 QA 13 NC 14 CKA
const PERIOD = 1e-6
function ls90(opts: { vcc?: boolean; r0?: string; r9?: string; n?: number }) {
  const n = opts.n ?? 12
  return run([
    lib('ttl.lib'),
    opts.vcc === false ? 'Rvcc vcc 0 1G' : 'VCC vcc 0 DC 5',
    // 时钟从 2 us 开始，下降沿在 2.5 us + k·1 us
    `VCK cka 0 PULSE(0 5 2u 5n 5n ${PERIOD / 2 - 5e-9} ${PERIOD})`,
    `VR0 r0 0 ${opts.r0 ?? 'PWL(0 5 1u 5 1.01u 0)'}`,
    `VR9 r9 0 ${opts.r9 ?? 'DC 0'}`,
    // QA 接 CKB
    'X1 qa r0 r0 nc4 vcc r9 r9 qc qb 0 qd qa nc13 cka SN74LS90',
    'RLA qa 0 10k',
    'RLB qb 0 10k',
    'RLC qc 0 10k',
    'RLD qd 0 10k',
    `.tran 5n ${2e-6 + n * PERIOD} 0 5n`,
  ])
}

function bcdAt(s: ReturnType<typeof run>, tq: number): number {
  const t = s.getVector('time')
  const bit = (n: string) => {
    const v = at(t, s.getVector(n), tq)
    if (v > VOH_MIN) return 1
    if (v < VOL_MAX) return 0
    throw new Error(`${n} 在 ${tq} 处电平无效: ${v}`)
  }
  return bit('qa') + 2 * bit('qb') + 4 * bit('qc') + 8 * bit('qd')
}

describe('74LS90', () => {
  it('R0 清零后 8421 BCD 计数 0→9→0', () => {
    const s = ls90({})
    const seq: number[] = []
    // 第 k 个下降沿在 2.5u + (k-1)·1u，取下降沿后 0.4 us 采样
    for (let k = 0; k <= 11; k++) seq.push(bcdAt(s, k === 0 ? 2.1e-6 : 2.9e-6 + (k - 1) * PERIOD))
    expect(seq).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1])
  })

  it('R0(1)·R0(2) 保持高电平时不计数', () => {
    const s = ls90({ r0: 'DC 5', n: 5 })
    for (let k = 0; k < 5; k++) expect(bcdAt(s, 2.9e-6 + k * PERIOD)).toBe(0)
  })

  it('R9(1)·R9(2) 置 9，且优先于 R0', () => {
    const s = ls90({ r0: 'DC 5', r9: 'PWL(0 5 1u 5 1.01u 0)', n: 3 })
    expect(bcdAt(s, 0.5e-6)).toBe(9)
    // R9 撤销后 R0 仍为高 -> 清零
    expect(bcdAt(s, 1.5e-6)).toBe(0)
    const s2 = ls90({ r0: 'DC 0', r9: 'PWL(0 5 1u 5 1.01u 0)', n: 3 })
    expect(bcdAt(s2, 1.5e-6)).toBe(9)
    // 9 之后下一个下降沿回到 0
    expect(bcdAt(s2, 2.9e-6)).toBe(0)
    expect(bcdAt(s2, 3.9e-6)).toBe(1)
  })

  it('VCC 未接时输出无效、不计数', () => {
    const s = ls90({ vcc: false, n: 5 })
    for (let k = 0; k < 5; k++) expect(bcdAt(s, 2.9e-6 + k * PERIOD)).toBe(0)
  })
})
