import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  markdownEscaped as escaped,
  type FileChange,
  isLocalReference,
  isManagedDocument,
  LocalPathError,
  localReferencePath,
  markdownView,
  PLAN_FILE,
  type PolicyIssue,
  parseRegistry,
  parseTasks,
  REGISTRY_FILE,
  type RegistryEntry,
  SNAPSHOT_FILE,
  type TextSnapshot,
  validateIncremental,
  validateRegistryCoverage,
  validateTaskEntry,
} from './docs-policy.ts'

export type DocLintIssue = { file: string; line: number; message: string }

const GENERATED = /(?:^|\/)(?:node_modules|build|dist|out|test-results|playwright-report|\.git)\//
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }
type TargetSnapshot = { paths?: Set<string>; aliases: Set<string> }

export function listMarkdownFiles(root: string): string[] {
  const output = execFileSync(
    'git',
    ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: GIT_ENV,
    },
  )
  return [...new Set(output.split('\0'))]
    .filter((file) => /\.md$/i.test(file) && !GENERATED.test(file) && existsSync(resolve(root, file)))
    .sort()
}

function destination(line: string, offset: number, inline: boolean): { target: string; end: number } | undefined {
  let start = offset
  while (/[ \t]/.test(line[start] ?? '')) start++
  let end = start
  let suffix = start
  if (line[start] === '<') {
    start++
    end = start
    while (end < line.length && (line[end] !== '>' || escaped(line, end))) end++
    if (end === line.length) return undefined
    suffix = end + 1
  } else {
    let depth = 0
    while (end < line.length) {
      const char = line[end]
      if (char === '\\') {
        end += 2
        continue
      }
      if (char === '(') depth++
      else if (char === ')') {
        if (depth === 0) break
        depth--
      } else if (/\s/.test(char ?? '') && depth === 0) break
      end++
    }
    if (depth !== 0) return undefined
    suffix = end
  }
  const closing = inline
    ? /^[ \t]*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))[ \t]*)?\)/
    : /^[ \t]*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))[ \t]*)?$/
  const tail = closing.exec(line.slice(suffix))
  if (!tail || (!inline && start === end)) return undefined
  return { target: line.slice(start, end), end: suffix + tail[0].length }
}

function labelEnd(line: string, start: number): number | undefined {
  let depth = 0
  for (let index = start; index < line.length; index++) {
    if (escaped(line, index)) continue
    if (line[index] === '[') depth++
    if (line[index] === ']' && --depth === 0) return index
  }
  return undefined
}

type MarkdownReference = {
  line: number
  start: number
  end: number
  target: string
  repositoryPath: boolean
  navigation: boolean
}

