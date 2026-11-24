import type { Project } from '@shared/schema/project'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { PanelDef } from './instrument-panels'

export type DockLayoutMode = 'single' | 'dual'

export interface InstrumentDockState {
  primaryId: string | null
  secondaryId: string | null
  layoutMode: DockLayoutMode
  manualExpandedIds: string[]
  expandedDialogId: string | null
  selectInstrument: (id: string, options?: { expandFixed?: boolean }) => void
  setLayoutMode: (mode: DockLayoutMode) => void
  collapseManualFixed: (id: string) => void
  setExpandedDialogId: (id: string | null) => void
  resetDock: () => void
}

export const instrumentDockStore = createStore<InstrumentDockState>()((set, get) => ({
  primaryId: null,
  secondaryId: null,
  layoutMode: 'single',
  manualExpandedIds: [],
  expandedDialogId: null,
  selectInstrument: (id, options) => {
    const state = get()
    const manualExpandedIds =
      options?.expandFixed && !state.manualExpandedIds.includes(id)
        ? [...state.manualExpandedIds, id]
        : state.manualExpandedIds
    if (state.primaryId === id) {
      if (manualExpandedIds !== state.manualExpandedIds) set({ manualExpandedIds })
      return
    }
    const nextSecondary = state.primaryId && state.primaryId !== id ? state.primaryId : state.secondaryId
    set({
      primaryId: id,
      secondaryId: nextSecondary === id ? null : nextSecondary,
      manualExpandedIds,
    })
  },
  setLayoutMode: (layoutMode) => {
    if (get().layoutMode === layoutMode) return
    set({ layoutMode })
  },
  collapseManualFixed: (id) => {
    const state = get()
    if (!state.manualExpandedIds.includes(id)) return
    set({
      manualExpandedIds: state.manualExpandedIds.filter((item) => item !== id),
      primaryId: state.primaryId === id ? null : state.primaryId,
      secondaryId: state.secondaryId === id ? null : state.secondaryId,
      expandedDialogId: state.expandedDialogId === id ? null : state.expandedDialogId,
    })
  },
  setExpandedDialogId: (expandedDialogId) => {
    if (get().expandedDialogId === expandedDialogId) return
    set({ expandedDialogId })
  },
  resetDock: () =>
    set({
      primaryId: null,
      secondaryId: null,
      layoutMode: 'single',
      manualExpandedIds: [],
      expandedDialogId: null,
    }),
}))

export function useInstrumentDock<T>(selector: (state: InstrumentDockState) => T): T {
  return useStore(instrumentDockStore, selector)
}

function projectPrimarySupplyIds(panels: readonly PanelDef[], project?: Project): Set<string> {
  const result = new Set<string>()
  const acReferenced = Boolean(
    project?.reference.nets.some((net) => net.some((ref) => ref.startsWith('ins-ac-power.'))),
  )
  const dcReferenced = Boolean(
    project?.reference.nets.some((net) => net.some((ref) => ref.startsWith('ins-dc-power.'))),
  )
  for (const panel of panels) {
    if (panel.instrument.kind === 'dcSupply' && (!acReferenced || dcReferenced)) {
      result.add(panel.id)
    }
    if (panel.instrument.kind === 'acSupply' && acReferenced) {
      result.add(panel.id)
    }
  }
  if (result.size === 0) {
    const fallback = panels.find(
      (panel) => panel.instrument.kind === 'dcSupply' || panel.instrument.kind === 'acSupply',
    )
    if (fallback) result.add(fallback.id)
  }
  return result
}

function dockPanelPriority(
  panel: PanelDef,
  wiredIds: ReadonlySet<string>,
  primarySupplies: ReadonlySet<string>,
  manualIds: ReadonlySet<string>,
): number {
  if (panel.instrument.mounting === 'desktop') {
    return panel.instrument.scope ? 0 : 1
  }
  if (primarySupplies.has(panel.id)) return 2
  if (wiredIds.has(panel.id)) return 3
  if (manualIds.has(panel.id)) return 4
  return 5
}

export interface ResolvedDockPanels {
  activePanels: PanelDef[]
  inactiveFixedPanels: PanelDef[]
  primaryPanel: PanelDef | null
  secondaryPanel: PanelDef | null
  displayedPanels: PanelDef[]
}

/**
 * 解析底栏活跃仪器集合与当前单/双表展示区（T1.9B，DESIGN.md、技术设计 §11）。
 * 活跃集合 = 已放置台式表 ∪ 项目主电源 ∪ 已接线固定表 ∪ 用户手动展开的固定表。
 */
export function resolveDockPanels(
  panels: readonly PanelDef[],
  wiredIds: ReadonlySet<string>,
  state: Pick<InstrumentDockState, 'primaryId' | 'secondaryId' | 'layoutMode' | 'manualExpandedIds'>,
  project?: Project,
): ResolvedDockPanels {
  const primarySupplies = projectPrimarySupplyIds(panels, project)
  const manualIds = new Set(state.manualExpandedIds)
  const scored = panels.map((panel, index) => ({
    panel,
    index,
    priority: dockPanelPriority(panel, wiredIds, primarySupplies, manualIds),
  }))
  scored.sort((a, b) => a.priority - b.priority || a.index - b.index)

  const activePanels = scored.filter((item) => item.priority <= 4).map((item) => item.panel)
  const inactiveFixedPanels = scored.filter((item) => item.priority === 5).map((item) => item.panel)

  const primaryPanel = activePanels.find((panel) => panel.id === state.primaryId) ?? activePanels[0] ?? null
  const secondaryPanel =
    state.layoutMode === 'dual' && primaryPanel && activePanels.length >= 2
      ? (activePanels.find((panel) => panel.id === state.secondaryId && panel.id !== primaryPanel.id) ??
        activePanels.find((panel) => panel.id !== primaryPanel.id) ??
        null)
      : null

  const displayedPanels = [primaryPanel, secondaryPanel].filter((panel): panel is PanelDef => panel !== null)
  return { activePanels, inactiveFixedPanels, primaryPanel, secondaryPanel, displayedPanels }
}
