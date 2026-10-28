import {
  ArrowLeft,
  ClipboardCheck,
  FileDown,
  ListChecks,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Power,
  RotateCcw,
  Save,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import { usePanelRef } from 'react-resizable-panels'
import { useNavigate, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { benchCircuitInput, connectInstrumentRuntime } from '@/lib/instrument-runtime'
import { useSimRestartNotice } from '@/lib/use-sim-restart-notice'
import { cn } from '@/lib/utils'
import { BenchViewport3D } from '@/three/bench-viewport'
import { qualityPreset, useQuality } from '@/three/quality-store'
import { buildMeasurementPlan } from '../../../domain/measurement/plan'
import { checkWiring, detectDanger } from '../../../domain/wiring-check'
import type { Project } from '../../../shared/schema/project'
import { InstrumentCabinet } from './instrument-cabinet'
import { InstrumentDock } from './instrument-dock'
import { InstrumentPlacementProvider } from './instrument-placement'
import { findProject, projectGuide } from './practice-content'
import { usePersistedLayout } from './use-persisted-layout'
import { WiringPanel, WiringShortcuts } from './wiring-panel'
import { circuitStore, useCircuit } from './wiring-state'

type PanelHandle = ReturnType<typeof usePanelRef>

function toggle(ref: PanelHandle) {
  const p = ref.current
  if (!p) return
  if (p.isCollapsed()) p.expand()
  else p.collapse()
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
}: {
  refs: Record<'left' | 'right' | 'bottom', PanelHandle>
  sceneReady: boolean
  project?: Project
}) {
  const navigate = useNavigate()
  const { projectId } = useParams()
  const powered = useCircuit((s) => s.powered)
  const togglePower = useCircuit((s) => s.togglePower)
  // Step completion/data recording belong to T0.15; displaying a guide is not completing it.
  const step = 0
  const steps = project?.steps.length ?? 0
  const check = () => {
    if (!project) return
    try {
      const plan = buildMeasurementPlan(benchCircuitInput(), powered, 'check')
      const danger = detectDanger(plan.checkInput)
      const report = checkWiring(plan.checkInput, project.reference)
      circuitStore.setState({
        notice: danger.length
          ? '存在电源短接或电流表并联接法。请先断电，检查电源两端和电流插孔。'
          : report.issues.length
            ? report.issues.map((issue) => issue.message).join(' ')
            : '电路拓扑和电压测量点连接正确。读数仍以当前仪表量程和输入内阻为准。',
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
        <Button variant="outline" disabled>
          <Save />
          记录读数
        </Button>
        <Button variant="outline" disabled>
          <FileDown />
          导出报告
        </Button>
        <Button variant="ghost" disabled>
          <RotateCcw />
          重置
        </Button>
        <Separator orientation="vertical" className="mx-1 h-6" />
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

function StatusBar({ simulation }: { simulation: string }) {
  const powered = useCircuit((s) => s.powered)
  const count = useCircuit((s) => s.wires.length)
  const quality = useQuality((state) => state.quality)
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t px-3 text-xs text-muted-foreground">
      <span className={cn('flex items-center gap-1', powered && 'text-success')}>
        <Power className="size-3" />
        {powered ? '已上电' : '未上电'}
      </span>
      <span data-simulation-status={simulation}>仿真：{simulation}</span>
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

// 练习工作台（PRD 15.3）。各区可拖动、可折叠，尺寸持久化
export function Workbench() {
  useSimRestartNotice()
  const { projectId } = useParams()
  const project = findProject(projectId)
  const [sceneReady, setSceneReady] = useState(false)
  const [simulation, setSimulation] = useState('未运行')
  const leftRef = usePanelRef()
  const rightRef = usePanelRef()
  const bottomRef = usePanelRef()
  const main = usePersistedLayout('wb-main')
  const center = usePersistedLayout('wb-center')
  const right = usePersistedLayout('wb-right')
  useEffect(() => connectInstrumentRuntime(({ message }) => setSimulation(message)), [])

  return (
    <InstrumentPlacementProvider allowedInstruments={project?.allowedInstruments}>
      <div className="workbench-shell flex flex-col">
        <WiringShortcuts />
        <TopBar
          refs={{ left: leftRef, right: rightRef, bottom: bottomRef }}
          sceneReady={sceneReady}
          project={project}
        />
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" {...main}>
          <ResizablePanel
            id="left"
            className="overflow-hidden"
            panelRef={leftRef}
            defaultSize="22"
            minSize={220}
            collapsible
            collapsedSize={0}
          >
            <Tabs defaultValue="guide" className="flex h-full flex-col gap-0">
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
                      components={{
                        h2: ({ children }) => <h2 className="text-base font-medium">{children}</h2>,
                        h3: ({ children }) => <h3 className="pt-2 text-sm font-medium">{children}</h3>,
                        p: ({ children }) => <p className="text-sm leading-relaxed">{children}</p>,
                        ol: ({ children }) => <ol className="list-decimal space-y-2 pl-5">{children}</ol>,
                        ul: ({ children }) => <ul className="list-disc space-y-2 pl-5">{children}</ul>,
                      }}
                    >
                      {projectGuide(project)}
                    </Markdown>
                  </div>
                ) : (
                  <Placeholder>该项目内容尚未交付；当前台面仅供仪表和接线功能验证。</Placeholder>
                )}
              </TabsContent>
              <TabsContent value="schematic">
                <Placeholder>原理图由项目内容加载。</Placeholder>
              </TabsContent>
              <TabsContent value="steps" className="min-h-0 overflow-auto">
                {project ? (
                  <ol className="list-decimal space-y-3 p-4 pl-8">
                    {project.steps.map((step) => (
                      <li key={step.id}>{step.text}</li>
                    ))}
                  </ol>
                ) : (
                  <Placeholder>该项目步骤尚未交付。</Placeholder>
                )}
              </TabsContent>
            </Tabs>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="center" minSize="30" className="min-h-0">
            <ResizablePanelGroup orientation="vertical" className="min-h-0 overflow-hidden" {...center}>
              <ResizablePanel id="viewport" minSize={200}>
                <BenchViewport3D onReadyChange={setSceneReady} />
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                id="bottom"
                className="relative overflow-hidden"
                panelRef={bottomRef}
                defaultSize="32"
                minSize={160}
                collapsible
                collapsedSize={0}
              >
                <Tabs defaultValue="instruments" className="flex h-full flex-col gap-0">
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
                  <TabsContent value="data">
                    <Placeholder>数据记录表由项目内容加载。</Placeholder>
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
                <WiringPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
        <StatusBar simulation={simulation} />
      </div>
    </InstrumentPlacementProvider>
  )
}
