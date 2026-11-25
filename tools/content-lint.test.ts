import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { subcircuitPorts } from './assets/lint.ts'
import {
  lintContent,
  lintLearnResourceSections,
  lintProjectGuide,
  lintProjectSchematic,
  PROJECT_GUIDE_SECTIONS,
} from './content-lint.ts'
import { scaffoldLearnResource, scaffoldModule, scaffoldProject } from './content-scaffold.ts'

const tempRoots: string[] = []

function copyContentFixture(prefix = 'virtual-content-lint-'): string {
  const root = resolve(mkdtempSync(join(tmpdir(), prefix)))
  tempRoots.push(root)
  cpSync('content', root, { recursive: true })
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('virtual-')) {
      throw new Error(`Refusing to remove unexpected temp dir: ${root}`)
    }
    rmSync(root, { recursive: true, force: true })
  }
})

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
    const root = copyContentFixture('virtual-step-reference-')
    const file = join(root, 'projects', 'DG-05', 'project.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    data.steps[0].referenceNets = [['dc1.KH_F', 'dc1.UNKNOWN']]
    writeFileSync(file, JSON.stringify(data))
    const issues = lintContent(root)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ path: 'steps[0].referenceNets[0][1]', message: 'dc1 上没有插孔 UNKNOWN' })
  })
})

