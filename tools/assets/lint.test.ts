import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type GlbInspection, inspectGlb, parseGlb, webpSize } from './glb.ts'
import {
  baselineAssetIssues,
  contentIssues,
  expectedAnchors,
  lintAssets,
  REQUIRED_BASELINE_ASSET_IDS,
  subcircuitPorts,
  validateAsset,
} from './lint.ts'
import { modelOutputPath, workspacePath } from './paths.ts'
import { importedSource } from './sources.ts'
import type { AssetCatalog, AssetDefinition } from './types.ts'

const catalog: AssetCatalog = JSON.parse(readFileSync(workspacePath('assets/layouts/catalog.json'), 'utf8'))
const module = catalog.assets.find((asset) => asset.kind === 'module') as AssetDefinition

function validModule(): GlbInspection {
  return {
    triangles: 100,
    drawCalls: 1,
    bounds: { min: [-0.145, 0, -0.03], max: [0.145, 0.47, 0.03] },
    textures: [{ mimeType: 'image/webp', width: 1024, height: 2048 }],
    anchors: expectedAnchors(module).map((name) => {
      const jack = module.jacks.find((entry) => `JACK_${entry.id}` === name)
      return {
        name,
        normal: [0, 0, 1],
        position: jack
          ? [(jack.x - 145) / 1000, (470 - jack.y) / 1000, module.dimensionsMm[2] / 2000 + 0.004]
          : [0, 0, 0.03],
      }
    }),
  }
}

