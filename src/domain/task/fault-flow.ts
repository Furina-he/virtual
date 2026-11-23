import type { FaultDef, Project } from '../../shared/schema/project.ts'
import { captureMeasurePoint, type MeasurementSnapshot, measurementUnit } from './measurements.ts'

export const FAULT_KINDS = ['open', 'short', 'drift', 'dead'] as const
export type FaultKind = (typeof FAULT_KINDS)[number]

export const FAULT_KIND_LABELS: Record<FaultKind, string> = {
  open: '开路（断线/虚焊）',
  short: '短路',
  drift: '参数漂移',
  dead: '元件损坏',
}

export const FAULT_SELECTION_MODES = ['preset', 'random', 'teacher'] as const
export type FaultSelectionMode = (typeof FAULT_SELECTION_MODES)[number]

export const FAULT_FLOW_STEPS = ['observe', 'measure', 'submit', 'judge', 'repair', 'verify'] as const
export type FaultFlowStepId = (typeof FAULT_FLOW_STEPS)[number]

export const FAULT_FLOW_STEP_TITLES: Record<FaultFlowStepId, string> = {
  observe: '1. 观察现象',
  measure: '2. 测量定位',
  submit: '3. 提交故障',
  judge: '4. 系统判定',
  repair: '5. 更换修复',
  verify: '6. 上电验证',
}

export type FaultFlowStage = 'idle' | 'observe' | 'measure' | 'repair' | 'verify' | 'completed'

export type FaultMeasurementRecord = {
  index: number
  timestampMs: number
  pointId?: string
  instanceId: string
  valueSI: number
  unit: string
  summary: string
}

export type FaultVerdict = {
  correct: boolean
  submittedTarget: string
  submittedKind: FaultKind
  message: string
  hint?: string
  timestampMs: number
}

export type FaultSessionRecord = {
  faultId: string
  target: string
  kind: FaultKind
  mode: FaultSelectionMode
  measurementCount: number
  wrongAttempts: number
  elapsedMs: number
  completedAtMs: number
}

export type FaultFlowState = {
  stage: FaultFlowStage
  mode: FaultSelectionMode
  activeFaultId?: string
  injectedFaultId?: string
  startedAtMs?: number
  completedAtMs?: number
  elapsedMs: number
  measurementCount: number
  wrongAttempts: number
  measurements: FaultMeasurementRecord[]
  lastVerdict?: FaultVerdict
  resolvedFaultIds: string[]
  history: FaultSessionRecord[]
}

export type FaultFlowUpdate = {
  ok: boolean
  state: FaultFlowState
  message: string
}

export function createFaultFlowState(): FaultFlowState {
  return {
    stage: 'idle',
    mode: 'preset',
    elapsedMs: 0,
    measurementCount: 0,
    wrongAttempts: 0,
    measurements: [],
    resolvedFaultIds: [],
    history: [],
  }
}

export function activeFaultDefinition(project: Project, state: FaultFlowState): FaultDef | undefined {
  if (!state.activeFaultId) return undefined
  return project.faults?.find((fault) => fault.id === state.activeFaultId)
}

export function injectedFaultDefinition(project: Project, state: FaultFlowState): FaultDef | undefined {
  if (!state.injectedFaultId) return undefined
  return project.faults?.find((fault) => fault.id === state.injectedFaultId)
}

export function faultCandidateTargets(project: Project, extraTargets: readonly string[] = []): string[] {
  const fromProject = (project.faults ?? []).map((fault) => fault.target)
  return [...new Set([...fromProject, ...extraTargets])].sort((a, b) => a.localeCompare(b))
}

