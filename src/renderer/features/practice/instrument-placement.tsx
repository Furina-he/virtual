import { DragDropProvider, type DragEndEvent, DragOverlay, useDragDropManager } from '@dnd-kit/react'
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { POWERED_INSTRUMENT_NOTICE } from '../../stores/circuit'
import { instrumentCatalog } from './practice-content'
import { fixedPlacements, previewInstruments } from './wiring-context'
import { circuitStore, useCircuit } from './wiring-state'

export const INSTRUMENT_DRAG_TYPE = 'desktop-instrument'
export const BENCH_DROP_ID = 'instrument-bench'
export type SlotPicker = (point: { x: number; y: number }) => string | null

const dragStore = createStore<{ instrumentId: string | null }>(() => ({ instrumentId: null }))
const defaultAllowed = instrumentCatalog
  .filter((instrument) => instrument.mounting === 'desktop')
  .map((instrument) => instrument.id)
const PlacementContext = createContext<{
  picker: RefObject<SlotPicker | null>
  allowedInstruments: readonly string[]
} | null>(null)

export function useInstrumentPlacement() {
  const context = useContext(PlacementContext)
  if (!context) throw new Error('Instrument placement requires InstrumentPlacementProvider')
  return context
}

export function useDraggingInstrument() {
  return useStore(dragStore, (state) => state.instrumentId)
}

function nextInstanceId(instrumentId: string): string {
  const preview = previewInstruments.find((instrument) => instrument.instrumentId === instrumentId)
  const prefix = preview?.instanceId.replace(/\d+$/, '') ?? instrumentId
  const history = circuitStore.temporal.getState()
  const used = new Set([
    ...fixedPlacements.map((placement) => placement.instanceId),
    ...[circuitStore.getState(), ...history.pastStates, ...history.futureStates].flatMap((state) =>
      (state.placedInstruments ?? []).map((instrument) => instrument.instanceId),
    ),
  ])
  let index = 1
  while (used.has(`${prefix}${index}`)) index++
  return `${prefix}${index}`
}

function PlacementDragLifetime() {
  const manager = useDragDropManager()
  const powered = useCircuit((state) => state.powered)
  useEffect(() => {
    const cancel = () => {
      if (dragStore.getState().instrumentId) manager?.actions.stop({ canceled: true })
      dragStore.setState({ instrumentId: null })
    }
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [manager])
  useEffect(() => {
    if (powered && dragStore.getState().instrumentId) {
      manager?.actions.stop({ canceled: true })
      circuitStore.setState({ notice: POWERED_INSTRUMENT_NOTICE })
    }
  }, [manager, powered])
  return null
}

export function InstrumentPlacementProvider({
  children,
  allowedInstruments = defaultAllowed,
}: {
  children: ReactNode
  allowedInstruments?: readonly string[]
}) {
  const picker = useRef<SlotPicker | null>(null)
  const context = useMemo(() => ({ picker, allowedInstruments }), [allowedInstruments])
  const end = (event: DragEndEvent) => {
    dragStore.setState({ instrumentId: null })
    if (event.canceled) return
    const instrumentId = event.operation.source?.data.instrumentId
    const instrument = instrumentCatalog.find((candidate) => candidate.id === instrumentId)
    if (instrument?.mounting !== 'desktop' || !allowedInstruments.includes(instrument.id)) return
    if (circuitStore.getState().powered) {
      circuitStore.setState({ notice: POWERED_INSTRUMENT_NOTICE })
      return
    }
    if (event.operation.target?.id !== BENCH_DROP_ID) {
      circuitStore.setState({ notice: '未放置仪表。请拖到台面上的安装位后松开。' })
      return
    }
    const native = event.nativeEvent
    const point =
      native instanceof MouseEvent ? { x: native.clientX, y: native.clientY } : event.operation.position.current
    const slot = picker.current?.(point)
    if (!slot) {
      circuitStore.setState({ notice: '未命中可见的台面安装位。请在 SLOT_ 标记内松开，必要时切换俯视。' })
      return
    }
    circuitStore
      .getState()
      .placeInstrument({ instanceId: nextInstanceId(instrument.id), instrumentId: instrument.id, slot, settings: {} })
  }
  return (
    <PlacementContext value={context}>
      <DragDropProvider
        onBeforeDragStart={(event) => {
          if (circuitStore.getState().powered) {
            event.preventDefault()
            circuitStore.setState({ notice: POWERED_INSTRUMENT_NOTICE })
          }
        }}
        onDragStart={(event) => {
          circuitStore.getState().cancelConnection()
          const id = event.operation.source?.data.instrumentId
          dragStore.setState({ instrumentId: typeof id === 'string' ? id : null })
        }}
        onDragEnd={end}
      >
        <PlacementDragLifetime />
        {children}
        <DragOverlay
          dropAnimation={null}
          className="pointer-events-none rounded-md border bg-background px-3 py-2 text-sm shadow-sm"
        >
          {(source) =>
            instrumentCatalog.find((instrument) => instrument.id === source.data.instrumentId)?.name ?? '仪表'
          }
        </DragOverlay>
      </DragDropProvider>
    </PlacementContext>
  )
}
