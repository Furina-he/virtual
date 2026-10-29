import { describe, expect, it } from 'vitest'
import { evaluateFormula, formulaColumns } from './formula.ts'

describe('recorded data formula', () => {
  it('evaluates only bounded arithmetic using recorded columns', () => {
    expect(evaluateFormula('uo/ui', { uo: 0.8, ui: 0.01 }).value).toBe(80)
    expect(evaluateFormula('5100 * ui / (us - ui)', { us: 0.1, ui: 0.01 }).value).toBeCloseTo(566.6666667)
    expect(evaluateFormula('2400 * ([uo-open]/[uo-load] - 1)', { 'uo-open': 1, 'uo-load': 0.5 }).value).toBe(2400)
    expect(evaluateFormula('-(-1 + 2) * +3e2', {}).value).toBe(-300)
    expect(formulaColumns('a+a/[u-in]')).toEqual(['a', 'u-in'])
  })

  it.each([
    'Math.abs(a)',
    'a.foo',
    'globalThis',
    'a;alert(1)',
    'a**2',
    'a +',
    '(a + 1',
    '1e999',
    '1,2',
    '`a`',
    'a ? 1 : 2',
  ])('does not execute unsupported syntax %s', (formula) => {
    const result = evaluateFormula(formula, { a: 1 })
    expect(result.value).toBeNull()
    expect(result.message).toBeTruthy()
  })

  it('keeps missing values, zero denominators and overflow explicitly incomplete', () => {
    expect(evaluateFormula('a/b', { a: 1, b: null }).message).toContain('先记录')
    expect(evaluateFormula('a/b', { a: 1, b: 0 }).message).toContain('分母为零')
    expect(evaluateFormula('a*1e100', { a: 1e300 }).message).toContain('有限数值')
    expect(evaluateFormula('a', { a: Number.NaN }).value).toBeNull()
  })
})
