import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Euler, Quaternion, Vector3 } from 'three'
import { Instrument } from '../../src/shared/schema/instrument.ts'
import { BenchScene } from '../../src/shared/schema/scene.ts'
import { type GlbInspection, inspectGlb, parseGlb } from './glb.ts'
import { modelOutputPath, workspacePath } from './paths.ts'
import { sha256 } from './provenance.ts'
import { checkSources, importedSource } from './sources.ts'
import type { AssetCatalog, AssetDefinition, AssetPlacement } from './types.ts'

export type AssetAudit = GlbInspection & { id: string; model: string; bytes: number; sha256: string }
export type AssetReport = {
  schemaVersion: 1
  assets: AssetAudit[]
  preview: { triangles: number; drawCalls: number }
  issues: string[]
}

export const REQUIRED_BASELINE_ASSET_IDS = [
  'bench',
  'mod-dc-circuit',
  'ins-dc-voltmeter',
  'ins-dc-ammeter',
  'ins-multimeter',
  'ins-dc-power',
  'ins-oscilloscope',
  'ins-func-gen',
  'cmp-resistor',
  'cmp-diode',
  'cmp-capacitor-ceramic',
  'cmp-capacitor-electrolytic',
  'cmp-led',
  'cmp-transistor-to92',
  'cmp-potentiometer',
  'cmp-switch',
  'cmp-dip8',
  'cmp-banana-jack',
] as const

export function baselineAssetIssues(assets: readonly Pick<AssetDefinition, 'id'>[]): string[] {
  const ids = new Set(assets.map((asset) => asset.id))
  return REQUIRED_BASELINE_ASSET_IDS.filter((id) => !ids.has(id)).map((id) => `Missing required baseline asset: ${id}`)
}

export function subcircuitPorts(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*\*/.test(line))
  const logical = lines.join('\n').replace(/\n\s*\+\s*/g, ' ')
  const declaration = logical.match(/^\s*\.subckt\s+\S+\s+([^\r\n]+)/im)?.[1]
  if (!declaration) throw new Error('Netlist has no .subckt declaration')
  return (
    declaration
      .split(/\bparams\s*:/i)[0]
      ?.trim()
      .split(/\s+/)
      .filter(Boolean) ?? []
  )
}

function sameIds(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && [...actual].sort().join('\n') === [...expected].sort().join('\n')
}

export function expectedAnchors(asset: AssetDefinition): string[] {
  return [
    ...asset.jacks.map((jack) => `JACK_${jack.id}`),
    ...asset.controls.map((control) => `${control.kind === 'knob' ? 'KNOB' : 'SW'}_${control.id}`),
    ...asset.screens.map((screen) => `SCREEN_${screen.id}`),
    ...(asset.leds ?? []).map((led) => `LED_${led.id}`),
    ...(asset.slots ?? []).map((slot) => slot.id),
  ]
}

