// pnpm content:lint：扫描 content/ 全部 JSON，按文件名选 schema 校验，再做跨文件引用检查。
// 输出格式：<文件路径> <字段路径> <问题>
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { z } from 'zod'
import { BenchScene, Instrument, Module, Project } from '../src/shared/schema/index.ts'

export type LintIssue = { file: string; path: string; message: string }

const SCHEMAS: Record<string, z.ZodType> = {
  'module.json': Module,
  'instrument.json': Instrument,
  'project.json': Project,
  'scene.json': BenchScene,
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

export function lintContent(root: string): LintIssue[] {
  const issues: LintIssue[] = []
  const modules = new Map<string, Module>()
  const instruments = new Map<string, Instrument>()
  const projects: { file: string; data: Project }[] = []

  for (const full of walk(root).filter((f) => f.endsWith('.json'))) {
    const file = relative(process.cwd(), full).split(sep).join('/')
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
    if (name === 'module.json') modules.set(data.id, data as Module)
    else if (name === 'instrument.json') instruments.set(data.id, data as Instrument)
    else if (name === 'project.json') projects.push({ file, data: data as Project })
  }

  for (const { file, data: p } of projects) {
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
    p.reference.measurePoints.forEach((mp, i) => {
      mp.between?.forEach((ref, j) => {
        checkRef(ref, `reference.measurePoints[${i}].between[${j}]`)
      })
      mp.branch?.forEach((ref, j) => {
        checkRef(ref, `reference.measurePoints[${i}].branch[${j}]`)
      })
    })
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
