import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ResolvedInstrument } from '../../domain/instruments'
import { buildMeasurementPlan } from '../../domain/measurement/plan'
import {
  type CapturedMeasurement,
  completeTaskStep,
  createFaultFlowState,
  createTaskState,
  currentTaskStep,
  type FaultFlowState,
  type FaultKind,
  type FaultSelectionMode,
  findNextIncompleteRow,
  type GuideMode,
  type MeasurementSnapshot,
  measurementUnit,
  normalizeQuestionAnswers,
  observeFaultSymptom,
  recordCurrentReading,
  recordFaultMeasurement,
  repairFault,
  requiredMeasurements,
  resolveGuideModePolicy,
  scopedReference,
  startFaultSession,
  submitFaultDiagnosis,
  type TaskState,
  updateQuestionAnswer,
  verifyFaultRepair,
  writeTableCell,
} from '../../domain/task'
import { checkWiring, detectDanger } from '../../domain/wiring-check'
import { evaluateFormula } from '../../shared/formula'
import type { DataTable, Project, Step } from '../../shared/schema/project'
import { SAVE_SCHEMA_VERSION, type SaveFile } from '../../shared/schema/save'
import { formatEngineeringValue } from '../components/instruments/rotary-knob-values'
import { circuitStore } from '../features/practice/wiring-state'
import { benchCircuitInput, currentMeasurementSnapshot } from '../lib/instrument-runtime'

export type TaskLeftTab = 'guide' | 'schematic' | 'steps'
export type TaskBottomTab = 'instruments' | 'data' | 'charts' | 'log'
export type ReportScreenshot = {
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
export type TaskUiState = {
  projectId?: string
  task: TaskState
  selectedTable: string
  selectedRow: number
  selectedSource: string
  leftTab: TaskLeftTab
  bottomTab: TaskBottomTab
  notice: string | null
  noticeDetail: string | null
  warnings: string[]
  captures: Record<string, CapturedMeasurement>
  screenshots: ReportScreenshot[]
  faultFlow: FaultFlowState
  guideMode: GuideMode
  focusedStepId: string | null
  answers: Record<string, string>
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
  noticeDetail: null,
  warnings: [],
  captures: {},
  screenshots: [],
  faultFlow: createFaultFlowState(),
  guideMode: 'guided',
  focusedStepId: null,
  answers: {},
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

export function resetTask(project?: Project, defaultGuideMode: GuideMode = 'guided'): void {
  taskStore.setState({
    projectId: project?.id,
    task: project ? createTaskState(project) : { completedSteps: [], tables: {} },
    selectedTable: project?.dataTables[0]?.id ?? '',
    selectedRow: 0,
    selectedSource: 'auto',
    leftTab: 'guide',
    bottomTab: 'instruments',
    notice: null,
    noticeDetail: null,
    warnings: [],
    captures: {},
    screenshots: [],
    faultFlow: createFaultFlowState(),
    guideMode: defaultGuideMode,
    focusedStepId: project?.steps[0]?.id ?? null,
    answers: project ? normalizeQuestionAnswers(project) : {},
    resetVersion: taskStore.getState().resetVersion + 1,
  })
}

export function addReportScreenshot(
  input: Omit<ReportScreenshot, 'id' | 'createdAt' | 'title'> & { title?: string },
): ReportScreenshot {
  const state = taskStore.getState()
  const index = state.screenshots.length + 1
  const modeLabel = input.displayMode === 'xy' ? 'X-Y' : 'Y-T'
  const shot: ReportScreenshot = {
    id: `shot-${Date.now()}-${index}`,
    instanceId: input.instanceId,
    instrumentTitle: input.instrumentTitle,
    title: input.title ?? `${input.instrumentTitle} #${index} (${modeLabel})`,
    dataUrl: input.dataUrl,
    createdAt: new Date().toISOString(),
    displayMode: input.displayMode,
    frozen: input.frozen,
    summaryText: input.summaryText,
  }
  taskStore.setState({
    screenshots: [...state.screenshots, shot],
    notice: `已将${input.instrumentTitle}波形截图存入报告附件（共 ${index} 张）。`,
  })
  return shot
}

export function removeReportScreenshot(id: string): void {
  const state = taskStore.getState()
  const next = state.screenshots.filter((item) => item.id !== id)
  taskStore.setState({
    screenshots: next,
    notice: `已移除波形截图附件（剩余 ${next.length} 张）。`,
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
    (task.tables[table.id] ?? []).flatMap((values, row) => [
      ...(table.sanity ?? [])
        .filter((rule) => {
          const value = values[rule.column]
          return (
            typeof value === 'number' &&
            ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max))
          )
        })
        .map((rule) => `${table.title} 第 ${row + 1} 行：${rule.message}`),
      ...table.columns.flatMap((column) => {
        if (!column.computed) return []
        const result = evaluateFormula(column.computed, values)
        return result.message ? [`${column.title}：${result.message}`] : []
      }),
    ]),
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

function formatCapturedValue(valueSI: number, unit: string, meterConfig?: ResolvedInstrument): string {
  if (!Number.isFinite(valueSI)) return unit ? `— ${unit}` : '—'
  if (meterConfig && meterConfig.mode !== 'power' && meterConfig.displayScale > 0) {
    const scaled = valueSI / meterConfig.displayScale
    const step = meterConfig.resolution / meterConfig.displayScale
    const decimals = step > 0 && step < 1 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))) : 0
    return `${scaled.toFixed(decimals)}${meterConfig.unit ? ` ${meterConfig.unit}` : ''}`
  }
  return formatEngineeringValue(valueSI, unit)
}

