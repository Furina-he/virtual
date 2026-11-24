import { ipcRenderer } from 'electron'
import type {
  LoadSaveResult,
  RecoveryCheckResult,
  SaveSummary,
  SettingsReadResult,
  WriteSaveResult,
} from '../shared/ipc/storage'
import type { SaveFile } from '../shared/schema/save'
import type { Settings } from '../shared/schema/settings'

export const storage = {
  saveManual: (save: SaveFile): Promise<WriteSaveResult> => ipcRenderer.invoke('storage:saveManual', save),
  loadManual: (projectId: string): Promise<LoadSaveResult> => ipcRenderer.invoke('storage:loadManual', projectId),
  writeAutosave: (save: SaveFile): Promise<WriteSaveResult> => ipcRenderer.invoke('storage:writeAutosave', save),
  readAutosave: (projectId: string): Promise<LoadSaveResult> => ipcRenderer.invoke('storage:readAutosave', projectId),
  clearAutosave: (projectId: string): Promise<void> => ipcRenderer.invoke('storage:clearAutosave', projectId),
  checkRecovery: (projectId: string): Promise<RecoveryCheckResult> =>
    ipcRenderer.invoke('storage:checkRecovery', projectId),
  listSaves: (): Promise<SaveSummary[]> => ipcRenderer.invoke('storage:listSaves'),
  readSettings: (): Promise<SettingsReadResult> => ipcRenderer.invoke('storage:readSettings'),
  writeSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('storage:writeSettings', patch),
}
