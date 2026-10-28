import { temporal } from 'zundo'
import { createStore } from 'zustand/vanilla'
import { CircuitState, PlacedInstrument, Wire, WireColor } from '../../shared/schema/circuit.ts'
import { JackRef } from '../../shared/schema/common.ts'

export const DEFAULT_WIRE_SLACK = 0.12
export const POWERED_WIRING_NOTICE = '当前已上电，请先断电再修改接线。'
export const POWERED_INSTRUMENT_NOTICE = '当前已上电，请先断电再放置或移除仪表。'

export type WirePatch = Partial<Pick<Wire, 'color' | 'label' | 'slack'>>
export type CircuitHistoryState = Pick<CircuitState, 'wires' | 'placedInstruments' | 'controlValues'>
export type InstrumentPlacement = CircuitState['placedInstruments'][number]
export type CircuitPlacementDefinition = {
  instrumentId: string
  jacks: readonly string[]
  slots: readonly string[]
}
export type CircuitStoreOptions = {
  instruments?: readonly CircuitPlacementDefinition[]
  reservedInstanceIds?: readonly string[]
  placementProblem?: (instrument: InstrumentPlacement, placed: readonly InstrumentPlacement[]) => string | null
}
export type CircuitEditorState = CircuitState & {
  selectedWireId: string | null
  wireColor: WireColor
  pendingJack: string | null
  notice: string | null
  addWire: (a: string, b: string, color?: WireColor, slack?: number) => boolean
  deleteWire: (id: string) => boolean
  clearWires: () => boolean
  updateWire: (id: string, patch: WirePatch) => boolean
  selectWire: (id: string | null) => boolean
  setWireColor: (color: WireColor) => boolean
  setPendingJack: (ref: string | null) => boolean
  cancelConnection: () => boolean
  togglePower: () => boolean
  placeInstrument: (instrument: InstrumentPlacement) => boolean
  removeInstrument: (instanceId: string) => boolean
  setInstrumentSettings: (instanceId: string, patch: Record<string, unknown>) => boolean
  setControlValue: (id: string, value: number) => boolean
  setControlValues: (patch: Record<string, number>) => boolean
  undo: () => boolean
  redo: () => boolean
}

function sameEndpoints(wire: Wire, a: string, b: string): boolean {
  return (wire.a === a && wire.b === b) || (wire.a === b && wire.b === a)
}

function historyState(state: CircuitEditorState): CircuitHistoryState {
  return {
    wires: state.wires,
    placedInstruments: state.placedInstruments,
    controlValues: state.controlValues,
  }
}

