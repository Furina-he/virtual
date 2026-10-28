import {
  type Camera,
  Color,
  DoubleSide,
  Euler,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from 'three'
import type { ScenePlacement } from '../features/practice/wiring-context'
import type { AssetAnchor } from './anchors'

export type SlotTarget = Mesh<PlaneGeometry, MeshBasicMaterial>

// GLB SLOT_ nodes are empty anchors. Their world transforms carry small raycast planes.
export function createSlotTargets(
  anchors: readonly AssetAnchor[],
  placement: ScenePlacement,
  desktopIds: readonly string[],
): SlotTarget[] {
  const rotation = new Quaternion().setFromEuler(new Euler(...(placement.rotation ?? [0, 0, 0])))
  const tabletop = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0))
  return anchors
    .filter((anchor) => anchor.kind === 'SLOT' && desktopIds.includes(anchor.name))
    .map((anchor) => {
      const mesh = new Mesh(
        new PlaneGeometry(0.2, 0.1),
        new MeshBasicMaterial({
          color: new Color('white'),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: DoubleSide,
        }),
      )
      mesh.name = `DROP_${anchor.name}`
      mesh.position
        .copy(anchor.position)
        .applyQuaternion(rotation)
        .add(new Vector3(...placement.position))
      mesh.position.add(new Vector3(0, 0.003, 0).applyQuaternion(rotation))
      mesh.quaternion.copy(rotation).multiply(anchor.quaternion).multiply(tabletop)
      mesh.userData.instrumentSlot = anchor.name
      mesh.userData.ignoreWiringHit = true
      mesh.updateMatrixWorld(true)
      return mesh
    })
}

export function pickInstrumentSlot(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
  camera: Camera,
  targets: SlotTarget[],
  blockers: Object3D[],
): string | null {
  const { left, top, width, height } = bounds
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    width <= 0 ||
    height <= 0 ||
    point.x < left ||
    point.x > left + width ||
    point.y < top ||
    point.y > top + height
  )
    return null
  const raycaster = new Raycaster()
  camera.updateMatrixWorld(true)
  const pointer = new Vector2(((point.x - left) / width) * 2 - 1, 1 - ((point.y - top) / height) * 2)
  raycaster.setFromCamera(pointer, camera)
  for (const target of targets) target.updateMatrixWorld(true)
  const hit = raycaster.intersectObjects(targets, false)[0]
  if (!hit) return null
  const obstacle = raycaster
    .intersectObjects(blockers, true)
    .find(
      (item) =>
        !item.object.userData.ignoreWiringHit && !item.object.userData.instrumentSlot && !item.object.userData.wireId,
    )
  if (obstacle && obstacle.distance < hit.distance - 0.002) return null
  return String(hit.object.userData.instrumentSlot)
}
