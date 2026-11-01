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
  setPreset: (preset: ViewPreset | null) => void
  focus: (instanceId: string) => void
  /** Esc: leave a device close-up for the work view. Returns false when nothing changed. */
  leaveFocus: () => boolean
  setHover: (patch: Partial<Pick<BenchViewState, 'hoveredJack' | 'hoveredWire' | 'hoveredControl'>>) => void
}

/** Transient view state; it never enters the circuit undo history. */
export const useBenchView = create<BenchViewState>()((set, get) => ({
  preset: 'work',
  request: 0,
  hoveredJack: null,
  hoveredWire: null,
  hoveredControl: null,
  setPreset: (preset) => set({ preset, request: preset ? get().request + 1 : get().request }),
  focus: (instanceId) => set({ preset: `focus:${instanceId}`, request: get().request + 1 }),
  leaveFocus: () => {
    if (get().preset === 'work') return false
    set({ preset: 'work', request: get().request + 1 })
    return true
  },
  setHover: (patch) => {
    const state = get()
    if (Object.entries(patch).every(([key, value]) => state[key as keyof typeof patch] === value)) return
    set(patch)
  },
}))

export function focusedInstance(preset: ViewPreset | null) {
  return preset?.startsWith('focus:') ? preset.slice('focus:'.length) : null
}
