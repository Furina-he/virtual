import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { useQuality } from '@/three/quality-store'
import { Settings } from '../../shared/schema/settings'

export type SettingsStoreState = {
  settings: Settings
  userDataDir: string
  hydrated: boolean
  settingsOpen: boolean
  aboutOpen: boolean
  commandOpen: boolean
  presentationMode: boolean
  hydrate: () => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  setPresentationMode: (enabled: boolean) => Promise<void>
  togglePresentationMode: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setAboutOpen: (open: boolean) => void
  setCommandOpen: (open: boolean) => void
}

function applyDocumentSettings(settings: Settings): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', settings.theme === 'dark')
  document.documentElement.dataset.fontScale = String(settings.fontScale)
  document.documentElement.dataset.theme = settings.theme
  document.documentElement.dataset.presentationMode = settings.fontScale === 1.25 ? 'on' : 'off'
}

const defaults = Settings.parse({})

export const settingsStore = createStore<SettingsStoreState>()((set, get) => ({
  settings: defaults,
  userDataDir: '',
  hydrated: false,
  settingsOpen: false,
  aboutOpen: false,
  commandOpen: false,
  presentationMode: false,
  hydrate: async () => {
    try {
      const result = await window.api.storage.readSettings()
      const currentQuality = useQuality.getState().quality
      const resolved = result.exists ? result.settings : { ...result.settings, quality: currentQuality }
      applyDocumentSettings(resolved)
      if (result.exists) useQuality.getState().setQuality(resolved.quality)
      set({
        settings: resolved,
        userDataDir: result.userDataDir,
        hydrated: true,
        presentationMode: resolved.fontScale === 1.25,
      })
    } catch {
      applyDocumentSettings(defaults)
      set({ hydrated: true })
    }
  },
  updateSettings: async (patch) => {
    const next = Settings.parse({ ...get().settings, ...patch })
    applyDocumentSettings(next)
    if (patch.quality) useQuality.getState().setQuality(patch.quality)
    set({
      settings: next,
      presentationMode: next.fontScale === 1.25,
    })
    try {
      const persisted = await window.api.storage.writeSettings(patch)
      applyDocumentSettings(persisted)
      set({
        settings: persisted,
        presentationMode: persisted.fontScale === 1.25,
      })
    } catch {
      // 内存态已即时生效，持久化失败不阻断当前课堂演示
    }
  },
  setPresentationMode: async (enabled) => {
    await get().updateSettings({ fontScale: enabled ? 1.25 : 1 })
  },
  togglePresentationMode: async () => {
    await get().setPresentationMode(!get().presentationMode)
  },
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setAboutOpen: (open) => set({ aboutOpen: open }),
  setCommandOpen: (open) => set({ commandOpen: open }),
}))

export function useSettings<T>(selector: (state: SettingsStoreState) => T): T {
  return useStore(settingsStore, selector)
}
