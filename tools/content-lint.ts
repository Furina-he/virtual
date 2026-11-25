// pnpm content:lint：扫描 content/ 全部内容文件，按 schema 校验 JSON，
// 检查跨文件引用、项目 guide.md 六项结构、schematic.svg 存在性与学习资源四项 Markdown 章节（NFR-07）。
// 输出格式：<文件路径> <字段路径> <问题>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { z } from 'zod'
import { injectFault } from '../src/domain/circuit/fault.ts'
import { BenchScene, Instrument, LearnResource, Module, Project } from '../src/shared/schema/index.ts'

export type LintIssue = { file: string; path: string; message: string }

export const PROJECT_GUIDE_SECTIONS = ['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题'] as const

export const LEARN_SECTION_KEYS = ['structure', 'symbol', 'parameters', 'troubleshooting'] as const
export type LearnSectionKey = (typeof LEARN_SECTION_KEYS)[number]

export const LEARN_SECTION_LABELS: Record<LearnSectionKey, string> = {
  structure: '结构原理',
  symbol: '符号识别',
  parameters: '参数计算',
  troubleshooting: '故障处理',
}

export const LEARN_MODEL_REQUIRED_CATEGORIES = new Set<LearnResource['category']>([
  'component',
  'ic',
  'instrument-tool',
])

export type MarkdownSection = {
  title: string
  line: number
  body: string
}

const SCHEMAS: Record<string, z.ZodType> = {
  'module.json': Module,
  'instrument.json': Instrument,
  'project.json': Project,
  'scene.json': BenchScene,
  'resource.json': LearnResource,
}

