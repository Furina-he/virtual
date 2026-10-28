import { Euler, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import type { BenchScene } from '../../src/shared/schema/scene.ts'
import { validateScene } from './lint.ts'
import type { AssetCatalog, AssetDefinition } from './types.ts'

function fixture() {
  const asset = (id: string, kind: AssetDefinition['kind']): AssetDefinition => ({
    id,
    kind,
    name: id,
    model: `${id}.glb`,
    bodyStyle: 'bench',
    estimatedDimensions: true,
    dimensionsMm: [100, 100, 100],
    jacks: [],
    screens: [],
    controls: [],
  })
  const bench = asset('bench', 'bench')
  bench.slots = [
    { id: 'SLOT_FIXED', kind: 'fixed', position: [0, 1.4, -0.2] },
    { id: 'SLOT_MODULE', kind: 'module', position: [0, 0.85, -0.2] },
    { id: 'SLOT_DESK', kind: 'desktop', position: [0.4, 0.8, 0.1] },
  ]
  const meter = { ...asset('meter', 'instrument'), mounting: 'fixed' as const }
  const desktop = { ...asset('desktop', 'instrument'), mounting: 'desktop' as const }
  const catalog: AssetCatalog = {
    schemaVersion: 1,
    assets: [bench, meter, desktop, asset('module', 'module')],
    preview: { camera: { position: [0, 1, 2], target: [0, 1, 0] }, placements: [] },
  }
  const scene: BenchScene = {
    schemaVersion: 1,
    id: 'bench',
    camera: catalog.preview.camera,
    placements: [
      { assetId: 'bench', instanceId: 'bench', position: [0, 0, 0] },
      { assetId: 'meter', instanceId: 'meter', position: [0, 1.4, -0.2], slot: 'SLOT_FIXED' },
      { assetId: 'module', instanceId: 'module1', position: [0, 0.85, -0.2], slot: 'SLOT_MODULE' },
      { assetId: 'desktop', instanceId: 'desk1', position: [0.4, 0.8, 0.1], slot: 'SLOT_DESK' },
    ],
  }
  const instruments = [{ id: 'meter', mounting: 'fixed' as const, fixedSlot: 'SLOT_FIXED' }]
  const fixed = scene.placements[1]
  const benchPlacement = scene.placements[0]
  if (!fixed || !benchPlacement) throw new Error('Missing test placements')
  return { catalog, scene, instruments, fixed, benchPlacement, meter }
}

describe('content scene asset references', () => {
  it('accepts valid content without requiring runtime logic for a desktop shell', () => {
    const { scene, catalog, instruments } = fixture()
    expect(validateScene(scene, catalog, instruments)).toEqual([])
  })

  it('rejects malformed data and duplicate stable instance IDs', () => {
    const { scene, catalog, instruments, fixed } = fixture()
    expect(validateScene({}, catalog, instruments).length).toBeGreaterThan(0)
    scene.placements.push({ ...fixed })
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('instanceId')
  })

  it('rejects an unknown asset and a missing bench', () => {
    const { scene, catalog, instruments, fixed, benchPlacement } = fixture()
    fixed.assetId = 'missing-model'
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('Unknown scene asset')
    benchPlacement.assetId = 'missing-bench'
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('exactly one known bench')
  })

  it('rejects unknown, missing, occupied, or incompatible slots', () => {
    const { scene, catalog, instruments, fixed } = fixture()
    fixed.slot = 'SLOT_UNKNOWN'
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('Unknown bench slot')
    delete fixed.slot
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('Missing placement slot')
    fixed.slot = 'SLOT_DESK'
    const issues = validateScene(scene, catalog, instruments).join('\n')
    expect(issues).toContain('already occupied')
    expect(issues).toContain('incompatible')
  })

  it('requires fixed instrument identity, slot, and exactly one instance', () => {
    const { scene, catalog, instruments, fixed } = fixture()
    fixed.instanceId = 'meter-preview-1'
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('content id and fixedSlot')
    fixed.instanceId = 'meter'
    instruments[0] = { id: 'meter', mounting: 'fixed', fixedSlot: 'SLOT_OTHER' }
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('content id and fixedSlot')
    scene.placements = scene.placements.filter((placement) => placement.assetId !== 'meter')
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('one placement')
  })

  it('rejects missing authoritative fixed content and mounting drift', () => {
    const { scene, catalog, instruments, meter } = fixture()
    expect(validateScene(scene, catalog, []).join('\n')).toContain('Missing authoritative fixed instrument content')
    const changed = { ...meter, mounting: 'desktop' as const }
    catalog.assets = catalog.assets.map((asset) => (asset.id === meter.id ? changed : asset))
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('mounting differs')
  })

  it('compares world transforms after moving and rotating the bench', () => {
    const { scene, catalog, instruments, fixed } = fixture()
    const rotation: [number, number, number] = [0, Math.PI / 2, 0]
    for (const placement of scene.placements) {
      placement.position = new Vector3(...placement.position)
        .applyEuler(new Euler(...rotation))
        .add(new Vector3(1, 0, 2))
        .toArray()
      placement.rotation = [...rotation]
    }
    expect(validateScene(scene, catalog, instruments)).toEqual([])
    fixed.position[0] += 0.01
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('world-space bench slot')
    fixed.rotation = [0, 0, 0]
    expect(validateScene(scene, catalog, instruments).join('\n')).toContain('orientation differs')
  })
})
