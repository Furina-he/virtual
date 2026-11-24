import { buildCategoryTree, filterLearnResources, LEARN_SECTION_TABS, learnCategoryLabel } from '@domain/learn/catalog'
import type { LearnCategory } from '@shared/schema/learn'
import { ArrowLeft, Box, Search, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import { useLocation, useNavigate, useParams } from 'react-router'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { DeviceViewer3D } from './device-viewer-3d'
import { findLearnResource, learnCatalog } from './learn-content'
import 'katex/dist/katex.min.css'

type LearnLocationState = { from?: string } | null

export function LearnPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { resourceId } = useParams()
  const fromPath = (location.state as LearnLocationState)?.from

  const [category, setCategory] = useState<LearnCategory | 'all'>('all')
  const [subcategory, setSubcategory] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState<(typeof LEARN_SECTION_TABS)[number]['key']>('structure')

  const tree = useMemo(() => buildCategoryTree(learnCatalog), [])
  const filtered = useMemo(
    () => filterLearnResources(learnCatalog, { category, subcategory, query }),
    [category, subcategory, query],
  )

  const selected = useMemo(() => {
    if (resourceId) {
      const exact = findLearnResource(resourceId)
      if (exact) return exact
    }
    return filtered[0] ?? learnCatalog[0]
  }, [resourceId, filtered])

  const selectCategory = (nextCat: LearnCategory | 'all', nextSub: string | null = null) => {
    setCategory(nextCat)
    setSubcategory(nextSub)
    const nextList = filterLearnResources(learnCatalog, { category: nextCat, subcategory: nextSub, query })
    if (nextList[0]) navigate(`/learn/${nextList[0].id}`, { replace: true, state: location.state })
  }

  return (
    <div className="workbench-shell flex flex-col bg-background text-foreground" data-page="learn">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate('/home')}>
            <ArrowLeft />
            返回首页
          </Button>
          {fromPath && (
            <Button size="sm" variant="outline" onClick={() => navigate(fromPath)}>
              <Wrench />
              返回实训台
            </Button>
          )}
          <Separator orientation="vertical" className="mx-1 h-5" />
          <h1 className="text-base font-medium">学习模式：颗粒化教学资源与 3D 器件认知</h1>
        </div>
        <span className="font-mono text-xs text-muted-foreground">共 {learnCatalog.length} 项资源（5 类）</span>
      </header>

      {/* PRD 15.3 学习模式三栏：分类树、资源列表、详情 */}
      <div className="grid min-h-0 flex-1 grid-cols-12">
        {/* 左栏：五类资源分类树 */}
        <aside aria-label="资源分类树" className="col-span-3 flex min-h-0 flex-col border-r">
          <ScrollArea className="min-h-0 flex-1 p-3">
            <div className="space-y-2">
              <button
                type="button"
                data-category-filter="all"
                aria-current={category === 'all' ? 'true' : undefined}
                onClick={() => selectCategory('all', null)}
                className={cn(
                  'flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                  category === 'all' && 'bg-muted font-medium',
                )}
              >
                <span>全部资源</span>
                <span className="font-mono text-xs text-muted-foreground">{learnCatalog.length}</span>
              </button>
              {tree.map((node) => (
                <div key={node.category} className="space-y-1">
                  <button
                    type="button"
                    data-category-filter={node.category}
                    aria-current={category === node.category && !subcategory ? 'true' : undefined}
                    onClick={() => selectCategory(node.category, null)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                      category === node.category && !subcategory && 'bg-muted font-medium',
                    )}
                  >
                    <span>{node.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{node.count}</span>
                  </button>
                  <div className="space-y-0.5 pl-4">
                    {node.subcategories.map((sub) => (
                      <button
                        key={sub.name}
                        type="button"
                        data-subcategory-filter={`${node.category}:${sub.name}`}
                        aria-current={category === node.category && subcategory === sub.name ? 'true' : undefined}
                        onClick={() => selectCategory(node.category, sub.name)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                          category === node.category &&
                            subcategory === sub.name &&
                            'bg-muted font-medium text-foreground',
                        )}
                      >
                        <span className="truncate">{sub.name}</span>
                        <span className="font-mono">{sub.count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </aside>

        {/* 中栏：关键字检索与资源列表 */}
        <section aria-label="资源列表" className="col-span-3 flex min-h-0 flex-col border-r">
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="检索学习资源"
                placeholder="检索名称、型号、原理关键字…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8 text-xs"
              />
            </div>
            <p className="mt-2 font-mono text-xs text-muted-foreground">匹配 {filtered.length} 项</p>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {filtered.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">未找到匹配的学习资源，请尝试其他关键字或分类。</p>
            ) : (
              <ul className="divide-y">
                {filtered.map((item) => {
                  const active = selected?.id === item.id
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        data-learn-item={item.id}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => navigate(`/learn/${item.id}`, { state: location.state })}
                        className={cn(
                          'flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                          active && 'bg-muted',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">{item.title}</span>
                          {item.model && <Box className="size-3.5 shrink-0 text-primary" aria-label="含 3D 模型" />}
                        </div>
                        <span className="line-clamp-1 text-xs text-muted-foreground">{item.subtitle}</span>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <Badge variant="outline">{learnCategoryLabel(item.category)}</Badge>
                          <span className="truncate text-xs text-muted-foreground">{item.subcategory}</span>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </ScrollArea>
        </section>

        {/* 右栏：3D 查看器（旋转/缩放/拆解/剖切）+ 四项内容详情 Tab */}
        <main
          aria-label="资源详情"
          data-selected-resource={selected?.id ?? ''}
          className="col-span-6 flex min-h-0 flex-col"
        >
          {selected ? (
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-4">
                <header className="space-y-1.5 border-b pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-medium">{selected.title}</h2>
                    <Badge variant="secondary">{learnCategoryLabel(selected.category)}</Badge>
                    <Badge variant="outline">{selected.subcategory}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{selected.subtitle}</p>
                  {selected.specs.length > 0 && selected.model && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {selected.specs.map((spec) => (
                        <span
                          key={spec.label}
                          className="rounded-sm border bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground"
                        >
                          {spec.label}：<strong className="font-medium text-foreground">{spec.value}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                </header>

                <DeviceViewer3D key={selected.id} resource={selected} />

                <Tabs
                  value={activeTab}
                  onValueChange={(value) => setActiveTab(value as typeof activeTab)}
                  className="space-y-3"
                >
                  <TabsList variant="line" className="w-full justify-start border-b">
                    {LEARN_SECTION_TABS.map((tab) => (
                      <TabsTrigger key={tab.key} value={tab.key} className="flex-none px-4">
                        {tab.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {LEARN_SECTION_TABS.map((tab) => (
                    <TabsContent key={tab.key} value={tab.key} data-learn-section={tab.key} className="space-y-2 pt-1">
                      <Markdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                          h2: ({ children }) => <h3 className="text-sm font-medium">{children}</h3>,
                          h3: ({ children }) => <h4 className="pt-1 text-xs font-medium">{children}</h4>,
                          p: ({ children }) => <p className="text-sm leading-relaxed">{children}</p>,
                          ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5 text-sm">{children}</ol>,
                          ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5 text-sm">{children}</ul>,
                          table: ({ children }) => <Table>{children}</Table>,
                          thead: ({ children }) => <TableHeader>{children}</TableHeader>,
                          tbody: ({ children }) => <TableBody>{children}</TableBody>,
                          tr: ({ children }) => <TableRow>{children}</TableRow>,
                          th: ({ children }) => <TableHead>{children}</TableHead>,
                          td: ({ children }) => <TableCell>{children}</TableCell>,
                        }}
                      >
                        {selected.sections[tab.key]}
                      </Markdown>
                    </TabsContent>
                  ))}
                </Tabs>
              </div>
            </ScrollArea>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">请从左侧选择要查看的学习资源。</p>
          )}
        </main>
      </div>
    </div>
  )
}
