import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    const expected = resolve(import.meta.dirname, '../build/tasks/GOV-01')
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
