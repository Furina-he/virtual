import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../shared/schema/project.ts'

vi.mock('./practice-content', async () => {
  const { readFileSync } = await import('node:fs')
  const { Instrument, Module } = await import('../../../shared/schema/index.ts')
  return {
    instrumentCatalog: [
      'ins-dc-voltmeter',
      'ins-dc-ammeter',
      'ins-dc-power',
      'ins-multimeter',
      'ins-func-gen',
      'ins-oscilloscope',
    ].map((id) => Instrument.parse(JSON.parse(readFileSync(`content/instruments/${id}/instrument.json`, 'utf8')))),
    moduleCatalog: [Module.parse(JSON.parse(readFileSync('content/modules/mod-dc-circuit/module.json', 'utf8')))],
  }
})

import {
  activateProject,
  circuitStore,
  getActivePlacements,
  getWiringJacks,
  nextInstrumentInstanceId,
  resetProject,
} from './wiring-state'

function projectFor(instanceId = 'board1', slot = 'SLOT_BOX_L2'): Project {
  return {
    id: 'DG-05',
    group: '直流电路',
    title: '配置驱动的实训场景',
    type: 'basic',
    modules: [{ instanceId, moduleId: 'mod-dc-circuit', slot }],
    allowedInstruments: ['ins-multimeter'],
    reference: { nets: [], measurePoints: [] },
    steps: [{ id: 'prepare', text: '准备器材。' }],
    dataTables: [],
    charts: [],
    questions: [],
  }
}

const historySize = () => {
  const history = circuitStore.temporal.getState()
  return [history.pastStates.length, history.futureStates.length]
}

afterEach(() => {
  activateProject()
  resetProject()
})

