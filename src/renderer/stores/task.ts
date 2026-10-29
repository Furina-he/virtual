import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { buildMeasurementPlan } from '../../domain/measurement/plan'
import {
  type CapturedMeasurement,
  completeTaskStep,
  createTaskState,
  currentTaskStep,
  type MeasurementSnapshot,
  recordCurrentReading,
  scopedReference,
  type TaskState,
  writeTableCell,
} from '../../domain/task'
import { checkWiring, detectDanger } from '../../domain/wiring-check'
import type { Project, Step } from '../../shared/schema/project'
import { circuitStore } from '../features/practice/wiring-state'
import { benchCircuitInput, currentMeasurementSnapshot } from '../lib/instrument-runtime'

export type TaskLeftTab = 'guide' | 'schematic' | 'steps'
export type TaskBottomTab = 'instruments' | 'data' | 'charts' | 'log'
export type TaskUiState = {
  projectId?: string
  task: TaskState
  selectedTable: string
  selectedRow: number
  selectedSource: string
  leftTab: TaskLeftTab
  bottomTab: TaskBottomTab
  notice: string | null
  warnings: string[]
  captures: Record<string, CapturedMeasurement>
  resetVersion: number
}

export const taskStore = createStore<TaskUiState>()(() => ({
  task: { completedSteps: [], tables: {} },
  selectedTable: '',
  selectedRow: 0,
  selectedSource: 'auto',
  leftTab: 'guide',
  bottomTab: 'instruments',
  notice: null,
  warnings: [],
  captures: {},
  resetVersion: 0,
}))

export function useTask<T>(selector: (state: TaskUiState) => T): T {
  return useStore(taskStore, selector)
}

export function taskCellKey(tableId: string, row: number, columnId: string): string {
  return JSON.stringify([tableId, row, columnId])
}

export function formatTaskCellValue(value: number | null): string {
  return value === null ? '' : String(Number(value.toPrecision(12)))
}

export function parseTaskCellDraft(draft: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = draft.trim().replaceAll('\u2212', '-')
  if (!text) return { ok: true, value: null }
  const value = Number(text)
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(value))
    return { ok: false, message: '请输入有限数值，可使用小数点和负号；留空表示未记录。' }
  return { ok: true, value }
}

export function resetTask(project?: Project): void {
  taskStore.setState({
    projectId: project?.id,
    task: project ? createTaskState(project) : { completedSteps: [], tables: {} },
    selectedTable: project?.dataTables[0]?.id ?? '',
    selectedRow: 0,
    selectedSource: 'auto',
    leftTab: 'guide',
    bottomTab: 'instruments',
    notice: null,
    warnings: [],
    captures: {},
    resetVersion: taskStore.getState().resetVersion + 1,
  })
}

function active(project: Project): boolean {
  if (taskStore.getState().projectId === project.id) return true
  taskStore.setState({ notice: '当前项目记录尚未初始化，请重新打开项目后重试。' })
  return false
}

export function selectTaskTable(project: Project, tableId: string): boolean {
  if (!active(project)) return false
  const table = project.dataTables.find((item) => item.id === tableId)
  if (!table) {
    taskStore.setState({ notice: '请选择项目配置中的数据表。' })
    return false
  }
  const state = taskStore.getState()
  taskStore.setState({ selectedTable: table.id, selectedRow: Math.min(state.selectedRow, table.rows - 1) })
  return true
}

export function selectTaskRow(project: Project, row: number): boolean {
  if (!active(project)) return false
  const table = project.dataTables.find((item) => item.id === taskStore.getState().selectedTable)
  if (!table || !Number.isInteger(row) || row < 0 || row >= table.rows) {
    taskStore.setState({ notice: '请选择当前数据表的有效记录行。' })
    return false
  }
  taskStore.setState({ selectedRow: row })
  return true
}

export function selectTaskSource(instanceId: string): void {
  taskStore.setState({ selectedSource: instanceId })
}

function sanityWarnings(project: Project, task: TaskState): string[] {
  const warnings = project.dataTables.flatMap((table) =>
    (task.tables[table.id] ?? []).flatMap((values, row) =>
      table.columns.flatMap((column) =>
        writeTableCell(project, task, table.id, row, column.id, values[column.id] ?? null).warnings.map(
          (message) => `${table.title} 第 ${row + 1} 行：${message}`,
        ),
      ),
    ),
  )
  return [...new Set(warnings)]
}

export function writeTaskCell(
  project: Project,
  tableId: string,
  row: number,
  columnId: string,
  value: number | null,
): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const update = writeTableCell(project, state.task, tableId, row, columnId, value)
  if (!update.ok) {
    taskStore.setState({ notice: update.message })
    return false
  }
  const captures = { ...state.captures }
  delete captures[taskCellKey(tableId, row, columnId)]
  taskStore.setState({
    task: update.state,
    captures,
    notice: update.message,
    warnings: sanityWarnings(project, update.state),
  })
  return true
}

function requiredPoints(step?: Step): string[] {
  return [...new Set([...(step?.measurePoints ?? []), ...(step?.expect ? [step.expect.measurePoint] : [])])]
}

