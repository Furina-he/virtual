import { z } from 'zod'

export const REGISTRY_FILE = 'docs/README.md'
export const PLAN_FILE = 'docs/\u6267\u884c\u8ba1\u5212.md'
export const SNAPSHOT_FILE = 'docs/\u9879\u76ee\u72b6\u6001.md'

export type PolicyIssue = { code: string; file: string; line: number; message: string }
export type RegistryEntry = {
  path: string
  kind: string
  role: string
  lifecycle: 'active' | 'archive' | 'retired'
  line: number
  pathStart: number
  pathEnd: number
}
export type TextSnapshot = {
  files: ReadonlySet<string>
  texts: ReadonlyMap<string, string>
  navigation: ReadonlySet<string>
}
export type FileChange = { path: string; kind: string; oldMode: string; newMode: string }
type Block = { content: string; contentStart: number; contentEnd: number; start: number; end: number; line: number }

const EMPTY = '\u2610'
const ONGOING = '\u25d0'
const COMPLETE = '\u2611'
const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i
const ROLES = ['architect', 'scoped-executor', 'append-only'] as const
const LIFECYCLES = ['active', 'archive', 'retired'] as const

function addIssue(issues: PolicyIssue[], code: string, file: string, line: number, message: string): void {
  issues.push({ code, file, line, message })
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function escapedRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isRepositoryPath(path: string): boolean {
  return (
    !!path &&
    !/[\\:*?"<>|]/.test(path) &&
    ![...path].some((char) => char.charCodeAt(0) < 32) &&
    path.split('/').every((part) => !!part && part !== '.' && part !== '..' && part.trim() === part)
  )
}

export function isManagedDocument(path: string): boolean {
  return /\.md$/i.test(path) && (!path.includes('/') || /^docs\//i.test(path))
}

export class LocalPathError extends Error {}

export function isLocalReference(target: string): boolean {
  return (
    !!target.split(/[?#]/, 1)[0] &&
    !target.startsWith('//') &&
    (!/^[a-z][a-z\d+.-]*:/i.test(target) || /^[a-z]:[\\/]/i.test(target))
  )
}

export function localReferencePath(file: string, target: string, repositoryPath = false): string | undefined {
  if (!isLocalReference(target)) return undefined
  const entity = /&(?:#\d+|#x[a-f\d]+|[a-z][a-z\d]+);/i.exec(target)
  const suffix = target.search(/[?#]/)
  if (entity && (suffix < 0 || entity.index < suffix))
    throw new LocalPathError(`HTML entities in local destinations are unsupported; use URL encoding: ${target}`)
  const path = target.split(/[?#]/, 1)[0] ?? ''
  const raw = decodeURIComponent(path)
  if (/^[a-z]:|^[\\/]{2}/i.test(raw)) throw new LocalPathError(`Unsupported native/network path: ${target}`)
  const decoded = raw.replace(/\\([\\()[\]<> ])/g, '$1').replaceAll('\\', '/')
  const parts = repositoryPath || decoded.startsWith('/') ? [] : file.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else {
      if (
        part.trim() !== part ||
        part.endsWith('.') ||
        /[:*?"<>|]/.test(part) ||
        [...part].some((char) => char.charCodeAt(0) < 32) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
        throw new LocalPathError(`Unsupported local path component: ${target}`)
      parts.push(part)
    }
  }
  return parts.join('/')
}

type CodeSpan = { start: number; end: number; contentStart: number; contentEnd: number }

export function markdownEscaped(text: string, index: number): boolean {
  let count = 0
  while (index > 0 && text[--index] === '\\') count++
  return count % 2 === 1
}

function columns(text: string): number {
  let column = 0
  for (const char of text) column += char === '\t' ? 4 - (column % 4) : 1
  return column
}

function codeEnd(text: string, start: number, width: number, limit: number): number | undefined {
  const marker = '`'.repeat(width)
  for (
    let index = text.indexOf(marker, start);
    index >= 0 && index < limit;
    index = text.indexOf(marker, index + width)
  ) {
    if (text[index - 1] !== '`' && text[index + width] !== '`') return index
  }
  return undefined
}

type MarkdownLine = {
  start: number
  end: number
  block: number
  blockStart: boolean
  contentStart: number
  container: boolean
  hidden: boolean
  definition: boolean
  flowEnd: number
}
type MarkdownContainer = { column: number; kind: 'list' | 'quote'; marker?: string }

function markdownLineSyntax(source: string, paragraph: boolean, context?: MarkdownContainer) {
  const line = source.replace(/\r$/, '')
  const indent = columns(/^[ \t]*/.exec(line)?.[0] ?? '')
  const thematic = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)
  const candidate = thematic ? null : /^ {0,3}([-+*]|\d{1,9}[.)])([ \t]+)/.exec(line)
  const marker = candidate?.[1] ?? ''
  const sameList = context?.kind === 'list' && context.marker === marker.at(-1) && indent < context.column
  const content = candidate ? line.slice(candidate[0].length).trim() : ''
  // New lists need nonempty content to interrupt; ordered lists need ordinal 1, not later item numbers.
  const list =
    candidate && (!paragraph || sameList || (content && (!/^\d/.test(marker) || Number.parseInt(marker, 10) === 1)))
      ? candidate
      : null
  return {
    blank: !line.trim(),
    indent,
    heading: /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line),
    thematic,
    setext: paragraph && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line),
    list,
    quote: /^ {0,3}>[ \t]?/.exec(line),
    fence: /^ {0,3}(`{3,}|~{3,})([^\r]*)$/.exec(line),
    comment: /^ {0,3}<!--/.test(line),
  }
}

function markdownParagraphBoundary(syntax: ReturnType<typeof markdownLineSyntax>): boolean {
  return (
    syntax.blank ||
    syntax.heading ||
    syntax.thematic ||
    syntax.setext ||
    !!syntax.list ||
    !!syntax.quote ||
    syntax.comment ||
    !!(syntax.fence && (syntax.fence[1]?.[0] !== '`' || !syntax.fence[2]?.includes('`')))
  )
}

function indentationEnd(source: string, width: number): number {
  let index = 0
  let column = 0
  while (column < width && /[ \t]/.test(source[index] ?? '')) {
    column += source[index] === '\t' ? 4 - (column % 4) : 1
    index++
  }
  return index
}

export function markdownView(text: string): {
  visible: string
  codes: CodeSpan[]
  uncertain: Set<number>
  lines: MarkdownLine[]
} {
  const ranges: { start: number; end: number }[] = []
  const codes: CodeSpan[] = []
  const uncertain = new Set<number>()
  const lines: MarkdownLine[] = []
  const sources = text.split('\n')
  let position = 0
  const starts = sources.map((source) => {
    const start = position
    position += source.length + 1
    return start
  })
  const paragraphEnd = (index: number, context?: MarkdownContainer): number => {
    let active = context
    for (let next = index + 1; next < sources.length; next++) {
      const source = sources[next] ?? ''
      const raw = markdownLineSyntax(source, true, active)
      let syntax = raw
      if (active?.kind === 'quote' && raw.quote) syntax = markdownLineSyntax(source.slice(raw.quote[0].length), true)
      else if (active?.kind === 'list' && !raw.list && !raw.quote && raw.indent >= active.column)
        syntax = markdownLineSyntax(source.slice(indentationEnd(source, active.column)), true)
      else if (active && !raw.quote && !raw.list) {
        if (active.kind === 'quote' && raw.indent >= 4) return starts[next] ?? text.length
        if (active.kind !== 'quote' && (raw.indent === 0 || raw.indent < active.column)) active = undefined
      }
      if (markdownParagraphBoundary(syntax)) return starts[next] ?? text.length
    }
    return text.length
  }
  let fence: { char: string; length: number } | undefined
  let container: MarkdownContainer | undefined
  let containerFence: { char: string; length: number } | undefined
  let unknownContainer = false
  let blockComment = false
  let commentUntil = 0
  let indented = false
  let paragraph = false
  let block = 0
  let codeUntil = 0
  for (const [lineIndex, source] of sources.entries()) {
    const offset = starts[lineIndex] ?? 0
    const end = offset + source.length
    const syntax = markdownLineSyntax(source, paragraph, container)
    const marker = syntax.fence
    let flowContext = container
    let flowEnd: number | undefined
    const state: MarkdownLine = {
      start: offset,
      end,
      block,
      blockStart: !paragraph,
      contentStart: syntax.quote?.[0].length ?? (container ? indentationEnd(source, container.column) : 0),
      container: !!container,
      hidden: false,
      definition: false,
      // Only spans/titles need lookahead; hidden JSON/code lines must not eagerly rescan their block.
      get flowEnd(): number {
        if (flowEnd === undefined) flowEnd = paragraphEnd(lineIndex, flowContext)
        return flowEnd
      },
    }
    let logical: ReturnType<typeof markdownLineSyntax> = state.container
      ? markdownLineSyntax(source.slice(state.contentStart), paragraph)
      : syntax
    lines.push(state)
    if (fence) {
      ranges.push({ start: offset, end })
      if (marker && marker[1]?.[0] === fence.char && marker[1].length >= fence.length && !marker[2]?.trim())
        fence = undefined
      state.hidden = true
      state.block = ++block
      continue
    }
    if (blockComment) {
      ranges.push({ start: offset, end })
      blockComment = !source.includes('-->')
      state.hidden = true
      state.block = ++block
      continue
    }
    let boundary = false
    if (commentUntil <= offset && codeUntil <= offset) {
      const { indent, list, quote } = syntax
      const lazyQuote: boolean = container?.kind === 'quote' && paragraph && !markdownParagraphBoundary(syntax)
      if (
        syntax.heading ||
        (!lazyQuote && !quote && !list && !syntax.blank && (indent === 0 || (container && indent < container.column)))
      ) {
        container = undefined
        containerFence = undefined
        unknownContainer = false
      }
      if (list) {
        const padding = columns(list[0]) - indent - (list[1]?.length ?? 0)
        if (padding > 4) uncertain.add(lineIndex + 1)
        container = {
          column: padding > 4 ? indent + (list[1]?.length ?? 0) + 1 : columns(list[0]),
          kind: 'list',
          marker: list[1]?.at(-1),
        }
        paragraph = false
      }
      if (quote) {
        if (container?.kind !== 'quote') paragraph = false
        container = { column: 0, kind: 'quote' }
      }
      state.container = !!container
      state.contentStart =
        list?.[0].length ?? quote?.[0].length ?? (container ? indentationEnd(source, container.column) : 0)
      flowContext = container
      const inside = source.slice(state.contentStart)
      logical = container ? markdownLineSyntax(inside, paragraph) : syntax
      const trimmed = inside.trimStart()
      const nested = /^(`{3,}|~{3,})([^\r]*)/.exec(trimmed)
      const nestedMarker = nested?.[1]
      const unknownNestedContainer = container && (logical.list || logical.quote)
      if (unknownNestedContainer) unknownContainer = true
      if (unknownContainer && container && source.trim()) uncertain.add(lineIndex + 1)
      const containerMarker =
        !!container &&
        !!(list || quote || indent >= container.column) &&
        !!nestedMarker &&
        (!!containerFence || nestedMarker[0] !== '`' || !nested?.[2]?.includes('`'))
      if (containerMarker && nestedMarker) {
        if (!containerFence) containerFence = { char: nestedMarker[0] ?? '`', length: nestedMarker.length }
        else if (
          nestedMarker[0] === containerFence.char &&
          nestedMarker.length >= containerFence.length &&
          !nested?.[2]?.trim()
        )
          containerFence = undefined
        uncertain.add(lineIndex + 1)
      } else if (
        containerFence ||
        (container && (quote ? columns(/^[ \t]*/.exec(inside)?.[0] ?? '') >= 4 : indent >= container.column + 4))
      )
        uncertain.add(lineIndex + 1)
      if (container && /^<!--/.test(trimmed)) {
        unknownContainer = true
        uncertain.add(lineIndex + 1)
      }
      if (!container && syntax.comment) {
        ranges.push({ start: offset, end })
        blockComment = !source.includes('-->')
        paragraph = false
        state.hidden = true
        state.block = ++block
        continue
      }
      if (marker && !quote && !containerMarker && (marker[1]?.[0] !== '`' || !marker[2]?.includes('`'))) {
        fence = { char: marker[1]?.[0] ?? '`', length: marker[1]?.length ?? 3 }
        ranges.push({ start: offset, end })
        paragraph = false
        state.hidden = true
        state.block = ++block
        continue
      }
      if (indented && source.trim() && indent < 4) indented = false
      if (!container && indent >= 4 && !paragraph) indented = true
      if (indented) {
        ranges.push({ start: offset, end })
        state.hidden = true
        state.block = ++block
        paragraph = false
        continue
      }
      boundary =
        logical.heading ||
        logical.thematic ||
        logical.setext ||
        !!(container && (logical.list || logical.quote || logical.comment))
      if (logical.blank || boundary) {
        paragraph = false
        state.block = ++block
      } else if (!paragraph) state.block = ++block
      state.blockStart = !paragraph
    }
    const paragraphBefore: boolean = paragraph
    let cursor = Math.max(0, Math.min(source.length, Math.max(codeUntil, commentUntil) - offset))
    while (cursor < source.length) {
      if (source.startsWith('<!--', cursor) && !markdownEscaped(source, cursor)) {
        const start = offset + cursor
        const close = text.indexOf('-->', start + 4)
        const limit = boundary || uncertain.has(lineIndex + 1) ? end : state.flowEnd
        if (close >= 0 && close + 3 <= limit) {
          commentUntil = close + 3
          ranges.push({ start, end: commentUntil })
          cursor = Math.min(source.length, commentUntil - offset)
        } else cursor += 4
      } else if (source[cursor] === '`' && !markdownEscaped(source, cursor)) {
        const width = /^`+/.exec(source.slice(cursor))?.[0].length ?? 1
        const start = offset + cursor
        const limit = boundary || uncertain.has(lineIndex + 1) ? end : state.flowEnd
        const close = codeEnd(text, start + width, width, limit)
        if (close === undefined) cursor += width
        else {
          codeUntil = close + width
          codes.push({ start, end: codeUntil, contentStart: start + width, contentEnd: close })
          ranges.push({ start, end: codeUntil })
          cursor = Math.min(source.length, codeUntil - offset)
        }
      } else cursor++
    }
    // Raw block transitions, not masked ink, determine paragraph/definition eligibility.
    state.definition = !state.container && !paragraphBefore && /^[ \t]*\[(?:\\.|[^\]\\])+\]:/.test(source)
    paragraph = !boundary && !logical.blank && !state.definition
  }
  let visible = ''
  let end = 0
  // Equal-length masking keeps raw JSON, authorized slices and diagnostic offsets intact.
  for (const range of ranges) {
    visible += text.slice(end, range.start) + text.slice(range.start, range.end).replace(/[^\r\n]/g, ' ')
    end = range.end
  }
  return { visible: visible + text.slice(end), codes, uncertain, lines }
}

export function readBlock(text: string, name: string, file: string, issues: PolicyIssue[]): Block | undefined {
  const starts = [...text.matchAll(new RegExp(`^${escapedRegex(`<!-- ${name}:start -->`)}\\r?$`, 'gm'))]
  const ends = [...text.matchAll(new RegExp(`^${escapedRegex(`<!-- ${name}:end -->`)}\\r?$`, 'gm'))]
  const line = lineAt(text, starts[0]?.index ?? ends[0]?.index ?? 0)
  if (starts.length > 1 || ends.length > 1) {
    addIssue(issues, 'BLOCK_DUPLICATE', file, line, `${name}: markers must occur exactly once`)
    return undefined
  }
  const start = starts[0]
  const end = ends[0]
  if (!start || !end) {
    addIssue(issues, 'BLOCK_MISSING', file, line, `${name}: missing start or end marker`)
    return undefined
  }
  if (end.index <= start.index) {
    addIssue(issues, 'BLOCK_ORDER', file, line, `${name}: end marker precedes start marker`)
    return undefined
  }
  const contentStart = start.index + `<!-- ${name}:start -->`.length
  return {
    content: text.slice(contentStart, end.index),
    contentStart,
    contentEnd: end.index,
    start: start.index,
    end: end.index + end[0].length,
    line,
  }
}

const nonempty = z.string().refine((value) => !!value.trim(), 'Expected a nonempty string')
const exactPath = nonempty.refine(isRepositoryPath, 'Expected a canonical, exact repository-relative path')
const taskId = nonempty.refine((value) => ID.test(value), 'Invalid task ID')
const addSchema = z
  .object({
    path: exactPath,
    kind: nonempty.optional(),
    role: z.enum(ROLES).optional(),
    lifecycle: z.enum(LIFECYCLES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ['kind', 'role', 'lifecycle'] as const) {
      if (isManagedDocument(value.path) ? value[field] === undefined : value[field] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: isManagedDocument(value.path)
            ? 'Managed document additions require all registry fields in the base policy'
            : 'Code/runtime/third-party additions accept only {path}',
        })
      }
    }
    if (value.lifecycle === 'retired') {
      context.addIssue({ code: 'custom', path: ['lifecycle'], message: 'An added document cannot be retired' })
    }
  })
const policySchema = z
  .object({
    schema: z.literal(1),
    id: taskId,
    modify: z.array(exactPath),
    sections: z
      .array(z.object({ path: exactPath, block: nonempty.refine((v) => !/[<>\r\n]/.test(v)) }).strict())
      .optional()
      .default([]),
    append: z.array(exactPath),
    add: z.array(addSchema),
    retire: z.array(exactPath),
    history_rewrite: z.array(exactPath),
    receipt: taskId,
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ['modify', 'append', 'retire', 'history_rewrite'] as const) {
      const seen = new Set<string>()
      value[field].forEach((path, index) => {
        if (seen.has(path)) context.addIssue({ code: 'custom', path: [field, index], message: 'Duplicate exact path' })
        seen.add(path)
      })
    }
    for (const field of ['sections', 'add'] as const) {
      const seen = new Set<string>()
      value[field].forEach((item, index) => {
        const key = 'block' in item ? `${item.path}\0${item.block}` : item.path
        if (seen.has(key)) context.addIssue({ code: 'custom', path: [field, index], message: 'Duplicate grant' })
        seen.add(key)
      })
    }
    if (value.receipt !== value.id) {
      context.addIssue({
        code: 'custom',
        path: ['receipt'],
        message: 'receipt must identify this task, not another task',
      })
    }
  })
const executionSchema = z
  .object({
    ClaimBase: z.string().regex(SHA).nullable(),
    Result: nonempty.nullable(),
    Evidence: z.array(nonempty),
    SyncImpact: nonempty.nullable(),
  })
  .strict()
const reviewSchema = z
  .object({
    Decision: nonempty,
    ReviewedCommit: z.string().regex(SHA).nullable(),
    Date: z
      .string()
      .refine(
        (value) =>
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
          new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
        'Expected a valid YYYY-MM-DD calendar date',
      )
      .nullable(),
    Scope: nonempty,
  })
  .strict()
export type TaskPolicy = z.infer<typeof policySchema>
type Execution = z.infer<typeof executionSchema>
type Review = z.infer<typeof reviewSchema>
type TaskHeading = { id: string; phase: string; start: number; end: number; phaseIndex: number; line: number }
export type TaskDocument = {
  headings: Map<string, TaskHeading>
  policies: Map<string, TaskPolicy>
  executions: Map<string, Execution>
  reviews: Map<string, Review>
}

function parseStructured<T>(
  text: string,
  name: string,
  schema: z.ZodType<T>,
  kind: string,
  issues: PolicyIssue[],
): T | undefined {
  const section = readBlock(text, name, PLAN_FILE, issues)
  if (!section) return undefined
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(section.content.trim())
  if (!fenced?.[1]) {
    addIssue(issues, 'JSON_INVALID', PLAN_FILE, section.line, `${name}: expected one fenced JSON object`)
    return undefined
  }
  const json = fenced[1]
  const offset = section.contentStart + section.content.indexOf(json)
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    addIssue(issues, 'JSON_INVALID', PLAN_FILE, lineAt(text, offset), `${name}: ${String(error)}`)
    return undefined
  }
  // JSON.parse silently overwrites duplicate keys; inspect valid JSON tokens before trusting it.
  const stack: { object: boolean; key: boolean; seen: Set<string> }[] = []
  const keyLines = new Map<string, number>()
  let duplicate = false
  for (const token of json.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]/g)) {
    const raw = token[0]
    const top = stack.at(-1)
    if (raw === '{' || raw === '[') stack.push({ object: raw === '{', key: raw === '{', seen: new Set() })
    else if (raw === '}' || raw === ']') stack.pop()
    else if (raw === ',' && top?.object) top.key = true
    else if (raw === ':' && top) top.key = false
    else if (raw.startsWith('"') && top?.object && top.key) {
      const key = JSON.parse(raw) as string
      const line = lineAt(text, offset + token.index)
      if (top.seen.has(key)) {
        addIssue(issues, 'JSON_DUPLICATE_FIELD', PLAN_FILE, line, `${name}.${key}: duplicate JSON field`)
        duplicate = true
      }
      top.seen.add(key)
      if (!keyLines.has(key)) keyLines.set(key, line)
    }
  }
  if (duplicate) return undefined
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    for (const problem of parsed.error.issues) {
      const fields = problem.code === 'unrecognized_keys' ? problem.keys : [String(problem.path.at(-1) ?? '')]
      for (const field of fields) {
        const path = problem.path.length ? problem.path.map(String).join('.') : field
        const code = kind === 'POLICY' && problem.path[0] === 'schema' ? 'POLICY_SCHEMA' : `${kind}_FIELD`
        addIssue(issues, code, PLAN_FILE, keyLines.get(field) ?? section.line, `${name}.${path}: ${problem.message}`)
      }
    }
    return undefined
  }
  return parsed.data
}

export function parseRegistry(text: string, issues: PolicyIssue[]): Map<string, RegistryEntry> {
  const entries = new Map<string, RegistryEntry>()
  const section = readBlock(text, 'docs-registry', REGISTRY_FILE, issues)
  if (!section) return entries
  let row = 0
  let offset = section.contentStart
  for (const source of section.content.split('\n')) {
    const start = offset
    offset += source.length + 1
    if (!source.trim()) continue
    const line = lineAt(text, start)
    const cells = source
      .trim()
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`([^`]+)`$/, '$1'))
    const tableLine = source.trim().startsWith('|') && source.trim().endsWith('|') && cells.length === 4
    if (row++ === 0) {
      if (!tableLine || cells.join('|') !== 'path|kind|role|lifecycle')
        addIssue(issues, 'REGISTRY_ROW', REGISTRY_FILE, line, 'docs-registry: expected path/kind/role/lifecycle header')
      continue
    }
    if (row === 2) {
      if (!tableLine || !cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
        addIssue(issues, 'REGISTRY_ROW', REGISTRY_FILE, line, 'docs-registry: invalid table separator')
      continue
    }
    const [path, kind, role, lifecycle] = cells
    if (
      !tableLine ||
      !path ||
      !isRepositoryPath(path) ||
      !isManagedDocument(path) ||
      !kind ||
      !ROLES.some((item) => item === role) ||
      !LIFECYCLES.some((item) => item === lifecycle)
    ) {
      addIssue(issues, 'REGISTRY_ROW', REGISTRY_FILE, line, 'docs-registry: invalid path/kind/role/lifecycle row')
      continue
    }
    if (entries.has(path))
      addIssue(issues, 'REGISTRY_DUPLICATE', REGISTRY_FILE, line, `docs-registry.path: duplicate registration ${path}`)
    else {
      const cell = source.split('|')[1] ?? ''
      const pathStart = start + source.indexOf('|') + 1 + cell.length - cell.trimStart().length
      entries.set(path, {
        path,
        kind,
        role: role as string,
        lifecycle: lifecycle as RegistryEntry['lifecycle'],
        line,
        pathStart,
        pathEnd: pathStart + cell.trim().length,
      })
    }
  }
  if (row < 2)
    addIssue(issues, 'REGISTRY_ROW', REGISTRY_FILE, section.line, 'docs-registry: missing table header/separator')
  return entries
}

export function validateRegistryCoverage(
  entries: ReadonlyMap<string, RegistryEntry>,
  files: ReadonlySet<string>,
  issues: PolicyIssue[],
): void {
  for (const file of files) {
    if (isManagedDocument(file) && !entries.has(file))
      addIssue(issues, 'REGISTRY_UNREGISTERED', file, 1, 'Project Markdown is not registered in docs/README.md')
  }
  for (const entry of entries.values()) {
    if (entry.lifecycle === 'retired') {
      if (files.has(entry.path))
        addIssue(
          issues,
          'REGISTRY_RETIRED_PRESENT',
          entry.path,
          1,
          `Retired path must be physically absent (registry line ${entry.line})`,
        )
    } else if (!files.has(entry.path)) {
      addIssue(
        issues,
        'REGISTRY_MISSING_DOCUMENT',
        REGISTRY_FILE,
        entry.line,
        `${entry.path}: ${entry.lifecycle} document is missing`,
      )
    }
  }
}

export function parseTasks(text: string, issues: PolicyIssue[]): TaskDocument {
  const headings = new Map<string, TaskHeading>()
  const allHeaders = [...markdownView(text).visible.matchAll(/^(#{1,6})[ \t]+(.+)\r?$/gm)]
  for (const header of allHeaders) {
    const heading = /^(\S+)[ \t]+(?:.*[ \t]+)?([\u2610\u25d0\u2611\u2298])[ \t]*$/.exec(header[2]?.trim() ?? '')
    if (!heading?.[1] || !heading[2] || !ID.test(heading[1])) continue
    const next = allHeaders.find(
      (candidate) => candidate.index > header.index && (candidate[1]?.length ?? 0) <= (header[1]?.length ?? 0),
    )
    const task = {
      id: heading[1],
      phase: heading[2],
      start: header.index,
      end: next?.index ?? text.length,
      phaseIndex: header.index + header[0].lastIndexOf(heading[2]),
      line: lineAt(text, header.index),
    }
    if (headings.has(task.id))
      addIssue(issues, 'TASK_ID_DUPLICATE', PLAN_FILE, task.line, `${task.id}: task ID must be unique`)
    else headings.set(task.id, task)
  }
  const names = new Set<string>()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!/^\s*<!-- task-(?:policy|execution|review):/.test(line)) continue
    const marker = /^<!-- (task-(?:policy|execution|review):([A-Za-z0-9][A-Za-z0-9._/-]*)):(?:start|end) -->$/.exec(
      line,
    )
    if (!marker?.[1])
      addIssue(issues, 'BLOCK_MALFORMED', PLAN_FILE, index + 1, 'Invalid task policy/execution/review marker')
    else names.add(marker[1])
  }
  const policies = new Map<string, TaskPolicy>()
  const executions = new Map<string, Execution>()
  const reviews = new Map<string, Review>()
  for (const name of names) {
    const [kind, id = ''] = name.split(':')
    const section = readBlock(text, name, PLAN_FILE, issues)
    const task = headings.get(id)
    if (!task)
      addIssue(
        issues,
        'TASK_ID_MISSING',
        PLAN_FILE,
        section?.line ?? 1,
        `${name}: no unique task heading with this ID and phase`,
      )
    else if (section) {
      const owner = [...headings.values()]
        .filter((item) => item.start <= section.start && item.end >= section.end)
        .sort((a, b) => b.start - a.start)[0]
      if (owner?.id !== id)
        addIssue(issues, 'TASK_BLOCK_LOCATION', PLAN_FILE, section.line, `${name}: block is outside its task card`)
    }
    if (kind === 'task-policy') {
      const value = parseStructured(text, name, policySchema, 'POLICY', issues)
      if (value) {
        if (value.id !== id)
          addIssue(
            issues,
            'POLICY_FIELD',
            PLAN_FILE,
            section?.line ?? 1,
            `${name}.id: policy ID differs from marker/task ID`,
          )
        else policies.set(id, value)
      }
    } else if (kind === 'task-execution') {
      const value = parseStructured(text, name, executionSchema, 'RECEIPT', issues)
      if (value) executions.set(id, value)
    } else {
      const value = parseStructured(text, name, reviewSchema, 'REVIEW', issues)
      if (value) reviews.set(id, value)
    }
  }
  for (const name of names) {
    if (!name.startsWith('task-policy:')) continue
    const id = name.slice('task-policy:'.length)
    if (!names.has(`task-execution:${id}`)) readBlock(text, `task-execution:${id}`, PLAN_FILE, issues)
    if (!names.has(`task-review:${id}`)) readBlock(text, `task-review:${id}`, PLAN_FILE, issues)
    const task = headings.get(id)
    const execution = executions.get(id)
    const review = reviews.get(id)
    if ((task?.phase === ONGOING || task?.phase === COMPLETE) && !execution?.ClaimBase)
      addIssue(
        issues,
        'RECEIPT_CLAIM_BASE',
        PLAN_FILE,
        task.line,
        `${id}.ClaimBase: claimed task requires a full commit SHA`,
      )
    if (task?.phase === COMPLETE) {
      if (!execution?.Result || !execution.Evidence.length || !execution.SyncImpact)
        addIssue(
          issues,
          'RECEIPT_INCOMPLETE',
          PLAN_FILE,
          task.line,
          `${id}: completed task requires Result, Evidence and SyncImpact`,
        )
      if (review?.Decision !== 'pass' || !review.ReviewedCommit || !review.Date)
        addIssue(
          issues,
          'TASK_REVIEW_REQUIRED',
          PLAN_FILE,
          task.line,
          `${id}: completion requires Decision=pass, ReviewedCommit and Date`,
        )
    }
  }
  return { headings, policies, executions, reviews }
}

export function validateTaskEntry(text: string, tasks: TaskDocument, issues: PolicyIssue[]): void {
  const section = readBlock(text, 'active-task', SNAPSHOT_FILE, issues)
  if (!section) return
  const content = section.content.trim()
  if (content === '-') return
  const body = content.replace(/^\u5f53\u524d\u4efb\u52a1[\uff1a:][ \t]*/, '')
  const link = /^\[([A-Za-z0-9][A-Za-z0-9._/-]*)\]\(([^\s()]+)\)$/.exec(body)
  const id = link?.[1] ?? (ID.test(body) ? body : undefined)
  if (!id) {
    addIssue(
      issues,
      'TASK_ENTRY_FORMAT',
      SNAPSHOT_FILE,
      section.line + 1,
      'active-task: only one task ID/link or -; do not copy a task phase',
    )
    return
  }
  if (!tasks.headings.has(id))
    addIssue(issues, 'TASK_ENTRY_ID', SNAPSHOT_FILE, section.line + 1, `active-task: unknown task ID ${id}`)
  if (link?.[2]) {
    try {
      if (localReferencePath(SNAPSHOT_FILE, link[2]) !== PLAN_FILE)
        addIssue(
          issues,
          'TASK_ENTRY_FORMAT',
          SNAPSHOT_FILE,
          section.line + 1,
          'active-task: link must target the execution plan',
        )
    } catch {
      addIssue(issues, 'TASK_ENTRY_FORMAT', SNAPSHOT_FILE, section.line + 1, 'active-task: invalid link encoding')
    }
  }
}

function masked(text: string, ranges: { start: number; end: number }[]): string {
  for (const range of ranges.sort((a, b) => b.start - a.start))
    text = `${text.slice(0, range.start)}<authorized>${text.slice(range.end)}`
  return text
}

function checkSections(before: string, after: string, file: string, names: string[], issues: PolicyIssue[]): void {
  const blocks = [before, after].map((text) => names.map((name) => readBlock(text, name, file, issues)))
  if (blocks.some((items) => items.some((item) => !item))) return
  const ranges = blocks.map((items) => items.filter((item): item is Block => !!item).sort((a, b) => a.start - b.start))
  if (ranges.some((items) => items.some((item, index) => index > 0 && (items[index - 1]?.end ?? 0) > item.start))) {
    addIssue(issues, 'SECTION_OVERLAP', file, 1, 'Authorized blocks must not overlap or nest')
    return
  }
  if (
    masked(
      before,
      (ranges[0] ?? []).map((item) => ({ start: item.contentStart, end: item.contentEnd })),
    ) !==
    masked(
      after,
      (ranges[1] ?? []).map((item) => ({ start: item.contentStart, end: item.contentEnd })),
    )
  ) {
    addIssue(
      issues,
      'SECTION_SCOPE',
      file,
      1,
      `Only inner content of ${names.join(', ')} may change; markers and all outside text are protected`,
    )
  }
}

function checkReceipt(
  before: string,
  after: string,
  id: string,
  baseTasks: TaskDocument,
  targetTasks: TaskDocument,
  issues: PolicyIssue[],
): void {
  const oldBlock = readBlock(before, `task-execution:${id}`, PLAN_FILE, issues)
  const newBlock = readBlock(after, `task-execution:${id}`, PLAN_FILE, issues)
  const oldTask = baseTasks.headings.get(id)
  const newTask = targetTasks.headings.get(id)
  if (!oldBlock || !newBlock || !oldTask || !newTask) return
  const oldRanges = [{ start: oldBlock.contentStart, end: oldBlock.contentEnd }]
  const newRanges = [{ start: newBlock.contentStart, end: newBlock.contentEnd }]
  if (oldTask.phase !== newTask.phase) {
    if (oldTask.phase === EMPTY && newTask.phase === ONGOING) {
      oldRanges.push({ start: oldTask.phaseIndex, end: oldTask.phaseIndex + 1 })
      newRanges.push({ start: newTask.phaseIndex, end: newTask.phaseIndex + 1 })
    } else
      addIssue(
        issues,
        'TASK_PHASE_PROTECTED',
        PLAN_FILE,
        newTask.line,
        `${id}: executor may only change the first unstarted phase to ongoing`,
      )
  }
  if (masked(before, oldRanges) !== masked(after, newRanges))
    addIssue(
      issues,
      'TASK_SCOPE',
      PLAN_FILE,
      newTask.line,
      `${id}: only this execution block and first start phase may change; policy/acceptance/review/other tasks are protected`,
    )
}

export function validateIncremental(
  base: TextSnapshot,
  target: TextSnapshot,
  changes: FileChange[],
  task: string,
  baseSha: string,
  issues: PolicyIssue[],
): void {
  const beforePlan = base.texts.get(PLAN_FILE) ?? ''
  const afterPlan = target.texts.get(PLAN_FILE) ?? ''
  const baseTasks = parseTasks(beforePlan, issues)
  const targetTasks = parseTasks(afterPlan, issues)
  const policy = baseTasks.policies.get(task)
  if (!policy) {
    addIssue(
      issues,
      'TASK_POLICY_MISSING',
      PLAN_FILE,
      1,
      `${task}: no valid task-policy in base ${baseSha}; current policy cannot grant permission`,
    )
    return
  }
  const assigned = baseTasks.headings.get(task)
  const execution = baseTasks.executions.get(task)
  const review = baseTasks.reviews.get(task)
  if (
    assigned?.phase !== EMPTY ||
    execution?.ClaimBase !== null ||
    review?.Decision !== 'pending' ||
    review.ReviewedCommit !== null ||
    review.Date !== null
  ) {
    addIssue(
      issues,
      'BASE_TASK_NOT_UNCLAIMED',
      PLAN_FILE,
      assigned?.line ?? 1,
      `${task} at base ${baseSha}: first authorization requires an unstarted task, null ClaimBase and an unstamped pending review; resume with the original ClaimBase`,
    )
  }
  const sectionGroups = new Map<string, string[]>()
  for (const section of policy.sections) {
    const blocks = sectionGroups.get(section.path) ?? []
    blocks.push(section.block)
    sectionGroups.set(section.path, blocks)
  }
  for (const [file, blocks] of sectionGroups) {
    const before = base.texts.get(file) ?? ''
    const after = target.texts.get(file) ?? ''
    checkSections(before, after, file, blocks, issues)
  }
  if (targetTasks.executions.get(task)?.ClaimBase !== baseSha)
    addIssue(
      issues,
      'RECEIPT_BASE_MISMATCH',
      PLAN_FILE,
      targetTasks.headings.get(task)?.line ?? 1,
      `${task}.ClaimBase must equal resolved assignment base ${baseSha}`,
    )
  const baseRegistry = parseRegistry(base.texts.get(REGISTRY_FILE) ?? '', issues)
  const targetRegistry = parseRegistry(target.texts.get(REGISTRY_FILE) ?? '', issues)
  for (const change of changes) {
    const file = change.path
    const before = base.texts.get(file) ?? ''
    const after = target.texts.get(file) ?? ''
    const detail = `${task} at base ${baseSha}`
    if (change.kind !== 'D' && !['100644', '100755'].includes(change.newMode))
      addIssue(issues, 'FILE_TYPE_UNSUPPORTED', file, 1, `${detail}: changed target must be a regular file`)
    if (
      change.kind !== 'D' &&
      (baseRegistry.get(file)?.lifecycle === 'retired' || targetRegistry.get(file)?.lifecycle === 'retired')
    )
      addIssue(
        issues,
        'RETIRED_CHANGED',
        file,
        1,
        `${detail}: changed retired path is a restoration/modification, not an unchanged legacy blob`,
      )
    if (change.kind === 'A') {
      const approved = policy.add.find((item) => item.path === file)
      if (!approved) addIssue(issues, 'ADD_NOT_APPROVED', file, 1, `${detail}: addition requires an exact add grant`)
      else if (isManagedDocument(file)) {
        const entry = targetRegistry.get(file)
        if (
          !entry ||
          entry.kind !== approved.kind ||
          entry.role !== approved.role ||
          entry.lifecycle !== approved.lifecycle
        )
          addIssue(
            issues,
            'ADD_REGISTRY_MISMATCH',
            file,
            1,
            `${detail}: target registration must match approved path/kind/role/lifecycle`,
          )
        if (!target.navigation.has(file))
          addIssue(
            issues,
            'ADD_NAVIGATION_MISSING',
            file,
            1,
            `${detail}: added document requires a real local navigation link in docs/README.md`,
          )
      }
      continue
    }
    if (change.kind === 'D') {
      if (!policy.retire.includes(file))
        addIssue(
          issues,
          'RETIRE_NOT_APPROVED',
          file,
          1,
          `${detail}: deletion/rename source requires an exact retire grant`,
        )
      else if (isManagedDocument(file) && targetRegistry.get(file)?.lifecycle !== 'retired')
        addIssue(
          issues,
          'RETIRE_REGISTRY_MISMATCH',
          file,
          1,
          `${detail}: retired document requires a retired registry row`,
        )
      continue
    }
    if (file === PLAN_FILE) {
      if (change.oldMode !== change.newMode)
        addIssue(issues, 'FILE_MODE_PROTECTED', file, 1, 'Execution plan file mode is protected')
      checkReceipt(before, after, policy.receipt, baseTasks, targetTasks, issues)
      continue
    }
    const entry = baseRegistry.get(file)
    const historical =
      policy.append.includes(file) ||
      /^docs\/archive\/.+\.md$/i.test(file) ||
      entry?.role === 'append-only' ||
      entry?.lifecycle === 'archive' ||
      entry?.kind === 'history'
    const rewrite = policy.history_rewrite.includes(file)
    if (historical) {
      if (change.oldMode !== change.newMode)
        addIssue(issues, 'FILE_MODE_PROTECTED', file, 1, 'Historical text grants do not authorize file mode changes')
      if (!rewrite && !after.replaceAll('\r\n', '\n').startsWith(before.replaceAll('\r\n', '\n')))
        addIssue(
          issues,
          'HISTORY_REWRITE',
          file,
          1,
          `${detail}: complete normalized historical text must remain a prefix; a section/modify grant cannot exempt it`,
        )
    }
    const sections = policy.sections.filter((item) => item.path === file).map((item) => item.block)
    if (sections.length) {
      if (change.oldMode !== change.newMode)
        addIssue(issues, 'FILE_MODE_PROTECTED', file, 1, 'Section grant does not authorize file mode changes')
      checkSections(before, after, file, sections, issues)
    } else if (!rewrite && !policy.append.includes(file) && (historical || !policy.modify.includes(file)))
      addIssue(
        issues,
        'SCOPE_DENIED',
        file,
        1,
        `${detail}: changed file requires an exact grant; historical modify does not authorize rewriting`,
      )
  }
  if (base.texts.get(REGISTRY_FILE) !== target.texts.get(REGISTRY_FILE)) {
    for (const entry of targetRegistry.values()) {
      const old = baseRegistry.get(entry.path)
      if (old && old.kind === entry.kind && old.role === entry.role && old.lifecycle === entry.lifecycle) continue
      if (entry.lifecycle === 'retired' ? target.files.has(entry.path) : !target.files.has(entry.path))
        addIssue(
          issues,
          'REGISTRY_MISSING_DOCUMENT',
          REGISTRY_FILE,
          entry.line,
          `${entry.path}: changed registry row does not match target tree lifecycle`,
        )
    }
    for (const old of baseRegistry.values()) {
      if (old.lifecycle !== 'retired' && target.files.has(old.path) && !targetRegistry.has(old.path))
        addIssue(issues, 'REGISTRY_UNREGISTERED', old.path, 1, 'Registry edit removed a still-present project document')
    }
  }
}
