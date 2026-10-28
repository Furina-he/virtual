const { app, BrowserWindow, session } = require('electron')

app.setPath('userData', process.env.ASSET_EXPORT_USER_DATA)
app.whenReady().then(async () => {
  const origin = new URL(process.env.ASSET_EXPORT_URL).origin
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${origin}/`) || /^(data|blob):/.test(details.url)
    callback({ cancel: !allowed })
  })
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  await window.loadURL(process.env.ASSET_EXPORT_URL)
})
app.on('window-all-closed', () => app.quit())
