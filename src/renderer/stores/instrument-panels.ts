import type { Instrument } from '@shared/schema/instrument'
import { create } from 'zustand'
import { type InstrumentReadingsSnapshot, instrumentReadings } from '../lib/instrument-readings'

export type PanelDef = {
  id: string
  title: string
  instrument: Instrument
  settings: Record<string, unknown>
}

export type InstrumentPanelSnapshot = { panels: PanelDef[]; powered: boolean }
type InstrumentPanelBridge = {
  getSnapshot: () => InstrumentPanelSnapshot
  subscribe: (listener: () => void) => () => void
  setSettings: (instanceId: string, patch: Record<string, unknown>) => void
}

const SNAPSHOT_KEY = 'instrument-panels-v2'
const REQUEST_KEY = 'instrument-panel-request-v2'
const READINGS_KEY = 'instrument-readings-v1'
let authority: InstrumentPanelBridge | undefined

type InstrumentPanelsState = InstrumentPanelSnapshot & {
  setSettings: (panelId: string, patch: Record<string, unknown>) => void
}

// This store is a low-frequency view of circuit state, never a second settings authority.
export const useInstrumentPanels = create<InstrumentPanelsState>()(() => ({
  panels: [],
  powered: false,
  setSettings: (panelId, patch) => {
    if (authority) authority.setSettings(panelId, patch)
    else window.api.sync.publish(REQUEST_KEY, { panelId, patch })
  },
}))

type PoppedState = { popped: string[] }
export const usePoppedPanels = create<PoppedState>()(() => ({ popped: [] }))

function publishReadings() {
  if (authority && usePoppedPanels.getState().popped.length)
    window.api.sync.publish(READINGS_KEY, instrumentReadings.snapshot())
}

/** Bind only in the main workbench; popouts send requests and receive committed snapshots. */
export function connectInstrumentPanels(bridge: InstrumentPanelBridge): () => void {
  authority = bridge
  let previous = ''
  const refresh = () => {
    const snapshot = bridge.getSnapshot()
    const serialized = JSON.stringify(snapshot)
    if (serialized === previous) return
    previous = serialized
    useInstrumentPanels.setState(snapshot)
    window.api.sync.publish(SNAPSHOT_KEY, snapshot)
    const ids = new Set(snapshot.panels.map((panel) => panel.id))
    for (const id of usePoppedPanels.getState().popped) if (!ids.has(id)) void window.api.panels.close(id)
  }
  refresh()
  const offCircuit = bridge.subscribe(refresh)
  const offReadings = instrumentReadings.subscribeAll(publishReadings)
  const offPopped = usePoppedPanels.subscribe(publishReadings)
  publishReadings()
  return () => {
    offCircuit()
    offReadings()
    offPopped()
    if (authority === bridge) authority = undefined
  }
}

let snapshotRevision = 0
let readingRevision = 0
window.api.sync.onUpdate((message) => {
  if (message.key === SNAPSHOT_KEY && !authority) {
    snapshotRevision++
    useInstrumentPanels.setState(message.state as InstrumentPanelSnapshot)
  }
  if (message.key === READINGS_KEY && !authority) {
    readingRevision++
    instrumentReadings.replace(message.state as InstrumentReadingsSnapshot)
  }
  if (message.key === REQUEST_KEY && authority) {
    const request = message.state as { panelId?: unknown; patch?: unknown } | null
    if (
      request &&
      typeof request.panelId === 'string' &&
      request.patch &&
      typeof request.patch === 'object' &&
      !Array.isArray(request.patch) &&
      useInstrumentPanels.getState().panels.some((panel) => panel.id === request.panelId)
    ) {
      authority.setSettings(request.panelId, request.patch as Record<string, unknown>)
    }
  }
})
void window.api.sync.get(SNAPSHOT_KEY).then((cached) => {
  if (cached !== undefined && !authority && snapshotRevision === 0)
    useInstrumentPanels.setState(cached as InstrumentPanelSnapshot)
})
void window.api.sync.get(READINGS_KEY).then((cached) => {
  if (cached !== undefined && !authority && readingRevision === 0)
    instrumentReadings.replace(cached as InstrumentReadingsSnapshot)
})

void window.api.panels.list().then((popped) => usePoppedPanels.setState({ popped }))
window.api.panels.onOpened((id) =>
  usePoppedPanels.setState((state) => ({ popped: state.popped.includes(id) ? state.popped : [...state.popped, id] })),
)
window.api.panels.onClosed((id) =>
  usePoppedPanels.setState((state) => ({ popped: state.popped.filter((panel) => panel !== id) })),
)
