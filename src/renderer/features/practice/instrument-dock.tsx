import { ExternalLink, Undo2 } from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useInstrumentPanels, usePoppedPanels } from '@/stores/instrument-panels'
import { focusedInstance, useBenchView } from '@/three/bench-view'
import { InstrumentPanel } from './instrument-panel'
import { usePersistedLayout } from './use-persisted-layout'

// 底栏"仪表"页：正在用的仪表面板并排显示（嵌套可调分栏），可弹出为独立窗口
export function InstrumentDock() {
  const panels = useInstrumentPanels((state) => state.panels)
  const ordered = [
    ...panels.filter((panel) => panel.instrument.mounting === 'desktop'),
    ...panels.filter((panel) => panel.instrument.mounting !== 'desktop'),
  ]
  const popped = usePoppedPanels((s) => s.popped)
  const layout = usePersistedLayout('wb-instruments')
  // Focusing an instrument in 3D points at its 2D panel too (技术设计 §10.3).
  const focused = useBenchView((state) => focusedInstance(state.preset))
  const sections = useRef(new Map<string, HTMLElement>())
  useEffect(() => {
    if (focused) sections.current.get(focused)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focused])
  if (!ordered.length)
    return <p className="p-3 text-muted-foreground">正在加载固定仪表。台式仪表需从仪表柜选取，并由学员连接测量线。</p>
  return (
    <div className="h-full min-h-0 w-full overflow-x-auto overflow-y-hidden">
      <div className="h-full min-h-0">
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 overflow-hidden"
          style={{ minWidth: ordered.length * 224, height: '100%' }}
          {...layout}
        >
          {ordered.map((panel, i) => {
            const isPopped = popped.includes(panel.id)
            return (
              <Fragment key={panel.id}>
                {i > 0 && <ResizableHandle />}
                <ResizablePanel id={panel.id} minSize={224}>
                  <section
                    ref={(element) => {
                      if (element) sections.current.set(panel.id, element)
                      else sections.current.delete(panel.id)
                    }}
                    className={cn('flex h-full flex-col', focused === panel.id && 'ring-2 ring-primary ring-inset')}
                    aria-label={panel.title}
                    data-focused={focused === panel.id}
                  >
                    <header className="flex h-8 items-center justify-between border-b px-3">
                      <h3 className="truncate text-sm font-medium" title={`${panel.title} (${panel.id})`}>
                        {panel.title}
                      </h3>
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
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => window.api.panels.popout(panel.id, panel.title)}
                            >
                              <ExternalLink />
                              <span className="sr-only">弹出 {panel.title}</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>弹出为独立窗口</TooltipContent>
                        </Tooltip>
                      )}
                    </header>
                    {isPopped ? (
                      <p className="p-3 text-muted-foreground">已在独立窗口中显示。关闭该窗口即回到这里。</p>
                    ) : (
                      <ScrollArea className="min-h-0 flex-1">
                        <InstrumentPanel panel={panel} />
                      </ScrollArea>
                    )}
                  </section>
                </ResizablePanel>
              </Fragment>
            )
          })}
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
