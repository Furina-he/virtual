import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Module } from '../../src/shared/schema/module.ts'
import { buildAsset } from './geometry.ts'
import { inspectGlb, parseGlb } from './glb.ts'
import { contentIssues, subcircuitPorts, validateAsset } from './lint.ts'
import { panelSvg } from './panels.ts'
import type { AssetCatalog } from './types.ts'

const catalog = JSON.parse(
  readFileSync(new URL('../../assets/layouts/catalog.json', import.meta.url), 'utf8'),
) as AssetCatalog
const asset = catalog.assets.find((entry) => entry.id === 'mod-555-app')
if (!asset) throw new Error('Missing 555 application board layout')
const definition = asset
const moduleUrl = new URL('../../content/modules/mod-555-app/', import.meta.url)
const moduleContent = Module.parse(JSON.parse(readFileSync(new URL('module.json', moduleUrl), 'utf8')))

// These coordinates are the prototype section 5.4 table, not the generated catalog.
const prototypeJacks = [
  ['VCC1', 252, 20, 'red'],
  ['GND1', 252, 165, 'black'],
  ['R5_1', 238, 118, 'yellow'],
  ['R5_2', 238, 145, 'yellow'],
  ['T1_TR', 25, 105, 'yellow'],
  ['T1_TH', 25, 80, 'yellow'],
  ['T1_DIS', 62, 60, 'yellow'],
  ['T1_RST', 45, 130, 'yellow'],
  ['T1_CV', 85, 130, 'yellow'],
  ['T1_OUT', 100, 92, 'yellow'],
  ['T1_RA_1', 15, 35, 'yellow'],
  ['T1_RA_2', 45, 35, 'yellow'],
  ['T1_RB_1', 65, 35, 'yellow'],
  ['T1_RB_2', 95, 35, 'yellow'],
  ['T1_CT_P', 15, 160, 'yellow'],
  ['T1_CT_N', 45, 160, 'yellow'],
  ['T1_CC_1', 65, 160, 'yellow'],
  ['T1_CC_2', 95, 160, 'yellow'],
  ['T2_TR', 149, 105, 'yellow'],
  ['T2_TH', 149, 80, 'yellow'],
  ['T2_DIS', 186, 60, 'yellow'],
  ['T2_RST', 169, 130, 'yellow'],
  ['T2_CV', 209, 130, 'yellow'],
  ['T2_OUT', 224, 92, 'yellow'],
  ['T2_RA_1', 139, 35, 'yellow'],
  ['T2_RA_2', 169, 35, 'yellow'],
  ['T2_RB_1', 189, 35, 'yellow'],
  ['T2_RB_2', 219, 35, 'yellow'],
  ['T2_CT_P', 139, 160, 'yellow'],
  ['T2_CT_N', 169, 160, 'yellow'],
  ['T2_CC_1', 189, 160, 'yellow'],
  ['T2_CC_2', 219, 160, 'yellow'],
  ['SPK_P', 252, 45, 'yellow'],
  ['SPK_N', 252, 75, 'black'],
  ['C5_P', 252, 105, 'yellow'],
  ['C5_N', 252, 135, 'yellow'],
] as const

