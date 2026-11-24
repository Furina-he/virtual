import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import catalogData from '../../../assets/layouts/catalog.json'
import sceneData from '../../../content/bench/scene.json'
import { activeWorkView, cameraView, computeActiveBenchBounds, previewFov, WORK_AREA_BOUNDS } from './asset-catalog'

type LayoutEntry = {
  id: string
  dimensionsMm: [number, number, number]
  slots?: Array<{ id: string; position: [number, number, number]; kind: string }>
  jacks?: Array<{ id: string; x: number; y: number }>
}

const assets = catalogData.assets as unknown as LayoutEntry[]
const benchLayout = assets.find((entry) => entry.id === 'bench')
const dcModuleLayout = assets.find((entry) => entry.id === 'mod-dc-circuit')
const dcPlacement = sceneData.placements.find((entry) => entry.assetId === 'mod-dc-circuit')

function buildCamera(preset: 'work' | 'front' | 'top', width: number, height: number) {
  const aspect = width / height
  const view = cameraView(preset, aspect)
  const camera = new THREE.PerspectiveCamera(previewFov, aspect, 0.05, 40)
  camera.position.set(...view.position)
  camera.lookAt(...view.target)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  return { camera, view }
}

function projectPoint(camera: THREE.PerspectiveCamera, pos: [number, number, number], width: number, height: number) {
  const projected = new THREE.Vector3(...pos).project(camera)
  return {
    x: (projected.x * 0.5 + 0.5) * width,
    y: (-projected.y * 0.5 + 0.5) * height,
    ndcX: projected.x,
    ndcY: projected.y,
    ndcZ: projected.z,
    visible:
      projected.z >= -1 &&
      projected.z <= 1 &&
      projected.x >= -1 &&
      projected.x <= 1 &&
      projected.y >= -1 &&
      projected.y <= 1,
  }
}

describe('T1.9A BEN-06 tightened bench work-area framing', () => {
  it('targets the upper work-area band Y ∈ [0.78 m, 1.56 m] and crops table legs below the worktop', () => {
    expect(WORK_AREA_BOUNDS.minY).toBe(0.78)
    expect(WORK_AREA_BOUNDS.maxY).toBe(1.56)
    expect(sceneData.camera.target).toEqual(WORK_AREA_BOUNDS.workTarget)

    for (const [width, height] of [
      [840, 460],
      [920, 480],
      [1400, 740],
    ] as const) {
      const { camera } = buildCamera('work', width, height)
      const upperInstruments = projectPoint(camera, [0, 1.48, -0.27], width, height)
      const worktopFront = projectPoint(camera, [0, 0.8, 0.15], width, height)
      const legBottom = projectPoint(camera, [0, 0.15, 0.2], width, height)
      expect(upperInstruments.visible).toBe(true)
      expect(worktopFront.visible).toBe(true)
      // 桌腿底部处于视锥下方之外，不再占满画面下半部
      expect(legBottom.ndcY).toBeLessThan(-1)
    }
  })

  it('keeps all desktop placement slots visible in work view across 1366/1440 workbench viewports', () => {
    const desktopSlots = (benchLayout?.slots ?? []).filter((slot) => slot.kind === 'desktop')
    expect(desktopSlots.map((slot) => slot.id)).toEqual(
      expect.arrayContaining(['SLOT_DESK_1', 'SLOT_DESK_2', 'SLOT_DESK_3', 'SLOT_DESK_4', 'SLOT_SCOPE']),
    )

    for (const [width, height] of [
      [780, 440],
      [900, 470],
      [1340, 700],
      [1420, 760],
    ] as const) {
      const { camera } = buildCamera('work', width, height)
      for (const slot of desktopSlots) {
        const projected = projectPoint(camera, slot.position, width, height)
        expect(projected.visible, `${slot.id} should be visible at ${width}x${height}`).toBe(true)
      }
    }
  })

  it('keeps dense mod-dc-circuit jack spacing below 14 px in work view so click-to-focus contract holds', () => {
    expect(dcPlacement).toBeDefined()
    expect(dcModuleLayout).toBeDefined()
    const jacks = dcModuleLayout?.jacks ?? []
    expect(jacks.length).toBeGreaterThan(10)
    const [ox = 0, oy = 0, oz = 0] = dcPlacement?.position ?? []
    const [widthMm, heightMm, depthMm] = dcModuleLayout?.dimensionsMm ?? [290, 470, 90]

    for (const [width, height] of [
      [780, 440],
      [900, 470],
      [1340, 700],
    ] as const) {
      const { camera } = buildCamera('work', width, height)
      const screenPts = jacks.map((jack) =>
        projectPoint(
          camera,
          [ox + (jack.x - widthMm / 2) / 1000, oy + (heightMm - jack.y) / 1000, oz + depthMm / 2000],
          width,
          height,
        ),
      )
      let minDist = Number.POSITIVE_INFINITY
      for (let i = 0; i < screenPts.length; i++) {
        for (let j = i + 1; j < screenPts.length; j++) {
          const a = screenPts[i]
          const b = screenPts[j]
          if (!a || !b) continue
          const dist = Math.hypot(a.x - b.x, a.y - b.y)
          if (dist < minDist) minDist = dist
        }
      }
      expect(minDist).toBeLessThan(14)
    }
  })

  it('produces valid finite front and top camera views for narrow and wide aspects', () => {
    for (const preset of ['work', 'front', 'top'] as const) {
      for (const aspect of [0.1, Number.NaN, 1.2, 16 / 9, 2.5]) {
        const view = cameraView(preset, aspect)
        expect(view.position.every(Number.isFinite)).toBe(true)
        expect(view.target.every(Number.isFinite)).toBe(true)
      }
    }
  })
})

