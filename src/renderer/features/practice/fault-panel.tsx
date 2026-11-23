import { listSubcktElements } from '@domain/circuit/fault'
import {
  activeFaultDefinition,
  FAULT_KIND_LABELS,
  FAULT_KINDS,
  type FaultKind,
  type FaultSelectionMode,
  faultCandidateTargets,
  faultStepStatuses,
} from '@domain/task'
import type { Project } from '@shared/schema/project'
import { useEffect, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import {
  observeTaskFaultSymptom,
  recordTaskFaultMeasurement,
  repairTaskFault,
  startTaskFaultSession,
  submitTaskFaultDiagnosis,
  useTask,
  verifyTaskFaultRepair,
} from '@/stores/task'
import { moduleCatalog, moduleNetlist } from './practice-content'
import { useCircuit } from './wiring-state'

export function FaultPanel({ project }: { project?: Project }) {
  const flow = useTask((state) => state.faultFlow)
  const notice = useTask((state) => state.notice)
  const powered = useCircuit((state) => state.powered)
  const [mode, setMode] = useState<FaultSelectionMode>('preset')
  const [presetFaultId, setPresetFaultId] = useState<string>('')
  const [selectedTarget, setSelectedTarget] = useState<string>('')
  const [selectedKind, setSelectedKind] = useState<FaultKind>('open')
  const [nowMs, setNowMs] = useState<number>(() => Date.now())

  const modeId = useId()
  const presetId = useId()
  const targetId = useId()
  const kindId = useId()

  const faults = project?.faults ?? []
  const activeFault = project ? activeFaultDefinition(project, flow) : undefined

  const candidates = useMemo(() => {
    if (!project) return []
    const extra: string[] = []
    for (const modRef of project.modules) {
      const mod = moduleCatalog.find((entry) => entry.id === modRef.moduleId)
      if (!mod) continue
      for (const el of listSubcktElements(moduleNetlist(mod))) {
        extra.push(`${modRef.instanceId}.${el.name}`)
      }
    }
    return faultCandidateTargets(project, extra)
  }, [project])

  useEffect(() => {
    const firstFault = faults[0]?.id ?? ''
    setPresetFaultId((current) => (faults.some((f) => f.id === current) ? current : firstFault))
  }, [faults])

  useEffect(() => {
    const firstTarget = candidates[0] ?? ''
    setSelectedTarget((current) => (candidates.includes(current) ? current : firstTarget))
  }, [candidates])

  useEffect(() => {
    if (flow.stage === 'idle' || flow.stage === 'completed' || flow.startedAtMs === undefined) return
    setNowMs(Date.now())
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [flow.stage, flow.startedAtMs])

  if (!project) {
    return <p className="p-3 text-xs text-muted-foreground">当前未选择有效实训项目。</p>
  }

  if (faults.length === 0) {
    return (
      <section aria-label="故障排查" data-fault-stage="idle" className="space-y-2 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          当前项目未配置故障库。可切换到排故专项项目（如 MD-07 三极管放大电路故障排除）进行故障设置与排查训练。
        </p>
      </section>
    )
  }

  const steps = faultStepStatuses(flow)
  const elapsedMs =
    flow.stage === 'idle'
      ? 0
      : flow.stage === 'completed'
        ? flow.elapsedMs
        : flow.startedAtMs !== undefined
          ? Math.max(flow.elapsedMs, Math.max(0, nowMs - flow.startedAtMs))
          : flow.elapsedMs

  return (
    <section
      aria-label="故障排查"
      data-fault-stage={flow.stage}
      data-active-fault={flow.activeFaultId ?? ''}
      data-injected-fault={flow.injectedFaultId ?? ''}
      data-measurement-count={flow.measurementCount}
      data-wrong-attempts={flow.wrongAttempts}
      data-resolved-count={flow.resolvedFaultIds.length}
      className="space-y-3 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">排故训练</h3>
        <span className="font-mono text-xs text-muted-foreground" data-fault-progress>
          已排故 {flow.resolvedFaultIds.length}/{faults.length}
        </span>
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <label htmlFor={modeId} className="text-xs text-muted-foreground">
            抽题方式
          </label>
          <Select value={mode} onValueChange={(value) => setMode(value as FaultSelectionMode)}>
            <SelectTrigger id={modeId} aria-label="抽题方式" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="preset">系统预设</SelectItem>
              <SelectItem value="random">随机抽取</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === 'preset' && (
          <div className="space-y-1">
            <label htmlFor={presetId} className="text-xs text-muted-foreground">
              预设故障题目
            </label>
            <Select value={presetFaultId} onValueChange={setPresetFaultId}>
              <SelectTrigger id={presetId} aria-label="预设故障题目" className="w-full">
                <SelectValue placeholder="选择预设故障" />
              </SelectTrigger>
              <SelectContent>
                {faults.map((fault, index) => {
                  const done = flow.resolvedFaultIds.includes(fault.id)
                  return (
                    <SelectItem key={fault.id} value={fault.id}>
                      故障 #{index + 1}（{fault.id}）{done ? ' · 已排故' : ''}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
        )}

        <Button
          size="sm"
          className="w-full"
          variant={flow.stage === 'idle' || flow.stage === 'completed' ? 'default' : 'outline'}
          onClick={() =>
            startTaskFaultSession(project, {
              mode,
              ...(mode === 'preset' ? { faultId: presetFaultId } : {}),
            })
          }
        >
          {flow.stage === 'idle' ? '开始排故' : mode === 'random' ? '随机抽取下一题' : '注入所选故障'}
        </Button>
        {powered && flow.stage === 'idle' && (
          <p className="text-xs text-warning">当前已上电，请先断电后再抽取或注入故障题目。</p>
        )}
      </div>

      <Separator />

      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">排故六步流程</h4>
        <ol className="grid grid-cols-2 gap-1 text-xs">
          {steps.map((step) => (
            <li
              key={step.id}
              data-fault-step={step.id}
              data-fault-step-status={step.status}
              className={cn(
                'rounded-sm border px-2 py-1',
                step.status === 'completed' && 'border-success text-success',
                step.status === 'current' && 'border-primary text-primary',
                step.status === 'failed' && 'border-destructive text-destructive',
                step.status === 'pending' && 'text-muted-foreground',
              )}
            >
              {step.title}
            </li>
          ))}
        </ol>
      </div>

      {activeFault && (
        <div className="space-y-2 rounded-md border p-2 text-xs">
          <div className="flex items-center justify-between gap-2 font-mono text-muted-foreground" data-fault-stats>
            <span>测量 {flow.measurementCount} 次</span>
            <span>误判 {flow.wrongAttempts} 次</span>
            <span>用时 {(elapsedMs / 1000).toFixed(1)} s</span>
          </div>
          <p className="leading-relaxed" data-fault-symptom>
            <span className="font-medium">故障现象：</span>
            {activeFault.symptom}
          </p>
        </div>
      )}

      {flow.stage === 'observe' && (
        <div className="space-y-2">
          <Button size="sm" variant="outline" className="w-full" onClick={() => observeTaskFaultSymptom(project)}>
            确认异常现象
          </Button>
          <Button size="sm" className="w-full" onClick={() => recordTaskFaultMeasurement(project)}>
            记录排故测量
          </Button>
        </div>
      )}

      {flow.stage === 'measure' && (
        <div className="space-y-2">
          <Button size="sm" variant="outline" className="w-full" onClick={() => recordTaskFaultMeasurement(project)}>
            记录排故测量（当前仪表读数）
          </Button>
          <div className="space-y-1">
            <label htmlFor={targetId} className="text-xs text-muted-foreground">
              疑似故障元件
            </label>
            <Select value={selectedTarget} onValueChange={setSelectedTarget}>
              <SelectTrigger id={targetId} aria-label="疑似故障元件" className="w-full">
                <SelectValue placeholder="选择故障元件位号" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((target) => (
                  <SelectItem key={target} value={target}>
                    {target}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor={kindId} className="text-xs text-muted-foreground">
              疑似故障类型
            </label>
            <Select value={selectedKind} onValueChange={(value) => setSelectedKind(value as FaultKind)}>
              <SelectTrigger id={kindId} aria-label="疑似故障类型" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FAULT_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {FAULT_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            className="w-full"
            onClick={() => submitTaskFaultDiagnosis(project, selectedTarget, selectedKind)}
          >
            提交故障判定
          </Button>
        </div>
      )}

      {flow.stage === 'repair' && (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            系统已判定正确。请先断电，再点击下方按钮更换故障元件并撤除故障注入。
          </p>
          <Button size="sm" className="w-full" onClick={() => repairTaskFault(project)}>
            更换元件/修复
          </Button>
        </div>
      )}

      {flow.stage === 'verify' && (
        <div className="space-y-2">
          <p className="text-xs leading-relaxed text-warning">
            故障元件已更换，尚未结项。请重新上电并测量正常节点电位/波形，完成上电验证后结项。
          </p>
          <Button size="sm" className="w-full" onClick={() => verifyTaskFaultRepair(project)}>
            上电验证并结项
          </Button>
        </div>
      )}

      {flow.stage === 'completed' && activeFault && (
        <div data-fault-completed="true" className="rounded-md border border-success p-2 text-xs text-success">
          排故已验证结项：{activeFault.target}（{FAULT_KIND_LABELS[activeFault.kind]}
          ）。可断电后抽取下一道故障继续训练。
        </div>
      )}

      {flow.lastVerdict && (
        <p
          role="status"
          data-fault-verdict={flow.lastVerdict.correct ? 'correct' : 'wrong'}
          className={cn(
            'rounded-sm border p-2 text-xs leading-relaxed',
            flow.lastVerdict.correct ? 'border-success text-success' : 'border-destructive text-destructive',
          )}
        >
          {flow.lastVerdict.message}
        </p>
      )}

      {notice && (
        <p data-fault-notice className="text-xs leading-relaxed text-muted-foreground">
          {notice}
        </p>
      )}

      {flow.measurements.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">测量定位记录</h4>
          <ol data-fault-measurements className="space-y-1 font-mono text-xs text-muted-foreground">
            {flow.measurements.map((item) => (
              <li key={item.index} className="rounded-sm border px-2 py-1">
                #{item.index} {item.summary}
              </li>
            ))}
          </ol>
        </div>
      )}

      {flow.history.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted-foreground">排故完成记录</h4>
          <ul data-fault-history className="space-y-1 text-xs text-muted-foreground">
            {flow.history.map((record) => (
              <li key={`${record.faultId}-${record.completedAtMs}`} className="rounded-sm border px-2 py-1">
                <span className="font-mono">
                  {record.faultId} ({record.target})
                </span>
                ：测 {record.measurementCount} 次 / 误判 {record.wrongAttempts} 次 /{' '}
                {(record.elapsedMs / 1000).toFixed(1)} s
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
