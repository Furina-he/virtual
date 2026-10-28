import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { workspacePath } from './paths.ts'
import { importedSource, readSources } from './sources.ts'
import type { AssetDefinition } from './types.ts'

export function sha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(workspacePath(path)))
    .digest('hex')
}

export function writeLicenses(assets: AssetDefinition[]) {
  const sources = readSources()
  const rows: string[][] = [
    ['asset_id', 'path', 'source', 'author', 'license', 'license_url', 'modified', 'changes', 'sha256'],
  ]
  for (const asset of assets) {
    const source = importedSource(asset, sources)
    rows.push([
      asset.id,
      asset.model,
      source?.url ?? 'assets/layouts/catalog.json + tools/assets/geometry.ts',
      source?.author ?? 'Project authors',
      source?.license ?? 'LicenseRef-Project-Owned',
      source?.legalUrl ?? '',
      source ? 'yes' : 'original',
      source
        ? 'CC0 mesh only; neutral vertex colors replace all source textures/certification marks; height normalized to 0.2 m; bottom-center origin'
        : 'Original parameterized geometry and silkscreen; estimated dimensions; no third-party product logos',
      sha256(asset.model),
    ])
    if (asset.kind !== 'component' && !asset.sourceFile) {
      const base = asset.model.slice(0, asset.model.lastIndexOf('/'))
      for (const extension of ['svg', 'webp']) {
        const path = `${base}/panel.${extension}`
        rows.push([
          `${asset.id}-panel-${extension}`,
          path,
          'assets/layouts/catalog.json + tools/assets/panels.ts',
          'Project authors',
          'LicenseRef-Project-Owned',
          '',
          'original',
          'Original panel layout; not an electrical schematic',
          sha256(path),
        ])
      }
    }
  }
  const hdri = sources.find((source) => source.id === 'studio-small-09')
  if (!hdri?.files[0]) throw new Error('HDRI source metadata is missing')
  rows.push([
    hdri.id,
    hdri.files[0].path,
    hdri.url,
    hdri.author,
    hdri.license,
    hdri.legalUrl,
    'no',
    'Original 1k HDRI',
    sha256(hdri.files[0].path),
  ])
  const csv = `${rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n')}\n`
  writeFileSync(workspacePath('assets/LICENSES.csv'), csv)
  writeFileSync(workspacePath('content/ASSET-LICENSES.csv'), csv)
  copyFileSync(
    workspacePath('node_modules/@fontsource-variable/noto-sans-sc/LICENSE'),
    workspacePath('content/ASSET-FONT-OFL.txt'),
  )
  writeFileSync(
    workspacePath('content/ASSET-NOTICES.md'),
    `# Asset Notices\n\nGenerated geometry, layout and silkscreen are project-authored (LicenseRef-Project-Owned); this label does not grant a new public license. See ASSET-LICENSES.csv for all shipped model/texture hashes.\n\n` +
      sources
        .map(
          (source) =>
            `## ${source.name}\n\nAuthor: ${source.author}. Source: ${source.url}\nLicense: ${source.license} (${source.legalUrl}). Publisher policy: ${source.licenseUrl}\n\n${source.id === 'tool-pliers' ? 'Only the mesh is reused. All original textures and certification marks are replaced by neutral vertex colors; dimensions and origin are normalized. This visual model makes no insulation, safety-rating or certification claim.' : 'Original unmodified 1k studio lighting, bundled for offline use.'}\n`,
        )
        .join('\n') +
      '\nPanel SVGs embed local Noto Sans SC subsets from @fontsource-variable/noto-sans-sc (SIL OFL 1.1). See ASSET-FONT-OFL.txt for the font copyright and license. CC0 legal text is bundled as ASSET-CC0-1.0.txt. Manufacturer reference photographs and archived KiCad files are development-only and are not included in the application.\n',
  )
}
