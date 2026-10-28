import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ring-buffer'

const f = (...v: number[]) => Float32Array.from(v)

describe('RingBuffer', () => {
  it('未满时按顺序读出', () => {
    const r = new RingBuffer(5)
    r.push(f(1, 2, 3), 0, 0.1)
    expect(r.length).toBe(3)
    expect(r.latest()).toBe(3)
    expect(r.latest(2)).toBe(1)
    expect(r.latest(3)).toBeNaN()
    const out = new Float32Array(3)
    expect(r.copyLatest(out)).toBe(3)
    expect([...out]).toEqual([1, 2, 3])
    expect(r.lastTime).toBeCloseTo(0.2)
  })

  it('跨越边界回绕', () => {
    const r = new RingBuffer(4)
    r.push(f(1, 2, 3))
    r.push(f(4, 5, 6))
    expect(r.length).toBe(4)
    expect(r.written).toBe(6)
    const out = new Float32Array(4)
    r.copyLatest(out)
    expect([...out]).toEqual([3, 4, 5, 6])
    expect(r.latest()).toBe(6)
  })

  it('单次写入超过容量只保留尾部', () => {
    const r = new RingBuffer(3)
    r.push(f(9))
    r.push(f(1, 2, 3, 4, 5))
    const out = new Float32Array(3)
    r.copyLatest(out)
    expect([...out]).toEqual([3, 4, 5])
    expect(r.written).toBe(6)
  })

  it('数据不足时右对齐，清空后归零', () => {
    const r = new RingBuffer(8)
    r.push(f(7, 8))
    const out = new Float32Array(4)
    expect(r.copyLatest(out)).toBe(2)
    expect([...out]).toEqual([0, 0, 7, 8])
    r.clear()
    expect(r.length).toBe(0)
  })
})