export function faultStepStatuses(
  state: FaultFlowState,
): { id: FaultFlowStepId; title: string; status: 'pending' | 'current' | 'completed' | 'failed' }[] {
  return FAULT_FLOW_STEPS.map((id) => {
    const title = FAULT_FLOW_STEP_TITLES[id]
    if (state.stage === 'idle') return { id, title, status: 'pending' }
    if (state.stage === 'completed') return { id, title, status: 'completed' }
    if (state.stage === 'observe') {
      return { id, title, status: id === 'observe' ? 'current' : 'pending' }
    }
    if (state.stage === 'measure') {
      if (id === 'observe') return { id, title, status: 'completed' }
      if (id === 'measure') return { id, title, status: 'current' }
      if (id === 'submit') return { id, title, status: state.measurementCount > 0 ? 'current' : 'pending' }
      if (id === 'judge')
        return { id, title, status: state.lastVerdict && !state.lastVerdict.correct ? 'failed' : 'pending' }
      return { id, title, status: 'pending' }
    }
    if (state.stage === 'repair') {
      if (id === 'observe' || id === 'measure' || id === 'submit' || id === 'judge')
        return { id, title, status: 'completed' }
      if (id === 'repair') return { id, title, status: 'current' }
      return { id, title, status: 'pending' }
    }
    // state.stage === 'verify'
    if (id === 'verify') return { id, title, status: 'current' }
    return { id, title, status: 'completed' }
  })
}

function reject(state: FaultFlowState, message: string): FaultFlowUpdate {
  return { ok: false, state, message }
}

function updateElapsed(state: FaultFlowState, nowMs: number): number {
  if (state.startedAtMs === undefined) return state.elapsedMs
  return Math.max(state.elapsedMs, Math.max(0, Math.round(nowMs - state.startedAtMs)))
}

export function startFaultSession(
  project: Project,
  state: FaultFlowState,
  options: {
    mode?: FaultSelectionMode
    faultId?: string
    nowMs?: number
    random?: () => number
    powered?: boolean
  } = {},
): FaultFlowUpdate {
  const faults = project.faults ?? []
  if (faults.length === 0) return reject(state, '当前项目未配置故障库。')
  if (options.powered === true) return reject(state, '当前已上电，请先断电再抽取或注入故障题目。')
  const mode: FaultSelectionMode = options.mode ?? 'preset'
  let chosen: FaultDef | undefined
  if (mode === 'random') {
    const unresolved = faults.filter((fault) => !state.resolvedFaultIds.includes(fault.id))
    const pool = unresolved.length > 0 ? unresolved : faults
    const rng = options.random ?? Math.random
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)))
    chosen = pool[index]
  } else {
    if (options.faultId) {
      chosen = faults.find((fault) => fault.id === options.faultId)
      if (!chosen) return reject(state, `故障题目 ${options.faultId} 不存在。`)
    } else {
      chosen = faults.find((fault) => !state.resolvedFaultIds.includes(fault.id)) ?? faults[0]
    }
  }
  if (!chosen) return reject(state, '未能选出有效的故障题目。')
  const nowMs = options.nowMs ?? Date.now()
  const next: FaultFlowState = {
    ...state,
    stage: 'observe',
    mode,
    activeFaultId: chosen.id,
    injectedFaultId: chosen.id,
    startedAtMs: nowMs,
    completedAtMs: undefined,
    elapsedMs: 0,
    measurementCount: 0,
    wrongAttempts: 0,
    measurements: [],
    lastVerdict: undefined,
  }
  const modeLabel = mode === 'random' ? '随机抽题' : mode === 'teacher' ? '教师指定' : `预设题目 ${chosen.id}`
  return {
    ok: true,
    state: next,
    message: `已激活排故任务（${modeLabel}）：故障现象为“${chosen.symptom}”。请上电观察现象并使用仪表测量定位。`,
  }
}

export function observeFaultSymptom(
  project: Project,
  state: FaultFlowState,
  options: { powered: boolean; nowMs?: number },
): FaultFlowUpdate {
  const fault = activeFaultDefinition(project, state)
  if (!fault || state.stage === 'idle') return reject(state, '请先抽取或选择故障题目。')
  if (state.stage !== 'observe') return reject(state, '当前已完成现象观察，请继续测量或提交排故结果。')
  if (!options.powered) return reject(state, '请先上电运行，观察故障电路的异常现象。')
  const nowMs = options.nowMs ?? Date.now()
  return {
    ok: true,
    state: {
      ...state,
      stage: 'measure',
      elapsedMs: updateElapsed(state, nowMs),
    },
    message: `已确认故障现象：“${fault.symptom}”。请使用电压表、万用表或示波器测量关键节点并记录排故测量。`,
  }
}

