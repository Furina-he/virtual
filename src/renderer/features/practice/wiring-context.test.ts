import { readFileSync } from 'node:fs'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import catalogData from '../../../../assets/layouts/catalog.json'
import sceneData from '../../../../content/bench/scene.json'
import { CircuitState } from '../../../shared/schema/circuit.ts'
import { JackRef } from '../../../shared/schema/common.ts'
import {
  desktopSlots,
  fixedPlacements,
  initialInstruments,
  instrumentPlacementProblem,
  jackName,
  jacksForPlacements,
  placementsForInstruments,
  previewInstruments,
  wiringJacks,
  wiringScene,
} from './wiring-context.ts'

const root = new URL('../../../../', import.meta.url)
const inspectorPath = '../../../../tools/assets/glb.ts'
const { inspectGlb, parseGlb } = (await import(inspectorPath)) as {
  parseGlb: (bytes: Buffer) => unknown
  inspectGlb: (glb: unknown) => { anchors: { name: string; position: number[]; normal: number[] }[] }
}

function sceneTransform(placement: (typeof wiringScene.placements)[number]): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...placement.position),
    new Quaternion().setFromEuler(new Euler(...(placement.rotation ?? [0, 0, 0]))),
    new Vector3(1, 1, 1),
  )
}

describe('content-owned wiring context', () => {
  it('loads the eight configured placements and 42 unique, schema-valid global jack references', () => {
    expect(wiringScene).toEqual(sceneData)
    expect(wiringScene.placements).toHaveLength(8)
    expect(new Set(wiringScene.placements.map((placement) => placement.instanceId)).size).toBe(8)
    expect(wiringJacks).toHaveLength(42)
    expect(new Set(wiringJacks.map((jack) => jack.ref)).size).toBe(42)
    for (const jack of wiringJacks) {
      expect(JackRef.safeParse(jack.ref).success, jack.ref).toBe(true)
      expect(jack.ref).toBe(`${jack.instanceId}.${jack.id}`)
      expect(wiringScene.placements.find((placement) => placement.instanceId === jack.instanceId)?.assetId).toBe(
        jack.assetId,
      )
    }
  })

  it('keeps fixed instrument instance IDs and mounting slots compatible with authoritative content', () => {
    const fixed = catalogData.assets.filter((asset) => asset.kind === 'instrument' && asset.mounting === 'fixed')
    expect(fixed).toHaveLength(3)
    const bench = catalogData.assets.find((asset) => asset.kind === 'bench')
    if (!bench) throw new Error('Missing bench asset fixture')
    const benchAnchors = inspectGlb(parseGlb(readFileSync(new URL(bench.model, root)))).anchors
    const benchPlacement = wiringScene.placements.find((placement) => placement.assetId === bench.id)
    if (!benchPlacement) throw new Error('Missing bench placement fixture')
    for (const asset of fixed) {
      const content = JSON.parse(readFileSync(new URL(asset.model.replace(/\.glb$/, '.json'), root), 'utf8')) as {
        id: string
        fixedSlot: string
        jacks: { id: string }[]
      }
      const placements = wiringScene.placements.filter((placement) => placement.assetId === asset.id)
      expect(placements).toHaveLength(1)
      const placement = placements[0]
      if (!placement) throw new Error(`Missing fixed placement ${asset.id}`)
      expect(placement.instanceId).toBe(content.id)
      expect(placement.slot).toBe(content.fixedSlot)
      const slot = benchAnchors.find((anchor) => anchor.name === content.fixedSlot)
      if (!slot) throw new Error(`Missing actual bench anchor ${content.fixedSlot}`)
      const expected = new Vector3().fromArray(slot.position).applyMatrix4(sceneTransform(benchPlacement))
      expect(expected.distanceTo(new Vector3(...placement.position))).toBeLessThan(1e-6)
      expect(wiringJacks.filter((jack) => jack.instanceId === content.id).map((jack) => jack.ref)).toEqual(
        content.jacks.map((jack) => `${content.id}.${jack.id}`),
      )
    }
    const module = JSON.parse(readFileSync(new URL('content/modules/mod-dc-circuit/module.json', root), 'utf8')) as {
      jacks: { id: string }[]
    }
    expect(wiringJacks.filter((jack) => jack.instanceId === 'dc1').map((jack) => jack.ref)).toEqual(
      module.jacks.map((jack) => `dc1.${jack.id}`),
    )
  })

  it('matches every actual GLB jack position and normal after applying its scene transform', () => {
    let checked = 0
    for (const placement of wiringScene.placements) {
      const asset = catalogData.assets.find((entry) => entry.id === placement.assetId)
      if (!asset) throw new Error(`Missing asset ${placement.assetId}`)
      const anchors = inspectGlb(parseGlb(readFileSync(new URL(asset.model, root)))).anchors.filter((anchor) =>
        anchor.name.startsWith('JACK_'),
      )
      const actual = wiringJacks.filter((jack) => jack.instanceId === placement.instanceId)
      expect(actual).toHaveLength(anchors.length)
      const world = sceneTransform(placement)
      for (const anchor of anchors) {
        const id = anchor.name.slice('JACK_'.length)
        const jack = actual.find((candidate) => candidate.id === id)
        if (!jack) throw new Error(`Missing derived jack ${placement.instanceId}.${id}`)
        const expectedPosition = new Vector3().fromArray(anchor.position).applyMatrix4(world)
        const expectedNormal = new Vector3().fromArray(anchor.normal).transformDirection(world)
        expect(expectedPosition.distanceTo(new Vector3(...jack.position)), jack.ref).toBeLessThan(1e-6)
        expect(expectedNormal.distanceTo(new Vector3(...jack.normal)), jack.ref).toBeLessThan(1e-6)
        expect(new Vector3(...jack.normal).length()).toBeCloseTo(1, 9)
        expect(anchor.position[2]).toBeCloseTo(
          (asset.dimensionsMm[2] ?? 0) / 2000 + (jack.kind === 'bnc' ? 0.007 : 0.004),
          9,
        )
        checked++
      }
    }
    expect(checked).toBe(42)
  })

  it('preserves three desktop previews but starts teaching with an empty desktop', () => {
    expect(initialInstruments).toEqual([])
    expect(previewInstruments).toHaveLength(3)
    expect(previewInstruments.map((instrument) => instrument.instanceId).sort()).toEqual([
      'generator1',
      'meter1',
      'scope1',
    ])
    for (const instrument of previewInstruments) {
      const asset = catalogData.assets.find((entry) => entry.id === instrument.instrumentId)
      const placement = wiringScene.placements.find((entry) => entry.instanceId === instrument.instanceId)
      expect(asset?.mounting).toBe('desktop')
      expect(placement?.assetId).toBe(instrument.instrumentId)
      expect(placement?.slot).toBe(instrument.slot)
      expect(instrument.settings).toEqual({})
    }
    expect(
      CircuitState.safeParse({
        placedInstruments: initialInstruments,
        wires: [],
        controlValues: {},
        powered: false,
      }).success,
    ).toBe(true)
    expect(fixedPlacements).toHaveLength(5)
    expect(placementsForInstruments(initialInstruments)).toEqual(fixedPlacements)
    expect(jacksForPlacements(fixedPlacements)).toHaveLength(32)
    expect(jacksForPlacements(fixedPlacements).some((jack) => jack.instanceId === 'meter1')).toBe(false)
  })

  it('derives placed instrument transforms from actual GLB desktop slots and exposes only their jacks', () => {
    const bench = catalogData.assets.find((asset) => asset.kind === 'bench')
    if (!bench) throw new Error('Missing bench')
    const glbSlots = inspectGlb(parseGlb(readFileSync(new URL(bench.model, root)))).anchors
    expect(desktopSlots).toHaveLength(5)
    for (const slot of desktopSlots) {
      const actual = glbSlots.find((anchor) => anchor.name === slot.id)
      expect(actual?.position).toEqual(slot.position)
      const instrument = { instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: slot.id, settings: {} }
      const placed = [instrument]
      const placements = placementsForInstruments(placed)
      expect(placements.find((entry) => entry.instanceId === 'meter1')?.position).toEqual(actual?.position)
      expect(instrumentPlacementProblem(instrument, [])).toBeNull()
      expect(
        jacksForPlacements(placements)
          .filter((jack) => jack.instanceId === 'meter1')
          .map((jack) => jack.ref),
      ).toEqual(['meter1.COM', 'meter1.VOHM', 'meter1.MA', 'meter1.A10'])
    }
  })

  it('rejects incompatible, occupied, overhanging and overlapping device placements', () => {
    const meter = { instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_2', settings: {} }
    expect(instrumentPlacementProblem({ ...meter, slot: 'SLOT_INS_DCV' }, [])).toContain('不能放置')
    expect(instrumentPlacementProblem({ ...meter, instrumentId: 'ins-dc-voltmeter' }, [])).toContain('不能放置')
    expect(instrumentPlacementProblem({ ...meter, instanceId: 'meter2' }, [meter])).toContain('已有仪表')
    expect(instrumentPlacementProblem({ ...meter, instrumentId: 'ins-func-gen' }, [])).toContain('边界')
    expect(
      instrumentPlacementProblem({ ...meter, instrumentId: 'ins-func-gen', slot: 'SLOT_DESK_4' }, [
        { ...meter, slot: 'SLOT_SCOPE' },
      ]),
    ).toContain('重叠')
  })

  it('exposes consistent endpoint labels and preserves unknown refs for diagnostics', () => {
    for (const jack of wiringJacks) {
      expect(jackName(jack.ref)).toBe(`${jack.deviceName} / ${jack.label} (${jack.id})`)
    }
    expect(jackName('missing.UNKNOWN')).toBe('missing.UNKNOWN')
  })
})
