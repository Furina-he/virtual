import { evaluateFormula } from '../../shared/formula.ts'
import type { Project, Step } from '../../shared/schema/project.ts'
import { type CapturedMeasurement, captureMeasurePoint, type MeasurementSnapshot } from './measurements.ts'
import {
  completeTaskStep,
  currentTaskStep,
  recordCurrentReading,
  requiredMeasurements,
  scopedReference,
  type TaskState,
} from './progress.ts'

export const GUIDE_MODES = ['guided', 'free'] as const
export type GuideMode = (typeof GUIDE_MODES)[number]

export const GUIDE_MODE_LABELS: Record<GuideMode, string> = {
  guided: '引导模式',
  free: '自主模式',
}

export type GuideModePolicy = {
  mode: GuideMode
  allowReferenceOverlay: boolean
  showProcessHints: boolean
  enforceSequentialSteps: boolean
  retainSafetyAlerts: true
  allowManualWiringCheck: true
  statusNotice: string
}

export function resolveGuideModePolicy(mode: GuideMode): GuideModePolicy {
  if (mode === 'free') {
    return {
      mode: 'free',
      allowReferenceOverlay: false,
      showProcessHints: false,
      enforceSequentialSteps: false,
      retainSafetyAlerts: true,
      allowManualWiringCheck: true,
      statusNotice: '自主模式：已隐藏 3D 参考接线虚线与步骤过程提示，保留安全告警与手动接线检查。',
    }
  }
  return {
    mode: 'guided',
    allowReferenceOverlay: true,
    showProcessHints: true,
    enforceSequentialSteps: true,
    retainSafetyAlerts: true,
    allowManualWiringCheck: true,
    statusNotice: '引导模式：按步骤高亮推进，可开启 3D 参考接线虚线与过程提示。',
  }
}

/** 自主模式下强制隐藏 3D 参考接线虚线（WIR-08、TSK-07） */
export function effectiveReferenceNets(
  project: Project | undefined,
  state: TaskState | undefined,
  mode: GuideMode,
): string[][] | undefined {
  if (!project || !state) return undefined
  if (!resolveGuideModePolicy(mode).allowReferenceOverlay) return undefined
  return scopedReference(project, currentTaskStep(project, state)).nets
}

export function canToggleReferenceOverlay(
  mode: GuideMode,
  referenceNets?: readonly (readonly string[])[],
): { allowed: true } | { allowed: false; message: string } {
  if (!resolveGuideModePolicy(mode).allowReferenceOverlay) {
    return {
      allowed: false,
      message: '当前为自主模式，已禁用 3D 参考接线虚线；请对照原理图自主接线，或切换回引导模式。',
    }
  }
  if (!referenceNets || referenceNets.length === 0) {
    return {
      allowed: false,
      message: '当前步骤未配置 3D 参考接线虚线。',
    }
  }
  return { allowed: true }
}

export type StepViewItem = {
  id: string
  index: number
  text: string
  status: 'completed' | 'current' | 'pending'
  focused: boolean
  canReview: boolean
  measurePoints: string[]
  dataTable?: string
  recordTable?: string
}

export function resolveFocusedStep(
  project: Project,
  state: TaskState,
  focusedStepId?: string | null,
): Step | undefined {
  if (focusedStepId) {
    const matched = project.steps.find((step) => step.id === focusedStepId)
    if (matched) return matched
  }
  return currentTaskStep(project, state) ?? project.steps.at(-1)
}

export function buildStepViewList(project: Project, state: TaskState, focusedStepId?: string | null): StepViewItem[] {
  const current = currentTaskStep(project, state)
  const focused = resolveFocusedStep(project, state, focusedStepId)
  return project.steps.map((step, index) => {
    const done = state.completedSteps.includes(step.id)
    const isCurrent = current?.id === step.id
    const status: StepViewItem['status'] = done ? 'completed' : isCurrent ? 'current' : 'pending'
    return {
      id: step.id,
      index,
      text: step.text,
      status,
      focused: focused?.id === step.id,
      canReview: done || isCurrent,
      measurePoints: requiredMeasurements(step),
      ...(step.dataTable ? { dataTable: step.dataTable } : {}),
      ...(step.recordTable ? { recordTable: step.recordTable } : {}),
    }
  })
}

