import { isMeasurementInstrument } from '@domain/instruments'
import {
  buildStepViewList,
  currentTaskStep,
  GUIDE_MODE_LABELS,
  GUIDE_MODES,
  measurementUnit,
  resolveGuideModePolicy,
  scopedReference,
} from '@domain/task'
import { missingReferenceLinks } from '@domain/wiring-check'
import type { Project } from '@shared/schema/project'
import { Crosshair } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatEngineeringValue } from '@/components/instruments/rotary-knob-values'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useInstrumentPanels } from '@/stores/instrument-panels'
import {
  completeCurrentTaskStep,
  evaluateTaskCompetition,
  focusTaskStep,
  formatTaskCellValue,
  parseTaskCellDraft,
  recordNextTaskRowReadings,
  recordTaskReadings,
  removeReportScreenshot,
  selectTaskRow,
  selectTaskSource,
  selectTaskTable,
  setTaskGuideMode,
  setTaskQuestionAnswer,
  startTaskCompetition,
  taskCellKey,
  tickTaskCompetition,
  useTask,
  writeTaskCell,
} from '@/stores/task'
import { useBenchView } from '@/three/bench-view'
import type { CapturedMeasurement } from '../../../domain/task'
import { jackName, useCircuit, useWiringJacks } from './wiring-state'

export { completeCurrentTaskStep, recordTaskReadings } from '@/stores/task'

type TaskColumn = Project['dataTables'][number]['columns'][number]

