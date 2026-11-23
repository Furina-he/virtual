import { useMemo } from 'react'
import { useStore } from 'zustand'
import { JackRef } from '../../../shared/schema/common'
import type { Project } from '../../../shared/schema/project'
import { type CircuitEditorState, type CircuitSceneContext, createCircuitStore } from '../../stores/circuit'
import { instrumentCatalog, moduleCatalog } from './practice-content'
import {
  desktopSlots,
  fixedPlacements,
  initialInstruments,
  instrumentPlacementProblem,
  jacksForPlacements,
  jackName as nameOfJack,
  placementSignature,
  placementsForInstruments,
  placementsForProject,
  previewInstruments,
  type ScenePlacement,
  wiringAssets,
} from './wiring-context'

export { type WiringJack, wiringJacks, wiringScene } from './wiring-context'

function sceneContext(placements: readonly ScenePlacement[]): CircuitSceneContext {
  const controlValues: Record<string, number> = {}
  for (const placement of placements) {
    if (!wiringAssets.some((asset) => asset.id === placement.assetId && asset.kind === 'module')) continue
    const module = moduleCatalog.find((entry) => entry.id === placement.assetId)
    if (!module) throw new Error(`实训模块配置不可用：${placement.assetId}。`)
    for (const control of module.controls) controlValues[`${placement.instanceId}.${control.id}`] = control.default
  }
  return {
    jackRefs: jacksForPlacements(placements).map((jack) => JackRef.parse(jack.ref)),
    reservedInstanceIds: placements.map((placement) => placement.instanceId),
    controlValues,
  }
}

let activeProject: Project | undefined
let activeBasePlacements = fixedPlacements
const initialContext = sceneContext(activeBasePlacements)
export const circuitStore = createCircuitStore(
  initialContext.jackRefs,
  {
    placedInstruments: initialInstruments,
    controlValues: initialContext.controlValues,
  },
  {
    instruments: instrumentCatalog
      .filter((instrument) => instrument.mounting === 'desktop')
      .map((instrument) => ({
        instrumentId: instrument.id,
        jacks: instrument.jacks.map((jack) => jack.id),
        slots: desktopSlots.map((slot) => slot.id),
      })),
    reservedInstanceIds: initialContext.reservedInstanceIds,
    placementProblem: (instrument, placed) => instrumentPlacementProblem(instrument, placed, activeBasePlacements),
  },
)

let activePlacements = fixedPlacements
let activePlacementKey = ''
function cachedPlacements(instruments: CircuitEditorState['placedInstruments']) {
  const key = JSON.stringify([
    placementSignature(activeBasePlacements),
    instruments
      .slice()
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
      .map(({ instanceId, instrumentId, slot }) => [instanceId, instrumentId, slot]),
  ])
  if (key !== activePlacementKey) {
    activePlacementKey = key
    activePlacements = placementsForInstruments(instruments, activeBasePlacements)
  }
  return activePlacements
}

/** Project configuration is separate from the circuit's undoable learner edits. */
export function activateProject(project?: Project): boolean {
  if (project === activeProject) return false
  const placements = placementsForProject(project)
  const context = sceneContext(placements)
  activeProject = project
  activeBasePlacements = placements
  circuitStore.getState().resetScene(context)
  return true
}

export function resetProject(): void {
  circuitStore.getState().resetScene(sceneContext(activeBasePlacements))
}

export function getActiveProject(): Project | undefined {
  return activeProject
}

export function getActivePlacements() {
  return cachedPlacements(circuitStore.getState().placedInstruments)
}

export function nextInstrumentInstanceId(instrumentId: string): string {
  const preview = previewInstruments.find((instrument) => instrument.instrumentId === instrumentId)
  const prefix = preview?.instanceId.replace(/\d+$/, '') ?? instrumentId
  const history = circuitStore.temporal.getState()
  const used = new Set([
    ...getActivePlacements().map((placement) => placement.instanceId),
    ...[circuitStore.getState(), ...history.pastStates, ...history.futureStates].flatMap((state) =>
      (state.placedInstruments ?? []).map((instrument) => instrument.instanceId),
    ),
  ])
  let index = 1
  while (used.has(`${prefix}${index}`)) index++
  return `${prefix}${index}`
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
