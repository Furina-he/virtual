import { BoxGeometry, Euler, Group, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { collectAnchors } from './anchors'
import { createSlotTargets, pickInstrumentSlot } from './instrument-slot-picking'

const bounds = { left: 130, top: 85, width: 960, height: 540 }

function fixture() {
  const bench = new Group()
  const anchor = new Object3D()
  anchor.name = 'SLOT_DESK_1'
  anchor.position.set(0, 0.8, 0)
  const fixed = new Object3D()
  fixed.name = 'SLOT_INS_DCV'
  fixed.position.set(0, 1.4, -0.2)
  bench.add(anchor, fixed)
  const targets = createSlotTargets(
    collectAnchors(bench),
    { assetId: 'bench', instanceId: 'bench', position: [0, 0, 0] },
    ['SLOT_DESK_1'],
  )
  const camera = new PerspectiveCamera(38, bounds.width / bounds.height, 0.02, 20)
  camera.position.set(0, 2, 2)
  camera.lookAt(0, 0.8, 0)
  camera.updateMatrixWorld(true)
  const dispose = () => {
    for (const target of targets) {
      target.geometry.dispose()
      target.material.dispose()
    }
  }
  return { bench, targets, camera, dispose }
}

function projected(point: Vector3, camera: PerspectiveCamera) {
  const projected = point.clone().project(camera)
  return {
    x: bounds.left + ((projected.x + 1) / 2) * bounds.width,
    y: bounds.top + ((1 - projected.y) / 2) * bounds.height,
  }
}

describe('actual SLOT anchor raycasting', () => {
  it('creates pick planes only for actual desktop GLB anchors, never for fixed console slots', () => {
    const { targets, dispose } = fixture()
    expect(targets).toHaveLength(1)
    expect(targets[0]?.userData.instrumentSlot).toBe('SLOT_DESK_1')
    expect(targets[0]?.position.toArray()).toEqual([0, 0.803, 0])
    const noAnchor = createSlotTargets([], { assetId: 'bench', instanceId: 'bench', position: [0, 0, 0] }, [
      'SLOT_DESK_1',
    ])
    expect(noAnchor).toEqual([])
    dispose()
  })

  it('picks the actual release coordinate with CSS canvas offset and aspect ratio', () => {
    const { targets, camera, dispose } = fixture()
    const target = targets[0]
    if (!target) throw new Error('Missing target')
    const point = projected(target.position, camera)
    expect(pickInstrumentSlot(point, bounds, camera, targets, [])).toBe('SLOT_DESK_1')
    expect(pickInstrumentSlot(projected(new Vector3(0.4, 0.803, 0), camera), bounds, camera, targets, [])).toBeNull()
    dispose()
  })

  it('rejects releases outside the canvas, malformed coordinates, or a zero-sized canvas', () => {
    const { targets, camera, dispose } = fixture()
    for (const point of [
      { x: bounds.left - 1, y: bounds.top + 1 },
      { x: bounds.left + bounds.width + 1, y: bounds.top + 1 },
      { x: bounds.left + 1, y: bounds.top - 1 },
      { x: bounds.left + 1, y: bounds.top + bounds.height + 1 },
      { x: NaN, y: bounds.top },
      { x: bounds.left, y: Infinity },
    ])
      expect(pickInstrumentSlot(point, bounds, camera, targets, [])).toBeNull()
    expect(pickInstrumentSlot({ x: 0, y: 0 }, { ...bounds, width: 0 }, camera, targets, [])).toBeNull()
    dispose()
  })

  it('does not place through instrument housings that occlude a slot', () => {
    const { targets, camera, dispose } = fixture()
    const target = targets[0]
    if (!target) throw new Error('Missing target')
    const blocker = new Mesh(new BoxGeometry(0.35, 0.35, 0.35), new MeshBasicMaterial())
    blocker.position.copy(target.position).lerp(camera.position, 0.3)
    blocker.updateMatrixWorld(true)
    const point = projected(target.position, camera)
    expect(pickInstrumentSlot(point, bounds, camera, targets, [blocker])).toBeNull()
    blocker.userData.ignoreWiringHit = true
    expect(pickInstrumentSlot(point, bounds, camera, targets, [blocker])).toBe('SLOT_DESK_1')
    blocker.geometry.dispose()
    blocker.material.dispose()
    dispose()
  })

  it('respects bench placement translation and rotation rather than a screen-space slot grid', () => {
    const { bench, dispose } = fixture()
    const position: [number, number, number] = [0.6, 0.1, -0.3]
    const rotation: [number, number, number] = [0, Math.PI / 3, 0]
    const targets = createSlotTargets(
      collectAnchors(bench),
      { assetId: 'bench', instanceId: 'bench', position, rotation },
      ['SLOT_DESK_1'],
    )
    const expected = new Vector3(0, 0.803, 0).applyEuler(new Euler(...rotation)).add(new Vector3(...position))
    expect(targets[0]?.position.distanceTo(expected)).toBeLessThan(1e-9)
    for (const target of targets) {
      target.geometry.dispose()
      target.material.dispose()
    }
    dispose()
  })
})
