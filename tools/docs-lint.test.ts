import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lintDocs, lintMarkdown, listMarkdownFiles } from './docs-lint.ts'

const roots: string[] = []
function workspace(): string {
  const root = resolve(mkdtempSync(join(tmpdir(), 'virtual-docs-lint-')))
  roots.push(root)
  return root
}

function write(root: string, file: string, text = ''): void {
  const full = join(root, file)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      dirname(root) !== resolve(tmpdir()) ||
      !/^virtual-docs-lint-[A-Za-z0-9_-]+$/.test(basename(root)) ||
      !lstatSync(root).isDirectory() ||
      lstatSync(root).isSymbolicLink()
    ) {
      throw new Error('Refusing to remove an unexpected fixture directory')
    }
    rmSync(root, { recursive: true, force: true })
  }
})

describe('docs:lint', () => {
  it('rejects both numeric ordering prefixes and names such as 3D-assets', () => {
    const root = workspace()
    expect(lintMarkdown(root, 'docs/01-plan.md', '# Plan')).toEqual([
      { file: 'docs/01-plan.md', line: 1, message: 'Markdown filenames must not start with a digit' },
    ])
    expect(lintMarkdown(root, 'docs/3D-assets.md', '')).toHaveLength(1)
    expect(lintMarkdown(root, 'docs/assets-3D.md', '')).toEqual([])
  })

  it('checks relative links, images, titles and repository-root links', () => {
    const root = workspace()
    write(root, 'README.md')
    write(root, 'docs/guide.md')
    write(root, 'assets/panel.svg')
    expect(
      lintMarkdown(root, 'docs/index.md', '[guide](guide.md "Guide") ![panel](../assets/panel.svg) [root](/README.md)'),
    ).toEqual([])
    expect(lintMarkdown(root, 'docs/index.md', '# Index\n![panel](missing.svg)\n[guide](old.md)')).toEqual([
      { file: 'docs/index.md', line: 2, message: 'Missing local target: missing.svg' },
      { file: 'docs/index.md', line: 3, message: 'Missing local target: old.md' },
    ])
  })

  it('decodes paths after removing query and fragment, including encoded punctuation and unicode', () => {
    const root = workspace()
    const name = 'A (draft) #1 \u6587\u6863.md'
    write(root, `docs/${name}`)
    const target = encodeURIComponent(name)
    expect(lintMarkdown(root, 'docs/index.md', `[guide](${target}?raw=1#section)`)).toEqual([])
    expect(lintMarkdown(root, 'docs/index.md', '[bad](guide%ZZ.md)')).toEqual([
      { file: 'docs/index.md', line: 1, message: 'Invalid URL encoding: guide%ZZ.md' },
    ])
  })

  it('handles angle targets with spaces, balanced parentheses and escaped punctuation', () => {
    const root = workspace()
    write(root, 'docs/A (draft).md')
    write(root, 'docs/a(b(c)).md')
    expect(
      lintMarkdown(root, 'docs/index.md', '[a](<A (draft).md> "Title") [b](a(b(c)).md) [c](A\\ \\(draft\\).md)'),
    ).toEqual([])
  })

  it('ignores external protocols, protocol-relative targets, pure anchors and queries', () => {
    const root = workspace()
    expect(
      lintMarkdown(
        root,
        'README.md',
        '[web](https://example.test/missing.md) [mail](mailto:a@example.test) [app](codex://review) ' +
          '![data](data:image/png;base64,abc) [host](//example.test/guide.md) [here](#section) [query](?view=all)',
      ),
    ).toEqual([])
  })

  it('skips fenced examples with matching marker type and minimum closing length', () => {
    const root = workspace()
    const text = [
      '````md',
      '[example](missing.md)',
      '```',
      '`docs/old.md`',
      '````',
      '~~~markdown',
      '[example](also-missing.md)',
      '~~~',
      '[actual](missing.md)',
    ].join('\n')
    expect(lintMarkdown(root, 'README.md', text)).toEqual([
      { file: 'README.md', line: 9, message: 'Missing local target: missing.md' },
    ])
  })

  it('checks repository docs references in inline code but not link examples or absolute evidence', () => {
    const root = workspace()
    write(root, 'docs/guide.md')
    write(root, 'docs/A draft.md')
    const text = [
      'See `docs/guide.md` and ``docs/A draft.md``.',
      'Old `docs/old.md#details` and `docs\\missing.md`.',
      '`[example](missing.md)` and `D:\\old\\build\\01-evidence.md` and `docs/*.md`.',
      '`D:\\old\\docs\\historical.md` and \\[literal](missing.md).',
    ].join('\n')
    expect(lintMarkdown(root, 'README.md', text)).toEqual([
      { file: 'README.md', line: 2, message: 'Missing local target: docs/old.md#details' },
      { file: 'README.md', line: 2, message: 'Missing local target: docs\\missing.md' },
    ])
  })

  it('lists cached and untracked Markdown safely while skipping deleted and generated files', () => {
    const root = workspace()
    execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore' })
    write(root, '.gitignore', 'build/\nnode_modules/\n')
    write(root, 'README.md')
    write(root, 'docs/deleted.md')
    execFileSync('git', ['add', '--', '.gitignore', 'README.md', 'docs/deleted.md'], { cwd: root })
    unlinkSync(join(root, 'docs/deleted.md'))
    write(root, 'docs/new [draft].md')
    write(root, 'build/01-output.md')
    write(root, 'node_modules/package/01-guide.md')
    expect(listMarkdownFiles(root)).toEqual(['README.md', 'docs/new [draft].md'])
    expect(lintDocs(root)).toEqual([])
    expect(lintDocs(root, ['docs/deleted.md', 'build/01-output.md'])).toEqual([])
  })
})

const PLAN = 'docs/\u6267\u884c\u8ba1\u5212.md'
const SNAPSHOT = 'docs/\u9879\u76ee\u72b6\u6001.md'
const HISTORY = 'docs/archive/history.md'
const RETIRED = 'docs/04-legacy.md'
const CLI = resolve(import.meta.dirname, 'docs-lint.ts')
const EMPTY = '\u2610'
const ONGOING = '\u25d0'
const COMPLETE = '\u2611'
const CURRENT = '\u5f53\u524d\u4efb\u52a1\uff1a'

type FixturePolicy = {
  schema: number
  id: string
  modify: string[]
  sections: { path: string; block: string }[]
  append: string[]
  add: Record<string, string>[]
  retire: string[]
  history_rewrite: string[]
  receipt: string
}

type CliReport = {
  mode: string
  task: string | null
  base: string | null
  target: string
  issues: { code: string; file: string; line: number; message: string }[]
}

function git(root: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Docs Fixture',
      '-c',
      'user.email=docs-fixture@example.test',
      '-c',
      'core.autocrlf=false',
      '-c',
      `core.hooksPath=${join(root, '.git', 'empty-hooks')}`,
      '-c',
      'commit.gpgSign=false',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    },
  ).trim()
}

function block(name: string, value: unknown): string {
  return `<!-- ${name}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${name}:end -->`
}

function replace(root: string, file: string, before: string, after: string): void {
  const text = readFileSync(join(root, file), 'utf8')
  if (!text.includes(before)) throw new Error(`Fixture replacement did not match ${file}: ${before}`)
  write(root, file, text.replace(before, after))
}

function setBlock(root: string, file: string, name: string, value: unknown): void {
  const text = readFileSync(join(root, file), 'utf8')
  const start = text.indexOf(`<!-- ${name}:start -->`)
  const end = text.indexOf(`<!-- ${name}:end -->`) + `<!-- ${name}:end -->`.length
  if (start < 0 || end < start) throw new Error(`Missing fixture block ${name}`)
  write(root, file, text.slice(0, start) + block(name, value) + text.slice(end))
}

function policy(): FixturePolicy {
  return {
    schema: 1,
    id: 'GOV-01',
    modify: ['tools/allowed.ts'],
    sections: [{ path: 'docs/README.md', block: 'docs-usage' }],
    append: [HISTORY],
    add: [{ path: 'tools/added.ts' }],
    retire: [],
    history_rewrite: [],
    receipt: 'GOV-01',
  }
}

function fixture(
  overrides: Partial<FixturePolicy> = {},
  named = false,
  initialHistory = '# History\nOriginal entry.\n',
): { root: string; base: string } {
  const container = workspace()
  const root = named ? join(container, '\u6587\u6863 space [fixture]') : container
  mkdirSync(root, { recursive: true })
  git(root, ['init', '--quiet'])
  write(root, '.gitignore', 'build/\nnode_modules/\n')
  write(root, 'README.md', '# Lab\n')
  const entries = ['README.md', 'docs/README.md', PLAN, SNAPSHOT, 'docs/current.md']
  write(
    root,
    'docs/README.md',
    [
      '# Documents',
      'Accepted capabilities remain unchanged.',
      '<!-- docs-registry:start -->',
      '| path | kind | role | lifecycle |',
      '|------|------|------|-----------|',
      ...entries.map((path) => `| \`${path}\` | reference | architect | active |`),
      `| \`${HISTORY}\` | history | append-only | archive |`,
      `| ${RETIRED} | legacy | architect | retired |`,
      '<!-- docs-registry:end -->',
      '<!-- docs-usage:start -->',
      '[Current](current.md)',
      '<!-- docs-usage:end -->',
      '',
    ].join('\n'),
  )
  write(root, 'docs/current.md', '# Current\n')
  write(root, HISTORY, initialHistory)
  write(root, RETIRED, '# Old tracked document\n')
  write(root, 'tools/allowed.ts', 'export const value = 1\n')
  write(root, 'tools/blocked.ts', 'export const other = 1\n')
  write(
    root,
    PLAN,
    [
      '# Tasks',
      '<a id="gov-01"></a>',
      `### GOV-01 Governance ${EMPTY}`,
      '**Acceptance**: Keep the existing contract.',
      block('task-policy:GOV-01', { ...policy(), ...overrides }),
      block('task-execution:GOV-01', { ClaimBase: null, Result: null, Evidence: [], SyncImpact: null }),
      block('task-review:GOV-01', { Decision: 'pending', ReviewedCommit: null, Date: null, Scope: 'tooling-only' }),
      `### OTHER-01 Other task ${EMPTY}`,
      'Do not change this task.',
      '',
    ].join('\n\n'),
  )
  write(
    root,
    SNAPSHOT,
    `# Snapshot\n<!-- active-task:start -->\n${CURRENT}[GOV-01](\u6267\u884c\u8ba1\u5212.md#gov-01)\n<!-- active-task:end -->\n`,
  )
  git(root, ['add', '--', '.'])
  git(root, ['commit', '--quiet', '-m', 'fixture assignment'])
  const base = git(root, ['rev-parse', 'HEAD'])
  // The index deliberately retains this retired blob, just like the user's old deletion.
  unlinkSync(join(root, RETIRED))
  return { root, base }
}

function claim(root: string, base: string): void {
  replace(root, PLAN, `Governance ${EMPTY}`, `Governance ${ONGOING}`)
  setBlock(root, PLAN, 'task-execution:GOV-01', {
    ClaimBase: base,
    Result: 'Implementation delivered; pending architecture review.',
    Evidence: ['build/tasks/GOV-01/fixture.log'],
    SyncImpact: 'Tooling and directed tests only.',
  })
}

function delivery(root: string, base: string): void {
  claim(root, base)
  write(root, 'tools/allowed.ts', 'export const value = 2\n')
  git(root, ['add', '--', PLAN, 'tools/allowed.ts'])
}

