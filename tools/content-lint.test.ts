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
})
