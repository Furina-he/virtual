import {
  AlertTriangle,
  ArrowLeft,
  Cable,
  ClipboardCheck,
  FileDown,
  FolderOpen,
  Gauge,
  ListChecks,
  Maximize2,
  Monitor,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Power,
  RotateCcw,
  Save,
  Settings as SettingsIcon,
} from 'lucide-react'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { usePanelRef } from 'react-resizable-panels'
import { useNavigate, useParams } from 'react-router'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SchematicViewer } from '@/features/schematic/schematic-viewer'
import { benchCircuitInput, connectInstrumentRuntime } from '@/lib/instrument-runtime'
import { resetScopeAcquisition } from '@/lib/scope-acquisition'
import { useSimRestartNotice } from '@/lib/use-sim-restart-notice'
import { cn } from '@/lib/utils'
import { instrumentDockStore } from '@/stores/instrument-dock'
import { useInstrumentPanels } from '@/stores/instrument-panels'
import { settingsStore, useSettings } from '@/stores/settings'
import { resetSimulationStatus, setSimulationStatus, useSimulationStatus } from '@/stores/simulation-status'
import { resetTask, setTaskGuideMode, taskStore, useTask } from '@/stores/task'
import { focusedInstance, useBenchView } from '@/three/bench-view'
import { BenchViewport3D } from '@/three/bench-viewport'
import { qualityPreset, useQuality } from '@/three/quality-store'
import { formatRealtimeRatio } from '../../../domain/measurement/pace'
import { buildMeasurementPlan } from '../../../domain/measurement/plan'
import { assembleLabReport, currentTaskStep, GUIDE_MODE_LABELS, scopedReference } from '../../../domain/task'
import { checkWiring, detectDanger } from '../../../domain/wiring-check'
import type { Project } from '../../../shared/schema/project'
import { POWERED_INSTRUMENT_NOTICE, POWERED_WIRING_NOTICE } from '../../stores/circuit'
import { InstrumentCabinet } from './instrument-cabinet'
import { InstrumentDock } from './instrument-dock'
import { InstrumentPlacementProvider } from './instrument-placement'
import { LiveReadingsBar } from './live-readings-bar'
import { ModuleProperties, resetModuleSelection } from './module-controls'
import { findProject, projectGuide } from './practice-content'
import { TaskChartsPanel } from './task-charts'
import { recordTaskReadings, TaskDataPanel, TaskStepsPanel } from './task-panel'
import { usePersistedLayout } from './use-persisted-layout'
import { useProjectStorage, useProjectStorageState } from './use-project-storage'
import { WireContextMenu } from './wire-menu'
import { WiringShortcuts } from './wiring-panel'
import { activateProject, circuitStore, resetProject, useCircuit } from './wiring-state'
import 'katex/dist/katex.min.css'

type PanelHandle = ReturnType<typeof usePanelRef>
type StagePreset = 'standard' | 'wiring' | 'debug'

function toggle(ref: PanelHandle) {
  const p = ref.current
  if (!p) return
  if (p.isCollapsed()) p.expand()
  else p.collapse()
}