describe('asset contract', () => {
  it.each(REQUIRED_BASELINE_ASSET_IDS)('rejects a catalog missing required baseline asset %s', (id) => {
    const missing = catalog.assets.filter((asset) => asset.id !== id)
    expect(baselineAssetIssues(missing)).toEqual([`Missing required baseline asset: ${id}`])
  })
  it('allows future assets without letting them replace a required baseline asset', () => {
    const baseline = REQUIRED_BASELINE_ASSET_IDS.map((id) => ({ id }))
    expect(baseline).toHaveLength(18)
    expect(baselineAssetIssues([...baseline, { id: 'future-reviewed-asset' }])).toEqual([])
    const replaced = baseline.filter((asset) => asset.id !== 'cmp-resistor')
    expect(baselineAssetIssues([...replaced, { id: 'future-reviewed-asset' }])).toEqual([
      'Missing required baseline asset: cmp-resistor',
    ])
  })
  it('keeps .subckt continuation ports and excludes params/comments', () => {
    expect(subcircuitPorts('* note\n.subckt sample A B\n+ C D params: k=1\nR1 A B 1k\n.ends')).toEqual([
      'A',
      'B',
      'C',
      'D',
    ])
    expect(() => subcircuitPorts('R1 A B 1k')).toThrow('subckt')
  })
  it('rejects unsafe asset paths', () => {
    expect(() => workspacePath('../outside.glb')).toThrow()
    expect(() => workspacePath('C:/outside.glb')).toThrow()
    expect(() => workspacePath('content\\model.glb')).toThrow()
    expect(workspacePath('content/models/test.glb')).toContain('content')
    expect(() => modelOutputPath('package.json')).toThrow('owned GLB')
    expect(() => modelOutputPath('content/modules/mod-dc-circuit/module.cir')).toThrow('owned GLB')
    expect(() => modelOutputPath('content/modules/../../outside.glb')).toThrow('owned GLB')
    expect(modelOutputPath(module.model)).toContain('module.glb')
  })
  it('fails closed for an imported model without source provenance', () => {
    const source = catalog.assets.find((asset) => asset.id === 'tool-pliers') as AssetDefinition
    expect(source).toMatchObject({ sourceFile: 'assets/vendor/polyhaven-pliers/pliers_1k.gltf' })
    expect(importedSource(source)?.license).toBe('CC0-1.0')
    expect(() => importedSource({ ...source, id: 'unregistered-tool' })).toThrow('verified source')
    expect(() => importedSource({ ...source, sourceFile: 'assets/other.gltf' })).toThrow('verified source')
  })
  it('checks ordered netlist ports and content-defined fixed instrument slots', () => {
    const reordered = { ...module, jacks: [...module.jacks].reverse() }
    expect(contentIssues(reordered, catalog.preview.placements).some((issue) => issue.includes('port order'))).toBe(
      true,
    )
    const fixed = catalog.assets.find(
      (asset) => asset.kind === 'instrument' && asset.mounting === 'fixed',
    ) as AssetDefinition
    expect(contentIssues(fixed, [{ assetId: fixed.id, slot: 'SLOT_DESK_1', position: [0, 0, 0] }])).toContain(
      'Fixed instrument is not in its content-defined fixedSlot',
    )
  })
  it('requires complete, unique anchors', () => {
    const info = validModule()
    info.anchors.push(info.anchors[0] as GlbInspection['anchors'][number])
    expect(validateAsset(module, info)).toContain('Duplicate interaction anchors')
    info.anchors = []
    expect(validateAsset(module, info)).toContain('GLB interaction anchors differ from the layout catalog')
  })
  it('detects misplaced and inward-facing jacks', () => {
    const info = validModule()
    const jack = info.anchors[0]
    if (!jack) throw new Error('Fixture needs a jack')
    jack.position[0] = 99
    jack.normal[2] = -1
    expect(validateAsset(module, info).some((issue) => issue.includes('panel XY'))).toBe(true)
    expect(validateAsset(module, info).some((issue) => issue.includes('face +Z'))).toBe(true)
  })
  it('rejects triangle, texture and coordinate budget regressions', () => {
    const info = validModule()
    info.triangles = 60_000
    info.textures[0] = { mimeType: 'image/webp', width: 4096, height: 4096 }
    info.bounds.min[1] = -1
    const errors = validateAsset(module, info)
    expect(errors.some((issue) => issue.includes('Triangle budget'))).toBe(true)
    expect(errors.some((issue) => issue.includes('Texture exceeds'))).toBe(true)
    expect(errors.some((issue) => issue.includes('Y=0'))).toBe(true)
    const component = catalog.assets.find((asset) => asset.componentStyle === 'resistor') as AssetDefinition
    expect(
      validateAsset({ ...component, triangleBudget: 100_000 }, info).some((issue) => issue.includes('hard PRD limit')),
    ).toBe(true)
  })
  it('validates every shipped GLB, provenance and current content/netlist anchors', () => {
    const report = lintAssets()
    expect(report.issues).toEqual([])
    expect(report.assets).toHaveLength(catalog.assets.length)
    expect(report.assets.map((asset) => asset.id)).toEqual(
      expect.arrayContaining([...REQUIRED_BASELINE_ASSET_IDS, 'tool-pliers']),
    )
    expect(report.preview.drawCalls).toBeLessThanOrEqual(100)
    expect(report.preview.triangles).toBeLessThanOrEqual(150_000)
  })
})

describe('GLB binary verification', () => {
  it('rejects invalid and truncated headers', () => {
    expect(() => parseGlb(Buffer.from('not a GLB'))).toThrow('GLB')
    const buffer = readFileSync(workspacePath(module.model))
    expect(() => parseGlb(buffer.subarray(0, buffer.length - 4))).toThrow('length')
  })
  it('rejects external textures and decoder extensions', () => {
    const glb = parseGlb(readFileSync(workspacePath(module.model)))
    glb.json.images = [{ uri: 'https://example.com/texture.png' }]
    expect(() => inspectGlb(glb)).toThrow('embedded')
    glb.json.images = []
    glb.json.extensionsRequired = ['KHR_draco_mesh_compression']
    expect(() => inspectGlb(glb)).toThrow('decoder')
  })
  it('reads actual embedded WebP dimensions', () => {
    const image = readFileSync(workspacePath('content/modules/mod-dc-circuit/panel.webp'))
    expect(webpSize(image)).toEqual(module.textureSize)
    expect(() => webpSize(Buffer.from('not WebP'))).toThrow('WebP')
  })
})