export function validateAsset(asset: AssetDefinition, info: GlbInspection): string[] {
  const issues: string[] = []
  const names = info.anchors.map((anchor) => anchor.name)
  if (new Set(names).size !== names.length) issues.push('Duplicate interaction anchors')
  if (!sameIds(names, expectedAnchors(asset))) issues.push('GLB interaction anchors differ from the layout catalog')
  const hardLimit =
    asset.kind === 'component' ? (asset.model.startsWith('content/models/tools/') ? 5000 : 1500) : 50_000
  if (asset.triangleBudget !== undefined && asset.triangleBudget > hardLimit)
    issues.push('Declared triangle budget exceeds the hard PRD limit')
  if (info.triangles > Math.min(asset.triangleBudget ?? hardLimit, hardLimit)) {
    issues.push(`Triangle budget exceeded: ${info.triangles}`)
  }
  const textureLimit = asset.kind === 'component' ? 512 : 2048
  for (const texture of info.textures) {
    if (texture.width > textureLimit || texture.height > textureLimit) issues.push(`Texture exceeds ${textureLimit}px`)
  }
  const [minX = 0, minY = 0, minZ = 0] = info.bounds.min
  const [maxX = 0, maxY = 0, maxZ = 0] = info.bounds.max
  if (Math.abs(minY) > 0.002) issues.push(`Bottom installation origin is not Y=0: ${minY}`)
  if (Math.abs((minX + maxX) / 2) > 0.01) issues.push('Asset is not horizontally centered on X=0')
  const measured = [maxX - minX, maxY - minY, maxZ - minZ]
  asset.dimensionsMm.forEach((mm, i) => {
    const size = measured[i] ?? 0
    // Small front controls/feet may protrude from the specified housing dimensions.
    if (size < (mm / 1000) * 0.75 || size > (mm / 1000) * 1.5 + 0.02) {
      issues.push(`Axis ${i} differs from declared meter dimensions: ${size} m vs ${mm} mm`)
    }
  })
  for (const jack of asset.jacks) {
    const anchor = info.anchors.find((entry) => entry.name === `JACK_${jack.id}`)
    if (!anchor) continue
    const x = (jack.x - asset.dimensionsMm[0] / 2) / 1000
    const y = (asset.dimensionsMm[1] - jack.y) / 1000
    if (Math.abs((anchor.position[0] ?? 0) - x) > 0.0002 || Math.abs((anchor.position[1] ?? 0) - y) > 0.0002) {
      issues.push(`JACK_${jack.id} differs from the panel XY coordinates`)
    }
    if ((anchor.normal[2] ?? 0) < 0.999 || (anchor.position[2] ?? 0) < asset.dimensionsMm[2] / 2000 - 0.001) {
      issues.push(`JACK_${jack.id} must face +Z on the front mounting plane`)
    }
  }
  for (const slot of asset.slots ?? []) {
    const anchor = info.anchors.find((entry) => entry.name === slot.id)
    if (anchor && slot.position.some((value, i) => Math.abs(value - (anchor.position[i] ?? 0)) > 0.0002)) {
      issues.push(`${slot.id} differs from its declared placement transform`)
    }
  }
  return issues
}

export function contentIssues(asset: AssetDefinition, placements: AssetPlacement[]): string[] {
  const issues: string[] = []
  if (asset.kind !== 'module' && asset.kind !== 'instrument') return issues
  const base = dirname(asset.model).replaceAll('\\', '/')
  const file = `${base}/${asset.kind === 'module' ? 'module' : 'instrument'}.json`
  if (!existsSync(workspacePath(file))) {
    // Scope/generator logic is intentionally not invented during asset production.
    if (asset.kind === 'module') issues.push(`Missing authoritative module content: ${file}`)
    return issues
  }
  const definition = JSON.parse(readFileSync(workspacePath(file), 'utf8')) as {
    id: string
    model: string
    netlist?: string
    mounting?: string
    fixedSlot?: string
    jacks: { id: string }[]
    controls?: { id: string; kind: string; param: string }[]
  }
  if (definition.id !== asset.id || `${base}/${definition.model}` !== asset.model)
    issues.push('Content model reference differs from catalog')
  if (asset.jacks.map((jack) => jack.id).join('\n') !== definition.jacks.map((jack) => jack.id).join('\n'))
    issues.push('Layout jacks differ from content JSON')
  if (definition.mounting && definition.mounting !== asset.mounting)
    issues.push('Fixed/desktop mounting differs from content JSON')
  if (definition.mounting === 'fixed') {
    const placed = placements.filter((entry) => entry.assetId === asset.id)
    if (placed.length !== 1 || placed[0]?.slot !== definition.fixedSlot)
      issues.push('Fixed instrument is not in its content-defined fixedSlot')
  }
  if (definition.controls) {
    if (
      !sameIds(
        asset.controls.map((control) => control.id),
        definition.controls.map((control) => control.id),
      )
    )
      issues.push('Layout controls differ from module JSON')
    for (const control of definition.controls) {
      if (asset.controls.find((entry) => entry.id === control.id)?.param !== control.param)
        issues.push(`Control ${control.id} parameter mapping differs`)
    }
  }
  if (definition.netlist) {
    const ports = subcircuitPorts(readFileSync(workspacePath(`${base}/${definition.netlist}`), 'utf8'))
    if (ports.join('\n') !== asset.jacks.map((jack) => jack.id).join('\n'))
      issues.push('SPICE .subckt port order differs from JACK_ layout order')
  }
  return issues
}