export function activeRecordableColumns(
  project: Project,
  state: TaskState,
  tableId: string,
): Project['dataTables'][number]['columns'] {
  const table = project.dataTables.find((item) => item.id === tableId)
  if (!table) return []
  const activeStep = currentTaskStep(project, state)
  return table.columns.filter((column) => {
    if (!column.measurePoint) return false
    if (column.captureSteps && (!activeStep || !column.captureSteps.includes(activeStep.id))) return false
    return true
  })
}

/** 查找指定数据表的下一空行（优先定位整行尚未记录的空行，其次定位尚有未填列的未完成行） */
export function findNextIncompleteRow(project: Project, state: TaskState, tableId: string, startRow = 0): number {
  const table = project.dataTables.find((item) => item.id === tableId)
  if (!table || table.rows <= 1) return 0
  const columns = activeRecordableColumns(project, state, tableId)
  const checkCols = columns.length > 0 ? columns : table.columns.filter((col) => !col.computed)
  const rows = state.tables[tableId] ?? []
  const clampedStart = Math.max(0, Math.min(startRow, table.rows - 1))
  for (let offset = 0; offset < table.rows; offset++) {
    const rowIndex = (clampedStart + offset) % table.rows
    const rowValues = rows[rowIndex]
    if (!rowValues) return rowIndex
    if (checkCols.every((col) => rowValues[col.id] === null || rowValues[col.id] === undefined)) {
      return rowIndex
    }
  }
  for (let offset = 0; offset < table.rows; offset++) {
    const rowIndex = (clampedStart + offset) % table.rows
    const rowValues = rows[rowIndex]
    if (!rowValues) return rowIndex
    if (checkCols.some((col) => rowValues[col.id] === null || rowValues[col.id] === undefined)) {
      return rowIndex
    }
  }
  return clampedStart
}

export type SanityViolation = {
  tableId: string
  tableTitle: string
  row: number
  columnId: string
  message: string
}

export function evaluateTableSanity(project: Project, state: TaskState, tableId?: string): SanityViolation[] {
  const tables = tableId ? project.dataTables.filter((t) => t.id === tableId) : project.dataTables
  const violations: SanityViolation[] = []
  for (const table of tables) {
    const rows = state.tables[table.id] ?? []
    rows.forEach((values, row) => {
      for (const rule of table.sanity ?? []) {
        const value = values[rule.column]
        if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max))
        ) {
          violations.push({
            tableId: table.id,
            tableTitle: table.title,
            row,
            columnId: rule.column,
            message: rule.message,
          })
        }
      }
      for (const column of table.columns) {
        if (!column.computed) continue
        const result = evaluateFormula(column.computed, values)
        if (result.message) {
          violations.push({
            tableId: table.id,
            tableTitle: table.title,
            row,
            columnId: column.id,
            message: `${column.title}：${result.message}`,
          })
        }
      }
    })
  }
  return violations
}

export type MultiRowRecordResult = {
  ok: boolean
  state: TaskState
  recordedRow: number
  nextSelectedRow: number
  measurements: CapturedMeasurement[]
  warnings: string[]
  ambiguousCandidates?: string[]
  message: string
}