function collectValidMeasurements(
  project: Project,
  snapshot: MeasurementSnapshot | undefined,
  selectedSource?: string,
): { pointId?: string; instanceId: string; valueSI: number; unit: string; summary: string }[] {
  if (!snapshot?.current) return []
  const explicitSource = selectedSource && selectedSource !== 'auto' ? selectedSource : undefined
  const captured: { pointId?: string; instanceId: string; valueSI: number; unit: string; summary: string }[] = []
  for (const point of project.reference.measurePoints) {
    const result = captureMeasurePoint(snapshot, point, explicitSource)
    if (!result.ok) continue
    const unit = measurementUnit(point)
    const valueSI = result.measurement.referenceValueSI
    const formatted = String(Number(valueSI.toPrecision(6)))
    const inst = result.measurement.channelId
      ? `${result.measurement.instanceId}.${result.measurement.channelId}`
      : result.measurement.instanceId
    captured.push({
      pointId: point.id,
      instanceId: inst,
      valueSI,
      unit,
      summary: `${point.id} = ${formatted} ${unit} (${inst})`,
    })
  }
  if (captured.length > 0) return captured

  for (const meter of snapshot.plan.meters) {
    if (explicitSource && meter.instanceId !== explicitSource) continue
    const reading = snapshot.readings[meter.instanceId]
    if (reading?.status !== 'ok' || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) continue
    const formatted = String(Number(reading.value.toPrecision(6)))
    captured.push({
      instanceId: meter.instanceId,
      valueSI: reading.value,
      unit: meter.config.unit,
      summary: `${meter.instanceId} = ${formatted} ${meter.config.unit}`,
    })
  }
  for (const wf of snapshot.waveforms ?? []) {
    const inst = `${wf.instanceId}.${wf.channelId}`
    if (explicitSource && wf.instanceId !== explicitSource && inst !== explicitSource) continue
    if (!wf.current || !wf.measurement || wf.requestedWindowSec !== undefined) continue
    const vpp = wf.measurement.vpp
    if (!Number.isFinite(vpp)) continue
    const formatted = String(Number(vpp.toPrecision(6)))
    captured.push({
      instanceId: inst,
      valueSI: vpp,
      unit: 'V',
      summary: `${inst} Vpp = ${formatted} V`,
    })
  }
  return captured
}

export function recordFaultMeasurement(
  project: Project,
  state: FaultFlowState,
  options: { snapshot?: MeasurementSnapshot; selectedSource?: string; nowMs?: number } = {},
): FaultFlowUpdate {
  const fault = activeFaultDefinition(project, state)
  if (!fault || state.stage === 'idle') return reject(state, '请先抽取或选择故障题目后再测量。')
  if (state.stage !== 'observe' && state.stage !== 'measure')
    return reject(state, '当前阶段无需继续定位测量，请按排故步骤执行修复或上电验证。')
  const captured = collectValidMeasurements(project, options.snapshot, options.selectedSource)
  if (captured.length === 0)
    return reject(state, '当前没有可记录的有效仪表读数或波形，请接好测量仪表并确保读数就绪后再记录。')
  const nowMs = options.nowMs ?? Date.now()
  const primary = captured[0] as (typeof captured)[number]
  const index = state.measurementCount + 1
  const entry: FaultMeasurementRecord = {
    index,
    timestampMs: nowMs,
    pointId: primary.pointId,
    instanceId: primary.instanceId,
    valueSI: primary.valueSI,
    unit: primary.unit,
    summary: captured.map((item) => item.summary).join('；'),
  }
  return {
    ok: true,
    state: {
      ...state,
      stage: 'measure',
      measurementCount: index,
      elapsedMs: updateElapsed(state, nowMs),
      measurements: [...state.measurements, entry],
    },
    message: `已记录第 ${index} 次排故测量：${entry.summary}。可根据测量结果提交疑似故障点与故障类型。`,
  }
}

