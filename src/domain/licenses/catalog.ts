// T3.4：纯 TS 第三方许可证与随包资产清单解析模块（无 React/Electron/Node I/O 依赖）。
// 唯一数据源为随包分发的 content/ASSET-LICENSES.csv、content/ASSET-NOTICES.md、
// resources/ngspice/LICENSE-NOTES.md 及各许可证全文，确保关于页与分发文件严格一致。

export interface AssetLicenseRow {
  assetId: string
  path: string
  source: string
  author: string
  license: string
  licenseUrl: string
  modified: string
  changes: string
  sha256: string
}

export interface NgspiceSourcePackage {
  name: string
  url: string
  sha256: string
}

export interface NgspiceShippedFile {
  file: string
  sourceCode: string
  license: string
  notes: string
}

export interface NgspiceLicenseSummary {
  verifiedDate: string
  sourceRepo: string
  sources: NgspiceSourcePackage[]
  files: NgspiceShippedFile[]
  excludesTableCmGpl: boolean
}

export interface BundledFontLicense {
  id: string
  name: string
  packageName: string
  author: string
  license: string
  usage: string
}

export interface AssetLicenseSummary {
  totalRows: number
  glbCount: number
  panelCount: number
  hdriCount: number
  projectOwnedCount: number
  thirdPartyRows: AssetLicenseRow[]
  licenseCounts: Record<string, number>
}

export const BUNDLED_FONT_LICENSES: readonly BundledFontLicense[] = [
  {
    id: 'font-noto-sans-sc',
    name: 'Noto Sans SC Variable',
    packageName: '@fontsource-variable/noto-sans-sc',
    author: 'Google Inc.',
    license: 'SIL OFL 1.1',
    usage: '全应用中文字体与 3D 面板丝印内嵌子集（本地离线）',
  },
  {
    id: 'font-jetbrains-mono',
    name: 'JetBrains Mono Variable',
    packageName: '@fontsource-variable/jetbrains-mono',
    author: 'The JetBrains Mono Project Authors',
    license: 'SIL OFL 1.1',
    usage: '等宽数值、数据记录表、状态栏与项目编号（本地离线）',
  },
  {
    id: 'font-dseg7',
    name: 'DSEG7 Classic',
    packageName: 'dseg',
    author: 'keshikan (Reserved Font Name "DSEG")',
    license: 'SIL OFL 1.1',
    usage: '虚拟仪表七段液晶主读数显示（本地离线）',
  },
  {
    id: 'font-katex',
    name: 'KaTeX & KaTeX Fonts',
    packageName: 'katex',
    author: 'Khan Academy and other contributors',
    license: 'MIT / SIL OFL 1.1',
    usage: '实训指导书与学习资源数学公式离线排版',
  },
] as const

export const BUNDLED_SPICE_LIBRARY_FILES: readonly string[] = [
  'bjt.lib',
  'cmos.lib',
  'diodes.lib',
  'fet.lib',
  'opamp.lib',
  'power.lib',
  'regulators.lib',
  'sensors.lib',
  'timers.lib',
  'ttl.lib',
] as const

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells
}

export function parseAssetLicensesCsv(csvText: string): AssetLicenseRow[] {
  const lines = csvText
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length <= 1) return []
  const rows: AssetLicenseRow[] = []
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    if (cells.length < 9) continue
    rows.push({
      assetId: cells[0] ?? '',
      path: cells[1] ?? '',
      source: cells[2] ?? '',
      author: cells[3] ?? '',
      license: cells[4] ?? '',
      licenseUrl: cells[5] ?? '',
      modified: cells[6] ?? '',
      changes: cells[7] ?? '',
      sha256: cells[8] ?? '',
    })
  }
  return rows
}

export function summarizeAssetLicenses(rows: readonly AssetLicenseRow[]): AssetLicenseSummary {
  const licenseCounts: Record<string, number> = {}
  const thirdPartyRows: AssetLicenseRow[] = []
  let glbCount = 0
  let panelCount = 0
  let hdriCount = 0
  let projectOwnedCount = 0

  for (const row of rows) {
    licenseCounts[row.license] = (licenseCounts[row.license] ?? 0) + 1
    if (row.path.endsWith('.glb')) glbCount++
    else if (row.path.endsWith('.hdr')) hdriCount++
    else if (row.path.endsWith('.svg') || row.path.endsWith('.webp')) panelCount++

    if (row.license === 'LicenseRef-Project-Owned') projectOwnedCount++
    else thirdPartyRows.push(row)
  }

  return {
    totalRows: rows.length,
    glbCount,
    panelCount,
    hdriCount,
    projectOwnedCount,
    thirdPartyRows,
    licenseCounts,
  }
}

function parseMarkdownTableRows(sectionText: string): string[][] {
  const rows: string[][] = []
  const lines = sectionText.replaceAll('\r\n', '\n').split('\n')
  let inTable = false
  let skippedSeparator = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('|')) {
      if (inTable) break
      continue
    }
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim())
    if (!inTable) {
      inTable = true
      continue
    }
    if (!skippedSeparator && cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      skippedSeparator = true
      continue
    }
    rows.push(cells)
  }
  return rows
}

function extractSection(mdText: string, heading: string): string {
  const normalized = mdText.replaceAll('\r\n', '\n')
  const marker = `## ${heading}`
  const start = normalized.indexOf(marker)
  if (start < 0) return ''
  const after = normalized.slice(start + marker.length)
  const next = after.search(/\n## /)
  return next < 0 ? after : after.slice(0, next)
}

function stripBackticks(value: string): string {
  return value.replaceAll('`', '').trim()
}

export function parseNgspiceLicenseNotes(mdText: string): NgspiceLicenseSummary {
  const normalized = mdText.replaceAll('\r\n', '\n')
  const dateMatch = /核对日期：([^\s。]+)/.exec(normalized)
  const repoMatch = /源码仓库：(https?:\/\/\S+)/.exec(normalized)

  const sourceRows = parseMarkdownTableRows(extractSection(normalized, '来源'))
  const sources: NgspiceSourcePackage[] = sourceRows
    .filter((cells) => cells.length >= 3)
    .map((cells) => ({
      name: cells[0] ?? '',
      url: cells[1] ?? '',
      sha256: cells[2] ?? '',
    }))

  const fileRows = parseMarkdownTableRows(extractSection(normalized, '逐文件结论'))
  const files: NgspiceShippedFile[] = fileRows
    .filter((cells) => cells.length >= 4)
    .map((cells) => ({
      file: stripBackticks(cells[0] ?? ''),
      sourceCode: stripBackticks(cells[1] ?? ''),
      license: cells[2] ?? '',
      notes: cells[3] ?? '',
    }))

  const tableSection = extractSection(normalized, 'table.cm 结论')
  const excludesTableCmGpl = tableSection.includes('table.cm 为 GPLv2+，不分发')

  return {
    verifiedDate: dateMatch?.[1] ?? '',
    sourceRepo: repoMatch?.[1] ?? '',
    sources,
    files,
    excludesTableCmGpl,
  }
}

export function filterAssetLicenses(rows: readonly AssetLicenseRow[], query: string): AssetLicenseRow[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return [...rows]
  return rows.filter(
    (row) =>
      row.assetId.toLowerCase().includes(keyword) ||
      row.path.toLowerCase().includes(keyword) ||
      row.license.toLowerCase().includes(keyword) ||
      row.author.toLowerCase().includes(keyword) ||
      row.sha256.toLowerCase().includes(keyword),
  )
}