export function recordMultiRowReading(
  project: Project,
  state: TaskState,
  tableId: string,
  options: {
    targetRow?: number | 'next'
    currentRow?: number
    snapshot?: MeasurementSnapshot
    selectedMeters?: Readonly<Record<string, string>>
    advanceRow?: boolean
    advanceStep?: boolean
    wiringCorrect?: boolean
  } = {},
): MultiRowRecordResult {
  const table = project.dataTables.find((item) => item.id === tableId)
  if (!table) {
    return {
      ok: false,
      state,
      recordedRow: 0,
      nextSelectedRow: 0,
      measurements: [],
      warnings: [],
      message: '当前项目没有可记录的数据表，请选择已配置的数据表。',
    }
  }
  const resolvedRow =
    options.targetRow === 'next'
      ? findNextIncompleteRow(project, state, table.id, options.currentRow ?? 0)
      : (options.targetRow ?? options.currentRow ?? 0)
  if (!Number.isInteger(resolvedRow) || resolvedRow < 0 || resolvedRow >= table.rows) {
    return {
      ok: false,
      state,
      recordedRow: 0,
      nextSelectedRow: 0,
      measurements: [],
      warnings: [],
      message: '请选择当前数据表的有效记录行。',
    }
  }

  const step = currentTaskStep(project, state)
  const required = requiredMeasurements(step)
  let nextState = state
  const measurements: CapturedMeasurement[] = []
  const failures = new Map<string, string>()
  let ambiguousCandidates: string[] | undefined

  for (const column of table.columns) {
    if (!column.measurePoint) continue
    if (column.captureSteps && (!step || !column.captureSteps.includes(step.id))) continue
    const point = project.reference.measurePoints.find((item) => item.id === column.measurePoint)
    if (point) {
      const probe = captureMeasurePoint(options.snapshot, point, options.selectedMeters?.[point.id])
      if (!probe.ok && probe.reason === 'ambiguous' && probe.candidates?.length) {
        ambiguousCandidates = probe.candidates
      }
    }
    const update = recordCurrentReading(project, nextState, table.id, resolvedRow, column.id, {
      snapshot: options.snapshot,
      selectedMeters: options.selectedMeters,
      row: resolvedRow,
      advance: false,
    })
    if (!update.ok || !update.measurement) {
      failures.set(column.measurePoint, update.message)
      continue
    }
    nextState = update.state
    measurements.push(update.measurement)
  }

  const warnings = [
    ...new Set(
      evaluateTableSanity(project, nextState).map((v) =>
        v.message.includes('：') && !table.sanity?.some((s) => s.message === v.message)
          ? v.message
          : `${v.tableTitle} 第 ${v.row + 1} 行：${v.message}`,
      ),
    ),
  ]

  if (measurements.length === 0) {
    const preferred = required.map((id) => failures.get(id)).find(Boolean)
    return {
      ok: false,
      state: nextState,
      recordedRow: resolvedRow,
      nextSelectedRow: resolvedRow,
      measurements: [],
      warnings,
      ...(ambiguousCandidates ? { ambiguousCandidates } : {}),
      message: preferred ?? failures.values().next().value ?? '该表没有绑定可快捷记录的测量点，请手动填写。',
    }
  }

  let completionMessage = ''
  if (
    options.advanceStep !== false &&
    step &&
    required.some((id) => measurements.some((capture) => capture.measurePoint === id))
  ) {
    const completion = completeTaskStep(project, nextState, step.id, {
      snapshot: options.snapshot,
      selectedMeters: options.selectedMeters,
      row: resolvedRow,
      wiringCorrect: options.wiringCorrect,
    })
    if (completion.ok) nextState = completion.state
    completionMessage = completion.message
  }

  const nextSelectedRow =
    options.advanceRow && table.rows > 1
      ? findNextIncompleteRow(project, nextState, table.id, Math.min(resolvedRow + 1, table.rows - 1))
      : resolvedRow

  return {
    ok: true,
    state: nextState,
    recordedRow: resolvedRow,
    nextSelectedRow,
    measurements,
    warnings,
    message: `已在第 ${resolvedRow + 1} 行记录 ${measurements.length} 项当前读数。${completionMessage}`,
  }
}

export function normalizeQuestionAnswers(
  project: Project,
  answers: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(project.questions.map((_, index) => [String(index), answers[String(index)] ?? '']))
}

export function updateQuestionAnswer(
  project: Project,
  answers: Readonly<Record<string, string>>,
  questionIndex: number,
  text: string,
): { ok: boolean; answers: Record<string, string>; message: string } {
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= project.questions.length) {
    return {
      ok: false,
      answers: normalizeQuestionAnswers(project, answers),
      message: '思考题序号超出当前项目配置范围。',
    }
  }
  const next = normalizeQuestionAnswers(project, answers)
  next[String(questionIndex)] = text
  return {
    ok: true,
    answers: next,
    message: `已保存思考题 ${questionIndex + 1} 作答。`,
  }
}