export function validateScene(
  input: unknown,
  catalog: AssetCatalog,
  instruments: readonly Pick<Instrument, 'id' | 'mounting' | 'fixedSlot'>[],
): string[] {
  const result = BenchScene.safeParse(input)
  if (!result.success) return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  const scene = result.data
  const issues: string[] = []
  const assets = new Map(catalog.assets.map((asset) => [asset.id, asset]))
  const benches = scene.placements.filter((placement) => assets.get(placement.assetId)?.kind === 'bench')
  const bench = benches[0]
  if (benches.length !== 1 || !bench) return ['Scene must place exactly one known bench asset']
  if (scene.id !== bench.assetId) issues.push('Scene id differs from its bench asset')
  const rotation = new Euler(...(bench.rotation ?? [0, 0, 0]))
  const orientation = new Quaternion().setFromEuler(rotation)
  const slots = new Map((assets.get(bench.assetId)?.slots ?? []).map((slot) => [slot.id, slot]))
  const occupied = new Set<string>()
  scene.placements.forEach((placement, index) => {
    const prefix = `placements.${index}`
    const asset = assets.get(placement.assetId)
    if (!asset) {
      issues.push(`${prefix}.assetId: Unknown scene asset ${placement.assetId}`)
      return
    }
    const instrument = instruments.find((entry) => entry.id === asset.id)
    if (instrument && instrument.mounting !== asset.mounting)
      issues.push(`${prefix}: Instrument mounting differs from content`)
    if (!placement.slot) {
      if (asset.kind === 'module' || asset.kind === 'instrument') issues.push(`${prefix}.slot: Missing placement slot`)
      return
    }
    const slot = slots.get(placement.slot)
    if (!slot) {
      issues.push(`${prefix}.slot: Unknown bench slot ${placement.slot}`)
      return
    }
    if (occupied.has(slot.id)) issues.push(`${prefix}.slot: Bench slot ${slot.id} is already occupied`)
    occupied.add(slot.id)
    const kind = asset.kind === 'module' ? 'module' : asset.kind === 'instrument' ? asset.mounting : 'desktop'
    if (kind !== slot.kind) issues.push(`${prefix}.slot: Slot kind ${slot.kind} is incompatible with ${asset.id}`)
    const expected = new Vector3(...slot.position).applyEuler(rotation).add(new Vector3(...bench.position))
    if (expected.distanceTo(new Vector3(...placement.position)) > 0.0002)
      issues.push(`${prefix}.position: Placement differs from the world-space bench slot`)
    if (slot.kind !== 'desktop') {
      const actual = new Quaternion().setFromEuler(new Euler(...(placement.rotation ?? [0, 0, 0])))
      if (orientation.angleTo(actual) > 0.0002)
        issues.push(`${prefix}.rotation: Fixed/module orientation differs from bench`)
    }
  })
  for (const asset of catalog.assets.filter((entry) => entry.kind === 'instrument' && entry.mounting === 'fixed')) {
    const instrument = instruments.find((entry) => entry.id === asset.id)
    if (instrument?.mounting !== 'fixed' || !instrument.fixedSlot) {
      issues.push(`${asset.id}: Missing authoritative fixed instrument content`)
      continue
    }
    const placed = scene.placements.filter((placement) => placement.assetId === asset.id)
    if (placed.length !== 1 || placed[0]?.instanceId !== instrument.id || placed[0]?.slot !== instrument.fixedSlot)
      issues.push(`${asset.id}: Fixed instrument requires one placement with its content id and fixedSlot`)
  }
  return issues
}

