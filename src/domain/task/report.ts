import { evaluateFormula, formulaColumns } from '../../shared/formula.ts'
import type { DataTable, Project } from '../../shared/schema/project.ts'
import { type ChartDataset, extractProjectCharts } from './charts.ts'
import type { FaultFlowState } from './fault-flow.ts'
import { evaluateTableSanity, normalizeQuestionAnswers } from './guided-mode.ts'
import type { TaskState } from './progress.ts'

export type ReportScreenshotItem = {
  id: string
  instanceId: string
  instrumentTitle: string
  title: string
  dataUrl: string
  createdAt: string
  displayMode: 'yt' | 'xy'
  frozen: boolean
  summaryText: string
}

export type ReportStepItem = {
  id: string
  index: number
  text: string
  completed: boolean
}

export type ReportTableCell = {
  columnId: string
  value: number | null
  formatted: string
}

export type ReportTableRow = {
  rowNumber: number
  cells: ReportTableCell[]
}

export type ReportTableSection = {
  id: string
  title: string
  columns: { id: string; title: string; unit?: string; computed?: string }[]
  rows: ReportTableRow[]
  filledRows: number
  warnings: string[]
}

export type ReportQuestionItem = {
  index: number
  prompt: string
  answer: string
}

export type ReportFaultSummary = {
  measurements: number
  wrongGuesses: number
  seconds: number
  resolvedCount: number
  resolvedFaultIds: string[]
}

export type LabReport = {
  projectId: string
  projectTitle: string
  projectGroup: string
  projectType: Project['type']
  generatedAt: string
  guideMarkdown: string
  stepSummary: {
    completed: number
    total: number
    items: ReportStepItem[]
  }
  tables: ReportTableSection[]
  charts: ChartDataset[]
  screenshots: ReportScreenshotItem[]
  questions: ReportQuestionItem[]
  faultSummary?: ReportFaultSummary
}

export type AssembleReportInput = {
  project: Project
  guideMarkdown: string
  task: TaskState
  answers: Readonly<Record<string, string>>
  screenshots?: readonly ReportScreenshotItem[]
  faultFlow?: FaultFlowState
  generatedAt?: string
}

function formatReportValue(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return String(Number(value.toPrecision(12)))
}

function computeRowValues(
  table: DataTable,
  rawRow: Readonly<Record<string, number | null>> | undefined,
): Record<string, number | null> {
  const values: Record<string, number | null> = Object.fromEntries(
    table.columns.map((column) => [column.id, rawRow?.[column.id] ?? null]),
  )
  const pending = new Map(table.columns.filter((column) => column.computed).map((column) => [column.id, column]))
  while (pending.size > 0) {
    let changed = false
    for (const [id, column] of pending) {
      const formula = column.computed as string
      if (formulaColumns(formula).some((reference) => pending.has(reference))) continue
      const result = evaluateFormula(formula, values)
      values[id] = result.value
      pending.delete(id)
      changed = true
    }
    if (!changed) break
  }
  return values
}

function isSafeImageDataUrl(url: string): boolean {
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)
}

function summarizeFaultFlow(project: Project, faultFlow?: FaultFlowState): ReportFaultSummary | undefined {
  if (!faultFlow || !project.faults?.length) return undefined
  const history = faultFlow.history
  const activeMeasurements =
    faultFlow.stage !== 'idle' && faultFlow.stage !== 'completed' ? faultFlow.measurementCount : 0
  const activeWrong = faultFlow.stage !== 'idle' && faultFlow.stage !== 'completed' ? faultFlow.wrongAttempts : 0
  const activeElapsedMs = faultFlow.stage !== 'idle' && faultFlow.stage !== 'completed' ? faultFlow.elapsedMs : 0
  const measurements = history.reduce((sum, item) => sum + item.measurementCount, 0) + activeMeasurements
  const wrongGuesses = history.reduce((sum, item) => sum + item.wrongAttempts, 0) + activeWrong
  const seconds = (history.reduce((sum, item) => sum + item.elapsedMs, 0) + activeElapsedMs) / 1000
  if (history.length === 0 && faultFlow.stage === 'idle') return undefined
  return {
    measurements,
    wrongGuesses,
    seconds: Number(seconds.toFixed(1)),
    resolvedCount: faultFlow.resolvedFaultIds.length,
    resolvedFaultIds: [...faultFlow.resolvedFaultIds],
  }
}

export function assembleLabReport(input: AssembleReportInput): LabReport {
  const { project, guideMarkdown, task } = input
  const normalizedAnswers = normalizeQuestionAnswers(project, input.answers)
  const completedSet = new Set(task.completedSteps)
  const stepItems: ReportStepItem[] = project.steps.map((step, index) => ({
    id: step.id,
    index: index + 1,
    text: step.text,
    completed: completedSet.has(step.id),
  }))

  const sanityByTable = new Map<string, string[]>()
  for (const violation of evaluateTableSanity(project, task)) {
    const list = sanityByTable.get(violation.tableId) ?? []
    const text = `第 ${violation.row + 1} 行：${violation.message}`
    if (!list.includes(text)) list.push(text)
    sanityByTable.set(violation.tableId, list)
  }

  const tables: ReportTableSection[] = project.dataTables.map((table) => {
    const rawRows = task.tables[table.id] ?? []
    const rows: ReportTableRow[] = Array.from({ length: table.rows }, (_, rowIndex) => {
      const resolved = computeRowValues(table, rawRows[rowIndex])
      return {
        rowNumber: rowIndex + 1,
        cells: table.columns.map((column) => {
          const raw = resolved[column.id]
          const val: number | null = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
          return {
            columnId: column.id,
            value: val,
            formatted: formatReportValue(val),
          }
        }),
      }
    })
    const filledRows = rows.filter((row) => row.cells.some((cell) => cell.value !== null)).length
    return {
      id: table.id,
      title: table.title,
      columns: table.columns.map((column) => ({
        id: column.id,
        title: column.title,
        ...(column.unit ? { unit: column.unit } : {}),
        ...(column.computed ? { computed: column.computed } : {}),
      })),
      rows,
      filledRows,
      warnings: sanityByTable.get(table.id) ?? [],
    }
  })

  const charts = extractProjectCharts(project, task)
  const screenshots = (input.screenshots ?? [])
    .filter((shot) => isSafeImageDataUrl(shot.dataUrl))
    .map((shot) => ({ ...shot }))

  const questions: ReportQuestionItem[] = project.questions.map((prompt, index) => ({
    index: index + 1,
    prompt,
    answer: (normalizedAnswers[String(index)] ?? '').trim(),
  }))

  const faultSummary = summarizeFaultFlow(project, input.faultFlow)

  return {
    projectId: project.id,
    projectTitle: project.title,
    projectGroup: project.group,
    projectType: project.type,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    guideMarkdown: guideMarkdown.trim(),
    stepSummary: {
      completed: stepItems.filter((item) => item.completed).length,
      total: stepItems.length,
      items: stepItems,
    },
    tables,
    charts,
    screenshots,
    questions,
    ...(faultSummary ? { faultSummary } : {}),
  }
}

export function defaultReportFilename(project: Pick<Project, 'id' | 'title'>): string {
  const safeTitle = project.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 48)
  return `${project.id}-${safeTitle}-实训报告.pdf`
}
