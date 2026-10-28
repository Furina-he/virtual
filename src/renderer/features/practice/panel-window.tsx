import { useParams } from 'react-router'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useInstrumentPanels } from '@/stores/instrument-panels'
import { InstrumentPanel } from './instrument-panel'

// 弹出窗口中的单个仪表面板（ADR-007）
export function PanelWindow() {
  const { panelId } = useParams()
  const panel = useInstrumentPanels((state) => state.panels.find((item) => item.id === panelId))
  if (!panel) return <p className="p-3 text-muted-foreground">没有找到这个仪表面板。</p>
  return (
    <main className="flex h-screen flex-col">
      <h1 className="flex h-8 items-center border-b px-3 text-sm font-medium">{panel.title}</h1>
      <ScrollArea className="min-h-0 flex-1">
        <InstrumentPanel panel={panel} />
      </ScrollArea>
    </main>
  )
}
