import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export function appIconPath(): string | undefined {
  const filename = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const candidate = app.isPackaged
    ? join(process.resourcesPath, filename)
    : join(app.getAppPath(), 'resources', filename)
  return existsSync(candidate) ? candidate : undefined
}
