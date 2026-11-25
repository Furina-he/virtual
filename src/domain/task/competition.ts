import type { CompetitionSpec, Project } from '../../shared/schema/project.ts'
import { captureMeasurePoint, type MeasurementSnapshot } from './measurements.ts'

// TSK-08：竞赛类任务（给定频率/幅值/波形指标，限时调试并按真实实测达成度判定）。纯 TS 领域模块。

export type CompetitionCriterionResult = {
  id: string
  passed: boolean
  measured: number | null
  message: string
}

export type CompetitionStatus = 'idle' | 'running' | 'passed' | 'expired'

export type CompetitionState = {
  status: CompetitionStatus
  startedAtMs: number | null
  elapsedSec: number
  remainingSec: number
  results: Record<string, CompetitionCriterionResult>
  passedCount: number
  totalCount: number
  scorePct: number
  message: string | null
}

export function createCompetitionState(spec?: CompetitionSpec): CompetitionState {
  const totalCount = spec?.criteria.length ?? 0
  return {
    status: 'idle',
    startedAtMs: null,
    elapsedSec: 0,
    remainingSec: spec?.timeLimitSec ?? 0,
    results: {},
    passedCount: 0,
    totalCount,
    scorePct: 0,
    message: null,
  }
}

export function startCompetition(spec: CompetitionSpec, nowMs: number): CompetitionState {
  return {
    status: 'running',
    startedAtMs: nowMs,
    elapsedSec: 0,
    remainingSec: spec.timeLimitSec,
    results: {},
    passedCount: 0,
    totalCount: spec.criteria.length,
    scorePct: 0,
    message: `竞赛计时已开始（限时 ${Math.round(spec.timeLimitSec / 60)} 分钟），请按给定指标自主搭接并调校波形后点击“核验竞赛指标”。`,
  }
}

export function tickCompetition(spec: CompetitionSpec, state: CompetitionState, nowMs: number): CompetitionState {
  if (state.status !== 'running' || state.startedAtMs === null) return state
  const elapsedSec = Math.max(0, Math.floor((nowMs - state.startedAtMs) / 1000))
  const remainingSec = Math.max(0, spec.timeLimitSec - elapsedSec)
  if (remainingSec === 0) {
    return {
      ...state,
      status: 'expired',
      elapsedSec: spec.timeLimitSec,
      remainingSec: 0,
      message: `竞赛计时已结束（达成 ${state.passedCount}/${state.totalCount} 项，达成度 ${state.scorePct}%）。`,
    }
  }
  return elapsedSec === state.elapsedSec ? state : { ...state, elapsedSec, remainingSec }
}

export function evaluateCompetition(
  project: Project,
  state: CompetitionState,
  snapshot: MeasurementSnapshot | undefined,
  nowMs: number,
  selectedMeters?: Readonly<Record<string, string>>,
): CompetitionState {
  const spec = project.competition
  if (!spec) return state
  const base = state.status === 'idle' ? startCompetition(spec, nowMs) : tickCompetition(spec, state, nowMs)
  if (base.status === 'expired') return base

  const results: Record<string, CompetitionCriterionResult> = { ...base.results }
  for (const criterion of spec.criteria) {
    const point = project.reference.measurePoints.find((item) => item.id === criterion.measurePoint)
    if (!point) continue
    const captured = captureMeasurePoint(snapshot, point, selectedMeters?.[point.id])
    if (!captured.ok) {
      // 保留本轮未切换探头前已核验通过的指标，避免示波器通道数限制导致无法逐项验收
      if (results[criterion.id]?.passed) continue
      results[criterion.id] = {
        id: criterion.id,
        passed: false,
        measured: null,
        message: captured.message,
      }
      continue
    }
    const measured = captured.measurement.referenceValueSI
    const passed = measured >= criterion.min && measured <= criterion.max
    results[criterion.id] = {
      id: criterion.id,
      passed,
      measured,
      message: passed
        ? `实测 ${measured.toFixed(2)} ${criterion.unit}（达标）`
        : `实测 ${measured.toFixed(2)} ${criterion.unit}，要求 ${criterion.min}~${criterion.max} ${criterion.unit}`,
    }
  }

  const totalCount = spec.criteria.length
  const passedCount = spec.criteria.filter((c) => results[c.id]?.passed).length
  const scorePct = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0
  const allPassed = passedCount === totalCount && totalCount > 0
  return {
    ...base,
    status: allPassed ? 'passed' : 'running',
    results,
    passedCount,
    totalCount,
    scorePct,
    message: allPassed
      ? `全部 ${totalCount} 项竞赛指标已达标（达成度 100%，用时 ${base.elapsedSec} s）！`
      : `当前已达标 ${passedCount}/${totalCount} 项（达成度 ${scorePct}%），请继续微调参数并接测剩余指标。`,
  }
}