function cli(root: string, args: string[], label: string, directory = true) {
  const parameters = [CLI, ...(directory ? [root] : []), ...args]
  const result = spawnSync(process.execPath, parameters, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      NODE_OPTIONS: '--max-old-space-size=96',
    },
  })
  if (result.error) throw result.error
  const evidence = process.env.DOCS_LINT_FIXTURE_LOG
  if (evidence) {
    const expected = resolve(import.meta.dirname, '../build/tasks/GOV-03')
    if (dirname(resolve(evidence)) !== expected || !/^fixture-cli-[\w-]+\.jsonl$/.test(basename(evidence))) {
      throw new Error('Refusing to write fixture evidence outside the approved task directory')
    }
    appendFileSync(
      evidence,
      `${JSON.stringify({ label, argv: parameters, exit: result.status, stdout: result.stdout, stderr: result.stderr })}\n`,
    )
  }
  console.log(
    `Fixture CLI: ${label}\nargv: ${JSON.stringify(parameters)}\nexit: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  return result
}

function report(result: ReturnType<typeof cli>): CliReport {
  const value = JSON.parse(result.stdout) as CliReport
  expect(Array.isArray(value.issues)).toBe(true)
  for (const issue of value.issues) {
    expect(issue.code).toMatch(/^[A-Z][A-Z0-9_]+$/)
    expect(issue.file.length).toBeGreaterThan(0)
    expect(Number.isInteger(issue.line) && issue.line > 0).toBe(true)
    expect(issue.message.length).toBeGreaterThan(0)
  }
  return value
}

function staged(root: string, base: string, label: string) {
  return cli(root, ['--task', 'GOV-01', '--base', base, '--staged', '--json'], label)
}

function rejected(result: ReturnType<typeof cli>, code: string, file?: string): CliReport {
  expect(result.status).not.toBe(0)
  const value = report(result)
  expect(value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code, ...(file ? { file } : {}) })]))
  return value
}

describe('GOV-01 static CLI', () => {
  it('supports cwd, optional Chinese/space directory, text and JSON without changing Git', () => {
    const { root } = fixture({}, true)
    const index = readFileSync(join(root, '.git/index'))
    const objects = git(root, ['count-objects', '-v'])
    const status = git(root, ['status', '--porcelain=v1'])
    expect(cli(root, [], 'static cwd', false).status).toBe(0)
    const result = cli(root, ['--json'], 'static optional directory JSON')
    expect(result.status).toBe(0)
    expect(report(result)).toMatchObject({ mode: 'static', task: null, base: null, target: 'worktree', issues: [] })
    expect(readFileSync(join(root, '.git/index'))).toEqual(index)
    expect(git(root, ['count-objects', '-v'])).toBe(objects)
    expect(git(root, ['status', '--porcelain=v1'])).toBe(status)
  })

  it('exempts runtime/third-party docs only from the registry and accepts an empty assignment', () => {
    const { root } = fixture()
    write(root, 'content/projects/demo/guide.md', '# Runtime\n[Root](/README.md)\n')
    write(root, 'resources/vendor/LICENSE.md', '# License\n')
    const text = readFileSync(join(root, SNAPSHOT), 'utf8')
    write(root, SNAPSHOT, text.replace(`${CURRENT}[GOV-01](\u6267\u884c\u8ba1\u5212.md#gov-01)`, '-'))
    expect(cli(root, ['--json'], 'runtime exemption and empty assignment').status).toBe(0)
  })

  it('accepts a valid ongoing claim with temporarily empty results', () => {
    const { root, base } = fixture()
    claim(root, base)
    setBlock(root, PLAN, 'task-execution:GOV-01', { ClaimBase: base, Result: null, Evidence: [], SyncImpact: null })
    expect(cli(root, ['--json'], 'ongoing partial receipt').status).toBe(0)
  })

  it('does not require old completed cards to invent policy/receipts and accepts optional sections', () => {
    const { root } = fixture()
    const withoutSections: Partial<FixturePolicy> = policy()
    delete withoutSections.sections
    setBlock(root, PLAN, 'task-policy:GOV-01', withoutSections)
    write(root, PLAN, `${readFileSync(join(root, PLAN), 'utf8')}\n### LEGACY-01 Historical completion ${COMPLETE}\n`)
    expect(cli(root, ['--json'], 'legacy completion and optional sections').status).toBe(0)
  })

  it('accepts completed governed cards only with complete receipts and a valid pass review', () => {
    const { root, base } = fixture()
    claim(root, base)
    replace(root, PLAN, `Governance ${ONGOING}`, `Governance ${COMPLETE}`)
    setBlock(root, PLAN, 'task-review:GOV-01', {
      Decision: 'pass',
      ReviewedCommit: base,
      Date: '2026-10-30',
      Scope: 'tooling-only',
    })
    expect(cli(root, ['--json'], 'complete receipt and review').status).toBe(0)
  })

  const invalid: { name: string; code: string; change: (root: string, base: string) => void }[] = [
    {
      name: 'unregistered root document',
      code: 'REGISTRY_UNREGISTERED',
      change: (r) => write(r, 'notes.md', '# Notes'),
    },
    {
      name: 'unregistered Chinese/space document',
      code: 'REGISTRY_UNREGISTERED',
      change: (r) => write(r, 'docs/\u65b0 \u6587\u6863 [draft].md', '# New'),
    },
    {
      name: 'ignored managed document',
      code: 'REGISTRY_UNREGISTERED',
      change: (r) => {
        write(r, '.gitignore', 'build/\nnode_modules/\ndocs/hidden.md\n')
        write(r, 'docs/hidden.md', '# Hidden')
      },
    },
    {
      name: 'duplicate registry row',
      code: 'REGISTRY_DUPLICATE',
      change: (r) =>
        replace(
          r,
          'docs/README.md',
          '<!-- docs-registry:end -->',
          '| `README.md` | reference | architect | active |\n<!-- docs-registry:end -->',
        ),
    },
    {
      name: 'missing active document',
      code: 'REGISTRY_MISSING_DOCUMENT',
      change: (r) => unlinkSync(join(r, 'docs/current.md')),
    },
    {
      name: 'missing archive document',
      code: 'REGISTRY_MISSING_DOCUMENT',
      change: (r) => unlinkSync(join(r, HISTORY)),
    },
    {
      name: 'retired document reappears',
      code: 'REGISTRY_RETIRED_PRESENT',
      change: (r) => write(r, RETIRED, '# Restored'),
    },
    {
      name: 'retired link is not a valid target',
      code: 'RETIRED_TARGET',
      change: (r) => write(r, 'README.md', `[Old](${RETIRED})\n`),
    },
    {
      name: 'runtime naming remains enforced',
      code: 'MARKDOWN_NAME',
      change: (r) => write(r, 'content/01-guide.md', '# Runtime'),
    },
    {
      name: 'runtime links remain enforced',
      code: 'LOCAL_TARGET_MISSING',
      change: (r) => write(r, 'resources/vendor/LICENSE.md', '[Missing](absent.txt)'),
    },
    {
      name: 'unknown registry role',
      code: 'REGISTRY_ROW',
      change: (r) => replace(r, 'docs/README.md', '| architect | active |', '| writer | active |'),
    },
    { name: 'missing task ID', code: 'TASK_ENTRY_ID', change: (r) => replace(r, SNAPSHOT, '[GOV-01]', '[MISSING-01]') },
    {
      name: 'policy has no matching task heading',
      code: 'TASK_ID_MISSING',
      change: (r) => replace(r, PLAN, '### GOV-01 Governance', '### RENAMED-01 Governance'),
    },
    {
      name: 'duplicate task ID',
      code: 'TASK_ID_DUPLICATE',
      change: (r) => write(r, PLAN, `${readFileSync(join(r, PLAN), 'utf8')}\n### GOV-01 Duplicate ${EMPTY}\n`),
    },
    {
      name: 'entry copies a stage',
      code: 'TASK_ENTRY_FORMAT',
      change: (r) => replace(r, SNAPSHOT, '#gov-01)', `#gov-01) ${ONGOING}`),
    },
    {
      name: 'entry repeats a task',
      code: 'TASK_ENTRY_FORMAT',
      change: (r) => replace(r, SNAPSHOT, '#gov-01)', '#gov-01) [GOV-01](\u6267\u884c\u8ba1\u5212.md#gov-01)'),
    },
    {
      name: 'ongoing without ClaimBase',
      code: 'RECEIPT_CLAIM_BASE',
      change: (r) => replace(r, PLAN, `Governance ${EMPTY}`, `Governance ${ONGOING}`),
    },
    {
      name: 'completed without review',
      code: 'TASK_REVIEW_REQUIRED',
      change: (r, b) => {
        claim(r, b)
        replace(r, PLAN, `Governance ${ONGOING}`, `Governance ${COMPLETE}`)
      },
    },
    {
      name: 'completed without result',
      code: 'RECEIPT_INCOMPLETE',
      change: (r, b) => {
        claim(r, b)
        replace(r, PLAN, `Governance ${ONGOING}`, `Governance ${COMPLETE}`)
        setBlock(r, PLAN, 'task-execution:GOV-01', { ClaimBase: b, Result: null, Evidence: [], SyncImpact: null })
      },
    },
    {
      name: 'unknown policy schema',
      code: 'POLICY_SCHEMA',
      change: (r) => replace(r, PLAN, '"schema": 1', '"schema": 2'),
    },
    {
      name: 'unknown policy field',
      code: 'POLICY_FIELD',
      change: (r) => replace(r, PLAN, '"schema": 1,', '"schema": 1, "allowEverything": true,'),
    },
    {
      name: 'policy field type',
      code: 'POLICY_FIELD',
      change: (r) => replace(r, PLAN, '"modify": [\n    "tools/allowed.ts"\n  ]', '"modify": null'),
    },
    {
      name: 'duplicate decoded JSON field',
      code: 'JSON_DUPLICATE_FIELD',
      change: (r) => replace(r, PLAN, '"schema": 1,', '"schema": 1, "sch\\u0065ma": 1,'),
    },
    {
      name: 'missing receipt field',
      code: 'RECEIPT_FIELD',
      change: (r) => replace(r, PLAN, '  "Evidence": [],\n  "SyncImpact": null\n', '  "Evidence": []\n'),
    },
    {
      name: 'unknown review field',
      code: 'REVIEW_FIELD',
      change: (r) => replace(r, PLAN, '"Decision": "pending",', '"Decision": "pending", "Editor": "architect",'),
    },
    { name: 'bad JSON', code: 'JSON_INVALID', change: (r) => replace(r, PLAN, '"schema": 1,', '"schema": invalid,') },
    {
      name: 'duplicate execution block',
      code: 'BLOCK_DUPLICATE',
      change: (r) => write(r, PLAN, `${readFileSync(join(r, PLAN), 'utf8')}\n${block('task-execution:GOV-01', {})}`),
    },
    {
      name: 'missing execution end marker',
      code: 'BLOCK_MISSING',
      change: (r) => replace(r, PLAN, '<!-- task-execution:GOV-01:end -->', ''),
    },
    {
      name: 'malformed task marker',
      code: 'BLOCK_MALFORMED',
      change: (r) => replace(r, PLAN, '<!-- task-policy:GOV-01:start -->', '<!-- task-policy:GOV-01:start'),
    },
    {
      name: 'noncanonical policy path',
      code: 'POLICY_FIELD',
      change: (r) => replace(r, PLAN, '"tools/allowed.ts"', '"../tools/allowed.ts"'),
    },
  ]
  it.each(invalid)('rejects $name', ({ name, code, change }) => {
    const { root, base } = fixture()
    change(root, base)
    rejected(cli(root, ['--json'], name), code)
  })

  it('locates errors in text output and reports a real invalid calendar date', () => {
    const { root, base } = fixture()
    claim(root, base)
    setBlock(root, PLAN, 'task-review:GOV-01', {
      Decision: 'pending',
      ReviewedCommit: null,
      Date: '2026-02-30',
      Scope: 'tooling-only',
    })
    const result = cli(root, [], 'text error location')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REVIEW_FIELD')
    expect(result.stderr).toMatch(/\.md:\d+/)
  })
})