function placementBox(assetId: string) {
  const layout = assets.find((entry) => entry.id === assetId)
  const placement = sceneData.placements.find((entry) => entry.assetId === assetId)
  if (!layout || !placement) throw new Error(`Missing placement for ${assetId}`)
  const [wMm, hMm, dMm] = layout.dimensionsMm
  const [x = 0, y = 0, z = 0] = placement.position
  return {
    min: { x: x - wMm / 2000, y, z: z - dMm / 2000 },
    max: { x: x + wMm / 2000, y: y + hMm / 1000, z: z + dMm / 2000 },
  }
}

describe('T1.9B computeActiveBenchBounds dynamic active-device framing', () => {
  it('crops empty right rack and table legs while enlarging mounted module screen area and keeping <14 px dense jack spacing', () => {
    const activeBounds = computeActiveBenchBounds([placementBox('ins-dc-power'), placementBox('mod-dc-circuit')])
    expect(activeBounds).not.toBeNull()
    if (!activeBounds) return
    expect(activeBounds.minY).toBeGreaterThanOrEqual(WORK_AREA_BOUNDS.minY)
    expect(activeBounds.center[0]).toBeLessThan(-0.2)
    expect(activeBounds.width).toBeLessThan(WORK_AREA_BOUNDS.width)

    const jacks = dcModuleLayout?.jacks ?? []
    const [ox = 0, oy = 0, oz = 0] = dcPlacement?.position ?? []
    const [widthMm, heightMm, depthMm] = dcModuleLayout?.dimensionsMm ?? [290, 470, 55]

    for (const [width, height] of [
      [780, 440],
      [900, 470],
      [1340, 700],
    ] as const) {
      const aspect = width / height
      const dynView = activeWorkView(activeBounds, aspect)
      const dynCam = new THREE.PerspectiveCamera(previewFov, aspect, 0.05, 40)
      dynCam.position.set(...dynView.position)
      dynCam.lookAt(...dynView.target)
      dynCam.updateMatrixWorld()
      dynCam.updateProjectionMatrix()

      const { camera: fullCam } = buildCamera('work', width, height)
      const legBottom = projectPoint(dynCam, [activeBounds.center[0], 0.15, 0.2], width, height)
      expect(legBottom.ndcY).toBeLessThan(-1)

      const modMin = projectPoint(dynCam, [ox - widthMm / 2000, oy, oz + depthMm / 2000], width, height)
      const modMax = projectPoint(
        dynCam,
        [ox + widthMm / 2000, oy + heightMm / 1000, oz + depthMm / 2000],
        width,
        height,
      )
      const oldMin = projectPoint(fullCam, [ox - widthMm / 2000, oy, oz + depthMm / 2000], width, height)
      const oldMax = projectPoint(
        fullCam,
        [ox + widthMm / 2000, oy + heightMm / 1000, oz + depthMm / 2000],
        width,
        height,
      )
      const newArea = Math.abs((modMax.x - modMin.x) * (modMax.y - modMin.y))
      const oldArea = Math.abs((oldMax.x - oldMin.x) * (oldMax.y - oldMin.y))
      if (width <= 900) expect(newArea).toBeGreaterThan(oldArea * 1.15)

      const screenPts = jacks.map((jack) =>
        projectPoint(
          dynCam,
          [ox + (jack.x - widthMm / 2) / 1000, oy + (heightMm - jack.y) / 1000, oz + depthMm / 2000],
          width,
          height,
        ),
      )
      let minDist = Number.POSITIVE_INFINITY
      for (let i = 0; i < screenPts.length; i++) {
        for (let j = i + 1; j < screenPts.length; j++) {
          const a = screenPts[i]
          const b = screenPts[j]
          if (!a || !b) continue
          minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y))
        }
      }
      expect(minDist).toBeLessThan(14)
    }
  })

  it('expands active bounds to include newly placed desktop oscilloscope on the right side', () => {
    const base = computeActiveBenchBounds([placementBox('ins-dc-power'), placementBox('mod-dc-circuit')])
    const withScope = computeActiveBenchBounds([
      placementBox('ins-dc-power'),
      placementBox('mod-dc-circuit'),
      placementBox('ins-oscilloscope'),
    ])
    expect(base).not.toBeNull()
    expect(withScope).not.toBeNull()
    if (!base || !withScope) return
    expect(withScope.maxX).toBeGreaterThan(base.maxX + 0.4)
    expect(withScope.width).toBeGreaterThan(base.width + 0.4)
  })
})