function formatCountdown(seconds: number): string {
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function CompetitionBanner({ project }: { project: Project }) {
  const spec = project.competition
  const competition = useTask((state) => state.competition)
  useEffect(() => {
    if (!spec || competition.status !== 'running') return
    const timer = window.setInterval(() => tickTaskCompetition(project), 1000)
    return () => window.clearInterval(timer)
  }, [project, spec, competition.status])
  if (!spec) return null
  const statusLabel =
    competition.status === 'passed'
      ? '已达标'
      : competition.status === 'expired'
        ? '已超时'
        : competition.status === 'running'
          ? '计时中'
          : '未开始'
  return (
    <section
      aria-label="竞赛指标验收"
      data-competition-panel
      data-competition-status={competition.status}
      data-competition-score={competition.scorePct}
      className="space-y-2 rounded-sm border bg-muted/30 p-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{spec.title}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {statusLabel} · {formatCountdown(competition.remainingSec)}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{spec.brief}</p>
      <ul className="space-y-1 text-xs">
        {spec.criteria.map((criterion) => {
          const res = competition.results[criterion.id]
          return (
            <li
              key={criterion.id}
              data-criterion-id={criterion.id}
              data-criterion-passed={res?.passed ? 'true' : 'false'}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">
                {criterion.label}（{criterion.min}~{criterion.max} {criterion.unit}）
              </span>
              <span
                className={cn(
                  'shrink-0 font-mono tabular-nums',
                  res?.passed ? 'text-success' : res ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {res?.passed
                  ? `${res.measured?.toFixed(1) ?? ''} ${criterion.unit} ✓`
                  : res?.measured !== null && res?.measured !== undefined
                    ? `${res.measured.toFixed(1)} ${criterion.unit}`
                    : '待核验'}
              </span>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <span className="font-mono text-xs tabular-nums">
          达成度：{competition.passedCount}/{spec.criteria.length}（{competition.scorePct}%）
        </span>
        <div className="flex items-center gap-1.5">
          {competition.status === 'idle' && (
            <Button size="xs" variant="outline" onClick={() => startTaskCompetition(project)}>
              开始竞赛
            </Button>
          )}
          <Button
            size="xs"
            variant="secondary"
            disabled={competition.status === 'expired'}
            onClick={() => evaluateTaskCompetition(project)}
          >
            核验竞赛指标
          </Button>
        </div>
      </div>
    </section>
  )
}

function TaskFeedback({ live = true }: { live?: boolean }) {
  const notice = useTask((state) => state.notice)
  const noticeDetail = useTask((state) => state.noticeDetail)
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
        <p data-task-notice title={noticeDetail ?? notice} className="text-xs leading-relaxed">
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
  sourceTitle,
}: {
  project: Project
  tableId: string
  tableTitle: string
  row: number
  column: TaskColumn
  value: number | null
  capture?: CapturedMeasurement
  sourceTitle?: string
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
    ? `来自 ${sourceTitle ?? '仪表'}${capture.channelId ? ` ${capture.channelId}` : ''} · ${formatEngineeringValue(capture.referenceValueSI, siUnit)}`
    : ''
  const captureTitle = capture
    ? `来自 ${sourceTitle ?? capture.instanceId}${capture.channelId ? `.${capture.channelId}` : ''} · 原始显示 ${formatTaskCellValue(capture.displayValueSI)} ${siUnit}，参考方向 ${formatTaskCellValue(capture.referenceValueSI)} ${siUnit}`
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
          title={captureTitle}
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
                  {sources.map((source) => {
                    const duplicated = sources.filter((entry) => entry.title === source.title).length > 1
                    return (
                      <SelectItem key={source.id} value={source.id} data-source-id={source.id}>
                        {duplicated ? `${source.title}（${source.id}）` : source.title}
                      </SelectItem>
                    )
                  })}
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
            {table && table.rows > 1 && (
              <Button variant="outline" onClick={() => recordNextTaskRowReadings(project)}>
                记录至下一空行
              </Button>
            )}
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
                    {table.columns.map((column) => {
                      const capture = state.captures[taskCellKey(table.id, row.index, column.id)]
                      const sourceTitle = capture
                        ? panels.find((panel) => panel.id === capture.instanceId)?.title
                        : undefined
                      return (
                        <TableCell key={column.id} data-column-id={column.id}>
                          <TaskCellInput
                            key={JSON.stringify([project.id, row.id, column.id, state.resetVersion])}
                            project={project}
                            tableId={table.id}
                            tableTitle={table.title}
                            row={row.index}
                            column={column}
                            value={state.task.tables[table.id]?.[row.index]?.[column.id] ?? null}
                            capture={capture}
                            sourceTitle={sourceTitle}
                          />
                        </TableCell>
                      )
                    })}
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
  const wires = useCircuit((value) => value.wires)
  const jacks = useWiringJacks()
  const initialized = Boolean(project) && state.projectId === project?.id
  const current = project && initialized ? currentTaskStep(project, state.task) : undefined
  const policy = resolveGuideModePolicy(state.guideMode)
  const availableJackSet = useMemo(() => new Set(jacks.map((jack) => jack.ref)), [jacks])
  // 引导模式下当前步骤的待连与待测定位条目（T1.9B；自主模式严格为空）
  const currentLocateItems = useMemo(() => {
    if (!project || !current || !policy.showProcessHints) return []
    const items: { key: string; label: string; a: string; b: string }[] = []
    const ref = scopedReference(project, current)
    const missing = missingReferenceLinks(ref.nets, wires).filter(
      ([a, b]) => availableJackSet.has(a) && availableJackSet.has(b),
    )
    for (const [a, b] of missing.slice(0, 4)) {
      items.push({ key: `net:${a}:${b}`, label: `${jackName(a)} → ${jackName(b)}`, a, b })
    }
    for (const mpId of current.measurePoints ?? []) {
      const mp = project.reference.measurePoints.find((entry) => entry.id === mpId)
      const endpoints = mp?.between ?? mp?.branch
      if (!endpoints) continue
      const [a, b] = endpoints
      if (!availableJackSet.has(a) || !availableJackSet.has(b)) continue
      const colTitle =
        project.dataTables.flatMap((t) => t.columns).find((col) => col.measurePoint === mpId)?.title ?? mpId
      items.push({ key: `mp:${mpId}`, label: `测量 ${colTitle}（${jackName(a)} / ${jackName(b)}）`, a, b })
    }
    return items
  }, [project, current, policy.showProcessHints, wires, availableJackSet])
  if (!project) return <p className="p-3 text-sm text-muted-foreground">当前未选择有效实训项目。</p>
  const completed = initialized ? state.task.completedSteps : []
  const stepViews = initialized ? buildStepViewList(project, state.task, state.focusedStepId) : []
  return (
    <section
      aria-label="实训步骤"
      data-task-project={project.id}
      data-current-step={current?.id ?? ''}
      data-focused-step={state.focusedStepId ?? current?.id ?? ''}
      data-completed-count={completed.length}
      data-guide-mode={state.guideMode}
      className="min-w-0"
    >
      <div className="sticky top-0 z-10 space-y-2 border-b bg-background p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">步骤进度</h2>
          <span className="font-mono text-xs">
            {completed.length}/{project.steps.length}
          </span>
        </div>
        <fieldset aria-label="实训引导模式" className="grid grid-cols-2 gap-1">
          {GUIDE_MODES.map((mode) => (
            <Button
              key={mode}
              size="xs"
              variant={state.guideMode === mode ? 'secondary' : 'outline'}
              aria-pressed={state.guideMode === mode}
              onClick={() => {
                if (mode === 'free') {
                  useBenchView.getState().setShowGuide(false)
                  useBenchView.getState().setHighlightedLink(null)
                }
                setTaskGuideMode(mode)
              }}
            >
              {GUIDE_MODE_LABELS[mode]}
            </Button>
          ))}
        </fieldset>
        <p data-guide-mode-policy className="text-xs leading-relaxed text-muted-foreground">
          {policy.showProcessHints
            ? '按顺序完成。测量步骤会核对当前真实读数，手填数据不能替代测量证据。'
            : '自主模式：已隐藏 3D 参考接线虚线与步骤过程测点提示，保留安全告警与手动接线检查。'}
        </p>
        <Button className="w-full" disabled={!initialized || !current} onClick={() => completeCurrentTaskStep(project)}>
          完成当前步骤
        </Button>
        <CompetitionBanner project={project} />
        <TaskFeedback live={state.bottomTab !== 'data'} />
      </div>
      <ol className="divide-y px-3">
        {stepViews.map((step) => {
          const done = step.status === 'completed'
          const active = step.status === 'current'
          return (
            <li
              key={step.id}
              data-step-id={step.id}
              data-step-state={step.status}
              data-step-focused={step.focused ? 'true' : 'false'}
              className={cn('space-y-1.5 py-3', step.focused && 'bg-muted/40 px-2 -mx-2 rounded-sm')}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  aria-label={`${step.index + 1}. ${step.id}`}
                  onClick={() => focusTaskStep(project, step.id)}
                  className="text-left text-xs font-medium hover:underline focus-visible:outline-1"
                >
                  第 {step.index + 1} 步
                </button>
                <span
                  className={cn('text-xs', done ? 'text-success' : active ? 'text-primary' : 'text-muted-foreground')}
                >
                  {done ? '已完成' : active ? '当前步骤' : '未开始'}
                </span>
              </div>
              <p className="text-sm leading-relaxed">{step.text}</p>
              {policy.showProcessHints && (step.measurePoints.length > 0 || step.dataTable) && (
                <p
                  data-step-hint={step.id}
                  data-measure-points={step.measurePoints.join(',')}
                  className="text-xs text-muted-foreground"
                >
                  {step.measurePoints.length > 0
                    ? `需测项：${step.measurePoints
                        .map(
                          (mpId) =>
                            project.dataTables
                              .flatMap((entry) => entry.columns)
                              .find((col) => col.measurePoint === mpId)?.title ?? mpId,
                        )
                        .join('、')}`
                    : ''}
                  {step.measurePoints.length > 0 && step.dataTable ? ' · ' : ''}
                  {step.dataTable
                    ? `关联表：${project.dataTables.find((entry) => entry.id === step.dataTable)?.title ?? step.dataTable}`
                    : ''}
                </p>
              )}
              {active && policy.showProcessHints && currentLocateItems.length > 0 && (
                <ul data-step-locate-list className="space-y-1 pt-1">
                  {currentLocateItems.map((item) => (
                    <li
                      key={item.key}
                      data-step-locate-item={item.key}
                      className="flex items-center justify-between gap-1.5 rounded-sm border bg-background px-2 py-1 text-xs hover:bg-accent/50"
                      onMouseEnter={() =>
                        useBenchView.getState().setHighlightedLink({
                          jacks: [item.a, item.b],
                          guidePair: [item.a, item.b],
                          source: 'step',
                        })
                      }
                      onMouseLeave={() => useBenchView.getState().setHighlightedLink(null)}
                    >
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.label}>
                        {item.label}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        data-step-locate-btn={item.key}
                        aria-label={`定位 ${item.label}`}
                        className="h-5 shrink-0 px-1.5"
                        onClick={() => useBenchView.getState().locateJack(item.a, [item.a, item.b], 'step')}
                      >
                        <Crosshair className="size-3" />
                        定位
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ol>
      {project.questions.length > 0 && (
        <section aria-label="思考题作答" data-task-questions className="space-y-3 border-t p-3">
          <h3 className="text-xs font-medium">思考题作答（{project.questions.length}）</h3>
          <div className="space-y-3">
            {project.questions.map((question, index) => {
              const qKey = String(index)
              const answer = state.answers[qKey] ?? ''
              return (
                <div key={question} className="space-y-1">
                  <label htmlFor={`question-${project.id}-${index}`} className="block text-xs leading-relaxed">
                    {index + 1}. {question}
                  </label>
                  <Input
                    id={`question-${project.id}-${index}`}
                    aria-label={`思考题 ${index + 1} 作答`}
                    data-question-index={index}
                    value={answer}
                    placeholder="输入本题分析与作答（随存档与报告保存）"
                    className="text-xs"
                    onChange={(event) => setTaskQuestionAnswer(project, index, event.target.value)}
                  />
                </div>
              )
            })}
          </div>
        </section>
      )}
    </section>
  )
}
