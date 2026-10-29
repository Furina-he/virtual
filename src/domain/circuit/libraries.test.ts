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
  '.inc "bjt.lib"',
  '.lib "https://example.com/bjt.lib" model',
])('rejects unknown libraries and external paths %s', (text) => {
  expect(() => expandLocalLibraries(text, { 'bjt.lib': '.model NPN_EST NPN(BF=60)' })).toThrow('模型库不存在')
})

it('detects recursive model references without executing commands', () => {
  expect(() =>
    expandLocalLibraries('.include a.lib', { 'a.lib': '.include b.lib', 'b.lib': '.include a.lib' }),
  ).toThrow('循环引用')
})

it('deduplicates repeated and transitive dependencies without suppressing the board header', () => {
  const text = '.subckt BOARD A B\nR1 A B 1k\n.ends BOARD\n.include a.lib\n.include b.lib\n.include shared.lib'
  const output = expandLocalLibraries(text, {
    'a.lib': '.include shared.lib\n.model A D(IS=1p)',
    'b.lib': '.include shared.lib\n.model B D(IS=2p)',
    'shared.lib': '* Library license\n.model SHARED D(IS=3p)',
  })
  expect(output.startsWith('.subckt BOARD A B')).toBe(true)
  expect(output.match(/\.model SHARED/g)).toHaveLength(1)
  expect(output.match(/Library license/g)).toHaveLength(1)
  expect(output).toContain('.model A D(IS=1p)')
  expect(output).toContain('.model B D(IS=2p)')
  expect(output).not.toMatch(/\.include/)
  expect(() => expandLocalLibraries(text, { 'a.lib': '.include a.lib', 'b.lib': '', 'shared.lib': '' })).toThrow(
    '循环引用',
  )
})
