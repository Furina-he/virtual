import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import voltmeterData from '../../../content/instruments/ins-dc-voltmeter/instrument.json'
import { Instrument } from '../../shared/schema/instrument'
import type { InstrumentPanelSnapshot } from './instrument-panels'

function setupBridge() {
  const updates = new Set<(message: { key: string; state: unknown }) => void>()
  const opened = new Set<(id: string) => void>()
  const closed = new Set<(id: string) => void>()
  const api = {
    sync: {
      get: vi.fn(async () => undefined),
      publish: vi.fn(),
      onUpdate: (listener: (message: { key: string; state: unknown }) => void) => {
        updates.add(listener)
        return () => updates.delete(listener)
      },
    },
    panels: {
      list: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      onOpened: (listener: (id: string) => void) => {
        opened.add(listener)
        return () => opened.delete(listener)
      },
      onClosed: (listener: (id: string) => void) => {
        closed.add(listener)
        return () => closed.delete(listener)
      },
    },
  }
  vi.stubGlobal('window', { api })
  return {
    api,
    update: (key: string, state: unknown) => {
      for (const listener of updates) listener({ key, state })
    },
    open: (id: string) => {
      for (const listener of opened) listener(id)
    },
  }
}

function snapshot(range = 'r20'): InstrumentPanelSnapshot {
  const instrument = Instrument.parse(voltmeterData)
  return {
    powered: false,
    panels: [{ id: 'fixed-meter', title: instrument.name, instrument, settings: { range } }],
  }
}

describe('instrument panel authority bridge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(async () => {
    const { instrumentReadings } = await import('../lib/instrument-readings')
    instrumentReadings.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('commits only the circuit snapshot, not an optimistic second settings state', async () => {
    const ipc = setupBridge()
    const { connectInstrumentPanels, useInstrumentPanels } = await import('./instrument-panels')
    let state = snapshot()
    let refresh: () => void = () => undefined
    const write = vi.fn()
    const disconnect = connectInstrumentPanels({
      getSnapshot: () => state,
      subscribe: (listener) => {
        refresh = listener
        return vi.fn()
      },
      setSettings: write,
    })
    useInstrumentPanels.getState().setSettings('fixed-meter', { range: 'r2' })
    expect(write).toHaveBeenCalledWith('fixed-meter', { range: 'r2' })
    expect(useInstrumentPanels.getState().panels[0]?.settings.range).toBe('r20')
    state = snapshot('r2')
    refresh()
    expect(useInstrumentPanels.getState().panels[0]?.settings.range).toBe('r2')
    expect(ipc.api.sync.publish.mock.calls.every(([key]) => key !== 'instrument-panel-request-v2')).toBe(true)
    disconnect()
  })

  it('routes popout requests to the main authority and ignores unknown instances', async () => {
    const ipc = setupBridge()
    const { connectInstrumentPanels } = await import('./instrument-panels')
    const write = vi.fn()
    const disconnect = connectInstrumentPanels({ getSnapshot: snapshot, subscribe: () => vi.fn(), setSettings: write })
    ipc.update('instrument-panel-request-v2', { panelId: 'fixed-meter', patch: { range: 'r2' } })
    expect(write).toHaveBeenCalledExactlyOnceWith('fixed-meter', { range: 'r2' })
    ipc.update('instrument-panel-request-v2', { panelId: 'removed-meter', patch: { range: 'r2' } })
    ipc.update('instrument-panel-request-v2', { panelId: 'fixed-meter', patch: [] })
    expect(write).toHaveBeenCalledTimes(1)
    disconnect()
  })

  it('receives readings in a popout without updating the React settings store', async () => {
    const ipc = setupBridge()
    const { useInstrumentPanels } = await import('./instrument-panels')
    const { instrumentReadings } = await import('../lib/instrument-readings')
    ipc.update('instrument-panels-v2', snapshot())
    useInstrumentPanels.getState().setSettings('fixed-meter', { range: 'r2' })
    expect(ipc.api.sync.publish).toHaveBeenCalledWith('instrument-panel-request-v2', {
      panelId: 'fixed-meter',
      patch: { range: 'r2' },
    })
    expect(useInstrumentPanels.getState().panels[0]?.settings.range).toBe('r20')
    const render = vi.fn()
    const unsubscribe = useInstrumentPanels.subscribe(render)
    ipc.update('instrument-readings-v1', { 'fixed-meter': { main: { text: '-1.23', unit: 'V', status: 'ok' } } })
    vi.advanceTimersByTime(100)
    expect(instrumentReadings.get('fixed-meter').text).toBe('-1.23')
    expect(render).not.toHaveBeenCalled()
    ipc.update('instrument-panels-v2', snapshot('r2'))
    expect(useInstrumentPanels.getState().panels[0]?.settings.range).toBe('r2')
    expect(render).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('coalesces reading IPC and closes a popped instrument when it leaves the bench', async () => {
    const ipc = setupBridge()
    const { connectInstrumentPanels } = await import('./instrument-panels')
    const { instrumentReadings } = await import('../lib/instrument-readings')
    let state = snapshot()
    let refresh: () => void = () => undefined
    const disconnect = connectInstrumentPanels({
      getSnapshot: () => state,
      subscribe: (listener) => {
        refresh = listener
        return vi.fn()
      },
      setSettings: vi.fn(),
    })
    ipc.open('fixed-meter')
    ipc.api.sync.publish.mockClear()
    for (let sample = 0; sample < 100; sample++)
      instrumentReadings.set('fixed-meter', { text: String(sample), unit: 'V', status: 'ok' })
    vi.advanceTimersByTime(100)
    expect(ipc.api.sync.publish).toHaveBeenCalledExactlyOnceWith('instrument-readings-v1', {
      'fixed-meter': { main: { text: '99', unit: 'V', status: 'ok' } },
    })
    state = { panels: [], powered: false }
    refresh()
    expect(ipc.api.panels.close).toHaveBeenCalledWith('fixed-meter')
    disconnect()
  })
})
