import { type Material, Mesh, type Object3D, Source, Texture } from 'three'
import { type Quality, qualityPreset } from './quality-store'

const textureSlots = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'bumpMap',
  'alphaMap',
] as const

export function scaledTextureSize(width: number, height: number, limit: number): [number, number] {
  const scale = Math.min(1, limit / Math.max(width, height))
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
}

/** Each quality instance owns its materials/textures, never the useGLTF cache's resources. */
export function cloneQualityModel(source: Object3D, quality: Quality) {
  const model = source.clone(true)
  const materials = new Map<Material, Material>()
  const textures = new Map<Texture, Texture>()
  const limit = qualityPreset(quality).textureSize
  let largestTexture = 0
  const cloneTexture = (sourceTexture: Texture) => {
    let texture = textures.get(sourceTexture)
    if (texture) return texture
    texture = sourceTexture.clone()
    texture.source = new Source(sourceTexture.image)
    const image = sourceTexture.image as CanvasImageSource & { width?: number; height?: number }
    if (image?.width && image.height) {
      const [width, height] = scaledTextureSize(image.width, image.height, limit)
      largestTexture = Math.max(largestTexture, width, height)
      if (width !== image.width || height !== image.height) {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Panel texture resizing requires Canvas 2D')
        context.drawImage(image, 0, 0, width, height)
        texture.image = canvas
      }
    }
    texture.needsUpdate = true
    textures.set(sourceTexture, texture)
    return texture
  }
  const cloneMaterial = (sourceMaterial: Material) => {
    const existing = materials.get(sourceMaterial)
    if (existing) return existing
    const material = sourceMaterial.clone()
    const maps = material as Material & Partial<Record<(typeof textureSlots)[number], Texture | null>>
    for (const key of textureSlots) {
      const texture = maps[key]
      if (texture instanceof Texture) maps[key] = cloneTexture(texture)
    }
    materials.set(sourceMaterial, material)
    return material
  }
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return
    node.material = Array.isArray(node.material) ? node.material.map(cloneMaterial) : cloneMaterial(node.material)
  })
  return {
    model,
    largestTexture,
    dispose: () => {
      for (const texture of textures.values()) texture.dispose()
      for (const material of materials.values()) material.dispose()
    },
  }
}
