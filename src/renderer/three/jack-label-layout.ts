import type { ScreenPoint } from './screen-picking'

/** 单设备特写常驻插孔标注的最小相邻屏幕间距与 DOM 上限（技术设计 §10.3，T1.9B）。 */
export const PERSISTENT_LABEL_MIN_SPACING_PX = 24
export const MAX_PERSISTENT_LABELS = 28

export interface LabelCandidate extends ScreenPoint {
  id: string
  label: string
  priority?: number
}

export interface PlacedJackLabel {
  id: string
  offsetX: number
  offsetY: number
}

interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

function estimateLabelSize(label: string): { width: number; height: number } {
  let units = 0
  for (const ch of label) {
    units += ch.charCodeAt(0) > 127 ? 1.5 : 0.9
  }
  return {
    width: Math.max(28, Math.min(104, Math.ceil(units * 8 + 12))),
    height: 20,
  }
}

function rectsOverlap(a: Rect, b: Rect, gap = 3): boolean {
  return !(a.right + gap <= b.left || b.right + gap <= a.left || a.bottom + gap <= b.top || b.bottom + gap <= a.top)
}

function insideViewport(rect: Rect, width: number, height: number, margin = 4): boolean {
  return rect.left >= margin && rect.top >= margin && rect.right <= width - margin && rect.bottom <= height - margin
}

/** 计算一组屏幕投影点的最小两两间距（像素）。少于 2 个点返回 Infinity。 */
export function minPairwiseSpacingPx(points: readonly ScreenPoint[]): number {
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    if (!a) continue
    for (let j = i + 1; j < points.length; j++) {
      const b = points[j]
      if (!b) continue
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (dist < min) min = dist
    }
  }
  return min
}

/**
 * 轻量贪心矩形避让算法（T1.9B，技术设计 §10.3）：
 * 在单设备特写且相邻插孔间距 ≥ 24 px 时，为可见插孔计算不重叠的偏移位置，并受 MAX_PERSISTENT_LABELS 上限保护。
 */
export function layoutVisibleJackLabels(
  candidates: readonly LabelCandidate[],
  options: {
    viewportWidth: number
    viewportHeight: number
    minSpacingPx?: number
    maxLabels?: number
  },
): PlacedJackLabel[] {
  const {
    viewportWidth,
    viewportHeight,
    minSpacingPx = PERSISTENT_LABEL_MIN_SPACING_PX,
    maxLabels = MAX_PERSISTENT_LABELS,
  } = options
  if (!candidates.length || viewportWidth <= 0 || viewportHeight <= 0 || maxLabels <= 0) return []
  if (minPairwiseSpacingPx(candidates) < minSpacingPx) return []

  const ordered = candidates.slice().sort((a, b) => {
    const prioDiff = (b.priority ?? 0) - (a.priority ?? 0)
    if (prioDiff !== 0) return prioDiff
    if (Math.abs(a.y - b.y) > 4) return a.y - b.y
    return a.x - b.x
  })

  const placed: PlacedJackLabel[] = []
  const boxes: Rect[] = []

  for (const item of ordered) {
    if (placed.length >= maxLabels) break
    const size = estimateLabelSize(item.label)
    const halfW = size.width / 2
    const halfH = size.height / 2
    const offsets: readonly [number, number][] = [
      [0, -(halfH + 11)],
      [0, halfH + 11],
      [halfW + 12, 0],
      [-(halfW + 12), 0],
    ]
    for (const [offsetX, offsetY] of offsets) {
      const cx = item.x + offsetX
      const cy = item.y + offsetY
      const rect: Rect = {
        left: cx - halfW,
        right: cx + halfW,
        top: cy - halfH,
        bottom: cy + halfH,
      }
      if (!insideViewport(rect, viewportWidth, viewportHeight)) continue
      if (boxes.some((other) => rectsOverlap(rect, other))) continue
      boxes.push(rect)
      placed.push({ id: item.id, offsetX: Math.round(offsetX), offsetY: Math.round(offsetY) })
      break
    }
  }

  return placed
}
