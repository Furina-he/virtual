import { z } from 'zod'
import catalogData from '../../../assets/layouts/catalog.json'
import sceneData from '../../../content/bench/scene.json'
import environmentUrl from '../../../resources/hdri/studio_small_09_1k.hdr?url'
import { BenchScene } from '../../shared/schema/scene'

export type Position = [number, number, number]
export type CameraPreset = 'work' | 'front' | 'top'
export const previewFov = 38

// The generated catalog is checked by assets:lint; Vite bundles every model locally.
const positionSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const assets = z
  .object({
    schemaVersion: z.literal(1),
    assets: z.array(
      z.object({ id: z.string(), name: z.string(), kind: z.string(), model: z.string(), dimensionsMm: positionSchema }),
    ),
  })
  .parse(catalogData)
export const catalog = { ...assets, preview: BenchScene.parse(sceneData) }
export const localEnvironment = environmentUrl
const modelUrls = import.meta.glob<string>('../../../content/**/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
})

export function previewAssets() {
  return assetsForPlacements(catalog.preview.placements)
}

export function assetsForPlacements(placements: readonly BenchScene['placements'][number][]) {
  return placements.map((placement) => {
    const asset = catalog.assets.find((entry) => entry.id === placement.assetId)
    const url = asset && modelUrls[`../../../${asset.model}`]
    if (!asset || !url) throw new Error(`Missing bundled preview asset: ${placement.assetId}`)
    return { ...placement, asset, url }
  })
}

export function cameraView(preset: CameraPreset, aspect: number) {
  const { position, target } = catalog.preview.camera
  const distance = Math.hypot(...position.map((value, axis) => value - (target[axis] ?? 0)))
  if (preset === 'front') {
    const bench = catalog.assets.find((asset) => asset.kind === 'bench')
    const placement = catalog.preview.placements.find((item) => item.assetId === bench?.id)
    if (bench && placement) {
      const [width, height, depth] = bench.dimensionsMm.map((value) => value / 1000) as Position
      const frontTarget: Position = [placement.position[0], placement.position[1] + height / 2, placement.position[2]]
      const fitDistance =
        (Math.max(height, width / aspect) / (2 * Math.tan((previewFov * Math.PI) / 360))) * 1.12 + depth / 2
      return {
        position: [frontTarget[0], frontTarget[1], frontTarget[2] + fitDistance] as Position,
        target: frontTarget,
      }
    }
  }
  const positions: Record<CameraPreset, Position> = {
    work: position,
    front: [target[0], target[1], target[2] + distance],
    top: [target[0], target[1] + distance, target[2] + 0.3],
  }
  return { position: positions[preset], target }
}
