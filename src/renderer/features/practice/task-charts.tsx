import { type ChartDataset, extractProjectCharts, formatChartAxisLabel } from '@domain/task'
import type { Project } from '@shared/schema/project'
import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, Scatter, ScatterChart, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { useTask } from '@/stores/task'

export function TaskChartCard({ dataset, animate = true }: { dataset: ChartDataset; animate?: boolean }) {
  const config = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        dataset.series.map((series) => [
          series.id,
          {
            label: formatChartAxisLabel(series.label, series.unit),
            color: series.colorVar,
          },
        ]),
      ),
    [dataset.series],
  )

  const xAxisLabel = formatChartAxisLabel(dataset.xLabel, dataset.xUnit)
  const firstSeries = dataset.series[0]
  const yAxisLabel =
    dataset.series.length === 1 && firstSeries
      ? formatChartAxisLabel(firstSeries.label, firstSeries.unit)
      : firstSeries?.unit && dataset.series.every((item) => item.unit === firstSeries.unit)
        ? firstSeries.unit
        : ''

  return (
    <article
      data-chart-card={dataset.id}
      data-chart-kind={dataset.kind}
      data-chart-points={dataset.validPointCount}
      className="space-y-2 rounded-md border p-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{dataset.title}</h3>
        <span className="font-mono text-xs text-muted-foreground">
          来源：{dataset.tableTitle} · 有效点 {dataset.validPointCount}/{dataset.totalRows} ·{' '}
          {dataset.kind === 'line' ? '折线图' : '散点图'}
        </span>
      </header>

      {dataset.emptyReason ? (
        <p data-chart-empty={dataset.id} className="py-6 text-center text-xs text-muted-foreground">
          {dataset.emptyReason}
        </p>
      ) : (
        <>
          <ChartContainer
            id={dataset.id}
            config={config}
            initialDimension={{ width: 640, height: 260 }}
            className="h-64 w-full aspect-auto"
          >
            {dataset.kind === 'scatter' ? (
              <ScatterChart margin={{ top: 8, right: 20, bottom: 20, left: 12 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey={dataset.xKey}
                  type="number"
                  domain={['auto', 'auto']}
                  name={dataset.xLabel}
                  label={{ value: xAxisLabel, position: 'insideBottom', offset: -10 }}
                />
                <YAxis
                  dataKey="y"
                  type="number"
                  domain={['auto', 'auto']}
                  label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                {dataset.series.map((series) => {
                  const seriesPoints = dataset.points
                    .filter((point) => point.values[series.id] !== null)
                    .map((point) => ({ [dataset.xKey]: point.x, y: point.values[series.id] }))
                  return (
                    <Scatter
                      key={series.id}
                      name={series.id}
                      data={seriesPoints}
                      fill={series.colorVar}
                      isAnimationActive={animate}
                    />
                  )
                })}
              </ScatterChart>
            ) : (
              <LineChart data={dataset.data} margin={{ top: 8, right: 20, bottom: 20, left: 12 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey={dataset.xKey}
                  type="number"
                  domain={['auto', 'auto']}
                  name={dataset.xLabel}
                  label={{ value: xAxisLabel, position: 'insideBottom', offset: -10 }}
                />
                <YAxis
                  type="number"
                  domain={['auto', 'auto']}
                  label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                {dataset.series.map((series) => (
                  <Line
                    key={series.id}
                    type="monotone"
                    dataKey={series.id}
                    name={series.id}
                    stroke={series.colorVar}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls={false}
                    isAnimationActive={animate}
                  />
                ))}
              </LineChart>
            )}
          </ChartContainer>
          {dataset.hint && <p className="text-xs text-muted-foreground">{dataset.hint}</p>}
        </>
      )}
    </article>
  )
}

export function TaskChartsPanel({ project }: { project?: Project }) {
  const state = useTask((value) => value)
  const datasets = useMemo(() => {
    if (!project || state.projectId !== project.id) return []
    return extractProjectCharts(project, state.task)
  }, [project, state.projectId, state.task])

  if (!project) return <p className="p-3 text-sm text-muted-foreground">当前未选择有效实训项目。</p>
  if (!project.charts.length) {
    return (
      <section aria-label="实训特性曲线" data-task-charts={project.id} className="p-3">
        <p className="text-sm text-muted-foreground">
          本项目未配置预设特性曲线。含伏安特性、电位图、谐振曲线等测绘任务的项目将根据数据记录自动出图。
        </p>
      </section>
    )
  }

  return (
    <section aria-label="实训特性曲线" data-task-charts={project.id} className="space-y-3 p-3">
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
        {datasets.map((dataset) => (
          <TaskChartCard key={dataset.id} dataset={dataset} />
        ))}
      </div>
    </section>
  )
}
