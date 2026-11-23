import {
  AlertTriangle,
  ArrowLeft,
  ClipboardCheck,
  FileDown,
  ListChecks,
  Maximize2,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Power,
  RotateCcw,
  Save,
} from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import { usePanelRef } from 'react-resizable-panels'
import { useNavigate, useParams } from 'react-router'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { benchCircuitInput, connectInstrumentRuntime } from '@/lib/instrument-runtime'
import { resetScopeAcquisition } from '@/lib/scope-acquisition'
import { useSimRestartNotice } from '@/lib/use-sim-restart-notice'
import { cn } from '@/lib/utils'
import { resetSimulationStatus, setSimulationStatus, useSimulationStatus } from '@/stores/simulation-status'
import { resetTask, setTaskGuideMode, taskStore, useTask } from '@/stores/task'
import { useBenchView } from '@/three/bench-view'
import { BenchViewport3D } from '@/three/bench-viewport'
import { qualityPreset, useQuality } from '@/three/quality-store'
import { formatRealtimeRatio } from '../../../domain/measurement/pace'
import { buildMeasurementPlan } from '../../../domain/measurement/plan'
import { currentTaskStep, GUIDE_MODE_LABELS, scopedReference } from '../../../domain/task'
import { checkWiring, detectDanger } from '../../../domain/wiring-check'
import type { Project } from '../../../shared/schema/project'
import { InstrumentCabinet } from './instrument-cabinet'
import { InstrumentDock } from './instrument-dock'
import { InstrumentPlacementProvider } from './instrument-placement'
import { ModuleProperties, resetModuleSelection } from './module-controls'
import { findProject, projectGuide, projectSchematic } from './practice-content'
import { recordTaskReadings, TaskDataPanel, TaskStepsPanel } from './task-panel'
import { usePersistedLayout } from './use-persisted-layout'
import { WireContextMenu } from './wire-menu'
import { WiringShortcuts } from './wiring-panel'
import { activateProject, circuitStore, resetProject, useCircuit } from './wiring-state'
import 'katex/dist/katex.min.css'

type PanelHandle = ReturnType<typeof usePanelRef>

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
  onReset,
}: {
  refs: Record<'left' | 'right' | 'bottom', PanelHandle>
  sceneReady: boolean
  project?: Project
  onReset: () => void
}) {
  const navigate = useNavigate()
  const { projectId } = useParams()
  const powered = useCircuit((s) => s.powered)
  const togglePower = useCircuit((s) => s.togglePower)
  const guideMode = useTask((state) => state.guideMode)
  const task = useTask((state) => (state.projectId === project?.id ? state.task : undefined))
  const step = project?.steps.filter((entry) => task?.completedSteps.includes(entry.id)).length ?? 0
  const steps = project?.steps.length ?? 0
  const toggleGuideMode = () => {
    const next = guideMode === 'guided' ? 'free' : 'guided'
    if (next === 'free') useBenchView.getState().setShowGuide(false)
    setTaskGuideMode(next)
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
      circuitStore.setState({
        notice: danger.length
          ? '存在电源短接或电流表并联接法。请先断电，检查电源两端和电流插孔。'
          : report.issues.length
            ? report.issues.map((issue) => issue.message).join(' ')
            : reference.measurePoints.length
              ? '电路拓扑和当前步骤的测量位置连接正确。档位仍需按指导设置，读数以实际量程和输入内阻为准。'
              : '电路拓扑连接正确。本步骤尚不要求接入测量仪表，请继续完成步骤。',
      })
    } catch (error) {
      circuitStore.setState({ notice: error instanceof Error ? error.message : '无法检查当前接线。' })
    }
  }
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <IconAction label="返回" onClick={() => navigate('/')}>
        <ArrowLeft />
      </IconAction>
      <h1 className="min-w-0 flex-1 truncate text-base font-medium" title={project?.title}>
        {project ? `${project.id} ${project.title}` : (projectId ?? '练习工作台')}
      </h1>
      <div className="flex w-40 items-center gap-2 text-muted-foreground">
        <Progress value={steps ? (step / steps) * 100 : 0} aria-label="步骤进度" />
        <span className="font-mono text-xs whitespace-nowrap">
          {step}/{steps}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="outline"
          data-top-guide-mode={guideMode}
          aria-label="切换引导或自主模式"
          onClick={toggleGuideMode}
          disabled={!sceneReady}
        >
          {GUIDE_MODE_LABELS[guideMode]}
        </Button>
        <Button variant="outline" onClick={check} disabled={!project || !sceneReady}>
          <ClipboardCheck />
          检查接线
        </Button>
        <Button
          variant={powered ? 'destructive' : 'default'}
          onClick={togglePower}
          aria-pressed={powered}
          disabled={!sceneReady && !powered}
        >
          <Power />
          {powered ? '断电' : '上电'}
        </Button>
        <Button
          variant="outline"
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
        <Button variant="outline" disabled>
          <FileDown />
          导出报告
        </Button>
        <Button variant="ghost" onClick={onReset} disabled={!sceneReady}>
          <RotateCcw />
          重置
        </Button>
        <Separator orientation="vertical" className="mx-1 h-6" />
        <IconAction label="专注台面" onClick={() => toggleFocusBench([refs.left, refs.bottom, refs.right])}>
          <Maximize2 />
        </IconAction>
        <IconAction label="显示/收起左栏" onClick={() => toggle(refs.left)}>
          <PanelLeft />
        </IconAction>
        <IconAction label="显示/收起底栏" onClick={() => toggle(refs.bottom)}>
          <PanelBottom />
        </IconAction>
        <IconAction label="显示/收起右栏" onClick={() => toggle(refs.right)}>
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
  const slow = simulation.pace?.slow === true
  const ratio = simulation.pace?.realtimeRatio ?? null
  const ratioText = ratio === null ? '' : formatRealtimeRatio(ratio)
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
      <span className="ml-auto">画质：{qualityPreset(quality).label}</span>
    </footer>
  )
}

