import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { AssetDefinition } from './types.ts'

declare global {
  interface Window {
    assetGallery: { done: boolean; count: number; error?: string }
  }
}
window.assetGallery = { done: false, count: 0 }

async function run() {
  const assets: AssetDefinition[] = await (await fetch('/catalog.json')).json()
  const host = document.querySelector('main')
  if (!host) throw new Error('Gallery container is missing')
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(2)
  renderer.setSize(360, 224)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  const loader = new GLTFLoader()
  try {
    for (const asset of assets) {
      const { scene: model } = await loader.loadAsync(`/${asset.model}`)
      const bounds = new Box3().setFromObject(model)
      const center = bounds.getCenter(new Vector3())
      const radius = bounds.getSize(new Vector3()).length() * 0.6
      if (!Number.isFinite(radius) || radius <= 0) throw new Error(`Invalid bounds for ${asset.id}`)
      model.position.sub(center)
      const scene = new Scene()
      scene.background = new Color('hsl(210, 8%, 97%)')
      scene.add(model, new HemisphereLight('white', 'hsl(210, 12%, 48%)', 2.2))
      const key = new DirectionalLight('white', 3.5)
      key.position.set(2, 3, 4)
      scene.add(key)
      const camera = new OrthographicCamera(
        (-radius * 360) / 224,
        (radius * 360) / 224,
        radius,
        -radius,
        radius / 100,
        radius * 20,
      )
      camera.position
        .set(1.25, 0.95, 1.7)
        .normalize()
        .multiplyScalar(radius * 4)
      camera.lookAt(0, 0, 0)
      renderer.render(scene, camera)
      if (!renderer.info.render.calls || renderer.getContext().isContextLost()) {
        throw new Error(`WebGL did not render ${asset.id}`)
      }
      const figure = document.createElement('figure')
      const image = new Image()
      image.alt = asset.name
      image.src = renderer.domElement.toDataURL('image/png')
      await image.decode()
      const caption = document.createElement('figcaption')
      const name = document.createElement('strong')
      name.textContent = asset.name
      const id = document.createElement('code')
      id.textContent = asset.id
      const detail = document.createElement('small')
      detail.textContent = `${asset.dimensionsMm.join(' x ')} mm / ${asset.sourceFile ? 'CC0, Poly Haven' : 'Project-authored'}`
      caption.append(name, id, detail)
      figure.append(image, caption)
      host.append(figure)
      window.assetGallery.count++
      model.traverse((node) => {
        if (!(node instanceof Mesh)) return
        node.geometry.dispose()
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose()
      })
    }
    const labels = assets.map((asset) => asset.name).join('')
    await document.fonts.load('600 16px "Asset Panel Font"', labels)
    await document.fonts.ready
  } finally {
    renderer.dispose()
  }
}

run()
  .catch((error: unknown) => {
    window.assetGallery.error = error instanceof Error ? error.message : String(error)
  })
  .finally(() => {
    window.assetGallery.done = true
  })
