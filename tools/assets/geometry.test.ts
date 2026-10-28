import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildAsset } from './geometry.ts'
import { REQUIRED_BASELINE_ASSET_IDS } from './lint.ts'
import { panelSvg } from './panels.ts'
import type { AssetCatalog, AssetDefinition } from './types.ts'

const catalog = JSON.parse(
  readFileSync(new URL('../../assets/layouts/catalog.json', import.meta.url), 'utf8'),
) as AssetCatalog
const procedural = catalog.assets.filter((definition) => !definition.sourceFile)

function meshStats(root: THREE.Group): { drawCalls: number; triangles: number } {
  let drawCalls = 0
  let triangles = 0
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    drawCalls += Array.isArray(node.material) ? node.material.length : 1
    triangles += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3
  })
  return { drawCalls, triangles }
}

function byId(id: string): AssetDefinition {
  const definition = catalog.assets.find((asset) => asset.id === id)
  if (!definition) throw new Error(`Missing catalog fixture ${id}`)
  return definition
}

describe('procedural asset catalog', () => {
  it('contains the requested 18 originals without using the archived CAD files as a build dependency', () => {
    const baseline = REQUIRED_BASELINE_ASSET_IDS.map(byId)
    expect(baseline.every((asset) => !asset.sourceFile)).toBe(true)
    expect(baseline.filter((asset) => asset.kind === 'bench')).toHaveLength(1)
    expect(baseline.filter((asset) => asset.kind === 'module')).toHaveLength(1)
    expect(baseline.filter((asset) => asset.kind === 'instrument')).toHaveLength(6)
    expect(baseline.filter((asset) => asset.kind === 'component')).toHaveLength(10)
    expect(new Set(catalog.assets.map((asset) => asset.id)).size).toBe(catalog.assets.length)
    expect(new Set(catalog.assets.map((asset) => asset.model)).size).toBe(catalog.assets.length)
    expect(catalog.schemaVersion).toBe(1)
  })

  it('retains every existing content port, control, and archived DC panel coordinate', () => {
    for (const definition of procedural.filter((asset) => asset.kind === 'module' || asset.kind === 'instrument')) {
      if (definition.bodyStyle === 'scope' || definition.bodyStyle === 'generator') continue
      const path = definition.model.replace(/\.glb$/, '.json')
      const content = JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as {
        jacks: { id: string; label: string }[]
        controls?: { id: string; param: string }[]
      }
      expect(definition.jacks.map(({ id, label }) => ({ id, label }))).toEqual(
        content.jacks.map(({ id, label }) => ({ id, label })),
      )
      for (const control of content.controls ?? []) {
        expect(definition.controls.find((item) => item.id === control.id)?.param).toBe(control.param)
      }
    }
    const rows = readFileSync(new URL('../../assets/kicad/mod-dc-circuit/jacks.csv', import.meta.url), 'utf8')
      .trim()
      .split(/\r?\n/)
      .slice(1)
    const definition = byId('mod-dc-circuit')
    for (const row of rows) {
      const [, id, , x, y] = row.split(',')
      expect(definition.jacks.find((jack) => jack.id === id)).toMatchObject({ x: Number(x), y: Number(y) })
    }
  })

  it('keeps the three fixed instruments in console slots, and desk instruments above the worktop', () => {
    const slots = byId('bench').slots ?? []
    for (const placement of catalog.preview.placements.filter((item) => item.slot)) {
      const slot = slots.find((candidate) => candidate.id === placement.slot)
      expect(slot).toBeDefined()
      expect(slot?.position).toEqual(placement.position)
      const definition = byId(placement.assetId)
      if (definition.mounting === 'fixed') {
        expect(slot?.kind).toBe('fixed')
        expect(placement.position[1]).toBeGreaterThan(0.8)
        expect(placement.position[2]).toBeLessThan(-0.2)
      } else if (definition.mounting === 'desktop') {
        expect(slot?.kind).toBe('desktop')
        expect(placement.position[1]).toBe(0.8)
      }
    }
  })

  it('rejects imported source entries rather than inventing substitute geometry', () => {
    const imported = catalog.assets.find((asset) => asset.sourceFile)
    expect(imported).toBeDefined()
    if (imported) expect(() => buildAsset(imported)).toThrow('source-file importer')
  })
})

