import { isMeasurementInstrument } from '@domain/instruments'
import { currentTaskStep, measurementUnit } from '@domain/task'
import type { Project } from '@shared/schema/project'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useInstrumentPanels } from '@/stores/instrument-panels'
import {
  completeCurrentTaskStep,
  formatTaskCellValue,
  parseTaskCellDraft,
  recordTaskReadings,
  removeReportScreenshot,
  selectTaskRow,
  selectTaskSource,
  selectTaskTable,
  taskCellKey,
  useTask,
  writeTaskCell,
} from '@/stores/task'
import type { CapturedMeasurement } from '../../../domain/task'

export { completeCurrentTaskStep, recordTaskReadings } from '@/stores/task'

type TaskColumn = Project['dataTables'][number]['columns'][number]

function TaskFeedback({ live = true }: { live?: boolean }) {
  const notice = useTask((state) => state.notice)
  const warnings = useTask((state) => state.warnings)
  if (!notice && !warnings.length) return null
  return (
    <div
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      aria-atomic="true"
      className="space-y-1"
    >
      {notice && (
        <p data-task-notice className="text-xs leading-relaxed">
          {notice}
        </p>
      )}
      {!!warnings.length && (
        <ul data-task-warnings className="list-disc space-y-1 pl-4 text-xs text-warning">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TaskCellInput({
  project,
  tableId,
  tableTitle,
  row,
  column,
  value,
  capture,
}: {
  project: Project
  tableId: string
  tableTitle: string
  row: number
  column: TaskColumn
  value: number | null
  capture?: CapturedMeasurement
}) {
  const [draft, setDraft] = useState(formatTaskCellValue(value))
  const [error, setError] = useState<string | null>(null)
  const editing = useRef(false)
  const dirty = useRef(false)
  const errorId = useId()
  const captureId = useId()
  const point = project.reference.measurePoints.find((item) => item.id === column.measurePoint)
  const siUnit = point ? measurementUnit(point) : (column.unit ?? '')
  useEffect(() => {
    if (!editing.current && !dirty.current) {
      setDraft(formatTaskCellValue(value))
      setError(null)
      dirty.current = false
    }
  }, [value])
  const commit = () => {
    editing.current = false
    if (!dirty.current) return
    const parsed = parseTaskCellDraft(draft)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }
    if (!writeTaskCell(project, tableId, row, column.id, parsed.value)) {
      setError('该单元格未更新，请查看记录反馈。')
      return
    }
    dirty.current = false
    setError(null)
    setDraft(formatTaskCellValue(parsed.value))
  }
  const captureLabel = capture
    ? `来源 ${capture.instanceId}；表屏 ${formatTaskCellValue(capture.displayValueSI)} ${siUnit}，参考方向 ${formatTaskCellValue(capture.referenceValueSI)} ${siUnit}。`
    : ''
  const describedBy = [error ? errorId : '', capture ? captureId : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className="min-w-20 space-y-1">
      <Input
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={Boolean(column.computed)}
        aria-label={`${tableTitle} 第 ${row + 1} 行 ${column.title}${column.unit ? ` (${column.unit})` : ''}`}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        data-table-id={tableId}
        data-column-id={column.id}
        data-row-index={row}
        data-measure-point={column.measurePoint ?? ''}
        data-captured-from={capture?.instanceId ?? ''}
        data-captured-channel={capture?.channelId ?? ''}
        data-reference-value-si={capture?.referenceValueSI}
        data-requested-window-sec={capture?.requestedWindowSec}
        data-captured-window={capture?.window ? JSON.stringify(capture.window) : ''}
        data-captured-statistics={capture?.statistics ? JSON.stringify(capture.statistics) : ''}
        placeholder={column.computed ? '等待测量数据' : '未记录'}
        className="font-mono text-xs"
        onFocus={() => {
          editing.current = true
        }}
        onChange={(event) => {
          editing.current = true
          dirty.current = true
          setDraft(event.target.value)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            editing.current = false
            dirty.current = false
            setError(null)
            setDraft(formatTaskCellValue(value))
          }
        }}
      />
      {error && (
        <p id={errorId} role="alert" className="max-w-48 whitespace-normal text-xs text-destructive">
          {error}
        </p>
      )}
      {capture && (
        <span
          id={captureId}
          title={captureLabel}
          className="block max-w-28 truncate font-mono text-xs text-muted-foreground"
        >
          {captureLabel}
        </span>
      )}
    </div>
  )
}

export function TaskDataPanel({ project }: { project?: Project }) {
  const state = useTask((value) => value)
  const panels = useInstrumentPanels((value) => value.panels)
  const tableSelectId = useId()
  const rowSelectId = useId()
  const sourceSelectId = useId()
  const sources = panels.flatMap((panel) =>
    isMeasurementInstrument(panel.instrument)
      ? [{ id: panel.id, title: panel.title }]
      : [
          ...(panel.instrument.scope?.channels ?? []).map((channel) => ({
            id: `${panel.id}.${channel.id}`,
            title: `${panel.title} ${channel.label}`,
          })),
          ...(panel.instrument.scope?.channels ?? []).flatMap((positive) =>
            (panel.instrument.scope?.channels ?? []).flatMap((negative) =>
              positive.id === negative.id
                ? []
                : [
                    {
                      id: `${panel.id}.${positive.id}-${negative.id}`,
                      title: `${panel.title} ${positive.label}−${negative.label}（同步差分）`,
                    },
                  ],
            ),
          ),
        ],
  )
  if (!project) return <p className="p-3 text-sm text-muted-foreground">当前未选择有效实训项目。</p>
  const step = currentTaskStep(project, state.task)
  const table = project.dataTables.find((item) => item.id === state.selectedTable)
  const rows = Array.from({ length: table?.rows ?? 0 }, (_, index) => ({
    index,
    id: JSON.stringify([table?.id, index]),
  }))
  const initialized = state.projectId === project.id
  const sourcePresent = state.selectedSource === 'auto' || sources.some((source) => source.id === state.selectedSource)
  return (
    <section
      aria-label="实训数据记录"
      data-task-project={project.id}
      data-task-table={state.selectedTable}
      data-current-step={initialized ? (step?.id ?? '') : ''}
      data-completed-count={initialized ? state.task.completedSteps.length : 0}
      className="min-w-0 space-y-3 p-3"
    >
      {!initialized ? (
        <p className="text-sm text-muted-foreground">正在初始化项目记录。</p>
      ) : !project.dataTables.length ? (
        <p className="text-sm text-muted-foreground">本项目尚未配置数据记录表。仪表功能验证不替代正式实训记录。</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex w-48 min-w-0 flex-col gap-1">
              <label htmlFor={tableSelectId} className="text-xs text-muted-foreground">
                记录数据表
              </label>
              <Select value={state.selectedTable} onValueChange={(value) => selectTaskTable(project, value)}>
                <SelectTrigger id={tableSelectId} className="w-full">
                  <SelectValue placeholder="选择数据表" />
                </SelectTrigger>
                <SelectContent>
                  {project.dataTables.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex w-24 flex-col gap-1">
              <label htmlFor={rowSelectId} className="text-xs text-muted-foreground">
                记录行
              </label>
              <Select
                value={String(state.selectedRow)}
                onValueChange={(value) => selectTaskRow(project, Number(value))}
                disabled={!table}
              >
                <SelectTrigger id={rowSelectId} className="w-full">
                  <SelectValue placeholder="选择行" />
                </SelectTrigger>
                <SelectContent>
                  {rows.map((row) => (
                    <SelectItem key={row.id} value={String(row.index)}>
                      第 {row.index + 1} 行
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex w-56 min-w-0 flex-col gap-1">
              <label htmlFor={sourceSelectId} className="text-xs text-muted-foreground">
                记录来源仪表
              </label>
              <Select value={state.selectedSource} onValueChange={selectTaskSource}>
                <SelectTrigger id={sourceSelectId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动匹配已接线仪表</SelectItem>
                  {sources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.title} ({source.id})
                    </SelectItem>
                  ))}
                  {!sourcePresent && (
                    <SelectItem value={state.selectedSource} disabled>
                      {state.selectedSource}（已移除）
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={() => recordTaskReadings(project)} disabled={!table}>
              记录当前行读数
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            可手填有限数值，留空清除。快捷记录仅写入当前真实仪表所测的绑定列，按测量点参考方向保留符号；未接入的列保持原值。
          </p>
          {table && (
            <Table aria-label={table.title} data-table-id={table.id}>
              <TableCaption>{table.title}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">行</TableHead>
                  {table.columns.map((column) => (
                    <TableHead key={column.id} scope="col" data-column-id={column.id}>
                      {column.title}
                      {column.unit && (
                        <span className="ml-1 font-mono text-xs text-muted-foreground">({column.unit})</span>
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-row-index={row.index}
                    data-state={row.index === state.selectedRow ? 'selected' : undefined}
                  >
                    <TableCell className="font-mono text-xs">{row.index + 1}</TableCell>
                    {table.columns.map((column) => (
                      <TableCell key={column.id} data-column-id={column.id}>
                        <TaskCellInput
                          key={JSON.stringify([project.id, row.id, column.id, state.resetVersion])}
                          project={project}
                          tableId={table.id}
                          tableTitle={table.title}
                          row={row.index}
                          column={column}
                          value={state.task.tables[table.id]?.[row.index]?.[column.id] ?? null}
                          capture={state.captures[taskCellKey(table.id, row.index, column.id)]}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
      <TaskFeedback />
      <section aria-label="报告波形截图" data-report-screenshots className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium">报告波形截图（{state.screenshots.length}）</h3>
        </div>
        {state.screenshots.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            可在示波器面板点击“截图入报告”，将当前波形（含 X-Y 模式或双光标读数）保存为报告附图。
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
            {state.screenshots.map((shot) => (
              <figure
                key={shot.id}
                data-screenshot-id={shot.id}
                data-screenshot-mode={shot.displayMode}
                className="flex flex-col gap-2 rounded-md border p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <figcaption className="truncate text-xs font-medium">{shot.title}</figcaption>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`删除 ${shot.title}`}
                    onClick={() => removeReportScreenshot(shot.id)}
                  >
                    删除
                  </Button>
                </div>
                <img
                  src={shot.dataUrl}
                  alt={shot.title}
                  className="aspect-video w-full rounded-sm border object-contain"
                />
                <p className="font-mono text-xs text-muted-foreground">{shot.summaryText}</p>
              </figure>
            ))}
          </div>
        )}
      </section>
    </section>
  )
}

export function TaskStepsPanel({ project }: { project?: Project }) {
  const state = useTask((value) => value)
  if (!project) return <p className="p-3 text-sm text-muted-foreground">当前未选择有效实训项目。</p>
  const initialized = state.projectId === project.id
  const current = initialized ? currentTaskStep(project, state.task) : undefined
  const completed = initialized ? state.task.completedSteps : []
  return (
    <section
      aria-label="实训步骤"
      data-task-project={project.id}
      data-current-step={current?.id ?? ''}
      data-completed-count={completed.length}
      className="min-w-0"
    >
      <div className="sticky top-0 z-10 space-y-2 border-b bg-background p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">步骤进度</h2>
          <span className="font-mono text-xs">
            {completed.length}/{project.steps.length}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          按顺序完成。测量步骤会核对当前真实读数，手填数据不能替代测量证据。
        </p>
        <Button className="w-full" disabled={!initialized || !current} onClick={() => completeCurrentTaskStep(project)}>
          完成当前步骤
        </Button>
        <TaskFeedback live={state.bottomTab !== 'data'} />
      </div>
      <ol className="divide-y px-3">
        {project.steps.map((step, index) => {
          const done = completed.includes(step.id)
          const active = current?.id === step.id
          return (
            <li
              key={step.id}
              data-step-id={step.id}
              data-step-state={done ? 'completed' : active ? 'current' : 'pending'}
              className="space-y-1 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-xs">
                  {index + 1}. {step.id}
                </h3>
                <span
                  className={cn('text-xs', done ? 'text-success' : active ? 'text-primary' : 'text-muted-foreground')}
                >
                  {done ? '已完成' : active ? '当前步骤' : '未开始'}
                </span>
              </div>
              <p className="text-sm leading-relaxed">{step.text}</p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
