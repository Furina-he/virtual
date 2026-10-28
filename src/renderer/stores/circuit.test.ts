import { describe, expect, it } from 'vitest'
import { CircuitState, Wire, type WireColor } from '../../shared/schema/circuit.ts'
import { createCircuitStore, DEFAULT_WIRE_SLACK, POWERED_INSTRUMENT_NOTICE, POWERED_WIRING_NOTICE } from './circuit.ts'

const refs = ['supply.POS', 'meter.POS', 'meter.NEG', ...Array.from({ length: 130 }, (_, index) => `board.J${index}`)]
const legacyWire: Wire = { id: 'legacy-wire', a: 'supply.POS', b: 'meter.POS', color: 'red' }
const desktop = { instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_1', settings: {} }
const placementOptions = {
  instruments: [
    { instrumentId: 'ins-multimeter', jacks: ['COM', 'VOHM', 'MA'], slots: ['SLOT_DESK_1', 'SLOT_DESK_2'] },
  ],
  reservedInstanceIds: ['bench'],
}

function historyLengths(store: ReturnType<typeof createCircuitStore>): [number, number] {
  const history = store.temporal.getState()
  return [history.pastStates.length, history.futureStates.length]
}

describe('circuit editor initialization', () => {
  it('starts empty and unpowered with no history or draft', () => {
    const store = createCircuitStore(refs)
    expect(store.getState()).toMatchObject({
      wires: [],
      placedInstruments: [],
      controlValues: {},
      powered: false,
      selectedWireId: null,
      wireColor: 'red',
      pendingJack: null,
      notice: null,
    })
    expect(historyLengths(store)).toEqual([0, 0])
  })

  it('preserves compatible initial circuit data without sharing mutable input or recording history', () => {
    const initial: CircuitState = {
      wires: [legacyWire],
      placedInstruments: [{ instanceId: 'meter', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_1', settings: {} }],
      controlValues: { 'board.K1': 1 },
      powered: true,
      activeFault: 'open-r1',
    }
    const store = createCircuitStore(refs, initial)
    expect(store.getState().wires).toEqual([legacyWire])
    expect(store.getState().wires[0]).not.toHaveProperty('slack')
    initial.controlValues['board.K1'] = 0
    const instrument = initial.placedInstruments[0]
    if (instrument) instrument.settings.range = '200m'
    expect(store.getState().controlValues['board.K1']).toBe(1)
    expect(store.getState().placedInstruments[0]?.settings).toEqual({})
    expect(store.getState().powered).toBe(true)
    expect(store.getState().activeFault).toBe('open-r1')
    expect(historyLengths(store)).toEqual([0, 0])
  })

  it('rejects malformed refs and invalid initial wire endpoints or duplicates', () => {
    expect(() => createCircuitStore(['not-a-jack'])).toThrow()
    expect(() => createCircuitStore(refs, { wires: [{ ...legacyWire, b: 'unknown.POS' }] })).toThrow('unknown jack')
    expect(() => createCircuitStore(refs, { wires: [legacyWire, { ...legacyWire, id: 'other' }] })).toThrow(
      'duplicates',
    )
    expect(() => createCircuitStore(refs, { wires: [legacyWire, { ...legacyWire, b: 'meter.NEG' }] })).toThrow(
      'duplicates',
    )
    expect(() => createCircuitStore(refs, { wires: [{ ...legacyWire, b: legacyWire.a }] })).toThrow()
  })
})

describe('wire editing', () => {
  it('adds a cross-device wire using a UUID, selected color and meter-scale default slack', () => {
    const store = createCircuitStore(refs)
    expect(store.getState().setWireColor('blue')).toBe(true)
    expect(store.getState().setPendingJack('supply.POS')).toBe(true)
    expect(store.getState().addWire('supply.POS', 'meter.POS')).toBe(true)
    const wire = store.getState().wires[0]
    expect(wire).toMatchObject({ a: 'supply.POS', b: 'meter.POS', color: 'blue', slack: DEFAULT_WIRE_SLACK })
    expect(wire?.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(store.getState().selectedWireId).toBe(wire?.id)
    expect(store.getState().pendingJack).toBeNull()
    expect(historyLengths(store)).toEqual([1, 0])
  })

  it('supports same-module jumpers and three different wires stacked on one socket', () => {
    const store = createCircuitStore(refs)
    for (const end of ['board.J1', 'board.J2', 'board.J3']) {
      expect(store.getState().addWire('board.J0', end, 'green', 0.02)).toBe(true)
    }
    expect(store.getState().wires.filter((wire) => wire.a === 'board.J0')).toHaveLength(3)
    expect(historyLengths(store)).toEqual([3, 0])
  })

  it('rejects exact and reversed duplicates without history changes or losing a pending connection', () => {
    const store = createCircuitStore(refs, { wires: [legacyWire] })
    store.getState().setPendingJack('meter.POS')
    expect(store.getState().addWire('supply.POS', 'meter.POS')).toBe(false)
    expect(store.getState().addWire('meter.POS', 'supply.POS', 'blue')).toBe(false)
    expect(store.getState().wires).toEqual([legacyWire])
    expect(store.getState().pendingJack).toBe('meter.POS')
    expect(store.getState().notice).toContain('已有导线')
    expect(historyLengths(store)).toEqual([0, 0])
  })

  it('rejects self-connections and unknown exact refs rather than accepting ID substrings', () => {
    const store = createCircuitStore(refs)
    expect(store.getState().addWire('meter.POS', 'meter.POS')).toBe(false)
    expect(store.getState().addWire('meter.POS', 'POS')).toBe(false)
    expect(store.getState().addWire('meter.POS', 'other.POS')).toBe(false)
    expect(store.getState().addWire('meter.POS', 'meter.POS ')).toBe(false)
    expect(store.getState().setPendingJack('meter.JACK_POS')).toBe(false)
    expect(store.getState().wires).toEqual([])
    expect(historyLengths(store)).toEqual([0, 0])
  })

  it.each([NaN, Infinity, -1, 0, 0.019, 0.401])('rejects invalid slack %s without graph history', (slack) => {
    const store = createCircuitStore(refs, { wires: [legacyWire] })
    expect(store.getState().addWire('board.J0', 'board.J1', 'red', slack)).toBe(false)
    expect(store.getState().updateWire(legacyWire.id, { slack })).toBe(false)
    expect(store.getState().wires).toEqual([legacyWire])
    expect(historyLengths(store)).toEqual([0, 0])
  })

  it('accepts both slack limits and all configured colors while refusing unknown colors', () => {
    const store = createCircuitStore(refs)
    expect(store.getState().addWire('board.J0', 'board.J1', 'yellowGreen', 0.02)).toBe(true)
    expect(store.getState().addWire('board.J0', 'board.J2', 'lightBlue', 0.4)).toBe(true)
    expect(store.getState().addWire('board.J0', 'board.J3', 'purple' as WireColor)).toBe(false)
    expect(store.getState().setWireColor('purple' as WireColor)).toBe(false)
    expect(store.getState().wires).toHaveLength(2)
    expect(historyLengths(store)).toEqual([2, 0])
  })

  it('updates color, label and slack together as one reversible edit', () => {
    const store = createCircuitStore(refs, { wires: [legacyWire] })
    expect(store.getState().updateWire(legacyWire.id, { color: 'yellow', label: 'U1', slack: 0.2 })).toBe(true)
    expect(store.getState().wires[0]).toEqual({ ...legacyWire, color: 'yellow', label: 'U1', slack: 0.2 })
    expect(historyLengths(store)).toEqual([1, 0])
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().wires).toEqual([legacyWire])
    expect(store.getState().redo()).toBe(true)
    expect(store.getState().wires[0]?.label).toBe('U1')
  })

  it('treats same effective values, empty patches and missing deletes as no-op history', () => {
    const store = createCircuitStore(refs, { wires: [legacyWire] })
    const before = store.getState().wires
    expect(store.getState().updateWire(legacyWire.id, {})).toBe(false)
    expect(store.getState().updateWire(legacyWire.id, { color: 'red', slack: DEFAULT_WIRE_SLACK })).toBe(false)
    expect(store.getState().updateWire(legacyWire.id, { label: '' })).toBe(false)
    expect(store.getState().deleteWire('missing')).toBe(false)
    expect(store.getState().wires).toBe(before)
    expect(historyLengths(store)).toEqual([0, 0])
  })

  it('accepts labels up to 48 characters, rejects longer edits and clears empty labels', () => {
    const store = createCircuitStore(refs, { wires: [legacyWire] })
    expect(store.getState().updateWire(legacyWire.id, { label: 'a'.repeat(48) })).toBe(true)
    expect(store.getState().updateWire(legacyWire.id, { label: 'b'.repeat(49) })).toBe(false)
    expect(store.getState().wires[0]?.label).toBe('a'.repeat(48))
    expect(historyLengths(store)).toEqual([1, 0])
    expect(store.getState().updateWire(legacyWire.id, { label: '' })).toBe(true)
    expect(store.getState().wires[0]).not.toHaveProperty('label')
  })

  it('deletes only the requested wire, clears stale selection and allows undo', () => {
    const other: Wire = { ...legacyWire, id: 'second-wire', b: 'meter.NEG' }
    const store = createCircuitStore(refs, { wires: [legacyWire, other] })
    store.getState().selectWire(legacyWire.id)
    expect(store.getState().deleteWire(legacyWire.id)).toBe(true)
    expect(store.getState().wires).toEqual([other])
    expect(store.getState().selectedWireId).toBeNull()
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().wires).toEqual([legacyWire, other])
  })

  it('clears every wire in one undo step and an empty clear does not record history', () => {
    const store = createCircuitStore(refs)
    expect(store.getState().clearWires()).toBe(false)
    store.getState().addWire('board.J0', 'board.J1')
    store.getState().addWire('board.J0', 'board.J2')
    const before = store.getState().wires
    expect(store.getState().clearWires()).toBe(true)
    expect(store.getState().wires).toEqual([])
    expect(historyLengths(store)).toEqual([3, 0])
    expect(store.getState().clearWires()).toBe(false)
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().wires).toEqual(before)
  })
})

describe('student-selected desktop instruments', () => {
  it('registers only currently placed jacks, keeping original IDs through undo and redo', () => {
    const store = createCircuitStore(['supply.POS'], undefined, placementOptions)
    expect(store.getState().addWire('supply.POS', 'meter1.VOHM')).toBe(false)
    expect(store.getState().placeInstrument(desktop)).toBe(true)
    expect(store.getState().wires).toEqual([])
    expect(store.getState().setPendingJack('meter1.COM')).toBe(true)
    expect(store.getState().addWire('supply.POS', 'meter1.VOHM')).toBe(true)
    const wire = store.getState().wires[0]
    expect(historyLengths(store)).toEqual([2, 0])
    expect(store.getState().removeInstrument('meter1')).toBe(true)
    expect(store.getState()).toMatchObject({
      wires: [],
      placedInstruments: [],
      pendingJack: null,
      selectedWireId: null,
    })
    expect(historyLengths(store)).toEqual([3, 0])
    expect(store.getState().setPendingJack('meter1.VOHM')).toBe(false)
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().wires).toEqual([wire])
    expect(store.getState().placedInstruments).toEqual([desktop])
    expect(store.getState().setPendingJack('meter1.COM')).toBe(true)
    expect(store.getState().redo()).toBe(true)
    expect(store.getState().setPendingJack('meter1.COM')).toBe(false)
    expect(store.getState().wires).toEqual([])
  })

  it('restores known jack membership when undoing the placement itself', () => {
    const store = createCircuitStore(['supply.POS'], undefined, placementOptions)
    store.getState().placeInstrument(desktop)
    store.temporal.getState().undo()
    expect(store.getState().addWire('supply.POS', 'meter1.COM')).toBe(false)
    store.temporal.getState().redo()
    expect(store.getState().addWire('supply.POS', 'meter1.COM')).toBe(true)
    expect(store.getState().placedInstruments[0]?.instanceId).toBe('meter1')
  })

  it('rejects missing content, reserved instance IDs, occupied and incompatible slots without history', () => {
    const store = createCircuitStore(['supply.POS'], undefined, placementOptions)
    for (const invalid of [
      { ...desktop, instrumentId: 'ins-missing' },
      { ...desktop, instrumentId: 'ins-dc-voltmeter' },
      { ...desktop, instanceId: 'supply' },
      { ...desktop, instanceId: 'bench' },
      { ...desktop, instanceId: 'Meter1' },
      { ...desktop, slot: 'SLOT_INS_DCV' },
      { ...desktop, settings: { internalR: NaN } },
    ])
      expect(store.getState().placeInstrument(invalid)).toBe(false)
    expect(historyLengths(store)).toEqual([0, 0])
    expect(store.getState().placeInstrument(desktop)).toBe(true)
    expect(store.getState().placeInstrument({ ...desktop, instanceId: 'meter2' })).toBe(false)
    expect(store.getState().placeInstrument({ ...desktop, slot: 'SLOT_DESK_2' })).toBe(false)
    expect(historyLengths(store)).toEqual([1, 0])
    expect(store.getState().removeInstrument('supply')).toBe(false)
    expect(store.getState().placedInstruments).toEqual([desktop])
  })

  it('applies geometry validation before adding a desktop instrument', () => {
    const store = createCircuitStore(['supply.POS'], undefined, {
      ...placementOptions,
      placementProblem: () => '仪表超出台面边界。',
    })
    expect(store.getState().placeInstrument(desktop)).toBe(false)
    expect(store.getState().notice).toBe('仪表超出台面边界。')
    expect(historyLengths(store)).toEqual([0, 0])
  })

  it('removes only exact instance endpoints and preserves unrelated wire selection', () => {
    const store = createCircuitStore(['supply.POS'], undefined, placementOptions)
    store.getState().placeInstrument(desktop)
    store.getState().placeInstrument({ ...desktop, instanceId: 'meter10', slot: 'SLOT_DESK_2' })
    store.getState().addWire('supply.POS', 'meter1.VOHM')
    store.getState().addWire('supply.POS', 'meter10.VOHM')
    const selected = store.getState().selectedWireId
    store.getState().removeInstrument('meter1')
    expect(store.getState().wires).toHaveLength(1)
    expect(store.getState().wires[0]?.b).toBe('meter10.VOHM')
    expect(store.getState().selectedWireId).toBe(selected)
    expect(store.getState().addWire('meter10.COM', 'meter10.MA')).toBe(true)
  })

  it('guards both placement and removal while powered without changing undo or redo', () => {
    const store = createCircuitStore(['supply.POS'], undefined, placementOptions)
    store.getState().placeInstrument(desktop)
    store.getState().addWire('supply.POS', 'meter1.VOHM')
    store.getState().undo()
    store.getState().togglePower()
    const before = store.getState().placedInstruments
    const history = historyLengths(store)
    expect(store.getState().placeInstrument({ ...desktop, instanceId: 'meter2', slot: 'SLOT_DESK_2' })).toBe(false)
    expect(store.getState().removeInstrument('meter1')).toBe(false)
    expect(store.getState().notice).toBe(POWERED_INSTRUMENT_NOTICE)
    expect(store.getState().placedInstruments).toBe(before)
    expect(historyLengths(store)).toEqual(history)
  })

  it('keeps live settings and fixed controls in graph history but never accepts non-finite parameters', () => {
    const store = createCircuitStore(['supply.POS'], undefined, placementOptions)
    store.getState().placeInstrument(desktop)
    store.getState().togglePower()
    expect(store.getState().setInstrumentSettings('meter1', { range: 'dcv20', internalR: 1e6 })).toBe(true)
    expect(store.getState().setControlValues({ 'supply.ch1': 12, 'supply.ch2': 5 })).toBe(true)
    expect(store.getState().setControlValue('supply.ch1', 12)).toBe(false)
    expect(store.getState().setInstrumentSettings('meter1', { range: 'dcv20' })).toBe(false)
    expect(store.getState().setControlValue('supply.ch1', Infinity)).toBe(false)
    expect(store.getState().setInstrumentSettings('meter1', { internalR: NaN })).toBe(false)
    expect(store.getState().setInstrumentSettings('missing', { range: 'dcv20' })).toBe(false)
    expect(historyLengths(store)).toEqual([3, 0])
    expect(store.getState().undo()).toBe(false)
    store.getState().togglePower()
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().controlValues).toEqual({})
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().placedInstruments[0]?.settings).toEqual({})
  })

  it('validates restored initial wires against restored desktop definitions', () => {
    const store = createCircuitStore(
      ['supply.POS'],
      {
        placedInstruments: [desktop],
        wires: [{ id: 'restored', a: 'supply.POS', b: 'meter1.VOHM', color: 'red' }],
      },
      placementOptions,
    )
    expect(store.getState().wires[0]?.b).toBe('meter1.VOHM')
    expect(historyLengths(store)).toEqual([0, 0])
  })
})

