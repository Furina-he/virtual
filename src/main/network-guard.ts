import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, type Session } from 'electron'

// NFR-09：运行时不得访问外网。只放行本地协议和开发服务器，其余请求一律拒绝并记日志。
const ALLOWED_PROTOCOLS = new Set(['file:', 'devtools:', 'chrome-extension:', 'data:', 'blob:'])

export function blockedLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'network-blocked.log')
}

function isAllowed(url: string, devServer: string | undefined): boolean {
  if (devServer && url.startsWith(devServer)) return true
  try {
    const { protocol, hostname } = new URL(url)
    if (ALLOWED_PROTOCOLS.has(protocol)) return true
    // 开发时 Vite HMR 走 ws://localhost
    return devServer !== undefined && (hostname === 'localhost' || hostname === '127.0.0.1')
  } catch {
    return false
  }
}

export function installNetworkGuard(session: Session, devServer: string | undefined): void {
  const logFile = blockedLogPath()
  mkdirSync(join(logFile, '..'), { recursive: true })
  session.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowed(details.url, devServer)) {
      callback({})
      return
    }
    appendFileSync(logFile, `${new Date().toISOString()}\t${details.resourceType}\t${details.url}\n`)
    callback({ cancel: true })
  })
}