function captureFeedback(
  project: Project,
  snapshot: MeasurementSnapshot | undefined,
  capture: CapturedMeasurement,
  table?: DataTable,
): { summary: string; detail: string } {
  const meter = snapshot?.plan.meters.find((item) => item.instanceId === capture.instanceId)
  const checkInstrument = snapshot?.plan.checkInput.instruments.find((item) => item.instanceId === capture.instanceId)
  const point = project.reference.measurePoints.find((item) => item.id === capture.measurePoint)
  const column =
    table?.columns.find((col) => col.measurePoint === capture.measurePoint) ??
    project.dataTables.flatMap((entry) => entry.columns).find((col) => col.measurePoint === capture.measurePoint)
  const pointTitle = column?.title ?? capture.measurePoint
  const instrumentName = meter?.config.instrument.name ?? checkInstrument?.instrument.name ?? capture.instanceId
  const sourceLabel = capture.channelId ? `${instrumentName} ${capture.channelId}` : instrumentName
  const unit = point ? measurementUnit(point) : (column?.unit ?? '')
  const ac = meter?.config.mode === 'acv' || meter?.config.mode === 'aca'
  const formattedDisp = formatCapturedValue(capture.displayValueSI, unit, meter?.config)
  const formattedRef = formatCapturedValue(capture.referenceValueSI, unit, meter?.config)
  const rawNumber = (value: number) => String(Number(value.toPrecision(12)))
  const reversedNote = capture.reversed
    ? ac
      ? '（表线反接，有效值幅度不变）'
      : `（表屏 ${formattedDisp}，表线反接已按参考方向换算）`
    : ''
  const summary = `${pointTitle}（${sourceLabel}）：${formattedRef}${reversedNote}`
  const detail = `${pointTitle} [${capture.measurePoint}] · ${sourceLabel} (${capture.instanceId}${capture.channelId ? `.${capture.channelId}` : ''})：原始显示 ${rawNumber(capture.displayValueSI)} ${unit}，参考方向 ${rawNumber(capture.referenceValueSI)} ${unit}`
  return { summary, detail }
}

function requestedWindowSeconds(project: Project, step?: Step): number[] {
  if (!step) return []
  const ids = requiredMeasurements(step)
  return [
    ...new Set(
      ids
        .map((id) => project.reference.measurePoints.find((point) => point.id === id)?.windowSec)
        .filter((seconds): seconds is number => seconds !== undefined),
    ),
  ]
}

