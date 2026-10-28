import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { cloneQualityModel, scaledTextureSize } from './model-quality'

describe('3D quality resources', () => {
  it('resizes real panel dimensions without upscaling or changing aspect', () => {
    expect(scaledTextureSize(2048, 1024, 1536)).toEqual([1536, 768])
    expect(scaledTextureSize(2048, 128, 1024)).toEqual([1024, 64])
    expect(scaledTextureSize(512, 256, 1024)).toEqual([512, 256])
  })

  it('owns cloned materials and textures but preserves cached geometry and textures', () => {
    const source = new Group()
    const map = new Texture()
    const material = new MeshStandardMaterial({ map })
    const geometry = new BoxGeometry()
    const one = new Mesh(geometry, material)
    const two = new Mesh(geometry, material)
    source.add(one, two)
    const materialDisposed = vi.fn()
    const textureDisposed = vi.fn()
    material.addEventListener('dispose', materialDisposed)
    map.addEventListener('dispose', textureDisposed)
    const quality = cloneQualityModel(source, 'low')
    const clone = quality.model.children[0] as Mesh<BoxGeometry, MeshStandardMaterial>
    expect(clone.geometry).toBe(geometry)
    expect(clone.material).not.toBe(material)
    expect(clone.material.map).not.toBe(map)
    expect(clone.material.map?.source).not.toBe(map.source)
    expect((quality.model.children[1] as Mesh).material).toBe(clone.material)
    quality.dispose()
    expect(materialDisposed).not.toHaveBeenCalled()
    expect(textureDisposed).not.toHaveBeenCalled()
    expect(one.material).toBe(material)
    expect(one.material.map).toBe(map)
  })
})
