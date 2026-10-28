import { cordPoints, type Point3 } from '@domain/wiring/cord'
import type { Wire } from '@shared/schema/circuit'
import {
  type BufferGeometry,
  Color,
  Curve,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  TubeGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export interface JackPosition {
  ref: string
  position: Point3
  normal: Point3
}

export interface WorkSurface {
  min: Point3
  max: Point3
}

/** Preserve the solver's catenary samples without spline overshoot at the tabletop. */
class CordCurve extends Curve<Vector3> {
  constructor(private readonly points: Point3[]) {
    super()
  }

  override getPoint(t: number, target = new Vector3()) {
    const scaled = Math.max(0, Math.min(1, t)) * (this.points.length - 1)
    const index = Math.min(this.points.length - 2, Math.floor(scaled))
    const a = this.points[index]
    const b = this.points[index + 1]
    if (!a || !b) return target
    return target.set(
      a[0] + (b[0] - a[0]) * (scaled - index),
      a[1] + (b[1] - a[1]) * (scaled - index),
      a[2] + (b[2] - a[2]) * (scaled - index),
    )
  }
}

export function jackStackCount(wires: Wire[], ref: string): number {
  return wires.filter((wire) => wire.a === ref || wire.b === ref).length
}

export function plugPosition(jack: JackPosition, stackIndex: number) {
  const normal = new Vector3(...jack.normal).normalize()
  const point = new Vector3(...jack.position).addScaledVector(normal, 0.003 + stackIndex * 0.008)
  const sideways = new Vector3(0, 1, 0).cross(normal).normalize()
  const upwards = normal.clone().cross(sideways).normalize()
  const angle = (stackIndex * Math.PI * 2) / 3
  const exit = point
    .clone()
    .addScaledVector(normal, 0.006)
    .addScaledVector(sideways, Math.cos(angle) * 0.012)
    .addScaledVector(upwards, Math.sin(angle) * 0.012)
  return { point, exit, normal }
}

function joinedGeometry(parts: BufferGeometry[]): BufferGeometry {
  const geometry = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!geometry) throw new Error('Cannot merge patch cord geometry')
  return geometry
}

function tube(points: Point3[], radius = 0.0018) {
  return new TubeGeometry(new CordCurve(points), points.length - 1, radius, 6, false)
}

export function clampCordPoints(points: Point3[], surface?: WorkSurface) {
  for (const point of points) {
    const onTable =
      surface &&
      point[0] >= surface.min[0] &&
      point[0] <= surface.max[0] &&
      point[2] >= surface.min[2] &&
      point[2] <= surface.max[2]
    point[1] = Math.max(onTable ? surface.max[1] + 0.006 : 0.008, point[1])
  }
  return points
}

export function patchCordGeometry(wire: Wire, jacks: readonly JackPosition[], wires: Wire[], surface?: WorkSurface) {
  const a = jacks.find((jack) => jack.ref === wire.a)
  const b = jacks.find((jack) => jack.ref === wire.b)
  if (!a || !b) throw new Error(`Missing endpoints for wire ${wire.id}`)
  const end = (jack: JackPosition) =>
    plugPosition(
      jack,
      wires.filter((item) => item.a === jack.ref || item.b === jack.ref).findIndex((item) => item.id === wire.id),
    )
  const start = end(a)
  const finish = end(b)
  const mainStart = start.exit.clone()
  const mainFinish = finish.exit.clone()
  if (a.normal[2] > 0.9 && b.normal[2] > 0.9) {
    // Front-panel cords clear intervening module faces, rather than tunnelling through them.
    const left = Math.min(a.position[0], b.position[0]) - 0.03
    const right = Math.max(a.position[0], b.position[0]) + 0.03
    const bottom = Math.min(a.position[1], b.position[1]) - (wire.slack ?? 0.12) - 0.03
    const top = Math.max(a.position[1], b.position[1]) + 0.03
    const faces = jacks.filter(
      (jack) =>
        jack.normal[2] > 0.9 &&
        jack.position[0] >= left &&
        jack.position[0] <= right &&
        jack.position[1] >= bottom &&
        jack.position[1] <= top,
    )
    const clearance = Math.max(start.exit.z, finish.exit.z, ...faces.map((jack) => jack.position[2])) + 0.024
    mainStart.z = clearance
    mainFinish.z = clearance
  }
  const points = clampCordPoints(cordPoints(mainStart.toArray(), mainFinish.toArray(), wire.slack ?? 0.12, 32), surface)
  const plug = (endpoint: ReturnType<typeof plugPosition>) =>
    new CylinderGeometry(0.004, 0.004, 0.007, 8).applyMatrix4(
      new Matrix4().compose(
        endpoint.point,
        new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), endpoint.normal),
        new Vector3(1, 1, 1),
      ),
    )
  const geometry = joinedGeometry([
    tube(points),
    tube([start.point.toArray(), start.exit.toArray(), mainStart.toArray()]),
    tube([mainFinish.toArray(), finish.exit.toArray(), finish.point.toArray()]),
    plug(start),
    plug(finish),
  ])
  if (wire.color === 'yellowGreen') {
    const green = new Color('rgb(38, 129, 72)')
    const yellow = new Color('rgb(236, 188, 29)')
    const uv = geometry.getAttribute('uv')
    const values: number[] = []
    for (let index = 0; index < uv.count; index++) {
      const color = Math.floor(uv.getX(index) * 16) % 2 === 0 ? green : yellow
      values.push(color.r, color.g, color.b)
    }
    geometry.setAttribute('color', new Float32BufferAttribute(values, 3))
  }
  return { geometry, midpoint: new Vector3(...(points[16] ?? points[0] ?? a.position)) }
}

export function draftCordGeometry(start: Point3, end: Point3, surface?: WorkSurface) {
  return tube(clampCordPoints(cordPoints(start, end, 0.08, 24), surface))
}

export { joinedGeometry }
