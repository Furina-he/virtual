import { ipcRenderer } from 'electron'

const PANEL_ID = /^[a-z][a-z0-9-]*$/

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

// 仪表面板弹出窗口（ADR-007）与窗口间状态同步
export const panels = {
  popout: (panelId: string, title: string): Promise<boolean> => {
    if (!PANEL_ID.test(panelId)) return Promise.resolve(false)
    return ipcRenderer.invoke('panels:popout', panelId, title)
  },
  close: (panelId: string): Promise<void> => ipcRenderer.invoke('panels:close', panelId),
  list: (): Promise<string[]> => ipcRenderer.invoke('panels:list'),
  onOpened: (listener: (panelId: string) => void) => subscribe('panels:opened', listener),
  onClosed: (listener: (panelId: string) => void) => subscribe('panels:closed', listener),
}

export const sync = {
  publish: (key: string, state: unknown): void => ipcRenderer.send('sync:publish', key, state),
  get: (key: string): Promise<unknown> => ipcRenderer.invoke('sync:get', key),
  onUpdate: (listener: (msg: { key: string; state: unknown }) => void) => subscribe('sync:update', listener),
}
