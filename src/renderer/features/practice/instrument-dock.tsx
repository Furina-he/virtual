import { ExternalLink, Undo2 } from 'lucide-react'
import { Fragment } from 'react'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useInstrumentPanels, usePoppedPanels } from '@/stores/instrument-panels'
import { InstrumentPanel } from './instrument-panel'
import { usePersistedLayout } from './use-persisted-layout'

// 底栏"仪表"页：正在用的仪表面板并排显示（嵌套可调分栏），可弹出为独立窗口
export function InstrumentDock() {
  const panels = useInstrumentPanels((state) => state.panels)
  const popped = usePoppedPanels((s) => s.popped)
  const layout = usePersistedLayout('wb-instruments')
  if (!panels.length)
    return <p className="p-3 text-muted-foreground">正在加载固定仪表。台式仪表需从仪表柜选取，并由学员连接测量线。</p>
  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      <div className="h-full min-h-0">
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 overflow-hidden"
          style={{ minWidth: panels.length * 224, height: '100%' }}
          {...layout}
        >
          {panels.map((panel, i) => {
            const isPopped = popped.includes(panel.id)
            return (
              <Fragment key={panel.id}>
                {i > 0 && <ResizableHandle />}
                <ResizablePanel id={panel.id} minSize={224}>
                  <section className="flex h-full flex-col" aria-label={panel.title}>
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
