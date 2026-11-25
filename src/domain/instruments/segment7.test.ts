import { describe, expect, it } from 'vitest'
import { decodeSegment7Mask, evaluateSegment7, parseSegment7ModeMask } from './segment7.ts'

describe('T1.11 共阴七段数码管电压解码与掩码解析', () => {
  it('按段电压阈值解码 0~9（兼容 CD4511B 与完整 6/9 字形）及全灭/非标字形', () => {
    expect(evaluateSegment7([4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 0.1])).toMatchObject({
      char: '0',
      mask: 0b1111110,
      litCount: 6,
    })
    expect(evaluateSegment7([0.1, 4.2, 4.2, 0.1, 0.1, 0.1, 0.1])).toMatchObject({
      char: '1',
      mask: 0b0110000,
      litCount: 2,
    })
    // CD4511B 的 6（cdefg）与 9（abcfg）
    expect(decodeSegment7Mask(0b0011111)).toMatchObject({ char: '6', litCount: 5 })
    expect(decodeSegment7Mask(0b1110011)).toMatchObject({ char: '9', litCount: 5 })
    // 完整 6（acdefg）与 9（abcdfg）
    expect(decodeSegment7Mask(0b1011111).char).toBe('6')
    expect(decodeSegment7Mask(0b1111011).char).toBe('9')
    // 全灭与非法字形
    expect(evaluateSegment7([0, 0, 0, 0, 0, 0, 0])).toMatchObject({ char: '', mask: 0, litCount: 0 })
    expect(decodeSegment7Mask(0b1000000)).toMatchObject({ char: '?', litCount: 1 })
  })

  it('解析 SEG7 渲染模式掩码并忽略非 SEG7 字符串', () => {
    expect(parseSegment7ModeMask('SEG7:127')).toBe(127)
    expect(parseSegment7ModeMask('SEG7:0')).toBe(0)
    expect(parseSegment7ModeMask('DCV')).toBeUndefined()
    expect(parseSegment7ModeMask('SEG7:999')).toBeUndefined()
  })
})
