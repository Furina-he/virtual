import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, ipcMain } from 'electron'
import type {
  LoadSaveResult,
  RecoveryCheckResult,
  SaveSummary,
  SettingsReadResult,
  WriteSaveResult,
} from '../shared/ipc/storage'
import { ProjectId } from '../shared/schema/project'
import { SaveFile } from '../shared/schema/save'
import { Settings } from '../shared/schema/settings'

const SAVE_JSON_RE = /^((?:DG|MD|SD)-\d{2})\.json$/
const AUTOSAVE_RE = /^((?:DG|MD|SD)-\d{2})\.autosave$/

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  const dir = join(filePath, '..')
  await mkdir(dir, { recursive: true })
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  const content = `${JSON.stringify(payload, null, 2)}\n`
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

export class ProjectStorage {
  readonly userDataDir: string
  readonly savesDir: string
  readonly settingsPath: string

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir
    this.savesDir = join(userDataDir, 'saves')
    this.settingsPath = join(userDataDir, 'settings.json')
  }

  private assertProjectId(projectId: string): string {
    return ProjectId.parse(projectId)
  }

  manualSavePath(projectId: string): string {
    const id = this.assertProjectId(projectId)
    return join(this.savesDir, `${id}.json`)
  }

  autosavePath(projectId: string): string {
    const id = this.assertProjectId(projectId)
    return join(this.savesDir, `${id}.autosave`)
  }

  private async readSaveFile(filePath: string): Promise<LoadSaveResult> {
    let rawText: string
    try {
      rawText = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isEnoent(error)) return { status: 'missing' }
      return {
        status: 'corrupt',
        message: `无法读取存档文件：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    try {
      const json: unknown = JSON.parse(rawText)
      const parsed = SaveFile.safeParse(json)
      if (!parsed.success) {
        return { status: 'corrupt', message: '存档文件版本或数据结构校验失败，已拒绝加载损坏内容。' }
      }
      return { status: 'ok', save: parsed.data }
    } catch {
      return { status: 'corrupt', message: '存档文件 JSON 已损坏或写入中断，已安全回退。' }
    }
  }

  async saveManual(rawSave: unknown): Promise<WriteSaveResult> {
    const parsed = SaveFile.safeParse(rawSave)
    if (!parsed.success) {
      return { ok: false, message: '存档数据校验失败，未写入磁盘。' }
    }
    const save = parsed.data
    const filePath = this.manualSavePath(save.projectId)
    try {
      await atomicWriteJson(filePath, save)
      // 手动保存成功后清除旧的自动存档，避免下次重复提示恢复
      await this.clearAutosave(save.projectId)
      return {
        ok: true,
        filePath,
        updatedAt: save.updatedAt,
        message: `已保存 ${save.projectId} 实训进度。`,
      }
    } catch (error) {
      return {
        ok: false,
        message: `保存进度失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async loadManual(projectId: string): Promise<LoadSaveResult> {
    try {
      return await this.readSaveFile(this.manualSavePath(projectId))
    } catch {
      return { status: 'corrupt', message: '项目编号无效。' }
    }
  }

  async writeAutosave(rawSave: unknown): Promise<WriteSaveResult> {
    const parsed = SaveFile.safeParse(rawSave)
    if (!parsed.success) {
      return { ok: false, message: '自动存档数据校验失败。' }
    }
    const save = parsed.data
    const filePath = this.autosavePath(save.projectId)
    try {
      await atomicWriteJson(filePath, save)
      return {
        ok: true,
        filePath,
        updatedAt: save.updatedAt,
        message: `已自动存档 ${save.projectId}。`,
      }
    } catch (error) {
      return {
        ok: false,
        message: `自动存档失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async readAutosave(projectId: string): Promise<LoadSaveResult> {
    try {
      return await this.readSaveFile(this.autosavePath(projectId))
    } catch {
      return { status: 'corrupt', message: '项目编号无效。' }
    }
  }

  async clearAutosave(projectId: string): Promise<void> {
    try {
      const filePath = this.autosavePath(projectId)
      await unlink(filePath)
    } catch (error) {
      if (!isEnoent(error)) throw error
    }
  }

  async checkRecovery(projectId: string): Promise<RecoveryCheckResult> {
    const id = this.assertProjectId(projectId)
    const [autoRes, manualRes] = await Promise.all([this.readAutosave(id), this.loadManual(id)])
    return {
      projectId: id,
      hasAutosave: autoRes.status === 'ok',
      autosaveCorrupt: autoRes.status === 'corrupt',
      ...(autoRes.status === 'corrupt' ? { corruptMessage: autoRes.message } : {}),
      ...(autoRes.status === 'ok' ? { autosave: autoRes.save } : {}),
      hasManualSave: manualRes.status === 'ok',
      manualSaveCorrupt: manualRes.status === 'corrupt',
      ...(manualRes.status === 'ok' ? { manualSave: manualRes.save } : {}),
    }
  }

  async listSaves(): Promise<SaveSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(this.savesDir)
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }

    const projectIds = new Set<string>()
    for (const name of entries) {
      const m1 = SAVE_JSON_RE.exec(name)
      if (m1?.[1]) projectIds.add(m1[1])
      const m2 = AUTOSAVE_RE.exec(name)
      if (m2?.[1]) projectIds.add(m2[1])
    }

    const summaries: SaveSummary[] = []
    for (const id of projectIds) {
      const [manual, auto] = await Promise.all([this.loadManual(id), this.readAutosave(id)])
      const manualSave = manual.status === 'ok' ? manual.save : undefined
      const autoSave = auto.status === 'ok' ? auto.save : undefined
      const latest =
        autoSave && manualSave
          ? autoSave.updatedAt >= manualSave.updatedAt
            ? autoSave
            : manualSave
          : (autoSave ?? manualSave)
      if (!latest) continue
      summaries.push({
        projectId: id,
        updatedAt: latest.updatedAt,
        completedSteps: latest.completedSteps.length,
        wireCount: latest.circuit.wires.length,
        hasManualSave: Boolean(manualSave),
        hasAutosave: Boolean(autoSave),
        ...(autoSave ? { autosaveUpdatedAt: autoSave.updatedAt } : {}),
      })
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async readSettings(): Promise<SettingsReadResult> {
    const defaults = Settings.parse({})
    try {
      const rawText = await readFile(this.settingsPath, 'utf8')
      const parsed = Settings.safeParse(JSON.parse(rawText))
      if (!parsed.success) {
        return { settings: defaults, exists: false, corruptFallback: true, userDataDir: this.userDataDir }
      }
      return { settings: parsed.data, exists: true, corruptFallback: false, userDataDir: this.userDataDir }
    } catch (error) {
      if (isEnoent(error)) {
        return { settings: defaults, exists: false, corruptFallback: false, userDataDir: this.userDataDir }
      }
      return { settings: defaults, exists: false, corruptFallback: true, userDataDir: this.userDataDir }
    }
  }

  async writeSettings(patch: unknown): Promise<Settings> {
    const current = await this.readSettings()
    const merged = Settings.parse({
      ...current.settings,
      ...(typeof patch === 'object' && patch !== null ? patch : {}),
    })
    await atomicWriteJson(this.settingsPath, merged)
    return merged
  }
}

export function registerStorageHandlers(): ProjectStorage {
  const storage = new ProjectStorage(app.getPath('userData'))

  ipcMain.handle('storage:saveManual', (_e, rawSave: unknown) => storage.saveManual(rawSave))
  ipcMain.handle('storage:loadManual', (_e, projectId: unknown) =>
    typeof projectId === 'string'
      ? storage.loadManual(projectId)
      : ({ status: 'corrupt', message: '项目编号无效。' } satisfies LoadSaveResult),
  )
  ipcMain.handle('storage:writeAutosave', (_e, rawSave: unknown) => storage.writeAutosave(rawSave))
  ipcMain.handle('storage:readAutosave', (_e, projectId: unknown) =>
    typeof projectId === 'string'
      ? storage.readAutosave(projectId)
      : ({ status: 'corrupt', message: '项目编号无效。' } satisfies LoadSaveResult),
  )
  ipcMain.handle('storage:clearAutosave', async (_e, projectId: unknown) => {
    if (typeof projectId === 'string') await storage.clearAutosave(projectId)
  })
  ipcMain.handle('storage:checkRecovery', (_e, projectId: unknown) => {
    if (typeof projectId !== 'string') throw new Error('项目编号无效。')
    return storage.checkRecovery(projectId)
  })
  ipcMain.handle('storage:listSaves', () => storage.listSaves())
  ipcMain.handle('storage:readSettings', () => storage.readSettings())
  ipcMain.handle('storage:writeSettings', (_e, patch: unknown) => storage.writeSettings(patch))

  return storage
}
