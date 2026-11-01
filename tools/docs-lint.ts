import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type DocLintIssue = { file: string; line: number; message: string }

const GENERATED = /(?:^|\/)(?:node_modules|build|dist|out|test-results|playwright-report|\.git)\//

export function listMarkdownFiles(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
  return [...new Set(output.split('\0'))]
    .filter((file) => /\.md$/i.test(file) && !GENERATED.test(file) && existsSync(resolve(root, file)))
    .sort()
}

function escaped(text: string, index: number): boolean {
  let count = 0
  while (index > 0 && text[--index] === '\\') count++
  return count % 2 === 1
}

function linkTargets(line: string): string[] {
  const targets: string[] = []
  for (const match of line.matchAll(/\[[^\]\r\n]*\]\(/g)) {
    if (escaped(line, match.index)) continue
    let start = match.index + match[0].length
    while (/\s/.test(line[start] ?? '')) start++
    let end = start
    let suffix = end
    if (line[start] === '<') {
      start++
      end = start
      while (end < line.length && (line[end] !== '>' || escaped(line, end))) end++
      if (end === line.length) continue
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
      if (depth !== 0) continue
      suffix = end
    }
    if (/^\s*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*)?\)/.test(line.slice(suffix))) {
      targets.push(line.slice(start, end))
    }
  }
  return targets
}

function checkTarget(root: string, file: string, line: number, target: string, repositoryPath = false): DocLintIssue[] {
  if (!target || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) return []
  const path = target.split(/[?#]/, 1)[0] ?? ''
  if (!path) return []
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
      .replace(/\\([\\()[\]<> ])/g, '$1')
      .replaceAll('\\', '/')
  } catch {
    return [{ file, line, message: `Invalid URL encoding: ${target}` }]
  }
  const base = repositoryPath || decoded.startsWith('/') ? root : dirname(resolve(root, file))
  const full = resolve(base, decoded.startsWith('/') ? `.${decoded}` : decoded)
  return existsSync(full) ? [] : [{ file, line, message: `Missing local target: ${target}` }]
}

export function lintMarkdown(root: string, file: string, text: string): DocLintIssue[] {
  const issues: DocLintIssue[] = []
  if (/^[0-9]/.test(basename(file.replaceAll('\\', '/')))) {
    issues.push({ file, line: 1, message: 'Markdown filenames must not start with a digit' })
  }
  let fence: { char: string; length: number } | undefined
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(source)
    if (fence) {
      if (marker && marker[1]?.[0] === fence.char && marker[1].length >= fence.length && !marker[2]?.trim()) {
        fence = undefined
      }
      continue
    }
    if (marker) {
      fence = { char: marker[1]?.[0] ?? '`', length: marker[1]?.length ?? 3 }
      continue
    }
    let line = source
    for (const code of source.matchAll(/(?<!`)(`+)(.*?)(?<!`)\1(?!`)/g)) {
      // Only repository docs paths are contracts; absolute local evidence is historical.
      for (const reference of (code[2] ?? '').matchAll(
        /(?:^|\s)(docs[\\/][^`<>"\r\n]*?\.md(?:[?#][^\s]*)?)(?=\s|$)/g,
      )) {
        const target = reference[1] ?? ''
        if (!target.includes('*')) issues.push(...checkTarget(root, file, index + 1, target, true))
      }
      line = `${line.slice(0, code.index)}${' '.repeat(code[0].length)}${line.slice(code.index + code[0].length)}`
    }
    for (const target of linkTargets(line)) issues.push(...checkTarget(root, file, index + 1, target))
  }
  return issues
}

export function lintDocs(root: string, files = listMarkdownFiles(root)): DocLintIssue[] {
  return files.flatMap((file) => {
    if (!/\.md$/i.test(file) || GENERATED.test(file.replaceAll('\\', '/')) || !existsSync(resolve(root, file)))
      return []
    return lintMarkdown(root, file, readFileSync(resolve(root, file), 'utf8'))
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const root = resolve(process.argv[2] ?? process.cwd())
    const files = listMarkdownFiles(root)
    const issues = lintDocs(root, files)
    for (const issue of issues) console.error(`${issue.file}:${issue.line}: ${issue.message}`)
    console.log(`${files.length} Markdown files; ${issues.length} issues`)
    process.exitCode = issues.length ? 1 : 0
  } catch (error) {
    console.error(`docs:lint: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