describe('GOV-01 staged and commit CLI', () => {
  it('audits index and final commit independently of unstaged changes and leaves the old deletion alone', () => {
    const { root, base } = fixture()
    delivery(root, base)
    replace(root, PLAN, 'Keep the existing contract.', 'Unstaged forbidden acceptance change.')
    write(root, 'tools/blocked.ts', 'export const other = 99\n')
    const index = readFileSync(join(root, '.git/index'))
    const objects = git(root, ['count-objects', '-v'])
    const result = staged(root, base.slice(0, 12), 'staged ignores unstaged differences')
    expect(result.status).toBe(0)
    expect(report(result)).toMatchObject({ mode: 'staged', task: 'GOV-01', base, target: 'index', issues: [] })
    expect(readFileSync(join(root, '.git/index'))).toEqual(index)
    expect(git(root, ['count-objects', '-v'])).toBe(objects)
    git(root, ['commit', '--quiet', '-m', 'fixture delivery'])
    const target = git(root, ['rev-parse', 'HEAD'])
    const committed = cli(
      root,
      ['--task', 'GOV-01', '--base', base, '--commit', target, '--json'],
      'commit ignores worktree',
    )
    expect(committed.status).toBe(0)
    expect(report(committed)).toMatchObject({ mode: 'commit', base, target, issues: [] })
    expect(git(root, ['diff', '--name-only'])).toContain(RETIRED)
    expect(git(root, ['diff', '--cached', '--name-only'])).toBe('')
  })

  it('allows named section content and normalized CRLF historical append, but no other README text', () => {
    const { root, base } = fixture()
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', '[Current](current.md)\nUsage details.')
    const old = readFileSync(join(root, HISTORY), 'utf8')
    write(root, HISTORY, `${old.replaceAll('\n', '\r\n')}\r\nNew event.\r\n`)
    git(root, ['add', '--', PLAN, 'docs/README.md', HISTORY])
    expect(staged(root, base, 'section and CRLF append').status).toBe(0)
  })

  it('supports multiple approved blocks in one file and explicit historical rewrite', () => {
    const { root, base } = fixture({
      sections: [
        { path: 'docs/README.md', block: 'docs-usage' },
        { path: 'docs/README.md', block: 'docs-registry' },
      ],
      history_rewrite: [HISTORY],
    })
    claim(root, base)
    replace(root, 'docs/README.md', '| reference | architect | active |', '| analysis | architect | active |')
    replace(root, 'docs/README.md', '[Current](current.md)', 'Approved new usage.')
    write(root, HISTORY, '# Authorized correction\n')
    git(root, ['add', '--', PLAN, 'docs/README.md', HISTORY])
    expect(staged(root, base, 'multiple sections and history rewrite').status).toBe(0)
  })

  it.each(['missing', 'duplicate'])('rejects an unused %s section in the immutable base policy', (fault) => {
    const { root } = fixture({ sections: [{ path: 'docs/README.md', block: 'unused-section' }] })
    const text = readFileSync(join(root, 'docs/README.md'), 'utf8')
    if (fault === 'duplicate') {
      write(
        root,
        'docs/README.md',
        `${text}\n<!-- unused-section:start -->\n<!-- unused-section:start -->\n<!-- unused-section:end -->\n`,
      )
    } else {
      write(root, 'docs/README.md', `${text}\n`)
    }
    git(root, ['add', '--', 'docs/README.md', PLAN])
    git(root, ['commit', '--quiet', '-m', `fixture ${fault} section policy`])
    const base = git(root, ['rev-parse', 'HEAD'])
    claim(root, base)
    write(root, 'tools/allowed.ts', 'export const value = 5\n')
    git(root, ['add', '--', PLAN, 'tools/allowed.ts'])
    rejected(
      staged(root, base, `unused ${fault} section`),
      fault === 'missing' ? 'BLOCK_MISSING' : 'BLOCK_DUPLICATE',
      'docs/README.md',
    )
  })

  const violations: { name: string; code: string; file: string; change: (root: string, base: string) => void }[] = [
    {
      name: 'unauthorized source',
      code: 'SCOPE_DENIED',
      file: 'tools/blocked.ts',
      change: (r) => write(r, 'tools/blocked.ts', 'export const other = 2\n'),
    },
    {
      name: 'self-edited whitelist',
      code: 'TASK_SCOPE',
      file: PLAN,
      change: (r) => replace(r, PLAN, '"tools/allowed.ts"', '"tools/allowed.ts", "tools/blocked.ts"'),
    },
    {
      name: 'other task',
      code: 'TASK_SCOPE',
      file: PLAN,
      change: (r) => replace(r, PLAN, 'Do not change this task.', 'Changed the other task.'),
    },
    {
      name: 'acceptance field',
      code: 'TASK_SCOPE',
      file: PLAN,
      change: (r) => replace(r, PLAN, 'Keep the existing contract.', 'Changed acceptance.'),
    },
    {
      name: 'architecture review',
      code: 'TASK_SCOPE',
      file: PLAN,
      change: (r) => replace(r, PLAN, '"Decision": "pending"', '"Decision": "pass"'),
    },
    {
      name: 'unauthorized completed phase',
      code: 'TASK_PHASE_PROTECTED',
      file: PLAN,
      change: (r) => replace(r, PLAN, `Governance ${ONGOING}`, `Governance ${COMPLETE}`),
    },
    {
      name: 'ClaimBase mismatch',
      code: 'RECEIPT_BASE_MISMATCH',
      file: PLAN,
      change: (r, b) => replace(r, PLAN, `"ClaimBase": "${b}"`, `"ClaimBase": "${'f'.repeat(40)}"`),
    },
    {
      name: 'README registry outside approved block',
      code: 'SECTION_SCOPE',
      file: 'docs/README.md',
      change: (r) =>
        replace(r, 'docs/README.md', '| reference | architect | active |', '| analysis | architect | active |'),
    },
    {
      name: 'accepted capability statement',
      code: 'SECTION_SCOPE',
      file: 'docs/README.md',
      change: (r) => replace(r, 'docs/README.md', 'Accepted capabilities remain unchanged.', 'All checks enabled.'),
    },
    {
      name: 'section outside text',
      code: 'SECTION_SCOPE',
      file: 'docs/README.md',
      change: (r) =>
        write(r, 'docs/README.md', `${readFileSync(join(r, 'docs/README.md'), 'utf8')}Outside addition.\n`),
    },
    {
      name: 'duplicate section marker',
      code: 'BLOCK_DUPLICATE',
      file: 'docs/README.md',
      change: (r) =>
        replace(
          r,
          'docs/README.md',
          '<!-- docs-usage:start -->',
          '<!-- docs-usage:start -->\n<!-- docs-usage:start -->',
        ),
    },
    {
      name: 'missing section marker',
      code: 'BLOCK_MISSING',
      file: 'docs/README.md',
      change: (r) => replace(r, 'docs/README.md', '<!-- docs-usage:end -->', ''),
    },
    {
      name: 'rewritten history',
      code: 'HISTORY_REWRITE',
      file: HISTORY,
      change: (r) => replace(r, HISTORY, 'Original entry.', 'Changed original entry.'),
    },
    {
      name: 'trimmed history suffix',
      code: 'HISTORY_REWRITE',
      file: HISTORY,
      change: (r) => write(r, HISTORY, `${readFileSync(join(r, HISTORY), 'utf8').trimEnd()} new event\n`),
    },
    {
      name: 'unapproved runtime document',
      code: 'ADD_NOT_APPROVED',
      file: 'content/new.md',
      change: (r) => write(r, 'content/new.md', '# Runtime'),
    },
    {
      name: 'unapproved deletion',
      code: 'RETIRE_NOT_APPROVED',
      file: 'docs/current.md',
      change: (r) => unlinkSync(join(r, 'docs/current.md')),
    },
    {
      name: 'changed retired legacy blob',
      code: 'RETIRED_CHANGED',
      file: RETIRED,
      change: (r) => write(r, RETIRED, '# Changed old blob'),
    },
  ]
  it.each(violations)('rejects staged $name', ({ name, code, file, change }) => {
    const { root, base } = fixture()
    delivery(root, base)
    change(root, base)
    git(root, ['add', '--', PLAN, file])
    rejected(staged(root, base, name), code, file)
  })

  it('ignores a whitelist forged only in the worktree and rejects a real invalid commit', () => {
    const { root, base } = fixture()
    delivery(root, base)
    replace(root, PLAN, '"tools/allowed.ts"', '"tools/allowed.ts", "tools/blocked.ts"')
    write(root, 'tools/blocked.ts', 'export const other = 3\n')
    git(root, ['add', '--', 'tools/blocked.ts'])
    rejected(staged(root, base, 'worktree-only forged whitelist'), 'SCOPE_DENIED', 'tools/blocked.ts')
    git(root, ['commit', '--quiet', '-m', 'fixture invalid delivery'])
    const target = git(root, ['rev-parse', 'HEAD'])
    rejected(
      cli(root, ['--task', 'GOV-01', '--base', base, '--commit', target, '--json'], 'invalid commit'),
      'SCOPE_DENIED',
      'tools/blocked.ts',
    )
  })

  it('handles Chinese/space/bracket renames as separately authorized delete and add paths', () => {
    const renamed = 'tools/\u65b0 \u6587\u4ef6 [draft].ts'
    const { root, base } = fixture({ add: [{ path: renamed }], retire: ['tools/allowed.ts'] })
    claim(root, base)
    git(root, ['add', '--', PLAN])
    git(root, ['mv', '--', 'tools/allowed.ts', renamed])
    expect(staged(root, base, 'approved Chinese rename').status).toBe(0)
    const denied = fixture()
    delivery(denied.root, denied.base)
    git(denied.root, ['mv', '--', 'tools/allowed.ts', renamed])
    const result = staged(denied.root, denied.base, 'unapproved rename')
    rejected(result, 'ADD_NOT_APPROVED', renamed)
    rejected(result, 'RETIRE_NOT_APPROVED', 'tools/allowed.ts')
  })
})

