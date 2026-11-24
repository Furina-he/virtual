import type { WiringIssue } from '@domain/wiring-check'
import { create } from 'zustand'
import type { CameraPreset } from './asset-catalog'
import type { PlacedJackLabel } from './jack-label-layout'

/** 预设视角或某台设备的正对特写（技术设计 §10.3）。 */
export type ViewPreset = CameraPreset | `focus:${string}`

export interface HighlightedDiagnosticLink {
  jacks: readonly string[]
  guidePair?: readonly [string, string]
  /** 过程提示类高亮在自主模式下会被严格屏蔽，仅安全告警允许。 */
  source?: 'diagnostic' | 'step' | 'danger'
}

interface BenchViewState {
  preset: ViewPreset | null
  /** Bumped on every request so re-selecting the current preset still moves the camera. */
  request: number
  hoveredJack: string | null
  hoveredWire: string | null
  hoveredControl: string | null
  /** Close-up only: jacks near the pointer that show a small screen label (技术设计 §10.3). */
  nearbyJacks: readonly string[]
  /** Close-up persistent anti-overlap jack labels for the focused device (T1.9B). */
  persistentLabels: readonly PlacedJackLabel[]
  /** Right-click on a wire, in client px. */
  wireMenu: { id: string; x: number; y: number } | null
  /** In-place Popover for clicking a 3D instrument knob (T1.9B, eliminates wheel-zoom conflict). */
  activeKnobPopover: { instanceId: string; anchorName: string; controlKey: string; x: number; y: number } | null
  /** Dashed reference cords for the current step (PRD WIR-08). */
  showGuide: boolean
  /** Translucent non-active cords to uncover silkscreen and lower jacks (T1.9A). */
  wireXRay: boolean
  /** Persistent anti-overlap jack labels in device close-up (T1.9B). */
  showJackLabels: boolean
  /** Alt held for temporary wire X-Ray and plug-end replugging (T1.9A). */
  altHeld: boolean
  /** Structured wiring check issues for right-panel locatable diagnostic list (T1.9B). */
  diagnosticIssues: readonly WiringIssue[]
  /** Matches circuitStore.notice when structured diagnosticIssues are the latest message. */
  diagnosticNotice: string | null
  /** Single hovered/located diagnostic or step endpoint pair highlighted in 3D (T1.9B). */
  highlightedLink: HighlightedDiagnosticLink | null
  /** Jack currently pulsing after clicking [定位] (T1.9B). */
  pulsingJack: string | null
  setPreset: (preset: ViewPreset | null) => void
  focus: (instanceId: string) => void
  /** Esc: leave a device close-up for the work view. Returns false when nothing changed. */
  leaveFocus: () => boolean
  setHover: (patch: Partial<Pick<BenchViewState, 'hoveredJack' | 'hoveredWire' | 'hoveredControl'>>) => void
  setNearbyJacks: (ids: readonly string[]) => void
  setPersistentLabels: (labels: readonly PlacedJackLabel[]) => void
  setWireMenu: (menu: BenchViewState['wireMenu']) => void
  setActiveKnobPopover: (popover: BenchViewState['activeKnobPopover']) => void
  toggleGuide: () => void
  setShowGuide: (show: boolean) => void
  toggleWireXRay: () => void
  setWireXRay: (enabled: boolean) => void
  toggleJackLabels: () => void
  setShowJackLabels: (show: boolean) => void
  setAltHeld: (held: boolean) => void
  setDiagnosticIssues: (issues: readonly WiringIssue[], notice?: string | null) => void
  setHighlightedLink: (link: HighlightedDiagnosticLink | null) => void
  locateJack: (
    jackRef: string,
    guidePair?: readonly [string, string],
    source?: HighlightedDiagnosticLink['source'],
  ) => void
  clearDiagnostics: () => void
}

const none: readonly string[] = []
const noLabels: readonly PlacedJackLabel[] = []
const noIssues: readonly WiringIssue[] = []
let pulseTimer: ReturnType<typeof setTimeout> | null = null