function Placeholder({ children }: { children: ReactNode }) {
  return <p className="p-3 text-muted-foreground">{children}</p>
}

function PaneTitle({ children }: { children: ReactNode }) {
  return <h2 className="flex h-8 shrink-0 items-center border-b px-3 text-sm font-medium">{children}</h2>
}

function ProjectSchematic({ project }: { project: Project }) {
  const url = projectSchematic(project)
  if (!url) return <Placeholder>该项目的原理图尚未交付。</Placeholder>
  return (
    <div className="space-y-3 p-3">
      <img src={url} alt={`${project.id} 原理图`} className="w-full rounded-md border" />
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">放大原理图</Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{project.title}：原理图</DialogTitle>
            <DialogDescription>插孔编号与当前挂箱一致，按指导书设置参数并连接仪表。</DialogDescription>
          </DialogHeader>
          <img src={url} alt={`${project.id} 放大原理图`} className="max-h-128 w-full object-contain" />
        </DialogContent>
      </Dialog>
    </div>
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
  const leftTab = useTask((state) => state.leftTab)
  const bottomTab = useTask((state) => state.bottomTab)
  const guideMode = useTask((state) => state.guideMode)
  const resetVersion = useTask((state) => state.resetVersion)
  const task = useTask((state) => (state.projectId === project?.id ? state.task : undefined))
  const guideNets = useMemo(() => {
    if (!project || !task) return undefined
    return scopedReference(project, currentTaskStep(project, task)).nets
  }, [project, task])
  const leftRef = usePanelRef()
  const rightRef = usePanelRef()
  const bottomRef = usePanelRef()
  const main = usePersistedLayout('wb-main')
  const center = usePersistedLayout('wb-center')
  const right = usePersistedLayout('wb-right')
  useLayoutEffect(() => {
    try {
      const changed = activateProject(project)
      if (changed || taskStore.getState().projectId !== project?.id || activationAttempt > 0) {
        resetTask(project)
        resetScopeAcquisition()
        resetModuleSelection()
        setResetOpen(false)
      }
      setActivationError(null)
    } catch (error) {
      // Keep an invalid project's title and controls away from the previous learner circuit.
      resetProject()
      resetTask()
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
          <Button variant="outline" onClick={() => navigate('/')}>
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
        <TopBar
          refs={{ left: leftRef, right: rightRef, bottom: bottomRef }}
          sceneReady={sceneReady}
          project={project}
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
              <TabsList variant="line" className="w-full justify-start border-b px-2">
                <TabsTrigger className="flex-none px-3" value="guide">
                  实训指导
                </TabsTrigger>
                <TabsTrigger className="flex-none px-3" value="schematic">
                  原理图
                </TabsTrigger>
                <TabsTrigger className="flex-none px-3" value="steps">
                  <ListChecks />
                  步骤
                </TabsTrigger>
              </TabsList>
              <TabsContent value="guide" className="min-h-0 overflow-auto">
                {project ? (
                  <div className="space-y-3 p-3">
                    {project.validation && (
                      <p className="border p-3 text-xs text-warning">
                        {project.validation.purpose} 正式内容与目标机性能验收未完成。
                      </p>
                    )}
                    <Markdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        h1: ({ children }) => <h2 className="text-base font-medium">{children}</h2>,
                        h2: ({ children }) => <h2 className="text-base font-medium">{children}</h2>,
                        h3: ({ children }) => <h3 className="pt-2 text-sm font-medium">{children}</h3>,
                        p: ({ children }) => <p className="text-sm leading-relaxed">{children}</p>,
                        ol: ({ children }) => <ol className="list-decimal space-y-2 pl-5">{children}</ol>,
                        ul: ({ children }) => <ul className="list-disc space-y-2 pl-5">{children}</ul>,
                        table: ({ children }) => <Table>{children}</Table>,
                        thead: ({ children }) => <TableHeader>{children}</TableHeader>,
                        tbody: ({ children }) => <TableBody>{children}</TableBody>,
                        tr: ({ children }) => <TableRow>{children}</TableRow>,
                        th: ({ children }) => <TableHead>{children}</TableHead>,
                        td: ({ children }) => <TableCell>{children}</TableCell>,
                      }}
                    >
                      {projectGuide(project)}
                    </Markdown>
                  </div>
                ) : (
                  <Placeholder>该项目内容尚未交付；当前台面仅供仪表和接线功能验证。</Placeholder>
                )}
              </TabsContent>
              <TabsContent value="schematic" className="min-h-0 overflow-auto">
                {project ? <ProjectSchematic project={project} /> : <Placeholder>该项目的原理图尚未交付。</Placeholder>}
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
                defaultSize="28"
                minSize={160}
                collapsible
                collapsedSize={0}
              >
                <Tabs
                  value={bottomTab}
                  onValueChange={(value) => taskStore.setState({ bottomTab: value as typeof bottomTab })}
                  className="flex h-full flex-col gap-0"
                >
                  <TabsList variant="line" className="w-full justify-start border-b px-2">
                    <TabsTrigger className="flex-none px-3" value="instruments">
                      仪表
                    </TabsTrigger>
                    <TabsTrigger className="flex-none px-3" value="data">
                      数据记录
                    </TabsTrigger>
                    <TabsTrigger className="flex-none px-3" value="charts">
                      曲线
                    </TabsTrigger>
                    <TabsTrigger className="flex-none px-3" value="log">
                      日志
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="instruments" className="flex min-h-0 flex-1 overflow-hidden">
                    <InstrumentDock />
                  </TabsContent>
                  <TabsContent value="data" className="min-h-0 flex-1 overflow-auto">
                    {project ? <TaskDataPanel project={project} /> : <Placeholder>该项目内容尚未交付。</Placeholder>}
                  </TabsContent>
                  <TabsContent value="charts">
                    <Placeholder>曲线由数据记录生成。</Placeholder>
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
              <ResizablePanel id="cabinet" defaultSize="38" minSize={140} className="overflow-auto">
                <PaneTitle>仪表柜</PaneTitle>
                <InstrumentCabinet />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="properties" defaultSize="62" minSize={240}>
                <ModuleProperties key={`${project?.id ?? 'unconfigured'}:${resetVersion}`} project={project} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
        <StatusBar />
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
                  resetScopeAcquisition()
                  resetModuleSelection()
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
