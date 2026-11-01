import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('virtual-docs-lint-')) {
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
