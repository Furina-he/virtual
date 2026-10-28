import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'

// ADR-007：底栏仪表面板"弹出"= 新 BrowserWindow，关闭即回到底栏。
// 各窗口之间的面板状态经 main 转发，main 缓存最新值供新窗口初始化。

const devServer = process.env.ELECTRON_RENDERER_URL
const panelWindows = new Map<string, BrowserWindow>()
const syncCache = new Map<string, unknown>()

export const PANEL_ID = /^[a-z][a-z0-9-]*$/

export function secureWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
}

export function loadRoute(win: BrowserWindow, hash: string): void {
  if (devServer) void win.loadURL(`${devServer}#${hash}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

function broadcast(channel: string, payload: unknown, except?: Electron.WebContents): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed() && w.webContents !== except) w.webContents.send(channel, payload)
}

export function registerPanelWindows(): void {
  ipcMain.handle('panels:popout', (_e, panelId: unknown, title: unknown) => {
    if (typeof panelId !== 'string' || !PANEL_ID.test(panelId)) return false
    const existing = panelWindows.get(panelId)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return true
    }
    const win = new BrowserWindow({
      width: 640,
      height: 480,
      minWidth: 320,
      minHeight: 240,
      title: typeof title === 'string' ? title : panelId,
      autoHideMenuBar: true,
      webPreferences: secureWebPreferences(),
    })
    panelWindows.set(panelId, win)
    loadRoute(win, `/panel/${panelId}`)
    broadcast('panels:opened', panelId)
    win.on('closed', () => {
      panelWindows.delete(panelId)
      broadcast('panels:closed', panelId)
    })
    return true
  })

  ipcMain.handle('panels:close', (_e, panelId: unknown) => {
    if (typeof panelId === 'string') panelWindows.get(panelId)?.close()
  })

  ipcMain.handle('panels:list', () => [...panelWindows.keys()])

  ipcMain.on('sync:publish', (e, key: unknown, state: unknown) => {
    if (typeof key !== 'string') return
    syncCache.set(key, state)
    broadcast('sync:update', { key, state }, e.sender)
  })

  ipcMain.handle('sync:get', (_e, key: unknown) => (typeof key === 'string' ? syncCache.get(key) : undefined))
}
