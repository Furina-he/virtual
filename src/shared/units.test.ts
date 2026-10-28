import { describe, expect, it } from 'vitest'
import { formatReading } from './units'

describe('formatReading', () => {
  it('数值与单位之间空一格，按分辨率保留位数', () => {
    expect(formatReading(12, 'V', 1)).toBe('12.0 V')
    expect(formatReading(-1.234, 'mA', 2)).toBe('-1.23 mA')
  })
})
