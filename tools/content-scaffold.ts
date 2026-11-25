// pnpm content:new：按 tools/templates/ 标准模板生成项目、学习资源或模块脚手架（NFR-07 / T1.10）。
// 用法：
//   pnpm content:new project <DG-12|MD-01|SD-10> --title "<项目名称>" [--group "<分组>"] [--type basic|integrated] [--out content]
//   pnpm content:new learn <component|ic|instrument-tool|concept|theory> <resource-id> --title "<名称>" [--subcategory "<子分类>"] [--out content]
//   pnpm content:new module <mod-id> --name "<模块名称>" [--form box|board] [--out content]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ContentId, LearnCategory, LearnResource, Module, Project, ProjectId } from '../src/shared/schema/index.ts'

export const TEMPLATES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'templates')

const DEFAULT_PROJECT_GROUPS: Record<string, string> = {
  DG: '直流电路',
  MD: '基本放大电路',
  SD: '数字逻辑基础',
}

const LEARN_TEMPLATE_DIRS: Record<LearnCategory, string> = {
  component: 'cmp-template',
  ic: 'ic-template',
  'instrument-tool': 'ins-learn-template',
  concept: 'concept-template',
  theory: 'concept-template',
}

const DEFAULT_LEARN_SUBCATEGORIES: Record<LearnCategory, string> = {
  component: '电阻类',
  ic: '逻辑与时序集成电路',
  'instrument-tool': '测量仪表',
  concept: '电路基本概念',
  theory: '电路分析理论',
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function ensureTargetDir(dir: string, force?: boolean): void {
  if (existsSync(dir) && !force) {
    throw new Error(`目标目录已存在：${dir}（如需覆盖请显式传入 --force）`)
  }
  mkdirSync(dir, { recursive: true })
}

export type ScaffoldProjectOptions = {
  id: string
  title: string
  group?: string
  type?: 'basic' | 'integrated'
  outRoot?: string
  force?: boolean
}

export function scaffoldProject(options: ScaffoldProjectOptions): string[] {
  const id = ProjectId.parse(options.id)
  const title = options.title.trim()
  if (!title) throw new Error('项目标题不能为空（请传入 --title）')
  const type = options.type ?? 'basic'
  const prefix = id.slice(0, 2)
  const group =
    options.group?.trim() ||
    (prefix === 'SD' && type === 'integrated'
      ? '综合性应用仿真实训项目'
      : (DEFAULT_PROJECT_GROUPS[prefix] ?? '直流电路'))
  const outRoot = resolve(options.outRoot ?? 'content')
  const targetDir = join(outRoot, 'projects', id)
  ensureTargetDir(targetDir, options.force)

  const templateDir = join(TEMPLATES_ROOT, 'project', 'DG-00')
  const rawProject = JSON.parse(readFileSync(join(templateDir, 'project.json'), 'utf8')) as Project
  const project = Project.parse({
    ...rawProject,
    id,
    group,
    title,
    type,
  })

  const guide = readFileSync(join(templateDir, 'guide.md'), 'utf8').replace(/^# DG-00 .*/m, `# ${id} ${title}`)
  const schematic = readFileSync(join(templateDir, 'schematic.svg'), 'utf8').replaceAll(
    'DG-00 实训项目标准原理图模板',
    `${id} ${escapeXml(title)}原理图`,
  )

  const projectPath = join(targetDir, 'project.json')
  const guidePath = join(targetDir, 'guide.md')
  const schematicPath = join(targetDir, 'schematic.svg')
  writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8')
  writeFileSync(guidePath, guide, 'utf8')
  writeFileSync(schematicPath, schematic, 'utf8')
  return [projectPath, guidePath, schematicPath]
}

export type ScaffoldLearnOptions = {
  category: LearnCategory
  id: string
  title: string
  subcategory?: string
  outRoot?: string
  force?: boolean
}

export function scaffoldLearnResource(options: ScaffoldLearnOptions): string[] {
  const category = LearnCategory.parse(options.category)
  const id = ContentId.parse(options.id)
  const title = options.title.trim()
  if (!title) throw new Error('学习资源名称不能为空（请传入 --title）')
  const subcategory = options.subcategory?.trim() || DEFAULT_LEARN_SUBCATEGORIES[category]
  const outRoot = resolve(options.outRoot ?? 'content')
  const targetDir = join(outRoot, 'learn', id)
  ensureTargetDir(targetDir, options.force)

  const templatePath = join(TEMPLATES_ROOT, 'learn', LEARN_TEMPLATE_DIRS[category], 'resource.json')
  const raw = JSON.parse(readFileSync(templatePath, 'utf8')) as LearnResource
  const resource = LearnResource.parse({
    ...raw,
    id,
    category,
    subcategory,
    title,
    keywords: [...new Set([title, id, subcategory])],
  })

  const resourcePath = join(targetDir, 'resource.json')
  writeFileSync(resourcePath, `${JSON.stringify(resource, null, 2)}\n`, 'utf8')
  return [resourcePath]
}

export type ScaffoldModuleOptions = {
  id: string
  name: string
  form?: 'box' | 'board'
  outRoot?: string
  force?: boolean
}

export function scaffoldModule(options: ScaffoldModuleOptions): string[] {
  const id = ContentId.parse(options.id)
  const name = options.name.trim()
  if (!name) throw new Error('模块名称不能为空（请传入 --name）')
  const form = options.form ?? 'box'
  const outRoot = resolve(options.outRoot ?? 'content')
  const targetDir = join(outRoot, 'modules', id)
  ensureTargetDir(targetDir, options.force)

  const templateDir = join(TEMPLATES_ROOT, 'module', 'mod-template')
  const rawModule = JSON.parse(readFileSync(join(templateDir, 'module.json'), 'utf8')) as Module
  const mod = Module.parse({
    ...rawModule,
    id,
    name,
    form,
  })
  const subcktName = id.replaceAll('-', '_')
  const cir = readFileSync(join(templateDir, 'module.cir'), 'utf8').replaceAll('mod_template', subcktName)

  const modulePath = join(targetDir, 'module.json')
  const cirPath = join(targetDir, 'module.cir')
  writeFileSync(modulePath, `${JSON.stringify(mod, null, 2)}\n`, 'utf8')
  writeFileSync(cirPath, cir, 'utf8')
  return [modulePath, cirPath]
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (key === 'force') {
      flags[key] = true
    } else if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      throw new Error(`参数 --${key} 缺少取值`)
    }
  }
  return { positional, flags }
}

