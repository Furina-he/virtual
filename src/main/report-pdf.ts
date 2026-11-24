import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { defaultReportFilename } from '../domain/task/report'
import { type ExportReportResult, type LabReportPayload, LabReportSchema } from '../shared/ipc/report'
import { loadRoute, secureWebPreferences } from './panel-windows'

const pendingJobs = new Map<string, LabReportPayload>()
const PRINT_TIMEOUT_MS = 20_000

async function atomicWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tempPath = join(dir, `.report-${process.pid}-${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, data)
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

async function renderReportToPdfBuffer(payload: LabReportPayload): Promise<Buffer> {
  const jobId = randomUUID()
  pendingJobs.set(jobId, payload)

  const printWin = new BrowserWindow({
    width: 960,
    height: 1200,
    show: false,
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(),
  })

  try {
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('report:ready', onReady)
        reject(new Error('报告渲染超时，未能生成 PDF。'))
      }, PRINT_TIMEOUT_MS)

      const onReady = (_event: Electron.IpcMainEvent, readyId: unknown) => {
        if (readyId !== jobId) return
        clearTimeout(timer)
        ipcMain.removeListener('report:ready', onReady)
        resolve()
      }

      ipcMain.on('report:ready', onReady)
      printWin.webContents.once('did-fail-load', (_e, _code, description) => {
        clearTimeout(timer)
        ipcMain.removeListener('report:ready', onReady)
        reject(new Error(`报告打印视图加载失败：${description}`))
      })
    })

    loadRoute(printWin, `/report-print/${jobId}`)
    await readyPromise

    const pdfData = await printWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    })
    return Buffer.from(pdfData)
  } finally {
    pendingJobs.delete(jobId)
    if (!printWin.isDestroyed()) printWin.destroy()
  }
}

export function registerReportPdfHandlers(): void {
  ipcMain.handle('report:getPayload', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') return null
    return pendingJobs.get(jobId) ?? null
  })

  ipcMain.handle('report:exportPdf', async (event, rawPayload: unknown): Promise<ExportReportResult> => {
    const parsed = LabReportSchema.safeParse(rawPayload)
    if (!parsed.success) {
      return { ok: false, message: '报告数据格式无效，无法导出 PDF。' }
    }
    const payload = parsed.data
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const defaultName = defaultReportFilename({ id: payload.projectId, title: payload.projectTitle })
    const defaultPath = join(app.getPath('documents'), defaultName)

    const saveOptions: Electron.SaveDialogOptions = {
      title: '导出实训报告',
      defaultPath,
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    }
    const saveResult = parent
      ? await dialog.showSaveDialog(parent, saveOptions)
      : await dialog.showSaveDialog(saveOptions)

    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, canceled: true, message: '已取消导出实训报告。' }
    }

    try {
      const pdf = await renderReportToPdfBuffer(payload)
      await atomicWriteFile(saveResult.filePath, pdf)
      return {
        ok: true,
        filePath: saveResult.filePath,
        bytes: pdf.byteLength,
        message: `已导出 PDF 实训报告：${saveResult.filePath}`,
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '导出 PDF 报告时发生未知错误。',
      }
    }
  })
}
