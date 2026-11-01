import { type Camera, type Object3D, Raycaster, Vector2, Vector3 } from 'three'

/** 技术设计 §10.3：插孔按屏幕距离吸附、导线按投影折线拾取，单位为 CSS px。 */
export const JACK_PICK_RADIUS_PX = 24
export const JACK_PICK_HYSTERESIS_PX = 4
export const WIRE_PICK_RADIUS_PX = 8
/** 插孔金属圈凸出面板，沿视线在锚点前这段距离内的命中不算遮挡。 */
export const OCCLUSION_TOLERANCE_M = 0.015

export interface ScreenPoint {
  x: number
  y: number
}

export interface ScreenTarget extends ScreenPoint {
  id: string
}

/**
 * Nearest target within the radius. The current target keeps priority until another one is
 * closer by more than the hysteresis, so the cursor does not flicker between dense jacks.
 */
export function nearestTarget<T extends ScreenTarget>(
  pointer: ScreenPoint,
  targets: readonly T[],
  radius = JACK_PICK_RADIUS_PX,
  current: string | null = null,
  hysteresis = JACK_PICK_HYSTERESIS_PX,
): T | null {
  let best: { target: T; distance: number } | null = null
  let held: { target: T; distance: number } | null = null
  for (const target of targets) {
    const distance = Math.hypot(target.x - pointer.x, target.y - pointer.y)
    if (distance > radius) continue
    if (target.id === current) held = { target, distance }
    if (!best || distance < best.distance) best = { target, distance }
  }
  if (held && best && best.target.id !== held.target.id && held.distance - best.distance <= hysteresis)
    return held.target
  return best?.target ?? null
}

/** Ordered by screen distance, for limiting the more expensive occlusion test to a few candidates. */
export function targetsWithin<T extends ScreenTarget>(
  pointer: ScreenPoint,
  targets: readonly T[],
  radius: number,
): T[] {
  return targets
    .map((target) => ({ target, distance: Math.hypot(target.x - pointer.x, target.y - pointer.y) }))
    .filter((entry) => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.target)
}

/**
 * 设备上相邻插孔的屏幕间距不小于该值时才直接接线；更小时单击设备先进入特写（LVSIM/Multisim 的先推近再操作）。
 */
export const MIN_PICKABLE_SPACING_PX = 14

/** Devices whose visible jacks are far enough apart on screen to be picked individually. */
export function pickableDevices(
  jacks: readonly (ScreenPoint & { device: string })[],
  minSpacing = MIN_PICKABLE_SPACING_PX,
): Set<string> {
  const groups = new Map<string, ScreenPoint[]>()
  for (const jack of jacks) {
    const group = groups.get(jack.device) ?? []
    group.push(jack)
    groups.set(jack.device, group)
  }
  const result = new Set<string>()
  for (const [device, points] of groups) {
    let spacing = Number.POSITIVE_INFINITY
    for (let i = 0; i < points.length; i++)
      for (let k = i + 1; k < points.length; k++) {
        const a = points[i]
        const b = points[k]
        if (a && b) spacing = Math.min(spacing, Math.hypot(a.x - b.x, a.y - b.y))
      }
    if (spacing >= minSpacing) result.add(device)
  }
  return result
}

export function distanceToPolyline(pointer: ScreenPoint, points: readonly ScreenPoint[]): number {
  const [first] = points
  if (!first) return Number.POSITIVE_INFINITY
  if (points.length === 1) return Math.hypot(first.x - pointer.x, first.y - pointer.y)
  let best = Number.POSITIVE_INFINITY
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]
    const b = points[index]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = dx * dx + dy * dy
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((pointer.x - a.x) * dx + (pointer.y - a.y) * dy) / length))
    best = Math.min(best, Math.hypot(a.x + dx * t - pointer.x, a.y + dy * t - pointer.y))
  }
  return best
}

export function nearestPolyline(
  pointer: ScreenPoint,
  lines: readonly { id: string; points: readonly ScreenPoint[] }[],
  radius = WIRE_PICK_RADIUS_PX,
): string | null {
  let best: { id: string; distance: number } | null = null
  for (const line of lines) {
    const distance = distanceToPolyline(pointer, line.points)
    if (distance <= radius && (!best || distance < best.distance)) best = { id: line.id, distance }
  }
  return best?.id ?? null
}

const projected = new Vector3()

/** CSS px inside the canvas, or null when the point is behind the camera or outside the clip volume. */
export function projectToCanvas(
  position: Vector3,
  camera: Camera,
  size: { width: number; height: number },
): ScreenPoint | null {
  projected.copy(position).project(camera)
  if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1) return null
  return { x: ((projected.x + 1) / 2) * size.width, y: ((1 - projected.y) / 2) * size.height }
}

const toCamera = new Vector3()

export function facesCamera(position: Vector3, normal: Vector3, camera: Camera) {
  return toCamera.subVectors(camera.position, position).dot(normal) > 0
}

const raycaster = new Raycaster()
const direction = new Vector3()

/** True when solid bench geometry lies between the camera and the point (beyond the tolerance). */
export function isOccluded(position: Vector3, camera: Camera, solids: readonly Object3D[]) {
  direction.subVectors(position, camera.position)
  const distance = direction.length()
  raycaster.set(camera.position, direction.normalize())
  raycaster.far = Math.max(0, distance - OCCLUSION_TOLERANCE_M)
  return raycaster.intersectObjects(solids as Object3D[], false).length > 0
}

export function pointerInCanvas(event: { clientX: number; clientY: number }, bounds: DOMRect): ScreenPoint | null {
  const x = event.clientX - bounds.left
  const y = event.clientY - bounds.top
  return x < 0 || y < 0 || x > bounds.width || y > bounds.height ? null : { x, y }
}

export function toNdc(point: ScreenPoint, size: { width: number; height: number }, target = new Vector2()) {
  return target.set((point.x / size.width) * 2 - 1, -(point.y / size.height) * 2 + 1)
}