describe('555 application board asset', () => {
  it('preserves the prototype panel, all 36 jack coordinates, colors and port order', () => {
    expect(definition.dimensionsMm.slice(0, 2)).toEqual([264, 184])
    expect(definition.estimatedDimensions).toBe(true)
    expect(definition.dimensionNote).toContain('estimated 18 mm depth')
    expect(definition.jacks.map((jack) => [jack.id, jack.x, jack.y, jack.color])).toEqual(prototypeJacks)
    expect(moduleContent.jacks.map((jack) => jack.id)).toEqual(prototypeJacks.map(([id]) => id))
    expect(definition.jacks.map(({ id, label }) => ({ id, label }))).toEqual(
      moduleContent.jacks.map(({ id, label }) => ({ id, label })),
    )
  })

  it('keeps component endpoints independent and declares actual differential speaker voltage', () => {
    expect(moduleContent.form).toBe('board')
    expect(moduleContent.controls).toEqual([])
    expect(moduleContent.commonNets).toBeUndefined()
    expect(moduleContent.internalJumpers).toBeUndefined()
    expect(moduleContent.indicators).toEqual([{ id: 'LS1', kind: 'speaker', probe: 'v(SPK_P,SPK_N)' }])
    for (const id of ['C1', 'C5']) {
      const prefix = id === 'C1' ? 'T1_CT' : 'C5'
      expect(moduleContent.jacks.find((jack) => jack.id === `${prefix}_P`)?.polarityHint).toBe('+')
      expect(moduleContent.jacks.find((jack) => jack.id === `${prefix}_N`)?.polarityHint).toBe('-')
    }
  })

  it('retains both 555 chip centers and the five resistor positions and fixed teaching values', () => {
    expect(definition.panel?.frames?.map((frame) => [frame.x + frame.width / 2, frame.y + frame.height / 2])).toEqual([
      [58.19, 88.19],
      [182.19, 88.19],
    ])
    expect(definition.panel?.symbols?.map((symbol) => [symbol.x, symbol.y, symbol.label])).toEqual([
      [25, 35, 'RA1 10 kΩ'],
      [75, 35, 'RB1 150 kΩ'],
      [149, 35, 'RA2 10 kΩ'],
      [199, 35, 'RB2 10 kΩ'],
      [238, 126, 'R5'],
    ])
    const svg = panelSvg(definition)
    for (const label of ['C1 4.7 µF', 'C2 0.047 µF', 'C3 0.01 µF', 'C4 0.01 µF', 'C5 100 µF', 'LS1 8 Ω/0.5 W']) {
      expect(svg).toContain(label)
    }
  })

  it('matches its independently authored SPICE declaration instead of generating a netlist from artwork', () => {
    const netlist = readFileSync(new URL('module.cir', moduleUrl), 'utf8')
    expect(subcircuitPorts(netlist)).toEqual(prototypeJacks.map(([id]) => id))
    expect(contentIssues(definition, catalog.preview.placements)).toEqual([])
    expect(netlist).toContain('C1 T1_CT_P T1_CT_N 4.7u')
    expect(netlist).toContain('C2 T2_CT_P T2_CT_N 47n')
    expect(netlist).toContain('RLS1 SPK_P SPK_N 8')
  })

  it('builds meter-scale, front-facing anchors without adding runtime-adjustable controls', () => {
    const root = buildAsset(definition)
    expect(root.userData).toMatchObject({ units: 'meters', front: '+Z', origin: 'bottom-installation-center' })
    const anchors: string[] = []
    root.traverse((node) => {
      if (/^(JACK|KNOB|SW|SCREEN|LED|SLOT)_/.test(node.name)) anchors.push(node.name)
    })
    expect(anchors).toEqual(prototypeJacks.map(([id]) => `JACK_${id}`))
    for (const [id, x, y] of prototypeJacks) {
      const anchor = root.getObjectByName(`JACK_${id}`)
      expect(anchor?.position.x).toBeCloseTo((x - 132) / 1000, 8)
      expect(anchor?.position.y).toBeCloseTo((184 - y) / 1000, 8)
      expect(anchor?.position.z).toBeCloseTo(0.013, 8)
      expect(anchor?.userData.normal).toEqual([0, 0, 1])
    }
    const bounds = new THREE.Box3().setFromObject(root)
    expect(bounds.min.y).toBeCloseTo(0, 7)
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      node.geometry.dispose()
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose()
    })
  })

  it('ships an actual validated local GLB with one WebP panel inside the original budgets', () => {
    const glb = parseGlb(readFileSync(new URL('module.glb', moduleUrl)))
    const inspection = inspectGlb(glb)
    expect(validateAsset(definition, inspection)).toEqual([])
    expect(inspection.anchors).toHaveLength(36)
    expect(inspection.drawCalls).toBe(3)
    expect(inspection.triangles).toBeLessThanOrEqual(50_000)
    expect(inspection.textures).toEqual([{ mimeType: 'image/webp', width: 2048, height: 1428 }])
    expect(glb.json.images?.every((image) => image.uri === undefined)).toBe(true)
  })

  it('ships local font-embedded panel artwork with no script, downloaded image or external font', () => {
    const svg = readFileSync(new URL('panel.svg', moduleUrl), 'utf8')
    expect(svg).toContain('font-family="Asset Panel Font"')
    expect(svg).toContain('url(data:font/woff2;base64,')
    expect(svg).not.toMatch(/<script|<image|@import|href=|url\(https?:/)
    expect(readFileSync(new URL('panel.webp', moduleUrl)).toString('ascii', 8, 12)).toBe('WEBP')
  })
})
