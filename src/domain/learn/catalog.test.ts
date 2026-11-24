import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LearnResource } from '../../shared/schema/learn.ts'
import {
  buildCategoryTree,
  checkLearnResourceCompleteness,
  filterLearnResources,
  findLearnResourceForBenchTarget,
  LEARN_CATEGORIES,
  LEARN_SECTION_TABS,
  learnCategoryLabel,
} from './catalog.ts'

function loadWorkspaceResources(): LearnResource[] {
  const dir = resolve('content/learn')
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const raw = readFileSync(resolve(dir, entry.name, 'resource.json'), 'utf8')
      return LearnResource.parse(JSON.parse(raw))
    })
}

describe('T1.9 LRN-01~LRN-08 五类学习资源分类树、全文检索与四项内容完整性', () => {
  const resources = loadWorkspaceResources()

  it('LRN-01/LRN-04/LRN-06/LRN-07 五类资源均非空且每项具备完整四项内容与有效 3D 模型声明', () => {
    const tree = buildCategoryTree(resources)
    expect(tree).toHaveLength(LEARN_CATEGORIES.length)
    for (const node of tree) {
      expect(node.count, `${node.label} 至少包含 1 个资源条目`).toBeGreaterThan(0)
      expect(node.subcategories.length).toBeGreaterThan(0)
    }

    expect(LEARN_SECTION_TABS.map((tab) => tab.label)).toEqual(['结构原理', '符号识别', '参数计算', '故障处理'])

    for (const item of resources) {
      const report = checkLearnResourceCompleteness(item)
      expect(report.complete, `${item.id} 完整性校验应通过`).toBe(true)
      expect(report.missingSections).toEqual([])
      expect(report.missingModel).toBe(false)
    }

    expect(learnCategoryLabel('instrument-tool')).toBe('常用仪器仪表工具')
  })

  it('LRN-01 支持按分类、子分类与多关键字全文检索（标题、关键词、正文）', () => {
    const byCategory = filterLearnResources(resources, { category: 'ic' })
    expect(byCategory.map((item) => item.id)).toEqual(expect.arrayContaining(['ic-ne555', 'ic-74ls90']))

    const bySubcategory = filterLearnResources(resources, { category: 'component', subcategory: '电阻类' })
    expect(bySubcategory.every((item) => item.subcategory === '电阻类')).toBe(true)

    // 多关键字命中：同时检索型号与正文术语
    const byQuery = filterLearnResources(resources, { query: '555 多谐' })
    expect(byQuery.map((item) => item.id)).toEqual(['ic-ne555'])

    // 检索工具条目（LRN-07）
    const toolHits = filterLearnResources(resources, { query: '组合钳' })
    expect(toolHits.map((item) => item.id)).toEqual(['tool-combination-pliers'])

    // 不存在的关键字返回空列表
    expect(filterLearnResources(resources, { query: '不存在的器件XYZ' })).toEqual([])
  })

  it('LRN-08 从实训台仪表或挂箱模块准确映射到对应学习资源条目', () => {
    const scopeRes = findLearnResourceForBenchTarget(resources, { instrumentId: 'ins-oscilloscope' })
    expect(scopeRes?.id).toBe('ins-learn-oscilloscope')

    const meterRes = findLearnResourceForBenchTarget(resources, { instrumentId: 'ins-multimeter' })
    expect(meterRes?.id).toBe('ins-learn-multimeter')

    const ampRes = findLearnResourceForBenchTarget(resources, { moduleId: 'mod-analog-amp' })
    expect(ampRes).toBeDefined()
    expect(ampRes?.relatedModules).toContain('mod-analog-amp')
  })
})
