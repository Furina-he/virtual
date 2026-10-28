import { Box3, Euler, Vector3 } from 'three'
import { z } from 'zod'
import catalogData from '../../../../assets/layouts/catalog.json'
import sceneData from '../../../../content/bench/scene.json'
import type { CircuitState } from '../../../shared/schema/circuit'
import { BenchScene } from '../../../shared/schema/scene'

export type WiringJack = {
  ref: string
  instanceId: string
  assetId: string
  id: string
  label: string
  deviceName: string
  kind: string
  position: [number, number, number]
  normal: [number, number, number]
}

const vector = z.tuple([z.number(), z.number(), z.number()])
export const wiringAssets = z
  .array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      mounting: z.enum(['fixed', 'desktop']).optional(),
      dimensionsMm: vector,
      slots: z
        .array(
          z.object({
            id: z.string(),
            kind: z.enum(['fixed', 'module', 'desktop']),
            position: vector,
            dimensionsMm: vector.optional(),
          }),
        )
        .optional(),
      jacks: z.array(
        z.object({ id: z.string(), label: z.string(), x: z.number(), y: z.number(), kind: z.string().optional() }),
      ),
    }),
  )
  .parse(catalogData.assets)

export const wiringScene = BenchScene.parse(sceneData)
export type ScenePlacement = BenchScene['placements'][number]
type PlacedInstrument = CircuitState['placedInstruments'][number]

export function jacksForPlacements(placements: readonly ScenePlacement[]): WiringJack[] {
  return placements.flatMap((placement) => {
    const asset = wiringAssets.find((entry) => entry.id === placement.assetId)
    if (!asset) throw new Error(`Unknown scene asset ${placement.assetId}`)
    const rotation = new Euler(...(placement.rotation ?? [0, 0, 0]))
    const normal = new Vector3(0, 0, 1).applyEuler(rotation).toArray()
    const [width, height, depth] = asset.dimensionsMm
    return asset.jacks.map((jack) => ({
      ref: `${placement.instanceId}.${jack.id}`,
      instanceId: placement.instanceId,
      assetId: asset.id,
      id: jack.id,
      label: jack.label,
      deviceName: asset.name,
      kind: jack.kind ?? 'banana4',
      position: new Vector3(
        (jack.x - width / 2) / 1000,
        (height - jack.y) / 1000,
        depth / 2000 + (jack.kind === 'bnc' ? 0.007 : 0.004),
      )
        .applyEuler(rotation)
        .add(new Vector3(...placement.position))
        .toArray(),
      normal,
    }))
  })
}

// The complete eight-asset fixture remains available to asset-pipeline tests and previews.
export const wiringJacks = jacksForPlacements(wiringScene.placements)

export const previewInstruments = wiringScene.placements.flatMap((placement) => {
  const asset = wiringAssets.find((entry) => entry.id === placement.assetId)
  return asset?.kind === 'instrument' && asset.mounting === 'desktop' && placement.slot
    ? [{ instanceId: placement.instanceId, instrumentId: asset.id, slot: placement.slot, settings: {} }]
    : []
})

export const initialInstruments: PlacedInstrument[] = []
export const fixedPlacements = wiringScene.placements.filter((placement) => {
  const asset = wiringAssets.find((entry) => entry.id === placement.assetId)
  return asset?.mounting !== 'desktop'
})
const benchPlacement = fixedPlacements.find((placement) =>
  wiringAssets.some((asset) => asset.id === placement.assetId && asset.kind === 'bench'),
)
if (!benchPlacement) throw new Error('Missing bench placement')
const bench = wiringAssets.find((asset) => asset.id === benchPlacement.assetId)
const benchRotation = new Euler(...(benchPlacement.rotation ?? [0, 0, 0]))
export const desktopSlots = (bench?.slots ?? [])
  .filter((slot) => slot.kind === 'desktop')
  .map((slot) => ({
    ...slot,
    position: new Vector3(...slot.position)
      .applyEuler(benchRotation)
      .add(new Vector3(...benchPlacement.position))
      .toArray(),
    rotation: benchPlacement.rotation,
  }))

export function placementsForInstruments(instruments: readonly PlacedInstrument[]): ScenePlacement[] {
  return [
    ...fixedPlacements,
    ...instruments.map((instrument) => {
      const slot = desktopSlots.find((entry) => entry.id === instrument.slot)
      if (!slot) throw new Error(`Unknown desktop slot ${instrument.slot}`)
      return {
        instanceId: instrument.instanceId,
        assetId: instrument.instrumentId,
        position: slot.position,
        rotation: slot.rotation,
        slot: slot.id,
      }
    }),
  ]
}

function placementBounds(placement: ScenePlacement): Box3 {
  const asset = wiringAssets.find((entry) => entry.id === placement.assetId)
  if (!asset) throw new Error(`Unknown placement asset ${placement.assetId}`)
  const [width, height, depth] = asset.dimensionsMm.map((value) => value / 1000) as [number, number, number]
  const rotation = new Euler(...(placement.rotation ?? [0, 0, 0]))
  const origin = new Vector3(...placement.position)
  const points = [-width / 2, width / 2].flatMap((x) =>
    [0, height].flatMap((y) =>
      [-depth / 2, depth / 2].map((z) => new Vector3(x, y, z).applyEuler(rotation).add(origin)),
    ),
  )
  return new Box3().setFromPoints(points)
}

export function instrumentPlacementProblem(
  instrument: PlacedInstrument,
  placed: readonly PlacedInstrument[],
): string | null {
  const asset = wiringAssets.find((entry) => entry.id === instrument.instrumentId)
  const slot = desktopSlots.find((entry) => entry.id === instrument.slot)
  if (asset?.mounting !== 'desktop' || !slot) return '该安装位不能放置这台仪表。'
  if (placed.some((item) => item.slot === slot.id)) return '该安装位已有仪表。'
  if (slot.dimensionsMm?.some((limit, axis) => (asset.dimensionsMm[axis] ?? 0) > limit)) {
    return '仪表尺寸超过该安装位的限制。'
  }
  const candidate: ScenePlacement = {
    assetId: asset.id,
    instanceId: instrument.instanceId,
    position: slot.position,
    rotation: slot.rotation,
  }
  const bounds = placementBounds(candidate)
  const surface = wiringScene.workSurface
  if (
    !surface ||
    [0, 2].some(
      (axis) =>
        bounds.min.getComponent(axis) < (surface.min[axis] ?? 0) - 1e-6 ||
        bounds.max.getComponent(axis) > (surface.max[axis] ?? 0) + 1e-6,
    ) ||
    Math.abs(bounds.min.y - surface.min[1]) > 1e-6
  ) {
    return '仪表超出台面边界，请选择其他安装位。'
  }
  const occupied = placementsForInstruments(placed).filter(
    (placement) => wiringAssets.find((entry) => entry.id === placement.assetId)?.kind !== 'bench',
  )
  if (occupied.some((placement) => bounds.clone().expandByScalar(-1e-6).intersectsBox(placementBounds(placement)))) {
    return '仪表会与现有设备重叠，请选择其他安装位。'
  }
  return null
}

export function jackName(ref: string, jacks: readonly WiringJack[] = wiringJacks): string {
  const jack = jacks.find((entry) => entry.ref === ref)
  return jack ? `${jack.deviceName} / ${jack.label} (${jack.id})` : ref
}
