import { describe, expect, it } from 'vitest'
import { Project } from '../../shared/schema/project.ts'
import { createFaultFlowState } from './fault-flow.ts'
import {
  assembleLabReport,
  createTaskState,
  defaultReportFilename,
  extractChartDataset,
  extractProjectCharts,
  formatChartAxisLabel,
  writeTableCell,
} from './index.ts'

const curveProject = Project.parse({
  id: 'DG-02',
  group: '直流电路',
  title: '电路元件伏安特性的测绘',
  type: 'basic',
  modules: [{ instanceId: 'dc1', moduleId: 'mod-dc-circuit', slot: 'SLOT_BOX_L1' }],
  allowedInstruments: ['ins-multimeter'],
  reference: {
    nets: [],
    measurePoints: [
      { id: 'u', kind: 'voltage', mode: 'dcv', between: ['dc1.TH_A', 'dc1.TH_B'] },
      { id: 'i', kind: 'current', mode: 'dca', branch: ['dc1.KH_I1A', 'dc1.KH_I1B'] },
    ],
  },
  steps: [
    { id: 's1', text: '接线并设置电源。', measurePoints: [] },
    { id: 's2', text: '逐点测量 U 与 I。', measurePoints: ['u', 'i'], dataTable: 'vi' },
  ],
  dataTables: [
    {
      id: 'vi',
      title: '电阻与非线性元件伏安特性',
      rows: 5,
      columns: [
        { id: 'u', title: '电压 U', unit: 'V', measurePoint: 'u' },
        { id: 'i_lin', title: '线性电流 I1', unit: 'mA', measurePoint: 'i' },
        { id: 'i_nl', title: '非线性电流 I2', unit: 'mA' },
        { id: 'p_lin', title: '功率 P', unit: 'mW', computed: 'u*i_lin' },
      ],
      sanity: [{ column: 'u', min: 0, max: 15, message: '电压 U 超出 0~15 V 推荐测量范围。' }],
    },
  ],
  charts: [
    { id: 'vi-line', title: '伏安特性曲线', table: 'vi', x: 'u', y: ['i_lin', 'i_nl'], kind: 'line' },
    { id: 'power-scatter', table: 'vi', x: 'u', y: ['p_lin'], kind: 'scatter' },
  ],
  questions: ['线性电阻与白炽灯伏安特性曲线有何区别？', '电压表内阻对小电流段有何影响？'],
})