const USAGE = `用法：
  pnpm content:new project <DG-12|MD-01|SD-10> --title "<项目名称>" [--group "<分组>"] [--type basic|integrated] [--out content] [--force]
  pnpm content:new learn <component|ic|instrument-tool|concept|theory> <resource-id> --title "<名称>" [--subcategory "<子分类>"] [--out content] [--force]
  pnpm content:new module <mod-id> --name "<模块名称>" [--form box|board] [--out content] [--force]`

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { positional, flags } = parseFlags(process.argv.slice(2))
    const kind = positional[0]
    const outRoot = typeof flags.out === 'string' ? flags.out : undefined
    const force = flags.force === true
    let created: string[] = []
    if (kind === 'project') {
      const id = positional[1] ?? ''
      const title = typeof flags.title === 'string' ? flags.title : ''
      const group = typeof flags.group === 'string' ? flags.group : undefined
      const type = flags.type === 'integrated' ? 'integrated' : 'basic'
      created = scaffoldProject({ id, title, group, type, outRoot, force })
    } else if (kind === 'learn') {
      const category = (positional[1] ?? '') as LearnCategory
      const id = positional[2] ?? ''
      const title = typeof flags.title === 'string' ? flags.title : ''
      const subcategory = typeof flags.subcategory === 'string' ? flags.subcategory : undefined
      created = scaffoldLearnResource({ category, id, title, subcategory, outRoot, force })
    } else if (kind === 'module') {
      const id = positional[1] ?? ''
      const name = typeof flags.name === 'string' ? flags.name : typeof flags.title === 'string' ? flags.title : ''
      const form = flags.form === 'board' ? 'board' : 'box'
      created = scaffoldModule({ id, name, form, outRoot, force })
    } else {
      console.error(USAGE)
      process.exit(1)
    }
    for (const file of created) console.log(`已生成：${file}`)
  } catch (error) {
    console.error(`content:new 失败：${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    process.exit(1)
  }
}
