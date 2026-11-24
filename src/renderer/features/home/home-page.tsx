import { BookOpen, Clock, Cpu, Monitor, Play, Search, Settings as SettingsIcon, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { projectCatalog } from '@/features/practice/practice-content'
import { useSettings } from '@/stores/settings'
import type { SaveSummary } from '../../../shared/ipc/storage'
import type { Project } from '../../../shared/schema/project'

type DomainKey = 'DG' | 'MD' | 'SD'

const DOMAIN_TABS: { key: DomainKey; label: string; description: string }[] = [
  { key: 'DG', label: '电工基础', description: '直流电路、交流电路、磁路与暂态分析' },
  { key: 'MD', label: '模拟电子', description: '基础型与综合性应用放大、电源、运放与排故' },
  { key: 'SD', label: '数字电子', description: '基础逻辑、时序计数与综合性应用系统' },
]

function projectDomain(project: Project): DomainKey {
  if (project.id.startsWith('MD-')) return 'MD'
  if (project.id.startsWith('SD-')) return 'SD'
  return 'DG'
}

export function HomePage() {
  const navigate = useNavigate()
  const setSettingsOpen = useSettings((s) => s.setSettingsOpen)
  const setCommandOpen = useSettings((s) => s.setCommandOpen)
  const presentationMode = useSettings((s) => s.presentationMode)
  const togglePresentationMode = useSettings((s) => s.togglePresentationMode)
  const [saves, setSaves] = useState<SaveSummary[]>([])
  const [domain, setDomain] = useState<DomainKey>('DG')

  useEffect(() => {
    let canceled = false
    window.api.storage
      .listSaves()
      .then((list) => {
        if (!canceled) setSaves(list)
      })
      .catch(() => {})
    return () => {
      canceled = true
    }
  }, [])

  const saveMap = useMemo(() => new Map(saves.map((item) => [item.projectId, item])), [saves])
  const latestSave = saves[0]
  const latestProject = latestSave ? projectCatalog.find((p) => p.id === latestSave.projectId) : undefined

  const groupedByDomain = useMemo(() => {
    const result: Record<DomainKey, Map<string, Project[]>> = {
      DG: new Map(),
      MD: new Map(),
      SD: new Map(),
    }
    const sorted = projectCatalog.slice().sort((a, b) => a.id.localeCompare(b.id))
    for (const project of sorted) {
      const map = result[projectDomain(project)]
      const list = map.get(project.group) ?? []
      list.push(project)
      map.set(project.group, list)
    }
    return result
  }, [])

  return (
    <div className="workbench-shell flex bg-background text-foreground" data-page="home">
      {/* PRD 15.3：左侧窄导航：学习、练习、设置 */}
      <aside aria-label="主导航" className="flex w-44 shrink-0 flex-col border-r bg-muted/20 p-3">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Cpu className="size-4 text-primary" />
          <span className="truncate text-sm font-medium">电工电子仿真</span>
        </div>
        <Separator className="my-2" />
        <nav className="flex flex-1 flex-col gap-1">
          <Button variant="secondary" className="justify-start" onClick={() => navigate('/home')}>
            <Wrench />
            练习模式
          </Button>
          <Button variant="ghost" className="justify-start" onClick={() => navigate('/learn')}>
            <BookOpen />
            学习模式
          </Button>
          <Button variant="ghost" className="justify-start" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
            系统设置
          </Button>
        </nav>
        <div className="space-y-1.5 border-t pt-2">
          <Button variant="outline" size="sm" className="w-full justify-between" onClick={() => setCommandOpen(true)}>
            <span className="flex items-center gap-1.5">
              <Search className="size-3.5" />
              命令面板
            </span>
            <Kbd>Ctrl+K</Kbd>
          </Button>
          <Button
            variant={presentationMode ? 'secondary' : 'ghost'}
            size="sm"
            className="w-full justify-start"
            aria-pressed={presentationMode}
            onClick={() => void togglePresentationMode()}
          >
            <Monitor className="size-3.5" />
            {presentationMode ? '演示模式：开' : '演示模式'}
          </Button>
        </div>
      </aside>

      {/* PRD 15.3 主区：顶部一行“继续上次实训” + 下方三子模块分 Tab 按分组列出项目 */}
      <main className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
        <section
          aria-label="继续上次实训"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3"
        >
          <div className="flex min-w-0 items-center gap-3">
            <Clock className="size-4 shrink-0 text-muted-foreground" />
            {latestProject && latestSave ? (
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  继续上次实训：<span className="font-mono">{latestProject.id}</span> {latestProject.title}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  已完成 {latestSave.completedSteps}/{latestProject.steps.length} 步 · {latestSave.wireCount} 根导线 ·
                  保存于 {new Date(latestSave.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium">继续上次实训</p>
                <p className="text-xs text-muted-foreground">暂无本地实训存档，可从下方任一模块进入实训工作台。</p>
              </div>
            )}
          </div>
          <Button
            size="sm"
            onClick={() => navigate(`/practice/${latestProject?.id ?? projectCatalog[0]?.id ?? 'DG-05'}`)}
          >
            <Play />
            {latestProject ? '继续实训' : '进入工作台'}
          </Button>
        </section>

        <Tabs value={domain} onValueChange={(v) => setDomain(v as DomainKey)} className="flex min-h-0 flex-1 flex-col">
          <TabsList variant="line" className="w-full justify-start border-b">
            {DOMAIN_TABS.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key} className="flex-none px-4">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {DOMAIN_TABS.map((tab) => {
            const groups = [...groupedByDomain[tab.key].entries()]
            return (
              <TabsContent key={tab.key} value={tab.key} className="min-h-0 flex-1 space-y-5 overflow-auto pt-4">
                <p className="text-xs text-muted-foreground">{tab.description}</p>
                {groups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">该子模块尚无已交付项目。</p>
                ) : (
                  groups.map(([groupName, items]) => (
                    <section key={groupName} className="space-y-2">
                      <h2 className="text-sm font-medium">{groupName}</h2>
                      <div className="divide-y rounded-md border">
                        {items.map((project) => {
                          const summary = saveMap.get(project.id)
                          const done = summary?.completedSteps ?? 0
                          const total = project.steps.length
                          return (
                            <div
                              key={project.id}
                              data-home-project={project.id}
                              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-3">
                                <span className="w-14 shrink-0 font-mono text-xs font-medium">{project.id}</span>
                                <span className="truncate text-sm">{project.title}</span>
                                <Badge variant="outline">
                                  {project.validation
                                    ? '功能验证'
                                    : project.type === 'integrated'
                                      ? '综合性应用'
                                      : '基础型'}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="font-mono text-xs text-muted-foreground">
                                  {summary ? `进度 ${done}/${total}` : '未开始'}
                                </span>
                                <Button size="sm" variant="outline" onClick={() => navigate(`/practice/${project.id}`)}>
                                  进入实训
                                </Button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  ))
                )}
              </TabsContent>
            )
          })}
        </Tabs>
      </main>
    </div>
  )
}