export function lintAssets(): AssetReport {
  const report: AssetReport = {
    schemaVersion: 1,
    assets: [],
    preview: { triangles: 0, drawCalls: 0 },
    issues: checkSources(),
  }
  const catalog: AssetCatalog = JSON.parse(readFileSync(workspacePath('assets/layouts/catalog.json'), 'utf8'))
  if (catalog.schemaVersion !== 1) report.issues.push('Unsupported asset catalog schema')
  report.issues.push(...baselineAssetIssues(catalog.assets))
  if (new Set(catalog.assets.map((asset) => asset.id)).size !== catalog.assets.length)
    report.issues.push('Duplicate asset ids')
  if (new Set(catalog.assets.map((asset) => asset.model)).size !== catalog.assets.length)
    report.issues.push('Duplicate model output paths')
  let scenePlacements: AssetPlacement[] | undefined
  try {
    const instruments = catalog.assets
      .filter((asset) => asset.kind === 'instrument')
      .flatMap((asset) => {
        const path = workspacePath(`${dirname(asset.model).replaceAll('\\', '/')}/instrument.json`)
        return existsSync(path) ? [Instrument.parse(JSON.parse(readFileSync(path, 'utf8')))] : []
      })
    const scene = BenchScene.parse(JSON.parse(readFileSync(workspacePath('content/bench/scene.json'), 'utf8')))
    scenePlacements = scene.placements
    report.issues.push(
      ...validateScene(scene, catalog, instruments).map((issue) => `content/bench/scene.json: ${issue}`),
    )
  } catch (error) {
    report.issues.push(`content/bench/scene.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const asset of catalog.assets) {
    try {
      importedSource(asset)
      const bytes = readFileSync(modelOutputPath(asset.model))
      const inspection = inspectGlb(parseGlb(bytes))
      const errors = [
        ...validateAsset(asset, inspection),
        ...contentIssues(asset, scenePlacements ?? catalog.preview.placements),
      ]
      report.issues.push(...errors.map((error) => `${asset.id}: ${error}`))
      report.assets.push({
        id: asset.id,
        model: asset.model,
        bytes: bytes.length,
        sha256: sha256(asset.model),
        ...inspection,
      })
    } catch (error) {
      report.issues.push(`${asset.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const placement of scenePlacements ?? catalog.preview.placements) {
    const asset = report.assets.find((entry) => entry.id === placement.assetId)
    if (!asset) report.issues.push(`Preview refers to missing asset ${placement.assetId}`)
    else {
      report.preview.triangles += asset.triangles
      report.preview.drawCalls += asset.drawCalls
    }
    if (!scenePlacements && placement.slot) {
      const slot = catalog.assets.flatMap((entry) => entry.slots ?? []).find((entry) => entry.id === placement.slot)
      if (!slot || slot.position.some((value, i) => Math.abs(value - (placement.position[i] ?? 0)) > 0.0002)) {
        report.issues.push(`Preview placement ${placement.assetId} differs from ${placement.slot}`)
      }
    }
  }
  if (report.preview.triangles > 150_000) report.issues.push('Preview exceeds 150000 triangles')
  if (report.preview.drawCalls > 100)
    report.issues.push('Preview exceeds 100 geometry draw calls before lights/shadows')
  for (const file of [
    'assets/LICENSES.csv',
    'content/ASSET-LICENSES.csv',
    'content/ASSET-NOTICES.md',
    'content/ASSET-CC0-1.0.txt',
    'content/ASSET-FONT-OFL.txt',
  ]) {
    if (!existsSync(workspacePath(file))) report.issues.push(`Missing attribution file: ${file}`)
  }
  if (existsSync(workspacePath('assets/LICENSES.csv'))) {
    const licenses = readFileSync(workspacePath('assets/LICENSES.csv'), 'utf8')
    for (const line of licenses.trim().split('\n').slice(1)) {
      const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => (match[1] ?? '').replaceAll('""', '"'))
      const [, path, , , , , , , checksum] = cells
      try {
        if (!path || sha256(path) !== checksum) report.issues.push(`Stale licensed asset hash: ${path}`)
      } catch {
        report.issues.push(`Missing licensed asset: ${path}`)
      }
    }
    for (const asset of report.assets) {
      const row = licenses.split('\n').find((line) => line.startsWith(`"${asset.id}",`))
      if (!row?.includes(`"${asset.model}"`) || !row?.includes(`"${asset.sha256}"`))
        report.issues.push(`Missing or stale license/hash row for ${asset.id}`)
    }
    const bundled = workspacePath('content/ASSET-LICENSES.csv')
    if (existsSync(bundled) && readFileSync(bundled, 'utf8') !== licenses)
      report.issues.push('Bundled asset licenses differ from source register')
  }
  return report
}

export function writeAssetManifest(): AssetReport {
  const report = lintAssets()
  const target = workspacePath('assets/generated/manifest.json')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const report = lintAssets()
  for (const issue of report.issues) console.error(issue)
  console.log(
    `${report.assets.length} GLBs; preview ${report.preview.triangles} triangles / ${report.preview.drawCalls} geometry draws; ${report.issues.length} issues`,
  )
  process.exitCode = report.issues.length ? 1 : 0
}