/** 专注台面：三栏都收起时恢复，否则一起收起，让视口占满工作区（T0.16 P1）。 */
function toggleFocusBench(refs: PanelHandle[]) {
  const panels = refs.flatMap((ref) => (ref.current ? [ref.current] : []))
  const focused = panels.every((panel) => panel.isCollapsed())
  for (const panel of panels) {
    if (focused) panel.expand()
    else panel.collapse()
  }
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" onClick={onClick}>
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function TopBar({
  refs,
  sceneReady,
  project,
  stagePreset,
  onSelectStagePreset,
  onClearStagePreset,
  onSaveManual,
  onLoadManual,
  onReset,
}: {
  refs: Record<'left' | 'right' | 'bottom', PanelHandle>
  sceneReady: boolean
  project?: Project
  stagePreset: StagePreset
  onSelectStagePreset: (preset: 'wiring' | 'debug') => void
  onClearStagePreset: () => void
  onSaveManual: () => void
  onLoadManual: () => void
  onReset: () => void
}) {
  const navigate = useNavigate()
  const { projectId } = useParams()
  const powered = useCircuit((s) => s.powered)
  const togglePower = useCircuit((s) => s.togglePower)
  const hasManualSave = useProjectStorageState((s) => s.hasManualSave)
  const [exporting, setExporting] = useState(false)
  const guideMode = useTask((state) => state.guideMode)
  const task = useTask((state) => (state.projectId === project?.id ? state.task : undefined))
  const step = project?.steps.filter((entry) => task?.completedSteps.includes(entry.id)).length ?? 0
  const steps = project?.steps.length ?? 0
  const toggleGuideMode = () => {
    const next = guideMode === 'guided' ? 'free' : 'guided'
    if (next === 'free') {
      useBenchView.getState().setShowGuide(false)
      useBenchView.getState().setHighlightedLink(null)
    }
    setTaskGuideMode(next)
  }
  const exportReport = async () => {
    if (!project || exporting) return
    setExporting(true)
    try {
      const state = taskStore.getState()
      const report = assembleLabReport({
        project,
        guideMarkdown: projectGuide(project),
        task: state.task,
        answers: state.answers,
        screenshots: state.screenshots,
        faultFlow: state.faultFlow,
      })
      const result = await window.api.report.exportPdf(report)
      taskStore.setState({ notice: result.message })
      if (result.ok) {
        toast.success(result.message)
      } else if (!result.canceled) {
        toast.error(result.message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 PDF 实训报告失败。'
      taskStore.setState({ notice: message })
      toast.error(message)
    } finally {
      setExporting(false)
    }
  }
  const check = () => {
    if (!project) return
    try {
      const plan = buildMeasurementPlan(benchCircuitInput(), powered, 'check')
      const danger = detectDanger(plan.checkInput)
      const state = taskStore.getState()
      const activeStep = currentTaskStep(project, state.task)
      const reference = scopedReference(project, activeStep)
      const report = checkWiring(plan.checkInput, reference)
      const issues = danger.length ? danger : report.issues
      const message = danger.length
        ? '存在电源短接或电流表并联接法。请先断电，检查电源两端和电流插孔。'
        : report.issues.length
          ? report.issues.map((issue) => issue.message).join(' ')
          : reference.measurePoints.length
            ? '电路拓扑和当前步骤的测量位置连接正确。档位仍需按指导设置，读数以实际量程和输入内阻为准。'
            : '电路拓扑连接正确。本步骤尚不要求接入测量仪表，请继续完成步骤。'
      useBenchView.getState().setDiagnosticIssues(issues, message)
      circuitStore.setState({ notice: message })
      if (issues.length > 0) {
        refs.right.current?.expand()
      }
      if (danger.length) {
        toast.error(message, {
          id: 'wiring-check',
          ...(powered
            ? {
                action: {
                  label: '立即断电',
                  onClick: () => {
                    if (circuitStore.getState().powered) circuitStore.getState().togglePower()
                  },
                },
              }
            : {}),
        })
      } else if (report.issues.length) {
        toast.warning(`接线检查发现 ${report.issues.length} 处问题，详见右侧接线诊断报告。`, { id: 'wiring-check' })
      } else {
        toast.success(message, { id: 'wiring-check' })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法检查当前接线。'
      circuitStore.setState({ notice: message })
      toast.error(message, { id: 'wiring-check' })
    }
  }
  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b px-2.5">
      <IconAction label="返回" onClick={() => navigate('/home')}>
        <ArrowLeft />
      </IconAction>
      <h1 className="min-w-16 flex-1 truncate text-sm font-medium xl:text-base" title={project?.title}>
        {project ? `${project.id} ${project.title}` : (projectId ?? '练习工作台')}
      </h1>
      <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Progress className="hidden w-14 2xl:block" value={steps ? (step / steps) * 100 : 0} aria-label="步骤进度" />
        <span className="font-mono text-xs whitespace-nowrap">
          {step}/{steps}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="gap-1 px-2 text-xs"
          data-top-guide-mode={guideMode}
          aria-label="切换引导或自主模式"
          onClick={toggleGuideMode}
          disabled={!sceneReady}
        >
          {GUIDE_MODE_LABELS[guideMode]}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 px-2 text-xs"
          onClick={check}
          disabled={!project || !sceneReady}
        >
          <ClipboardCheck />
          检查接线
        </Button>
        <Button
          size="sm"
          variant={powered ? 'destructive' : 'default'}
          className="gap-1 px-2 text-xs"
          onClick={togglePower}
          aria-pressed={powered}
          disabled={!sceneReady && !powered}
        >
          <Power />
          {powered ? '断电' : '上电'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 px-2 text-xs"
          disabled={!sceneReady || !project?.dataTables.length}
          onClick={() => {
            if (!project) return
            recordTaskReadings(project)
            refs.bottom.current?.expand()
            refs.left.current?.expand()
          }}
        >
          <Save />
          记录读数
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1 px-2 text-xs" disabled={!project || !sceneReady}>
              <FolderOpen />
              存档
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onSaveManual}>保存进度</DropdownMenuItem>
            <DropdownMenuItem onSelect={onLoadManual} disabled={!hasManualSave}>
              读取存档
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 px-2 text-xs"
          disabled={!project || !sceneReady || exporting}
          onClick={() => void exportReport()}
        >
          <FileDown />
          {exporting ? '导出中…' : '导出报告'}
        </Button>
        <Button size="sm" variant="ghost" className="gap-1 px-2 text-xs" onClick={onReset} disabled={!sceneReady}>
          <RotateCcw />
          重置
        </Button>
        <Separator orientation="vertical" className="mx-0.5 h-6" />
        <fieldset aria-label="阶段布局预设" className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant={stagePreset === 'wiring' ? 'secondary' : 'ghost'}
            className="gap-1 px-2 text-xs"
            aria-pressed={stagePreset === 'wiring'}
            data-stage-preset="wiring"
            onClick={() => onSelectStagePreset('wiring')}
          >
            <Cable />
            接线专注
          </Button>
          <Button
            size="sm"
            variant={stagePreset === 'debug' ? 'secondary' : 'ghost'}
            className="gap-1 px-2 text-xs"
            aria-pressed={stagePreset === 'debug'}
            data-stage-preset="debug"
            onClick={() => onSelectStagePreset('debug')}
          >
            <Gauge />
            调测专注
          </Button>
        </fieldset>
        <Separator orientation="vertical" className="mx-0.5 h-6" />
        <IconAction label="切换演示模式" onClick={() => void settingsStore.getState().togglePresentationMode()}>
          <Monitor />
        </IconAction>
        <IconAction label="系统设置" onClick={() => settingsStore.getState().setSettingsOpen(true)}>
          <SettingsIcon />
        </IconAction>
        <IconAction
          label="专注台面"
          onClick={() => {
            onClearStagePreset()
            toggleFocusBench([refs.left, refs.bottom, refs.right])
          }}
        >
          <Maximize2 />
        </IconAction>
        <IconAction
          label="显示/收起左栏"
          onClick={() => {
            onClearStagePreset()
            toggle(refs.left)
          }}
        >
          <PanelLeft />
        </IconAction>
        <IconAction
          label="显示/收起底栏"
          onClick={() => {
            onClearStagePreset()
            toggle(refs.bottom)
          }}
        >
          <PanelBottom />
        </IconAction>
        <IconAction
          label="显示/收起右栏"
          onClick={() => {
            onClearStagePreset()
            toggle(refs.right)
          }}
        >
          <PanelRight />
        </IconAction>
      </div>
    </header>
  )
}

function StatusBar() {
  const powered = useCircuit((s) => s.powered)
  const count = useCircuit((s) => s.wires.length)
  const quality = useQuality((state) => state.quality)
  const simulation = useSimulationStatus((state) => state)
  const autosaveStatus = useProjectStorageState((state) => state.autosaveStatus)
  const slow = simulation.pace?.slow === true
  const ratio = simulation.pace?.realtimeRatio ?? null
  const ratioText = ratio === null ? '' : formatRealtimeRatio(ratio)
  const autosaveLabel =
    autosaveStatus === 'pending'
      ? '待自动存档'
      : autosaveStatus === 'saved'
        ? '已自动存档'
        : autosaveStatus === 'error'
          ? '自动存档失败'
          : '未改动'
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t px-3 text-xs text-muted-foreground">
      <span className={cn('flex items-center gap-1', powered && 'text-success')}>
        <Power className="size-3" />
        {powered ? '已上电' : '未上电'}
      </span>
      <span
        className={cn(
          simulation.state === 'error' && 'text-destructive',
          simulation.state === 'protected' && 'text-warning',
        )}
        data-simulation-status={simulation.message}
        data-simulation-slow={slow ? 'true' : 'false'}
        data-realtime-ratio={ratio === null ? undefined : ratio.toFixed(3)}
      >
        仿真：{simulation.message}
      </span>
      {slow && (
        <Tooltip>
          <TooltipTrigger
            type="button"
            className="flex items-center gap-1 rounded-xs font-mono whitespace-nowrap text-warning focus-visible:outline-1"
            data-simulation-slow-notice="true"
          >
            <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
            <span role="status">慢于实时（{ratioText}）</span>
          </TooltipTrigger>
          <TooltipContent>
            {`当前电路计算慢于实时（约 ${ratioText}），仿真时间推进慢于真实时间。读数和波形仍为真实仿真结果，达到稳态需更长等待时间。`}
          </TooltipContent>
        </Tooltip>
      )}
      <span>导线：{count}</span>
      <span data-autosave-state={autosaveStatus} className={cn(autosaveStatus === 'error' && 'text-destructive')}>
        存档：{autosaveLabel}
      </span>
      <span className="ml-auto">画质：{qualityPreset(quality).label}</span>
    </footer>
  )
}

function Placeholder({ children }: { children: ReactNode }) {
  return <p className="p-3 text-muted-foreground">{children}</p>
}

const GUIDE_REMARK_PLUGINS = [remarkGfm, remarkMath]
const GUIDE_REHYPE_PLUGINS = [rehypeKatex]
const GUIDE_MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: ReactNode }) => <h2 className="text-base font-medium">{children}</h2>,
  h2: ({ children }: { children?: ReactNode }) => <h2 className="text-base font-medium">{children}</h2>,
  h3: ({ children }: { children?: ReactNode }) => <h3 className="pt-2 text-sm font-medium">{children}</h3>,
  p: ({ children }: { children?: ReactNode }) => <p className="text-sm leading-relaxed">{children}</p>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="list-decimal space-y-2 pl-5">{children}</ol>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="list-disc space-y-2 pl-5">{children}</ul>,
  table: ({ children }: { children?: ReactNode }) => <Table>{children}</Table>,
  thead: ({ children }: { children?: ReactNode }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }: { children?: ReactNode }) => <TableBody>{children}</TableBody>,
  tr: ({ children }: { children?: ReactNode }) => <TableRow>{children}</TableRow>,
  th: ({ children }: { children?: ReactNode }) => <TableHead>{children}</TableHead>,
  td: ({ children }: { children?: ReactNode }) => <TableCell>{children}</TableCell>,
}

