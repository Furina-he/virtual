import { describe, expect, it } from 'vitest'
import { at, lib, run } from './helpers.ts'

const VOH_MIN = 2.7
const VOL_MAX = 0.5
const lv = (b: number | boolean) => (b ? 5 : 0)

function bitOf(s: ReturnType<typeof run>, name: string, tq?: number): 0 | 1 {
  const v = tq === undefined ? (s.getVector(name).at(-1) ?? 0) : at(s.getVector('time'), s.getVector(name), tq)
  if (v > VOH_MIN) return 1
  if (v < VOL_MAX) return 0
  throw new Error(`${name} at ${tq ?? 'end'} invalid TTL voltage: ${v.toFixed(3)} V`)
}

function wordAt(s: ReturnType<typeof run>, names: readonly string[], tq?: number): number {
  return names.reduce((acc, name, idx) => acc + (bitOf(s, name, tq) << idx), 0)
}

describe('SIM-08 / SIM-15 M2 B5 74LS 全系列芯片真值表与供电门控金标准', () => {
  it('74LS02 / 74LS04 / 74LS08 / 74LS32 / 74LS86 五类基本门电路全真值表与断电安全', () => {
    for (const [a, b] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      const s = run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        `VA a 0 PWL(0 0 50n 0 51n ${lv(a)})`,
        `VB b 0 PWL(0 0 50n 0 51n ${lv(b)})`,
        'X02 y_nor a b n2 a b 0 a b n3 a b n4 vcc SN74LS02',
        'X04 a y_not a n04b a n04c 0 n04d a n04e a n04f a vcc SN74LS04',
        'X08 a b y_and a b n08b 0 n08c a b n08d a b vcc SN74LS08',
        'X32 a b y_or a b n32b 0 n32c a b n32d a b vcc SN74LS32',
        'X86 a b y_xor a b n86b 0 n86c a b n86d a b vcc SN74LS86',
        'R1 y_nor 0 10k',
        'R2 y_not 0 10k',
        'R3 y_and 0 10k',
        'R4 y_or 0 10k',
        'R5 y_xor 0 10k',
        '.tran 2n 200n 0 2n',
      ])
      expect(bitOf(s, 'y_nor'), `LS02 ${a}${b}`).toBe(!(a || b) ? 1 : 0)
      expect(bitOf(s, 'y_not'), `LS04 ${a}`).toBe(!a ? 1 : 0)
      expect(bitOf(s, 'y_and'), `LS08 ${a}${b}`).toBe(a && b ? 1 : 0)
      expect(bitOf(s, 'y_or'), `LS32 ${a}${b}`).toBe(a || b ? 1 : 0)
      expect(bitOf(s, 'y_xor'), `LS86 ${a}${b}`).toBe(a !== b ? 1 : 0)
    }

    // 断电时输出全部低于 VOL_MAX
    const unpowered = run([
      lib('ttl.lib'),
      'Rvcc vcc 0 1G',
      'VA a 0 DC 0',
      'VB b 0 DC 0',
      'X02 y_nor a b n2 a b 0 a b n3 a b n4 vcc SN74LS02',
      'X04 a y_not a n04b a n04c 0 n04d a n04e a n04f a vcc SN74LS04',
      'R1 y_nor 0 10k',
      'R2 y_not 0 10k',
      '.tran 5n 100n 0 5n',
    ])
    expect(bitOf(unpowered, 'y_nor')).toBe(0)
    expect(bitOf(unpowered, 'y_not')).toBe(0)
  })

  it('74LS148 8-3 线优先编码器：使能、全 8 级优先级覆盖及 /GS /EO', () => {
    const test148 = (ei: number, activeMask: number) => {
      // activeMask bit k = 1 表示 /Ik = 0（低有效请求）
      const pin = (k: number) => ((activeMask >> k) & 1 ? 0 : 5)
      return run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        `VEI ei 0 DC ${lv(ei)}`,
        ...Array.from({ length: 8 }, (_, k) => `VI${k} i${k} 0 DC ${pin(k)}`),
        'X148 i4 i5 i6 i7 ei a2 a1 0 a0 i0 i1 i2 i3 gs eo vcc SN74LS148',
        'R1 a2 0 10k',
        'R2 a1 0 10k',
        'R3 a0 0 10k',
        'R4 gs 0 10k',
        'R5 eo 0 10k',
        '.tran 5n 100n 0 5n',
      ])
    }
    // /EI=1 禁能：全高
    const dis = test148(1, 0xff)
    expect([bitOf(dis, 'a2'), bitOf(dis, 'a1'), bitOf(dis, 'a0'), bitOf(dis, 'gs'), bitOf(dis, 'eo')]).toEqual([
      1, 1, 1, 1, 1,
    ])
    // /EI=0 无请求：/A=111, /GS=1, /EO=0
    const idle = test148(0, 0x00)
    expect([bitOf(idle, 'a2'), bitOf(idle, 'a1'), bitOf(idle, 'a0'), bitOf(idle, 'gs'), bitOf(idle, 'eo')]).toEqual([
      1, 1, 1, 1, 0,
    ])
    // 单一与多路并发优先测试：最高位 k 覆盖所有低位
    for (let hi = 0; hi <= 7; hi++) {
      const mask = (1 << hi) | (hi > 0 ? 1 : 0) // 同时拉低 /I0 验证高位优先
      const s = test148(0, mask)
      const invCode = (bitOf(s, 'a2') << 2) | (bitOf(s, 'a1') << 1) | bitOf(s, 'a0')
      expect(invCode, `priority hi=${hi}`).toBe(7 - hi)
      expect(bitOf(s, 'gs')).toBe(0)
      expect(bitOf(s, 'eo')).toBe(1)
    }
  })

  it('74LS138 译码器、74LS151 8 选 1 与 74LS153 双 4 选 1 完整真值表', () => {
    // 74LS138 全 8 路译码 + 禁能态
    for (let addr = 0; addr < 8; addr++) {
      const s = run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        `VA a 0 DC ${lv(addr & 1)}`,
        `VB b 0 DC ${lv(addr & 2)}`,
        `VC c 0 DC ${lv(addr & 4)}`,
        'X138 a b c 0 0 vcc y7 0 y6 y5 y4 y3 y2 y1 y0 vcc SN74LS138',
        ...Array.from({ length: 8 }, (_, k) => `Ry${k} y${k} 0 10k`),
        '.tran 5n 100n 0 5n',
      ])
      for (let k = 0; k < 8; k++) expect(bitOf(s, `y${k}`), `138 addr=${addr} y${k}`).toBe(k === addr ? 0 : 1)
    }

    // 74LS151 实现三变量奇校验 F = Σm(1,2,4,7)
    const parity = [0, 1, 1, 0, 1, 0, 0, 1]
    for (let addr = 0; addr < 8; addr++) {
      const s = run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        `VA a 0 DC ${lv(addr & 1)}`,
        `VB b 0 DC ${lv(addr & 2)}`,
        `VC c 0 DC ${lv(addr & 4)}`,
        ...parity.map((p, k) => `VD${k} d${k} 0 DC ${lv(p)}`),
        'X151 d3 d2 d1 d0 y w 0 0 c b a d7 d6 d5 d4 vcc SN74LS151',
        'Ry y 0 10k',
        'Rw w 0 10k',
        '.tran 5n 100n 0 5n',
      ])
      expect(bitOf(s, 'y'), `151 addr=${addr}`).toBe(parity[addr])
      expect(bitOf(s, 'w'), `151 W addr=${addr}`).toBe(parity[addr] ? 0 : 1)
    }

    // 74LS153 双通道（1C = 0110 XOR，2C = 1001 XNOR）
    for (let addr = 0; addr < 4; addr++) {
      const s = run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        `VA a 0 DC ${lv(addr & 1)}`,
        `VB b 0 DC ${lv(addr & 2)}`,
        'X153 0 b 0 vcc vcc 0 y1 0 y2 vcc 0 0 vcc a 0 vcc SN74LS153',
        'R1 y1 0 10k',
        'R2 y2 0 10k',
        '.tran 5n 100n 0 5n',
      ])
      const xorVal = ((addr & 1) !== addr >> 1 ? 1 : 0) as 0 | 1
      expect(bitOf(s, 'y1')).toBe(xorVal)
      expect(bitOf(s, 'y2')).toBe(xorVal ? 0 : 1)
    }
  })

  it('74LS183 双全加器、74LS283 四位超前进位全加器与 74LS85 数值比较器（含级联）', () => {
    // 74LS183 全部 8 组 (A,B,Cin) 真值表
    for (let m = 0; m < 8; m++) {
      const a = m & 1
      const b = (m >> 1) & 1
      const ci = (m >> 2) & 1
      const s = run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        `VA a 0 DC ${lv(a)}`,
        `VB b 0 DC ${lv(b)}`,
        `VC ci 0 DC ${lv(ci)}`,
        'X183 a nc2 b ci s1 co1 0 co2 s2 ci b nc12 a vcc SN74LS183',
        'Rs1 s1 0 10k',
        'Rc1 co1 0 10k',
        'Rs2 s2 0 10k',
        'Rc2 co2 0 10k',
        '.tran 5n 100n 0 5n',
      ])
      const sum = a + b + ci
      expect(bitOf(s, 's1')).toBe(sum & 1)
      expect(bitOf(s, 'co1')).toBe((sum >> 1) & 1)
      expect(bitOf(s, 's2')).toBe(sum & 1)
      expect(bitOf(s, 'co2')).toBe((sum >> 1) & 1)
    }

    // 74LS283 代表性边界与进位传播组合（含 15+0+1=16 满进位链）
    for (const [a, b, c0] of [
      [0, 0, 0],
      [5, 3, 0],
      [9, 6, 1],
      [15, 0, 1],
      [15, 15, 1],
      [10, 7, 0],
    ] as const) {
      const s = run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        ...[0, 1, 2, 3].map((k) => `VA${k} a${k} 0 DC ${lv((a >> k) & 1)}`),
        ...[0, 1, 2, 3].map((k) => `VB${k} b${k} 0 DC ${lv((b >> k) & 1)}`),
        `VC0 c0 0 DC ${lv(c0)}`,
        'X283 s1 b1 a1 s0 a0 b0 c0 0 c4 s3 b3 a3 s2 a2 b2 vcc SN74LS283',
        'Rs0 s0 0 10k',
        'Rs1 s1 0 10k',
        'Rs2 s2 0 10k',
        'Rs3 s3 0 10k',
        'Rc4 c4 0 10k',
        '.tran 5n 100n 0 5n',
      ])
      expect(wordAt(s, ['s0', 's1', 's2', 's3', 'c4'])).toBe(a + b + c0)
    }

    // 74LS85 比较与低位级联（含 A>B、A<B、A=B 透传级联）
    for (const [a, b, igt, ieq, ilt, exp] of [
      [12, 5, 0, 1, 0, [1, 0, 0]],
      [3, 11, 0, 1, 0, [0, 0, 1]],
      [9, 9, 0, 1, 0, [0, 1, 0]],
      [9, 9, 1, 0, 0, [1, 0, 0]],
      [9, 9, 0, 0, 1, [0, 0, 1]],
      [9, 9, 0, 0, 0, [1, 0, 1]],
    ] as const) {
      const s = run([
        lib('ttl.lib'),
        'VCC vcc 0 DC 5',
        ...[0, 1, 2, 3].map((k) => `VA${k} a${k} 0 DC ${lv((a >> k) & 1)}`),
        ...[0, 1, 2, 3].map((k) => `VB${k} b${k} 0 DC ${lv((b >> k) & 1)}`),
        `VGT igt 0 DC ${lv(igt)}`,
        `VEQ ieq 0 DC ${lv(ieq)}`,
        `VLT ilt 0 DC ${lv(ilt)}`,
        'X85 b3 ilt ieq igt ogt oeq olt 0 b0 a0 b1 a1 a2 b2 a3 vcc SN74LS85',
        'R1 ogt 0 10k',
        'R2 oeq 0 10k',
        'R3 olt 0 10k',
        '.tran 5n 100n 0 5n',
      ])
      expect([bitOf(s, 'ogt'), bitOf(s, 'oeq'), bitOf(s, 'olt')]).toEqual([...exp])
    }
  })

  it('74LS74 上升沿 D 触发器与 74LS112 下降沿 JK 触发器（含异步置位/复位与翻转）', () => {
    // 74LS74：0~0.5u /CLR=0 -> Q=0；1u 上升沿锁存 D=1 -> Q=1；2u 上升沿锁存 D=0 -> Q=0；3u /PRE=0 -> Q=1
    const s74 = run([
      lib('ttl.lib'),
      'VCC vcc 0 DC 5',
      'VCLR clr 0 PWL(0 0 400n 0 410n 5)',
      'VPRE pre 0 PWL(0 5 2.8u 5 2.81u 0)',
      'VD d 0 PWL(0 5 1.5u 5 1.51u 0)',
      'VCK ck 0 PWL(0 0 1u 0 1.01u 5 1.4u 5 1.41u 0 2u 0 2.01u 5)',
      'X74 clr d ck pre q nq 0 nq2 q2 vcc 0 0 vcc vcc SN74LS74',
      'Rq q 0 10k',
      'Rnq nq 0 10k',
      '.tran 5n 3.4u 0 5n',
    ])
    expect(bitOf(s74, 'q', 0.2e-6)).toBe(0)
    expect(bitOf(s74, 'q', 1.3e-6)).toBe(1)
    expect(bitOf(s74, 'nq', 1.3e-6)).toBe(0)
    expect(bitOf(s74, 'q', 2.3e-6)).toBe(0)
    expect(bitOf(s74, 'q', 3.1e-6)).toBe(1)

    // 74LS112：J=K=1 下降沿翻转（t=1u 下降沿 0->1，t=2u 下降沿 1->0，t=3u 下降沿 0->1）
    const s112 = run([
      lib('ttl.lib'),
      'VCC vcc 0 DC 5',
      'VCLR clr 0 PWL(0 0 300n 0 310n 5)',
      'VCK ck 0 PWL(0 5 1u 5 1.01u 0 1.5u 0 1.51u 5 2u 5 2.01u 0 2.5u 0 2.51u 5 3u 5 3.01u 0)',
      'X112 ck vcc vcc vcc q nq nq2 0 q2 vcc 0 0 vcc vcc clr vcc SN74LS112',
      'Rq q 0 10k',
      'Rnq nq 0 10k',
      '.tran 5n 3.5u 0 5n',
    ])
    expect(bitOf(s112, 'q', 0.5e-6)).toBe(0)
    expect(bitOf(s112, 'q', 1.3e-6)).toBe(1)
    expect(bitOf(s112, 'q', 2.3e-6)).toBe(0)
    expect(bitOf(s112, 'q', 3.3e-6)).toBe(1)
  })

  it('74LS194 双向移位寄存器：清零、并行置数 1010、右移、保持、左移全功能', () => {
    // 时钟上升沿在 1u, 2u, 3u, 4u, 5u
    // t=0.2u /CLR=0 -> 0000
    // t=1u S1S0=11 并行置数 DCBA=1010 (A=0,B=1,C=0,D=1 => 10)
    // t=2u S1S0=01 右移(SR=1): QA=1,QB=0,QC=1,QD=0 => 0101 (5)
    // t=3u S1S0=00 保持: 0101 (5)
    // t=4u S1S0=10 左移(SL=1): QD=1,QC=0,QB=1,QA=0 => 1010 (10)
    // t=5u S1S0=10 左移(SL=0): QD=0,QC=1,QB=0,QA=1 => 0101 (5)
    const s = run([
      lib('ttl.lib'),
      'VCC vcc 0 DC 5',
      'VCLR clr 0 PWL(0 0 300n 0 310n 5)',
      'VCK ck 0 PULSE(0 5 1u 5n 5n 400n 1u)',
      'VS1 s1 0 PWL(0 5 1.5u 5 1.51u 0 3.5u 0 3.51u 5)',
      'VS0 s0 0 PWL(0 5 2.5u 5 2.51u 0)',
      'VSR sr 0 DC 5',
      'VSL sl 0 PWL(0 5 4.5u 5 4.51u 0)',
      // A=0, B=1, C=0, D=1
      'X194 clr sr 0 vcc 0 vcc sl 0 s0 s1 ck qd qc qb qa vcc SN74LS194',
      'Rqa qa 0 10k',
      'Rqb qb 0 10k',
      'Rqc qc 0 10k',
      'Rqd qd 0 10k',
      '.tran 5n 5.6u 0 5n',
    ])
    const q = (tq: number) => wordAt(s, ['qa', 'qb', 'qc', 'qd'], tq)
    expect(q(0.5e-6)).toBe(0b0000)
    expect(q(1.3e-6)).toBe(0b1010)
    expect(q(2.3e-6)).toBe(0b0101)
    expect(q(3.3e-6)).toBe(0b0101)
    expect(q(4.3e-6)).toBe(0b1010)
    expect(q(5.3e-6)).toBe(0b0101)
  })

  it('74LS192 可逆十进制计数器：异步置数、UP 加计数 8→9→0(/CO)、DOWN 减计数 0→9(/BO)→8', () => {
    // 0~0.3u: /LOAD=0 置数 8 (D=1,C=0,B=0,A=0)
    // UP 上升沿在 1.5u (8->9), 2.5u (9->0), 3.5u (0->1)；UP 在 2.0u~2.4u 为低 -> /CO 应为低!
    // DOWN 上升沿在 4.5u (1->0), 5.5u (0->9), 6.5u (9->8)；DOWN 在 5.0u~5.4u 为低 -> /BO 应为低!
    const s = run([
      lib('ttl.lib'),
      'VCC vcc 0 DC 5',
      'VLD nld 0 PWL(0 0 300n 0 310n 5)',
      'VUP up 0 PWL(0 5 1u 5 1.01u 0 1.5u 0 1.51u 5 2u 5 2.01u 0 2.5u 0 2.51u 5 3u 5 3.01u 0 3.5u 0 3.51u 5)',
      'VDN dn 0 PWL(0 5 4u 5 4.01u 0 4.5u 0 4.51u 5 5u 5 5.01u 0 5.5u 0 5.51u 5 6u 5 6.01u 0 6.5u 0 6.51u 5)',
      'X192 0 qb qa dn up qc qd 0 vcc 0 nld co bo 0 0 vcc SN74LS192',
      'Ra qa 0 10k',
      'Rb qb 0 10k',
      'Rc qc 0 10k',
      'Rd qd 0 10k',
      'Rco co 0 10k',
      'Rbo bo 0 10k',
      '.tran 5n 7u 0 5n',
    ])
    const q = (tq: number) => wordAt(s, ['qa', 'qb', 'qc', 'qd'], tq)
    expect(q(0.7e-6)).toBe(8)
    expect(q(1.8e-6)).toBe(9)
    expect(bitOf(s, 'co', 2.25e-6)).toBe(0) // Q=9 且 UP=0 -> /CO 有效低电平
    expect(q(2.8e-6)).toBe(0)
    expect(bitOf(s, 'co', 2.8e-6)).toBe(1)
    expect(q(3.8e-6)).toBe(1)
    expect(q(4.8e-6)).toBe(0)
    expect(bitOf(s, 'bo', 5.25e-6)).toBe(0) // Q=0 且 DOWN=0 -> /BO 有效低电平
    expect(q(5.8e-6)).toBe(9)
    expect(q(6.8e-6)).toBe(8)

    // 慢上升沿（10 µs 边沿）下验证完整 0→1→2→3 递增（防 adc_bridge 过渡区干扰方向判别）
    const slow = run([
      lib('ttl.lib'),
      'VCC vcc 0 DC 5',
      'VCLR clr 0 PWL(0 5 100u 5 101u 0)',
      'VUP up 0 PULSE(0 5 500u 10u 10u 500u 1m)',
      'X192 0 qb qa vcc up qc qd 0 0 0 vcc co bo clr 0 vcc SN74LS192',
      'Ra qa 0 10k',
      'Rb qb 0 10k',
      'Rc qc 0 10k',
      'Rd qd 0 10k',
      '.tran 5u 4m 0 5u',
    ])
    const qs = (tq: number) => wordAt(slow, ['qa', 'qb', 'qc', 'qd'], tq)
    expect([qs(0.3e-3), qs(0.8e-3), qs(1.8e-3), qs(2.8e-3), qs(3.8e-3)]).toEqual([0, 1, 2, 3, 4])
  })

  it('74LS161 同步二进制计数器（0→15→0 + RCO）与 74LS160 同步十进制计数器（0→9→0 + RCO + 同步置数）', () => {
    const s161 = run([
      lib('ttl.lib'),
      'VCC vcc 0 DC 5',
      'VCLR clr 0 PWL(0 0 300n 0 310n 5)',
      // 同步置数 13 (1101) 于第 1 个上升沿 (1u)，随后正常加计数 13->14->15(RCO=1)->0->1
      'VLD nld 0 PWL(0 0 1.4u 0 1.41u 5)',
      'VCK ck 0 PULSE(0 5 1u 5n 5n 400n 1u)',
      'X161 clr ck vcc 0 vcc vcc vcc 0 nld vcc qd qc qb qa rco vcc SN74LS161',
      'Ra qa 0 10k',
      'Rb qb 0 10k',
      'Rc qc 0 10k',
      'Rd qd 0 10k',
      'Rrco rco 0 10k',
      '.tran 5n 5.6u 0 5n',
    ])
    const q161 = (tq: number) => wordAt(s161, ['qa', 'qb', 'qc', 'qd'], tq)
    expect(q161(0.5e-6)).toBe(0)
    expect(q161(1.3e-6)).toBe(13)
    expect(q161(2.3e-6)).toBe(14)
    expect(q161(3.3e-6)).toBe(15)
    expect(bitOf(s161, 'rco', 3.3e-6)).toBe(1)
    expect(q161(4.3e-6)).toBe(0)
    expect(bitOf(s161, 'rco', 4.3e-6)).toBe(0)
    expect(q161(5.3e-6)).toBe(1)

    const s160 = run([
      lib('ttl.lib'),
      'VCC vcc 0 DC 5',
      'VCLR clr 0 PWL(0 0 300n 0 310n 5)',
      // 同步置数 7 (0111) 于 1u，随后 7->8->9(RCO=1)->0->1
      'VLD nld 0 PWL(0 0 1.4u 0 1.41u 5)',
      'VCK ck 0 PULSE(0 5 1u 5n 5n 400n 1u)',
      'X160 clr ck vcc vcc vcc 0 vcc 0 nld vcc qd qc qb qa rco vcc SN74LS160',
      'Ra qa 0 10k',
      'Rb qb 0 10k',
      'Rc qc 0 10k',
      'Rd qd 0 10k',
      'Rrco rco 0 10k',
      '.tran 5n 5.6u 0 5n',
    ])
    const q160 = (tq: number) => wordAt(s160, ['qa', 'qb', 'qc', 'qd'], tq)
    expect(q160(1.3e-6)).toBe(7)
    expect(q160(2.3e-6)).toBe(8)
    expect(q160(3.3e-6)).toBe(9)
    expect(bitOf(s160, 'rco', 3.3e-6)).toBe(1)
    expect(q160(4.3e-6)).toBe(0)
    expect(bitOf(s160, 'rco', 4.3e-6)).toBe(0)
    expect(q160(5.3e-6)).toBe(1)
  })
})
