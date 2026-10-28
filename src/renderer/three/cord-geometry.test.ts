import type { Wire } from '@shared/schema/circuit'
import { describe, expect, it } from 'vitest'
import { clampCordPoints, jackStackCount, patchCordGeometry, plugPosition } from './cord-geometry'

const jacks = [
  { ref: 'box.A', position: [0, 0.9, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] },
  {
    ref: 'meter.POS',
    position: [0.4, 1.1, 0.1] as [number, number, number],
    normal: [0, 0, 1] as [number, number, number],
  },
]

describe('patch cord geometry', () => {
  it('stacks 3 plugs at different axial positions and fanout angles', () => {
    const jack = jacks[0]
    if (!jack) throw new Error('Missing test jack')
    const positions = [0, 1, 2].map((index) => plugPosition(jack, index))
    expect(positions[1]?.point.z).toBeCloseTo((positions[0]?.point.z ?? 0) + 0.008)
    expect(positions[2]?.point.z).toBeCloseTo((positions[1]?.point.z ?? 0) + 0.008)
    expect(new Set(positions.map((position) => `${position.exit.x},${position.exit.y}`)).size).toBe(3)
  })

  it('generates one finite mesh per wire and leaves endpoint metadata unchanged', () => {
    const wire: Wire = { id: 'w1', a: 'box.A', b: 'meter.POS', color: 'red', slack: 0.12 }
    const { geometry, midpoint } = patchCordGeometry(wire, jacks, [wire])
    expect(geometry.index?.count).toBeGreaterThan(32 * 6)
    expect(Array.from(geometry.attributes.position?.array ?? []).every(Number.isFinite)).toBe(true)
    expect(midpoint.y).toBeLessThan(1)
    expect(jacks[0]?.position).toEqual([0, 0.9, 0])
    expect(jackStackCount([wire], 'box.A')).toBe(1)
    geometry.dispose()
  })

  it('clamps contact to the content-defined tabletop only inside its footprint', () => {
    const points: [number, number, number][] = [
      [0, 0.6, 0],
      [1.2, 0.6, 0],
      [1.2, -0.1, 0],
    ]
    clampCordPoints(points, { min: [-0.9, 0.8, -0.375], max: [0.9, 0.8, 0.375] })
    expect(points[0]?.[1]).toBeCloseTo(0.806)
    expect(points[1]?.[1]).toBeCloseTo(0.6)
    expect(points[2]?.[1]).toBeCloseTo(0.008)
  })

  it('gives PE wires both yellow and green vertex colors without additional draw groups', () => {
    const wire: Wire = { id: 'pe', a: 'box.A', b: 'meter.POS', color: 'yellowGreen' }
    const { geometry } = patchCordGeometry(wire, jacks, [wire])
    const colors = geometry.getAttribute('color')
    expect(colors.count).toBe(geometry.getAttribute('position').count)
    expect(colors.getX(0)).not.toBe(colors.getX(14))
    expect(geometry.groups).toHaveLength(0)
    geometry.dispose()
  })

  it('routes a front-panel cord ahead of an intervening deeper module face', () => {
    const refs = [
      {
        ref: 'power.P',
        position: [-0.6, 1, -0.21] as [number, number, number],
        normal: [0, 0, 1] as [number, number, number],
      },
      {
        ref: 'meter.P',
        position: [0.1, 1.45, -0.21] as [number, number, number],
        normal: [0, 0, 1] as [number, number, number],
      },
      {
        ref: 'module.A',
        position: [-0.15, 1.2, -0.16] as [number, number, number],
        normal: [0, 0, 1] as [number, number, number],
      },
    ]
    const wire: Wire = { id: 'w1', a: 'power.P', b: 'meter.P', color: 'red', slack: 0.12 }
    const { geometry, midpoint } = patchCordGeometry(wire, refs, [wire])
    expect(midpoint.z).toBeGreaterThan(-0.14)
    expect(Array.from(geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true)
    geometry.dispose()
  })
})
