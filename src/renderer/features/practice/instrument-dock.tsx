import { findLearnResourceForBenchTarget } from '@domain/learn/catalog'
import type { Project } from '@shared/schema/project'
import { BookOpen, ExternalLink, Maximize2, Undo2 } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { learnCatalog } from '@/features/learn/learn-content'
import { cn } from '@/lib/utils'
import { instrumentDockStore, resolveDockPanels, useInstrumentDock } from '@/stores/instrument-dock'
import { type PanelDef, useInstrumentPanels, usePoppedPanels } from '@/stores/instrument-panels'
import { focusedInstance, useBenchView } from '@/three/bench-view'
import { InstrumentPanel } from './instrument-panel'
import { useCircuit } from './wiring-state'

function DockPanelCard({
  panel,
  isPopped,
  isFocused,
  isWired,
  slotRole,
}: {
  panel: PanelDef
  isPopped: boolean
  isFocused: boolean
  isWired: boolean
  slotRole: 'primary' | 'secondary'
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const learnResource = findLearnResourceForBenchTarget(learnCatalog, {
    instrumentId: panel.instrument.id,
  })
  const showLearnLink = Boolean(learnResource?.relatedInstruments.includes(panel.instrument.id))
  return (
    <section
      className={cn('flex h-full min-w-0 flex-col overflow-clip', isFocused && 'ring-2 ring-primary ring-inset')}
      aria-label={panel.title}
      data-panel-instance={panel.id}
      data-dock-slot={slotRole}
      data-focused={isFocused}
      data-wired={isWired}
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-1 border-b px-3">
        <h3 className="truncate text-sm font-medium" title={`${panel.title} (${panel.id})`}>
          {panel.title}
        </h3>
        <div className="flex shrink-0 items-center gap-0.5">
          {showLearnLink && learnResource && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() =>
                    navigate(`/learn/${learnResource.id}`, {
                      state: { from: location.pathname },
                    })
                  }
                >
                  <BookOpen />
                  <span className="sr-only">查看 {panel.title} 器件资料</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>查看器件资料</TooltipContent>
            </Tooltip>
          )}
          {!isPopped && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  data-expand-panel={panel.id}
                  onClick={() => instrumentDockStore.getState().setExpandedDialogId(panel.id)}
                >
                  <Maximize2 />
                  <span className="sr-only">放大 {panel.title}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>站内放大</TooltipContent>
            </Tooltip>
          )}
          {isPopped ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" onClick={() => window.api.panels.close(panel.id)}>
                  <Undo2 />
                  <span className="sr-only">收回 {panel.title}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>收回到底栏</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-sm" variant="ghost" onClick={() => window.api.panels.popout(panel.id, panel.title)}>
                  <ExternalLink />
                  <span className="sr-only">弹出 {panel.title}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>弹出为独立窗口</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>
      {isPopped ? (
        <p className="p-3 text-muted-foreground">已在独立窗口中显示。关闭该窗口即回到这里。</p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <InstrumentPanel panel={panel} />
        </ScrollArea>
      )}
    </section>
  )
}

/**
 * 底栏“仪表”主表大视图（T1.9B，DESIGN.md、技术设计 §11）：
 * - 默认单主表 100% 宽度视图，彻底消除横滚条；
 * - 支持一键双表对比模式（最多并排 2 台，shadcn ResizablePanelGroup）；
 * - 支持站内大尺寸 Dialog 放大与独立窗口弹出。
 */
