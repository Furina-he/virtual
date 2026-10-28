import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { AssetDefinition, ComponentStyle, ControlDefinition, JackColor, Vector3Tuple } from './types.ts'

const colors = {
  paint: 'hsl(207, 9%, 79%)',
  light: 'hsl(45, 18%, 94%)',
  frame: 'hsl(205, 15%, 30%)',
  dark: 'hsl(210, 11%, 16%)',
  rubber: 'hsl(210, 7%, 10%)',
  screen: 'hsl(173, 17%, 10%)',
  grid: 'hsl(174, 12%, 20%)',
  metal: 'hsl(205, 8%, 72%)',
  brass: 'hsl(42, 44%, 54%)',
  worktop: 'hsl(36, 17%, 64%)',
  blue: 'hsl(202, 43%, 40%)',
  red: 'hsl(2, 58%, 42%)',
  yellow: 'hsl(44, 67%, 54%)',
  green: 'hsl(152, 41%, 35%)',
  black: 'hsl(210, 7%, 10%)',
}

type Finish = 'paint' | 'metal'
const frontRotation: Vector3Tuple = [Math.PI / 2, 0, 0]

function jackColor(color: JackColor): string {
  return colors[color]
}

function roundedBox(width: number, height: number, depth: number, radius: number): THREE.BufferGeometry {
  const bevel = Math.min(radius / 4, depth / 6)
  const halfWidth = width / 2 - bevel
  const halfHeight = height / 2 - bevel
  const corner = Math.max(0.0001, Math.min(radius - bevel, halfWidth / 2, halfHeight / 2))
  const shape = new THREE.Shape()
  shape.moveTo(-halfWidth + corner, -halfHeight)
  shape.lineTo(halfWidth - corner, -halfHeight)
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + corner)
  shape.lineTo(halfWidth, halfHeight - corner)
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - corner, halfHeight)
  shape.lineTo(-halfWidth + corner, halfHeight)
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - corner)
  shape.lineTo(-halfWidth, -halfHeight + corner)
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + corner, -halfHeight)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    steps: 1,
    curveSegments: 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  })
  geometry.translate(0, 0, -depth / 2 + bevel)
  return geometry
}

class MeshBatch {
  private readonly geometries: Record<Finish, THREE.BufferGeometry[]> = { paint: [], metal: [] }

