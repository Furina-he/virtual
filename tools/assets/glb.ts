import { Box3, Matrix4, Quaternion, Vector3 } from 'three'

type Accessor = {
  bufferView?: number
  byteOffset?: number
  componentType: number
  count: number
  type: string
  normalized?: boolean
  sparse?: unknown
  min?: number[]
  max?: number[]
}
type GltfNode = {
  name?: string
  children?: number[]
  mesh?: number
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  matrix?: number[]
  extras?: Record<string, unknown>
}
export type GltfDocument = {
  asset: { version: string }
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: GltfNode[]
  meshes?: { primitives: { indices?: number; attributes: Record<string, number>; mode?: number }[] }[]
  accessors?: Accessor[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[]
  buffers?: { byteLength: number; uri?: string }[]
  images?: { uri?: string; mimeType?: string; bufferView?: number }[]
  extensionsRequired?: string[]
}
export type ParsedGlb = { json: GltfDocument; binary: Buffer }
export type AssetAnchor = { name: string; position: number[]; normal: number[] }
export type GlbInspection = {
  triangles: number
  drawCalls: number
  bounds: { min: number[]; max: number[] }
  anchors: AssetAnchor[]
  textures: { mimeType: string; width: number; height: number }[]
}

export function parseGlb(bytes: Buffer): ParsedGlb {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2) {
    throw new Error('Not a glTF 2.0 GLB')
  }
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error('GLB total byte length mismatch')
  let json: GltfDocument | undefined
  let binary: Buffer = Buffer.alloc(0)
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length) throw new Error('Truncated GLB chunk header')
    const length = bytes.readUInt32LE(offset)
    const type = bytes.readUInt32LE(offset + 4)
    if (length % 4 || offset + 8 + length > bytes.length) throw new Error('Invalid GLB chunk length')
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 0x4e4f534a) {
      if (json || offset !== 12) throw new Error('GLB must begin with a single JSON chunk')
      json = JSON.parse(body.toString('utf8').trim())
    } else if (type === 0x004e4942) {
      if (!json || binary.length) throw new Error('Invalid GLB binary chunk order')
      binary = body
    } else throw new Error('Unsupported GLB chunk')
    offset += 8 + length
  }
  if (json?.asset?.version !== '2.0') throw new Error('GLB JSON must declare glTF 2.0')
  return { json, binary }
}

export function webpSize(bytes: Buffer): [number, number] {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('Texture is not WebP')
  }
  const kind = bytes.toString('ascii', 12, 16)
  if (kind === 'VP8X' && bytes.length >= 30) return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
  if (kind === 'VP8 ' && bytes.length >= 30) return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
  if (kind === 'VP8L' && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  throw new Error('Unsupported WebP header')
}

function viewBytes(glb: ParsedGlb, index: number): Buffer {
  const view = glb.json.bufferViews?.[index]
  if (!Number.isSafeInteger(index) || index < 0 || view?.buffer !== 0) {
    throw new Error(`Missing embedded buffer view ${index}`)
  }
  const start = view.byteOffset ?? 0
  const declaredLength = glb.json.buffers?.[0]?.byteLength ?? 0
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(view.byteLength) ||
    start < 0 ||
    view.byteLength < 0 ||
    start + view.byteLength > Math.min(glb.binary.length, declaredLength)
  ) {
    throw new Error(`Buffer view ${index} exceeds embedded buffer`)
  }
  return glb.binary.subarray(start, start + view.byteLength)
}

function positionBounds(glb: ParsedGlb, index: number): Box3 {
  const accessor = glb.json.accessors?.[index]
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    accessor?.type !== 'VEC3' ||
    accessor.componentType !== 5126 ||
    accessor.bufferView === undefined
  ) {
    throw new Error(`Invalid POSITION accessor ${index}`)
  }
  const bytes = viewBytes(glb, accessor.bufferView)
  const stride = glb.json.bufferViews?.[accessor.bufferView]?.byteStride ?? 12
  const offset = accessor.byteOffset ?? 0
  if (
    !Number.isSafeInteger(accessor.count) ||
    !Number.isSafeInteger(stride) ||
    !Number.isSafeInteger(offset) ||
    accessor.count <= 0 ||
    stride < 12 ||
    offset < 0 ||
    offset + (accessor.count - 1) * stride + 12 > bytes.length
  ) {
    throw new Error(`POSITION accessor ${index} exceeds its buffer view`)
  }
  const bounds = new Box3()
  for (let i = 0; i < accessor.count; i++) {
    const start = offset + i * stride
    const xyz = [bytes.readFloatLE(start), bytes.readFloatLE(start + 4), bytes.readFloatLE(start + 8)]
    if (!xyz.every(Number.isFinite)) throw new Error(`Nonfinite POSITION in accessor ${index}`)
    bounds.expandByPoint(new Vector3().fromArray(xyz))
  }
  return bounds
}