export function InstrumentDock({ project }: { project?: Project }) {
  const panels = useInstrumentPanels((state) => state.panels)
  const panelIds = useMemo(() => new Set(panels.map((panel) => panel.id)), [panels])
  const primaryId = useInstrumentDock((state) => state.primaryId)
  const secondaryId = useInstrumentDock((state) => state.secondaryId)
  const layoutMode = useInstrumentDock((state) => state.layoutMode)
  const manualExpandedIds = useInstrumentDock((state) => state.manualExpandedIds)
  const expandedDialogId = useInstrumentDock((state) => state.expandedDialogId)
  const popped = usePoppedPanels((state) => state.popped)
  const focused = useBenchView((state) => focusedInstance(state.preset))

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

  // 新放置台式仪表自动提升为主表，便于放表后立即调参
  const prevDesktopRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const desktopIds = panels.filter((panel) => panel.instrument.mounting === 'desktop').map((panel) => panel.id)
    const added = desktopIds.filter((id) => !prevDesktopRef.current.has(id))
    prevDesktopRef.current = new Set(desktopIds)
    const latest = added.at(-1)
    if (latest) instrumentDockStore.getState().selectInstrument(latest)
  }, [panels])

  const wiredIds = useMemo(() => new Set(wiredKey ? wiredKey.split(',') : []), [wiredKey])
  const resolved = useMemo(
    () => resolveDockPanels(panels, wiredIds, { primaryId, secondaryId, layoutMode, manualExpandedIds }, project),
    [panels, wiredIds, primaryId, secondaryId, layoutMode, manualExpandedIds, project],
  )
  const { displayedPanels, activePanels, inactiveFixedPanels } = resolved
  const expandedPanel = expandedDialogId ? (panels.find((panel) => panel.id === expandedDialogId) ?? null) : null

  useEffect(() => {
    if (expandedDialogId && (!expandedPanel || popped.includes(expandedDialogId))) {
      instrumentDockStore.getState().setExpandedDialogId(null)
    }
  }, [expandedDialogId, expandedPanel, popped])

  if (!displayedPanels.length) {
    return <p className="p-3 text-muted-foreground">正在加载固定仪表。台式仪表需从仪表柜选取，并由学员连接测量线。</p>
  }

  const singlePanel = displayedPanels.length === 1 ? displayedPanels[0] : null

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-instrument-dock
      data-dock-layout={displayedPanels.length > 1 ? 'dual' : 'single'}
      data-active-instrument-count={activePanels.length}
      data-hidden-fixed-count={inactiveFixedPanels.length}
    >
      {singlePanel ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DockPanelCard
            panel={singlePanel}
            isPopped={popped.includes(singlePanel.id)}
            isFocused={focused === singlePanel.id}
            isWired={wiredIds.has(singlePanel.id)}
            slotRole="primary"
          />
        </div>
      ) : (
        <ResizablePanelGroup
          key={displayedPanels.map((panel) => panel.id).join(',')}
          orientation="horizontal"
          className="min-h-0 flex-1 overflow-hidden"
        >
          {displayedPanels.map((panel, index) => (
            <Fragment key={panel.id}>
              {index > 0 && <ResizableHandle />}
              <ResizablePanel id={panel.id} minSize={240} defaultSize={panel.instrument.scope ? '58' : '50'}>
                <DockPanelCard
                  panel={panel}
                  isPopped={popped.includes(panel.id)}
                  isFocused={focused === panel.id}
                  isWired={wiredIds.has(panel.id)}
                  slotRole={index === 0 ? 'primary' : 'secondary'}
                />
              </ResizablePanel>
            </Fragment>
          ))}
        </ResizablePanelGroup>
      )}
      <Dialog
        open={Boolean(expandedPanel)}
        onOpenChange={(open) => {
          if (!open) instrumentDockStore.getState().setExpandedDialogId(null)
        }}
      >
        {expandedPanel && (
          <DialogContent
            className="instrument-enlarged-dialog flex flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
            data-enlarged-instrument-dialog={expandedPanel.id}
          >
            <DialogHeader className="flex-row items-center justify-between gap-2 border-b px-4 py-3 pr-12">
              <div className="min-w-0">
                <DialogTitle className="truncate">{expandedPanel.title}</DialogTitle>
                <DialogDescription className="sr-only">{expandedPanel.title} 站内放大面板</DialogDescription>
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const { id, title } = expandedPanel
                  instrumentDockStore.getState().setExpandedDialogId(null)
                  void window.api.panels.popout(id, title)
                }}
              >
                <ExternalLink className="size-3.5" />
                弹出独立窗口
              </Button>
            </DialogHeader>
            <ScrollArea className="min-h-0 flex-1">
              <InstrumentPanel panel={expandedPanel} className="p-4" />
            </ScrollArea>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