  add(
    source: THREE.BufferGeometry,
    color: string,
    position: Vector3Tuple = [0, 0, 0],
    rotation: Vector3Tuple = [0, 0, 0],
    finish: Finish = 'paint',
  ): void {
    const geometry = source.index ? source.toNonIndexed() : source
    if (geometry !== source) source.dispose()
    geometry.clearGroups()
    geometry.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
        new THREE.Vector3(1, 1, 1),
      ),
    )
    const tint = new THREE.Color(color)
    const count = geometry.getAttribute('position').count
    const values = new Float32Array(count * 3)
    for (let index = 0; index < count; index++) tint.toArray(values, index * 3)
    geometry.setAttribute('color', new THREE.BufferAttribute(values, 3))
    this.geometries[finish].push(geometry)
  }

  box(size: Vector3Tuple, position: Vector3Tuple, color: string, finish: Finish = 'paint'): void {
    this.add(new THREE.BoxGeometry(...size), color, position, [0, 0, 0], finish)
  }

  cylinder(
    radius: number,
    length: number,
    position: Vector3Tuple,
    color: string,
    rotation: Vector3Tuple = [0, 0, 0],
    finish: Finish = 'paint',
    segments = 12,
  ): void {
    this.add(new THREE.CylinderGeometry(radius, radius, length, segments), color, position, rotation, finish)
  }

  rod(a: Vector3Tuple, b: Vector3Tuple, radius: number, color = colors.metal, finish: Finish = 'metal'): void {
    const start = new THREE.Vector3(...a)
    const end = new THREE.Vector3(...b)
    const direction = end.clone().sub(start)
    const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), 8)
    geometry.applyMatrix4(
      new THREE.Matrix4().makeRotationFromQuaternion(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
      ),
    )
    this.add(geometry, color, start.add(end).multiplyScalar(0.5).toArray(), [0, 0, 0], finish)
  }

  finish(parent: THREE.Group, prefix = 'STATIC'): void {
    for (const finish of ['paint', 'metal'] as const) {
      const inputs = this.geometries[finish]
      if (inputs.length === 0) continue
      const geometry = mergeGeometries(inputs)
      if (!geometry) throw new Error(`Incompatible procedural geometry in ${parent.name}`)
      for (const input of inputs) input.dispose()
      const material = new THREE.MeshStandardMaterial({
        name: `${prefix}_${finish}`,
        vertexColors: true,
        roughness: finish === 'metal' ? 0.32 : 0.72,
        metalness: finish === 'metal' ? 0.72 : 0.035,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = `${prefix}_${finish}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData = { static: prefix === 'STATIC' }
      parent.add(mesh)
    }
  }
}

function anchor(root: THREE.Group, name: string, position: Vector3Tuple, data: Record<string, unknown>): THREE.Group {
  const group = new THREE.Group()
  group.name = name
  group.position.set(...position)
  group.userData = { ...data, normal: [0, 0, 1] }
  root.add(group)
  return group
}

function panelPosition(definition: AssetDefinition, x: number, y: number, offset = 0): Vector3Tuple {
  const [width, height, depth] = definition.dimensionsMm
  return [(x - width / 2) / 1000, (height - y) / 1000, depth / 2000 + offset]
}

function addPanel(root: THREE.Group, definition: AssetDefinition, texture?: THREE.Texture, bench = false): void {
  const [width, height, depth] = definition.dimensionsMm.map((value) => value / 1000) as Vector3Tuple
  const geometry = new THREE.PlaneGeometry(bench ? width - 0.12 : width - 0.004, bench ? 0.074 : height - 0.004)
  if (!bench) {
    // Crop the edge of the texture without moving the millimeter-registered silkscreen.
    const uv = geometry.getAttribute('uv')
    for (let index = 0; index < uv.count; index++) {
      uv.setXY(
        index,
        (uv.getX(index) * (width - 0.004) + 0.002) / width,
        (uv.getY(index) * (height - 0.004) + 0.002) / height,
      )
    }
  }
  if (texture) texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshStandardMaterial({
    name: 'PANEL_silkscreen',
    color: texture ? 'white' : colors.light,
    map: texture ?? null,
    roughness: 0.82,
    metalness: 0.03,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'PANEL_silkscreen'
  mesh.position.set(0, bench ? 1.545 : height / 2, bench ? -0.201 : depth / 2 + 0.0003)
  mesh.receiveShadow = true
  root.add(mesh)
}

function screw(batch: MeshBatch, x: number, y: number, z: number, radius = 0.0015): void {
  batch.cylinder(radius, 0.0007, [x, y, z], colors.metal, frontRotation, 'metal', 8)
  batch.box([radius * 1.3, radius * 0.2, 0.0001], [x, y, z + 0.0004], colors.dark)
}

function addHousing(batch: MeshBatch, definition: AssetDefinition): void {
  const [width, height, depth] = definition.dimensionsMm.map((value) => value / 1000) as Vector3Tuple
  const handheld = definition.bodyStyle === 'handheld'
  const module = definition.bodyStyle === 'module'
  const fixed = definition.mounting === 'fixed'
  const radius = Math.min(width * 0.06, height * 0.07, 0.012)
  batch.add(roundedBox(width, height, depth, radius), handheld ? colors.frame : colors.paint, [0, height / 2, 0])
  batch.add(roundedBox(width - 0.002, height - 0.002, 0.004, radius * 0.65), module ? colors.blue : colors.dark, [
    0,
    height / 2,
    depth / 2 - 0.0025,
  ])
  if (handheld) {
    for (const sign of [-1, 1]) {
      for (let index = 0; index < 8; index++) {
        batch.box(
          [0.004, 0.0018, depth * 0.5],
          [sign * (width / 2 - 0.0015), height * 0.38 + index * 0.005, 0],
          colors.rubber,
        )
      }
    }
    batch.add(roundedBox(width * 0.64, height * 0.33, 0.006, 0.003), colors.dark, [
      0,
      height * 0.36,
      -depth / 2 + 0.002,
    ])
  } else if (!fixed && !module) {
    for (const x of [-width * 0.37, width * 0.37]) {
      for (const z of [-depth * 0.31, depth * 0.31]) {
        batch.add(roundedBox(0.022, 0.008, 0.026, 0.003), colors.rubber, [x, 0.004, z])
      }
    }
    for (let index = 0; index < 11; index++) {
      batch.box(
        [0.0025, 0.0005, depth * 0.38],
        [-width * 0.3 + index * width * 0.06, height - 0.0002, -depth * 0.13],
        colors.dark,
      )
    }
    batch.box([width * 0.58, 0.012, 0.009], [0, height - 0.01, -depth / 2 + 0.001], colors.dark)
  }
  for (const x of [-width / 2 + 0.007, width / 2 - 0.007]) {
    for (const y of [0.007, height - 0.007]) screw(batch, x, y, depth / 2 + 0.0007)
  }
  if (module) {
    for (const x of [-width * 0.32, width * 0.32]) {
      batch.box([0.036, 0.006, 0.012], [x, height - 0.01, -depth / 2 + 0.003], colors.metal, 'metal')
    }
  }
}

function addJacks(root: THREE.Group, batch: MeshBatch, definition: AssetDefinition): void {
  for (const jack of definition.jacks) {
    const position = panelPosition(definition, jack.x, jack.y, 0.001)
    const bnc = jack.kind === 'bnc'
    const radius = bnc ? 0.005 : 0.0045
    const innerRadius = bnc ? 0.0027 : 0.002
    const length = bnc ? 0.006 : 0.003
    const profile = [
      new THREE.Vector2(innerRadius, 0),
      new THREE.Vector2(innerRadius, length),
      new THREE.Vector2(radius - 0.0006, length),
      new THREE.Vector2(radius, length - 0.0006),
      new THREE.Vector2(radius, 0),
      new THREE.Vector2(innerRadius, 0),
    ]
    batch.add(
      new THREE.LatheGeometry(profile, 12),
      bnc ? colors.metal : jackColor(jack.color),
      position,
      frontRotation,
      bnc ? 'metal' : 'paint',
    )
    batch.add(new THREE.CircleGeometry(innerRadius * 0.95, 12), colors.rubber, [
      position[0],
      position[1],
      position[2] + 0.0001,
    ])
    batch.add(
      new THREE.RingGeometry(innerRadius, innerRadius + 0.00035, 12),
      colors.metal,
      [position[0], position[1], position[2] + length + 0.00005],
      [0, 0, 0],
      'metal',
    )
    if (bnc) {
      batch.cylinder(
        0.0006,
        0.002,
        [position[0], position[1], position[2] + 0.002],
        colors.brass,
        frontRotation,
        'metal',
        8,
      )
      for (const sign of [-1, 1]) {
        batch.box(
          [0.002, 0.0015, 0.002],
          [position[0] + sign * 0.0047, position[1], position[2] + 0.003],
          colors.metal,
          'metal',
        )
      }
    }
    anchor(root, `JACK_${jack.id}`, [position[0], position[1], position[2] + length], {
      id: jack.id,
      label: jack.label,
      kind: jack.kind ?? 'banana4',
      color: jack.color,
    })
  }
}

function addControl(
  root: THREE.Group,
  batch: MeshBatch,
  definition: AssetDefinition,
  control: ControlDefinition,
): void {
  const radius = (control.radiusMm ?? (control.kind === 'knob' ? 8 : 4)) / 1000
  const position = panelPosition(definition, control.x, control.y, 0.0015)
  const group = anchor(root, `${control.kind === 'knob' ? 'KNOB' : 'SW'}_${control.id}`, position, {
    id: control.id,
    label: control.label,
    kind: control.kind,
    ...(control.param ? { param: control.param } : {}),
  })
  const moving = new MeshBatch()
  if (control.kind === 'knob') {
    const depth = Math.min(radius * 0.85, 0.012)
    batch.add(new THREE.RingGeometry(radius, radius + 0.0014, 20), colors.metal, position, [0, 0, 0], 'metal')
    moving.add(
      new THREE.CylinderGeometry(radius * 0.88, radius, depth, 20),
      colors.dark,
      [0, 0, depth / 2],
      frontRotation,
    )
    moving.cylinder(radius * 0.74, 0.0007, [0, 0, depth + 0.0001], colors.frame, frontRotation, 'paint', 20)
    for (let index = 0; index < 16; index++) {
      const angle = (index / 16) * Math.PI * 2
      moving.add(
        new THREE.BoxGeometry(radius * 0.08, radius * 0.2, depth * 0.75),
        colors.rubber,
        [Math.sin(angle) * radius * 0.94, Math.cos(angle) * radius * 0.94, depth / 2],
        [0, 0, -angle],
      )
    }
    moving.box(
      [Math.max(0.0006, radius * 0.075), radius * 0.42, 0.00025],
      [0, radius * 0.47, depth + 0.00065],
      colors.light,
    )
  } else if (control.shape === 'push') {
    batch.add(roundedBox(radius * 2.4, radius * 1.65, 0.0015, radius * 0.35), colors.dark, position)
    moving.add(roundedBox(radius * 2, radius * 1.28, 0.002, radius * 0.3), colors.frame, [0, 0, 0.0012])
    moving.box([radius * 0.62, 0.00045, 0.0002], [0, 0, 0.0023], colors.light)
  } else {
    batch.cylinder(radius, 0.0015, position, colors.metal, frontRotation, 'metal')
    moving.cylinder(radius * 0.5, 0.002, [0, 0, 0.0018], colors.dark, frontRotation)
    moving.rod([0, 0, 0.002], [0, 0.0025, 0.01], 0.001, colors.metal, 'paint')
    moving.add(roundedBox(0.0036, 0.004, 0.005, 0.001), colors.dark, [0, 0.0025, 0.0098])
  }
  moving.finish(group, `MOVING_${control.id}`)
}

function addScreensAndLeds(root: THREE.Group, batch: MeshBatch, definition: AssetDefinition): void {
  for (const screen of definition.screens) {
    const width = screen.width / 1000
    const height = screen.height / 1000
    const position = panelPosition(definition, screen.x, screen.y, 0.002)
    batch.add(roundedBox(width + 0.005, height + 0.005, 0.0025, 0.002), colors.dark, position)
    const group = anchor(root, `SCREEN_${screen.id}`, [position[0], position[1], position[2] + 0.0014], {
      id: screen.id,
      label: screen.id,
      kind: 'screen',
      width,
      height,
      powered: false,
    })
    const material = new THREE.MeshStandardMaterial({
      name: `DISPLAY_${screen.id}`,
      color: colors.screen,
      roughness: 0.42,
      metalness: 0.12,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
    mesh.name = `DISPLAY_${screen.id}`
    mesh.userData = { dynamicTextureTarget: true, powered: false }
    group.add(mesh)
    if (screen.style === 'grid') {
      const grid = new MeshBatch()
      for (let index = 1; index < 10; index++) {
        grid.box([0.00022, height, 0.00005], [-width / 2 + (width * index) / 10, 0, 0.00008], colors.grid)
      }
      for (let index = 1; index < 8; index++) {
        grid.box([width, 0.00022, 0.00005], [0, -height / 2 + (height * index) / 8, 0.00008], colors.grid)
      }
      grid.finish(group, `UNPOWERED_GRID_${screen.id}`)
    }
  }
  for (const led of definition.leds ?? []) {
    const position = panelPosition(definition, led.x, led.y, 0.002)
    batch.cylinder(0.002, 0.001, position, colors.dark, frontRotation)
    const group = anchor(root, `LED_${led.id}`, [position[0], position[1], position[2] + 0.0006], {
      id: led.id,
      label: led.label,
      kind: 'led',
      powered: false,
    })
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.0014, 8, 4),
      new THREE.MeshStandardMaterial({
        name: `LENS_${led.id}`,
        color: jackColor(led.color),
        emissive: jackColor(led.color),
        emissiveIntensity: 0,
        roughness: 0.38,
      }),
    )
    mesh.name = `LENS_${led.id}`
    mesh.scale.z = 0.45
    group.add(mesh)
  }
}

function addBench(root: THREE.Group, batch: MeshBatch, definition: AssetDefinition, texture?: THREE.Texture): void {
  for (const x of [-0.785, 0.785]) {
    for (const z of [-0.275, 0.275]) {
      batch.box([0.055, 0.748, 0.055], [x, 0.4, z], colors.frame)
      batch.add(roundedBox(0.068, 0.038, 0.068, 0.006), colors.rubber, [x, 0.019, z])
    }
    batch.box([0.047, 0.06, 0.58], [x, 0.17, 0], colors.frame)
    batch.box([0.043, 0.057, 0.67], [x, 0.743, 0], colors.frame)
  }
  batch.box([1.58, 0.07, 0.035], [0, 0.705, -0.29], colors.frame)
  batch.box([1.58, 0.044, 0.035], [0, 0.195, -0.285], colors.frame)
  batch.box([1.77, 0.045, 0.72], [0, 0.7585, 0], colors.frame)
  batch.add(roundedBox(1.8, 0.035, 0.75, 0.009), colors.worktop, [0, 0.7825, 0])
  batch.box([1.773, 0.007, 0.004], [0, 0.777, 0.374], colors.light)
  for (const x of [-0.59, 0.59]) {
    batch.add(roundedBox(0.355, 0.164, 0.58, 0.006), colors.paint, [x, 0.659, -0.008])
    batch.box([0.337, 0.138, 0.009], [x, 0.662, 0.285], colors.light)
    batch.box([0.108, 0.01, 0.015], [x, 0.694, 0.302], colors.metal, 'metal')
    for (const side of [-1, 1]) {
      batch.box([0.008, 0.015, 0.02], [x + side * 0.05, 0.69, 0.298], colors.metal, 'metal')
    }
    batch.cylinder(0.004, 0.002, [x + 0.123, 0.698, 0.292], colors.metal, frontRotation, 'metal')
  }
  for (const x of [-0.85, 0.85]) {
    batch.add(roundedBox(0.047, 0.79, 0.16, 0.005), colors.frame, [x, 1.195, -0.29])
  }
  batch.box([1.69, 0.708, 0.036], [0, 1.19, -0.333], colors.paint)
  batch.box([1.695, 0.088, 0.128], [0, 1.552, -0.269], colors.frame)
  batch.box([0.478, 0.666, 0.023], [-0.612, 1.156, -0.241], colors.light)
  batch.box([0.023, 0.697, 0.081], [-0.361, 1.174, -0.268], colors.frame)
  batch.box([1.177, 0.483, 0.005], [0.238, 1.106, -0.308], colors.frame)
  batch.box([1.177, 0.142, 0.017], [0.238, 1.44, -0.234], colors.light)
  for (const y of [0.848, 1.353]) {
    batch.box([1.176, 0.017, 0.056], [0.238, y, -0.244], colors.metal, 'metal')
    batch.box([1.176, 0.005, 0.006], [0.238, y + 0.007, -0.213], colors.dark)
    for (let index = 0; index < 8; index++) screw(batch, -0.298 + index * 0.152, y, -0.214, 0.002)
  }
  for (let index = 0; index < 12; index++) {
    batch.box([0.004, 0.025, 0.0005], [-0.765 + index * 0.027, 0.913, -0.229], colors.dark)
  }
  addPanel(root, definition, texture, true)
  for (const slot of definition.slots ?? []) {
    anchor(root, slot.id, slot.position, { id: slot.id, label: slot.id, kind: 'slot', mounting: slot.kind })
  }
}

function axial(batch: MeshBatch, diode: boolean): void {
  const radius = diode ? 0.0018 : 0.0016
  const length = diode ? 0.006 : 0.008
  const y = radius
  batch.cylinder(radius, length, [0, y, 0], diode ? colors.dark : 'hsl(40, 39%, 65%)', [0, 0, Math.PI / 2])
  batch.rod([-0.012, y, 0], [-length / 2, y, 0], 0.00032)
  batch.rod([length / 2, y, 0], [0.012, y, 0], 0.00032)
  const stripes = diode
    ? [{ x: 0.0019, color: colors.light, width: 0.0008 }]
    : [
        { x: -0.0026, color: 'hsl(28, 62%, 24%)', width: 0.00055 },
        { x: -0.0011, color: colors.black, width: 0.00055 },
        { x: 0.0005, color: colors.red, width: 0.00055 },
        { x: 0.0026, color: colors.brass, width: 0.00055 },
      ]
  for (const stripe of stripes) {
    batch.cylinder(radius + 0.00004, stripe.width, [stripe.x, y, 0], stripe.color, [0, 0, Math.PI / 2])
  }
}

function addComponent(batch: MeshBatch, style: ComponentStyle): void {
  switch (style) {
    case 'resistor':
    case 'diode':
      axial(batch, style === 'diode')
      break
    case 'ceramic-capacitor': {
      const geometry = new THREE.SphereGeometry(0.0035, 12, 8)
      geometry.scale(1, 1, 0.38)
      batch.add(geometry, 'hsl(25, 58%, 48%)', [0, 0.0095, 0])
      for (const x of [-0.0015, 0.0015]) batch.rod([x, 0, 0], [x, 0.0076, 0], 0.00027)
      break
    }
    case 'electrolytic-capacitor':
      batch.cylinder(0.004, 0.0107, [0, 0.0115, 0], colors.blue)
      batch.cylinder(0.0038, 0.0005, [0, 0.017, 0], colors.metal, [0, 0, 0], 'metal')
      batch.cylinder(0.004, 0.0008, [0, 0.0061, 0], colors.rubber)
      batch.box([0.0013, 0.0101, 0.0002], [0.001, 0.01155, 0.00382], colors.light)
      batch.box([0.0058, 0.0001, 0.00022], [0, 0.01728, 0], colors.dark)
      batch.box([0.00022, 0.0001, 0.0058], [0, 0.01728, 0], colors.dark)
      for (const x of [-0.00125, 0.00125]) batch.rod([x, 0, 0], [x, 0.006, 0], 0.00028)
      break
    case 'led':
      batch.cylinder(0.0024, 0.0045, [0, 0.0103, 0], colors.red)
      batch.add(new THREE.SphereGeometry(0.0024, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), colors.red, [0, 0.01255, 0])
      batch.cylinder(0.0029, 0.0007, [0, 0.008, 0], colors.red)
      for (const x of [-0.00125, 0.00125]) batch.rod([x, 0, 0], [x, 0.008, 0], 0.0003)
      break
    case 'transistor-to92': {
      const shape = new THREE.Shape()
      shape.moveTo(-0.0025, -0.0011)
      shape.lineTo(0.0025, -0.0011)
      shape.lineTo(0.0025, 0)
      shape.absarc(0, 0, 0.0025, 0, Math.PI, false)
      shape.lineTo(-0.0025, -0.0011)
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.0048, bevelEnabled: false, curveSegments: 4 })
      batch.add(geometry, colors.dark, [0, 0.007, 0], [-Math.PI / 2, 0, 0])
      for (const x of [-0.00127, 0, 0.00127]) batch.rod([x, 0, 0], [x, 0.0075, 0], 0.00025)
      break
    }
    case 'potentiometer':
      batch.cylinder(0.0085, 0.007, [0, 0.01, 0], colors.metal, [0, 0, 0], 'metal', 16)
      batch.cylinder(0.0076, 0.0018, [0, 0.0056, 0], colors.dark, [0, 0, 0], 'paint', 16)
      batch.cylinder(0.004, 0.004, [0, 0.015, 0], colors.metal, [0, 0, 0], 'metal')
      batch.cylinder(0.003, 0.012, [0, 0.023, 0], colors.metal, [0, 0, 0], 'metal', 10)
      batch.box([0.00035, 0.0002, 0.0038], [0, 0.0291, 0], colors.dark)
      for (const x of [-0.005, 0, 0.005]) batch.box([0.0016, 0.006, 0.0005], [x, 0.003, 0.005], colors.brass, 'metal')
      break
    case 'toggle-switch':
      batch.add(roundedBox(0.0105, 0.009, 0.008, 0.0009), colors.dark, [0, 0.0085, 0])
      batch.box([0.013, 0.001, 0.009], [0, 0.013, 0], colors.metal, 'metal')
      batch.cylinder(0.0033, 0.003, [0, 0.015, 0], colors.metal, [0, 0, 0], 'metal')
      batch.rod([0, 0.0155, 0], [0, 0.023, 0.002], 0.0011)
      batch.add(roundedBox(0.0035, 0.0045, 0.0035, 0.0008), colors.dark, [0, 0.024, 0.002])
      for (const x of [-0.004, 0, 0.004]) batch.box([0.001, 0.005, 0.0005], [x, 0.0025, 0], colors.brass, 'metal')
      break
    case 'dip8':
      batch.add(roundedBox(0.0105, 0.0032, 0.0066, 0.0006), colors.dark, [0, 0.0044, 0])
      for (const x of [-0.00381, -0.00127, 0.00127, 0.00381]) {
        for (const sign of [-1, 1]) {
          batch.rod([x, 0, sign * 0.0048], [x, 0.002, sign * 0.0048], 0.00023)
          batch.rod([x, 0.002, sign * 0.0048], [x, 0.0036, sign * 0.0031], 0.00023)
        }
      }
      batch.add(new THREE.CircleGeometry(0.0005, 8), colors.paint, [-0.0037, 0.00605, 0.002], [-Math.PI / 2, 0, 0])
      batch.box([0.0005, 0.0001, 0.002], [-0.005, 0.00605, 0], colors.rubber)
      break
    case 'banana-jack': {
      batch.cylinder(0.0032, 0.016, [0, 0.0055, -0.004], colors.metal, frontRotation, 'metal')
      const profile = [
        new THREE.Vector2(0.002, 0),
        new THREE.Vector2(0.002, 0.008),
        new THREE.Vector2(0.0049, 0.008),
        new THREE.Vector2(0.0055, 0.007),
        new THREE.Vector2(0.0055, 0),
        new THREE.Vector2(0.002, 0),
      ]
      batch.add(new THREE.LatheGeometry(profile, 16), colors.red, [0, 0.0055, 0.004], frontRotation)
      batch.add(new THREE.CircleGeometry(0.00195, 16), colors.rubber, [0, 0.0055, 0.0041])
      batch.add(new THREE.RingGeometry(0.002, 0.0024, 16), colors.metal, [0, 0.0055, 0.0121], [0, 0, 0], 'metal')
      for (let index = 0; index < 5; index++) {
        batch.cylinder(0.00355, 0.0006, [0, 0.0055, -0.009 + index * 0.0015], colors.metal, frontRotation, 'metal')
      }
      break
    }
  }
}

function fitComponent(root: THREE.Group, dimensions: Vector3Tuple): void {
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  const size = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  const scale = new THREE.Vector3(
    dimensions[0] / 1000 / size.x,
    dimensions[1] / 1000 / size.y,
    dimensions[2] / 1000 / size.z,
  )
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.translate(-center.x, -bounds.min.y, -center.z)
      node.geometry.scale(scale.x, scale.y, scale.z)
    }
  })
}

export function buildAsset(definition: AssetDefinition, panelTexture?: THREE.Texture): THREE.Group {
  if (definition.sourceFile) throw new Error(`External asset ${definition.id} must use its source-file importer`)
  const root = new THREE.Group()
  root.name = definition.id
  root.userData = {
    assetId: definition.id,
    name: definition.name,
    kind: definition.kind,
    units: 'meters',
    front: '+Z',
    origin: 'bottom-installation-center',
    dimensionsMm: definition.dimensionsMm,
    estimatedDimensions: definition.estimatedDimensions,
    ...(definition.mounting ? { mounting: definition.mounting } : {}),
  }
  const batch = new MeshBatch()
  if (definition.bodyStyle === 'bench') {
    addBench(root, batch, definition, panelTexture)
  } else if (definition.bodyStyle === 'component') {
    if (!definition.componentStyle) throw new Error(`Missing component style for ${definition.id}`)
    addComponent(batch, definition.componentStyle)
  } else {
    addHousing(batch, definition)
    addPanel(root, definition, panelTexture)
    addJacks(root, batch, definition)
    for (const control of definition.controls) addControl(root, batch, definition, control)
    addScreensAndLeds(root, batch, definition)
  }
  batch.finish(root)
  if (definition.bodyStyle === 'component') fitComponent(root, definition.dimensionsMm)
  root.updateMatrixWorld(true)
  return root
}