export function submitFaultDiagnosis(
  project: Project,
  state: FaultFlowState,
  input: { target: string; kind: FaultKind; nowMs?: number },
): FaultFlowUpdate {
  const fault = activeFaultDefinition(project, state)
  if (!fault || state.stage === 'idle') return reject(state, '请先抽取或选择故障题目。')
  if (state.stage === 'repair' || state.stage === 'verify' || state.stage === 'completed')
    return reject(state, '当前故障已判定通过，请继续执行更换修复或上电验证。')
  if (state.measurementCount < 1)
    return reject(state, '请先上电观察并使用仪表测量定位至少 1 次，再提交故障点与故障类型。')
  const target = input.target.trim()
  if (!target) return reject(state, '请选择疑似故障元件位号。')
  if (!FAULT_KINDS.includes(input.kind)) return reject(state, '请选择有效的故障类型。')
  const nowMs = input.nowMs ?? Date.now()
  const elapsedMs = updateElapsed(state, nowMs)
  const correct = target.toLowerCase() === fault.target.toLowerCase() && input.kind === fault.kind
  if (!correct) {
    const wrongAttempts = state.wrongAttempts + 1
    const message = `判定未通过（第 ${wrongAttempts} 次误判）：所提交的“${target} / ${FAULT_KIND_LABELS[input.kind]}”与当前故障不符。排查提示：${fault.hint}`
    const verdict: FaultVerdict = {
      correct: false,
      submittedTarget: target,
      submittedKind: input.kind,
      message,
      hint: fault.hint,
      timestampMs: nowMs,
    }
    return {
      ok: false,
      state: {
        ...state,
        stage: 'measure',
        wrongAttempts,
        elapsedMs,
        lastVerdict: verdict,
      },
      message,
    }
  }
  const message = `系统判定正确：确认故障为 ${fault.target} ${FAULT_KIND_LABELS[fault.kind]}。请先断电，点击“更换元件/修复”撤除故障，再重新上电验证。`
  const verdict: FaultVerdict = {
    correct: true,
    submittedTarget: fault.target,
    submittedKind: fault.kind,
    message,
    timestampMs: nowMs,
  }
  return {
    ok: true,
    state: {
      ...state,
      stage: 'repair',
      elapsedMs,
      lastVerdict: verdict,
    },
    message,
  }
}

export function repairFault(
  project: Project,
  state: FaultFlowState,
  options: { powered: boolean; nowMs?: number },
): FaultFlowUpdate {
  const fault = activeFaultDefinition(project, state)
  if (!fault || state.stage === 'idle') return reject(state, '请先抽取或选择故障题目。')
  if (state.stage === 'observe' || state.stage === 'measure')
    return reject(state, '请先完成测量定位并提交正确的故障点与故障类型，经系统判定通过后再更换修复。')
  if (state.stage === 'verify') return reject(state, '故障元件已更换修复，请上电并执行验证测量后结项。')
  if (state.stage === 'completed') return reject(state, '当前排故任务已完成验证并结项。')
  if (options.powered) return reject(state, '当前已上电，请先断电再更换故障元件或修复电路。')
  const nowMs = options.nowMs ?? Date.now()
  return {
    ok: true,
    state: {
      ...state,
      stage: 'verify',
      injectedFaultId: undefined,
      elapsedMs: updateElapsed(state, nowMs),
    },
    message: `已更换/修复 ${fault.target} 并撤除故障注入。此时尚未结项，请重新上电并点击“上电验证并结项”核对电路恢复正常。`,
  }
}

