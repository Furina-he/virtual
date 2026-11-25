import type { LearnCategory, LearnResource } from '../../shared/schema/learn.ts'

export type LearnCategoryMeta = {
  id: LearnCategory
  label: string
  description: string
}

export const LEARN_CATEGORIES: readonly LearnCategoryMeta[] = [
  { id: 'concept', label: '基本概念', description: '电路基本物理量、参考方向与基本定律' },
  { id: 'theory', label: '基础理论', description: '模拟放大、频响、时序逻辑与数模接口理论' },
  { id: 'component', label: '电子元器件', description: '电阻、电容、二极管、三极管、电位器、开关与继电器 3D 认知' },
  { id: 'ic', label: '常用集成电路', description: 'NE555、74LS/CD4511 等常用芯片引脚图、功能表与应用' },
  { id: 'instrument-tool', label: '常用仪器仪表工具', description: '万用表、示波器、电源与常用电工工具结构与使用规范' },
] as const

export const LEARN_SECTION_TABS = [
  { key: 'structure', label: '结构原理' },
  { key: 'symbol', label: '符号识别' },
  { key: 'parameters', label: '参数计算' },
  { key: 'troubleshooting', label: '故障处理' },
] as const

export type LearnSectionKey = (typeof LEARN_SECTION_TABS)[number]['key']

export type LearnCategoryNode = {
  category: LearnCategory
  label: string
  count: number
  subcategories: { name: string; count: number }[]
}

export function buildCategoryTree(resources: readonly LearnResource[]): LearnCategoryNode[] {
  return LEARN_CATEGORIES.map((meta) => {
    const inCategory = resources.filter((item) => item.category === meta.id)
    const subMap = new Map<string, number>()
    for (const item of inCategory) {
      subMap.set(item.subcategory, (subMap.get(item.subcategory) ?? 0) + 1)
    }
    return {
      category: meta.id,
      label: meta.label,
      count: inCategory.length,
      subcategories: [...subMap.entries()].map(([name, count]) => ({ name, count })),
    }
  })
}

export type LearnFilterOptions = {
  category?: LearnCategory | 'all'
  subcategory?: string | null
  query?: string
}

export function filterLearnResources(
  resources: readonly LearnResource[],
  options: LearnFilterOptions = {},
): LearnResource[] {
  const { category = 'all', subcategory = null, query = '' } = options
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)

  return resources.filter((item) => {
    if (category !== 'all' && item.category !== category) return false
    if (subcategory && item.subcategory !== subcategory) return false
    if (terms.length === 0) return true
    const haystack = [
      item.id,
      item.title,
      item.subtitle,
      item.summary,
      item.subcategory,
      ...item.keywords,
      item.sections.structure,
      item.sections.symbol,
      item.sections.parameters,
      item.sections.troubleshooting,
    ]
      .join(' ')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export type LearnCompletenessReport = {
  complete: boolean
  missingSections: LearnSectionKey[]
  missingModel: boolean
}

const MODEL_REQUIRED_CATEGORIES = new Set<LearnCategory>(['component', 'ic', 'instrument-tool'])

export function checkLearnResourceCompleteness(resource: LearnResource): LearnCompletenessReport {
  const missingSections: LearnSectionKey[] = []
  for (const tab of LEARN_SECTION_TABS) {
    if (!resource.sections[tab.key]?.trim()) {
      missingSections.push(tab.key)
    }
  }
  const missingModel = MODEL_REQUIRED_CATEGORIES.has(resource.category) && !resource.model
  return {
    complete: missingSections.length === 0 && !missingModel,
    missingSections,
    missingModel,
  }
}

export function findLearnResourceForBenchTarget(
  resources: readonly LearnResource[],
  target: { instrumentId?: string; moduleId?: string; keyword?: string },
): LearnResource | undefined {
  if (target.instrumentId) {
    const id = target.instrumentId
    const direct = resources.find((item) => item.category === 'instrument-tool' && item.relatedInstruments.includes(id))
    if (direct) return direct
    const matched = resources.find((item) => item.relatedInstruments.includes(id))
    if (matched) return matched
  }
  if (target.moduleId) {
    const matched = resources.find((item) => item.relatedModules.includes(target.moduleId as string))
    if (matched) return matched
  }
  if (target.keyword) {
    return filterLearnResources(resources, { query: target.keyword })[0]
  }
  return resources[0]
}

export function learnCategoryLabel(category: LearnCategory): string {
  return LEARN_CATEGORIES.find((item) => item.id === category)?.label ?? category
}
