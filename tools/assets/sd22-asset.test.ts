import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Module } from '../../src/shared/schema/module.ts'
import { buildAsset } from './geometry.ts'
import { inspectGlb, parseGlb } from './glb.ts'
import { type AssetReport, contentIssues, subcircuitPorts, validateAsset } from './lint.ts'
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
const followerAsset = catalog.assets.find((entry) => entry.id === 'mod-voltage-follower')
if (!followerAsset) throw new Error('Missing approved voltage-follower adapter layout')
const follower = followerAsset
const followerUrl = new URL('../../content/modules/mod-voltage-follower/', import.meta.url)
const followerContent = Module.parse(JSON.parse(readFileSync(new URL('module.json', followerUrl), 'utf8')))
const manifest = JSON.parse(
  readFileSync(new URL('../../assets/generated/manifest.json', import.meta.url), 'utf8'),
) as AssetReport

function checksum(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

// Original 555 board/artwork bytes are pinned to 5b20b60; approved follower cir/glb/panel bytes to afa5a97.
// mod-voltage-follower/module.json hash updated for the 2026-11-21 approved Option A maxStep change (2e-6 -> 20e-6).
const shippedHashes = [
  ['mod-555-app/module.cir', '9708ee1fa6dcb308d183ed7d0c51ec4b7ed0d6190251d12aa8473be35fd0c081'],
  ['mod-555-app/module.glb', '030d276d48ce83e2f12d6aab2054870c468201e46dc5cb415ef320e7d46ef3d5'],
  ['mod-555-app/panel.svg', 'a1146906608a184e158575968366827a13a778e664b67acad1cbae523a4ab567'],
  ['mod-555-app/panel.webp', '3519fb6d6423f14e14a39c8234d84058f8aa472713650b6ddca8f218cada2168'],
  ['mod-voltage-follower/module.json', '101e55f1ed5f300435e1bd0626468ad872cd6b75738590ae244b4a9db1547dfb'],
  ['mod-voltage-follower/module.cir', 'f7f3605488bdcb17ca86a7faa6ee0a0894f4abb72dc272e67fd956dfc1b8f8fd'],
  ['mod-voltage-follower/module.glb', '01081a207b4310ea1d5775012f29e19a77e1ddd6f97c52a244e19a5d3009b327'],
  ['mod-voltage-follower/panel.svg', '3bd5df52064373874f6768baf5ee88e3f2c0a332530d8646d6f3b7cd6e71811b'],
  ['mod-voltage-follower/panel.webp', 'fe13973ffc19998f827f6ad9356c554f3c3bde385296e849bd59c97e21a76ba1'],
] as const

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
    expect(moduleContent.indicators).toEqual([
      { id: 'LS1', kind: 'speaker', between: ['SPK_P', 'SPK_N'], audio: { fullScale: 5 } },
    ])
    expect(moduleContent.simulation).toEqual({ analysis: 'tran', maxStep: 20e-6, pacing: 'realtime' })
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

describe('approved independent follower adapter asset', () => {
  it('preserves its four-jack supply/input/output order and independent board footprint', () => {
    expect(follower.dimensionsMm).toEqual([120, 80, 40])
    expect(follower.estimatedDimensions).toBe(true)
    expect(follower.dimensionNote).toContain('TLV9001IDBVR')
    expect(follower.jacks.map((jack) => [jack.id, jack.x, jack.y, jack.color])).toEqual([
      ['VCC', 108, 18, 'red'],
      ['GND', 108, 68, 'black'],
      ['IN', 12, 42, 'yellow'],
      ['OUT', 108, 42, 'yellow'],
    ])
    expect(followerContent.jacks.map(({ id, label }) => ({ id, label }))).toEqual(
      follower.jacks.map(({ id, label }) => ({ id, label })),
    )
    expect(followerContent.form).toBe('board')
    expect(followerContent.controls).toEqual([])
    expect(followerContent.indicators).toEqual([])
    expect(followerContent.commonNets).toBeUndefined()
    expect(followerContent.internalJumpers).toBeUndefined()
    expect(followerContent.simulation).toEqual({ analysis: 'tran', maxStep: 20e-6, pacing: 'realtime' })
  })

  it('keeps real internal negative feedback, named local model inclusion and supply decoupling', () => {
    const netlist = readFileSync(new URL('module.cir', followerUrl), 'utf8')
    expect(subcircuitPorts(netlist)).toEqual(['VCC', 'GND', 'IN', 'OUT'])
    expect(contentIssues(follower, catalog.preview.placements)).toEqual([])
    expect(netlist).toContain('XBUF OUT GND IN OUT VCC TLV9001_EST')
    expect(netlist).toContain('Cdecouple VCC GND 100n')
    expect(netlist).toContain('.include "opamp.lib"')
    expect(netlist).not.toContain('NE555')
  })

  it('ships four correctly registered front-facing GLB anchors and a local WebP panel', () => {
    const glb = parseGlb(readFileSync(new URL('module.glb', followerUrl)))
    const inspection = inspectGlb(glb)
    expect(validateAsset(follower, inspection)).toEqual([])
    expect(inspection.anchors.map((anchor) => anchor.name)).toEqual(['JACK_VCC', 'JACK_GND', 'JACK_IN', 'JACK_OUT'])
    expect(inspection.triangles).toBe(1010)
    expect(inspection.drawCalls).toBe(3)
    expect(inspection.textures).toEqual([{ mimeType: 'image/webp', width: 1536, height: 1024 }])
    expect(glb.json.images?.every((image) => image.uri === undefined)).toBe(true)
  })

  it('retains the reviewed nonoverlapping supply labels and explicitly estimated model notice', () => {
    expect(follower.jacks.find((jack) => jack.id === 'VCC')?.labelY).toBe(10)
    expect(follower.jacks.find((jack) => jack.id === 'GND')).toMatchObject({ labelX: 96, labelY: 75 })
    const svg = readFileSync(new URL('panel.svg', followerUrl), 'utf8')
    expect(svg).toContain('TLV9001IDBVR 估计模型 / 5 V')
    expect(svg).toContain('font-family="Asset Panel Font"')
    expect(svg).toContain('url(data:font/woff2;base64,')
    expect(svg).not.toMatch(/<script|<image|@import|href=|url\(https?:/)
    expect(readFileSync(new URL('panel.webp', followerUrl)).toString('ascii', 8, 12)).toBe('WEBP')
  })
})

describe('SD-22 asset merge provenance', () => {
  it('does not rewrite the original 555 board or the separately approved follower artifacts', () => {
    for (const [path, expected] of shippedHashes) {
      const bytes = readFileSync(new URL(`../../content/modules/${path}`, import.meta.url))
      expect(checksum(bytes), path).toBe(expected)
    }
  })

  it('preserves both reviewed catalog and manifest entries when merging shared metadata', () => {
    const expectedEntries = [
      [
        definition,
        '36ff2546fb3f004dc85eb3a043672f225c5a44e251424c42a9ea9af72313e56e',
        '06016a973e1db17e4fc6d73a272a34714fa2ea03099e2b1423ce392399202e78',
      ],
      [
        follower,
        '5749ef5299bec6d5d0de98563236f5311a8382625f804b8aba1cb45c338a4527',
        '6f7bcf79c79039cab7359bd97961a648b493b7d1bcc1b0e46fb248e7430e92fd',
      ],
    ] as const
    for (const [entry, catalogHash, manifestHash] of expectedEntries) {
      expect(checksum(JSON.stringify(entry)), `${entry.id} catalog`).toBe(catalogHash)
      expect(catalog.assets.filter((asset) => asset.id === entry.id)).toHaveLength(1)
      const audit = manifest.assets.find((asset) => asset.id === entry.id)
      expect(manifest.assets.filter((asset) => asset.id === entry.id)).toHaveLength(1)
      expect(checksum(JSON.stringify(audit)), `${entry.id} manifest`).toBe(manifestHash)
    }
  })

  it('keeps matching source/bundled license rows without dangling asset paths or stale checksums', () => {
    const source = readFileSync(new URL('../../assets/LICENSES.csv', import.meta.url), 'utf8')
    const bundled = readFileSync(new URL('../../content/ASSET-LICENSES.csv', import.meta.url), 'utf8')
    expect(bundled).toBe(source)
    const rows = source
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((row) => [...row.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? '').replaceAll('""', '"')))
    expect(new Set(rows.map((row) => row[0])).size).toBe(rows.length)
    for (const row of rows) {
      const path = row[1]
      expect(path).toBeTruthy()
      const bytes = readFileSync(new URL(`../../${path}`, import.meta.url))
      expect(checksum(bytes), path).toBe(row[8])
    }
    for (const entry of [definition, follower]) {
      const moduleRows = rows.filter((row) => row[0] === entry.id || row[0]?.startsWith(`${entry.id}-panel-`))
      expect(moduleRows).toHaveLength(3)
      expect(moduleRows.every((row) => row[4] === 'LicenseRef-Project-Owned')).toBe(true)
      expect(moduleRows.find((row) => row[0] === entry.id)?.[1]).toBe(entry.model)
    }
  })
})