const EXTERNAL_MARKDOWN_MEDIA_RE =
  /!\[[^\]]*\]\(\s*<?https?:\/\/|<\s*(?:img|iframe|script|audio|video|source)\b[^>]*\bsrc\s*=\s*["']https?:\/\//i
const EXTERNAL_SVG_RESOURCE_RE = /(?:\b(?:href|xlink:href|src)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\/)/i

function toRelFile(full: string): string {
  return relative(process.cwd(), full).split(sep).join('/')
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function formatPath(path: PropertyKey[]): string {
  return (
    path.reduce<string>(
      (acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : acc ? `${acc}.${String(key)}` : String(key)),
      '',
    ) || '(根)'
  )
}

function isRelativeGlbPath(modelPath: string): boolean {
  const normalized = modelPath.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(normalized)) return false
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  return normalized.toLowerCase().endsWith('.glb')
}

function hasSubstantiveBody(body: string): boolean {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{3,6}\s+/.test(line) && !/^(?:`{3,}|~{3,})/.test(line))
  return cleaned.length > 0
}

export function parseMarkdownLevel2Sections(markdown: string): {
  sections: MarkdownSection[]
  hasExternalMedia: boolean
} {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/)
  const sections: MarkdownSection[] = []
  let current: { title: string; line: number; bodyLines: string[] } | undefined
  let fence: { char: string; length: number } | undefined
  let hasExternalMedia = false

  const flush = () => {
    if (!current) return
    sections.push({
      title: current.title,
      line: current.line,
      body: current.bodyLines.join('\n'),
    })
    current = undefined
  }

  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      current?.bodyLines.push(line)
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        !(fenceMatch[2] ?? '').trim()
      ) {
        fence = undefined
      }
      continue
    }
    if (fenceMatch) {
      const char = fenceMatch[1]?.[0] ?? '`'
      const info = fenceMatch[2] ?? ''
      if (!(char === '`' && info.includes('`'))) {
        fence = { char, length: fenceMatch[1]?.length ?? 3 }
        current?.bodyLines.push(line)
        continue
      }
    }

    if (EXTERNAL_MARKDOWN_MEDIA_RE.test(line)) {
      hasExternalMedia = true
    }

    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*(?:#+[ \t]*)?$/.exec(line)
    if (heading) {
      const level = heading[1]?.length ?? 0
      const title = (heading[2] ?? '').trim()
      if (level === 2) {
        flush()
        current = { title, line: index + 1, bodyLines: [] }
        continue
      }
      if (level === 1) {
        flush()
        continue
      }
    }

    current?.bodyLines.push(line)
  }

  flush()
  return { sections, hasExternalMedia }
}

export function lintProjectGuide(file: string, markdown: string): LintIssue[] {
  const issues: LintIssue[] = []
  const parsed = parseMarkdownLevel2Sections(markdown)
  if (parsed.hasExternalMedia) {
    issues.push({ file, path: 'guide.md', message: '实训指导书禁止引用外部网络媒体资源（NFR-09）' })
  }

  let lastLine = 0
  let lastTitle = ''
  for (const required of PROJECT_GUIDE_SECTIONS) {
    const matches = parsed.sections.filter((section) => section.title === required)
    if (matches.length === 0) {
      issues.push({ file, path: `guide.md#${required}`, message: `缺少必备二级标题「## ${required}」` })
      continue
    }
    if (matches.length > 1) {
      issues.push({ file, path: `guide.md#${required}`, message: `二级标题「## ${required}」重复出现` })
    }
    const first = matches[0]
    if (!first) continue
    if (!hasSubstantiveBody(first.body)) {
      issues.push({ file, path: `guide.md#${required}`, message: `章节「## ${required}」正文不能为空` })
    }
    if (first.line < lastLine) {
      issues.push({
        file,
        path: `guide.md#${required}`,
        message: `章节「## ${required}」顺序应位于「## ${lastTitle}」之后`,
      })
    } else {
      lastLine = first.line
      lastTitle = required
    }
  }
  return issues
}

export function lintProjectSchematic(file: string, svgText: string): LintIssue[] {
  const issues: LintIssue[] = []
  if (!/<svg\b[\s\S]*<\/svg>/i.test(svgText)) {
    issues.push({ file, path: 'schematic.svg', message: '原理图 schematic.svg 内容不是有效的 SVG 文件' })
    return issues
  }
  if (EXTERNAL_SVG_RESOURCE_RE.test(svgText)) {
    issues.push({ file, path: 'schematic.svg', message: '原理图禁止引用外部网络资源（NFR-09）' })
  }
  return issues
}

export function lintLearnResourceSections(file: string, resource: LearnResource): LintIssue[] {
  const issues: LintIssue[] = []
  for (const key of LEARN_SECTION_KEYS) {
    const label = LEARN_SECTION_LABELS[key]
    const text = resource.sections[key]
    if (!text.trim()) {
      issues.push({ file, path: `sections.${key}`, message: `学习资源章节「${label}」不能为空` })
      continue
    }
    const parsed = parseMarkdownLevel2Sections(text)
    if (parsed.hasExternalMedia) {
      issues.push({
        file,
        path: `sections.${key}`,
        message: `学习资源章节「${label}」禁止引用外部网络媒体资源（NFR-09）`,
      })
    }
    if (parsed.sections.length === 0) {
      issues.push({ file, path: `sections.${key}`, message: `学习资源章节「${label}」缺少二级标题（## ...）` })
      continue
    }
    if (parsed.sections.some((section) => !hasSubstantiveBody(section.body))) {
      issues.push({ file, path: `sections.${key}`, message: `学习资源章节「${label}」二级标题下正文不能为空` })
    }
  }
  return issues
}

export function lintContent(root: string): LintIssue[] {
  const issues: LintIssue[] = []
  const modules = new Map<string, Module>()
  const moduleNetlists = new Map<string, string>()
  const instruments = new Map<string, Instrument>()
  const projects: { file: string; full: string; data: Project }[] = []
  const learnResources: { file: string; full: string; data: LearnResource }[] = []

  for (const full of walk(root).filter((f) => f.endsWith('.json'))) {
    const file = toRelFile(full)
    const name = full.split(sep).pop() ?? ''
    const schema = SCHEMAS[name]
    if (!schema) {
      issues.push({ file, path: '(文件)', message: `未知内容文件，应为 ${Object.keys(SCHEMAS).join(' / ')}` })
      continue
    }
    let json: unknown
    try {
      json = JSON.parse(readFileSync(full, 'utf8'))
    } catch (e) {
      issues.push({ file, path: '(文件)', message: `JSON 语法错误：${(e as Error).message}` })
      continue
    }
    const result = schema.safeParse(json)
    if (!result.success) {
      for (const issue of result.error.issues)
        issues.push({ file, path: formatPath(issue.path), message: issue.message })
      continue
    }
    // 目录名须与 id 一致，便于按 id 定位文件
    const data = result.data as { id: string }
    const dirName = full.split(sep).at(-2)
    if (dirName !== data.id) issues.push({ file, path: 'id', message: `id ${data.id} 与所在目录名 ${dirName} 不一致` })
    if (name === 'module.json') {
      const mod = data as Module
      modules.set(data.id, mod)
      try {
        moduleNetlists.set(data.id, readFileSync(join(dirname(full), mod.netlist), 'utf8'))
      } catch {
        // 最小 JSON 夹具可能省略 .cir；真实模块网表完整性由 assets:lint 覆盖
      }
    } else if (name === 'instrument.json') instruments.set(data.id, data as Instrument)
    else if (name === 'project.json') projects.push({ file, full, data: data as Project })
    else if (name === 'resource.json') learnResources.push({ file, full, data: data as LearnResource })
  }

  for (const { file, full, data: p } of projects) {
    // 实例 ID → 插孔集合。固定在控制屏上的仪表以仪表 id 作为实例 ID
    const jacksOf = new Map<string, Set<string>>()
    for (const ins of instruments.values())
      if (ins.mounting === 'fixed') jacksOf.set(ins.id, new Set(ins.jacks.map((j) => j.id)))
    p.modules.forEach((m, i) => {
      const mod = modules.get(m.moduleId)
      if (!mod) issues.push({ file, path: `modules[${i}].moduleId`, message: `模块 ${m.moduleId} 不存在` })
      else jacksOf.set(m.instanceId, new Set(mod.jacks.map((j) => j.id)))
    })
    p.allowedInstruments.forEach((id, i) => {
      const ins = instruments.get(id)
      const path = `allowedInstruments[${i}]`
      if (!ins) issues.push({ file, path, message: `仪表 ${id} 不存在` })
      else if (ins.mounting === 'fixed') issues.push({ file, path, message: `仪表 ${id} 固定在控制屏上，不放进仪表柜` })
      else jacksOf.set(ins.id, new Set(ins.jacks.map((jack) => jack.id)))
    })
    const checkRef = (ref: string, path: string) => {
      const [inst = '', jack = ''] = ref.split('.')
      const jacks = jacksOf.get(inst)
      if (!jacks) issues.push({ file, path, message: `实例 ${inst} 不在 modules 中，也不是固定仪表` })
      else if (!jacks.has(jack)) issues.push({ file, path, message: `${inst} 上没有插孔 ${jack}` })
    }
    p.reference.nets.forEach((net, i) => {
      net.forEach((ref, j) => {
        checkRef(ref, `reference.nets[${i}][${j}]`)
      })
    })
    p.steps.forEach((step, i) => {
      step.referenceNets?.forEach((net, j) => {
        net.forEach((ref, k) => {
          checkRef(ref, `steps[${i}].referenceNets[${j}][${k}]`)
        })
      })
    })
    p.reference.measurePoints.forEach((mp, i) => {
      mp.between?.forEach((ref, j) => {
        checkRef(ref, `reference.measurePoints[${i}].between[${j}]`)
      })
      mp.branch?.forEach((ref, j) => {
        checkRef(ref, `reference.measurePoints[${i}].branch[${j}]`)
      })
    })
    p.faults?.forEach((fault, i) => {
      const [inst = '', ...rest] = fault.target.split('.')
      const modRef = p.modules.find((m) => m.instanceId === inst)
      if (!modRef) return
      const subckt = moduleNetlists.get(modRef.moduleId)
      if (!subckt) return
      try {
        injectFault(subckt, rest.join('.'), fault)
      } catch (error) {
        issues.push({
          file,
          path: `faults[${i}]`,
          message: error instanceof Error ? error.message : `故障 ${fault.id} 无法注入`,
        })
      }
    })

    // T1.10 / TSK-01 / NFR-07：项目实训指导书 guide.md 六项结构与原理图 schematic.svg 校验
    const projectDir = dirname(full)
    const guideFull = join(projectDir, 'guide.md')
    const guideFile = toRelFile(guideFull)
    if (!existsSync(guideFull)) {
      issues.push({ file: guideFile, path: 'guide.md', message: '缺少项目实训指导书 guide.md' })
    } else {
      issues.push(...lintProjectGuide(guideFile, readFileSync(guideFull, 'utf8')))
    }

    const schematicFull = join(projectDir, 'schematic.svg')
    const schematicFile = toRelFile(schematicFull)
    if (!existsSync(schematicFull)) {
      // 正式教学项目必须附带原理图；显式标注 validation 的功能验证夹具除外
      if (!p.validation) {
        issues.push({ file: schematicFile, path: 'schematic.svg', message: '缺少项目原理图 schematic.svg' })
      }
    } else {
      issues.push(...lintProjectSchematic(schematicFile, readFileSync(schematicFull, 'utf8')))
    }
  }

  // T1.10 / LRN-01~07 / NFR-07：学习资源四项 Markdown 章节、3D 模型与跨文件引用校验
  for (const { file, full, data: resource } of learnResources) {
    issues.push(...lintLearnResourceSections(file, resource))

    const resourceDir = dirname(full)
    const categoryDir = dirname(resourceDir)
    const contentBase = basename(categoryDir) === 'learn' ? dirname(categoryDir) : resolve(root)

    if (LEARN_MODEL_REQUIRED_CATEGORIES.has(resource.category) && !resource.model) {
      issues.push({ file, path: 'model', message: `分类 ${resource.category} 必须声明本地 3D 模型路径` })
    } else if (resource.model) {
      if (!isRelativeGlbPath(resource.model)) {
        issues.push({ file, path: 'model', message: '3D 模型路径必须是内容目录内的相对 .glb 路径' })
      } else if (!existsSync(join(contentBase, resource.model))) {
        issues.push({ file, path: 'model', message: `3D 模型文件不存在：${resource.model}` })
      }
    }

    if (instruments.size > 0 || existsSync(join(contentBase, 'instruments'))) {
      resource.relatedInstruments.forEach((id, i) => {
        if (!instruments.has(id)) {
          issues.push({ file, path: `relatedInstruments[${i}]`, message: `关联仪表 ${id} 不存在` })
        }
      })
    }
    if (modules.size > 0 || existsSync(join(contentBase, 'modules'))) {
      resource.relatedModules.forEach((id, i) => {
        if (!modules.has(id)) {
          issues.push({ file, path: `relatedModules[${i}]`, message: `关联模块 ${id} 不存在` })
        }
      })
    }
  }

  return issues
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.argv[2] ?? 'content'
  const issues = lintContent(root)
  for (const i of issues) console.error(`${i.file}  ${i.path}  ${i.message}`)
  console.log(issues.length ? `\n${issues.length} 个问题` : `${root} 校验通过`)
  process.exit(issues.length ? 1 : 0)
}
