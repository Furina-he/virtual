import { describe, expect, it } from 'vitest'
import {
  layoutVisibleJackLabels,
  MAX_PERSISTENT_LABELS,
  minPairwiseSpacingPx,
  PERSISTENT_LABEL_MIN_SPACING_PX,
} from './jack-label-layout'

describe('T1.9B jack-label-layout persistent anti-overlap labels', () => {
  it('suppresses persistent labels when adjacent jacks are closer than 24 px', () => {
    const dense = [
      { id: 'dc1.A', label: 'A', x: 200, y: 200 },
      { id: 'dc1.B', label: 'B', x: 220, y: 200 },
    ]
    expect(minPairwiseSpacingPx(dense)).toBeLessThan(PERSISTENT_LABEL_MIN_SPACING_PX)
    expect(layoutVisibleJackLabels(dense, { viewportWidth: 800, viewportHeight: 500 })).toEqual([])
  })

  it('places non-overlapping labels around jacks in close-up with spacing >= 24 px', () => {
    const roomy = [
      { id: 'dc1.A', label: 'U1+', x: 200, y: 200 },
      { id: 'dc1.B', label: 'U1−', x: 232, y: 200 },
      { id: 'dc1.C', label: 'GND', x: 200, y: 244 },
      { id: 'dc1.D', label: 'OUT', x: 232, y: 244 },
    ]
    const placed = layoutVisibleJackLabels(roomy, { viewportWidth: 800, viewportHeight: 500 })
    expect(placed).toHaveLength(4)
    expect(new Set(placed.map((entry) => entry.id)).size).toBe(4)
    // Neighboring jacks adapt offsets instead of stacking at identical coordinates
    const byId = new Map(placed.map((entry) => [entry.id, entry]))
    expect(byId.get('dc1.A')?.offsetY).not.toBe(byId.get('dc1.B')?.offsetY)
  })

  it('enforces MAX_PERSISTENT_LABELS cap and respects priority ordering', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `mod.J${index}`,
      label: `J${index}`,
      x: 80 + (index % 8) * 90,
      y: 60 + Math.floor(index / 8) * 80,
      priority: index === 39 ? 10 : 0,
    }))
    const placed = layoutVisibleJackLabels(many, { viewportWidth: 960, viewportHeight: 600 })
    expect(placed.length).toBe(MAX_PERSISTENT_LABELS)
    expect(placed[0]?.id).toBe('mod.J39')
  })
})
