import { contextBridge } from 'electron'
import { panels, sync } from './panels'
import { sim } from './sim'

// 类型化 IPC 桥，T0.3 起按 src/shared/ipc 补充
const api = {
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  panels,
  sync,
  sim,
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