describe('T1.10 NFR-07 项目 guide.md 六项结构、原理图与学习资源 Markdown 章节门禁', () => {
  it('NFR-07 T1.10 缺少 guide.md 或缺少六项必备二级标题时精准报错', () => {
    const root = copyContentFixture()
    const guideFile = join(root, 'projects', 'DG-05', 'guide.md')

    // 1. 删除 guide.md
    unlinkSync(guideFile)
    expect(lintContent(root)).toEqual([
      expect.objectContaining({
        path: 'guide.md',
        message: '缺少项目实训指导书 guide.md',
      }),
    ])

    // 2. 缺失「注意事项」与「思考题」，且把「实训目的」放进代码块试图伪造
    writeFileSync(
      guideFile,
      [
        '# DG-05 缺章节样例',
        '```markdown',
        '## 实训目的',
        '代码块内标题不能冒充正式章节。',
        '```',
        '## 实训原理',
        '说明 KCL 与 KVL 原理。',
        '## 器材清单',
        '- 电路基础挂箱',
        '## 实训步骤',
        '1. 接线并测量。',
        '### 注意事项',
        '三级标题不能替代必备二级标题。',
      ].join('\n'),
      'utf8',
    )
    const missingIssues = lintContent(root)
    expect(missingIssues.map((issue) => issue.path)).toEqual([
      'guide.md#实训目的',
      'guide.md#注意事项',
      'guide.md#思考题',
    ])
  })

  it('NFR-07 T1.10 校验 guide.md 章节正文非空、不可重复、顺序规范且禁止外网媒体', () => {
    const emptyAndDup = [
      '## 实训目的',
      '### 仅有三级子标题没有正文',
      '## 实训原理',
      '原理正文。',
      '## 器材清单',
      '器材清单正文。',
      '## 实训步骤',
      '步骤正文。',
      '## 思考题',
      '1. 先写了思考题导致顺序错误。',
      '## 注意事项',
      '![外网图](https://example.invalid/pic.png)',
      '## 注意事项',
      '重复出现。',
    ].join('\n')

    const issues = lintProjectGuide('content/projects/DG-05/guide.md', emptyAndDup)
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'guide.md', message: expect.stringContaining('外部网络媒体资源') }),
        expect.objectContaining({ path: 'guide.md#实训目的', message: '章节「## 实训目的」正文不能为空' }),
        expect.objectContaining({ path: 'guide.md#注意事项', message: '二级标题「## 注意事项」重复出现' }),
        expect.objectContaining({
          path: 'guide.md#思考题',
          message: '章节「## 思考题」顺序应位于「## 注意事项」之后',
        }),
      ]),
    )
    expect(PROJECT_GUIDE_SECTIONS).toEqual(['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题'])
  })

  it('NFR-07 T1.10 校验正式项目 schematic.svg 存在性及离线 SVG 合法性', () => {
    const root = copyContentFixture()
    const schematicFile = join(root, 'projects', 'MD-07', 'schematic.svg')

    // 正式项目缺少 schematic.svg 报错
    unlinkSync(schematicFile)
    expect(lintContent(root)).toEqual([
      expect.objectContaining({ path: 'schematic.svg', message: '缺少项目原理图 schematic.svg' }),
    ])

    // 写入非法 SVG 内容报错
    writeFileSync(schematicFile, '<div>not svg</div>', 'utf8')
    expect(lintContent(root)).toEqual([
      expect.objectContaining({ path: 'schematic.svg', message: '原理图 schematic.svg 内容不是有效的 SVG 文件' }),
    ])

    // 写入外网引用报错（标准 xmlns="http://www.w3.org/2000/svg" 允许，外链 href 禁止）
    writeFileSync(
      schematicFile,
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example.invalid/a.png"/></svg>',
      'utf8',
    )
    expect(lintContent(root)).toEqual([
      expect.objectContaining({ path: 'schematic.svg', message: '原理图禁止引用外部网络资源（NFR-09）' }),
    ])

    expect(
      lintProjectSchematic(
        'schematic.svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
      ),
    ).toEqual([])
  })

  it('NFR-07 T1.10 校验学习资源四项 Markdown 章节、本地 3D 模型与跨文件引用', () => {
    const root = copyContentFixture()
    const file = join(root, 'learn', 'cmp-bjt-npn', 'resource.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))

    // 破坏四项章节与模型/关联引用
    data.sections.structure = '缺少二级标题的纯段落文本'
    data.sections.symbol = '## 只有标题没有正文\n   '
    data.sections.parameters = '## 参数\n![外网图片](https://example.invalid/chart.png)'
    data.model = 'models/components/nonexistent.glb'
    data.relatedModules = ['mod-does-not-exist']
    data.relatedInstruments = ['ins-does-not-exist']
    writeFileSync(file, JSON.stringify(data), 'utf8')

    const issues = lintContent(root)
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'sections.structure', message: expect.stringContaining('缺少二级标题') }),
        expect.objectContaining({ path: 'sections.symbol', message: expect.stringContaining('正文不能为空') }),
        expect.objectContaining({ path: 'sections.parameters', message: expect.stringContaining('外部网络媒体资源') }),
        expect.objectContaining({ path: 'model', message: '3D 模型文件不存在：models/components/nonexistent.glb' }),
        expect.objectContaining({ path: 'relatedModules[0]', message: '关联模块 mod-does-not-exist 不存在' }),
        expect.objectContaining({ path: 'relatedInstruments[0]', message: '关联仪表 ins-does-not-exist 不存在' }),
      ]),
    )

    // 器件/芯片/仪表工具缺失 model 须报错
    const noModel = JSON.parse(readFileSync(join('content', 'learn', 'ic-74ls90', 'resource.json'), 'utf8'))
    delete noModel.model
    writeFileSync(join(root, 'learn', 'ic-74ls90', 'resource.json'), JSON.stringify(noModel), 'utf8')
    expect(lintContent(root)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'model', message: '分类 ic 必须声明本地 3D 模型路径' })]),
    )

    // 正常学习资源四项校验返回空数组
    const validResource = JSON.parse(readFileSync(join('content', 'learn', 'ic-ne555', 'resource.json'), 'utf8'))
    expect(lintLearnResourceSections('content/learn/ic-ne555/resource.json', validResource)).toEqual([])
  })

  it('NFR-07 T1.10 标准脚手架模板可直接生成项目、五类学习资源与模块并通过 content:lint', () => {
    const root = copyContentFixture('virtual-scaffold-')

    // 1. 生成新项目（使用不与 61 个正式项目冲突的合成编号 DG-99）
    const projectFiles = scaffoldProject({
      id: 'DG-99',
      title: '交流电路功率及功率因数的测量',
      group: '交流电路',
      type: 'basic',
      outRoot: root,
    })
    expect(projectFiles).toHaveLength(3)
    expect(() => scaffoldProject({ id: 'DG-99', title: '重复不覆盖', outRoot: root })).toThrow('目标目录已存在')

    // 2. 生成五类学习资源（使用不与 M2 正式资源冲突的合成 ID）
    scaffoldLearnResource({
      category: 'component',
      id: 'cmp-metal-resistor-demo',
      title: '金属膜电阻器样例',
      subcategory: '电阻类',
      outRoot: root,
    })
    scaffoldLearnResource({
      category: 'ic',
      id: 'ic-cd4511-demo',
      title: 'CD4511 译码器样例',
      subcategory: '显示译码',
      outRoot: root,
    })
    scaffoldLearnResource({
      category: 'instrument-tool',
      id: 'tool-wire-stripper-demo',
      title: '剥线钳样例',
      subcategory: '常用电工工具',
      outRoot: root,
    })
    scaffoldLearnResource({
      category: 'concept',
      id: 'concept-power-factor-demo',
      title: '交流电路功率因数样例',
      subcategory: '交流电路概念',
      outRoot: root,
    })
    scaffoldLearnResource({
      category: 'theory',
      id: 'theory-thevenin-demo',
      title: '戴维南等效定理样例',
      subcategory: '直流网络理论',
      outRoot: root,
    })

    // 3. 生成新模块并验证 .subckt 端口与 module.json jacks 顺序 1:1 一致
    const [modJsonPath, modCirPath] = scaffoldModule({
      id: 'mod-ac-power',
      name: '交流功率因数实验挂箱',
      form: 'box',
      outRoot: root,
    })
    const modJson = JSON.parse(readFileSync(modJsonPath as string, 'utf8')) as { jacks: { id: string }[] }
    const modCir = readFileSync(modCirPath as string, 'utf8')
    expect(subcircuitPorts(modCir)).toEqual(modJson.jacks.map((jack) => jack.id))

    // 4. 全部新生成内容合并现有 content/ 后必须零错误通过 content:lint
    expect(lintContent(root)).toEqual([])
  })
})