describe('procedural geometry', () => {
  it.each(procedural.map((definition) => [definition.id, definition] as const))(
    '%s has unique semantic nodes, finite geometry, and installation-plane origin',
    (_id, definition) => {
      const before = JSON.stringify(definition)
      const root = buildAsset(definition)
      expect(root.position.toArray()).toEqual([0, 0, 0])
      expect(root.scale.toArray()).toEqual([1, 1, 1])
      const bounds = new THREE.Box3().setFromObject(root)
      expect(bounds.min.y).toBeCloseTo(0, 6)
      expect(bounds.isEmpty()).toBe(false)
      const names: string[] = []
      root.traverse((node) => {
        if (/^(JACK|KNOB|SW|SCREEN|LED|SLOT)_/.test(node.name)) names.push(node.name)
        if (!(node instanceof THREE.Mesh)) return
        expect(Array.isArray(node.material)).toBe(false)
        const geometry: THREE.BufferGeometry = node.geometry
        for (const attribute of Object.values(geometry.attributes)) {
          expect(Array.from(attribute.array).every(Number.isFinite)).toBe(true)
        }
      })
      expect(new Set(names).size).toBe(names.length)
      const [width, height, depth] = definition.dimensionsMm
      for (const jack of definition.jacks) {
        const node = root.getObjectByName(`JACK_${jack.id}`)
        expect(node).toBeInstanceOf(THREE.Group)
        expect(node?.position.x).toBeCloseTo((jack.x - width / 2) / 1000, 8)
        expect(node?.position.y).toBeCloseTo((height - jack.y) / 1000, 8)
        expect(node?.position.z).toBeGreaterThan(depth / 2000)
        expect(node?.quaternion.toArray()).toEqual([0, 0, 0, 1])
        expect(node?.userData.label).toBe(jack.label)
      }
      for (const control of definition.controls) {
        const prefix = control.kind === 'knob' ? 'KNOB' : 'SW'
        const node = root.getObjectByName(`${prefix}_${control.id}`)
        expect(node).toBeInstanceOf(THREE.Group)
        expect(node?.children.length).toBeGreaterThan(0)
      }
      for (const screen of definition.screens) {
        const node = root.getObjectByName(`SCREEN_${screen.id}`)
        expect(node).toBeInstanceOf(THREE.Group)
        const display = node?.getObjectByName(`DISPLAY_${screen.id}`)
        expect(display).toBeInstanceOf(THREE.Mesh)
        expect(display?.userData).toMatchObject({ powered: false, dynamicTextureTarget: true })
      }
      expect(JSON.stringify(definition)).toBe(before)
    },
  )

  it('fits each component to the declared meter-scale envelope and stays within 1500 triangles', () => {
    for (const definition of procedural.filter((asset) => asset.kind === 'component')) {
      const root = buildAsset(definition)
      const bounds = new THREE.Box3().setFromObject(root)
      const size = bounds.getSize(new THREE.Vector3())
      for (const [index, actual] of size.toArray().entries()) {
        expect(actual).toBeCloseTo((definition.dimensionsMm[index] ?? 0) / 1000, 7)
      }
      expect(bounds.min.x + bounds.max.x).toBeCloseTo(0, 7)
      expect(bounds.min.z + bounds.max.z).toBeCloseTo(0, 7)
      expect(meshStats(root).triangles).toBeLessThanOrEqual(1500)
    }
  })

  it('keeps panel silkscreen in front of the enclosure rather than hidden by the front badge', () => {
    for (const definition of procedural.filter((asset) => asset.kind === 'module' || asset.kind === 'instrument')) {
      const root = buildAsset(definition)
      const panel = root.getObjectByName('PANEL_silkscreen')
      if (!(panel instanceof THREE.Mesh)) throw new Error(`Missing panel on ${definition.id}`)
      const bounds = new THREE.Box3().setFromObject(panel)
      const point = new THREE.Vector3(0, bounds.max.y - 0.009, bounds.max.z + 0.1)
      const ray = new THREE.Raycaster(point, new THREE.Vector3(0, 0, -1))
      expect(ray.intersectObject(root, true)[0]?.object.name, definition.id).toBe('PANEL_silkscreen')
    }
  })

  it('leaves scene draw-call headroom below the PRD hard limits', () => {
    let draws = 0
    let triangles = 0
    for (const placement of catalog.preview.placements) {
      const counts = meshStats(buildAsset(byId(placement.assetId)))
      expect(counts.triangles).toBeLessThanOrEqual(5000)
      draws += counts.drawCalls
      triangles += counts.triangles
    }
    expect(draws).toBeLessThanOrEqual(70)
    expect(triangles).toBeLessThanOrEqual(150000)
  })
})

describe('panel SVG generation', () => {
  it('produces local, deterministic artwork within texture budgets', () => {
    for (const definition of procedural) {
      const svg = panelSvg(definition)
      expect(svg).toBe(panelSvg(definition))
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
      expect(svg).not.toMatch(/<image|<script|@import|href=|https:/)
      const limit = definition.kind === 'component' ? 512 : 2048
      for (const size of definition.textureSize ?? []) expect(size).toBeLessThanOrEqual(limit)
    }
  })

  it('escapes text instead of interpreting configuration labels as SVG markup', () => {
    const definition = structuredClone(byId('mod-dc-circuit'))
    definition.panel = { title: '<script>"unsafe" & \'quoted\'</script>' }
    const svg = panelSvg(definition)
    expect(svg).toContain('&lt;script&gt;&quot;unsafe&quot; &amp; &apos;quoted&apos;&lt;/script&gt;')
    expect(svg).not.toContain('<script>')
  })
})