export function recordTaskReadings(project: Project): boolean {
  taskStore.setState({ bottomTab: 'data', leftTab: 'steps' })
  if (!active(project)) return false
  const state = taskStore.getState()
  const step = currentTaskStep(project, state.task)
  const table = project.dataTables.find((item) => item.id === (step?.dataTable ?? state.selectedTable))
  if (!table) {
    taskStore.setState({ notice: '当前项目没有可记录的数据表，请选择已配置的数据表。' })
    return false
  }
  const row = Math.min(state.selectedRow, table.rows - 1)
  const snapshot = currentMeasurementSnapshot(requestedWindowSeconds(project, step))
  const meters = selectedMeters(project, state.selectedSource)
  const required = requiredMeasurements(step)
  let task = state.task
  const captures = { ...state.captures }
  const successful: CapturedMeasurement[] = []
  const failures = new Map<string, string>()
  for (const column of table.columns) {
    if (!column.measurePoint) continue
    if (column.captureSteps && (!step || !column.captureSteps.includes(step.id))) continue
    const update = recordCurrentReading(project, task, table.id, row, column.id, {
      snapshot,
      selectedMeters: meters,
      row,
      advance: false,
    })
    if (!update.ok || !update.measurement) {
      failures.set(column.measurePoint, update.message)
      continue
    }
    task = update.state
    successful.push(update.measurement)
    captures[taskCellKey(table.id, row, column.id)] = update.measurement
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
      row,
      wiringCorrect: wiring?.correct,
    })
    if (completion.ok) task = completion.state
    completionMessage = `${completion.message}${wiring && !wiring.correct ? wiring.messages.join(' ') : ''}`
  }
  const nextStep = currentTaskStep(project, task)
  const nextTable = nextStep?.dataTable ?? table.id
  const nextRows = project.dataTables.find((entry) => entry.id === nextTable)?.rows ?? table.rows
  const feedbackEntries = successful.map((capture) => captureFeedback(project, snapshot, capture, table))
  taskStore.setState({
    task,
    focusedStepId: nextStep?.id ?? project.steps.at(-1)?.id ?? state.focusedStepId,
    selectedTable: nextTable,
    selectedRow: Math.min(row, nextRows - 1),
    captures,
    notice: `已记录 ${successful.length} 项：${feedbackEntries.map((entry) => entry.summary).join('；')}。${completionMessage}`,
    noticeDetail: feedbackEntries.map((entry) => entry.detail).join('\n'),
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
  const snapshot = currentMeasurementSnapshot(requestedWindowSeconds(project, step))
  const wiring = step.checkWiring ? freshWiring(project, step) : undefined
  const update = completeTaskStep(project, state.task, step.id, {
    snapshot,
    selectedMeters: selectedMeters(project, state.selectedSource),
    row: state.selectedRow,
    wiringCorrect: wiring?.correct,
  })
  const nextStep = currentTaskStep(project, update.state)
  const nextTable = nextStep?.dataTable ?? state.selectedTable
  const nextRows = project.dataTables.find((entry) => entry.id === nextTable)?.rows ?? 1
  taskStore.setState({
    task: update.state,
    focusedStepId: update.ok ? (nextStep?.id ?? project.steps.at(-1)?.id ?? state.focusedStepId) : state.focusedStepId,
    selectedTable: nextTable,
    selectedRow: Math.min(state.selectedRow, nextRows - 1),
    leftTab: 'steps',
    notice: `${update.message}${wiring && !wiring.correct ? wiring.messages.join(' ') : ''}`,
    noticeDetail: null,
    warnings: [...new Set([...sanityWarnings(project, update.state), ...(wiring?.messages ?? [])])],
  })
  return update.ok
}

export function startTaskFaultSession(
  project: Project,
  options: { mode?: FaultSelectionMode; faultId?: string; random?: () => number } = {},
): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const powered = circuitStore.getState().powered
  const update = startFaultSession(project, state.faultFlow, { ...options, powered })
  taskStore.setState({
    faultFlow: update.state,
    notice: update.message,
  })
  if (update.ok) {
    circuitStore.setState({ activeFault: update.state.injectedFaultId, notice: update.message })
  }
  return update.ok
}

