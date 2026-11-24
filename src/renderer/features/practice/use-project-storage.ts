import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { resetScopeAcquisition } from '@/lib/scope-acquisition'
import { buildProjectSaveFile, restoreTaskFromSave, taskStore } from '@/stores/task'
import type { RecoveryCheckResult } from '../../../shared/ipc/storage'
import type { Project } from '../../../shared/schema/project'
import type { SaveFile } from '../../../shared/schema/save'
import { resetModuleSelection } from './module-controls'
import { circuitStore, restoreProjectCircuit } from './wiring-state'

export const AUTOSAVE_DEBOUNCE_MS = 2000

export type AutosaveStatus = 'idle' | 'pending' | 'saved' | 'error'

type ProjectStorageState = {
  recovery: RecoveryCheckResult | null
  hasManualSave: boolean
  autosaveStatus: AutosaveStatus
  lastSavedAt: string | null
}

/** 独立状态切片，避免 2 s 防抖自动存档状态变更触发整个 Workbench（含 3D 与 KaTeX 指导书）重渲染。 */
export const projectStorageStore = createStore<ProjectStorageState>(() => ({
  recovery: null,
  hasManualSave: false,
  autosaveStatus: 'idle',
  lastSavedAt: null,
}))

export function useProjectStorageState<T>(selector: (state: ProjectStorageState) => T): T {
  return useStore(projectStorageStore, selector)
}

type WatchedRefs = {
  projectId: string
  wires: unknown
  placedInstruments: unknown
  controlValues: unknown
  activeFault: string | null
  completedSteps: unknown
  tables: unknown
  answers: unknown
  guideMode: string
  faultHistoryLen: number
  faultMeasurements: number
  faultWrong: number
}

function captureWatchedRefs(projectId: string): WatchedRefs {
  const c = circuitStore.getState()
  const t = taskStore.getState()
  const match = t.projectId === projectId
  return {
    projectId,
    wires: c.wires,
    placedInstruments: c.placedInstruments,
    controlValues: c.controlValues,
    activeFault: c.activeFault ?? null,
    completedSteps: match ? t.task.completedSteps : null,
    tables: match ? t.task.tables : null,
    answers: match ? t.answers : null,
    guideMode: match ? t.guideMode : 'guided',
    faultHistoryLen: match ? t.faultFlow.history.length : 0,
    faultMeasurements: match ? t.faultFlow.measurementCount : 0,
    faultWrong: match ? t.faultFlow.wrongAttempts : 0,
  }
}

function sameWatchedRefs(a: WatchedRefs | null, b: WatchedRefs): boolean {
  if (!a) return false
  return (
    a.projectId === b.projectId &&
    a.wires === b.wires &&
    a.placedInstruments === b.placedInstruments &&
    a.controlValues === b.controlValues &&
    a.activeFault === b.activeFault &&
    a.completedSteps === b.completedSteps &&
    a.tables === b.tables &&
    a.answers === b.answers &&
    a.guideMode === b.guideMode &&
    a.faultHistoryLen === b.faultHistoryLen &&
    a.faultMeasurements === b.faultMeasurements &&
    a.faultWrong === b.faultWrong
  )
}

function persistenceFingerprint(projectId: string): string {
  const c = circuitStore.getState()
  const t = taskStore.getState()
  return JSON.stringify([
    projectId,
    c.wires,
    c.placedInstruments,
    c.controlValues,
    c.activeFault ?? null,
    t.projectId === projectId ? t.task.completedSteps : [],
    t.projectId === projectId ? t.task.tables : {},
    t.projectId === projectId ? t.answers : {},
    t.projectId === projectId ? t.guideMode : 'guided',
    t.projectId === projectId ? t.faultFlow.history.length : 0,
    t.projectId === projectId ? t.faultFlow.measurementCount : 0,
    t.projectId === projectId ? t.faultFlow.wrongAttempts : 0,
  ])
}