describe('GOV-01 approved additions and CLI failures', () => {
  const added = 'docs/\u65b0 \u8bf4\u660e.md'
  function addition(): { root: string; base: string } {
    return fixture({
      add: [{ path: added, kind: 'analysis', role: 'scoped-executor', lifecycle: 'active' }],
      sections: [
        { path: 'docs/README.md', block: 'docs-registry' },
        { path: 'docs/README.md', block: 'docs-usage' },
      ],
    })
  }
  function addDocument(root: string, base: string, registry = true, navigation = true): void {
    claim(root, base)
    write(root, added, '# Approved document\n')
    if (registry)
      replace(
        root,
        'docs/README.md',
        '<!-- docs-registry:end -->',
        `| \`${added}\` | analysis | scoped-executor | active |\n<!-- docs-registry:end -->`,
      )
    if (navigation)
      replace(root, 'docs/README.md', '[Current](current.md)', `[Current](current.md) [New](<${added.slice(5)}>)`)
    git(root, ['add', '--', PLAN, 'docs/README.md', added])
  }

  it('requires approved metadata, matching target registry and real local navigation together', () => {
    const { root, base } = addition()
    addDocument(root, base)
    expect(staged(root, base, 'approved document closed loop').status).toBe(0)
  })

  it.each([
    { name: 'missing registry', registry: false, navigation: true, code: 'ADD_REGISTRY_MISMATCH' },
    { name: 'missing navigation', registry: true, navigation: false, code: 'ADD_NAVIGATION_MISSING' },
  ])('rejects approved addition with $name', ({ name, registry, navigation, code }) => {
    const { root, base } = addition()
    addDocument(root, base, registry, navigation)
    rejected(staged(root, base, name), code, added)
  })

  it('rejects mismatched registration metadata and add not implicitly granting registry permission', () => {
    const { root, base } = addition()
    addDocument(root, base)
    replace(root, 'docs/README.md', '| analysis | scoped-executor | active |', '| reference | architect | active |')
    git(root, ['add', '--', 'docs/README.md'])
    rejected(staged(root, base, 'metadata mismatch'), 'ADD_REGISTRY_MISMATCH', added)
    const limited = fixture({ add: [{ path: added, kind: 'analysis', role: 'scoped-executor', lifecycle: 'active' }] })
    addDocument(limited.root, limited.base)
    rejected(staged(limited.root, limited.base, 'add does not grant registry edit'), 'SECTION_SCOPE', 'docs/README.md')
  })

  it('accepts explicitly approved code/runtime additions without inventing registry entries', () => {
    const { root, base } = fixture({ add: [{ path: 'tools/added.ts' }, { path: 'content/new.md' }] })
    claim(root, base)
    write(root, 'tools/added.ts', 'export const added = true\n')
    write(root, 'content/new.md', '# Runtime\n[Root](/README.md)\n')
    git(root, ['add', '--', PLAN, 'tools/added.ts', 'content/new.md'])
    expect(staged(root, base, 'approved code and runtime additions').status).toBe(0)
  })

  it('rejects managed additions without approved full metadata in the base', () => {
    const { root, base } = fixture({ add: [{ path: added }] })
    claim(root, base)
    write(root, added, '# Unapproved metadata\n')
    git(root, ['add', '--', PLAN, added])
    rejected(staged(root, base, 'base add metadata incomplete'), 'POLICY_FIELD', PLAN)
  })

  it('closes approved retirement in the registry and removes its navigation', () => {
    const { root, base } = fixture({
      retire: ['docs/current.md'],
      sections: [
        { path: 'docs/README.md', block: 'docs-registry' },
        { path: 'docs/README.md', block: 'docs-usage' },
      ],
    })
    claim(root, base)
    replace(
      root,
      'docs/README.md',
      '| `docs/current.md` | reference | architect | active |',
      '| `docs/current.md` | reference | architect | retired |',
    )
    replace(root, 'docs/README.md', '[Current](current.md)', 'Retired navigation removed.')
    unlinkSync(join(root, 'docs/current.md'))
    git(root, ['add', '--', PLAN, 'docs/README.md', 'docs/current.md'])
    expect(staged(root, base, 'approved retirement closure').status).toBe(0)
  })

  it.each([
    { kind: 'empty staging', code: 'STAGED_EMPTY' },
    { kind: 'bad base', code: 'BASE_INVALID' },
    { kind: 'blob base', code: 'BASE_INVALID' },
    { kind: 'blob target', code: 'COMMIT_INVALID' },
    { kind: 'base equals target', code: 'COMMIT_NOT_DESCENDANT' },
    { kind: 'nonancestor commit', code: 'COMMIT_NOT_DESCENDANT' },
    { kind: 'nonancestor staged', code: 'BASE_NOT_ANCESTOR' },
  ])('rejects $kind', ({ kind, code }) => {
    const { root, base } = fixture()
    if (kind === 'empty staging') {
      rejected(staged(root, base, kind), code)
      return
    }
    delivery(root, base)
    if (kind === 'bad base' || kind === 'blob base') {
      const value = kind === 'bad base' ? 'missing-base' : git(root, ['rev-parse', `${base}:tools/allowed.ts`])
      rejected(staged(root, value, kind), code)
    } else if (kind === 'blob target' || kind === 'base equals target') {
      const value = kind === 'blob target' ? git(root, ['rev-parse', `${base}:tools/allowed.ts`]) : base
      rejected(cli(root, ['--task', 'GOV-01', '--base', base, '--commit', value, '--json'], kind), code)
    } else {
      const tree = git(root, ['rev-parse', `${base}^{tree}`])
      const unrelated = git(root, ['commit-tree', tree, '-m', 'unrelated fixture root'])
      const result =
        kind === 'nonancestor staged'
          ? staged(root, unrelated, kind)
          : cli(root, ['--task', 'GOV-01', '--base', base, '--commit', unrelated, '--json'], kind)
      rejected(result, code)
    }
  })

  it.each([
    { args: ['--staged', '--commit', 'HEAD'], code: 'CLI_MODE_CONFLICT' },
    { args: ['--unknown'], code: 'CLI_UNKNOWN_ARGUMENT' },
    { args: ['--task'], code: 'CLI_MISSING_VALUE' },
    { args: ['--commit'], code: 'CLI_MISSING_VALUE' },
    { args: ['--task', 'GOV-01'], code: 'CLI_MODE_REQUIRED' },
    { args: ['--staged'], code: 'CLI_REQUIRED_ARGUMENT' },
    { args: ['--json'], code: 'CLI_DUPLICATE_ARGUMENT' },
    { args: ['--base', 'HEAD', '--base', 'HEAD', '--staged', '--task', 'GOV-01'], code: 'CLI_DUPLICATE_ARGUMENT' },
  ])('rejects arguments $args with clean JSON', ({ args, code }) => {
    const { root } = fixture()
    rejected(cli(root, [...args, '--json'], `argument error ${code}`), code)
  })

  it('reports non-Git directories and unknown tasks without stdout contamination', () => {
    const root = workspace()
    rejected(cli(root, ['--json'], 'not a Git repository'), 'GIT_ERROR')
    const valid = fixture()
    delivery(valid.root, valid.base)
    rejected(
      cli(valid.root, ['--task', 'MISSING-01', '--base', valid.base, '--staged', '--json'], 'unknown task'),
      'TASK_POLICY_MISSING',
      PLAN,
    )
  })

  it.each(['image', 'comment', 'multiline comment'])('does not accept %s as document navigation', (kind) => {
    const { root, base } = addition()
    addDocument(root, base, true, false)
    const link = `[New](<${added.slice(5)}>)`
    const fake = kind === 'image' ? `!${link}` : kind === 'comment' ? `<!-- ${link} -->` : `<!--\n${link}\n-->`
    replace(root, 'docs/README.md', '[Current](current.md)', `[Current](current.md)\n${fake}`)
    git(root, ['add', '--', 'docs/README.md'])
    rejected(staged(root, base, `fake navigation ${kind}`), 'ADD_NAVIGATION_MISSING', added)
  })
})

