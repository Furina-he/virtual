import { describe, expect, it } from 'vitest'
import { type Block, Chunker } from './chunker'

describe('Chunker', () => {
  it('不均匀步长插值到等间隔网格，块序号连续', () => {
    const blocks: Block[] = []
    const c = new Chunker(['a'], 0.1, 4, (b) => blocks.push(b))
    // v = 10 t，步长 0.07 / 0.25 混合
    for (const t of [0, 0.07, 0.32, 0.39, 0.64, 0.71, 0.96, 1.05]) c.push(t, [10 * t])
    c.flush()
    expect(blocks.map((b) => b.seq)).toEqual([0, 1, 2])
    const all = blocks.flatMap((b) => [...(b.data.a as Float32Array)])
    expect(all).toHaveLength(11)
    for (const [k, v] of all.entries()) expect(v).toBeCloseTo(k, 4)
    expect(blocks[1]?.t0).toBeCloseTo(0.4, 9)
    expect(blocks[2]?.data.a).toHaveLength(3)
  })

  it('满块不复用已发出的缓冲', () => {
    const blocks: Block[] = []
    const c = new Chunker(['a', 'b'], 1, 2, (b) => blocks.push(b))
    for (let t = 0; t < 6; t++) c.push(t, [t, -t])
    expect(blocks).toHaveLength(3)
    expect([...(blocks[0]?.data.b ?? [])]).toEqual([0, -1])
    expect(blocks[0]?.data.a?.buffer).not.toBe(blocks[1]?.data.a?.buffer)
  })
})
