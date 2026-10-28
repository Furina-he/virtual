import { useMemo } from 'react'
import { useStore } from 'zustand'
import { type CircuitEditorState, createCircuitStore } from '../../stores/circuit'
import { instrumentCatalog } from './practice-content'
import {
  desktopSlots,
  fixedPlacements,
  initialInstruments,
  instrumentPlacementProblem,
  jacksForPlacements,
  jackName as nameOfJack,
  placementsForInstruments,
} from './wiring-context'

export { type WiringJack, wiringJacks, wiringScene } from './wiring-context'

export const circuitStore = createCircuitStore(
  jacksForPlacements(fixedPlacements).map((jack) => jack.ref),
  {
    placedInstruments: initialInstruments,
  },
  {
    instruments: instrumentCatalog
      .filter((instrument) => instrument.mounting === 'desktop')
      .map((instrument) => ({
        instrumentId: instrument.id,
        jacks: instrument.jacks.map((jack) => jack.id),
        slots: desktopSlots.map((slot) => slot.id),
      })),
    reservedInstanceIds: fixedPlacements.map((placement) => placement.instanceId),
    placementProblem: instrumentPlacementProblem,
  },
)

let activePlacements = fixedPlacements
let activePlacementKey = ''
function cachedPlacements(instruments: CircuitEditorState['placedInstruments']) {
  const key = instruments.map(({ instanceId, instrumentId, slot }) => `${instanceId}:${instrumentId}:${slot}`).join('|')
  if (key !== activePlacementKey) {
    activePlacementKey = key
    activePlacements = placementsForInstruments(instruments)
  }
  return activePlacements
}

export function getActivePlacements() {
  return cachedPlacements(circuitStore.getState().placedInstruments)
}

export function getWiringJacks() {
  return jacksForPlacements(getActivePlacements())
}

export function jackName(ref: string): string {
  return nameOfJack(ref, getWiringJacks())
}

export function useCircuit<T>(selector: (state: CircuitEditorState) => T): T {
  return useStore(circuitStore, selector)
}

export function useActivePlacements() {
  return useCircuit((state) => cachedPlacements(state.placedInstruments))
}

export function useWiringJacks() {
  const placements = useActivePlacements()
  return useMemo(() => jacksForPlacements(placements), [placements])
}

export function useHistorySize() {
  const undoCount = useStore(circuitStore.temporal, (state) => state.pastStates.length)
  const redoCount = useStore(circuitStore.temporal, (state) => state.futureStates.length)
  return { undoCount, redoCount }
}