describe('GOV-01 boundary regressions', () => {
  const history = '# History\n<!-- history-note:start -->\nOriginal entry.\n<!-- history-note:end -->\n'

  it.each([false, true])('section grant cannot rewrite archive history (append=%s)', (append) => {
    const { root, base } = fixture(
      { sections: [{ path: HISTORY, block: 'history-note' }], append: append ? [HISTORY] : [] },
      false,
      history,
    )
    claim(root, base)
    replace(root, HISTORY, 'Original entry.', 'Rewritten history.')
    git(root, ['add', '--', PLAN, HISTORY])
    rejected(staged(root, base, `historical section rewrite append=${append}`), 'HISTORY_REWRITE', HISTORY)
  })

  it('protects archive history even when its role is architect and modify is granted', () => {
    const { root } = fixture({ modify: [HISTORY], append: [] })
    replace(root, 'docs/README.md', '| history | append-only | archive |', '| history | architect | archive |')
    git(root, ['add', '--', 'docs/README.md'])
    git(root, ['commit', '--quiet', '-m', 'fixture revised assignment'])
    const base = git(root, ['rev-parse', 'HEAD'])
    claim(root, base)
    replace(root, HISTORY, 'Original entry.', 'Rewritten history.')
    git(root, ['add', '--', PLAN, HISTORY])
    rejected(staged(root, base, 'architect archive modify'), 'HISTORY_REWRITE', HISTORY)
  })

  it('explicit history_rewrite exempts the prefix but does not expand an approved section', () => {
    const { root, base } = fixture(
      { sections: [{ path: HISTORY, block: 'history-note' }], history_rewrite: [HISTORY] },
      false,
      history,
    )
    claim(root, base)
    replace(root, HISTORY, 'Original entry.', 'Approved correction.')
    git(root, ['add', '--', PLAN, HISTORY])
    expect(staged(root, base, 'approved historical section correction').status).toBe(0)
    write(root, HISTORY, `${readFileSync(join(root, HISTORY), 'utf8')}Unapproved outside text.\n`)
    git(root, ['add', '--', HISTORY])
    rejected(staged(root, base, 'historical correction outside section'), 'SECTION_SCOPE', HISTORY)
  })

  it.each(['build', 'out', 'node_modules'])(
    'registers actual docs/%s Markdown instead of treating it as generated',
    (directory) => {
      const { root } = fixture()
      write(root, `docs/${directory}/unregistered.md`, '# Project document\n')
      rejected(
        cli(root, ['--json'], `nested managed ${directory}`),
        'REGISTRY_UNREGISTERED',
        `docs/${directory}/unregistered.md`,
      )
    },
  )

  it('preserves optional subdirectory naming/link scope while governance stays repository-wide', () => {
    const { root } = fixture()
    write(root, 'README.md', '[Outside scoped check](missing.md)\n')
    expect(cli(root, ['docs', '--json'], 'original subdirectory scope', false).status).toBe(0)
    rejected(cli(root, ['--json'], 'default repository link scope'), 'LOCAL_TARGET_MISSING', 'README.md')
    write(root, 'docs/unregistered.md', '# Unregistered\n')
    rejected(
      cli(root, ['tools', '--json'], 'directory cannot evade registry', false),
      'REGISTRY_UNREGISTERED',
      'docs/unregistered.md',
    )
  })

  it('does not treat intent-to-add as a file in the deliverable index tree', () => {
    const { root, base } = fixture()
    claim(root, base)
    write(root, 'tools/phantom.md', '# Not staged\n')
    git(root, ['add', '-N', '--', 'tools/phantom.md'])
    replace(root, 'docs/README.md', '[Current](current.md)', '[Current](current.md) [Phantom](../tools/phantom.md)')
    git(root, ['add', '--', PLAN, 'docs/README.md'])
    rejected(staged(root, base, 'intent-to-add target exclusion'), 'LOCAL_TARGET_MISSING', 'docs/README.md')
  })

  it('cannot hide a gitlink update using diff.ignoreSubmodules', () => {
    const { root } = fixture()
    const initial = git(root, ['rev-parse', 'HEAD'])
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${initial},vendor/link`])
    git(root, ['commit', '--quiet', '-m', 'fixture gitlink assignment'])
    const base = git(root, ['rev-parse', 'HEAD'])
    delivery(root, base)
    const tree = git(root, ['rev-parse', `${base}^{tree}`])
    const changed = git(root, ['commit-tree', tree, '-p', base, '-m', 'fixture gitlink target'])
    git(root, ['update-index', '--cacheinfo', `160000,${changed},vendor/link`])
    git(root, ['config', 'diff.ignoreSubmodules', 'all'])
    rejected(staged(root, base, 'hidden gitlink update'), 'FILE_TYPE_UNSUPPORTED', 'vendor/link')
  })

  it('protects section file modes and rejects symlink target types without creating OS symlinks', () => {
    const { root, base } = fixture()
    delivery(root, base)
    git(root, ['update-index', '--chmod=+x', '--', 'docs/README.md'])
    rejected(staged(root, base, 'protected section chmod'), 'FILE_MODE_PROTECTED', 'docs/README.md')
    const blob = git(root, ['rev-parse', `${base}:tools/blocked.ts`])
    git(root, ['update-index', '--cacheinfo', `120000,${blob},tools/allowed.ts`])
    rejected(staged(root, base, 'symlink file type'), 'FILE_TYPE_UNSUPPORTED', 'tools/allowed.ts')
  })

  it('rejects unmerged index stages', () => {
    const { root, base } = fixture()
    delivery(root, base)
    const blob = git(root, ['rev-parse', `${base}:tools/allowed.ts`])
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      input: `0 ${'0'.repeat(40)}\ttools/allowed.ts\n100644 ${blob} 1\ttools/allowed.ts\n100644 ${blob} 2\ttools/allowed.ts\n100644 ${blob} 3\ttools/allowed.ts\n`,
    })
    rejected(staged(root, base, 'unmerged index'), 'INDEX_UNMERGED', 'tools/allowed.ts')
  })

  it('refuses lazy fetching a missing promisor blob and leaves the object store unchanged', () => {
    const { root, base } = fixture()
    delivery(root, base)
    const remote = workspace()
    git(root, ['clone', '--quiet', '--bare', '--no-hardlinks', root, remote])
    git(root, ['config', 'core.repositoryformatversion', '1'])
    git(root, ['config', 'extensions.partialClone', 'fixture-origin'])
    git(root, ['config', 'remote.fixture-origin.promisor', 'true'])
    git(root, ['config', 'remote.fixture-origin.url', remote])
    const blob = git(root, ['rev-parse', `${base}:${PLAN}`])
    expect(blob).toMatch(/^[a-f\d]{40}$/)
    const object = resolve(root, '.git/objects', blob.slice(0, 2), blob.slice(2))
    if (dirname(dirname(object)) !== resolve(root, '.git/objects')) throw new Error('Unexpected fixture object path')
    unlinkSync(object)
    const objects = git(root, ['count-objects', '-v'])
    rejected(staged(root, base, 'missing promisor object; no lazy fetch'), 'GIT_BLOB_READ', PLAN)
    expect(git(root, ['count-objects', '-v'])).toBe(objects)
  })

  it('commit audit does not require current HEAD or use a different worktree version', () => {
    const { root, base } = fixture()
    delivery(root, base)
    git(root, ['commit', '--quiet', '-m', 'fixture isolated commit'])
    const target = git(root, ['rev-parse', 'HEAD'])
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/unborn'])
    expect(
      cli(root, ['--task', 'GOV-01', '--base', base, '--commit', target, '--json'], 'explicit commit with unborn HEAD')
        .status,
    ).toBe(0)
  })

  it('rejects repository-escaping local links in an incremental target', () => {
    const { root, base } = fixture()
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', '[Current](current.md) [Outside](../../outside.md)')
    git(root, ['add', '--', PLAN, 'docs/README.md'])
    rejected(staged(root, base, 'repository-escaping link'), 'LOCAL_TARGET_OUTSIDE', 'docs/README.md')
  })

  it.each(['staged', 'commit'])('locates %s scope errors in text output', (mode) => {
    const { root, base } = fixture()
    delivery(root, base)
    write(root, 'tools/blocked.ts', 'export const blocked = true\n')
    git(root, ['add', '--', 'tools/blocked.ts'])
    let target: string | undefined
    if (mode === 'commit') {
      git(root, ['commit', '--quiet', '-m', 'fixture text rejection'])
      target = git(root, ['rev-parse', 'HEAD'])
    }
    const args = ['--task', 'GOV-01', '--base', base, ...(target ? ['--commit', target] : ['--staged'])]
    const result = cli(root, args, `${mode} text scope location`)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('tools/blocked.ts:1: [SCOPE_DENIED]')
    expect(result.stderr).toContain(base)
  })
})

type ModeExpectation = { static: string | null; staged: string | null; commit: string | null }

function checkModes(
  root: string,
  base: string,
  files: string[],
  label: string,
  expected: ModeExpectation = { static: null, staged: null, commit: null },
): void {
  function check(result: ReturnType<typeof cli>, mode: keyof ModeExpectation): void {
    const code = expected[mode]
    if (code) rejected(result, code)
    else {
      expect(result.status).toBe(0)
      expect(report(result)).toMatchObject({ mode, issues: [] })
    }
  }
  const staticResult = cli(root, ['--json'], `${label}: static`)
  git(root, ['add', '--', PLAN, ...files])
  const stagedResult = staged(root, base, `${label}: staged`)
  git(root, ['commit', '--quiet', '-m', `fixture ${label}`])
  const target = git(root, ['rev-parse', 'HEAD'])
  const commitResult = cli(root, ['--task', 'GOV-01', '--base', base, '--commit', target, '--json'], `${label}: commit`)
  check(staticResult, 'static')
  check(stagedResult, 'staged')
  check(commitResult, 'commit')
}

function allReject(code: string): ModeExpectation {
  return { static: code, staged: code, commit: code }
}

describe('GOV-02 lifecycle regressions', () => {
  it.each(['ongoing', 'complete', 'returned', 'blocked', 'unstarted claimed', 'unstarted reviewed', 'pending stamped'])(
    'does not grant a new base from a %s card, without banning its static structure',
    (kind) => {
      const { root, base: original } = fixture()
      delivery(root, original)
      git(root, ['commit', '--quiet', '-m', 'fixture first delivery'])
      const delivered = git(root, ['rev-parse', 'HEAD'])
      const phase =
        kind === 'complete'
          ? COMPLETE
          : kind === 'blocked'
            ? '\u2298'
            : kind.startsWith('unstarted') || kind === 'pending stamped'
              ? EMPTY
              : ONGOING
      replace(root, PLAN, `Governance ${ONGOING}`, `Governance ${phase}`)
      if (kind === 'unstarted reviewed' || kind === 'pending stamped')
        setBlock(root, PLAN, 'task-execution:GOV-01', { ClaimBase: null, Result: null, Evidence: [], SyncImpact: null })
      if (['complete', 'returned', 'blocked', 'unstarted reviewed', 'pending stamped'].includes(kind))
        setBlock(root, PLAN, 'task-review:GOV-01', {
          Decision:
            kind === 'returned'
              ? 'return'
              : kind === 'blocked'
                ? 'blocked'
                : kind === 'pending stamped'
                  ? 'pending'
                  : 'pass',
          ReviewedCommit: delivered,
          Date: '2026-10-30',
          Scope: 'tooling-only',
        })
      git(root, ['add', '--', PLAN])
      git(root, ['commit', '--quiet', '--allow-empty', '-m', `fixture ${kind} baseline`])
      const wrongBase = git(root, ['rev-parse', 'HEAD'])
      if (phase === EMPTY) replace(root, PLAN, `Governance ${EMPTY}`, `Governance ${ONGOING}`)
      setBlock(root, PLAN, 'task-execution:GOV-01', {
        ClaimBase: wrongBase,
        Result: 'Wrongly reclaimed from a later commit, retaining the existing review.',
        Evidence: ['build/fixture.log'],
        SyncImpact: 'Fixture only.',
      })
      write(root, 'tools/allowed.ts', 'export const value = 3\n')
      checkModes(root, wrongBase, ['tools/allowed.ts'], `reclaimed ${kind}`, {
        static: null,
        staged: 'BASE_TASK_NOT_UNCLAIMED',
        commit: 'BASE_TASK_NOT_UNCLAIMED',
      })
    },
  )

  it.each(['ReviewedCommit', 'Date'])('rejects a pending baseline stamped only with %s', (field) => {
    const { root, base: original } = fixture()
    setBlock(root, PLAN, 'task-review:GOV-01', {
      Decision: 'pending',
      ReviewedCommit: field === 'ReviewedCommit' ? original : null,
      Date: field === 'Date' ? '2026-10-31' : null,
      Scope: 'tooling-only',
    })
    git(root, ['add', '--', PLAN])
    git(root, ['commit', '--quiet', '-m', `fixture pending ${field}`])
    const wrongBase = git(root, ['rev-parse', 'HEAD'])
    claim(root, wrongBase)
    checkModes(root, wrongBase, ['tools/allowed.ts'], `pending only ${field}`, {
      static: null,
      staged: 'BASE_TASK_NOT_UNCLAIMED',
      commit: 'BASE_TASK_NOT_UNCLAIMED',
    })
  })

  it('keeps the first ClaimBase across consecutive legal deliveries and isolates the old user deletion', () => {
    const { root, base } = fixture()
    delivery(root, base)
    git(root, ['commit', '--quiet', '-m', 'fixture first legal delivery'])
    write(root, 'tools/allowed.ts', 'export const value = 3\n')
    checkModes(root, base, ['tools/allowed.ts'], 'same ClaimBase second delivery')
    expect(git(root, ['diff', '--name-only'])).toBe(RETIRED)
    expect(git(root, ['diff', '--cached', '--name-only'])).toBe('')
  })

  it('audits a historical pending delivery after a later review and broken worktree', () => {
    const { root, base } = fixture()
    delivery(root, base)
    git(root, ['commit', '--quiet', '-m', 'fixture historical pending delivery'])
    const target = git(root, ['rev-parse', 'HEAD'])
    setBlock(root, PLAN, 'task-review:GOV-01', {
      Decision: 'return',
      ReviewedCommit: target,
      Date: '2026-10-30',
      Scope: 'tooling-only',
    })
    git(root, ['add', '--', PLAN])
    git(root, ['commit', '--quiet', '-m', 'fixture architecture return'])
    write(root, PLAN, '# Broken current worktree\n')
    write(root, 'docs/README.md', '[Broken](missing.md)\n')
    const result = cli(
      root,
      ['--task', 'GOV-01', '--base', base, '--commit', target, '--json'],
      'historical pending target',
    )
    expect(result.status).toBe(0)
    expect(report(result)).toMatchObject({ mode: 'commit', base, target, issues: [] })
  })
})

describe('GOV-02 registry and local boundary regressions', () => {
  it.each(['usage code', 'usage link', 'usage image', 'other document', 'same registry row other cell'])(
    'rejects retired references in %s in all three CLI modes',
    (kind) => {
      const { root, base } = fixture({
        modify: ['tools/allowed.ts', 'README.md'],
        sections: [
          { path: 'docs/README.md', block: 'docs-usage' },
          { path: 'docs/README.md', block: 'docs-registry' },
        ],
      })
      claim(root, base)
      const files = ['docs/README.md']
      if (kind === 'same registry row other cell')
        replace(root, 'docs/README.md', `| ${RETIRED} | legacy |`, `| ${RETIRED} | \`${RETIRED}\` |`)
      else if (kind === 'other document') {
        write(root, 'README.md', `Read \`${RETIRED}\` before work.\n`)
        files.push('README.md')
      } else {
        const reference =
          kind === 'usage code' ? `\`${RETIRED}\`` : `${kind === 'usage image' ? '!' : ''}[Old](04-legacy.md)`
        replace(root, 'docs/README.md', '[Current](current.md)', `Read ${reference} before work.`)
      }
      checkModes(root, base, files, kind, allReject('RETIRED_TARGET'))
    },
  )

  it('accepts only true plain/backtick registry path declarations and valid active references', () => {
    const { root, base } = fixture({
      sections: [
        { path: 'docs/README.md', block: 'docs-registry' },
        { path: 'docs/README.md', block: 'docs-usage' },
      ],
    })
    claim(root, base)
    replace(root, 'docs/README.md', `| ${RETIRED} | legacy |`, `| \`${RETIRED}\` | legacy |`)
    replace(root, 'docs/README.md', '[Current](current.md)', '[Current](current.md) See `docs/current.md`.')
    checkModes(root, base, ['docs/README.md'], 'exact declarations and active references')
  })

  it.each(['docs/new #1.md', 'docs/new %draft.md'])(
    'accepts the native registry declaration and encoded navigation for %s',
    (added) => {
      const { root, base } = fixture({
        add: [{ path: added, kind: 'analysis', role: 'scoped-executor', lifecycle: 'active' }],
        sections: [
          { path: 'docs/README.md', block: 'docs-registry' },
          { path: 'docs/README.md', block: 'docs-usage' },
        ],
      })
      claim(root, base)
      write(root, added, '# Approved native filename\n')
      replace(
        root,
        'docs/README.md',
        '<!-- docs-registry:end -->',
        `| \`${added}\` | analysis | scoped-executor | active |\n<!-- docs-registry:end -->`,
      )
      replace(root, 'docs/README.md', '[Current](current.md)', `[New](${encodeURIComponent(basename(added))})`)
      checkModes(root, base, ['docs/README.md', added], `native registry ${added}`)
    },
  )

  it.each([
    '../../outside.md',
    '/%2e%2e/outside.md',
    '%2e%2e/%2e%2e/outside.md',
    '..\\..\\outside.md',
    '../../outside%20file.md',
  ])('rejects the existing repository-external target %s consistently', (target) => {
    const { root, base } = fixture({}, true)
    write(dirname(root), 'outside.md', '# Outside the Git repository, inside the isolated container\n')
    write(dirname(root), 'outside file.md', '# Outside\n')
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', `[Outside](${target})`)
    checkModes(root, base, ['docs/README.md'], `outside ${target}`, allReject('LOCAL_TARGET_OUTSIDE'))
  })

  it.each(['current.md.', '<current.md >', 'current.md%20', 'current.md%2e', '%5c%5cserver%5cshare'])(
    'rejects path aliases %s',
    (target) => {
      const { root, base } = fixture()
      claim(root, base)
      replace(root, 'docs/README.md', '[Current](current.md)', `[Alias](${target})`)
      checkModes(root, base, ['docs/README.md'], `path alias ${target}`, allReject('LOCAL_PATH_UNSUPPORTED'))
    },
  )

  it('diagnoses entity destinations rather than accepting an existing truncated literal path', () => {
    const { root } = fixture()
    write(root, 'docs/current&', 'This literal path is not the entity-decoded Markdown destination.\n')
    git(root, ['add', '--', 'docs/current&'])
    git(root, ['commit', '--quiet', '-m', 'fixture literal entity prefix'])
    const base = git(root, ['rev-parse', 'HEAD'])
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', '[Encoded](current&#46;md)')
    checkModes(root, base, ['docs/README.md'], 'unsupported HTML entity path', allReject('LOCAL_PATH_UNSUPPORTED'))
  })

  it('keeps explicit lintDocs source paths inside the repository before reading', () => {
    const { root } = fixture({}, true)
    write(dirname(root), 'outside.md', '# Private source\n[Private](private-content-missing.md)\n')
    const result = lintDocs(root, ['../outside.md'])
    expect(result).toEqual([{ file: '../outside.md', line: 1, message: 'Unsupported source path: ../outside.md' }])
    expect(JSON.stringify(result)).not.toContain('private-content-missing.md')
  })
})