export function verifyFaultRepair(
  project: Project,
  state: FaultFlowState,
  options: { powered: boolean; snapshot?: MeasurementSnapshot; selectedSource?: string; nowMs?: number },
): FaultFlowUpdate {
  const fault = activeFaultDefinition(project, state)
  if (!fault || state.stage === 'idle') return reject(state, '请先抽取或选择故障题目。')
  if (state.stage === 'observe' || state.stage === 'measure')
    return reject(state, '尚未完成故障判定与修复，不能直接验证结项。')
  if (state.stage === 'repair' || state.injectedFaultId !== undefined)
    return reject(state, '请先断电执行“更换元件/修复”撤除故障注入，再上电验证。')
  if (state.stage === 'completed') return reject(state, '当前排故题目已完成上电验证并结项。')
  if (!options.powered) return reject(state, '请先上电运行，在带电状态下测量验证修复后的电路恢复正常。')
  if (!options.snapshot?.current) return reject(state, '当前仿真读数尚未就绪，请等待上电读数更新后再验证。')

  const explicitSource =
    options.selectedSource && options.selectedSource !== 'auto' ? options.selectedSource : undefined
  if (fault.verify && fault.verify.length > 0) {
    let matchedCount = 0
    for (const expectation of fault.verify) {
      const point = project.reference.measurePoints.find((item) => item.id === expectation.measurePoint)
      if (!point) continue
      const capture = captureMeasurePoint(options.snapshot, point, explicitSource)
      if (!capture.ok) continue
      matchedCount++
      const val = capture.measurement.referenceValueSI
      if (val < expectation.min || val > expectation.max) {
        return reject(
          state,
          `验证未通过：测量点 ${point.id} 当前实测值 ${Number(val.toPrecision(5))} ${measurementUnit(point)} 未恢复到正常范围 [${expectation.min}, ${expectation.max}] ${measurementUnit(point)}。请检查接线与电源设置。`,
        )
      }
    }
    if (matchedCount === 0) {
      const needed = fault.verify.map((item) => item.measurePoint).join(' / ')
      return reject(state, `请将测量仪表接到验证测量点（${needed}）并待读数稳定后再执行上电验证。`)
    }
  }

  const captured = collectValidMeasurements(project, options.snapshot, options.selectedSource)
  if (captured.length === 0) {
    return reject(state, '当前没有有效的验证测量读数，请接好仪表并上电测量后再验证结项。')
  }

  const nowMs = options.nowMs ?? Date.now()
  const elapsedMs = updateElapsed(state, nowMs)
  const measurementCount = state.measurementCount + 1
  const primary = captured[0] as (typeof captured)[number]
  const verifyEntry: FaultMeasurementRecord = {
    index: measurementCount,
    timestampMs: nowMs,
    pointId: primary.pointId,
    instanceId: primary.instanceId,
    valueSI: primary.valueSI,
    unit: primary.unit,
    summary: `[验证] ${captured.map((item) => item.summary).join('；')}`,
  }
  const record: FaultSessionRecord = {
    faultId: fault.id,
    target: fault.target,
    kind: fault.kind,
    mode: state.mode,
    measurementCount,
    wrongAttempts: state.wrongAttempts,
    elapsedMs,
    completedAtMs: nowMs,
  }
  const resolvedFaultIds = state.resolvedFaultIds.includes(fault.id)
    ? state.resolvedFaultIds
    : [...state.resolvedFaultIds, fault.id]
  return {
    ok: true,
    state: {
      ...state,
      stage: 'completed',
      injectedFaultId: undefined,
      completedAtMs: nowMs,
      elapsedMs,
      measurementCount,
      measurements: [...state.measurements, verifyEntry],
      resolvedFaultIds,
      history: [...state.history, record],
    },
    message: `上电验证通过，排故结项！故障 ${fault.target}（${FAULT_KIND_LABELS[fault.kind]}）已排除，共测量 ${measurementCount} 次、误判 ${state.wrongAttempts} 次、用时 ${(elapsedMs / 1000).toFixed(1)} s。`,
  }
}
