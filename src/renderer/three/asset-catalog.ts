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

/** Frontal close-up of one device: faces +Z (all panels face +Z, ADR-008) and fills the view with a small margin. */
export function focusView(box: { min: Vector3Like; max: Vector3Like }, aspect: number, margin = 0.08) {
  const size = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
  const [width = 0, height = 0, depth = 0] = size
  const target: Position = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2]
  const distance =
    (Math.max(height, width / aspect) * (1 + margin * 2)) / (2 * Math.tan((previewFov * Math.PI) / 360)) + depth / 2
  return { position: [target[0], target[1], target[2] + distance] as Position, target }
}

interface Vector3Like {
  x: number
  y: number
  z: number
}

export interface Box3Like {
  min: Vector3Like
  max: Vector3Like
}

export interface ActiveBenchBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
  width: number
  height: number
  depth: number
  center: Position
}

/**
 * 台面以上有效设备带（技术设计 §10.3，T1.9A / T1.9B 拖放全桌位视图）：
 * 实训台台面位于 Y = 0.80 m，以下为桌腿与抽屉；收紧视野至 Y ∈ [0.78 m, 1.56 m]
 * 使控制屏、仪表排、挂箱与桌面仪器占满画面，同时保持全部桌面安装位可见且挂箱密集插孔 < 14 px。
 */
export const WORK_AREA_BOUNDS = {
  minY: 0.78,
  maxY: 1.56,
  width: 1.78,
  height: 0.82,
  depth: 0.54,
  margin: 1.07,
  workTarget: [0, 1.13, -0.08] as Position,
  frontTarget: [0, 1.17, -0.08] as Position,
  workAzimuthRad: 0.18,
  workElevationRad: 0.16,
} as const

/**
 * 动态有效设备构图包围盒（技术设计 §10.3，T1.9B）：
 * 围绕当前挂载挂箱 + 控制屏电源 + 已放置台式表 + 已接线固定表的联合包围盒框取，
 * 始终裁除 Y < 0.78 m 桌腿区并维持最小物理跨度以守住挂箱密集插孔 < 14 px 单击特写契约。
 */
export function computeActiveBenchBounds(boxes: readonly Box3Like[]): ActiveBenchBounds | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  for (const box of boxes) {
    const vals = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]
    if (!vals.every(Number.isFinite)) continue
    minX = Math.min(minX, box.min.x)
    maxX = Math.max(maxX, box.max.x)
    minY = Math.min(minY, box.min.y)
    maxY = Math.max(maxY, box.max.y)
    minZ = Math.min(minZ, box.min.z)
    maxZ = Math.max(maxZ, box.max.z)
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null

  const clampedMinY = Math.max(WORK_AREA_BOUNDS.minY, minY)
  const clampedMaxY = Math.max(clampedMinY + 0.1, maxY)
  const padX = 0.06
  const padY = 0.06
  const paddedMinX = Math.max(-0.92, minX - padX)
  const paddedMaxX = Math.min(0.92, maxX + padX)
  const paddedMinY = Math.max(WORK_AREA_BOUNDS.minY, clampedMinY - padY)
  const paddedMaxY = Math.min(1.62, clampedMaxY + padY)

  const width = Math.max(0.84, Math.min(WORK_AREA_BOUNDS.width, paddedMaxX - paddedMinX))
  const height = Math.max(0.84, Math.min(0.88, paddedMaxY - paddedMinY))
  const depth = Math.max(0.48, Math.min(WORK_AREA_BOUNDS.depth, maxZ - minZ + 0.16))
  const centerY = Math.max(1.06, Math.min(1.22, (paddedMinY + paddedMaxY) / 2))

  return {
    minX: paddedMinX,
    maxX: paddedMaxX,
    minY: paddedMinY,
    maxY: paddedMaxY,
    minZ,
    maxZ,
    width,
    height,
    depth,
    center: [(paddedMinX + paddedMaxX) / 2, centerY, Math.max(-0.14, Math.min(0.05, (minZ + maxZ) / 2))],
  }
}

export function activeWorkView(bounds: ActiveBenchBounds, aspect: number) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0.2 ? aspect : 16 / 9
  const tanHalf = Math.tan((previewFov * Math.PI) / 360)
  const distance =
    Math.max(bounds.height / (2 * tanHalf), bounds.width / safeAspect / (2 * tanHalf)) * 1.1 + bounds.depth / 2
  const az = 0.12
  const el = 0.14
  const target = bounds.center
  return {
    position: [
      target[0] + distance * Math.sin(az) * Math.cos(el),
      target[1] + distance * Math.sin(el),
      target[2] + distance * Math.cos(az) * Math.cos(el),
    ] as Position,
    target,
  }
}

export function cameraView(preset: CameraPreset, aspect: number) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0.2 ? aspect : 16 / 9
  const tanHalf = Math.tan((previewFov * Math.PI) / 360)
  const fitDistance = (width: number, height: number, depth: number, margin: number) =>
    Math.max(height / (2 * tanHalf), width / safeAspect / (2 * tanHalf)) * margin + depth / 2

  if (preset === 'work') {
    const distance = fitDistance(
      WORK_AREA_BOUNDS.width,
      WORK_AREA_BOUNDS.height,
      WORK_AREA_BOUNDS.depth,
      WORK_AREA_BOUNDS.margin,
    )
    const { workTarget: target, workAzimuthRad: az, workElevationRad: el } = WORK_AREA_BOUNDS
    return {
      position: [
        target[0] + distance * Math.sin(az) * Math.cos(el),
        target[1] + distance * Math.sin(el),
        target[2] + distance * Math.cos(az) * Math.cos(el),
      ] as Position,
      target,
    }
  }
  if (preset === 'front') {
    const distance = fitDistance(WORK_AREA_BOUNDS.width, 0.78, WORK_AREA_BOUNDS.depth, 1.06)
    const target = WORK_AREA_BOUNDS.frontTarget
    return {
      position: [target[0], target[1], target[2] + distance] as Position,
      target,
    }
  }
  const topTarget: Position = [0, 0.86, 0.02]
  const topDistance = fitDistance(WORK_AREA_BOUNDS.width, 0.85, 0.4, 1.08)
  return {
    position: [topTarget[0], topTarget[1] + topDistance, topTarget[2] + 0.28] as Position,
    target: topTarget,
  }
}