describe('zundo graph history', () => {
  it('undoes and redoes 20 steps with original wire IDs intact', () => {
    const store = createCircuitStore(refs)
    for (let index = 1; index <= 20; index++) store.getState().addWire('board.J0', `board.J${index}`)
    const completed = store.getState().wires
    expect(historyLengths(store)).toEqual([20, 0])
    for (let index = 19; index >= 0; index--) {
      expect(store.getState().undo()).toBe(true)
      expect(store.getState().wires).toEqual(completed.slice(0, index))
    }
    expect(store.getState().undo()).toBe(false)
    for (let index = 1; index <= 20; index++) {
      expect(store.getState().redo()).toBe(true)
      expect(store.getState().wires).toEqual(completed.slice(0, index))
    }
    expect(store.getState().redo()).toBe(false)
  })

  it('preserves redo through UI changes and rejected edits, then discards it after a new graph edit', () => {
    const store = createCircuitStore(refs, { wires: [legacyWire] })
    store.getState().addWire('board.J0', 'board.J1')
    store.getState().undo()
    expect(historyLengths(store)).toEqual([0, 1])
    store.getState().setWireColor('white')
    store.getState().selectWire(legacyWire.id)
    store.getState().setPendingJack('board.J2')
    store.getState().cancelConnection()
    store.getState().togglePower()
    store.getState().togglePower()
    store.getState().addWire(legacyWire.b, legacyWire.a)
    store.getState().updateWire(legacyWire.id, { color: 'red' })
    expect(historyLengths(store)).toEqual([0, 1])
    store.getState().updateWire(legacyWire.id, { label: 'branch' })
    expect(historyLengths(store)).toEqual([1, 0])
    expect(store.getState().redo()).toBe(false)
  })

  it('tracks only wires, placedInstruments and controlValues, never UI, power or active fault', () => {
    const store = createCircuitStore(refs)
    store.setState({
      wires: [legacyWire],
      placedInstruments: [{ instanceId: 'meter', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_1', settings: {} }],
      controlValues: { 'board.K1': 1 },
    })
    store.getState().selectWire(legacyWire.id)
    store.getState().setWireColor('black')
    store.getState().setPendingJack('meter.NEG')
    store.setState({ activeFault: 'test-fault' })
    expect(Object.keys(store.temporal.getState().pastStates[0] ?? {}).sort()).toEqual([
      'controlValues',
      'placedInstruments',
      'wires',
    ])
    expect(historyLengths(store)).toEqual([1, 0])
    store.getState().undo()
    expect(store.getState()).toMatchObject({
      wires: [],
      placedInstruments: [],
      controlValues: {},
      selectedWireId: null,
      pendingJack: null,
      wireColor: 'black',
      activeFault: 'test-fault',
    })
    expect(historyLengths(store)).toEqual([0, 1])
  })

  it('keeps 100 graph steps and drops only the oldest history', () => {
    const store = createCircuitStore(refs)
    for (let index = 1; index <= 105; index++) store.getState().addWire('board.J0', `board.J${index}`)
    expect(historyLengths(store)).toEqual([100, 0])
    for (let index = 0; index < 100; index++) expect(store.getState().undo()).toBe(true)
    expect(store.getState().wires).toHaveLength(5)
    expect(store.getState().undo()).toBe(false)
    for (let index = 0; index < 100; index++) expect(store.getState().redo()).toBe(true)
    expect(store.getState().wires).toHaveLength(105)
  })

  it('reconciles selection and pending state for public temporal undo/redo without extra history entries', () => {
    const store = createCircuitStore(refs)
    store.getState().addWire('board.J0', 'board.J1')
    store.getState().setPendingJack('board.J2')
    store.temporal.getState().undo()
    expect(store.getState().selectedWireId).toBeNull()
    expect(store.getState().pendingJack).toBeNull()
    expect(historyLengths(store)).toEqual([0, 1])
    store.temporal.getState().redo()
    expect(store.getState().wires).toHaveLength(1)
    expect(store.getState().selectedWireId).toBeNull()
    expect(historyLengths(store)).toEqual([1, 0])
    store.temporal.getState().undo(0)
    expect(historyLengths(store)).toEqual([1, 0])
    expect(store.getState().selectWire('missing')).toBe(false)
  })
})

describe('powered wiring guard', () => {
  it.each(['add', 'delete', 'clear', 'update', 'undo', 'redo', 'temporalUndo', 'temporalRedo'])(
    'rejects %s while powered without changing either history stack',
    (action) => {
      const store = createCircuitStore(refs, { wires: [legacyWire] })
      store.getState().updateWire(legacyWire.id, { label: 'saved' })
      store.getState().addWire('board.J0', 'board.J1')
      store.getState().undo()
      store.getState().togglePower()
      const before = store.getState().wires
      const history = JSON.stringify([store.temporal.getState().pastStates, store.temporal.getState().futureStates])
      const actions: Record<string, () => unknown> = {
        add: () => store.getState().addWire('board.J0', 'board.J2'),
        delete: () => store.getState().deleteWire(legacyWire.id),
        clear: () => store.getState().clearWires(),
        update: () => store.getState().updateWire(legacyWire.id, { color: 'blue', slack: 0.3 }),
        undo: () => store.getState().undo(),
        redo: () => store.getState().redo(),
        temporalUndo: () => store.temporal.getState().undo(),
        temporalRedo: () => store.temporal.getState().redo(),
      }
      const result = actions[action]?.()
      if (!action.startsWith('temporal')) expect(result).toBe(false)
      expect(store.getState().notice).toBe(POWERED_WIRING_NOTICE)
      expect(store.getState().powered).toBe(true)
      expect(store.getState().wires).toBe(before)
      expect(JSON.stringify([store.temporal.getState().pastStates, store.temporal.getState().futureStates])).toBe(
        history,
      )
    },
  )

  it('power-on cancels the draft and blocks new drafts, but non-graph UI remains usable', () => {
    const store = createCircuitStore(refs, { wires: [legacyWire] })
    store.getState().setPendingJack('meter.POS')
    expect(store.getState().togglePower()).toBe(true)
    expect(store.getState().pendingJack).toBeNull()
    expect(store.getState().setPendingJack('meter.NEG')).toBe(false)
    expect(store.getState().notice).toBe(POWERED_WIRING_NOTICE)
    expect(store.getState().selectWire(legacyWire.id)).toBe(true)
    expect(store.getState().setWireColor('green')).toBe(true)
    expect(historyLengths(store)).toEqual([0, 0])
    store.getState().togglePower()
    expect(store.getState().setPendingJack('meter.NEG')).toBe(true)
    expect(store.getState().cancelConnection()).toBe(true)
    expect(store.getState().cancelConnection()).toBe(false)
    expect(store.getState().notice).toBeNull()
  })
})

describe('wire schema compatibility', () => {
  it('keeps old wires valid and preserves optional routing slack in serialized circuits', () => {
    expect(Wire.parse(legacyWire)).toEqual(legacyWire)
    expect(Wire.parse({ ...legacyWire, slack: 0.12 })).toEqual({ ...legacyWire, slack: 0.12 })
    expect(Wire.safeParse({ ...legacyWire, slack: 0.01 }).success).toBe(false)
    expect(Wire.safeParse({ ...legacyWire, slack: 0.41 }).success).toBe(false)
    const state = CircuitState.parse({
      wires: [{ ...legacyWire, slack: 0.3 }],
      placedInstruments: [],
      controlValues: {},
      powered: false,
    })
    expect(JSON.parse(JSON.stringify(state)).wires[0].slack).toBe(0.3)
  })
})
