import { readFileSync } from 'node:fs'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import catalogData from '../../../../assets/layouts/catalog.json'
import sceneData from '../../../../content/bench/scene.json'
import { CircuitState } from '../../../shared/schema/circuit.ts'
import { JackRef } from '../../../shared/schema/common.ts'
import type { Project } from '../../../shared/schema/project.ts'
import {
  desktopSlots,
  fixedPlacements,
  initialInstruments,
  instrumentPlacementProblem,
  jackName,
  jacksForPlacements,
  placementSignature,
  placementsForInstruments,
  placementsForProject,
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
  it('loads the configured placements and 52 unique, schema-valid global jack references', () => {
    expect(wiringScene).toEqual(sceneData)
    expect(wiringScene.placements).toHaveLength(11)
    expect(new Set(wiringScene.placements.map((placement) => placement.instanceId)).size).toBe(11)
    expect(wiringJacks).toHaveLength(52)
    expect(new Set(wiringJacks.map((jack) => jack.ref)).size).toBe(52)
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
    expect(fixed).toHaveLength(6)
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
    expect(checked).toBe(52)
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
    expect(fixedPlacements).toHaveLength(8)
    expect(placementsForInstruments(initialInstruments)).toEqual(fixedPlacements)
    expect(jacksForPlacements(fixedPlacements)).toHaveLength(40)
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

function projectFor(modules: Project['modules']): Project {
  return {
    id: 'DG-05',
    group: '直流电路',
    title: '配置驱动的实训场景',
    type: 'basic',
    modules,
    allowedInstruments: [],
    reference: { nets: [], measurePoints: [] },
    steps: [{ id: 'prepare', text: '准备器材。' }],
    dataTables: [],
    charts: [],
    questions: [],
  }
}

describe('project-owned wiring context', () => {
  const module = { instanceId: 'board1', moduleId: 'mod-dc-circuit', slot: 'SLOT_BOX_L2' }

  it('keeps the legacy fixture only when no project is configured', () => {
    expect(placementsForProject()).toBe(fixedPlacements)
    expect(wiringScene.placements).toEqual(sceneData.placements)
  })

  it('replaces fixture modules with configured IDs and actual module slot transforms', () => {
    const placements = placementsForProject(projectFor([module]))
    const hardware = fixedPlacements.filter(
      (placement) => catalogData.assets.find((asset) => asset.id === placement.assetId)?.kind !== 'module',
    )
    expect(placements.filter((placement) => placement.instanceId !== module.instanceId)).toEqual(hardware)
    const bench = catalogData.assets.find((asset) => asset.kind === 'bench')
    const slot = bench?.slots?.find((entry) => entry.id === module.slot)
    expect(slot).toBeDefined()
    expect(placements.find((placement) => placement.instanceId === module.instanceId)).toMatchObject({
      assetId: module.moduleId,
      slot: module.slot,
      position: slot?.position,
    })
    expect(placements.some((placement) => placement.instanceId === 'dc1')).toBe(false)
    expect(
      placements.some((placement) => previewInstruments.some((preview) => preview.instanceId === placement.instanceId)),
    ).toBe(false)
    const jacks = jacksForPlacements(placements)
    expect(jacks.some((jack) => jack.ref.startsWith('dc1.'))).toBe(false)
    expect(jacks.filter((jack) => jack.instanceId === module.instanceId)).toHaveLength(
      wiringJacks.filter((jack) => jack.instanceId === 'dc1').length,
    )
    expect(
      jacks.filter((jack) => jack.instanceId === module.instanceId).every((jack) => jack.ref.startsWith('board1.')),
    ).toBe(true)
  })

  it('rejects unavailable assets, incorrect or duplicate slots, oversized modules and occupied IDs', () => {
    expect(() => placementsForProject(projectFor([{ ...module, moduleId: 'missing-module' }]))).toThrow('资产')
    expect(() => placementsForProject(projectFor([{ ...module, moduleId: 'bench' }]))).toThrow('资产')
    expect(() => placementsForProject(projectFor([{ ...module, slot: 'SLOT_MISSING' }]))).toThrow('安装位')
    expect(() => placementsForProject(projectFor([{ ...module, slot: 'SLOT_DESK_1' }]))).toThrow('类型')
    expect(() => placementsForProject(projectFor([{ ...module, slot: 'SLOT_BOX_S1' }]))).toThrow('尺寸')
    expect(() => placementsForProject(projectFor([module, { ...module, instanceId: 'board2' }]))).toThrow('重复')
    expect(() => placementsForProject(projectFor([module, { ...module, slot: 'SLOT_BOX_L1' }]))).toThrow('实例编号')
    expect(() => placementsForProject(projectFor([{ ...module, instanceId: 'bench' }]))).toThrow('实例编号')
    expect(() => placementsForProject(projectFor([{ ...module, instanceId: 'ins-dc-voltmeter' }]))).toThrow('实例编号')
    expect(() => placementsForProject(projectFor([{ ...module, instanceId: 'bad.id' }]))).toThrow()
    expect(() => placementsForProject(projectFor([]))).toThrow('未配置')
  })

  it('composes desktop instruments and checks collisions against active module geometry', () => {
    const base = placementsForProject(projectFor([module]))
    const meter = { instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_1', settings: {} }
    expect(placementsForInstruments([], base)).toEqual(base)
    expect(placementsForInstruments([meter], base).some((placement) => placement.instanceId === 'dc1')).toBe(false)
    expect(instrumentPlacementProblem(meter, [], base)).toBeNull()
    const slot = desktopSlots.find((entry) => entry.id === meter.slot)
    if (!slot) throw new Error('Missing desktop slot')
    const overlap = base.map((placement) =>
      placement.instanceId === module.instanceId ? { ...placement, position: slot.position } : placement,
    )
    expect(instrumentPlacementProblem(meter, [], overlap)).toContain('重叠')
  })

  it('keys geometry by asset, instance, slot, position and rotation without depending on array order', () => {
    const placements = placementsForProject(projectFor([module]))
    const signature = placementSignature(placements)
    expect(placementSignature(placements.slice().reverse())).toBe(signature)
    expect(placementSignature(placements.map((placement) => ({ ...placement, rotation: [0, 0, 0] })))).toBe(signature)
    const change = (patch: Partial<(typeof placements)[number]>) =>
      placementSignature(
        placements.map((placement) =>
          placement.instanceId === module.instanceId ? { ...placement, ...patch } : placement,
        ),
      )
    expect(change({ assetId: 'ins-oscilloscope' })).not.toBe(signature)
    expect(change({ instanceId: 'board2' })).not.toBe(signature)
    expect(change({ slot: 'SLOT_BOX_L1' })).not.toBe(signature)
    expect(change({ position: [0.3, 0.865, -0.2] })).not.toBe(signature)
    expect(change({ rotation: [0, 0.1, 0] })).not.toBe(signature)
  })
})
