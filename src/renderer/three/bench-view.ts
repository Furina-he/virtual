import { create } from 'zustand'
import type { CameraPreset } from './asset-catalog'

/** 预设视角或某台设备的正对特写（技术设计 §10.3）。 */
export type ViewPreset = CameraPreset | `focus:${string}`

interface BenchViewState {
  preset: ViewPreset | null
  /** Bumped on every request so re-selecting the current preset still moves the camera. */
  request: number
  hoveredJack: string | null
  hoveredWire: string | null
  hoveredControl: string | null
  /** Close-up only: jacks near the pointer that show a small screen label (技术设计 §10.3). */
  nearbyJacks: readonly string[]
  /** Right-click on a wire, in client px. */
  wireMenu: { id: string; x: number; y: number } | null
  /** Dashed reference cords for the current step (PRD WIR-08). */
  showGuide: boolean
  setPreset: (preset: ViewPreset | null) => void
  focus: (instanceId: string) => void
  /** Esc: leave a device close-up for the work view. Returns false when nothing changed. */
  leaveFocus: () => boolean
  setHover: (patch: Partial<Pick<BenchViewState, 'hoveredJack' | 'hoveredWire' | 'hoveredControl'>>) => void
  setNearbyJacks: (ids: readonly string[]) => void
  setWireMenu: (menu: BenchViewState['wireMenu']) => void
  toggleGuide: () => void
  setShowGuide: (show: boolean) => void
}

const none: readonly string[] = []

/** Transient view state; it never enters the circuit undo history. */
export const useBenchView = create<BenchViewState>()((set, get) => ({
  preset: 'work',
  request: 0,
  hoveredJack: null,
  hoveredWire: null,
  hoveredControl: null,
  nearbyJacks: none,
  wireMenu: null,
  showGuide: false,
  setPreset: (preset) =>
    set({
      preset,
      request: preset ? get().request + 1 : get().request,
      nearbyJacks: preset ? none : get().nearbyJacks,
    }),
  focus: (instanceId) => set({ preset: `focus:${instanceId}`, request: get().request + 1, nearbyJacks: none }),
  leaveFocus: () => {
    if (get().preset === 'work') return false
    set({ preset: 'work', request: get().request + 1, nearbyJacks: none })
    return true
  },
  setHover: (patch) => {
    const state = get()
    if (Object.entries(patch).every(([key, value]) => state[key as keyof typeof patch] === value)) return
    set(patch)
  },
  setWireMenu: (wireMenu) => set({ wireMenu }),
  toggleGuide: () => set({ showGuide: !get().showGuide }),
  setShowGuide: (showGuide) => {
    if (get().showGuide === showGuide) return
    set({ showGuide })
  },
  setNearbyJacks: (ids) => {
    const current = get().nearbyJacks
    if (ids.length === current.length && ids.every((id, index) => current[index] === id)) return
    set({ nearbyJacks: ids.length ? ids : none })
  },
}))

export function focusedInstance(preset: ViewPreset | null) {
  return preset?.startsWith('focus:') ? preset.slice('focus:'.length) : null
}
