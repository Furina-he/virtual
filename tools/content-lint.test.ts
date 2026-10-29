import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lintContent } from './content-lint.ts'

describe('content:lint', () => {
  it('仓库 content/ 全部通过', () => {
    expect(lintContent('content')).toEqual([])
  })

  it('故意写错的样例报出文件路径与字段路径', () => {
    const issues = lintContent('tests/fixtures/content-bad').map((i) => `${i.file} ${i.path}`)
    expect(issues).toEqual(
      expect.arrayContaining([
        'tests/fixtures/content-bad/modules/mod-y/module.json controls[0].default',
        'tests/fixtures/content-bad/projects/DG-05/project.json allowedInstruments[0]',
        'tests/fixtures/content-bad/projects/DG-05/project.json allowedInstruments[1]',
        'tests/fixtures/content-bad/projects/DG-05/project.json reference.nets[0][1]',
      ]),
    )
    expect(issues).toHaveLength(4)
  })

  it('checks actual jack membership in step topology replacements', () => {
    const root = mkdtempSync(join(tmpdir(), 'virtual-step-reference-'))
    cpSync('content', root, { recursive: true })
    const file = join(root, 'projects', 'DG-05', 'project.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    data.steps[0].referenceNets = [['dc1.KH_F', 'dc1.UNKNOWN']]
    writeFileSync(file, JSON.stringify(data))
    const issues = lintContent(root)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ path: 'steps[0].referenceNets[0][1]', message: 'dc1 上没有插孔 UNKNOWN' })
  })
})