const ProjectGuide = memo(function ProjectGuide({ project }: { project: Project }) {
  return (
    <div className="space-y-3 p-3">
      {project.validation && (
        <p className="border p-3 text-xs text-warning">{project.validation.purpose} 正式内容与目标机性能验收未完成。</p>
      )}
      <Markdown
        remarkPlugins={GUIDE_REMARK_PLUGINS}
        rehypePlugins={GUIDE_REHYPE_PLUGINS}
        components={GUIDE_MARKDOWN_COMPONENTS}
      >
        {projectGuide(project)}
      </Markdown>
    </div>
  )
})

function BenchFeedbackToasts({ bottomRef }: { bottomRef: PanelHandle }) {
  useEffect(() => {
    let prevNotice = circuitStore.getState().notice
    const unsubCircuit = circuitStore.subscribe((state) => {
      const nextNotice = state.notice
      if (
        state.powered &&
        nextNotice !== prevNotice &&
        (nextNotice === POWERED_WIRING_NOTICE || nextNotice === POWERED_INSTRUMENT_NOTICE)
      ) {
        toast.warning(nextNotice, {
          id: 'powered-guard',
          action: {
            label: '立即断电',
            onClick: () => {
              if (circuitStore.getState().powered) circuitStore.getState().togglePower()
            },
          },
        })
      }
      prevNotice = nextNotice
    })
    let prevRequest = useBenchView.getState().request
    const unsubView = useBenchView.subscribe((state) => {
      if (state.request === prevRequest) return
      prevRequest = state.request
      const target = focusedInstance(state.preset)
      if (!target) return
      if (circuitStore.getState().pendingJack) return
      if (useInstrumentPanels.getState().panels.some((panel) => panel.id === target)) {
        instrumentDockStore.getState().selectInstrument(target, { expandFixed: true })
        taskStore.setState({ bottomTab: 'instruments' })
        if (!settingsStore.getState().presentationMode) bottomRef.current?.expand()
      }
    })
    return () => {
      unsubCircuit()
      unsubView()
    }
  }, [bottomRef])
  return null
}

