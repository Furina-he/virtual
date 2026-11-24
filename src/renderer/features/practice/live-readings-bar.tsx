import { isMeasurementInstrument } from '@domain/instruments'
import type { Project } from '@shared/schema/project'
import { Columns2, Plus, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getInstrumentReading, instrumentReadings, readingIsWarning } from '@/lib/instrument-readings'
import { cn } from '@/lib/utils'
import { instrumentDockStore, resolveDockPanels, useInstrumentDock } from '@/stores/instrument-dock'
import { type PanelDef, useInstrumentPanels } from '@/stores/instrument-panels'
import { taskStore } from '@/stores/task'
import { useCircuit } from './wiring-state'

function panelReadingScreen(panel: PanelDef): string | null {
  if (panel.instrument.scope) return null
  if (panel.instrument.kind === 'dcSupply') return 'CH1'
  if (panel.instrument.kind === 'acSupply') return 'PHASE'
  if (isMeasurementInstrument(panel.instrument) || panel.instrument.kind === 'funcGen') return 'main'
  return null
}

function readSignature(list: readonly PanelDef[]): string {
  return list
    .map((panel) => {
      const screenId = panelReadingScreen(panel)
      if (!screenId) return `${panel.id}:scope`
      const r = getInstrumentReading(panel.id, screenId)
      return `${panel.id}:${r.status}:${r.text}:${r.unit}`
    })
    .join('|')
}

/**
 * 底栏顶行“统一活跃仪器切换与实时读数条”（T1.9B，DESIGN.md、技术设计 §11）：
 * - 展示活跃集合（已放置台式表 ∪ 项目主电源 ∪ 已接线固定表 ∪ 手动展开的固定表）及 10 Hz 节流读数；
 * - 未接线固定表统一收拢至右侧“+ 其他固定表”下拉按需唤出；
 * - 提供一键“[单表 | 双表]”对比模式切换；切至数据记录/曲线页时仍常驻可见。
 */
export function LiveReadingsBar({ project }: { project?: Project }) {
  const panels = useInstrumentPanels((state) => state.panels)
  const panelIds = useMemo(() => new Set(panels.map((panel) => panel.id)), [panels])
  const primaryId = useInstrumentDock((state) => state.primaryId)
  const secondaryId = useInstrumentDock((state) => state.secondaryId)
  const layoutMode = useInstrumentDock((state) => state.layoutMode)
  const manualExpandedIds = useInstrumentDock((state) => state.manualExpandedIds)

  const wiredKey = useCircuit((state) => {
    const ids: string[] = []
    for (const wire of state.wires) {
      const aDot = wire.a.indexOf('.')
      const bDot = wire.b.indexOf('.')
      const aInst = aDot > 0 ? wire.a.slice(0, aDot) : ''
      const bInst = bDot > 0 ? wire.b.slice(0, bDot) : ''
      if (aInst && panelIds.has(aInst) && !ids.includes(aInst)) ids.push(aInst)
      if (bInst && panelIds.has(bInst) && !ids.includes(bInst)) ids.push(bInst)
    }
    ids.sort()
    return ids.join(',')
  })

  const wiredIds = useMemo(() => new Set(wiredKey ? wiredKey.split(',') : []), [wiredKey])
  const resolved = useMemo(
    () => resolveDockPanels(panels, wiredIds, { primaryId, secondaryId, layoutMode, manualExpandedIds }, project),
    [panels, wiredIds, primaryId, secondaryId, layoutMode, manualExpandedIds, project],
  )
  const { activePanels, inactiveFixedPanels, primaryPanel, secondaryPanel } = resolved

  const [, setSignature] = useState('')

  useEffect(() => {
    if (!activePanels.length) return
    setSignature(readSignature(activePanels))
    return instrumentReadings.subscribeAll(() => {
      const next = readSignature(activePanels)
      setSignature((prev) => (prev === next ? prev : next))
    })
  }, [activePanels])

  if (!panels.length) return null

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden px-1.5 py-0.5">
      <div
        role="toolbar"
        aria-label="活跃仪器与实时读数"
        data-live-readings-bar
        className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {activePanels.map((panel) => {
          const screenId = panelReadingScreen(panel)
          const reading = screenId ? getInstrumentReading(panel.id, screenId) : null
          const warning = reading ? readingIsWarning(reading) : false
          const valueLabel = reading ? `${reading.text}${reading.unit ? ` ${reading.unit}` : ''}` : null
          const isPrimary = primaryPanel?.id === panel.id
          const isSecondary = secondaryPanel?.id === panel.id
          const activeSlot = isPrimary ? 'primary' : isSecondary ? 'secondary' : 'inactive'
          return (
            <Button
              key={panel.id}
              size="xs"
              variant={isPrimary ? 'secondary' : 'outline'}
              aria-pressed={isPrimary || isSecondary}
              data-live-reading-chip={panel.id}
              data-instrument-title={panel.title}
              data-active-slot={activeSlot}
              data-reading-status={reading?.status ?? 'active'}
              data-wired={wiredIds.has(panel.id) ? 'true' : 'false'}
              className={cn(
                'shrink-0 gap-1 px-2 text-xs',
                isPrimary && 'border-primary/50',
                isSecondary && 'border-foreground/30',
                warning && 'border-warning text-warning',
              )}
              onClick={() => {
                taskStore.setState({ bottomTab: 'instruments' })
                instrumentDockStore.getState().selectInstrument(panel.id)
              }}
            >
              <span className={cn(isPrimary ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {panel.title}
              </span>
              {valueLabel && <span className="font-mono tabular-nums">{valueLabel}</span>}
            </Button>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {inactiveFixedPanels.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="xs"
                variant="outline"
                data-other-fixed-trigger
                aria-label="其他固定表"
                className="shrink-0 gap-1 px-2 text-xs"
              >
                <Plus className="size-3" />
                <span>固定表</span>
                <span className="font-mono text-muted-foreground">({inactiveFixedPanels.length})</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {inactiveFixedPanels.map((panel) => (
                <DropdownMenuItem
                  key={panel.id}
                  data-fixed-instrument-item={panel.id}
                  onSelect={() => {
                    taskStore.setState({ bottomTab: 'instruments' })
                    instrumentDockStore.getState().selectInstrument(panel.id, { expandFixed: true })
                  }}
                >
                  {panel.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <fieldset aria-label="仪表视图模式" className="flex shrink-0 items-center gap-0.5 border-l pl-1.5">
          <Button
            size="xs"
            variant={layoutMode === 'single' ? 'secondary' : 'ghost'}
            aria-pressed={layoutMode === 'single'}
            data-dock-mode="single"
            onClick={() => {
              taskStore.setState({ bottomTab: 'instruments' })
              instrumentDockStore.getState().setLayoutMode('single')
            }}
          >
            <Square className="size-3" />
            单表
          </Button>
          <Button
            size="xs"
            variant={layoutMode === 'dual' ? 'secondary' : 'ghost'}
            aria-pressed={layoutMode === 'dual'}
            data-dock-mode="dual"
            disabled={activePanels.length < 2}
            onClick={() => {
              taskStore.setState({ bottomTab: 'instruments' })
              instrumentDockStore.getState().setLayoutMode('dual')
            }}
          >
            <Columns2 className="size-3" />
            双表
          </Button>
        </fieldset>
      </div>
    </div>
  )
}