describe('T1.6 TSK-04/05/06 曲线点提取与报告数据模型拼装', () => {
  it('TSK-04 从多行数据表提取有效曲线点、过滤空值并按 X 升序排序折线图，支持计算列散点图', () => {
    let task = createTaskState(curveProject)
    // 刻意乱序记录，并包含空行与单列缺失行
    task = writeTableCell(curveProject, task, 'vi', 0, 'u', 6).state
    task = writeTableCell(curveProject, task, 'vi', 0, 'i_lin', 12).state
    task = writeTableCell(curveProject, task, 'vi', 0, 'i_nl', 8.5).state

    // 第 2 行仅填 X 未填任何 Y -> 应被过滤
    task = writeTableCell(curveProject, task, 'vi', 1, 'u', 4).state

    // 第 3 行仅填 Y 未填 X -> 应被过滤
    task = writeTableCell(curveProject, task, 'vi', 2, 'i_lin', 5).state

    // 第 4 行记录更小的 X（2 V），且只填第一条曲线
    task = writeTableCell(curveProject, task, 'vi', 3, 'u', 2).state
    task = writeTableCell(curveProject, task, 'vi', 3, 'i_lin', 4).state

    // 第 5 行记录 10 V
    task = writeTableCell(curveProject, task, 'vi', 4, 'u', 10).state
    task = writeTableCell(curveProject, task, 'vi', 4, 'i_lin', 20).state
    task = writeTableCell(curveProject, task, 'vi', 4, 'i_nl', 11.2).state

    const [viLine, powerScatter] = extractProjectCharts(curveProject, task)
    if (!viLine || !powerScatter) throw new Error('Expected two chart datasets')
    expect(viLine.title).toBe('伏安特性曲线')
    expect(viLine.validPointCount).toBe(3)
    expect(viLine.droppedRowCount).toBe(2)
    expect(viLine.emptyReason).toBeNull()
    expect(viLine.hint).toBeNull()
    // 折线图按 X 升序排列：2 -> 6 -> 10
    expect(viLine.points.map((point) => point.x)).toEqual([2, 6, 10])
    expect(viLine.points[0]?.values).toEqual({ i_lin: 4, i_nl: null })
    expect(viLine.points[1]?.values).toEqual({ i_lin: 12, i_nl: 8.5 })
    expect(viLine.points[2]?.values).toEqual({ i_lin: 20, i_nl: 11.2 })
    expect(formatChartAxisLabel(viLine.xLabel, viLine.xUnit)).toBe('电压 U (V)')

    // 散点图引用计算列 p_lin = u * i_lin，保持原始记录顺序（6 -> 2 -> 10）
    expect(powerScatter.kind).toBe('scatter')
    expect(powerScatter.title).toContain('功率 P')
    expect(powerScatter.points.map((point) => [point.x, point.values.p_lin])).toEqual([
      [6, 72],
      [2, 8],
      [10, 200],
    ])
  })

  it('TSK-04 空表返回明确空原因，单点折线给出继续记录提示', () => {
    const emptyTask = createTaskState(curveProject)
    const firstChart = curveProject.charts[0]
    if (!firstChart) throw new Error('Expected first chart')
    const emptyDataset = extractChartDataset(curveProject, emptyTask, firstChart)
    expect(emptyDataset.validPointCount).toBe(0)
    expect(emptyDataset.emptyReason).toContain('尚无有效数据点')

    let singleTask = writeTableCell(curveProject, emptyTask, 'vi', 0, 'u', 3).state
    singleTask = writeTableCell(curveProject, singleTask, 'vi', 0, 'i_lin', 6).state
    const singleDataset = extractChartDataset(curveProject, singleTask, firstChart)
    expect(singleDataset.validPointCount).toBe(1)
    expect(singleDataset.emptyReason).toBeNull()
    expect(singleDataset.hint).toContain('1 个有效数据点')
  })

  it('TSK-05/06 组装完整结构化实验报告（指导、步骤、计算列、合理性提示、曲线、有效截图、思考题）', () => {
    let task = createTaskState(curveProject)
    task = { ...task, completedSteps: ['s1'] }
    task = writeTableCell(curveProject, task, 'vi', 0, 'u', 20).state // 超出 15 V 触发 sanity 警告
    task = writeTableCell(curveProject, task, 'vi', 0, 'i_lin', 40).state

    const validPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const report = assembleLabReport({
      project: curveProject,
      guideMarkdown: '## 实训目的\n掌握元件伏安特性测绘方法。',
      task,
      answers: { '0': '线性电阻为直线，白炽灯因灯丝升温阻值增大呈非线性弯曲。' },
      screenshots: [
        {
          id: 'shot-1',
          instanceId: 'scope1',
          instrumentTitle: '示波器',
          title: '示波器 #1 (X-Y)',
          dataUrl: validPng,
          createdAt: '2026-11-24T03:00:00.000Z',
          displayMode: 'xy',
          frozen: true,
          summaryText: 'X-Y 模式 · CH1 Vpp=4.00 V',
        },
        {
          id: 'shot-bad',
          instanceId: 'scope1',
          instrumentTitle: '示波器',
          title: '非法外链截图',
          dataUrl: 'https://example.com/evil.png',
          createdAt: '2026-11-24T03:00:01.000Z',
          displayMode: 'yt',
          frozen: false,
          summaryText: '',
        },
      ],
      faultFlow: createFaultFlowState(),
      generatedAt: '2026-11-24T03:05:00.000Z',
    })

    expect(report.projectId).toBe('DG-02')
    expect(report.stepSummary.completed).toBe(1)
    expect(report.stepSummary.total).toBe(2)
    expect(report.tables[0]?.filledRows).toBe(1)
    expect(report.tables[0]?.rows[0]?.cells.find((cell) => cell.columnId === 'p_lin')?.formatted).toBe('800')
    expect(report.tables[0]?.warnings[0]).toContain('电压 U 超出 0~15 V')
    expect(report.charts[0]?.validPointCount).toBe(1)
    // 非法非 data:image URL 应被过滤
    expect(report.screenshots).toHaveLength(1)
    expect(report.screenshots[0]?.id).toBe('shot-1')
    expect(report.questions).toEqual([
      {
        index: 1,
        prompt: '线性电阻与白炽灯伏安特性曲线有何区别？',
        answer: '线性电阻为直线，白炽灯因灯丝升温阻值增大呈非线性弯曲。',
      },
      {
        index: 2,
        prompt: '电压表内阻对小电流段有何影响？',
        answer: '',
      },
    ])
    expect(defaultReportFilename(curveProject)).toBe('DG-02-电路元件伏安特性的测绘-实训报告.pdf')
  })
})
