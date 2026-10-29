import { evaluateFormula, formulaColumns } from '../../shared/formula.ts'
import type { Project, Step } from '../../shared/schema/project.ts'
import { type CapturedMeasurement, captureMeasurePoint, type MeasurementSnapshot, tableValue } from './measurements.ts'

export type TaskState = {
  completedSteps: string[]
  tables: Record<string, Record<string, number | null>[]>
}
export type CompletionEvidence = {
  snapshot?: MeasurementSnapshot
  /** A fresh check report for the current graph; this can be supplied while the bench is powered off. */
  wiringCorrect?: boolean
  row?: number
  selectedMeters?: Readonly<Record<string, string>>
  /** Disable per-cell advancement when the renderer records a batch and completes its current step once. */
  advance?: boolean
}
export type TaskUpdate = {
  ok: boolean
  state: TaskState
  message: string
  warnings: string[]
  measurement?: CapturedMeasurement
}

export function createTaskState(project: Project): TaskState {
  return {
    completedSteps: [],
    tables: Object.fromEntries(
      project.dataTables.map((table) => [
        table.id,
        Array.from({ length: table.rows }, () => Object.fromEntries(table.columns.map((column) => [column.id, null]))),
      ]),
    ),
  }
}

export function currentTaskStep(project: Project, state: TaskState): Step | undefined {
  return project.steps.find((step) => !state.completedSteps.includes(step.id))
}

export function scopedReference(project: Project, step?: Step): Project['reference'] {
  const reference = step?.referenceNets ? { ...project.reference, nets: step.referenceNets } : project.reference
  if (step?.measurePoints === undefined) {
    if (step || !project.steps.some((item) => item.measurePoints !== undefined)) return reference
    return { ...reference, measurePoints: [] }
  }
  const required = new Set(step.measurePoints)
  return {
    ...reference,
    measurePoints: reference.measurePoints.filter((point) => required.has(point.id)),
  }
}

export function tableRowComplete(project: Project, state: TaskState, tableId: string, row = 0): boolean {
  const table = project.dataTables.find((item) => item.id === tableId)
  const values = state.tables[tableId]?.[row]
  return Boolean(
    table &&
      Number.isInteger(row) &&
      row >= 0 &&
      row < table.rows &&
      values &&
      table.columns.every((column) => typeof values[column.id] === 'number' && Number.isFinite(values[column.id])),
  )
}

function failure(state: TaskState, message: string): TaskUpdate {
  return { ok: false, state, message, warnings: [] }
}

function recompute(
  table: Project['dataTables'][number],
  row: Record<string, number | null>,
): { values: Record<string, number | null>; warnings: string[] } {
  const values = { ...row }
  const warnings: string[] = []
  const pending = new Map(table.columns.filter((column) => column.computed).map((column) => [column.id, column]))
  while (pending.size) {
    let changed = false
    for (const [id, column] of pending) {
      const formula = column.computed as string
      if (formulaColumns(formula).some((reference) => pending.has(reference))) continue
      const result = evaluateFormula(formula, values)
      values[id] = result.value
      if (result.message) warnings.push(`${column.title}：${result.message}`)
      pending.delete(id)
      changed = true
    }
    if (!changed) break
  }
  return { values, warnings }
}

export function writeTableCell(
  project: Project,
  state: TaskState,
  tableId: string,
  row: number,
  columnId: string,
  value: number | null,
): TaskUpdate {
  const table = project.dataTables.find((item) => item.id === tableId)
  const column = table?.columns.find((item) => item.id === columnId)
  const values = state.tables[tableId]?.[row]
  if (!table || !column || !values || !Number.isInteger(row) || row < 0 || row >= table.rows)
    return failure(state, '数据表或单元格不存在，请选择配置中的行和列。')
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
    return failure(state, '请输入有限的数字；留空表示未记录。')
  if (column.computed) return failure(state, '计算列不能手动填写，请填写测量数据。')
  const warnings = (table.sanity ?? [])
    .filter(
      (rule) =>
        rule.column === columnId &&
        value !== null &&
        ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)),
    )
    .map((rule) => rule.message)
  if (Object.is(values[columnId], value)) return { ok: true, state, message: '数据未改变。', warnings }
  const rows = [...(state.tables[tableId] ?? [])]
  const calculated = recompute(table, { ...values, [columnId]: value })
  rows[row] = calculated.values
  return {
    ok: true,
    state: { ...state, tables: { ...state.tables, [tableId]: rows } },
    message: '数据已更新。',
    warnings: [...warnings, ...calculated.warnings],
  }
}

