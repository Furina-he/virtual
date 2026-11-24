import { ipcRenderer } from 'electron'
import type { ExportReportResult, LabReportPayload } from '../shared/ipc/report'

export const report = {
  exportPdf: (payload: LabReportPayload): Promise<ExportReportResult> =>
    ipcRenderer.invoke('report:exportPdf', payload),
  getPrintPayload: (jobId: string): Promise<LabReportPayload | null> => ipcRenderer.invoke('report:getPayload', jobId),
  notifyPrintReady: (jobId: string): void => {
    ipcRenderer.send('report:ready', jobId)
  },
}
