import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { installNetworkGuard } from './network-guard'
import { registerPanelWindows } from './panel-windows'
import { SimHost } from './sim-host'

const devServer = process.env.ELECTRON_RENDERER_URL

// e2e 用独立数据目录，避免污染本机数据
if (process.env.VIRTUAL_USER_DATA) app.setPath('userData', process.env.VIRTUAL_USER_DATA)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  // 主窗口关闭时一并关闭弹出的仪表窗口
  win.on('closed', () => app.quit())
  // 外部链接不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (devServer) void win.loadURL(devServer)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  installNetworkGuard(session.defaultSession, devServer)
  registerPanelWindows()
  const sim = new SimHost()
  sim.start()
  // e2e 通过 app.evaluate 读取 sim 进程 pid
  if (process.env.VIRTUAL_USER_DATA) Object.assign(globalThis, { __virtualSim: sim })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