export function observeTaskFaultSymptom(project: Project): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const update = observeFaultSymptom(project, state.faultFlow, { powered: circuitStore.getState().powered })
  taskStore.setState({
    faultFlow: update.state,
    notice: update.message,
  })
  return update.ok
}

export function recordTaskFaultMeasurement(project: Project): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const snapshot = currentMeasurementSnapshot()
  const update = recordFaultMeasurement(project, state.faultFlow, {
    snapshot,
    selectedSource: state.selectedSource,
  })
  taskStore.setState({
    faultFlow: update.state,
    notice: update.message,
  })
  return update.ok
}

export function submitTaskFaultDiagnosis(project: Project, target: string, kind: FaultKind): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const update = submitFaultDiagnosis(project, state.faultFlow, { target, kind })
  taskStore.setState({
    faultFlow: update.state,
    notice: update.message,
  })
  return update.ok
}

export function repairTaskFault(project: Project): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const update = repairFault(project, state.faultFlow, { powered: circuitStore.getState().powered })
  taskStore.setState({
    faultFlow: update.state,
    notice: update.message,
  })
  if (update.ok) {
    circuitStore.setState({ activeFault: update.state.injectedFaultId, notice: update.message })
  }
  return update.ok
}

export function verifyTaskFaultRepair(project: Project): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const snapshot = currentMeasurementSnapshot()
  const update = verifyFaultRepair(project, state.faultFlow, {
    powered: circuitStore.getState().powered,
    snapshot,
    selectedSource: state.selectedSource,
  })
  taskStore.setState({
    faultFlow: update.state,
    notice: update.message,
  })
  return update.ok
}

export function setTaskGuideMode(mode: GuideMode): void {
  const policy = resolveGuideModePolicy(mode)
  taskStore.setState({
    guideMode: mode,
    notice: policy.statusNotice,
  })
}

export function focusTaskStep(project: Project, stepId: string | null): boolean {
  if (!active(project)) return false
  if (stepId !== null && !project.steps.some((step) => step.id === stepId)) {
    taskStore.setState({ notice: '所选实训步骤不存在。' })
    return false
  }
  const targetStep = stepId
    ? project.steps.find((step) => step.id === stepId)
    : currentTaskStep(project, taskStore.getState().task)
  const linkedTable = targetStep?.dataTable ?? targetStep?.recordTable
  const state = taskStore.getState()
  const nextTable =
    linkedTable && project.dataTables.some((t) => t.id === linkedTable) ? linkedTable : state.selectedTable
  const nextRows = project.dataTables.find((t) => t.id === nextTable)?.rows ?? 1
  taskStore.setState({
    focusedStepId: stepId,
    selectedTable: nextTable,
    selectedRow: Math.min(state.selectedRow, nextRows - 1),
  })
  return true
}

export function recordNextTaskRowReadings(project: Project): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const step = currentTaskStep(project, state.task)
  const tableId = step?.dataTable ?? state.selectedTable
  const table = project.dataTables.find((item) => item.id === tableId)
  if (!table) {
    taskStore.setState({ notice: '当前项目没有可记录的数据表，请选择已配置的数据表。' })
    return false
  }
  const targetRow = findNextIncompleteRow(project, state.task, table.id, 0)
  taskStore.setState({ selectedTable: table.id, selectedRow: targetRow })
  const ok = recordTaskReadings(project)
  if (!ok) return false
  const after = taskStore.getState()
  if (after.selectedTable === table.id && table.rows > 1) {
    const nextRow = findNextIncompleteRow(project, after.task, table.id, Math.min(targetRow + 1, table.rows - 1))
    taskStore.setState({ selectedRow: nextRow })
  }
  return true
}

