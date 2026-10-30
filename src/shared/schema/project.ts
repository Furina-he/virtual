import { z } from 'zod'
import { formulaColumns } from '../formula.ts'
import { ContentId, InstanceId, JackRef, uniqueBy } from './common.ts'

// 技术设计 §3.3
export const ProjectId = z.string().regex(/^(DG|MD|SD)-\d{2}$/, '项目编号格式应为 DG-01 / MD-01 / SD-01')
const SlotId = z.string().regex(/^SLOT_[A-Z0-9_]+$/, '格式应为 SLOT_<大写ID>')

export const MeasurePoint = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['voltage', 'current', 'waveform']),
    mode: z.enum(['dcv', 'acv', 'dca', 'aca']).optional(),
    quantity: z.enum(['mean', 'vpp', 'min', 'max', 'frequency', 'period']).optional(),
    minCycles: z.number().int().min(2).optional(),
    // Optional bounded raw/stream window for static waveform evidence.
    windowSec: z.number().finite().gt(0).lte(16).optional(),
    between: z.tuple([JackRef, JackRef]).optional(),
    // 电流测量所在支路：串入电流表时断开的两个插孔
    branch: z.tuple([JackRef, JackRef]).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.kind === 'current' && !p.branch)
      ctx.addIssue({ code: 'custom', message: '电流测量点需要 branch', path: ['branch'] })
    if (p.kind !== 'current' && !p.between)
      ctx.addIssue({ code: 'custom', message: '电压/波形测量点需要 between', path: ['between'] })
    if (
      p.mode &&
      (p.kind === 'waveform' ||
        (p.kind === 'current' ? !['dca', 'aca'].includes(p.mode) : !['dcv', 'acv'].includes(p.mode)))
    )
      ctx.addIssue({ code: 'custom', message: '测量模式与测量点类型不符', path: ['mode'] })
    if (p.quantity && p.kind !== 'waveform')
      ctx.addIssue({ code: 'custom', message: 'quantity 只用于波形测量点', path: ['quantity'] })
    if (p.minCycles && p.kind !== 'waveform')
      ctx.addIssue({ code: 'custom', message: 'minCycles 只用于波形测量点', path: ['minCycles'] })
    if (p.windowSec !== undefined && p.kind !== 'waveform')
      ctx.addIssue({ code: 'custom', message: 'windowSec 只用于波形测量点', path: ['windowSec'] })
  })

// 步骤完成条件：某测量点读数落在区间内
export const Expectation = z
  .object({ measurePoint: z.string().min(1), min: z.number(), max: z.number() })
  .superRefine((e, ctx) => {
    if (e.min > e.max) ctx.addIssue({ code: 'custom', message: '上限不能小于下限', path: ['max'] })
  })

export const Column = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  unit: z.string().optional(),
  // 绑定测量点后可用"记录当前读数"（TSK-03）
  measurePoint: z.string().min(1).optional(),
  computed: z.string().optional(),
  captureSteps: z.array(z.string().min(1)).min(1).optional(),
})

// 明显不合理数据的提示（TSK-03）
export const SanityRule = z
  .object({
    column: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
    message: z.string().min(1),
  })
  .superRefine((rule, ctx) => {
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max)
      ctx.addIssue({ code: 'custom', message: '上限不能小于下限', path: ['max'] })
  })

export const DataTable = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  columns: z.array(Column).min(1).superRefine(uniqueBy('id')),
  rows: z.number().int().positive(),
  sanity: z.array(SanityRule).optional(),
})

export const Chart = z.object({
  id: z.string().min(1),
  table: z.string().min(1),
  x: z.string().min(1),
  y: z.array(z.string().min(1)).min(1),
  kind: z.enum(['line', 'scatter']),
})

// 技术设计 §8
export const FaultDef = z.object({
  id: z.string().min(1),
  target: z.string().regex(/^[a-z][a-z0-9-]*\.\S+$/, '格式应为 <实例ID>.<元件名>'),
  kind: z.enum(['open', 'short', 'drift', 'dead']),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  symptom: z.string().min(1),
  hint: z.string().min(1),
})

export const Step = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  expect: Expectation.optional(),
  expects: z.array(Expectation).optional(),
  measurePoints: z
    .array(z.string().min(1))
    .refine((points) => new Set(points).size === points.length, '步骤测量点不能重复')
    .optional(),
  referenceNets: z.array(z.array(JackRef).min(2)).min(1).optional(),
  checkWiring: z.boolean().optional(),
  recordTable: z.string().min(1).optional(),
  dataTable: z.string().min(1).optional(),
})

