import { evaluateFormula, formulaColumns } from '../../shared/formula.ts'
import type { Chart, DataTable, Project } from '../../shared/schema/project.ts'
import type { TaskState } from './progress.ts'

export const CHART_SERIES_VARS = [
  'var(--primary)',
  'var(--chart-2)',
  'var(--success)',
  'var(--warning)',
  'var(--destructive)',
] as const

export type ChartSeriesMeta = {
  id: string
  label: string
  unit?: string
  colorVar: string
}

export type ChartPoint = {
  rowIndex: number
  x: number
  values: Record<string, number | null>
}

export type ChartDataset = {
  id: string
  title: string
  tableId: string
  tableTitle: string
  kind: Chart['kind']
  xKey: string
  xLabel: string
  xUnit?: string
  series: ChartSeriesMeta[]
  points: ChartPoint[]
  data: Record<string, number | null>[]
  totalRows: number
  validPointCount: number
  droppedRowCount: number
  emptyReason: string | null
  hint: string | null
}

function resolveRowValues(
  table: DataTable,
  rawRow: Readonly<Record<string, number | null>> | undefined,
): Record<string, number | null> {
  const values: Record<string, number | null> = Object.fromEntries(
    table.columns.map((column) => [column.id, rawRow?.[column.id] ?? null]),
  )
  const pending = new Map(table.columns.filter((column) => column.computed).map((column) => [column.id, column]))
  while (pending.size > 0) {
    let changed = false
    for (const [id, column] of pending) {
      const formula = column.computed as string
      if (formulaColumns(formula).some((reference) => pending.has(reference))) continue
      const result = evaluateFormula(formula, values)
      values[id] = result.value
      pending.delete(id)
      changed = true
    }
    if (!changed) break
  }
  return values
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function defaultChartTitle(table: DataTable, xTitle: string, yTitles: readonly string[]): string {
  return `${table.title}（${yTitles.join(' / ')} — ${xTitle}）`
}

export function extractChartDataset(project: Project, state: TaskState, chart: Chart): ChartDataset {
  const table = project.dataTables.find((entry) => entry.id === chart.table)
  if (!table) {
    return {
      id: chart.id,
      title: chart.title ?? chart.id,
      tableId: chart.table,
      tableTitle: chart.table,
      kind: chart.kind,
      xKey: chart.x,
      xLabel: chart.x,
      series: [],
      points: [],
      data: [],
      totalRows: 0,
      validPointCount: 0,
      droppedRowCount: 0,
      emptyReason: `未找到曲线关联的数据表 ${chart.table}。`,
      hint: null,
    }
  }

  const xCol = table.columns.find((col) => col.id === chart.x)
  const series: ChartSeriesMeta[] = chart.y.map((colId, index) => {
    const col = table.columns.find((entry) => entry.id === colId)
    return {
      id: colId,
      label: col?.title ?? colId,
      ...(col?.unit ? { unit: col.unit } : {}),
      colorVar: CHART_SERIES_VARS[index % CHART_SERIES_VARS.length] ?? 'var(--primary)',
    }
  })
  const xLabel = xCol?.title ?? chart.x
  const title =
    chart.title ??
    defaultChartTitle(
      table,
      xLabel,
      series.map((item) => item.label),
    )

  const rawRows = state.tables[table.id] ?? []
  const totalRows = Math.max(table.rows, rawRows.length)
  const extracted: ChartPoint[] = []

  for (let rowIndex = 0; rowIndex < totalRows; rowIndex++) {
    const resolved = resolveRowValues(table, rawRows[rowIndex])
    const xVal = finiteNumber(resolved[chart.x])
    if (xVal === null) continue
    const values: Record<string, number | null> = {}
    let hasValidY = false
    for (const item of series) {
      const yVal = finiteNumber(resolved[item.id])
      values[item.id] = yVal
      if (yVal !== null) hasValidY = true
    }
    if (!hasValidY) continue
    extracted.push({ rowIndex, x: xVal, values })
  }

  const points =
    chart.kind === 'line'
      ? extracted.slice().sort((a, b) => (a.x === b.x ? a.rowIndex - b.rowIndex : a.x - b.x))
      : extracted

  const data = points.map((point) => ({
    rowIndex: point.rowIndex + 1,
    [chart.x]: point.x,
    ...point.values,
  }))

  const validPointCount = points.length
  const droppedRowCount = Math.max(0, totalRows - validPointCount)
  const emptyReason =
    validPointCount === 0
      ? `尚无有效数据点，请先在“${table.title}”中记录 ${xLabel} 与 ${series.map((s) => s.label).join('、')} 读数。`
      : null
  const hint =
    validPointCount === 1 && chart.kind === 'line'
      ? '当前仅 1 个有效数据点，继续记录更多数据行即可连成完整特性曲线。'
      : null

  return {
    id: chart.id,
    title,
    tableId: table.id,
    tableTitle: table.title,
    kind: chart.kind,
    xKey: chart.x,
    xLabel,
    ...(xCol?.unit ? { xUnit: xCol.unit } : {}),
    series,
    points,
    data,
    totalRows,
    validPointCount,
    droppedRowCount,
    emptyReason,
    hint,
  }
}

export function extractProjectCharts(project: Project, state: TaskState): ChartDataset[] {
  return project.charts.map((chart) => extractChartDataset(project, state, chart))
}

export function formatChartAxisLabel(label: string, unit?: string): string {
  return unit ? `${label} (${unit})` : label
}
