import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import { useParams } from 'react-router'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { LabReportPayload } from '../../../shared/ipc/report'
import { TaskChartCard } from './task-charts'
import 'katex/dist/katex.min.css'

async function waitForPrintReady(): Promise<void> {
  if (document.fonts?.ready) {
    await document.fonts.ready
  }
  const images = Array.from(document.querySelectorAll('img'))
  await Promise.all(
    images.map((img) => {
      if (img.complete) return Promise.resolve()
      return new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true })
        img.addEventListener('error', () => resolve(), { once: true })
      })
    }),
  )
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

export function ReportPrintPage() {
  const { jobId } = useParams()
  const [report, setReport] = useState<LabReportPayload | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!jobId) {
      setLoaded(true)
      return
    }
    let canceled = false
    window.api.report
      .getPrintPayload(jobId)
      .then((payload) => {
        if (canceled) return
        setReport(payload)
        setLoaded(true)
      })
      .catch(() => {
        if (!canceled) setLoaded(true)
      })
    return () => {
      canceled = true
    }
  }, [jobId])

  useEffect(() => {
    if (!loaded || !jobId) return
    let canceled = false
    void waitForPrintReady().then(() => {
      if (!canceled) window.api.report.notifyPrintReady(jobId)
    })
    return () => {
      canceled = true
    }
  }, [loaded, jobId])

  if (!loaded) return <main className="p-6 text-sm text-muted-foreground">正在准备实训报告……</main>
  if (!report) return <main className="p-6 text-sm text-destructive">未找到待导出的实训报告数据。</main>

  const exportTime = new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false })

  return (
    <main className="mx-auto max-w-4xl space-y-6 bg-background p-6 text-foreground">
      <header className="space-y-2 border-b pb-4">
        <h1 className="text-lg font-medium">
          {report.projectId} {report.projectTitle} — 虚拟仿真实训报告
        </h1>
        <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>分组：{report.projectGroup}</span>
          <span>类型：{report.projectType === 'integrated' ? '综合性应用' : '基础型'}</span>
          <span>
            步骤完成：{report.stepSummary.completed}/{report.stepSummary.total}
          </span>
          <span>导出时间：{exportTime}</span>
        </div>
      </header>

      {report.guideMarkdown && (
        <section className="space-y-2">
          <h2 className="border-b pb-1 text-base font-medium">一、实训指导摘要</h2>
          <div className="space-y-2 text-xs leading-relaxed">
            <Markdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                h1: ({ children }) => <h3 className="pt-1 text-sm font-medium">{children}</h3>,
                h2: ({ children }) => <h3 className="pt-1 text-sm font-medium">{children}</h3>,
                h3: ({ children }) => <h4 className="pt-1 text-xs font-medium">{children}</h4>,
                p: ({ children }) => <p className="text-xs leading-relaxed">{children}</p>,
                ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
                ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
                table: ({ children }) => <Table>{children}</Table>,
                thead: ({ children }) => <TableHeader>{children}</TableHeader>,
                tbody: ({ children }) => <TableBody>{children}</TableBody>,
                tr: ({ children }) => <TableRow>{children}</TableRow>,
                th: ({ children }) => <TableHead>{children}</TableHead>,
                td: ({ children }) => <TableCell>{children}</TableCell>,
              }}
            >
              {report.guideMarkdown}
            </Markdown>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="border-b pb-1 text-base font-medium">二、实训步骤进度</h2>
        <ol className="space-y-1 text-xs">
          {report.stepSummary.items.map((item) => (
            <li key={item.id} className="flex items-start gap-2">
              <span className="shrink-0 font-mono text-muted-foreground">
                [{item.completed ? '已完成' : '未完成'}] {item.index}.
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="border-b pb-1 text-base font-medium">三、实训数据记录表</h2>
        {report.tables.length === 0 ? (
          <p className="text-xs text-muted-foreground">本项目未配置数据记录表。</p>
        ) : (
          report.tables.map((table) => (
            <div key={table.id} className="space-y-2 break-inside-avoid">
              <h3 className="text-sm font-medium">
                {table.title}（已记录 {table.filledRows}/{table.rows.length} 行）
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>行</TableHead>
                    {table.columns.map((col) => (
                      <TableHead key={col.id}>
                        {col.title}
                        {col.unit ? ` (${col.unit})` : ''}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.rows.map((row) => (
                    <TableRow key={row.rowNumber}>
                      <TableCell className="font-mono text-xs">{row.rowNumber}</TableCell>
                      {row.cells.map((cell) => (
                        <TableCell key={cell.columnId} className="font-mono text-xs">
                          {cell.formatted}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {table.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-warning">
                  {table.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </section>

      {report.charts.length > 0 && (
        <section className="space-y-3">
          <h2 className="border-b pb-1 text-base font-medium">四、实训特性曲线</h2>
          <div className="space-y-4">
            {report.charts.map((chart) => (
              <div key={chart.id} className="break-inside-avoid">
                <TaskChartCard dataset={chart} animate={false} />
              </div>
            ))}
          </div>
        </section>
      )}

      {report.screenshots.length > 0 && (
        <section className="space-y-3">
          <h2 className="border-b pb-1 text-base font-medium">五、示波器波形截图</h2>
          <div className="grid grid-cols-1 gap-4">
            {report.screenshots.map((shot) => (
              <figure key={shot.id} className="space-y-2 break-inside-avoid rounded-md border p-3">
                <figcaption className="text-xs font-medium">
                  {shot.title}（{shot.displayMode === 'xy' ? 'X-Y 模式' : 'Y-T 模式'}
                  {shot.frozen ? ' · 冻结' : ''}）
                </figcaption>
                <img src={shot.dataUrl} alt={shot.title} className="max-h-72 w-full rounded-sm border object-contain" />
                <p className="font-mono text-xs text-muted-foreground">{shot.summaryText}</p>
              </figure>
            ))}
          </div>
        </section>
      )}

      {report.faultSummary && (
        <section className="space-y-2 break-inside-avoid">
          <h2 className="border-b pb-1 text-base font-medium">六、排故过程记录</h2>
          <p className="font-mono text-xs text-muted-foreground">
            已排除故障数：{report.faultSummary.resolvedCount} · 排故测量次数：{report.faultSummary.measurements} ·
            误判次数：{report.faultSummary.wrongGuesses} · 累计排故用时：{report.faultSummary.seconds} s
          </p>
        </section>
      )}

      {report.questions.length > 0 && (
        <section className="space-y-3">
          <h2 className="border-b pb-1 text-base font-medium">思考题作答</h2>
          <ol className="space-y-3">
            {report.questions.map((item) => (
              <li key={item.index} className="space-y-1 break-inside-avoid rounded-md border p-3 text-xs">
                <p className="font-medium">
                  {item.index}. {item.prompt}
                </p>
                <p className="whitespace-pre-wrap text-muted-foreground">{item.answer || '（未作答）'}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  )
}
