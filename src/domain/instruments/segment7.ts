export const SEGMENT7_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const
export type Segment7Name = (typeof SEGMENT7_NAMES)[number]

export type Segment7State = {
  /** 七段点亮状态，顺序 [a, b, c, d, e, f, g] */
  lit: readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean]
  /** 7 位掩码：bit6=a, bit5=b, bit4=c, bit3=d, bit2=e, bit1=f, bit0=g */
  mask: number
  /** 解析出的十进制字符（0~9），全灭为空串，非标准字形为 '?' */
  char: string
  litCount: number
}

// 兼容 CD4511B（6 无 a 段、9 无 d 段）与 74LS47 / 常见 7 段字形（6 含 a 段、9 含 d 段）
const MASK_TO_CHAR = new Map<number, string>([
  [0b0000000, ''],
  [0b1111110, '0'],
  [0b0110000, '1'],
  [0b1101101, '2'],
  [0b1111001, '3'],
  [0b0110011, '4'],
  [0b1011011, '5'],
  [0b0011111, '6'],
  [0b1011111, '6'],
  [0b1110000, '7'],
  [0b1111111, '8'],
  [0b1110011, '9'],
  [0b1111011, '9'],
])

export function decodeSegment7Mask(mask: number): Segment7State {
  const safeMask = Number.isInteger(mask) ? mask & 0b1111111 : 0
  const lit = [
    Boolean(safeMask & 0b1000000),
    Boolean(safeMask & 0b0100000),
    Boolean(safeMask & 0b0010000),
    Boolean(safeMask & 0b0001000),
    Boolean(safeMask & 0b0000100),
    Boolean(safeMask & 0b0000010),
    Boolean(safeMask & 0b0000001),
  ] as const
  const litCount = lit.reduce((sum, on) => sum + (on ? 1 : 0), 0)
  return {
    lit,
    mask: safeMask,
    char: MASK_TO_CHAR.get(safeMask) ?? '?',
    litCount,
  }
}

/** 按真实仿真段电压（相对共阴端）判定七段数码管点亮状态与字形。 */
export function evaluateSegment7(voltages: readonly (number | undefined)[], threshold = 1.8): Segment7State {
  let mask = 0
  for (let i = 0; i < 7; i++) {
    const v = voltages[i]
    if (typeof v === 'number' && Number.isFinite(v) && v >= threshold) {
      mask |= 1 << (6 - i)
    }
  }
  return decodeSegment7Mask(mask)
}

export function parseSegment7ModeMask(mode?: string): number | undefined {
  if (!mode?.startsWith('SEG7:')) return undefined
  const parsed = Number.parseInt(mode.slice('SEG7:'.length), 10)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 127 ? parsed : undefined
}