export const Project = z
  .object({
    id: ProjectId,
    group: z.string().min(1),
    title: z.string().min(1),
    type: z.enum(['basic', 'integrated']),
    // A functional validation fixture is not a completed teaching project.
    validation: z.object({ purpose: z.string().min(1), limitations: z.array(z.string().min(1)).min(1) }).optional(),
    modules: z
      .array(z.object({ instanceId: InstanceId, moduleId: ContentId, slot: SlotId }))
      .min(1)
      .superRefine(uniqueBy('instanceId')),
    // 仪表柜内容，只能是 desktop 类仪表；固定在控制屏上的仪表总是在场（content:lint 交叉检查）
    allowedInstruments: z.array(ContentId),
    reference: z.object({
      nets: z.array(z.array(JackRef).min(2)),
      measurePoints: z.array(MeasurePoint).superRefine(uniqueBy('id')),
    }),
    steps: z.array(Step).min(1).superRefine(uniqueBy('id')),
    dataTables: z.array(DataTable).superRefine(uniqueBy('id')).default([]),
    charts: z.array(Chart).superRefine(uniqueBy('id')).default([]),
    faults: z.array(FaultDef).superRefine(uniqueBy('id')).optional(),
    questions: z.array(z.string().min(1)),
  })
  .superRefine((p, ctx) => {
    // 参考拓扑中一个插孔只能属于一个网络
    const validateNets = (nets: string[][], path: (string | number)[]) => {
      const owner = new Map<string, number>()
      nets.forEach((net, i) => {
        net.forEach((ref, j) => {
          const prev = owner.get(ref)
          if (prev !== undefined)
            ctx.addIssue({
              code: 'custom',
              message: `插孔 ${ref} 同时出现在网络 ${prev} 和 ${i}`,
              path: [...path, i, j],
            })
          owner.set(ref, i)
        })
      })
    }
    validateNets(p.reference.nets, ['reference', 'nets'])
    const points = new Set(p.reference.measurePoints.map((m) => m.id))
    const tables = new Map(p.dataTables.map((t) => [t.id, new Set(t.columns.map((c) => c.id))]))
    const steps = new Set(p.steps.map((step) => step.id))
    p.steps.forEach((s, i) => {
      if (s.referenceNets) validateNets(s.referenceNets, ['steps', i, 'referenceNets'])
      if (s.expect && !points.has(s.expect.measurePoint))
        ctx.addIssue({
          code: 'custom',
          message: `测量点 ${s.expect.measurePoint} 不存在`,
          path: ['steps', i, 'expect', 'measurePoint'],
        })
      s.expects?.forEach((expectation, j) => {
        if (!points.has(expectation.measurePoint))
          ctx.addIssue({
            code: 'custom',
            message: `测量点 ${expectation.measurePoint} 不存在`,
            path: ['steps', i, 'expects', j, 'measurePoint'],
          })
      })
      s.measurePoints?.forEach((point, j) => {
        if (!points.has(point))
          ctx.addIssue({
            code: 'custom',
            message: `测量点 ${point} 不存在`,
            path: ['steps', i, 'measurePoints', j],
          })
      })
      if (s.recordTable && !tables.has(s.recordTable))
        ctx.addIssue({ code: 'custom', message: `数据表 ${s.recordTable} 不存在`, path: ['steps', i, 'recordTable'] })
      if (s.dataTable && !tables.has(s.dataTable))
        ctx.addIssue({ code: 'custom', message: `数据表 ${s.dataTable} 不存在`, path: ['steps', i, 'dataTable'] })
    })
    p.dataTables.forEach((table, i) => {
      const dependencies = new Map<string, string[]>()
      table.columns.forEach((column, j) => {
        if (column.measurePoint && !points.has(column.measurePoint))
          ctx.addIssue({
            code: 'custom',
            message: `测量点 ${column.measurePoint} 不存在`,
            path: ['dataTables', i, 'columns', j, 'measurePoint'],
          })
        column.captureSteps?.forEach((step, index) => {
          if (!steps.has(step))
            ctx.addIssue({
              code: 'custom',
              message: `步骤 ${step} 不存在`,
              path: ['dataTables', i, 'columns', j, 'captureSteps', index],
            })
        })
        if (column.captureSteps && !column.measurePoint)
          ctx.addIssue({
            code: 'custom',
            message: 'captureSteps 需要绑定测量点',
            path: ['dataTables', i, 'columns', j, 'captureSteps'],
          })
        if (column.computed) {
          try {
            const referenced = formulaColumns(column.computed)
            dependencies.set(column.id, referenced)
            for (const id of referenced)
              if (!tables.get(table.id)?.has(id))
                ctx.addIssue({
                  code: 'custom',
                  message: `计算列引用了不存在的列 ${id}`,
                  path: ['dataTables', i, 'columns', j, 'computed'],
                })
          } catch (error) {
            ctx.addIssue({
              code: 'custom',
              message: error instanceof Error ? error.message : '计算公式无效',
              path: ['dataTables', i, 'columns', j, 'computed'],
            })
          }
          if (column.measurePoint)
            ctx.addIssue({
              code: 'custom',
              message: '计算列不能同时绑定测量点',
              path: ['dataTables', i, 'columns', j, 'computed'],
            })
        }
      })
      function cyclic(id: string, visiting = new Set<string>()): boolean {
        if (visiting.has(id)) return true
        const next = new Set(visiting).add(id)
        return (dependencies.get(id) ?? []).some((reference) => cyclic(reference, next))
      }
      table.columns.forEach((column, index) => {
        if (column.computed && cyclic(column.id))
          ctx.addIssue({
            code: 'custom',
            message: '计算列存在循环引用',
            path: ['dataTables', i, 'columns', index, 'computed'],
          })
      })
      table.sanity?.forEach((rule, j) => {
        if (!tables.get(table.id)?.has(rule.column))
          ctx.addIssue({
            code: 'custom',
            message: `列 ${rule.column} 不存在`,
            path: ['dataTables', i, 'sanity', j, 'column'],
          })
      })
    })
    p.charts.forEach((c, i) => {
      const cols = tables.get(c.table)
      if (!cols) {
        ctx.addIssue({ code: 'custom', message: `数据表 ${c.table} 不存在`, path: ['charts', i, 'table'] })
        return
      }
      if (!cols.has(c.x)) ctx.addIssue({ code: 'custom', message: `列 ${c.x} 不存在`, path: ['charts', i, 'x'] })
      c.y.forEach((col, k) => {
        if (!cols.has(col)) ctx.addIssue({ code: 'custom', message: `列 ${col} 不存在`, path: ['charts', i, 'y', k] })
      })
    })
  })

export type Project = z.infer<typeof Project>
export type FaultDef = z.infer<typeof FaultDef>
export type MeasurePoint = z.infer<typeof MeasurePoint>
export type Step = z.infer<typeof Step>
export type DataTable = z.infer<typeof DataTable>
