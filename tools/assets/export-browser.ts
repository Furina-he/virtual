import {
  Box3,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { buildAsset } from './geometry.ts'
import { panelSvg } from './panels.ts'
import type { AssetDefinition } from './types.ts'

type ExportResult = { id: string; bounds: { min: number[]; max: number[] } }
type ExportStatus = { done: boolean; error?: string; results: ExportResult[] }
declare global {
  interface Window {
    assetExport: ExportStatus
  }
}

window.assetExport = { done: false, results: [] }

async function put(path: string, data: ArrayBuffer | Blob | string) {
  const response = await fetch(`/output?path=${encodeURIComponent(path)}`, { method: 'POST', body: data })
  if (!response.ok) throw new Error(`Cannot write ${path}: ${await response.text()}`)
}

async function makePanel(asset: AssetDefinition): Promise<CanvasTexture> {
  const css = await (await fetch(`/panel-font.css?asset=${encodeURIComponent(asset.id)}`)).text()
  const original = panelSvg(asset)
  // SVG images cannot fetch page fonts. Embed the locally bundled subsets in the SVG itself.
  const svg = original
    .replace(/(<svg\b[^>]*>)/, `$1<style>${css}</style>`)
    .replace(/font-family="[^"]+"/, 'font-family="Asset Panel Font"')
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const parsed = new DOMParser().parseFromString(original, 'image/svg+xml')
  const labels = [...parsed.querySelectorAll('text')]
  const text = labels.map((label) => label.textContent ?? '').join('')
  const weights = new Set(labels.map((label) => label.getAttribute('font-weight') ?? '500'))
  await Promise.all([...weights].map((weight) => document.fonts.load(`${weight} 16px "Asset Panel Font"`, text)))
  await document.fonts.ready
  for (const label of labels) label.remove()
  const image = new Image()
  const shapes = new XMLSerializer().serializeToString(parsed)
  const url = URL.createObjectURL(new Blob([shapes], { type: 'image/svg+xml' }))
  try {
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    ;[canvas.width, canvas.height] = asset.textureSize ?? [1024, 1024]
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is unavailable')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const viewBox = parsed.documentElement.getAttribute('viewBox')?.split(' ').map(Number)
    const width = viewBox?.[2]
    const height = viewBox?.[3]
    if (!width || !height) throw new Error('Panel SVG has no valid viewBox')
    context.save()
    context.scale(canvas.width / width, canvas.height / height)
    // SVG image decoding does not await every embedded font subset. Canvas text does, after fonts.load above.
    for (const label of labels) {
      context.font = `${label.getAttribute('font-weight') ?? 500} ${label.getAttribute('font-size')}px "Asset Panel Font"`
      context.fillStyle = label.getAttribute('fill') ?? 'black'
      const anchor = label.getAttribute('text-anchor')
      context.textAlign = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left'
      context.fillText(label.textContent ?? '', Number(label.getAttribute('x')), Number(label.getAttribute('y')))
    }
    context.restore()
    const webp = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('WebP encoding failed'))), 'image/webp', 0.92)
    })
    const base = asset.model.slice(0, asset.model.lastIndexOf('/'))
    await put(`${base}/panel.svg`, svg)
    await put(`${base}/panel.webp`, webp)
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.userData.mimeType = 'image/webp'
    return texture
  } finally {
    URL.revokeObjectURL(url)
    style.remove()
  }
}

async function importAsset(asset: AssetDefinition): Promise<Group> {
  const gltf = await new GLTFLoader().loadAsync(`/${asset.sourceFile}`)
  const source = gltf.scene
  // Reuse the CC0 mesh, not its certification marks. No albedo imagery is shipped.
  const steel = new Color('hsl(210, 5%, 57%)')
  const grip = new Color('hsl(12, 65%, 38%)')
  const material = new MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.58 })
  material.name = 'neutral-tool-material'
  source.traverse((node) => {
    if (!(node instanceof Mesh)) return
    const positions = node.geometry.getAttribute('position')
    const colors: number[] = []
    for (let i = 0; i < positions.count; i++) {
      const color = positions.getY(i) < -0.035 ? grip : steel
      colors.push(color.r, color.g, color.b)
    }
    node.geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
    node.material = material
  })
  const initial = new Box3().setFromObject(source)
  source.scale.setScalar(asset.dimensionsMm[1] / 1000 / initial.getSize(new Vector3()).y)
  source.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(source)
  const center = bounds.getCenter(new Vector3())
  source.position.set(-center.x, -bounds.min.y, -center.z)
  const root = new Group()
  root.name = asset.id
  root.userData = { assetId: asset.id, label: asset.name, unit: 'meter', front: '+Z', source: 'CC0-1.0' }
  root.add(source)
  return root
}

async function run() {
  const { assets }: { assets: AssetDefinition[] } = await (await fetch('/assets/layouts/catalog.json')).json()
  for (const asset of assets) {
    const texture = asset.kind !== 'component' && !asset.sourceFile ? await makePanel(asset) : undefined
    const object = asset.sourceFile ? await importAsset(asset) : buildAsset(asset, texture)
    const bounds = new Box3().setFromObject(object)
    const buffer = await new GLTFExporter().parseAsync(object, {
      binary: true,
      trs: true,
      maxTextureSize: asset.kind === 'component' ? 512 : 2048,
      copyright: asset.sourceFile
        ? 'PierreB3D / Poly Haven, CC0-1.0; modified neutral materials'
        : 'Project-authored asset',
    })
    if (!(buffer instanceof ArrayBuffer)) throw new Error(`Expected GLB binary for ${asset.id}`)
    await put(asset.model, buffer)
    window.assetExport.results.push({ id: asset.id, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() } })
  }
}

run()
  .catch((error: unknown) => {
    window.assetExport.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  })
  .finally(() => {
    window.assetExport.done = true
  })