function selectedMeters(project: Project, source: string): Record<string, string> | undefined {
  return source === 'auto'
    ? undefined
    : Object.fromEntries(project.reference.measurePoints.map((point) => [point.id, source]))
}

function freshWiring(project: Project, step: Step) {
  try {
    const state = circuitStore.getState()
    const plan = buildMeasurementPlan(benchCircuitInput(state), state.powered, 'task-check')
    const report = checkWiring(plan.checkInput, scopedReference(project, step))
    const dangers = detectDanger(plan.checkInput)
    return {
      correct: report.circuitOk && report.measurementsOk && dangers.length === 0,
      messages: [...new Set([...dangers, ...report.issues].map((issue) => issue.message))],
    }
  } catch (error) {
    return { correct: false, messages: [error instanceof Error ? error.message : '无法检查当前接线，请检查器材配置。'] }
  }
}

function captureFeedback(
  project: Project,
  snapshot: MeasurementSnapshot | undefined,
  capture: CapturedMeasurement,
): string {
  const meter = snapshot?.plan.meters.find((item) => item.instanceId === capture.instanceId)
  const point = project.reference.measurePoints.find((item) => item.id === capture.measurePoint)
  const unit = point?.kind === 'current' ? 'A' : 'V'
  const ac = meter?.config.mode === 'acv' || meter?.config.mode === 'aca'
  const number = (value: number) => String(Number(value.toPrecision(12)))
  return `${capture.measurePoint}：${meter?.config.instrument.name ?? capture.instanceId}（${capture.instanceId}）表屏 ${number(capture.displayValueSI)} ${unit}，按参考方向记录 ${number(capture.referenceValueSI)} ${unit}。${capture.reversed ? (ac ? '表线正负端接反，有效值的非负幅度不因反接改变。' : '表线正负端接反，记录按声明方向换算；未取绝对值。') : ''}`
}

export function recordTaskReadings(project: Project): boolean {
  taskStore.setState({ bottomTab: 'data', leftTab: 'steps' })
  if (!active(project)) return false
  const state = taskStore.getState()
  const table = project.dataTables.find((item) => item.id === state.selectedTable)
  if (!table) {
    taskStore.setState({ notice: '当前项目没有可记录的数据表，请选择已配置的数据表。' })
    return false
  }
  const snapshot = currentMeasurementSnapshot()
  const meters = selectedMeters(project, state.selectedSource)
  const step = currentTaskStep(project, state.task)
  const required = requiredPoints(step)
  let task = state.task
  const captures = { ...state.captures }
  const successful: CapturedMeasurement[] = []
  const failures = new Map<string, string>()
  for (const column of table.columns) {
    if (!column.measurePoint) continue
    const update = recordCurrentReading(project, task, table.id, state.selectedRow, column.id, {
      snapshot,
      selectedMeters: meters,
      row: state.selectedRow,
      advance: false,
    })
    if (!update.ok || !update.measurement) {
      failures.set(column.measurePoint, update.message)
      continue
    }
    task = update.state
    successful.push(update.measurement)
    captures[taskCellKey(table.id, state.selectedRow, column.id)] = update.measurement
  }
  if (!successful.length) {
    const preferred = required.map((id) => failures.get(id)).find(Boolean)
    taskStore.setState({
      notice: preferred ?? failures.values().next().value ?? '该表没有绑定可快捷记录的测量点，请手动填写。',
      warnings: sanityWarnings(project, task),
    })
    return false
  }
  let completionMessage = ''
  if (step && required.some((id) => successful.some((capture) => capture.measurePoint === id))) {
    const wiring = step.checkWiring ? freshWiring(project, step) : undefined
    const completion = completeTaskStep(project, task, step.id, {
      snapshot,
      selectedMeters: meters,
      row: state.selectedRow,
      wiringCorrect: wiring?.correct,
    })
    if (completion.ok) task = completion.state
    completionMessage = `${completion.message}${wiring && !wiring.correct ? wiring.messages.join(' ') : ''}`
  }
  taskStore.setState({
    task,
    captures,
    notice: `已记录 ${successful.length} 项当前读数。${successful.map((capture) => captureFeedback(project, snapshot, capture)).join(' ')}${completionMessage}`,
    warnings: sanityWarnings(project, task),
  })
  return true
}

export function completeCurrentTaskStep(project: Project): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const step = currentTaskStep(project, state.task)
  if (!step) {
    taskStore.setState({ notice: '本项目的配置步骤已完成。' })
    return false
  }
  const snapshot = currentMeasurementSnapshot()
  const wiring = step.checkWiring ? freshWiring(project, step) : undefined
  const update = completeTaskStep(project, state.task, step.id, {
    snapshot,
    selectedMeters: selectedMeters(project, state.selectedSource),
    row: state.selectedRow,
    wiringCorrect: wiring?.correct,
  })
  taskStore.setState({
    task: update.state,
    leftTab: 'steps',
    notice: `${update.message}${wiring && !wiring.correct ? wiring.messages.join(' ') : ''}`,
    warnings: [...new Set([...sanityWarnings(project, update.state), ...(wiring?.messages ?? [])])],
  })
  return update.ok
}
