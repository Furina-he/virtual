import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cordPoints, type Point3 } from './cord.ts'

const start: Point3 = [-0.25, 1.1, 0.12]
const end: Point3 = [0.55, 1.35, -0.48]

function length(points: Point3[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]
    const point = points[i]
    if (!previous || !point) throw new Error('Missing sample')
    total += Math.hypot(...point.map((value, axis) => value - (previous[axis] ?? 0)))
  }
  return total
}

describe('cordPoints', () => {
  it('returns 32 segments with exact copied endpoints without mutating inputs', () => {
    const a = [...start] as Point3
    const b = [...end] as Point3
    const points = cordPoints(a, b, 0.12)
    expect(points).toHaveLength(33)
    expect(points[0]).toEqual(start)
    expect(points.at(-1)).toEqual(end)
    expect(points[0]).not.toBe(a)
    expect(points.at(-1)).not.toBe(b)
    expect(a).toEqual(start)
    expect(b).toEqual(end)
  })

  it.each([0.02, 0.12, 0.4])('has midpoint drop %s m and downward gravity', (sag) => {
    const points = cordPoints(start, end, sag)
    expect(points[16]?.[1]).toBeCloseTo((start[1] + end[1]) / 2 - sag, 12)
    points.forEach((point, index) => {
      const t = index / 32
      expect(point[0]).toBeCloseTo(start[0] + (end[0] - start[0]) * t, 13)
      expect(point[2]).toBeCloseTo(start[2] + (end[2] - start[2]) * t, 13)
      expect(point[1]).toBeLessThanOrEqual(start[1] + (end[1] - start[1]) * t + 1e-12)
      expect(point.every(Number.isFinite)).toBe(true)
    })
  })

  it('matches a true asymmetric catenary, not a sloped line plus symmetric sag', () => {
    const a = 0.65
    const lowPoint = 0.18
    const y0 = 1.3
    const curveY = (x: number) => y0 + a * (Math.cosh((x - lowPoint) / a) - Math.cosh(-lowPoint / a))
    const y1 = curveY(1)
    const sag = (y0 + y1) / 2 - curveY(0.5)
    const points = cordPoints([0.2, y0, -0.4], [0.8, y1, 0.4], sag, 128)
    points.forEach((point, index) => {
      expect(point[1]).toBeCloseTo(curveY(index / 128), 12)
    })
  })

  it('is symmetric at equal heights and reversible at unequal heights', () => {
    const equal = cordPoints([0, 1, 0], [1, 1, 0], 0.3)
    equal.forEach((point, index) => {
      expect(point[1]).toBeCloseTo(equal[32 - index]?.[1] ?? 0, 13)
    })
    const forward = cordPoints(start, end, 0.17)
    const reverse = cordPoints(end, start, 0.17).reverse()
    forward.forEach((point, index) => {
      point.forEach((value, axis) => {
        expect(value).toBeCloseTo(reverse[index]?.[axis] ?? 0, 12)
      })
    })
  })

  it('keeps slack in meters and does not grow with translated world coordinates', () => {
    const local = cordPoints(start, end, 0.12)
    const offset: Point3 = [25, 40, -18]
    const move = (point: Point3): Point3 => [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]]
    const translated = cordPoints(move(start), move(end), 0.12)
    local.forEach((point, index) => {
      point.forEach((value, axis) => {
        expect(translated[index]?.[axis]).toBeCloseTo(value + (offset[axis] ?? 0), 12)
      })
    })
    expect(length(local)).toBeGreaterThan(Math.hypot(0.8, 0.25, -0.6))
    expect(length(local)).toBeLessThan(1.5)
  })

  it('supports denser sampling of a large sag without changing the curve', () => {
    const small = cordPoints(start, end, 0.02)
    const coarse = cordPoints(start, end, 0.4)
    const dense = cordPoints(start, end, 0.4, 128)
    expect(dense).toHaveLength(129)
    expect(length(coarse)).toBeGreaterThan(length(small))
    expect(length(dense)).toBeGreaterThanOrEqual(length(coarse))
    coarse.forEach((point, index) => {
      point.forEach((value, axis) => {
        expect(dense[index * 4]?.[axis]).toBeCloseTo(value, 12)
      })
    })
  })

  it.each([
    [
      [0, 0, 0],
      [0, 1.5, 0],
    ],
    [
      [0, 1.5, 0],
      [0, 0, 0],
    ],
    [
      [0.1, 0.8, -0.2],
      [0.1, 0.8, -0.2],
    ],
    [
      [0, 0, 0],
      [1e-9, 1, -1e-9],
    ],
  ] as [Point3, Point3][])('uses a finite deterministic loop for vertical/coincident endpoints %j %j', (a, b) => {
    const points = cordPoints(a, b, 0.12)
    expect(points).toEqual(cordPoints(a, b, 0.12))
    expect(points[0]).toEqual(a)
    expect(points.at(-1)).toEqual(b)
    expect(points.flat().every(Number.isFinite)).toBe(true)
    expect(points[16]?.[1]).toBeCloseTo((a[1] + b[1]) / 2 - 0.12, 12)
    expect(points.some((point) => Math.abs(point[0] - a[0]) > 0.01)).toBe(true)
    for (let index = 1; index < points.length; index++) expect(points[index]).not.toEqual(points[index - 1])
  })

  it.each([1e-6, 1e-5, 0.01, 0.1, 1, 5, 100])('stays finite at horizontal span %s m', (span) => {
    for (const rise of [-2, 0, 2]) {
      const points = cordPoints([0, 2, 0], [span, 2 + rise, 0], 0.4)
      expect(points.flat().every(Number.isFinite)).toBe(true)
      expect(points[16]?.[1]).toBeCloseTo(2 + rise / 2 - 0.4, 10)
      expect(length(points)).toBeLessThan(span + Math.abs(rise) + 3)
    }
  })

  it('clamps finite sag values to the supported visual range', () => {
    expect(cordPoints(start, end, -1)).toEqual(cordPoints(start, end, 0.02))
    expect(cordPoints(start, end, 8)).toEqual(cordPoints(start, end, 0.4))
  })

  it('rejects nonfinite coordinates/sag and invalid segment counts', () => {
    expect(() => cordPoints([Number.NaN, 0, 0], end, 0.12)).toThrow(RangeError)
    expect(() => cordPoints(start, [0, Number.POSITIVE_INFINITY, 0], 0.12)).toThrow(RangeError)
    expect(() => cordPoints(start, end, Number.NaN)).toThrow(RangeError)
    for (const count of [0, 1, 2.5, 513, Number.POSITIVE_INFINITY]) {
      expect(() => cordPoints(start, end, 0.12, count)).toThrow(RangeError)
    }
  })

  it('does not import rendering, framework, or platform dependencies', () => {
    const source = readFileSync(new URL('./cord.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^\s*import\b/m)
  })
})
