import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_FONT_LICENSES,
  BUNDLED_SPICE_LIBRARY_FILES,
  filterAssetLicenses,
  parseAssetLicensesCsv,
  parseNgspiceLicenseNotes,
  summarizeAssetLicenses,
} from './catalog'

const ROOT = resolve(__dirname, '../../..')

function listFilesRecursive(dir: string, baseDir = dir): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...listFilesRecursive(full, baseDir))
    else result.push(relative(baseDir, full).replaceAll('\\', '/'))
  }
  return result.sort()
}

describe('T3.4 第三方许可证与随包清单一致性校验', () => {
  const sourceCsv = readFileSync(join(ROOT, 'assets/LICENSES.csv'), 'utf8')
  const bundledCsv = readFileSync(join(ROOT, 'content/ASSET-LICENSES.csv'), 'utf8')
  const assetNotices = readFileSync(join(ROOT, 'content/ASSET-NOTICES.md'), 'utf8')
  const cc0Text = readFileSync(join(ROOT, 'content/ASSET-CC0-1.0.txt'), 'utf8')
  const oflText = readFileSync(join(ROOT, 'content/ASSET-FONT-OFL.txt'), 'utf8')
  const ngspiceNotes = readFileSync(join(ROOT, 'resources/ngspice/LICENSE-NOTES.md'), 'utf8')
  const ngspiceCopying = readFileSync(join(ROOT, 'resources/ngspice/COPYING'), 'utf8')
  const ngspiceThirdParty = readFileSync(join(ROOT, 'resources/ngspice/THIRD-PARTY-LICENSES.txt'), 'utf8')

  it('assets/LICENSES.csv 与随包 content/ASSET-LICENSES.csv 逐字节一致且无旧 KiCad/参考图路径', () => {
    expect(bundledCsv).toBe(sourceCsv)
    const rows = parseAssetLicensesCsv(bundledCsv)
    const summary = summarizeAssetLicenses(rows)

    expect(rows.length).toBeGreaterThanOrEqual(160)
    expect(summary.glbCount).toBe(71)
    expect(summary.hdriCount).toBe(1)
    expect(summary.thirdPartyRows.map((row) => row.assetId).sort()).toEqual(['studio-small-09', 'tool-pliers'])
    for (const row of rows) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(row.path.toLowerCase()).not.toContain('kicad')
      expect(row.path.toLowerCase()).not.toContain('assets/reference')
    }
    expect(assetNotices).toContain('Studio Small 09')
    expect(assetNotices).toContain('Pliers')
    expect(assetNotices).toContain('archived KiCad files are development-only and are not included')
    expect(cc0Text).toContain('CC0 1.0 Universal')
    expect(oflText).toContain('SIL OPEN FONT LICENSE Version 1.1')
  })

  it('resources/ngspice/ 磁盘文件与 LICENSE-NOTES.md 逐文件结论一一对应且严禁分发 GPL table.cm', () => {
    const parsed = parseNgspiceLicenseNotes(ngspiceNotes)
    expect(parsed.excludesTableCmGpl).toBe(true)
    expect(parsed.sources.length).toBe(3)
    expect(parsed.sourceRepo).toContain('sourceforge.net/p/ngspice')

    const onDisk = listFilesRecursive(join(ROOT, 'resources/ngspice')).filter((file) => file !== 'LICENSE-NOTES.md')
    const documented = parsed.files.map((item) => item.file).sort()

    expect(onDisk).toEqual(documented)
    expect(onDisk.some((file) => file.toLowerCase().includes('table.cm'))).toBe(false)
    expect(onDisk.some((file) => file.toLowerCase().endsWith('.osdi'))).toBe(false)

    // 许可证全文完整覆盖：Modified BSD、XSPICE、LGPL 2.1（KLU/numparam/libsndfile）、BSD-2（libsamplerate）、Apache-2.0 LLVM-exception（libomp）
    expect(ngspiceCopying).toContain("Modified BSD'")
    expect(ngspiceCopying).toContain('GNU LESSER GENERAL PUBLIC LICENSE')
    expect(ngspiceThirdParty).toContain('BSD 2-Clause License')
    expect(ngspiceThirdParty).toContain('libsamplerate')
    expect(ngspiceThirdParty).toContain('Apache License')
    expect(ngspiceThirdParty).toContain('LLVM Exceptions')
  })

  it('本地字体与 SPICE 器件模型库声明齐全，无外部厂商 SPICE 拷贝', () => {
    expect(BUNDLED_FONT_LICENSES.map((font) => font.id)).toEqual([
      'font-noto-sans-sc',
      'font-jetbrains-mono',
      'font-dseg7',
      'font-katex',
    ])

    const spiceDir = join(ROOT, 'content/models/spice')
    const spiceFiles = readdirSync(spiceDir)
      .filter((name) => name.endsWith('.lib'))
      .sort()
    expect(spiceFiles).toEqual([...BUNDLED_SPICE_LIBRARY_FILES])

    for (const file of spiceFiles) {
      const header = readFileSync(join(spiceDir, file), 'utf8').slice(0, 1200)
      expect(header, `${file} 必须声明来源`).toMatch(/来源|自行/)
    }
  })

  it('资产许可检索过滤支持按 ID、路径、许可证与哈希定位', () => {
    const rows = parseAssetLicensesCsv(bundledCsv)
    expect(
      filterAssetLicenses(rows, 'CC0-1.0')
        .map((row) => row.assetId)
        .sort(),
    ).toEqual(['studio-small-09', 'tool-pliers'])
    expect(filterAssetLicenses(rows, 'bench.glb').map((row) => row.assetId)).toEqual(['bench'])
    expect(filterAssetLicenses(rows, '').length).toBe(rows.length)
  })
})
