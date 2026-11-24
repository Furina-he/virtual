import { Search, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import {
  circuitStore,
  jackName,
  useActivePlacements,
  useCircuit,
  useWiringJacks,
  type WiringJack,
} from '@/features/practice/wiring-state'
import { cn } from '@/lib/utils'
import { catalog } from './asset-catalog'
import { useBenchView } from './bench-view'

type DeviceCategory = 'power' | 'desktop' | 'fixedMeter' | 'otherModule' | 'sameDevice'

const CATEGORY_ORDER: readonly DeviceCategory[] = ['power', 'desktop', 'fixedMeter', 'otherModule', 'sameDevice']

function classifyDevice(
  instanceId: string,
  assetId: string,
  kind: string,
  sourceInstanceId: string,
  desktopIds: ReadonlySet<string>,
): DeviceCategory {
  if (instanceId === sourceInstanceId) return 'sameDevice'
  if (assetId === 'ins-dc-power' || assetId === 'ins-ac-power') return 'power'
  if (desktopIds.has(instanceId)) return 'desktop'
  if (kind === 'instrument') return 'fixedMeter'
  return 'otherModule'
}

/**
 * 免切镜跨设备快捷落点浮窗（技术设计 §10.3，T1.9B）：
 * - 进入 pendingJack 待接线/改接态时自动从 3D 视口右侧滑出；
 * - 悬停端子芯片时联动 hoveredJack，3D 预览导线实时吸附指向真实目标插孔；
 * - 单击即走 circuitStore.completeConnection 完成真实连线，支持 Shift 或开关连续同源引出。
 */
export function QuickTargetWiringDock() {
  const pending = useCircuit((state) => state.pendingJack)
  const pendingRewire = useCircuit((state) => state.pendingRewire)
  const wires = useCircuit((state) => state.wires)
  const placed = useCircuit((state) => state.placedInstruments)
  const placements = useActivePlacements()
  const jacks = useWiringJacks()
  const [query, setQuery] = useState('')
  const [continuous, setContinuous] = useState(false)
  const switchId = useId()

  useEffect(() => {
    if (!pending) {
      setQuery('')
      setContinuous(false)
    }
  }, [pending])

  const desktopIds = useMemo(() => new Set(placed.map((item) => item.instanceId)), [placed])
  const placementInfo = useMemo(() => {
    const map = new Map<string, { assetId: string; kind: string }>()
    for (const placement of placements) {
      const asset = catalog.assets.find((entry) => entry.id === placement.assetId)
      if (asset) map.set(placement.instanceId, { assetId: asset.id, kind: asset.kind })
    }
    return map
  }, [placements])

  const alreadyLinkedToSource = useMemo(() => {
    const set = new Set<string>()
    if (!pending) return set
    for (const wire of wires) {
      if (pendingRewire && wire.id === pendingRewire.wireId) continue
      if (wire.a === pending) set.add(wire.b)
      if (wire.b === pending) set.add(wire.a)
    }
    return set
  }, [wires, pending, pendingRewire])

  const grouped = useMemo(() => {
    if (!pending) return []
    const sourceInstance = pending.slice(0, pending.indexOf('.'))
    const needle = query.trim().toLowerCase()
    const byDevice = new Map<
      string,
      { instanceId: string; deviceName: string; category: DeviceCategory; jacks: WiringJack[] }
    >()

    for (const jack of jacks) {
      if (jack.ref === pending) continue
      if (pendingRewire && jack.ref === pendingRewire.fixedJack) continue
      if (needle) {
        const haystack = `${jack.deviceName} ${jack.label} ${jack.id} ${jack.ref}`.toLowerCase()
        if (!haystack.includes(needle)) continue
      }
      const existing = byDevice.get(jack.instanceId)
      if (existing) {
        existing.jacks.push(jack)
        continue
      }
      const info = placementInfo.get(jack.instanceId)
      const category = classifyDevice(
        jack.instanceId,
        info?.assetId ?? '',
        info?.kind ?? 'module',
        sourceInstance,
        desktopIds,
      )
      byDevice.set(jack.instanceId, {
        instanceId: jack.instanceId,
        deviceName: jack.deviceName,
        category,
        jacks: [jack],
      })
    }

    return [...byDevice.values()].sort((a, b) => {
      const catDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
      if (catDiff !== 0) return catDiff
      return a.deviceName.localeCompare(b.deviceName, 'zh-CN')
    })
  }, [pending, pendingRewire, jacks, query, placementInfo, desktopIds])

  if (!pending) return null

  return (
    <aside
      aria-label="快捷接线落点"
      data-quick-target-dock
      data-source-jack={pending}
      className="absolute top-11 right-2.5 bottom-2.5 z-20 flex w-64 flex-col rounded-md border bg-background/95 shadow-md"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2.5 py-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-foreground">{pendingRewire ? '快捷改接落点' : '快捷接线落点'}</h3>
          <p className="truncate text-xs text-primary" title={jackName(pending)}>
            {pendingRewire ? `固定端：${jackName(pending)}` : `起点：${jackName(pending)}`}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="关闭快捷落点"
          onClick={() => circuitStore.getState().cancelConnection()}
        >
          <X />
        </Button>
      </div>
      <div className="shrink-0 space-y-2 border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设备或插孔…"
            aria-label="搜索快捷落点"
            data-quick-target-search
            className="h-7 pl-7 text-xs"
          />
        </div>
        {!pendingRewire && (
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={switchId} className="truncate text-xs text-muted-foreground">
              连续从此孔引出（或按 Shift）
            </label>
            <Switch
              id={switchId}
              size="sm"
              aria-label="连续从此孔引出"
              data-continuous-wiring-switch
              checked={continuous}
              onCheckedChange={setContinuous}
            />
          </div>
        )}
      </div>
      <ScrollArea type="auto" className="min-h-0 flex-1">
        <div className="space-y-3 p-2">
          {grouped.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">未找到匹配的端子。</p>
          ) : (
            grouped.map((group) => (
              <div key={group.instanceId} className="space-y-1.5" data-quick-target-group={group.instanceId}>
                <div className="flex items-center justify-between gap-1 text-xs font-medium text-muted-foreground">
                  <span className="truncate">{group.deviceName}</span>
                  {group.category === 'sameDevice' && <span className="shrink-0 font-normal">本设备</span>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.jacks.map((jack) => {
                    const linked = alreadyLinkedToSource.has(jack.ref)
                    const isOriginal = pendingRewire?.originalJack === jack.ref
                    return (
                      <Button
                        key={jack.ref}
                        size="xs"
                        variant="outline"
                        disabled={linked}
                        data-quick-target-jack={jack.ref}
                        title={`${jack.deviceName} · ${jack.label}（${jack.id}）${linked ? ' · 已连接' : ''}`}
                        className={cn('h-6 max-w-full px-2 text-xs', isOriginal && 'border-primary/50 text-primary')}
                        onMouseEnter={() => useBenchView.getState().setHover({ hoveredJack: jack.ref })}
                        onFocus={() => useBenchView.getState().setHover({ hoveredJack: jack.ref })}
                        onMouseLeave={() => {
                          if (useBenchView.getState().hoveredJack === jack.ref) {
                            useBenchView.getState().setHover({ hoveredJack: null })
                          }
                        }}
                        onBlur={() => {
                          if (useBenchView.getState().hoveredJack === jack.ref) {
                            useBenchView.getState().setHover({ hoveredJack: null })
                          }
                        }}
                        onClick={(event) => {
                          const keepSource = !pendingRewire && (continuous || event.shiftKey)
                          const ok = circuitStore.getState().completeConnection(jack.ref, { keepSource })
                          if (ok && useBenchView.getState().hoveredJack === jack.ref) {
                            useBenchView.getState().setHover({ hoveredJack: null })
                          }
                        }}
                      >
                        <span className="truncate">{jack.label}</span>
                        {linked && <span className="text-muted-foreground">已连</span>}
                      </Button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}
