import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  distanceToPolyline,
  facesCamera,
  isOccluded,
  JACK_PICK_RADIUS_PX,
  nearestPolyline,
  nearestTarget,
  pickableDevices,
  pointerInCanvas,
  projectToCanvas,
  targetsWithin,
} from './screen-picking'

const jacks = [
  { id: 'a', x: 100, y: 100 },
  { id: 'b', x: 120, y: 100 },
  { id: 'c', x: 300, y: 300 },
]

describe('nearestTarget', () => {
  it('snaps to the closest jack within 24 px and ignores farther ones', () => {
    expect(nearestTarget({ x: 104, y: 110 }, jacks)?.id).toBe('a')
    expect(nearestTarget({ x: 100, y: 100 + JACK_PICK_RADIUS_PX }, jacks)?.id).toBe('a')
    expect(nearestTarget({ x: 100, y: 100 + JACK_PICK_RADIUS_PX + 1 }, jacks)).toBeNull()
    expect(nearestTarget({ x: 200, y: 200 }, jacks)).toBeNull()
  })

  it('keeps the held jack until another is closer by more than the hysteresis', () => {
    // 11 px from a, 9 px from b: within 4 px, so a stays.
    expect(nearestTarget({ x: 111, y: 100 }, jacks, 24, 'a')?.id).toBe('a')
    expect(nearestTarget({ x: 111, y: 100 }, jacks, 24, null)?.id).toBe('b')
    // 15 px from a, 5 px from b: switch.
    expect(nearestTarget({ x: 115, y: 100 }, jacks, 24, 'a')?.id).toBe('b')
  })

  it('orders candidates by distance', () => {
    expect(targetsWithin({ x: 118, y: 100 }, jacks, 24).map((target) => target.id)).toEqual(['b', 'a'])
  })
})

describe('pickableDevices', () => {
  it('requires jacks of a device to be at least 14 px apart; a lone jack is always pickable', () => {
    const projected = [
      { device: 'box', x: 0, y: 0 },
      { device: 'box', x: 7, y: 0 },
      { device: 'supply', x: 0, y: 50 },
      { device: 'supply', x: 19, y: 50 },
      { device: 'probe', x: 90, y: 90 },
    ]
    expect([...pickableDevices(projected)].sort()).toEqual(['probe', 'supply'])
    expect([...pickableDevices(projected, 6)].sort()).toEqual(['box', 'probe', 'supply'])
  })
})

describe('polyline picking', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ]
  it('measures distance to the nearest segment, not only vertices', () => {
    expect(distanceToPolyline({ x: 50, y: 6 }, line)).toBeCloseTo(6)
    expect(distanceToPolyline({ x: 106, y: 50 }, line)).toBeCloseTo(6)
    expect(distanceToPolyline({ x: -3, y: -4 }, line)).toBeCloseTo(5)
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Number.POSITIVE_INFINITY)
  })

  it('selects the nearest wire within 8 px', () => {
    const lines = [
      { id: 'w1', points: line },
      {
        id: 'w2',
        points: [
          { x: 0, y: 10 },
          { x: 100, y: 10 },
        ],
      },
    ]
    expect(nearestPolyline({ x: 50, y: 3 }, lines)).toBe('w1')
    expect(nearestPolyline({ x: 50, y: 8 }, lines)).toBe('w2')
    expect(nearestPolyline({ x: 50, y: 30 }, lines)).toBeNull()
  })
})

describe('projection and occlusion', () => {
  const camera = new PerspectiveCamera(38, 2, 0.02, 20)
  camera.position.set(0, 0, 2)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  const size = { width: 800, height: 400 }

  it('projects into canvas CSS pixels and rejects points behind the camera', () => {
    expect(projectToCanvas(new Vector3(0, 0, 0), camera, size)).toEqual({ x: 400, y: 200 })
    expect(projectToCanvas(new Vector3(0, 0, 3), camera, size)).toBeNull()
  })

  it('treats back-facing jacks as hidden', () => {
    expect(facesCamera(new Vector3(), new Vector3(0, 0, 1), camera)).toBe(true)
    expect(facesCamera(new Vector3(), new Vector3(0, 0, -1), camera)).toBe(false)
  })

  it('ignores the jack panel itself but reports a solid in front of the jack', () => {
    const panel = new Mesh(new BoxGeometry(1, 1, 0.01), new MeshBasicMaterial())
    panel.position.set(0, 0, -0.008)
    panel.updateMatrixWorld()
    expect(isOccluded(new Vector3(0, 0, 0), camera, [panel])).toBe(false)
    const cover = new Mesh(new BoxGeometry(0.2, 0.2, 0.05), new MeshBasicMaterial())
    cover.position.set(0, 0, 0.4)
    cover.updateMatrixWorld()
    expect(isOccluded(new Vector3(0, 0, 0), camera, [panel, cover])).toBe(true)
  })

  it('keeps pointer coordinates relative to the canvas', () => {
    const bounds = { left: 10, top: 20, width: 100, height: 50 } as DOMRect
    expect(pointerInCanvas({ clientX: 60, clientY: 45 }, bounds)).toEqual({ x: 50, y: 25 })
    expect(pointerInCanvas({ clientX: 5, clientY: 45 }, bounds)).toBeNull()
  })
})
