export type SchematicJackAttrName = 'data-jack' | 'data-jack-id' | 'id'

export type SchematicJackLink = {
  attrName: SchematicJackAttrName
  attrValue: string
  jackRef: string
  jackId: string
}

export type SchematicElementAttrs = {
  dataJack?: string | null
  dataJackId?: string | null
  id?: string | null
}

const FULL_JACK_REF_RE = /^[a-z][a-z0-9-]*\.[A-Za-z0-9_-]+$/

function resolveShortJackId(shortId: string, availableJackRefs: readonly string[]): string | null {
  if (!shortId) return null
  if (FULL_JACK_REF_RE.test(shortId)) {
    if (availableJackRefs.length === 0 || availableJackRefs.includes(shortId)) return shortId
    return null
  }
  const suffix = `.${shortId}`
  const matches = availableJackRefs.filter((ref) => ref.endsWith(suffix))
  if (matches.length === 1) return matches[0] ?? null
  return null
}

export function resolveJackRefFromElement(
  attrs: SchematicElementAttrs,
  availableJackRefs: readonly string[],
): { attrName: SchematicJackAttrName; attrValue: string; jackRef: string; jackId: string } | null {
  const dataJack = attrs.dataJack?.trim()
  if (dataJack) {
    const resolved = resolveShortJackId(dataJack, availableJackRefs)
    if (resolved) {
      return {
        attrName: 'data-jack',
        attrValue: dataJack,
        jackRef: resolved,
        jackId: resolved.slice(resolved.indexOf('.') + 1),
      }
    }
  }

  const dataJackId = attrs.dataJackId?.trim()
  if (dataJackId) {
    const resolved = resolveShortJackId(dataJackId, availableJackRefs)
    if (resolved) {
      return {
        attrName: 'data-jack-id',
        attrValue: dataJackId,
        jackRef: resolved,
        jackId: resolved.slice(resolved.indexOf('.') + 1),
      }
    }
  }

  const id = attrs.id?.trim()
  if (id?.startsWith('JACK_')) {
    const rawJack = id.slice('JACK_'.length)
    const resolved = resolveShortJackId(rawJack, availableJackRefs)
    if (resolved) {
      return {
        attrName: 'id',
        attrValue: id,
        jackRef: resolved,
        jackId: resolved.slice(resolved.indexOf('.') + 1),
      }
    }
  }

  return null
}

const SVG_TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*?)\/?>/g
const ATTR_RE = /\b(data-jack|data-jack-id|id)\s*=\s*"([^"]+)"/g

/** 从原理图 SVG 文本解析全部与当前实训台插孔对应的节点映射（TSK-02）。 */
export function extractSchematicJackLinks(svgText: string, availableJackRefs: readonly string[]): SchematicJackLink[] {
  const links: SchematicJackLink[] = []
  const seen = new Set<string>()
  for (const tagMatch of svgText.matchAll(SVG_TAG_RE)) {
    const attrBlob = tagMatch[2]
    if (!attrBlob) continue
    const attrs: SchematicElementAttrs = {}
    for (const attrMatch of attrBlob.matchAll(ATTR_RE)) {
      const name = attrMatch[1]
      const value = attrMatch[2]
      if (name === 'data-jack') attrs.dataJack = value
      else if (name === 'data-jack-id') attrs.dataJackId = value
      else if (name === 'id') attrs.id = value
    }
    const resolved = resolveJackRefFromElement(attrs, availableJackRefs)
    if (!resolved) continue
    const dedupeKey = `${resolved.attrName}:${resolved.attrValue}:${resolved.jackRef}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    links.push(resolved)
  }
  return links
}

/** 根据 3D 台面或接线列表悬停/选中的插孔反查原理图高亮节点（双向高亮）。 */
export function findMatchingSchematicLinks(
  jackRef: string | null | undefined,
  links: readonly SchematicJackLink[],
): SchematicJackLink[] {
  if (!jackRef) return []
  return links.filter((link) => link.jackRef === jackRef)
}

export function buildBidirectionalJackMap(links: readonly SchematicJackLink[]): {
  toJackRef: Map<string, string>
  toSchematicKeys: Map<string, string[]>
} {
  const toJackRef = new Map<string, string>()
  const toSchematicKeys = new Map<string, string[]>()
  for (const link of links) {
    const key = `${link.attrName}=${link.attrValue}`
    toJackRef.set(key, link.jackRef)
    const list = toSchematicKeys.get(link.jackRef) ?? []
    if (!list.includes(key)) list.push(key)
    toSchematicKeys.set(link.jackRef, list)
  }
  return { toJackRef, toSchematicKeys }
}

export type SchematicJackClickDecision =
  | { action: 'start'; source: string }
  | { action: 'complete'; source: string; target: string }
  | { action: 'cancel'; source: string }

/**
 * 原理图两点直连状态转换纯函数（T1.9B，技术设计 §11）：
 * 无待接线时设起点；点击同孔取消待接线；点击另一插孔直接完成真实连线。
 */
export function resolveSchematicJackClick(
  currentPending: string | null,
  clickedJackRef: string,
): SchematicJackClickDecision {
  if (!currentPending) return { action: 'start', source: clickedJackRef }
  if (currentPending === clickedJackRef) return { action: 'cancel', source: clickedJackRef }
  return { action: 'complete', source: currentPending, target: clickedJackRef }
}
