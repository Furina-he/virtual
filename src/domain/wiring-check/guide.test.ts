import { describe, expect, it } from 'vitest'
import { missingReferenceLinks } from './guide.ts'

describe('missingReferenceLinks', () => {
  it('chains every jack of an unwired net', () => {
    expect(missingReferenceLinks([['p.A', 'm.B', 'm.C']], [])).toEqual([
      ['p.A', 'm.B'],
      ['m.B', 'm.C'],
    ])
  })

  it('skips jacks already connected, directly or through other wires', () => {
    const wires = [
      { a: 'p.A', b: 'x.T' },
      { a: 'x.T', b: 'm.C' },
    ]
    expect(missingReferenceLinks([['p.A', 'm.B', 'm.C']], wires)).toEqual([['p.A', 'm.B']])
  })

  it('returns nothing once each net is connected', () => {
    const nets = [
      ['p.A', 'm.B'],
      ['p.N', 'm.D'],
    ]
    const wires = [
      { a: 'm.B', b: 'p.A' },
      { a: 'p.N', b: 'm.D' },
    ]
    expect(missingReferenceLinks(nets, wires)).toEqual([])
  })
})
