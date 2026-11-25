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

  it('M2 LRN 验收：90 个元器件（★ ≥80 且十类齐全）、38 款芯片、12 仪表 + 5 工具，且覆盖全部 61 项目与 33 模块', () => {
    const components = resources.filter((item) => item.category === 'component')
    const ics = resources.filter((item) => item.category === 'ic')
    const instrumentsAndTools = resources.filter((item) => item.category === 'instrument-tool')
    const principles = resources.filter((item) => item.category === 'concept' || item.category === 'theory')

    // PRD 5.2.1(2)1) ★ ≥80 元器件 & §8.1 精确 90 个十类齐全
    expect(components.length).toBe(90)
    const compSubs = new Map<string, number>()
    for (const c of components) compSubs.set(c.subcategory, (compSubs.get(c.subcategory) ?? 0) + 1)
    expect(Object.fromEntries(compSubs)).toEqual({
      电阻类: 14,
      电容类: 10,
      电感与磁性元件: 10,
      二极管类: 11,
      '三极管、场效应管、晶闸管': 10,
      光电与显示: 5,
      电声器件: 5,
      '开关、继电器与保护': 10,
      传感器: 7,
      其他: 8,
    })

    // PRD §8.2 精确 38 款常用集成电路（全部含 Markdown 功能表）
    expect(ics.length).toBe(38)
    for (const ic of ics) {
      expect(ic.model, `${ic.id} 须配置 3D 封装模型`).toBeDefined()
    }

    // PRD LRN-07 & LRN-08：全部 12 台实训台仪表均支持精准一键直跳 + 5 件常用电工工具
    const allInstrumentIds = readdirSync(resolve('content/instruments'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(allInstrumentIds.length).toBe(12)
    for (const insId of allInstrumentIds) {
      const hit = findLearnResourceForBenchTarget(resources, { instrumentId: insId })
      expect(hit?.category, `${insId} 跳转应优先落至仪表资料`).toBe('instrument-tool')
      expect(hit?.relatedInstruments).toContain(insId)
    }
    const tools = instrumentsAndTools.filter((item) => item.subcategory === '常用电工工具')
    expect(tools.length).toBe(5)

    // PRD Q9：全部 61 个正式项目均有 ≥1 份基本概念/基础理论原理条目关联
    const allProjects = readdirSync(resolve('content/projects'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(allProjects.length).toBe(61)
    for (const pid of allProjects) {
      const covered = principles.some(
        (item) =>
          item.keywords.includes(pid) ||
          item.summary.includes(pid) ||
          Object.values(item.sections).some((text) => text.includes(pid)),
      )
      expect(covered, `正式项目 ${pid} 至少关联 1 份原理知识点`).toBe(true)
    }

    // PRD LRN-08：全部 33 块挂箱/实验板模块均有关联学习资料
    const allModules = readdirSync(resolve('content/modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    for (const modId of allModules) {
      const hit = findLearnResourceForBenchTarget(resources, { moduleId: modId })
      expect(hit?.relatedModules, `模块 ${modId} 应存在关联学习条目`).toContain(modId)
    }
  })
})