export function useProjectStorage(project: Project | undefined, enabled: boolean) {
  const suppressRef = useRef(false)
  const baselineRef = useRef<string>('')
  const lastSeenRefs = useRef<WatchedRefs | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const applySave = useCallback(
    (targetProject: Project, save: SaveFile, noticeMessage: string) => {
      suppressRef.current = true
      clearPendingTimer()
      try {
        resetScopeAcquisition()
        resetModuleSelection()
        restoreProjectCircuit(save)
        restoreTaskFromSave(targetProject, save, noticeMessage)
        baselineRef.current = persistenceFingerprint(targetProject.id)
        lastSeenRefs.current = captureWatchedRefs(targetProject.id)
        projectStorageStore.setState({
          autosaveStatus: 'saved',
          lastSavedAt: save.updatedAt,
        })
      } finally {
        suppressRef.current = false
      }
    },
    [clearPendingTimer],
  )

  // 进入项目时检测未正常关闭留下的 .autosave 与已有手动存档
  useEffect(() => {
    clearPendingTimer()
    projectStorageStore.setState({
      recovery: null,
      hasManualSave: false,
      autosaveStatus: 'idle',
      lastSavedAt: null,
    })
    if (!project || !enabled) {
      lastSeenRefs.current = null
      return
    }

    baselineRef.current = persistenceFingerprint(project.id)
    lastSeenRefs.current = captureWatchedRefs(project.id)
    let canceled = false
    window.api.storage
      .checkRecovery(project.id)
      .then((result) => {
        if (canceled) return
        projectStorageStore.setState({
          hasManualSave: result.hasManualSave,
          ...(result.hasAutosave || result.autosaveCorrupt ? { recovery: result } : {}),
        })
      })
      .catch(() => {
        // 忽略启动探测异常，不阻塞正常实训
      })
    return () => {
      canceled = true
    }
  }, [project, enabled, clearPendingTimer])

  // 监听接线、仪表、控件、数据表、思考题与排故变化，做 2 s 防抖自动存档
  useEffect(() => {
    if (!project || !enabled) return
    const projectId = project.id

    const scheduleAutosave = () => {
      if (suppressRef.current) return
      if (taskStore.getState().projectId !== projectId) return
      // O(1) 引用快路径：忽略 powered/notice/pendingJack 等不入存档的瞬态字段更新
      const nextRefs = captureWatchedRefs(projectId)
      if (sameWatchedRefs(lastSeenRefs.current, nextRefs)) return
      lastSeenRefs.current = nextRefs

      const current = persistenceFingerprint(projectId)
      if (current === baselineRef.current) return
      if (projectStorageStore.getState().autosaveStatus !== 'pending') {
        projectStorageStore.setState({ autosaveStatus: 'pending' })
      }
      clearPendingTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (suppressRef.current || taskStore.getState().projectId !== projectId) return
        const save = buildProjectSaveFile(project)
        const savedFingerprint = persistenceFingerprint(projectId)
        void window.api.storage
          .writeAutosave(save)
          .then((result) => {
            if (result.ok) {
              baselineRef.current = savedFingerprint
              projectStorageStore.setState({
                autosaveStatus: 'saved',
                lastSavedAt: result.updatedAt,
              })
            } else {
              projectStorageStore.setState({ autosaveStatus: 'error' })
            }
          })
          .catch(() => {
            projectStorageStore.setState({ autosaveStatus: 'error' })
          })
      }, AUTOSAVE_DEBOUNCE_MS)
    }

    const unsubCircuit = circuitStore.subscribe(scheduleAutosave)
    const unsubTask = taskStore.subscribe(scheduleAutosave)
    return () => {
      unsubCircuit()
      unsubTask()
      clearPendingTimer()
    }
  }, [project, enabled, clearPendingTimer])

  const saveManual = useCallback(async () => {
    if (!project) return false
    clearPendingTimer()
    const save = buildProjectSaveFile(project)
    const fp = persistenceFingerprint(project.id)
    const result = await window.api.storage.saveManual(save)
    taskStore.setState({ notice: result.message })
    if (result.ok) {
      baselineRef.current = fp
      lastSeenRefs.current = captureWatchedRefs(project.id)
      projectStorageStore.setState({
        hasManualSave: true,
        autosaveStatus: 'saved',
        lastSavedAt: result.updatedAt,
        recovery: null,
      })
      toast.success(result.message)
      return true
    }
    toast.error(result.message)
    return false
  }, [project, clearPendingTimer])

  const loadManual = useCallback(async () => {
    if (!project) return false
    const result = await window.api.storage.loadManual(project.id)
    if (result.status === 'ok') {
      applySave(project, result.save, `已读取 ${project.id} 手动存档，当前处于断电状态。`)
      projectStorageStore.setState({ recovery: null })
      toast.success(`已读取 ${project.id} 手动存档（已保持断电）。`)
      return true
    }
    const message = result.status === 'missing' ? '当前项目尚无本地手动存档。' : result.message
    taskStore.setState({ notice: message })
    toast.error(message)
    return false
  }, [project, applySave])

  const restoreAutosave = useCallback(async () => {
    const recovery = projectStorageStore.getState().recovery
    if (!project || !recovery) return false
    if (recovery.hasAutosave && recovery.autosave) {
      applySave(project, recovery.autosave, `已从自动存档恢复 ${project.id} 进度，当前处于断电状态。`)
      projectStorageStore.setState({ recovery: null })
      toast.success('已恢复自动存档进度（已保持断电）。')
      return true
    }
    if (recovery.autosaveCorrupt && recovery.hasManualSave && recovery.manualSave) {
      applySave(project, recovery.manualSave, `自动存档已损坏，已回退恢复 ${project.id} 上次手动存档（已保持断电）。`)
      await window.api.storage.clearAutosave(project.id).catch(() => {})
      projectStorageStore.setState({ recovery: null })
      toast.success('已回退到上次手动存档（已保持断电）。')
      return true
    }
    return false
  }, [project, applySave])

  const discardAutosave = useCallback(async () => {
    if (!project) return
    clearPendingTimer()
    await window.api.storage.clearAutosave(project.id).catch(() => {})
    baselineRef.current = persistenceFingerprint(project.id)
    lastSeenRefs.current = captureWatchedRefs(project.id)
    projectStorageStore.setState({ recovery: null, autosaveStatus: 'idle' })
    taskStore.setState({ notice: '已丢弃未保存的自动存档，从初始台面开始。' })
  }, [project, clearPendingTimer])

  const notifyProjectReset = useCallback(() => {
    clearPendingTimer()
    projectStorageStore.setState({ recovery: null, autosaveStatus: 'idle' })
    if (!project) return
    baselineRef.current = persistenceFingerprint(project.id)
    lastSeenRefs.current = captureWatchedRefs(project.id)
    void window.api.storage.clearAutosave(project.id).catch(() => {})
  }, [project, clearPendingTimer])

  return {
    saveManual,
    loadManual,
    restoreAutosave,
    discardAutosave,
    notifyProjectReset,
  }
}