describe('GOV-02 visible Markdown and local reference syntax', () => {
  it.each([
    { name: 'inline code open comment', text: '`<!--` [Current](current.md)', code: null },
    { name: 'paragraph continuation', text: 'Introduction\n    [Old](04-legacy.md)', code: 'RETIRED_TARGET' },
    { name: 'tab paragraph continuation', text: 'Introduction\n\t[Old](04-legacy.md)', code: 'RETIRED_TARGET' },
    { name: 'simple list continuation', text: '- Item\n\n    [Old](04-legacy.md)', code: 'RETIRED_TARGET' },
    { name: 'inline triple backticks', text: '```code``` [Old](04-legacy.md)', code: 'RETIRED_TARGET' },
    { name: 'escaped comment opener', text: '\\<!-- [Old](04-legacy.md)', code: 'RETIRED_TARGET' },
    { name: 'even-slash code opener', text: '\\\\`<!--` [Old](04-legacy.md)', code: 'RETIRED_TARGET' },
  ])('keeps real Markdown visible after $name', ({ name, text, code }) => {
    const { root, base } = fixture()
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', text)
    checkModes(root, base, ['docs/README.md'], `visibility ${name}`, code ? allReject(code) : undefined)
  })

  it.each(['backtick fence', 'tilde fence', 'indented code', 'comment', 'fence containing an open comment'])(
    'preserves real task metadata around a valid %s with fake headings',
    (kind) => {
      const { root } = fixture()
      const fake = `### EXAMPLE-01 Example ${EMPTY}\n# Fake top-level heading`
      const example =
        kind === 'indented code'
          ? fake
              .split('\n')
              .map((line) => `    ${line}`)
              .join('\n')
          : kind === 'comment'
            ? `<!--\n${fake}\n-->`
            : kind === 'backtick fence'
              ? `\`\`\`\`md\n${fake}\n\`\`\`\``
              : `~~~md\n${kind === 'fence containing an open comment' ? '<!--\n' : ''}${fake}\n~~~`
      replace(
        root,
        PLAN,
        '**Acceptance**: Keep the existing contract.',
        `**Acceptance**: Keep the existing contract.\n\n${example}`,
      )
      git(root, ['add', '--', PLAN])
      git(root, ['commit', '--quiet', '-m', `fixture assigned ${kind}`])
      const base = git(root, ['rev-parse', 'HEAD'])
      claim(root, base)
      checkModes(root, base, ['tools/allowed.ts'], `visible metadata ${kind}`)
    },
  )

  it.each(['fenced', 'indented', 'tab indented', 'HTML comment'])(
    'does not check hidden %s example targets but keeps the following visible line',
    (kind) => {
      const { root, base } = fixture()
      claim(root, base)
      const hidden = '[Example](missing.md) `docs/04-legacy.md`'
      const example =
        kind === 'fenced'
          ? `~~~md\n${hidden}\n~~~`
          : kind === 'HTML comment'
            ? `<!--\n${hidden}\n-->`
            : `${kind === 'indented' ? '    ' : '\t'}${hidden}`
      replace(root, 'docs/README.md', '[Current](current.md)', `${example}\n\n[Current](current.md)`)
      checkModes(root, base, ['docs/README.md'], `hidden ${kind}`)
    },
  )

  it.each(['full', 'collapsed', 'shortcut', 'image', 'unused definition'])(
    'rejects a retired %s reference target in three modes',
    (kind) => {
      const { root, base } = fixture()
      claim(root, base)
      const use =
        kind === 'full'
          ? '[Old][OLD]'
          : kind === 'collapsed'
            ? '[old][]'
            : kind === 'shortcut'
              ? '[old]'
              : kind === 'image'
                ? '![old]'
                : ''
      replace(root, 'docs/README.md', '[Current](current.md)', `${use}\n\n[old]: 04-legacy.md "Old document"`)
      checkModes(root, base, ['docs/README.md'], `retired reference ${kind}`, allReject('RETIRED_TARGET'))
    },
  )

  it.each([
    { name: 'undefined full reference', text: '[Old][missing]', code: 'LOCAL_REFERENCE_UNDEFINED' },
    { name: 'undefined collapsed reference', text: '[missing][]', code: 'LOCAL_REFERENCE_UNDEFINED' },
    {
      name: 'duplicate definition',
      text: '[Old][old]\n\n[old]: current.md\n[OLD]: 04-legacy.md',
      code: 'LOCAL_REFERENCE_DUPLICATE',
    },
    { name: 'multiline inline destination', text: '[Old](\n04-legacy.md)', code: 'LOCAL_LINK_UNSUPPORTED' },
    { name: 'multiline inline label', text: '[Old\nlabel](04-legacy.md)', code: 'LOCAL_LINK_UNSUPPORTED' },
    {
      name: 'multiline reference label',
      text: '[Old\nlabel][old]\n\n[old]: current.md',
      code: 'LOCAL_LINK_UNSUPPORTED',
    },
    { name: 'multiline definition label', text: '[old\nlabel]: 04-legacy.md', code: 'LOCAL_LINK_UNSUPPORTED' },
    {
      name: 'multiline reference destination',
      text: '[Old][old]\n\n[old]:\n  04-legacy.md',
      code: 'LOCAL_LINK_UNSUPPORTED',
    },
    { name: 'HTML local href', text: '<a href="04-legacy.md">Old</a>', code: 'LOCAL_LINK_UNSUPPORTED' },
    { name: 'HTML local image', text: '<img src="04-legacy.md">', code: 'LOCAL_LINK_UNSUPPORTED' },
    {
      name: 'mixed HTML targets',
      text: '<img src="https://example.test/panel.png" href="04-legacy.md">',
      code: 'LOCAL_LINK_UNSUPPORTED',
    },
    { name: 'unclosed inline angle destination', text: '[Old](<04-legacy.md)', code: 'LOCAL_LINK_UNSUPPORTED' },
    { name: 'list-contained fence', text: '- ```md\n  [Example](current.md)\n  ```', code: 'LOCAL_LINK_UNSUPPORTED' },
    { name: 'quoted fence', text: '> ~~~md\n> [Example](current.md)\n> ~~~', code: 'LOCAL_LINK_UNSUPPORTED' },
    { name: 'excess list padding', text: '-     [Example](current.md)', code: 'LOCAL_LINK_UNSUPPORTED' },
    { name: 'quoted tab code', text: '>  \t[Example](current.md)', code: 'LOCAL_LINK_UNSUPPORTED' },
    {
      name: 'quoted list fence',
      text: '> - ```md\n>   [Example](current.md)\n>   ```',
      code: 'LOCAL_LINK_UNSUPPORTED',
    },
    {
      name: 'nested quote fence',
      text: '> > ```md\n> > [Example](current.md)\n> > ```',
      code: 'LOCAL_LINK_UNSUPPORTED',
    },
  ])('diagnoses unsupported or ambiguous $name instead of silently passing', ({ name, text, code }) => {
    const { root, base } = fixture()
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', text)
    checkModes(root, base, ['docs/README.md'], name, allReject(code))
  })

  it('preserves UTF-8, spaces, URL encoding, titles, normalized reference labels and external links', () => {
    const { root } = fixture({ modify: ['tools/allowed.ts', 'docs/current.md'] })
    const name = '\u6587\u6863 A (draft) #1.md'
    write(root, `assets/${name}`, '# In-repository non-managed reference target\n')
    git(root, ['add', '--', `assets/${name}`])
    git(root, ['commit', '--quiet', '-m', 'fixture local UTF-8 target'])
    const base = git(root, ['rev-parse', 'HEAD'])
    claim(root, base)
    replace(
      root,
      'docs/README.md',
      '[Current](current.md)',
      [
        '[Local][Mixed Case] [mixed case][] [mixed case] ![Panel][mixed case]',
        '[Root](/docs/current.md) [Encoded root](%2Fdocs%2Fcurrent.md)',
        '[Web][web] [Host](//example.test/guide.md) [Here](#section) [Query](?view=all)',
        '',
        `[ mixed   CASE ]: <../assets/${name.replace('#', '%23')}> "Local title"`,
        '[web]: https://example.test/missing.md',
      ].join('\n'),
    )
    checkModes(root, base, ['docs/README.md'], 'reference syntax compatibility')
  })

  it('keeps original text locations after CRLF fenced/indented/comment examples and inline comments', () => {
    const { root, base } = fixture()
    claim(root, base)
    write(
      root,
      'docs/README.md',
      readFileSync(join(root, 'docs/README.md'), 'utf8').replace(
        '[Current](current.md)',
        '~~~md\r\n[Hidden](missing.md)\r\n~~~\r\n\r\n    [Hidden](missing.md)\r\n\r\n<!-- [Hidden](missing.md) -->\r\n[Visible](04-legacy.md)',
      ),
    )
    const text = readFileSync(join(root, 'docs/README.md'), 'utf8')
    const line = text.slice(0, text.indexOf('[Visible]')).split('\n').length
    for (const mode of ['static', 'staged', 'commit']) {
      let args = ['--json']
      if (mode !== 'static') {
        git(root, ['add', '--', PLAN, 'docs/README.md'])
        if (mode === 'commit') git(root, ['commit', '--quiet', '-m', 'fixture original line locations'])
        args = [
          '--task',
          'GOV-01',
          '--base',
          base,
          ...(mode === 'staged' ? ['--staged'] : ['--commit', git(root, ['rev-parse', 'HEAD'])]),
        ]
      } else args = []
      const result = cli(root, args, `${mode} visible original line`)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`docs/README.md:${line}: [RETIRED_TARGET]`)
      expect(result.stderr).not.toContain('missing.md')
    }
  })
})

describe('GOV-02 real versus example navigation', () => {
  const added = 'docs/new-guide.md'
  it.each([
    'indented',
    'tab indented',
    'fenced',
    'comment',
    'definition only',
    'image reference',
    'visible full reference',
    'inline code open comment',
    'paragraph continuation',
    'simple list continuation',
    'paragraph definition',
    'nested inline label',
  ])('distinguishes %s navigation using actual static, staged and commit CLI', (kind) => {
    const { root, base } = fixture({
      add: [{ path: added, kind: 'analysis', role: 'scoped-executor', lifecycle: 'active' }],
      sections: [
        { path: 'docs/README.md', block: 'docs-registry' },
        { path: 'docs/README.md', block: 'docs-usage' },
      ],
    })
    claim(root, base)
    write(root, added, '# Approved document\n')
    replace(
      root,
      'docs/README.md',
      '<!-- docs-registry:end -->',
      `| \`${added}\` | analysis | scoped-executor | active |\n<!-- docs-registry:end -->`,
    )
    const link = '[New](new-guide.md)'
    const navigation =
      kind === 'inline code open comment'
        ? `\`<!--\` ${link}`
        : kind === 'paragraph continuation'
          ? `Introduction\n    ${link}`
          : kind === 'simple list continuation'
            ? `- Item\n\n    ${link}`
            : kind === 'paragraph definition'
              ? `Introduction\n[new]: new-guide.md\n\n[New][new]`
              : kind === 'nested inline label'
                ? '[Outer [Inner](https://example.test)](new-guide.md)'
                : kind === 'indented'
                  ? `    ${link}`
                  : kind === 'tab indented'
                    ? `\t${link}`
                    : kind === 'fenced'
                      ? `~~~md\n${link}\n~~~`
                      : kind === 'comment'
                        ? `<!-- ${link} -->`
                        : `${kind === 'visible full reference' ? '[New][new]\n\n' : kind === 'image reference' ? '![New][new]\n\n' : ''}[new]: new-guide.md`
    replace(root, 'docs/README.md', '[Current](current.md)', `\n${navigation}\n`)
    const unsupported = ['paragraph definition', 'nested inline label'].includes(kind)
    const code = [
      'visible full reference',
      'inline code open comment',
      'paragraph continuation',
      'simple list continuation',
    ].includes(kind)
      ? null
      : 'ADD_NAVIGATION_MISSING'
    checkModes(
      root,
      base,
      ['docs/README.md', added],
      `navigation ${kind}`,
      unsupported ? allReject('LOCAL_LINK_UNSUPPORTED') : { static: null, staged: code, commit: code },
    )
  })
})