function RecoveryDialog({ onDiscard, onRestore }: { onDiscard: () => void; onRestore: () => void }) {
  const recovery = useProjectStorageState((s) => s.recovery)
  return (
    <Dialog
      open={Boolean(recovery)}
      onOpenChange={(open) => {
        if (!open) onDiscard()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>检测到未保存的自动存档</DialogTitle>
          <DialogDescription>
            {recovery?.hasAutosave && recovery.autosave
              ? `上次退出前自动保存了 ${recovery.autosave.circuit.wires.length} 根导线、${recovery.autosave.completedSteps.length} 个已完成步骤与数据记录（${new Date(recovery.autosave.updatedAt).toLocaleString('zh-CN', { hour12: false })}）。恢复后将保持断电状态。`
              : `${recovery?.corruptMessage ?? '自动存档文件已损坏。'}${recovery?.hasManualSave ? '可回退恢复上次手动存档，或丢弃并重新开始。' : '将从初始台面重新开始。'}`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDiscard}>
            丢弃自动存档
          </Button>
          {(recovery?.hasAutosave || recovery?.hasManualSave) && (
            <Button onClick={onRestore}>{recovery?.hasAutosave ? '恢复自动存档' : '回退到手动存档'}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 练习工作台（PRD 15.3）。各区可拖动、可折叠，尺寸持久化
export function Workbench() {
  useSimRestartNotice()
  const navigate = useNavigate()
  const { projectId } = useParams()
  const project = findProject(projectId)
  const [sceneReady, setSceneReady] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [activationError, setActivationError] = useState<string | null>(null)
  const [activationAttempt, setActivationAttempt] = useState(0)
  const [stagePreset, setStagePreset] = useState<StagePreset>('standard')
  const [cabinetCollapsed, setCabinetCollapsed] = useState(false)
  const leftTab = useTask((state) => state.leftTab)
  const bottomTab = useTask((state) => state.bottomTab)
  const guideMode = useTask((state) => state.guideMode)
  const resetVersion = useTask((state) => state.resetVersion)
  const presentationMode = useSettings((state) => state.presentationMode)
  const task = useTask((state) => (state.projectId === project?.id ? state.task : undefined))
  const guideNets = useMemo(() => {
    if (!project || !task) return undefined
    return scopedReference(project, currentTaskStep(project, task)).nets
  }, [project, task])
  const leftRef = usePanelRef()
  const rightRef = usePanelRef()
  const bottomRef = usePanelRef()
  const cabinetRef = usePanelRef()
  const main = usePersistedLayout('wb-main')
  const center = usePersistedLayout('wb-center')
  const right = usePersistedLayout('wb-right')
  const storage = useProjectStorage(project, !activationError)
  const handleSelectStagePreset = (next: 'wiring' | 'debug') => {
    if (stagePreset === next) {
      rightRef.current?.expand()
      bottomRef.current?.expand()
      bottomRef.current?.resize('34%')
      cabinetRef.current?.expand()
      setCabinetCollapsed(false)
      setStagePreset('standard')
      return
    }
    if (next === 'wiring') {
      bottomRef.current?.collapse()
      rightRef.current?.expand()
      cabinetRef.current?.collapse()
      setCabinetCollapsed(true)
      setStagePreset('wiring')
      return
    }
    rightRef.current?.collapse()
    bottomRef.current?.expand()
    bottomRef.current?.resize('46%')
    taskStore.setState({ bottomTab: 'instruments' })
    setStagePreset('debug')
  }
  useLayoutEffect(() => {
    try {
      const changed = activateProject(project)
      if (changed || taskStore.getState().projectId !== project?.id || activationAttempt > 0) {
        resetTask(project, settingsStore.getState().settings.guideMode)
        instrumentDockStore.getState().resetDock()
        useBenchView.getState().clearDiagnostics()
        resetScopeAcquisition()
        resetModuleSelection()
        setResetOpen(false)
      }
      setActivationError(null)
    } catch (error) {
      // Keep an invalid project's title and controls away from the previous learner circuit.
      resetProject()
      resetTask()
      instrumentDockStore.getState().resetDock()
      resetScopeAcquisition()
      resetModuleSelection()
      setResetOpen(false)
      setActivationError(error instanceof Error ? error.message : '无法挂载本项目的实训模块。')
    }
  }, [project, activationAttempt])
  useEffect(() => {
    if (activationError) {
      resetSimulationStatus()
      return
    }
    const disconnect = connectInstrumentRuntime(setSimulationStatus)
    return () => {
      disconnect()
      resetSimulationStatus()
    }
  }, [activationError])
  useEffect(() => {
    const openGuide = () => {
      leftRef.current?.expand()
    }
    window.addEventListener('virtual:open-guide', openGuide)
    return () => window.removeEventListener('virtual:open-guide', openGuide)
  }, [leftRef])
  const prevPresentation = useRef(presentationMode)
  useEffect(() => {
    if (prevPresentation.current === presentationMode) return
    prevPresentation.current = presentationMode
    if (presentationMode) {
      rightRef.current?.collapse()
      bottomRef.current?.collapse()
    } else {
      rightRef.current?.expand()
      bottomRef.current?.expand()
    }
  }, [presentationMode, rightRef, bottomRef])

  if (activationError) {
    return (
      <main className="workbench-shell flex flex-col items-start gap-3 p-4">
        <h1 className="text-base font-medium">项目器材未能加载</h1>
        <p role="alert" className="text-sm text-destructive">
          {activationError}
        </p>
        <p className="text-sm text-muted-foreground">
          台面已断电并清空。请检查项目模块、安装位和本地资源后重试，或返回其他项目。
        </p>
        <div className="flex gap-2">
          <Button onClick={() => setActivationAttempt((attempt) => attempt + 1)}>重试加载</Button>
          <Button variant="outline" onClick={() => navigate('/home')}>
            返回
          </Button>
        </div>
      </main>
    )
  }

  return (
    <InstrumentPlacementProvider allowedInstruments={project?.allowedInstruments}>
      <div className="workbench-shell flex flex-col">
        <WiringShortcuts />
        <WireContextMenu />
        <BenchFeedbackToasts bottomRef={bottomRef} />
        <TopBar
          refs={{ left: leftRef, right: rightRef, bottom: bottomRef }}
          sceneReady={sceneReady}
          project={project}
          stagePreset={stagePreset}
          onSelectStagePreset={handleSelectStagePreset}
          onClearStagePreset={() => setStagePreset('standard')}
          onSaveManual={() => void storage.saveManual()}
          onLoadManual={() => void storage.loadManual()}
          onReset={() => setResetOpen(true)}
        />
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" {...main}>
          <ResizablePanel
            id="left"
            className="overflow-hidden"
            panelRef={leftRef}
            defaultSize="18"
            minSize={220}
            collapsible
            collapsedSize={0}
          >
            <Tabs
              value={leftTab}
              onValueChange={(value) => taskStore.setState({ leftTab: value as typeof leftTab })}
              className="flex h-full flex-col gap-0"
            >
              <TabsList variant="line" className="w-full justify-start border-b px-1.5">
                <TabsTrigger className="flex-none px-2 text-xs" value="guide">
                  实训指导
                </TabsTrigger>
                <TabsTrigger className="flex-none px-2 text-xs" value="schematic">
                  原理图
                </TabsTrigger>
                <TabsTrigger className="flex-none gap-1 px-2 text-xs" value="steps">
                  <ListChecks className="size-3.5" />
                  步骤
                </TabsTrigger>
              </TabsList>
              <TabsContent value="guide" className="min-h-0 overflow-auto">
                {project ? (
                  <ProjectGuide project={project} />
                ) : (
                  <Placeholder>该项目内容尚未交付；当前台面仅供仪表和接线功能验证。</Placeholder>
                )}
              </TabsContent>
              <TabsContent value="schematic" className="min-h-0 overflow-auto">
                {project ? <SchematicViewer project={project} /> : <Placeholder>该项目的原理图尚未交付。</Placeholder>}
              </TabsContent>
              <TabsContent value="steps" className="min-h-0 overflow-auto">
                {project ? <TaskStepsPanel project={project} /> : <Placeholder>该项目步骤尚未交付。</Placeholder>}
              </TabsContent>
            </Tabs>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="center" minSize="30" className="min-h-0">
            <ResizablePanelGroup orientation="vertical" className="min-h-0 overflow-hidden" {...center}>
              <ResizablePanel id="viewport" minSize={200}>
                <BenchViewport3D
                  onReadyChange={setSceneReady}
                  guideNets={guideNets}
                  guideMode={guideMode}
                  onGuideBlocked={(message) => {
                    taskStore.setState({ notice: message })
                    circuitStore.setState({ notice: message })
                  }}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                id="bottom"
                className="relative overflow-hidden"
                panelRef={bottomRef}
                defaultSize="34"
                minSize={160}
                collapsible
                collapsedSize={0}
              >
                <Tabs
                  value={bottomTab}
                  onValueChange={(value) => taskStore.setState({ bottomTab: value as typeof bottomTab })}
                  className="flex h-full flex-col gap-0"
                >
                  <div className="flex shrink-0 items-center border-b">
                    <TabsList variant="line" className="w-auto shrink-0 justify-start px-1.5">
                      <TabsTrigger className="flex-none px-2 text-xs" value="instruments">
                        仪表
                      </TabsTrigger>
                      <TabsTrigger className="flex-none px-2 text-xs" value="data">
                        数据记录
                      </TabsTrigger>
                      <TabsTrigger className="flex-none px-2 text-xs" value="charts">
                        曲线
                      </TabsTrigger>
                      <TabsTrigger className="flex-none px-2 text-xs" value="log">
                        日志
                      </TabsTrigger>
                    </TabsList>
                    <LiveReadingsBar project={project} />
                  </div>
                  <TabsContent value="instruments" className="flex min-h-0 flex-1 overflow-hidden">
                    <InstrumentDock project={project} />
                  </TabsContent>
                  <TabsContent value="data" className="min-h-0 flex-1 overflow-auto">
                    {project ? <TaskDataPanel project={project} /> : <Placeholder>该项目内容尚未交付。</Placeholder>}
                  </TabsContent>
                  <TabsContent value="charts" className="min-h-0 flex-1 overflow-auto">
                    {project ? <TaskChartsPanel project={project} /> : <Placeholder>曲线由数据记录生成。</Placeholder>}
                  </TabsContent>
                  <TabsContent value="log">
                    <Placeholder>暂无日志。</Placeholder>
                  </TabsContent>
                </Tabs>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="right"
            className="relative overflow-hidden"
            panelRef={rightRef}
            defaultSize="20"
            minSize={220}
            collapsible
            collapsedSize={0}
          >
            <ResizablePanelGroup orientation="vertical" className="min-h-0 overflow-hidden" {...right}>
              <ResizablePanel
                id="cabinet"
                panelRef={cabinetRef}
                defaultSize="36"
                minSize={140}
                collapsible
                collapsedSize={33}
                className="flex flex-col overflow-hidden"
                onResize={(panelSize) => {
                  setCabinetCollapsed(panelSize.inPixels <= 48)
                }}
              >
                <InstrumentCabinet
                  collapsed={cabinetCollapsed}
                  onToggleCollapse={(nextCollapsed) => {
                    setCabinetCollapsed(nextCollapsed)
                    if (nextCollapsed) cabinetRef.current?.collapse()
                    else cabinetRef.current?.expand()
                  }}
                />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="properties" defaultSize="64" minSize={240}>
                <ModuleProperties key={`${project?.id ?? 'unconfigured'}:${resetVersion}`} project={project} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
        <StatusBar />
        <RecoveryDialog
          onDiscard={() => void storage.discardAutosave()}
          onRestore={() => void storage.restoreAutosave()}
        />
        <Dialog open={resetOpen} onOpenChange={setResetOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重置当前实训？</DialogTitle>
              <DialogDescription>
                将断电并清空接线、台式仪表、步骤和数据记录，恢复默认设置。此操作不能撤销。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setResetOpen(false)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  resetProject()
                  resetTask(project)
                  instrumentDockStore.getState().resetDock()
                  useBenchView.getState().clearDiagnostics()
                  resetScopeAcquisition()
                  resetModuleSelection()
                  storage.notifyProjectReset()
                  setResetOpen(false)
                }}
              >
                确认重置
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </InstrumentPlacementProvider>
  )
}