export function setTaskQuestionAnswer(project: Project, questionIndex: number, text: string): boolean {
  if (!active(project)) return false
  const state = taskStore.getState()
  const update = updateQuestionAnswer(project, state.answers, questionIndex, text)
  taskStore.setState({
    answers: update.answers,
    ...(update.ok ? {} : { notice: update.message }),
  })
  return update.ok
}

export function buildProjectSaveFile(project: Project): SaveFile {
  const circuit = circuitStore.getState()
  const taskState = taskStore.getState()
  const fault = taskState.faultFlow
  const hasFaultHistory = fault.history.length > 0 || fault.stage !== 'idle'
  const activeMeasurements = fault.stage !== 'idle' && fault.stage !== 'completed' ? fault.measurementCount : 0
  const activeWrong = fault.stage !== 'idle' && fault.stage !== 'completed' ? fault.wrongAttempts : 0
  const activeElapsedMs = fault.stage !== 'idle' && fault.stage !== 'completed' ? fault.elapsedMs : 0
  const faultLog = hasFaultHistory
    ? {
        measurements: fault.history.reduce((sum, item) => sum + item.measurementCount, 0) + activeMeasurements,
        wrongGuesses: fault.history.reduce((sum, item) => sum + item.wrongAttempts, 0) + activeWrong,
        seconds: Number(
          ((fault.history.reduce((sum, item) => sum + item.elapsedMs, 0) + activeElapsedMs) / 1000).toFixed(1),
        ),
      }
    : undefined

  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    projectId: project.id,
    updatedAt: new Date().toISOString(),
    circuit: {
      placedInstruments: structuredClone(circuit.placedInstruments),
      wires: structuredClone(circuit.wires),
      controlValues: { ...circuit.controlValues },
      ...(circuit.activeFault ? { activeFault: circuit.activeFault } : {}),
    },
    completedSteps: [...taskState.task.completedSteps],
    tables: structuredClone(taskState.task.tables),
    answers: normalizeQuestionAnswers(project, taskState.answers),
    guideMode: taskState.guideMode,
    ...(faultLog ? { faultLog } : {}),
  }
}

export function restoreTaskFromSave(project: Project, save: SaveFile, noticeMessage?: string): void {
  const validSteps = new Set(project.steps.map((step) => step.id))
  const completedSteps = save.completedSteps.filter((id) => validSteps.has(id))
  let restored = createTaskState(project)
  restored = { ...restored, completedSteps }

  for (const table of project.dataTables) {
    const savedRows = save.tables[table.id] ?? []
    for (let rowIndex = 0; rowIndex < Math.min(table.rows, savedRows.length); rowIndex++) {
      const savedRow = savedRows[rowIndex]
      if (!savedRow) continue
      for (const column of table.columns) {
        if (column.computed) continue
        const value = savedRow[column.id]
        if (typeof value === 'number' && Number.isFinite(value)) {
          const updated = writeTableCell(project, restored, table.id, rowIndex, column.id, value)
          if (updated.ok) restored = updated.state
        }
      }
    }
  }

  const nextStep = currentTaskStep(project, restored)
  const selectedTable = nextStep?.dataTable ?? project.dataTables[0]?.id ?? ''
  const guideMode = save.guideMode ?? 'guided'

  taskStore.setState((prev) => ({
    projectId: project.id,
    task: restored,
    selectedTable,
    selectedRow: 0,
    selectedSource: 'auto',
    notice: noticeMessage ?? '已恢复存档进度，当前处于断电状态。',
    warnings: sanityWarnings(project, restored),
    captures: {},
    guideMode,
    focusedStepId: nextStep?.id ?? project.steps.at(-1)?.id ?? null,
    answers: normalizeQuestionAnswers(project, save.answers),
    resetVersion: prev.resetVersion + 1,
  }))
}