function markdownReferences(text: string): { references: MarkdownReference[]; issues: Omit<PolicyIssue, 'file'>[] } {
  const references: MarkdownReference[] = []
  const issues: Omit<PolicyIssue, 'file'>[] = []
  const view = markdownView(text)
  const lines = view.visible.split('\n')
  const originalLines = text.split('\n')
  const definitions = new Map<string, string>()
  const definitionLines = new Set<number>()
  const normalize = (label: string) =>
    label
      .replace(/\\([\\[\]])/g, '$1')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  const add = (reference: MarkdownReference) => {
    if (view.uncertain.has(reference.line) && isLocalReference(reference.target)) {
      issues.push({
        code: 'LOCAL_LINK_UNSUPPORTED',
        line: reference.line,
        message:
          'Local links in nested/ambiguous code containers are not supported; use a standalone example or visible navigation',
      })
      reference.navigation = false
    }
    references.push(reference)
  }
  for (const code of view.codes) {
    const content = text.slice(code.contentStart, code.contentEnd)
    // Repository docs paths are contracts; absolute local evidence remains historical.
    for (const match of content.matchAll(/(?:^|\s)(docs[\\/][^`<>"\r\n]*?\.md(?:[?#][^\s]*)?)(?=\s|$)/g)) {
      const target = match[1] ?? ''
      if (!target.includes('*'))
        add({
          line: text.slice(0, code.contentStart + match.index + match[0].indexOf(target)).split('\n').length,
          start: code.start,
          end: code.end,
          target,
          repositoryPath: true,
          navigation: false,
        })
    }
  }
  let offset = 0
  for (const [index, source] of lines.entries()) {
    const line = source.replace(/\r$/, '')
    const original = (originalLines[index] ?? '').replace(/\r$/, '')
    const blockStart =
      index === 0 || !lines[index - 1]?.trim() || !!/^[ \t]*\[((?:\\.|[^\]\\])+)\]:/.exec(lines[index - 1] ?? '')
    const definition = /^[ \t]*\[((?:\\.|[^\]\\])+)\]:/.exec(line)
    if (definition && !escaped(line, line.indexOf('['))) {
      definitionLines.add(index)
      if (!blockStart) {
        issues.push({
          code: 'LOCAL_LINK_UNSUPPORTED',
          line: index + 1,
          message: 'Reference definitions inside a paragraph are not supported; place definitions at a block boundary',
        })
        offset += source.length + 1
        continue
      }
      const parsed = destination(original, definition[0].length, false)
      if (!parsed)
        issues.push({
          code: 'LOCAL_LINK_UNSUPPORTED',
          line: index + 1,
          message: 'Reference definitions require a single-line destination and optional title',
        })
      else {
        const label = normalize(original.slice(line.indexOf('[') + 1, definition[0].lastIndexOf(']')))
        if (definitions.has(label))
          issues.push({
            code: 'LOCAL_REFERENCE_DUPLICATE',
            line: index + 1,
            message: `Duplicate reference label: ${label}`,
          })
        else definitions.set(label, parsed.target)
        add({
          line: index + 1,
          start: offset,
          end: offset + line.length,
          target: parsed.target,
          repositoryPath: false,
          navigation: false,
        })
      }
    }
    offset += source.length + 1
  }
  offset = 0
  for (const [index, source] of lines.entries()) {
    const line = source.replace(/\r$/, '')
    const original = (originalLines[index] ?? '').replace(/\r$/, '')
    if (!definitionLines.has(index)) {
      for (let cursor = 0; cursor < line.length; cursor++) {
        if (line[cursor] !== '[' || escaped(line, cursor)) continue
        const close = labelEnd(line, cursor)
        if (close === undefined) {
          const continuation = lines.slice(index + 1, index + 3).join('\n')
          if (/\]\s*(?:\(|\[)/.test(continuation) || /^\s*[^\]]+\]:/.test(continuation))
            issues.push({
              code: 'LOCAL_LINK_UNSUPPORTED',
              line: index + 1,
              message: 'Multiline link/reference labels are not supported',
            })
          continue
        }
        const image = line[cursor - 1] === '!' && !escaped(line, cursor - 1)
        let end = close + 1
        let target: string | undefined
        if (line[end] === '(') {
          if (original.slice(cursor + 1, close).includes('[')) {
            issues.push({
              code: 'LOCAL_LINK_UNSUPPORTED',
              line: index + 1,
              message: 'Nested link labels are not supported; use a single visible link label',
            })
            cursor = close
            continue
          }
          const parsed = destination(original, end + 1, true)
          if (!parsed)
            issues.push({
              code: 'LOCAL_LINK_UNSUPPORTED',
              line: index + 1,
              message: 'Inline links require a single-line balanced destination and optional title',
            })
          else {
            target = parsed.target
            end = parsed.end
          }
        } else {
          let label = original.slice(cursor + 1, close)
          const explicit = line[end] === '['
          if (explicit) {
            const referenceEnd = labelEnd(line, end)
            if (referenceEnd === undefined) {
              issues.push({ code: 'LOCAL_LINK_UNSUPPORTED', line: index + 1, message: 'Unclosed reference label' })
              continue
            }
            label = original.slice(end + 1, referenceEnd) || label
            end = referenceEnd + 1
          }
          target = definitions.get(normalize(label))
          if (explicit && target === undefined)
            issues.push({
              code: 'LOCAL_REFERENCE_UNDEFINED',
              line: index + 1,
              message: `Undefined reference label: ${normalize(label)}`,
            })
        }
        if (target !== undefined)
          add({
            line: index + 1,
            start: offset + cursor,
            end: offset + end,
            target,
            repositoryPath: false,
            navigation: !image,
          })
        cursor = end - 1
      }
    }
    offset += source.length + 1
  }
  for (const html of view.visible.matchAll(/<[a-z][^>]*>/gi)) {
    for (const attribute of html[0].matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const target = attribute[1] ?? attribute[2] ?? attribute[3] ?? ''
      if (isLocalReference(target))
        issues.push({
          code: 'LOCAL_LINK_UNSUPPORTED',
          line: text.slice(0, html.index + attribute.index).split('\n').length,
          message: 'Local HTML href/src targets are not supported; use a Markdown link/image',
        })
    }
  }
  return { references, issues }
}

function filesystemTarget(root: string, path: string, aliases = new Set<string>()): 'present' | 'missing' | 'alias' {
  if ([...aliases].some((alias) => path === alias || path.startsWith(`${alias}/`))) return 'alias'
  let directory = root
  const parts = path.split('/').filter(Boolean)
  for (const [index, part] of parts.entries()) {
    // Inspect each prefix before any child access; never resolve or follow a junction/symlink.
    if (!readdirSync(directory).includes(part)) return 'missing'
    const full = resolve(directory, part)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(full)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'missing'
      throw error
    }
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return 'alias'
    if (index < parts.length - 1 && !entry.isDirectory()) return 'missing'
    directory = full
  }
  return 'present'
}

function checkTarget(root: string, file: string, line: number, target: string, repositoryPath = false): DocLintIssue[] {
  let path: string | undefined
  try {
    path = localReferencePath(file, target, repositoryPath)
  } catch (error) {
    return [
      { file, line, message: error instanceof LocalPathError ? error.message : `Invalid URL encoding: ${target}` },
    ]
  }
  if (path === undefined)
    return isLocalReference(target) ? [{ file, line, message: `Local target escapes the repository: ${target}` }] : []
  const state = filesystemTarget(root, path)
  return state === 'present'
    ? []
    : [
        {
          file,
          line,
          message: state === 'alias' ? `Unsupported local path alias: ${target}` : `Missing local target: ${target}`,
        },
      ]
}

export function lintMarkdown(root: string, file: string, text: string): DocLintIssue[] {
  const issues: DocLintIssue[] = []
  if (/^[0-9]/.test(basename(file.replaceAll('\\', '/')))) {
    issues.push({ file, line: 1, message: 'Markdown filenames must not start with a digit' })
  }
  const scan = markdownReferences(text)
  issues.push(...scan.issues.map(({ line, message }) => ({ file, line, message })))
  for (const reference of scan.references) {
    issues.push(...checkTarget(root, file, reference.line, reference.target, reference.repositoryPath))
  }
  return issues
}

export function lintDocs(root: string, files = listMarkdownFiles(root)): DocLintIssue[] {
  return files.flatMap((file) => {
    if (!/\.md$/i.test(file) || GENERATED.test(file.replaceAll('\\', '/'))) return []
    let state: 'present' | 'missing' | 'alias'
    try {
      if (
        localReferencePath('', file.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/'), true) !==
        file.replaceAll('\\', '/')
      )
        throw new LocalPathError(`Unsupported source path: ${file}`)
      state = filesystemTarget(root, file.replaceAll('\\', '/'))
    } catch (error) {
      return [{ file, line: 1, message: error instanceof Error ? error.message : String(error) }]
    }
    if (state === 'alias') return [{ file, line: 1, message: `Unsupported local path alias: ${file}` }]
    if (state !== 'present') return []
    return lintMarkdown(root, file, readFileSync(resolve(root, file), 'utf8'))
  })
}

type Mode = 'static' | 'staged' | 'commit'
type Options = { mode: Mode; directory?: string; task?: string; base?: string; commit?: string }
export type DocLintReport = {
  mode: Mode
  task: string | null
  base: string | null
  target: string
  files: number
  changes: number
  issues: PolicyIssue[]
}
type GitEntry = { mode: string; oid: string; blob: boolean }

class AuditFailure extends Error {
  code: string
  file: string
  constructor(code: string, file: string, message: string) {
    super(message)
    this.code = code
    this.file = file
  }
}

function parseArguments(args: string[]): Options {
  const options: Options = { mode: 'static' }
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (!arg.startsWith('-')) {
      if (options.directory !== undefined)
        throw new AuditFailure('CLI_UNKNOWN_ARGUMENT', '<cli>', 'Only one optional directory is accepted')
      options.directory = arg
      continue
    }
    if (!['--json', '--staged', '--task', '--base', '--commit'].includes(arg))
      throw new AuditFailure('CLI_UNKNOWN_ARGUMENT', '<cli>', `Unknown argument ${arg}`)
    if (seen.has(arg)) throw new AuditFailure('CLI_DUPLICATE_ARGUMENT', '<cli>', `Duplicate argument ${arg}`)
    seen.add(arg)
    if (arg === '--json') continue
    if (arg === '--staged') {
      options.mode = 'staged'
      continue
    }
    const value = args[++index]
    if (!value || value.startsWith('-')) throw new AuditFailure('CLI_MISSING_VALUE', '<cli>', `${arg} requires a value`)
    if (arg === '--task') options.task = value
    else if (arg === '--base') options.base = value
    else {
      options.mode = 'commit'
      options.commit = value
    }
  }
  if (seen.has('--staged') && seen.has('--commit'))
    throw new AuditFailure('CLI_MODE_CONFLICT', '<cli>', '--staged and --commit are mutually exclusive')
  if (options.mode === 'static' && (options.task || options.base))
    throw new AuditFailure('CLI_MODE_REQUIRED', '<cli>', '--task/--base require --staged or --commit')
  if (options.mode !== 'static' && (!options.task || !options.base))
    throw new AuditFailure(
      'CLI_REQUIRED_ARGUMENT',
      '<cli>',
      'Incremental audit requires --task <ID> and --base <assignment commit>',
    )
  return options
}

function git(root: string, args: string[], code = 'GIT_ERROR', file = '<git>'): string {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      env: GIT_ENV,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuditFailure(code, file, `git ${args.join(' ')}: ${detail}`)
  }
}

function resolveCommit(root: string, value: string, code: string): string {
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], code).trim()
}

function isAncestor(root: string, base: string, target: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', base, target], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: GIT_ENV,
  })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new AuditFailure(
    'GIT_ERROR',
    '<git>',
    `Cannot validate ancestry ${base} -> ${target}: ${result.error?.message ?? result.stderr}`,
  )
}

function readEntries(root: string, target: string): Map<string, GitEntry> {
  const index = target === 'index'
  const output = git(root, index ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', '--full-tree', target])
  const entries = new Map<string, GitEntry>()
  for (const record of output.split('\0').filter(Boolean)) {
    const match = index
      ? /^(\d{6}) ([a-f\d]+) (\d)\t([\s\S]+)$/.exec(record)
      : /^(\d{6}) (blob|commit) ([a-f\d]+)\t([\s\S]+)$/.exec(record)
    if (!match?.[1] || !match[4])
      throw new AuditFailure('GIT_FORMAT', '<git>', 'Invalid NUL-delimited Git tree/index record')
    if (index && match[3] !== '0')
      throw new AuditFailure('INDEX_UNMERGED', match[4], 'Resolve unmerged index entries before audit')
    entries.set(match[4], {
      mode: match[1],
      oid: (index ? match[2] : match[3]) ?? '',
      blob: index ? match[1] !== '160000' : match[2] === 'blob',
    })
  }
  return entries
}

function readChanges(root: string, base: string, target: string): FileChange[] {
  const output = git(root, [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    '--ita-invisible-in-index',
    ...(target === 'index' ? ['--cached'] : []),
    base,
    ...(target === 'index' ? [] : [target]),
    '--',
  ])
  const records = output.split('\0').filter(Boolean)
  const changes: FileChange[] = []
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f\d]+ [a-f\d]+ ([ADMT])$/.exec(records[index] ?? '')
    const path = records[index + 1]
    if (!match?.[1] || !match[2] || !match[3] || !path)
      throw new AuditFailure('GIT_FORMAT', path ?? '<git>', 'Invalid NUL-delimited Git change record')
    changes.push({ path, kind: match[3], oldMode: match[1], newMode: match[2] })
  }
  return changes
}

function loadTexts(
  root: string,
  entries: Map<string, GitEntry>,
  paths: Set<string>,
  cache: Map<string, string>,
): Map<string, string> {
  const texts = new Map<string, string>()
  for (const path of paths) {
    const entry = entries.get(path)
    if (!entry?.blob) continue
    let text = cache.get(entry.oid)
    if (text === undefined) {
      text = git(root, ['cat-file', 'blob', entry.oid], 'GIT_BLOB_READ', path)
      cache.set(entry.oid, text)
    }
    texts.set(path, text)
  }
  return texts
}

function navigation(text: string): Set<string> {
  const targets = new Set<string>()
  for (const reference of markdownReferences(text).references) {
    if (!reference.navigation) continue
    try {
      const path = localReferencePath(REGISTRY_FILE, reference.target)
      if (path !== undefined) targets.add(path)
    } catch {
      // Invalid encodings are diagnosed by the Markdown checker, never accepted as navigation.
    }
  }
  return targets
}

function validTreePaths(entries: Map<string, GitEntry>): TargetSnapshot {
  const paths = new Set<string>()
  const aliases = new Set<string>()
  paths.add('')
  for (const [file, entry] of entries) {
    if (!['100644', '100755'].includes(entry.mode)) {
      aliases.add(file)
      continue
    }
    paths.add(file)
    const parts = file.split('/')
    while (parts.length > 1) {
      parts.pop()
      paths.add(parts.join('/'))
    }
  }
  return { paths, aliases }
}

function codedMarkdown(
  root: string,
  file: string,
  text: string,
  retired: Set<string>,
  targets?: TargetSnapshot,
  declarations?: Map<string, RegistryEntry>,
): PolicyIssue[] {
  const issues: PolicyIssue[] = []
  if (/^[0-9]/.test(basename(file)))
    issues.push({ code: 'MARKDOWN_NAME', file, line: 1, message: 'Markdown filenames must not start with a digit' })
  const scan = markdownReferences(text)
  issues.push(...scan.issues.map((issue) => ({ ...issue, file })))
  for (const reference of scan.references) {
    const { line, target, repositoryPath } = reference
    // Check the exact registry path cell before URL parsing; a literal # or % in a
    // declared filename is a native path, not a fragment or malformed escape.
    const declaration =
      file === REGISTRY_FILE && repositoryPath
        ? [...(declarations?.values() ?? [])].find(
            (entry) => reference.start === entry.pathStart && reference.end === entry.pathEnd,
          )
        : undefined
    if (declaration) continue
    let path: string | undefined
    try {
      path = localReferencePath(file, target, repositoryPath)
    } catch (error) {
      issues.push({
        code: error instanceof LocalPathError ? 'LOCAL_PATH_UNSUPPORTED' : 'LOCAL_URL_ENCODING',
        file,
        line,
        message: error instanceof LocalPathError ? error.message : `Invalid URL encoding: ${target}`,
      })
      continue
    }
    // Registry path cells are declarations, not valid-link assertions for retired documents.
    if (path === undefined) {
      if (isLocalReference(target))
        issues.push({
          code: 'LOCAL_TARGET_OUTSIDE',
          file,
          line,
          message: `Local target escapes the audited repository: ${target}`,
        })
      continue
    }
    if (path !== undefined && retired.has(path)) {
      issues.push({
        code: 'RETIRED_TARGET',
        file,
        line,
        message: `Retired local target is not a valid link/reference: ${target}`,
      })
      continue
    }
    if ([...(targets?.aliases ?? [])].some((alias) => path === alias || path.startsWith(`${alias}/`)))
      issues.push({
        code: 'LOCAL_PATH_UNSUPPORTED',
        file,
        line,
        message: `Local target crosses a Git symlink/gitlink: ${target}`,
      })
    else if (targets?.paths) {
      if (!targets.paths.has(path))
        issues.push({
          code: 'LOCAL_TARGET_MISSING',
          file,
          line,
          message: `Missing local target in audited tree: ${target}`,
        })
    } else {
      const state = filesystemTarget(root, path, targets?.aliases)
      if (state !== 'present')
        issues.push({
          code: state === 'alias' ? 'LOCAL_PATH_UNSUPPORTED' : 'LOCAL_TARGET_MISSING',
          file,
          line,
          message:
            state === 'alias'
              ? `Local target crosses a filesystem alias: ${target}`
              : `Missing local target: ${target}`,
        })
    }
  }
  return issues
}

function projectMarkdown(root: string): string[] {
  const files: string[] = []
  function walk(directory: string): void {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory() && !entry.isSymbolicLink() && (directory || entry.name === 'docs')) walk(path)
      else if (isManagedDocument(path) && entry.isFile()) files.push(path)
      else if (isManagedDocument(path) && entry.isSymbolicLink()) files.push(path)
    }
  }
  walk('')
  return files
}

function auditStatic(root: string, directory: string, result: DocLintReport): void {
  const targets = validTreePaths(readEntries(root, 'index'))
  const managed = projectMarkdown(root)
  const scope = relative(root, directory).replaceAll('\\', '/')
  const inScope = (file: string) => !scope || file === scope || file.startsWith(`${scope}/`)
  const files = [
    ...new Set([
      ...listMarkdownFiles(directory)
        .map((file) => relative(root, resolve(directory, file)).replaceAll('\\', '/'))
        .filter(inScope),
      ...managed.filter(inScope),
    ]),
  ].sort()
  result.files = files.length
  const texts = new Map<string, string>()
  const controlFiles = [REGISTRY_FILE, PLAN_FILE, SNAPSHOT_FILE].filter((file) => existsSync(resolve(root, file)))
  for (const file of new Set([...files, ...controlFiles])) {
    try {
      const nativePath = file.split('/').map(encodeURIComponent).join('/')
      if (localReferencePath('', nativePath, true) !== file)
        throw new LocalPathError(`Unsupported source path: ${file}`)
      const sourceState = filesystemTarget(root, file, targets.aliases)
      if (sourceState !== 'present') {
        if (sourceState === 'alias')
          result.issues.push({
            code: 'LOCAL_PATH_UNSUPPORTED',
            file,
            line: 1,
            message: 'Source document crosses a filesystem/Git alias; content was not read',
          })
        continue
      }
      texts.set(file, readFileSync(resolve(root, file), 'utf8'))
    } catch (error) {
      if (error instanceof LocalPathError) {
        result.issues.push({ code: 'LOCAL_PATH_UNSUPPORTED', file, line: 1, message: error.message })
        continue
      }
      throw new AuditFailure('FILE_READ', file, String(error))
    }
  }
  const entries = parseRegistry(texts.get(REGISTRY_FILE) ?? '', result.issues)
  const present = new Set(managed.filter((file) => filesystemTarget(root, file, targets.aliases) === 'present'))
  for (const entry of entries.values()) {
    const full = resolve(root, entry.path)
    if (
      filesystemTarget(root, entry.path, targets.aliases) === 'present' &&
      (entry.lifecycle === 'retired' || lstatSync(full).isFile())
    )
      present.add(entry.path)
  }
  validateRegistryCoverage(entries, present, result.issues)
  const tasks = parseTasks(texts.get(PLAN_FILE) ?? '', result.issues)
  validateTaskEntry(texts.get(SNAPSHOT_FILE) ?? '', tasks, result.issues)
  const retired = new Set(
    [...entries.values()].filter((entry) => entry.lifecycle === 'retired').map((entry) => entry.path),
  )
  for (const file of files)
    result.issues.push(
      ...codedMarkdown(root, file, texts.get(file) ?? '', retired, { aliases: targets.aliases }, entries),
    )
}

function auditIncremental(root: string, options: Options, result: DocLintReport): void {
  const base = resolveCommit(root, options.base ?? '', 'BASE_INVALID')
  result.base = base
  const target = options.mode === 'staged' ? 'index' : resolveCommit(root, options.commit ?? '', 'COMMIT_INVALID')
  result.target = target
  if (target === 'index') {
    const head = resolveCommit(root, 'HEAD', 'GIT_ERROR')
    if (!isAncestor(root, base, head))
      throw new AuditFailure('BASE_NOT_ANCESTOR', '<git>', `Assignment base ${base} is not an ancestor of HEAD ${head}`)
    if (
      !git(root, [
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=none',
        '--ita-invisible-in-index',
        '--',
      ]).length
    )
      throw new AuditFailure(
        'STAGED_EMPTY',
        '<git>',
        'No staged changes; selectively stage your authorized delivery before audit',
      )
  } else if (target === base || !isAncestor(root, base, target))
    throw new AuditFailure(
      'COMMIT_NOT_DESCENDANT',
      '<git>',
      `Target ${target} must be a successor of assignment base ${base}`,
    )
  const beforeEntries = readEntries(root, base)
  const recordedEntries = readEntries(root, target)
  const changes = readChanges(root, base, target)
  // ITA entries are not in the commit tree. Rebuild only actual cached changes over the base.
  const afterEntries = target === 'index' ? new Map(beforeEntries) : recordedEntries
  if (target === 'index') {
    for (const change of changes) {
      if (change.kind === 'D') afterEntries.delete(change.path)
      else {
        const entry = recordedEntries.get(change.path)
        if (!entry) throw new AuditFailure('GIT_FORMAT', change.path, 'Changed path is missing from the index')
        afterEntries.set(change.path, entry)
      }
    }
  }
  result.changes = changes.length
  result.files = changes.filter(
    (change) =>
      change.kind !== 'D' &&
      /\.md$/i.test(change.path) &&
      (isManagedDocument(change.path) || !GENERATED.test(change.path)),
  ).length
  const cache = new Map<string, string>()
  const paths = new Set([
    PLAN_FILE,
    REGISTRY_FILE,
    ...changes.filter((item) => /\.md$/i.test(item.path)).map((item) => item.path),
  ])
  const initial = loadTexts(root, beforeEntries, new Set([PLAN_FILE]), cache)
  const basePolicy = parseTasks(initial.get(PLAN_FILE) ?? '', []).policies.get(options.task ?? '')
  for (const path of [...(basePolicy?.append ?? []), ...(basePolicy?.sections.map((item) => item.path) ?? [])])
    paths.add(path)
  const beforeTexts = loadTexts(root, beforeEntries, paths, cache)
  const afterTexts = loadTexts(root, afterEntries, paths, cache)
  const snapshot = (entries: Map<string, GitEntry>, texts: Map<string, string>): TextSnapshot => ({
    files: new Set(entries.keys()),
    texts,
    navigation: navigation(texts.get(REGISTRY_FILE) ?? ''),
  })
  const before = snapshot(beforeEntries, beforeTexts)
  const after = snapshot(afterEntries, afterTexts)
  validateIncremental(before, after, changes, options.task ?? '', base, result.issues)
  const registry = parseRegistry(afterTexts.get(REGISTRY_FILE) ?? '', [])
  const baseRegistry = parseRegistry(beforeTexts.get(REGISTRY_FILE) ?? '', [])
  const retired = new Set(
    [...registry.values(), ...baseRegistry.values()]
      .filter((entry) => entry.lifecycle === 'retired')
      .map((entry) => entry.path),
  )
  const targets = validTreePaths(afterEntries)
  for (const change of changes) {
    if (
      change.kind !== 'D' &&
      /\.md$/i.test(change.path) &&
      (isManagedDocument(change.path) || !GENERATED.test(change.path))
    ) {
      result.issues.push(
        ...codedMarkdown(root, change.path, afterTexts.get(change.path) ?? '', retired, targets, registry),
      )
    }
  }
}

export function runDocsLint(args: string[], cwd = process.cwd()): DocLintReport {
  const mode = args.includes('--commit') ? 'commit' : args.includes('--staged') ? 'staged' : 'static'
  const result: DocLintReport = {
    mode,
    task: null,
    base: null,
    target: mode === 'static' ? 'worktree' : mode === 'staged' ? 'index' : '',
    files: 0,
    changes: 0,
    issues: [],
  }
  try {
    const options = parseArguments(args)
    result.mode = options.mode
    result.task = options.task ?? null
    result.base = options.base ?? null
    result.target = options.commit ?? (options.mode === 'staged' ? 'index' : 'worktree')
    const directory = resolve(cwd, options.directory ?? '.')
    const root = resolve(git(directory, ['rev-parse', '--show-toplevel']).trim())
    if (options.mode === 'static') auditStatic(root, directory, result)
    else auditIncremental(root, options, result)
  } catch (error) {
    const failure =
      error instanceof AuditFailure
        ? error
        : new AuditFailure('AUDIT_ERROR', '<git>', error instanceof Error ? error.message : String(error))
    result.issues.push({ code: failure.code, file: failure.file, line: 1, message: failure.message })
  }
  result.issues = [...new Map(result.issues.map((issue) => [JSON.stringify(issue), issue])).values()]
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const result = runDocsLint(args)
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    for (const issue of result.issues) console.error(`${issue.file}:${issue.line}: [${issue.code}] ${issue.message}`)
    console.log(`${result.files} Markdown files; ${result.issues.length} issues (${result.mode})`)
    if (result.mode !== 'static')
      console.log(`task=${result.task}; base=${result.base}; target=${result.target}; changes=${result.changes}`)
  }
  process.exitCode = result.issues.length ? 1 : 0
}
