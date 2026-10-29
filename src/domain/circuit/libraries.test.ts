import { expect, it } from 'vitest'
import { expandLocalLibraries } from './libraries.ts'

it('inlines only named bundled libraries and preserves the circuit and model license text', () => {
  const text = '.subckt TEST A B\nR1 A B 1k\n.ends TEST\n.include "bjt.lib"'
  const library = '* Project authored estimate\n.model NPN_EST NPN(BF=60)'
  expect(expandLocalLibraries(text, { 'bjt.lib': library })).toBe(text.replace('.include "bjt.lib"', library))
})

it.each([
  '.include "../bjt.lib"',
  '.include "https://example.com/bjt.lib"',
  '.include "C:/model.lib"',
  '.include missing.lib',
  '.include bjt.lib\n.include unknown.lib',
])('rejects unknown libraries and external paths %s', (text) => {
  expect(() => expandLocalLibraries(text, { 'bjt.lib': '.model NPN_EST NPN(BF=60)' })).toThrow('模型库不存在')
})

it('detects recursive model references without executing commands', () => {
  expect(() =>
    expandLocalLibraries('.include a.lib', { 'a.lib': '.include b.lib', 'b.lib': '.include a.lib' }),
  ).toThrow('循环引用')
})