function indexCount(glb: ParsedGlb, index: number, vertexCount: number): number {
  const accessor = glb.json.accessors?.[index]
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    accessor?.type !== 'SCALAR' ||
    accessor.bufferView === undefined ||
    accessor.normalized === true ||
    accessor.sparse !== undefined
  ) {
    throw new Error(`Invalid INDEX accessor ${index}`)
  }
  const size =
    accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : accessor.componentType === 5125 ? 4 : 0
  if (!size) throw new Error(`Invalid INDEX accessor ${index}: expected unsigned integer components`)
  if (!Number.isSafeInteger(accessor.count) || accessor.count <= 0 || accessor.count % 3) {
    throw new Error(`Invalid triangle index count in accessor ${index}`)
  }
  const bytes = viewBytes(glb, accessor.bufferView)
  const view = glb.json.bufferViews?.[accessor.bufferView]
  const offset = accessor.byteOffset ?? 0
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % size ||
    (view?.byteOffset ?? 0) % size ||
    view?.byteStride !== undefined
  ) {
    throw new Error(`Invalid INDEX accessor ${index}: indices must be aligned and tightly packed`)
  }
  if (offset + accessor.count * size > bytes.length) {
    throw new Error(`INDEX accessor ${index} exceeds its buffer view`)
  }
  for (let i = 0; i < accessor.count; i++) {
    const vertex = bytes.readUIntLE(offset + i * size, size)
    if (vertex >= vertexCount) throw new Error(`INDEX accessor ${index} has out-of-range vertex index ${vertex}`)
  }
  return accessor.count
}

export function inspectGlb(glb: ParsedGlb): GlbInspection {
  const { json } = glb
  const buffer = json.buffers?.[0]
  if (json.buffers?.length !== 1 || !buffer || buffer.uri) throw new Error('Only one embedded GLB buffer is allowed')
  if (buffer.byteLength > glb.binary.length) throw new Error('Declared buffer exceeds GLB binary')
  if (json.extensionsRequired?.some((extension) => extension !== 'EXT_texture_webp')) {
    throw new Error('GLB requires an unbundled compression decoder or unsupported extension')
  }
  const textures = (json.images ?? []).map((image) => {
    if (image.uri || image.bufferView === undefined) throw new Error('Texture must be embedded, not a file or URL')
    if (image.mimeType !== 'image/webp') throw new Error(`Texture must be WebP, found ${image.mimeType}`)
    const [width, height] = webpSize(viewBytes(glb, image.bufferView))
    return { mimeType: image.mimeType, width, height }
  })
  let triangles = 0
  let drawCalls = 0
  const bounds = new Box3()
  const anchors: AssetAnchor[] = []
  const visited = new Set<number>()
  function visit(index: number, parent: Matrix4) {
    if (visited.has(index)) throw new Error(`GLB scene reuses node ${index} or has a cycle`)
    visited.add(index)
    const node = json.nodes?.[index]
    if (!node) throw new Error(`Missing GLB node ${index}`)
    const local = node.matrix
      ? new Matrix4().fromArray(node.matrix)
      : new Matrix4().compose(
          new Vector3().fromArray(node.translation ?? [0, 0, 0]),
          new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
          new Vector3().fromArray(node.scale ?? [1, 1, 1]),
        )
    if (!local.elements.every(Number.isFinite)) throw new Error(`Nonfinite transform at node ${index}`)
    const world = parent.clone().multiply(local)
    if (/^(JACK|KNOB|SW|SCREEN|LED|LAMP|SLOT)_/.test(node.name ?? '')) {
      anchors.push({
        name: node.name ?? '',
        position: new Vector3().setFromMatrixPosition(world).toArray(),
        normal: new Vector3(0, 0, 1).transformDirection(world).toArray(),
      })
    }
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh]
      if (!mesh) throw new Error(`Missing mesh ${node.mesh}`)
      for (const primitive of mesh.primitives) {
        if ((primitive.mode ?? 4) !== 4) throw new Error('Only triangle primitives are supported')
        const position = primitive.attributes.POSITION
        if (position === undefined) throw new Error('Mesh has no POSITION accessor')
        const localBounds = positionBounds(glb, position)
        const vertexCount = json.accessors?.[position]?.count ?? 0
        const count = primitive.indices === undefined ? vertexCount : indexCount(glb, primitive.indices, vertexCount)
        if (count % 3) throw new Error('Triangle index count is not divisible by 3')
        triangles += count / 3
        drawCalls++
        bounds.union(localBounds.applyMatrix4(world))
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }
  const scene = json.scenes?.[json.scene ?? 0]
  if (!scene?.nodes?.length) throw new Error('GLB has no default scene')
  for (const node of scene.nodes) visit(node, new Matrix4())
  if (bounds.isEmpty()) throw new Error('GLB has no visible geometry')
  return { triangles, drawCalls, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, anchors, textures }
}
