import type { SaveFile } from '../schema/save'
import type { Settings } from '../schema/settings'

export type SaveSummary = {
  projectId: string
  updatedAt: string
  completedSteps: number
  wireCount: number
  hasManualSave: boolean
  hasAutosave: boolean
  autosaveUpdatedAt?: string
}

export type WriteSaveResult =
  | { ok: true; filePath: string; updatedAt: string; message: string }
  | { ok: false; message: string }

export type LoadSaveResult =
  | { status: 'ok'; save: SaveFile }
  | { status: 'missing' }
  | { status: 'corrupt'; message: string }

export type RecoveryCheckResult = {
  projectId: string
  hasAutosave: boolean
  autosaveCorrupt: boolean
  corruptMessage?: string
  autosave?: SaveFile
  hasManualSave: boolean
  manualSaveCorrupt: boolean
  manualSave?: SaveFile
}

export type SettingsReadResult = {
  settings: Settings
  exists: boolean
  corruptFallback: boolean
  userDataDir: string
}
