import { useDraggable } from '@dnd-kit/react'
import type { Instrument } from '@shared/schema/instrument'
import { ChevronDown, ChevronRight, GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { INSTRUMENT_DRAG_TYPE, useInstrumentPlacement } from './instrument-placement'
import { instrumentCatalog } from './practice-content'
import { circuitStore, placeInstrumentInFirstSlot, slotDisplayName, useCircuit } from './wiring-state'

function CabinetInstrument({ instrument, disabled }: { instrument: Instrument; disabled: boolean }) {
  const { ref, isDragging } = useDraggable({
    id: `cabinet-${instrument.id}`,
    type: INSTRUMENT_DRAG_TYPE,
    data: { instrumentId: instrument.id },
    disabled,
  })
  return (
    <div className="flex items-stretch gap-1">
      <Button
        ref={ref}
        variant="outline"
        className="h-auto min-w-0 flex-1 justify-start gap-2 whitespace-normal py-2 text-left"
        aria-label={`拖放 ${instrument.name}`}
        aria-describedby="cabinet-instructions"
        disabled={disabled}
        data-instrument-id={instrument.id}
        data-dragging={isDragging}
      >
        <GripVertical className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{instrument.name}</span>
      </Button>
      <Button
        size="sm"
        variant="secondary"
        className="h-auto shrink-0 px-2"
        aria-label={`放置 ${instrument.name}`}
        title={`一键放置 ${instrument.name} 到首个空闲台面安装位`}
        onClick={() => placeInstrumentInFirstSlot(instrument.id)}
      >
        <Plus />
        上台
      </Button>
    </div>
  )
}

export function InstrumentCabinet({
  collapsed = false,
  onToggleCollapse,
}: {
  collapsed?: boolean
  onToggleCollapse?: (collapsed: boolean) => void
}) {
  const { allowedInstruments } = useInstrumentPlacement()
  const powered = useCircuit((state) => state.powered)
  const placed = useCircuit((state) => state.placedInstruments)
  const available = instrumentCatalog.filter(
    (instrument) => instrument.mounting === 'desktop' && allowedInstruments.includes(instrument.id),
  )
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => onToggleCollapse?.(!open)}
      className="flex h-full min-h-0 flex-col"
    >
      <section
        aria-label="仪表柜"
        className="flex h-full min-h-0 flex-col"
        data-placed-count={placed.length}
        data-cabinet-collapsed={collapsed ? 'true' : 'false'}
      >
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b px-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-sm font-medium">仪表柜</h2>
            <span className="font-mono text-xs text-muted-foreground">已放 {placed.length} 台</span>
          </div>
          {onToggleCollapse && (
            <CollapsibleTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={collapsed ? '展开仪表柜' : '收起仪表柜'}
                title={collapsed ? '展开仪表柜' : '收起仪表柜为单行摘要'}
              >
                {collapsed ? <ChevronRight /> : <ChevronDown />}
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        <CollapsibleContent className="min-h-0 flex-1 overflow-auto">
          <div className="space-y-3 p-3">
            <p id="cabinet-instructions" className="text-xs text-muted-foreground">
              拖动仪表到台面安装位或点击“上台”自动入位，并自行连接表笔。固定仪表保留在控制屏。
            </p>
            {powered && <p className="text-xs text-warning">请先断电，再放置或移除仪表。</p>}
            <div className="space-y-2">
              {available.map((instrument) => (
                <CabinetInstrument key={instrument.id} instrument={instrument} disabled={powered} />
              ))}
              {!available.length && <p className="text-xs text-muted-foreground">当前任务没有可选的台式仪表。</p>}
            </div>
            <div className="border-t pt-3">
              <h3 className="mb-2 text-xs font-medium">台面仪表 · {placed.length}</h3>
              {placed.length ? (
                <ul className="divide-y">
                  {placed.map((instrument) => {
                    const displayName =
                      instrumentCatalog.find((item) => item.id === instrument.instrumentId)?.name ??
                      instrument.instrumentId
                    const slotLabel = slotDisplayName(instrument.slot)
                    return (
                      <li
                        key={instrument.instanceId}
                        className="flex items-center gap-2 py-2"
                        data-placed-instrument={instrument.instanceId}
                        data-instance-id={instrument.instanceId}
                        data-slot-id={instrument.slot}
                        title={`${displayName} · ${slotLabel}（${instrument.slot} / ${instrument.instanceId}）`}
                      >
                        <div className="min-w-0 flex-1 text-xs">
                          <p className="truncate">{displayName}</p>
                          <p className="truncate text-muted-foreground">{slotLabel}</p>
                        </div>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`移除 ${instrument.instanceId}`}
                          disabled={powered}
                          onClick={() => circuitStore.getState().removeInstrument(instrument.instanceId)}
                        >
                          <Trash2 />
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">台面尚未放置仪表。选表不会自动接线。</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">移除仪表会同时移除其外部接线，可用 Ctrl+Z 一并撤销。</p>
            </div>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