describe('GOV-02 unchanged path aliases', () => {
  it.each(['symlink', 'gitlink'])('rejects references through an unchanged Git %s', (kind) => {
    const { root, base: original } = fixture()
    const path = 'assets/alias'
    const oid = kind === 'gitlink' ? original : git(root, ['rev-parse', 'HEAD:tools/allowed.ts'])
    git(root, ['update-index', '--add', '--cacheinfo', `${kind === 'gitlink' ? '160000' : '120000'},${oid},${path}`])
    git(root, ['commit', '--quiet', '-m', `fixture assigned ${kind}`])
    const base = git(root, ['rev-parse', 'HEAD'])
    if (kind === 'gitlink') mkdirSync(join(root, path), { recursive: true })
    else write(root, path, 'A regular Windows checkout must not turn Git symlink metadata into a valid target.\n')
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', '[Alias](../assets/alias)')
    checkModes(root, base, ['docs/README.md'], `unchanged ${kind}`, allReject('LOCAL_PATH_UNSUPPORTED'))
  })

  it('does not follow a junction target outside the repository', () => {
    const { root, base } = fixture({}, true)
    const outside = join(dirname(root), 'outside')
    write(outside, 'target.md', '# Outside the repository, inside the isolated fixture container\n')
    const alias = join(root, 'assets/alias')
    mkdirSync(dirname(alias), { recursive: true })
    symlinkSync(outside, alias, 'junction')
    claim(root, base)
    replace(root, 'docs/README.md', '[Current](current.md)', '[Alias](../assets/alias/target.md)')
    const result = cli(root, ['--json'], 'static junction local target')
    rejected(result, 'LOCAL_PATH_UNSUPPORTED', 'docs/README.md')
  })

  it('refuses to read a source document through a junction before checking its content', () => {
    const { root } = fixture({}, true)
    const outside = join(dirname(root), 'outside')
    write(outside, 'source.md', '# External\n[Do not read](outside-content-missing.md)\n')
    const alias = join(root, 'docs/alias')
    symlinkSync(outside, alias, 'junction')
    const oid = git(root, ['rev-parse', 'HEAD:tools/allowed.ts'])
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${oid},docs/alias/source.md`])
    const result = cli(root, ['--json'], 'static junction source isolation')
    rejected(result, 'LOCAL_PATH_UNSUPPORTED', 'docs/alias/source.md')
    expect(result.stdout).not.toContain('outside-content-missing.md')
  })
})

type Gov03Case = {
  id: string
  group: string
  text: string
  expected: ModeExpectation
  navigation: 'eligible' | 'example' | 'none'
  addition?: boolean
  issueLine?: number
}

// GOV-03 matrix:start
const gov03Cases: Gov03Case[] = (() => {
  const cases: Gov03Case[] = []
  const comments = [
    { id: 'body-close', prefix: 'Introduction <!--\nbody -->\n', line: 3 },
    { id: 'standalone-close', prefix: 'Introduction <!--\nbody\n-->\n', line: 4 },
    { id: 'close-line-link', prefix: 'Introduction <!--\nbody --> ', line: 2 },
    { id: 'same-line-close', prefix: 'Introduction <!-- -->\n', line: 2 },
  ]
  for (const [shapeIndex, shape] of comments.entries()) {
    for (const [indentIndex, indent] of ['    ', '\t'].entries()) {
      const eol = (shapeIndex + indentIndex) % 2 ? '\r\n' : '\n'
      for (const [target, code] of [
        ['current.md', null],
        ['04-legacy.md', 'RETIRED_TARGET'],
      ] as const) {
        cases.push({
          id: `comment-${shape.id}-${indentIndex}-${target}`,
          group: 'paragraph-comment-continuity',
          text: `${shape.prefix}${indent}[Target](${target})`.replaceAll('\n', eol),
          expected: code ? allReject(code) : { static: null, staged: null, commit: null },
          navigation: 'eligible',
          issueLine: code ? shape.line : undefined,
        })
      }
      cases.push({
        id: `comment-${shape.id}-${indentIndex}-new-navigation`,
        group: 'paragraph-comment-continuity',
        text: `${shape.prefix}${indent}[New](new-guide.md)`.replaceAll('\n', eol),
        expected: { static: null, staged: null, commit: null },
        navigation: 'eligible',
        addition: true,
      })
    }
  }
  for (const [index, indent] of ['    ', '\t'].entries()) {
    for (const [target, code] of [
      ['missing.md', 'LOCAL_TARGET_MISSING'],
      ['../../outside.md', 'LOCAL_TARGET_OUTSIDE'],
    ]) {
      cases.push({
        id: `comment-boundary-${index}-${code}`,
        group: 'paragraph-comment-targets',
        text: `Introduction <!--\nbody\n-->\n${indent}[Target](${target})`,
        expected: allReject(code as string),
        navigation: 'eligible',
        issueLine: 4,
      })
    }
    for (const [target, code] of [
      ['current.md', null],
      ['04-legacy.md', 'RETIRED_TARGET'],
    ] as const) {
      cases.push({
        id: `comment-internal-blank-${index}-${target}`,
        group: 'literal-unclosed-inline-comment',
        text: `Introduction <!--\n\n-->\n${indent}[Target](${target})`,
        expected: code ? allReject(code) : { static: null, staged: null, commit: null },
        navigation: 'eligible',
        issueLine: code ? 4 : undefined,
      })
    }
  }
  for (const [boundaryIndex, prefix] of [
    '---\n',
    '* * *\n',
    '_ _ _\n',
    '- - -\n',
    'Title\n---\n',
    'Title\n===\n',
    'Introduction <!--\nbody -->\n\n',
  ].entries()) {
    for (const [indentIndex, indent] of ['    ', '\t'].entries()) {
      for (const example of [true, false]) {
        cases.push({
          id: `block-boundary-${boundaryIndex}-${indentIndex}-${example ? 'code' : 'visible'}`,
          group: 'thematic-setext-blank-boundaries',
          text: `${prefix}${example ? indent : ''}[New](new-guide.md)`.replaceAll(
            '\n',
            (boundaryIndex + indentIndex) % 2 ? '\r\n' : '\n',
          ),
          expected: {
            static: null,
            staged: example ? 'ADD_NAVIGATION_MISSING' : null,
            commit: example ? 'ADD_NAVIGATION_MISSING' : null,
          },
          navigation: example ? 'example' : 'eligible',
          addition: true,
        })
      }
    }
  }
  for (const [index, prefix] of ['<!-- block\nbody -->\n', 'Introduction\n<!-- block -->\n'].entries()) {
    for (const example of [true, false]) {
      cases.push({
        id: `html-block-${index}-${example ? 'code' : 'visible'}`,
        group: 'html-block-versus-inline-comment',
        text: `${prefix}${example ? '\t' : ''}[New](new-guide.md)`,
        expected: {
          static: null,
          staged: example ? 'ADD_NAVIGATION_MISSING' : null,
          commit: example ? 'ADD_NAVIGATION_MISSING' : null,
        },
        navigation: example ? 'example' : 'eligible',
        addition: true,
      })
    }
  }
  for (const [index, indent] of ['    ', '\t'].entries()) {
    cases.push({
      id: `standalone-equals-paragraph-${index}`,
      group: 'setext-requires-a-paragraph',
      text: `===\n${indent}[New](new-guide.md)`,
      expected: { static: null, staged: null, commit: null },
      navigation: 'eligible',
      addition: true,
    })
  }
  for (const length of [2, 4, 7]) {
    const label = Array.from({ length }, (_, index) => `word-${index}`).join('\n')
    const normalized = label.replaceAll('\n', ' ')
    const forms = [
      { id: 'inline', text: `[${label}](04-legacy.md)` },
      { id: 'image', text: `![${label}](current.md)` },
      { id: 'definition', text: `[${label}]: 04-legacy.md\n\n[${normalized}]` },
      { id: 'full-display', text: `[${label}][old]\n\n[old]: current.md` },
      { id: 'full-reference', text: `[Old][${label}]\n\n[${normalized}]: current.md` },
      { id: 'shortcut', text: `[${label}]\n\n[${normalized}]: current.md` },
      { id: 'collapsed', text: `[${label}][]\n\n[${normalized}]: current.md` },
    ]
    for (const [formIndex, form] of forms.entries()) {
      cases.push({
        id: `multiline-${length}-${form.id}`,
        group: 'multiline-to-actual-block-boundary',
        text: form.text.replaceAll('\n', (length + formIndex) % 2 ? '\r\n' : '\n'),
        expected: allReject('LOCAL_LINK_UNSUPPORTED'),
        navigation: 'none',
        issueLine: 1,
      })
    }
    cases.push({
      id: `plain-multiline-brackets-${length}`,
      group: 'non-link-ordinary-text',
      text: `[${label}]\n\n[Unbound] ![Unbound] \\[Escaped](missing.md)`.replaceAll('\n', '\r\n'),
      expected: { static: null, staged: null, commit: null },
      navigation: 'none',
    })
  }
  for (const [containerIndex, prefix] of ['> ', '- ', '1. '].entries()) {
    for (const use of ['[Old][old]', '[old][]', '[old]', '![Old][old]']) {
      cases.push({
        id: `container-definition-${containerIndex}-${use}`,
        group: 'container-definitions-explicitly-unsupported',
        text: `${prefix}[old]: 04-legacy.md\n\n${use}`,
        expected: allReject('LOCAL_LINK_UNSUPPORTED'),
        navigation: 'none',
        issueLine: 1,
      })
    }
    cases.push({
      id: `container-active-definition-${containerIndex}`,
      group: 'container-definitions-explicitly-unsupported',
      text: `${prefix}[current]: current.md\n\n[current]`.replaceAll('\n', '\r\n'),
      expected: allReject('LOCAL_LINK_UNSUPPORTED'),
      navigation: 'none',
      issueLine: 1,
    })
    cases.push({
      id: `container-unbound-text-${containerIndex}`,
      group: 'non-link-ordinary-text',
      text: `${prefix}[Unbound] ![Unbound]`,
      expected: { static: null, staged: null, commit: null },
      navigation: 'none',
    })
  }
  for (const eol of ['\n', '\r\n']) {
    for (const separated of [true, false]) {
      cases.push({
        id: `comment-definition-${eol.length}-${separated ? 'block' : 'paragraph'}`,
        group: 'definition-eligibility-is-structural',
        text: `Introduction <!--\nbody -->\n${separated ? '\n' : ''}[new]: new-guide.md\n\n[New]`.replaceAll('\n', eol),
        expected: separated ? { static: null, staged: null, commit: null } : allReject('LOCAL_LINK_UNSUPPORTED'),
        navigation: separated ? 'eligible' : 'none',
        addition: true,
        issueLine: separated ? undefined : 3,
      })
    }
    cases.push({
      id: `inline-code-block-limit-${eol.length}`,
      group: 'one-structural-boundary-for-code-and-links',
      text: 'Paragraph `\n---\n[Visible](04-legacy.md)\n`'.replaceAll('\n', eol),
      expected: allReject('RETIRED_TARGET'),
      navigation: 'eligible',
      issueLine: 3,
    })
  }
  for (const [index, boundary] of ['\n', '# Heading\n'].entries()) {
    cases.push({
      id: `actual-block-stop-${index}`,
      group: 'non-link-ordinary-text',
      text: `[Unbound\n${boundary}closing](current.md)`,
      expected: { static: null, staged: null, commit: null },
      navigation: 'none',
    })
  }
  for (const sample of [
    { id: 'container-continuation-definition', text: '- Item\n\n  [old]: 04-legacy.md\n\n[old]', line: 3 },
    { id: 'container-paragraph-quote', text: '> Introduction\n> [old]: current.md\n\n[old]', line: 2 },
    { id: 'container-paragraph-list', text: '- Introduction\n  [old]: current.md\n\n[old]', line: 2 },
    { id: 'container-nested-quote-definition', text: '> > [old]: current.md\n\n[old]', line: 1 },
    {
      id: 'container-long-quote-definition',
      text: '> [word-0\n> word-1\n> word-2\n> word-3]: current.md\n\n[word-0 word-1 word-2 word-3]',
      line: 1,
    },
    { id: 'definition-multiline-title', text: '[current]: current.md\n "Multi\n line title"\n\n[current]', line: 1 },
  ]) {
    cases.push({
      id: sample.id,
      group: 'unsupported-definition-boundaries',
      text: sample.text,
      expected: allReject('LOCAL_LINK_UNSUPPORTED'),
      navigation: 'none',
      issueLine: sample.line,
    })
  }
  for (const sample of [
    { id: 'quote-inline-code', text: '> `Example\n> [New](new-guide.md)\n> `', example: true },
    { id: 'quote-inline-comment', text: '> Introduction <!--\n> [New](new-guide.md) -->', example: true },
    { id: 'quote-code-blank', text: '> `Example\n>\n> [New](new-guide.md)\n> `', example: false },
    { id: 'quote-comment-blank', text: '> Introduction <!--\n>\n> -->\n> [New](new-guide.md)', example: false },
    { id: 'quote-code-heading', text: '> `Example\n> # Heading\n> [New](new-guide.md)\n> `', example: false },
    { id: 'list-inline-code', text: '- `Example\n  [New](new-guide.md)\n  `', example: true },
    { id: 'list-inline-comment', text: '- Introduction <!--\n  [New](new-guide.md) -->', example: true },
  ]) {
    cases.push({
      id: `self-review-${sample.id}`,
      group: 'container-inline-spans-use-logical-blocks',
      text: sample.text,
      expected: {
        static: null,
        staged: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
        commit: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
      },
      navigation: sample.example ? 'example' : 'eligible',
      addition: true,
    })
  }
  for (const marker of ['`', '``']) {
    cases.push({
      id: `self-review-leading-code-definition-${marker.length}`,
      group: 'definition-start-cannot-be-created-by-masking',
      text: `${marker}Example${marker} [new]: new-guide.md\n\n[New]`,
      expected: allReject('LOCAL_LINK_UNSUPPORTED'),
      navigation: 'none',
      addition: true,
      issueLine: 1,
    })
  }
  cases.push({
    id: 'self-review-quote-multiline-shortcut',
    group: 'container-label-normalization',
    text: '> [word-0\n> word-1]\n\n[word-0 word-1]: current.md',
    expected: allReject('LOCAL_LINK_UNSUPPORTED'),
    navigation: 'none',
    issueLine: 1,
  })
  for (const sample of [
    {
      id: 'existing-title-ordinary-quote',
      text: '[new]: new-guide.md "Existing title"\n"Ordinary paragraph [New](new-guide.md)"\n\n[new]',
    },
    {
      id: 'unclosed-title-ordinary-quote',
      text: "[new]: new-guide.md\n'Ordinary paragraph [New](new-guide.md) but no closing title\n\n[new]",
    },
    {
      id: 'closed-quote-trailing-paragraph',
      text: "[new]: new-guide.md\n'Closed quote' trailing paragraph [New](new-guide.md)\n\n[new]",
    },
    {
      id: 'nested-parenthesis-ordinary-text',
      text: '[new]: new-guide.md\n(outer (inner) [New](new-guide.md))\n\n[new]',
    },
  ]) {
    cases.push({
      id: `self-review-${sample.id}`,
      group: 'title-continuation-versus-ordinary-text',
      text: sample.text,
      expected: { static: null, staged: null, commit: null },
      navigation: 'eligible',
      addition: true,
    })
  }
  for (const [index, title] of [
    "'Closed title'",
    '(escaped \\(inner\\))',
    '    "Multi\n    line title"',
    '\t"Multi\n\tline title"',
    '        "Multi\n        line title"',
  ].entries()) {
    cases.push({
      id: `self-review-real-title-continuation-${index}`,
      group: 'title-continuation-versus-ordinary-text',
      text: `[current]: current.md\n${title}\n\n[current]`,
      expected: allReject('LOCAL_LINK_UNSUPPORTED'),
      navigation: 'none',
      issueLine: 1,
    })
  }
  for (const sample of [
    { id: 'lazy-quote-code', text: '> `Example\nlazy continuation\n> [New](new-guide.md)\n> `', example: true },
    {
      id: 'lazy-quote-comment',
      text: '> Introduction <!--\nlazy continuation\n> [New](new-guide.md) -->',
      example: true,
    },
    { id: 'lazy-quote-visible', text: '> Introduction\nlazy continuation\n> [New](new-guide.md)', example: false },
    {
      id: 'quote-actual-outdent',
      text: '> Introduction\n\nOutside paragraph\n\n[new]: new-guide.md\n\n[new]',
      example: false,
    },
    { id: 'quote-actual-heading', text: '> `Example\n# Heading\n> [New](new-guide.md)\n> `', example: false },
    { id: 'quote-actual-thematic', text: '> `Example\n---\n> [New](new-guide.md)\n> `', example: false },
    {
      id: 'quote-actual-html-block',
      text: '> Introduction <!--\n<!-- block -->\n> [New](new-guide.md)',
      example: false,
    },
  ]) {
    cases.push({
      id: `final-review-${sample.id}`,
      group: 'logical-quote-continuity-versus-block-interruption',
      text: sample.text,
      expected: {
        static: null,
        staged: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
        commit: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
      },
      navigation: sample.example ? 'example' : 'eligible',
      addition: true,
    })
  }
  cases.push({
    id: 'final-review-lazy-quote-shortcut',
    group: 'logical-quote-continuity-versus-block-interruption',
    text: '> [word-0\nmiddle\n> word-1]\n\n[word-0 middle word-1]: current.md',
    expected: allReject('LOCAL_LINK_UNSUPPORTED'),
    navigation: 'none',
    issueLine: 1,
  })
  for (const sample of [
    { id: 'paragraph-one-interrupts', text: 'Paragraph `Example\n1. [New](new-guide.md)\n`', example: false },
    { id: 'paragraph-two-code', text: 'Paragraph `Example\n2. [New](new-guide.md)\n`', example: true },
    { id: 'paragraph-two-comment', text: 'Paragraph <!--\n2. [New](new-guide.md) -->', example: true },
    { id: 'quote-paragraph-two-code', text: '> `Example\n> 2. [New](new-guide.md)\n> `', example: true },
    { id: 'block-start-two-code', text: '2. `Example\n   [New](new-guide.md)\n   `', example: true },
    { id: 'same-list-next-two', text: '1. `Example\n2. [New](new-guide.md)\n`', example: false },
    { id: 'blank-start-two-code', text: 'Introduction\n\n2. `Example\n   [New](new-guide.md)\n   `', example: true },
    { id: 'long-number-paragraph-code', text: 'Paragraph `Example\n1234567890. [New](new-guide.md)\n`', example: true },
    { id: 'long-number-list-code', text: '1. `Example\n1234567890. [New](new-guide.md)\n`', example: true },
  ]) {
    cases.push({
      id: `ordered-review-${sample.id}`,
      group: 'ordered-list-candidate-versus-paragraph-interruption',
      text: sample.text,
      expected: {
        static: null,
        staged: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
        commit: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
      },
      navigation: sample.example ? 'example' : 'eligible',
      addition: true,
    })
  }
  for (const sample of [
    { id: 'star-paragraph-code', text: 'Paragraph `Example\n* \n[New](new-guide.md)\n`', example: true },
    { id: 'plus-paragraph-code', text: 'Paragraph `Example\n+ \n[New](new-guide.md)\n`', example: true },
    { id: 'one-paragraph-code', text: 'Paragraph `Example\n1. \n[New](new-guide.md)\n`', example: true },
    { id: 'same-list-empty-item', text: '1. `Example\n2. \n[New](new-guide.md)\n`', example: false },
  ]) {
    cases.push({
      id: `empty-review-${sample.id}`,
      group: 'empty-list-item-versus-paragraph-interruption',
      text: sample.text,
      expected: {
        static: null,
        staged: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
        commit: sample.example ? 'ADD_NAVIGATION_MISSING' : null,
      },
      navigation: sample.example ? 'example' : 'eligible',
      addition: true,
    })
  }
  return cases
})()
// GOV-03 matrix:end

