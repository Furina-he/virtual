import { describe, expect, it } from 'vitest'
import { type GltfDocument, inspectGlb, type ParsedGlb } from './glb.ts'

function triangle(componentType: 5121 | 5123 | 5125 = 5123) {
  const indexSize = componentType === 5121 ? 1 : componentType === 5123 ? 2 : 4
  const positions: NonNullable<GltfDocument['accessors']>[number] = {
    bufferView: 0,
    componentType: 5126,
    count: 3,
    type: 'VEC3',
  }
  const indices: NonNullable<GltfDocument['accessors']>[number] = {
    bufferView: 1,
    byteOffset: 4,
    componentType,
    count: 3,
    type: 'SCALAR',
  }
  const indexView: NonNullable<GltfDocument['bufferViews']>[number] = {
    buffer: 0,
    byteOffset: 40,
    byteLength: 4 + 3 * indexSize,
  }
  const primitive: NonNullable<GltfDocument['meshes']>[number]['primitives'][number] = {
    attributes: { POSITION: 0 },
    indices: 1,
  }
  const binary = Buffer.alloc(44 + 3 * indexSize)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => {
    binary.writeFloatLE(value, index * 4)
  })
  ;[0, 1, 2].forEach((value, index) => {
    binary.writeUIntLE(value, 44 + index * indexSize, indexSize)
  })
  const json: GltfDocument = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    accessors: [positions, indices],
    bufferViews: [{ buffer: 0, byteLength: 36 }, indexView],
    buffers: [{ byteLength: binary.length }],
  }
  const glb: ParsedGlb = { json, binary }
  return { glb, primitive, positions, indices, indexView, indexSize }
}

describe('GLB triangle indices', () => {
  it.each([5121, 5123, 5125] as const)('accepts unsigned index type %i with byte offsets', (componentType) => {
    const { glb } = triangle(componentType)
    expect(inspectGlb(glb)).toMatchObject({ triangles: 1, drawCalls: 1 })
  })

  it('continues to support non-indexed triangles', () => {
    const { glb, primitive } = triangle()
    delete primitive.indices
    expect(inspectGlb(glb)).toMatchObject({ triangles: 1, drawCalls: 1 })
  })

  it('rejects a nonexistent index accessor rather than counting zero triangles', () => {
    const { glb, primitive } = triangle()
    primitive.indices = 99
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
  })

  it.each([5120, 5122, 5126])('rejects non-unsigned index component type %i', (componentType) => {
    const { glb, indices } = triangle()
    indices.componentType = componentType
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
  })

  it('rejects non-scalar indices', () => {
    const { glb, indices } = triangle()
    indices.type = 'VEC3'
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
  })

  it('rejects normalized and sparse index accessors', () => {
    const { glb, indices } = triangle()
    indices.normalized = true
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
    indices.normalized = false
    indices.sparse = { count: 1 }
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
  })

  it.each([0, -3, 1.5, 4])('rejects an invalid triangle index count %s', (count) => {
    const { glb, indices } = triangle()
    indices.count = count
    expect(() => inspectGlb(glb)).toThrow(/index count/i)
  })

  it.each([-1, 0.5, 1, 6])('rejects an invalid or overflowing accessor byte offset %s', (byteOffset) => {
    const { glb, indices } = triangle()
    indices.byteOffset = byteOffset
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
  })

  it('rejects an index accessor extending beyond its buffer view', () => {
    const { glb, indices } = triangle()
    indices.count = 6
    expect(() => inspectGlb(glb)).toThrow('buffer view')
  })

  it('rejects a missing index buffer view', () => {
    const { glb, indices } = triangle()
    indices.bufferView = 99
    expect(() => inspectGlb(glb)).toThrow('buffer view')
  })

  it('rejects an index buffer view extending beyond the embedded binary', () => {
    const { glb, indexView } = triangle()
    indexView.byteLength += 2
    expect(() => inspectGlb(glb)).toThrow('embedded buffer')
  })

  it('rejects an index buffer view extending into undeclared GLB padding', () => {
    const { glb } = triangle()
    const buffer = glb.json.buffers?.[0]
    if (!buffer) throw new Error('Fixture needs a buffer')
    buffer.byteLength -= 2
    expect(() => inspectGlb(glb)).toThrow('embedded buffer')
  })

  it('rejects strided index data', () => {
    const { glb, indexView } = triangle()
    indexView.byteStride = 4
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
  })

  it('rejects a misaligned index buffer view', () => {
    const { glb, indexView } = triangle()
    indexView.byteOffset = 39
    expect(() => inspectGlb(glb)).toThrow('INDEX accessor')
  })

  it.each([5121, 5123, 5125] as const)('rejects out-of-range vertex indices for type %i', (componentType) => {
    const { glb, indexSize } = triangle(componentType)
    glb.binary.writeUIntLE(3, 44 + 2 * indexSize, indexSize)
    expect(() => inspectGlb(glb)).toThrow('vertex index 3')
  })

  it('rejects missing POSITION attributes and accessors', () => {
    const { glb, primitive } = triangle()
    delete primitive.attributes.POSITION
    expect(() => inspectGlb(glb)).toThrow('POSITION accessor')
    primitive.attributes.POSITION = 99
    expect(() => inspectGlb(glb)).toThrow('POSITION accessor')
  })

  it('requires a positive integer vertex count before validating indices', () => {
    const { glb, positions } = triangle()
    positions.count = 2.5
    expect(() => inspectGlb(glb)).toThrow('POSITION accessor')
  })
})