export function createCircuitStore(
  jackRefs: readonly string[],
  initial?: Partial<CircuitState>,
  options: CircuitStoreOptions = {},
) {
  const fixedJacks = new Set(jackRefs.map((ref) => JackRef.parse(ref)))
  const definitions = new Map(options.instruments?.map((instrument) => [instrument.instrumentId, instrument]))
  const reservedIds = new Set([...jackRefs.map((ref) => ref.split('.')[0]), ...(options.reservedInstanceIds ?? [])])
  const initialState = CircuitState.parse(
    structuredClone({ wires: [], placedInstruments: [], controlValues: {}, powered: false, ...initial }),
  )
  // Derive endpoints from the current history snapshot, never a mutable registration cache.
  function knownJacks(state: Pick<CircuitState, 'placedInstruments'>): Set<string> {
    const refs = new Set(fixedJacks)
    for (const instrument of state.placedInstruments) {
      for (const id of definitions.get(instrument.instrumentId)?.jacks ?? []) {
        refs.add(JackRef.parse(`${instrument.instanceId}.${id}`))
      }
    }
    return refs
  }
  const initialJacks = knownJacks(initialState)
  for (const [index, wire] of initialState.wires.entries()) {
    if (!initialJacks.has(wire.a) || !initialJacks.has(wire.b)) {
      throw new Error(`Initial wire ${wire.id} refers to an unknown jack`)
    }
    if (
      initialState.wires.slice(0, index).some((other) => other.id === wire.id || sameEndpoints(other, wire.a, wire.b))
    ) {
      throw new Error(`Initial wire ${wire.id} duplicates a wire id or endpoint pair`)
    }
  }

  function reject(notice: string): false {
    store.setState({ notice })
    return false
  }

  function editable(): boolean {
    return !store.getState().powered || reject(POWERED_WIRING_NOTICE)
  }

  function instrumentEditable(): boolean {
    return !store.getState().powered || reject(POWERED_INSTRUMENT_NOTICE)
  }

  function validSettings(settings: Record<string, unknown>): boolean {
    return Object.values(settings).every(
      (value) =>
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)),
    )
  }

  function setControlValues(patch: Record<string, number>): boolean {
    if (Object.entries(patch).some(([id, value]) => !id || !Number.isFinite(value))) {
      return reject('仪表设置无效，请输入有限数值。')
    }
    const state = store.getState()
    if (Object.entries(patch).every(([id, value]) => state.controlValues[id] === value)) return false
    store.setState({ controlValues: { ...state.controlValues, ...patch }, pendingJack: null, notice: null })
    return true
  }

  function moveHistory(direction: 'undo' | 'redo', steps = 1): boolean {
    if (!editable()) return false
    if (!Number.isSafeInteger(steps) || steps < 1) return false
    const history = store.temporal.getState()
    const available = direction === 'undo' ? history.pastStates.length : history.futureStates.length
    if (!available) return false
    originalHistory[direction](Math.min(available, steps))
    const state = store.getState()
    store.setState({
      selectedWireId: state.wires.some((wire) => wire.id === state.selectedWireId) ? state.selectedWireId : null,
      pendingJack: null,
      notice: null,
    })
    return true
  }

  const store = createStore<CircuitEditorState>()(
    temporal(
      (set, get) => ({
        ...initialState,
        selectedWireId: null,
        wireColor: 'red',
        pendingJack: null,
        notice: null,
        addWire: (a, b, color, slack = DEFAULT_WIRE_SLACK) => {
          if (!editable()) return false
          const refs = knownJacks(get())
          if (!refs.has(a) || !refs.has(b)) return reject('插孔不存在，请选择台面上的插孔。')
          if (a === b) return reject('导线两端不能是同一插孔。')
          const state = get()
          if (state.wires.some((wire) => sameEndpoints(wire, a, b))) return reject('这两个插孔之间已有导线。')
          const result = Wire.safeParse({ id: crypto.randomUUID(), a, b, color: color ?? state.wireColor, slack })
          if (!result.success) return reject('导线颜色或走线参数无效。')
          set({
            wires: [...state.wires, result.data],
            selectedWireId: result.data.id,
            pendingJack: null,
            notice: null,
          })
          return true
        },
        deleteWire: (id) => {
          if (!editable()) return false
          const state = get()
          if (!state.wires.some((wire) => wire.id === id)) return false
          set({
            wires: state.wires.filter((wire) => wire.id !== id),
            selectedWireId: state.selectedWireId === id ? null : state.selectedWireId,
            pendingJack: null,
            notice: null,
          })
          return true
        },
        clearWires: () => {
          if (!editable()) return false
          if (get().wires.length === 0) return false
          set({ wires: [], selectedWireId: null, pendingJack: null, notice: null })
          return true
        },
        updateWire: (id, patch) => {
          if (!editable()) return false
          const state = get()
          const wire = state.wires.find((entry) => entry.id === id)
          if (!wire) return reject('未找到该导线。')
          const next = { ...wire }
          if (patch.color !== undefined) next.color = patch.color
          if (patch.slack !== undefined) next.slack = patch.slack
          if (Object.hasOwn(patch, 'label')) {
            if (patch.label === '' || patch.label === undefined) delete next.label
            else next.label = patch.label
          }
          if (next.label !== undefined && next.label.length > 48) return reject('导线标签不能超过 48 个字符。')
          const result = Wire.safeParse(next)
          if (!result.success) return reject('导线颜色、标签或走线参数无效。')
          if (
            next.color === wire.color &&
            next.label === wire.label &&
            (next.slack ?? DEFAULT_WIRE_SLACK) === (wire.slack ?? DEFAULT_WIRE_SLACK)
          ) {
            return false
          }
          set({ wires: state.wires.map((entry) => (entry.id === id ? result.data : entry)), notice: null })
          return true
        },
        selectWire: (id) => {
          if (id !== null && !get().wires.some((wire) => wire.id === id)) return reject('未找到该导线。')
          if (get().selectedWireId === id) return false
          set({ selectedWireId: id, notice: null })
          return true
        },
        setWireColor: (color) => {
          if (!WireColor.safeParse(color).success) return reject('请选择有效的导线颜色。')
          if (get().wireColor === color) return false
          set({ wireColor: color, notice: null })
          return true
        },
        setPendingJack: (ref) => {
          if (ref !== null) {
            if (!editable()) return false
            if (!knownJacks(get()).has(ref)) return reject('插孔不存在，请选择台面上的插孔。')
          }
          if (get().pendingJack === ref) return false
          set({ pendingJack: ref, notice: null })
          return true
        },
        cancelConnection: () => {
          if (get().pendingJack === null) return false
          set({ pendingJack: null, notice: null })
          return true
        },
        togglePower: () => {
          set({ powered: !get().powered, pendingJack: null, notice: null })
          return true
        },
        placeInstrument: (instrument) => {
          if (!instrumentEditable()) return false
          const result = PlacedInstrument.safeParse(instrument)
          if (!result.success || !validSettings(result.data.settings)) return reject('仪表放置参数无效。')
          const next = result.data
          const definition = definitions.get(next.instrumentId)
          if (!definition) return reject('该仪表尚无可用配置，不能从仪表柜放置。')
          if (!definition.slots.includes(next.slot)) return reject('该安装位不能放置这台仪表。')
          const state = get()
          if (
            reservedIds.has(next.instanceId) ||
            state.placedInstruments.some((item) => item.instanceId === next.instanceId)
          ) {
            return reject('仪表实例编号已占用。')
          }
          if (state.placedInstruments.some((item) => item.slot === next.slot)) return reject('该安装位已有仪表。')
          const problem = options.placementProblem?.(next, state.placedInstruments)
          if (problem) return reject(problem)
          set({ placedInstruments: [...state.placedInstruments, next], pendingJack: null, notice: null })
          return true
        },
        removeInstrument: (instanceId) => {
          if (!instrumentEditable()) return false
          const state = get()
          if (!state.placedInstruments.some((item) => item.instanceId === instanceId))
            return reject('只能移除台面上的台式仪表。')
          const prefix = `${instanceId}.`
          const wires = state.wires.filter((wire) => !wire.a.startsWith(prefix) && !wire.b.startsWith(prefix))
          set({
            placedInstruments: state.placedInstruments.filter((item) => item.instanceId !== instanceId),
            wires,
            selectedWireId: wires.some((wire) => wire.id === state.selectedWireId) ? state.selectedWireId : null,
            pendingJack: null,
            notice: null,
          })
          return true
        },
        setInstrumentSettings: (instanceId, patch) => {
          if (!validSettings(patch)) return reject('仪表设置无效，请检查档位和参数。')
          const state = get()
          const instrument = state.placedInstruments.find((item) => item.instanceId === instanceId)
          if (!instrument) return reject('仪表尚未放置到台面。')
          if (Object.entries(patch).every(([id, value]) => instrument.settings[id] === value)) return false
          set({
            placedInstruments: state.placedInstruments.map((item) =>
              item === instrument ? { ...item, settings: { ...item.settings, ...patch } } : item,
            ),
            pendingJack: null,
            notice: null,
          })
          return true
        },
        setControlValue: (id, value) => setControlValues({ [id]: value }),
        setControlValues,
        undo: () => moveHistory('undo'),
        redo: () => moveHistory('redo'),
      }),
      {
        partialize: historyState,
        equality: (a, b) =>
          a.wires === b.wires && a.placedInstruments === b.placedInstruments && a.controlValues === b.controlValues,
        limit: 100,
      },
    ),
  )
  const originalHistory = { undo: store.temporal.getState().undo, redo: store.temporal.getState().redo }
  // The exposed temporal controls use the same power guard as toolbar and keyboard actions.
  store.temporal.setState({
    undo: (steps) => {
      moveHistory('undo', steps)
    },
    redo: (steps) => {
      moveHistory('redo', steps)
    },
  })
  return store
}

export type CircuitStore = ReturnType<typeof createCircuitStore>
