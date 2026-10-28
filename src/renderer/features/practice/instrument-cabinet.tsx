import { useDraggable } from '@dnd-kit/react'
import type { Instrument } from '@shared/schema/instrument'
import { GripVertical, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { INSTRUMENT_DRAG_TYPE, useInstrumentPlacement } from './instrument-placement'
import { instrumentCatalog } from './practice-content'
import { circuitStore, useCircuit } from './wiring-state'

function CabinetInstrument({ instrument, disabled }: { instrument: Instrument; disabled: boolean }) {
  const { ref, isDragging } = useDraggable({
    id: `cabinet-${instrument.id}`,
    type: INSTRUMENT_DRAG_TYPE,
    data: { instrumentId: instrument.id },
    disabled,
  })
  return (
    <Button
      ref={ref}
      variant="outline"
      className="h-auto w-full justify-start gap-2 whitespace-normal py-2 text-left"
      aria-label={`拖放 ${instrument.name}`}
      aria-describedby="cabinet-instructions"
      disabled={disabled}
      data-instrument-id={instrument.id}
      data-dragging={isDragging}
    >
      <GripVertical className="shrink-0 text-muted-foreground" />
      <span>{instrument.name}</span>
    </Button>
  )
}

export function InstrumentCabinet() {
  const { allowedInstruments } = useInstrumentPlacement()
  const powered = useCircuit((state) => state.powered)
  const placed = useCircuit((state) => state.placedInstruments)
  const notice = useCircuit((state) => state.notice)
  const available = instrumentCatalog.filter(
    (instrument) => instrument.mounting === 'desktop' && allowedInstruments.includes(instrument.id),
  )
  return (
    <section aria-label="仪表柜" className="space-y-3 p-3" data-placed-count={placed.length}>
      <p id="cabinet-instructions" className="text-xs text-muted-foreground">
        拖动仪表到台面 SLOT_ 安装位，自行连接表笔。固定仪表保留在控制屏，不从柜中选取。
      </p>
      {powered && <p className="text-xs text-warning">请先断电，再放置或移除仪表。</p>}
      <div className="space-y-2">
        {available.map((instrument) => (
          <CabinetInstrument key={instrument.id} instrument={instrument} disabled={powered} />
        ))}
        {!available.length && <p className="text-xs text-muted-foreground">当前任务没有可选的台式仪表。</p>}
      </div>
      {notice && (
        <p role="status" className="text-xs text-warning">
          {notice}
        </p>
      )}
      <div className="border-t pt-3">
        <h3 className="mb-2 text-xs font-medium">台面仪表 · {placed.length}</h3>
        {placed.length ? (
          <ul className="divide-y">
            {placed.map((instrument) => (
              <li
                key={instrument.instanceId}
                className="flex items-center gap-2 py-2"
                data-placed-instrument={instrument.instanceId}
              >
                <div className="min-w-0 flex-1 text-xs">
                  <p>
                    {instrumentCatalog.find((item) => item.id === instrument.instrumentId)?.name ??
                      instrument.instrumentId}
                  </p>
                  <p className="break-words font-mono text-muted-foreground">
                    {instrument.instanceId} · {instrument.slot}
                  </p>
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
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">台面尚未放置仪表。选表不会自动接线。</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">移除仪表会同时移除其外部接线，可用 Ctrl+Z 一并撤销。</p>
      </div>
    </section>
  )
}