describe('GOV-03 parsing contract matrix', () => {
  it.each(gov03Cases)('$id ($group)', (sample) => {
    const added = 'docs/new-guide.md'
    const { root, base } = fixture(
      sample.addition
        ? {
            add: [{ path: added, kind: 'analysis', role: 'scoped-executor', lifecycle: 'active' }],
            sections: [
              { path: 'docs/README.md', block: 'docs-registry' },
              { path: 'docs/README.md', block: 'docs-usage' },
            ],
          }
        : {},
    )
    claim(root, base)
    if (sample.addition) {
      write(root, added, '# Approved document\n')
      replace(
        root,
        'docs/README.md',
        '<!-- docs-registry:end -->',
        `| \`${added}\` | analysis | scoped-executor | active |\n<!-- docs-registry:end -->`,
      )
    }
    const before = readFileSync(join(root, 'docs/README.md'), 'utf8')
    const startLine = before.slice(0, before.indexOf('[Current](current.md)')).split('\n').length
    replace(root, 'docs/README.md', '[Current](current.md)', sample.text)
    const staticResult = cli(root, ['--json'], `GOV-03/${sample.id}/static`)
    git(root, ['add', '--', PLAN, 'docs/README.md', ...(sample.addition ? [added] : [])])
    const stagedResult = staged(root, base, `GOV-03/${sample.id}/staged`)
    git(root, ['commit', '--quiet', '-m', `fixture GOV-03 ${sample.id}`])
    const target = git(root, ['rev-parse', 'HEAD'])
    const commitResult = cli(
      root,
      ['--task', 'GOV-01', '--base', base, '--commit', target, '--json'],
      `GOV-03/${sample.id}/commit`,
    )
    for (const [mode, result] of [
      ['static', staticResult],
      ['staged', stagedResult],
      ['commit', commitResult],
    ] as const) {
      const code = sample.expected[mode]
      if (code) {
        const file = code === 'ADD_NAVIGATION_MISSING' ? added : 'docs/README.md'
        const value = rejected(result, code, file)
        expect(value.mode).toBe(mode)
        expect(value.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code,
              file,
              line: code === 'ADD_NAVIGATION_MISSING' ? 1 : startLine + (sample.issueLine ?? 1) - 1,
            }),
          ]),
        )
      } else {
        expect(result.status).toBe(0)
        expect(report(result)).toMatchObject({ mode, issues: [] })
      }
    }
    expect(git(root, ['diff', '--name-status'])).toBe(`D\t${RETIRED}`)
  })

  it.each(['---', 'Title\n---', 'Title\n==='])('keeps code headings after %s out of task ownership', (prefix) => {
    const { root } = fixture()
    const example = `${prefix}\n\t### EXAMPLE-03 Fake ${EMPTY}\n    # Fake top-level header`
    replace(
      root,
      PLAN,
      '**Acceptance**: Keep the existing contract.',
      `**Acceptance**: Keep the existing contract.\n\n${example}`,
    )
    git(root, ['add', '--', PLAN])
    git(root, ['commit', '--quiet', '-m', 'fixture GOV-03 heading boundary assignment'])
    const base = git(root, ['rev-parse', 'HEAD'])
    claim(root, base)
    checkModes(root, base, ['tools/allowed.ts'], `GOV-03/task-headings/${prefix}`)
  })
})