describe('active project scene and learner graph', () => {
  it('preserves geometry references for initial activation with the same fixture and ignores repeated activation', () => {
    const legacy = getActivePlacements()
    const project = projectFor('dc1', 'SLOT_BOX_L1')
    expect(activateProject(project)).toBe(true)
    expect(getActivePlacements()).toBe(legacy)
    expect(circuitStore.getState().controlValues).toEqual({ 'dc1.K1': 1, 'dc1.K2': 1, 'dc1.K3': 0 })
    circuitStore.getState().addWire('dc1.KH_F', 'dc1.KH_A')
    expect(activateProject(project)).toBe(false)
    expect(circuitStore.getState().wires).toHaveLength(1)
  })

  it('switches modules, known jacks and defaults while clearing powered graph, desktop devices, drafts, faults and history', () => {
    activateProject(projectFor())
    expect(getActivePlacements().find((placement) => placement.instanceId === 'board1')?.slot).toBe('SLOT_BOX_L2')
    expect(getWiringJacks().some((jack) => jack.ref.startsWith('dc1.'))).toBe(false)
    circuitStore
      .getState()
      .placeInstrument({ instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_2', settings: {} })
    circuitStore.getState().addWire('ins-dc-power.CH1P', 'board1.KH_U1P')
    circuitStore.getState().setControlValue('board1.K1', 0)
    circuitStore.getState().undo()
    expect(historySize()).toEqual([2, 1])
    circuitStore.getState().togglePower()
    circuitStore.setState({ pendingJack: 'board1.KH_F', activeFault: 'old-fault', notice: 'old-notice' })
    activateProject(projectFor('board2', 'SLOT_BOX_L1'))
    expect(circuitStore.getState()).toMatchObject({
      wires: [],
      placedInstruments: [],
      powered: false,
      activeFault: undefined,
      selectedWireId: null,
      pendingJack: null,
      notice: null,
      controlValues: { 'board2.K1': 1, 'board2.K2': 1, 'board2.K3': 0 },
    })
    expect(historySize()).toEqual([0, 0])
    expect(circuitStore.getState().undo()).toBe(false)
    expect(circuitStore.getState().redo()).toBe(false)
    expect(getActivePlacements().some((placement) => placement.instanceId === 'board1')).toBe(false)
    expect(getWiringJacks().some((jack) => jack.ref.startsWith('meter1.'))).toBe(false)
    expect(circuitStore.getState().addWire('board1.KH_F', 'ins-dc-power.CH1P')).toBe(false)
    expect(circuitStore.getState().addWire('board2.KH_F', 'ins-dc-power.CH1P')).toBe(true)
  })

  it('reset keeps the active module configuration and restores its content defaults without reviving history', () => {
    const project = projectFor()
    activateProject(project)
    circuitStore.getState().setControlValue('board1.K3', 1)
    circuitStore.getState().addWire('board1.KH_F', 'board1.KH_A')
    circuitStore.getState().togglePower()
    const placements = getActivePlacements()
    resetProject()
    expect(getActivePlacements()).toBe(placements)
    expect(circuitStore.getState().powered).toBe(false)
    expect(circuitStore.getState().wires).toEqual([])
    expect(circuitStore.getState().controlValues).toEqual({ 'board1.K1': 1, 'board1.K2': 1, 'board1.K3': 0 })
    expect(historySize()).toEqual([0, 0])
    expect(activateProject(project)).toBe(false)
  })

  it('uses module IDs and only the current project history when allocating desktop IDs', () => {
    activateProject(projectFor('meter1', 'SLOT_BOX_L1'))
    expect(nextInstrumentInstanceId('ins-multimeter')).toBe('meter2')
    expect(
      circuitStore
        .getState()
        .placeInstrument({ instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_2', settings: {} }),
    ).toBe(false)
    circuitStore
      .getState()
      .placeInstrument({ instanceId: 'meter2', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_2', settings: {} })
    circuitStore.getState().removeInstrument('meter2')
    expect(nextInstrumentInstanceId('ins-multimeter')).toBe('meter3')
    resetProject()
    expect(nextInstrumentInstanceId('ins-multimeter')).toBe('meter2')
    activateProject(projectFor('board2', 'SLOT_BOX_L1'))
    expect(nextInstrumentInstanceId('ins-multimeter')).toBe('meter1')
    expect(
      circuitStore
        .getState()
        .placeInstrument({ instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_2', settings: {} }),
    ).toBe(true)
    expect(circuitStore.getState().addWire('meter1.KH_F', 'board2.KH_F')).toBe(false)
    expect(circuitStore.getState().addWire('meter1.COM', 'board2.KH_F')).toBe(true)
  })

  it('rejects invalid activation before replacing the active scene or learner state', () => {
    const project = projectFor()
    activateProject(project)
    circuitStore.getState().addWire('board1.KH_F', 'board1.KH_A')
    const placements = getActivePlacements()
    const state = circuitStore.getState()
    const history = historySize()
    const invalid = { ...project, modules: [{ instanceId: 'other', moduleId: 'missing-module', slot: 'SLOT_BOX_L1' }] }
    expect(() => activateProject(invalid)).toThrow()
    expect(getActivePlacements()).toBe(placements)
    expect(circuitStore.getState()).toBe(state)
    expect(historySize()).toEqual(history)
    expect(activateProject(project)).toBe(false)
  })

  it('does not invalidate geometry for settings, wiring, controls or equivalent desktop ordering', () => {
    activateProject(projectFor())
    circuitStore
      .getState()
      .placeInstrument({ instanceId: 'meter1', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_1', settings: {} })
    circuitStore
      .getState()
      .placeInstrument({ instanceId: 'meter2', instrumentId: 'ins-multimeter', slot: 'SLOT_DESK_2', settings: {} })
    const placements = getActivePlacements()
    circuitStore.getState().setInstrumentSettings('meter1', { range: 'dcv2' })
    circuitStore.getState().setControlValue('board1.K1', 0)
    circuitStore.getState().addWire('meter1.COM', 'board1.KH_F')
    expect(getActivePlacements()).toBe(placements)
    circuitStore.setState({ placedInstruments: circuitStore.getState().placedInstruments.slice().reverse() })
    expect(getActivePlacements()).toBe(placements)
    resetProject()
    expect(getActivePlacements()).not.toBe(placements)
    const base = getActivePlacements()
    resetProject()
    expect(getActivePlacements()).toBe(base)
  })
})
