import { describe, expect, it } from 'vitest'
import { evaluateSegment7 } from '../../../src/domain/instruments/segment7.ts'
import { at, lib, run } from './helpers.ts'

// CD4511 DIP-16: 1 B 2 C 3 /LT 4 /BI 5 LE 6 D 7 A 8 VSS 9 e 10 d 11 c 12 b 13 a 14 g 15 f 16 VDD
function runCd4511(opts: {
  bcd: number
  lt?: number
  bi?: number
  le?: string
  vdd?: boolean
  extraLines?: string[]
  stopUs?: number
}) {
  const bit = (n: number) => ((opts.bcd >> n) & 1 ? 5 : 0)
  const stop = (opts.stopUs ?? 2) * 1e-6
  return run([
    lib('cmos.lib'),
    opts.vdd === false ? 'Rvdd vdd 0 1G' : 'VDD vdd 0 DC 5',
    `VA a 0 DC ${bit(0)}`,
    `VB b 0 DC ${bit(1)}`,
    `VC c 0 DC ${bit(2)}`,
    `VD d 0 DC ${bit(3)}`,
    `VLT lt 0 DC ${opts.lt ?? 5}`,
    `VBI bi 0 DC ${opts.bi ?? 5}`,
    `VLE le 0 ${opts.le ?? 'DC 0'}`,
    ...(opts.extraLines ?? []),
    'X1 b c lt bi le d a 0 se sd sc sb sa sg sf vdd CD4511',
    'Rsa sa 0 1k',
    'Rsb sb 0 1k',
    'Rsc sc 0 1k',
    'Rsd sd 0 1k',
    'Rse se 0 1k',
    'Rsf sf 0 1k',
    'Rsg sg 0 1k',
    `.tran 20n ${stop} 0 20n`,
  ])
}

function readDisplay(s: ReturnType<typeof run>, tq?: number) {
  const t = s.getVector('time')
  const sample = (name: string) => (tq === undefined ? s.getVector(name).at(-1) : at(t, s.getVector(name), tq))
  return evaluateSegment7(['sa', 'sb', 'sc', 'sd', 'se', 'sf', 'sg'].map(sample), 1.8)
}

describe('T1.11 CD4511 BCD-七段锁存/译码/驱动器金标准', () => {
  it('SIM-15 透明译码 0~9 段码精确符合 CD4511B 真值表，10~15 自动消隐', () => {
    const expectedMasks: Record<number, number> = {
      0: 0b1111110,
      1: 0b0110000,
      2: 0b1101101,
      3: 0b1111001,
      4: 0b0110011,
      5: 0b1011011,
      6: 0b0011111,
      7: 0b1110000,
      8: 0b1111111,
      9: 0b1110011,
    }
    for (let d = 0; d <= 9; d++) {
      const s = runCd4511({ bcd: d })
      const disp = readDisplay(s)
      expect(disp.mask, `BCD=${d}`).toBe(expectedMasks[d])
      expect(disp.char, `BCD=${d}`).toBe(String(d))
    }
    for (let d = 10; d <= 15; d++) {
      const s = runCd4511({ bcd: d })
      const disp = readDisplay(s)
      expect(disp.mask, `BCD=${d} blank`).toBe(0)
      expect(disp.char, `BCD=${d} blank`).toBe('')
    }
  })

  it('SIM-15 /LT 灯测全亮显示 8（优先于 /BI）、/BI 消隐全灭、LE 锁存保持前值', () => {
    // /LT=0, /BI=0 -> 灯测优先，全亮 8
    expect(readDisplay(runCd4511({ bcd: 1, lt: 0, bi: 0 }))).toMatchObject({ mask: 0b1111111, char: '8' })
    // /LT=5, /BI=0 -> 消隐全灭
    expect(readDisplay(runCd4511({ bcd: 8, lt: 5, bi: 0 }))).toMatchObject({ mask: 0, char: '' })

    // LE=0 时输入 5 -> 1 us 时 LE 升至 5 V 锁存 -> 2 us 时 BCD 改为 2 -> 输出保持 5
    const sLatch = run([
      lib('cmos.lib'),
      'VDD vdd 0 DC 5',
      'VA a 0 PWL(0 5 1.8u 5 1.9u 0)',
      'VB b 0 PWL(0 0 1.8u 0 1.9u 5)',
      'VC c 0 PWL(0 5 1.8u 5 1.9u 0)',
      'VD d 0 DC 0',
      'VLT lt 0 DC 5',
      'VBI bi 0 DC 5',
      'VLE le 0 PWL(0 0 0.9u 0 1.0u 5 3.0u 5 3.1u 0)',
      'X1 b c lt bi le d a 0 se sd sc sb sa sg sf vdd CD4511',
      'Rsa sa 0 1k',
      'Rsb sb 0 1k',
      'Rsc sc 0 1k',
      'Rsd sd 0 1k',
      'Rse se 0 1k',
      'Rsf sf 0 1k',
      'Rsg sg 0 1k',
      '.tran 20n 4u 0 20n',
    ])
    expect(readDisplay(sLatch, 0.5e-6).char).toBe('5')
    expect(readDisplay(sLatch, 2.5e-6).char).toBe('5')
    expect(readDisplay(sLatch, 3.8e-6).char).toBe('2')
  })

  it('SIM-15 未供电（VDD 断开）时所有段输出为低电平，且高阻 CMOS 输入不拉低前级 TTL 输出', () => {
    const disp = readDisplay(runCd4511({ bcd: 8, lt: 0, vdd: false }))
    expect(disp.mask).toBe(0)
    expect(disp.char).toBe('')

    // 经 10 kΩ 串联源阻驱动输入引脚（等效弱高阻驱动），验证输入下拉为 10 MΩ（而非 10 mΩ）
    const sHiZ = run([
      lib('cmos.lib'),
      'VDD vdd 0 DC 5',
      'VA sa_src 0 DC 3.4',
      'RA sa_src a 10k',
      'VB b 0 DC 0',
      'VC sc_src 0 DC 3.4',
      'RC sc_src c 10k',
      'VD d 0 DC 0',
      'VLT lt_src 0 DC 5',
      'RLT lt_src lt 10k',
      'VBI bi_src 0 DC 5',
      'RBI bi_src bi 10k',
      'VLE le 0 DC 0',
      'X1 b c lt bi le d a 0 se sd sc sb sa sg sf vdd CD4511',
      'Rsa sa 0 1k',
      'Rsb sb 0 1k',
      'Rsc sc 0 1k',
      'Rsd sd 0 1k',
      'Rse se 0 1k',
      'Rsf sf 0 1k',
      'Rsg sg 0 1k',
      '.tran 20n 2u 0 20n',
    ])
    expect(sHiZ.getVector('a').at(-1)).toBeGreaterThan(3.35)
    expect(readDisplay(sHiZ).char).toBe('5')
  })
})
