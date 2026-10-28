import { describe, expect, it } from 'vitest'
import { embeddedPanelFont } from './font.ts'

describe('offline panel typography', () => {
  it('embeds only locally bundled font data and supports independent weights', () => {
    const css = embeddedPanelFont('A 12 V')
    expect(css).toContain("font-family: 'Asset Panel Font'")
    expect(css).toContain('font-weight: 100 900')
    expect(css).toContain('data:font/woff2;base64,')
    expect(css).not.toMatch(/url\((?!data:)/)
    expect(css).not.toMatch(/https?:/)
  })
  it('includes additional local subsets for Chinese panel labels', () => {
    const latin = embeddedPanelFont('A 12 V')
    const chinese = embeddedPanelFont('\u7535\u8def\u57fa\u7840\u5b9e\u9a8c A 12 V')
    expect(chinese.length).toBeGreaterThan(latin.length)
  })
})