/** Transient view state; it never enters the circuit undo history. */
export const useBenchView = create<BenchViewState>()((set, get) => ({
  preset: 'work',
  request: 0,
  hoveredJack: null,
  hoveredWire: null,
  hoveredControl: null,
  nearbyJacks: none,
  persistentLabels: noLabels,
  wireMenu: null,
  activeKnobPopover: null,
  showGuide: false,
  wireXRay: false,
  showJackLabels: true,
  altHeld: false,
  diagnosticIssues: noIssues,
  diagnosticNotice: null,
  highlightedLink: null,
  pulsingJack: null,
  setPreset: (preset) =>
    set({
      preset,
      request: preset ? get().request + 1 : get().request,
      nearbyJacks: preset ? none : get().nearbyJacks,
      persistentLabels: preset && !preset.startsWith('focus:') ? noLabels : get().persistentLabels,
      activeKnobPopover: null,
    }),
  focus: (instanceId) =>
    set({
      preset: `focus:${instanceId}`,
      request: get().request + 1,
      nearbyJacks: none,
      persistentLabels: noLabels,
      activeKnobPopover: null,
    }),
  leaveFocus: () => {
    if (get().preset === 'work') return false
    set({
      preset: 'work',
      request: get().request + 1,
      nearbyJacks: none,
      persistentLabels: noLabels,
      activeKnobPopover: null,
    })
    return true
  },
  setHover: (patch) => {
    const state = get()
    if (Object.entries(patch).every(([key, value]) => state[key as keyof typeof patch] === value)) return
    set(patch)
  },
  setWireMenu: (wireMenu) => set({ wireMenu }),
  setActiveKnobPopover: (activeKnobPopover) => set({ activeKnobPopover }),
  toggleGuide: () => set({ showGuide: !get().showGuide }),
  setShowGuide: (showGuide) => {
    if (get().showGuide === showGuide) return
    set({ showGuide })
  },
  toggleWireXRay: () => set({ wireXRay: !get().wireXRay }),
  setWireXRay: (wireXRay) => {
    if (get().wireXRay === wireXRay) return
    set({ wireXRay })
  },
  toggleJackLabels: () => {
    const next = !get().showJackLabels
    set({ showJackLabels: next, ...(next ? {} : { nearbyJacks: none, persistentLabels: noLabels }) })
  },
  setShowJackLabels: (showJackLabels) => {
    if (get().showJackLabels === showJackLabels) return
    set({ showJackLabels, ...(showJackLabels ? {} : { nearbyJacks: none, persistentLabels: noLabels }) })
  },
  setAltHeld: (altHeld) => {
    if (get().altHeld === altHeld) return
    set({ altHeld })
  },
  setDiagnosticIssues: (issues, notice = null) =>
    set({
      diagnosticIssues: issues.length ? issues : noIssues,
      diagnosticNotice: issues.length ? notice : null,
    }),
  setHighlightedLink: (highlightedLink) => set({ highlightedLink }),
  locateJack: (jackRef, guidePair, source = 'diagnostic') => {
    const dot = jackRef.indexOf('.')
    const instanceId = dot > 0 ? jackRef.slice(0, dot) : null
    if (pulseTimer) clearTimeout(pulseTimer)
    set({
      ...(instanceId
        ? {
            preset: `focus:${instanceId}` as ViewPreset,
            request: get().request + 1,
            nearbyJacks: none,
            persistentLabels: noLabels,
            activeKnobPopover: null,
          }
        : {}),
      pulsingJack: jackRef,
      highlightedLink: {
        jacks: guidePair ? [...guidePair] : [jackRef],
        guidePair,
        source,
      },
    })
    pulseTimer = setTimeout(() => {
      pulseTimer = null
      if (get().pulsingJack === jackRef) set({ pulsingJack: null })
    }, 2400)
  },
  clearDiagnostics: () => {
    if (pulseTimer) {
      clearTimeout(pulseTimer)
      pulseTimer = null
    }
    set({ diagnosticIssues: noIssues, diagnosticNotice: null, highlightedLink: null, pulsingJack: null })
  },
  setNearbyJacks: (ids) => {
    const current = get().nearbyJacks
    if (ids.length === current.length && ids.every((id, index) => current[index] === id)) return
    set({ nearbyJacks: ids.length ? ids : none })
  },
  setPersistentLabels: (labels) => {
    const current = get().persistentLabels
    if (
      labels.length === current.length &&
      labels.every(
        (item, index) =>
          current[index]?.id === item.id &&
          current[index]?.offsetX === item.offsetX &&
          current[index]?.offsetY === item.offsetY,
      )
    ) {
      return
    }
    set({ persistentLabels: labels.length ? labels : noLabels })
  },
}))

export function focusedInstance(preset: ViewPreset | null) {
  return preset?.startsWith('focus:') ? preset.slice('focus:'.length) : null
}