function requiredMeasurements(step: Step): string[] {
  return [...new Set([...(step.measurePoints ?? []), ...(step.expect ? [step.expect.measurePoint] : [])])]
}

export function completeTaskStep(
  project: Project,
  state: TaskState,
  stepId: string,
  evidence: CompletionEvidence = {},
): TaskUpdate {
  const step = currentTaskStep(project, state)
  if (!step || step.id !== stepId) return failure(state, '请先完成当前步骤，不能跳过或重复完成步骤。')
  if (step.checkWiring && evidence.wiringCorrect !== true)
    return failure(state, '请检查当前接线，确认电路和本步骤测量点连接正确后再继续。')
  for (const id of requiredMeasurements(step)) {
    const point = project.reference.measurePoints.find((item) => item.id === id)
    if (!point) return failure(state, `当前步骤引用的测量点 ${id} 不存在。`)
    const capture = captureMeasurePoint(evidence.snapshot, point, evidence.selectedMeters?.[id])
    if (!capture.ok) return failure(state, capture.message)
    if (
      step.expect?.measurePoint === id &&
      (capture.measurement.referenceValueSI < step.expect.min || capture.measurement.referenceValueSI > step.expect.max)
    )
      return failure(state, '当前实测读数尚未满足步骤范围，请检查设置与接线，不要改填预期数值。')
  }
  if (step.recordTable && !tableRowComplete(project, state, step.recordTable, evidence.row ?? 0))
    return failure(state, '请先填写本步骤要求的数据表行，保留真实测量结果。')
  return {
    ok: true,
    state: { ...state, completedSteps: [...state.completedSteps, step.id] },
    message: '当前步骤已完成。',
    warnings: [],
  }
}

export function recordCurrentReading(
  project: Project,
  state: TaskState,
  tableId: string,
  row: number,
  columnId: string,
  evidence: CompletionEvidence = {},
): TaskUpdate {
  const column = project.dataTables.find((table) => table.id === tableId)?.columns.find((item) => item.id === columnId)
  const activeStep = currentTaskStep(project, state)
  if (column?.captureSteps && (!activeStep || !column.captureSteps.includes(activeStep.id)))
    return failure(state, '该列不属于当前测量阶段，保留已记录的数据。')
  const point = project.reference.measurePoints.find((item) => item.id === column?.measurePoint)
  if (!column || !point) return failure(state, '该列未绑定可记录的测量点，请手动填写或选择其他列。')
  const capture = captureMeasurePoint(evidence.snapshot, point, evidence.selectedMeters?.[point.id])
  if (!capture.ok) return failure(state, capture.message)
  const value = tableValue(point, capture.measurement, column.unit)
  if (value === undefined) return failure(state, '数据列的单位与测量点不符，不能自动记录。')
  const updated = writeTableCell(project, state, tableId, row, columnId, value)
  if (!updated.ok) return updated
  const step = currentTaskStep(project, updated.state)
  const completion =
    evidence.advance !== false && step && requiredMeasurements(step).includes(point.id)
      ? completeTaskStep(project, updated.state, step.id, { ...evidence, row })
      : undefined
  return {
    ...updated,
    state: completion?.ok ? completion.state : updated.state,
    message: `已记录 ${point.id} 的当前读数。${capture.measurement.reversed ? capture.message : ''}${completion ? completion.message : ''}`,
    measurement: capture.measurement,
  }
}
