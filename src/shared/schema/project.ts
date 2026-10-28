import { z } from 'zod'
import { ContentId, InstanceId, JackRef, uniqueBy } from './common.ts'

// 技术设计 §3.3
export const ProjectId = z.string().regex(/^(DG|MD|SD)-\d{2}$/, '项目编号格式应为 DG-01 / MD-01 / SD-01')
const SlotId = z.string().regex(/^SLOT_[A-Z0-9_]+$/, '格式应为 SLOT_<大写ID>')

export const MeasurePoint = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['voltage', 'current', 'waveform']),
    between: z.tuple([JackRef, JackRef]).optional(),
    // 电流测量所在支路：串入电流表时断开的两个插孔
    branch: z.tuple([JackRef, JackRef]).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.kind === 'current' && !p.branch)
      ctx.addIssue({ code: 'custom', message: '电流测量点需要 branch', path: ['branch'] })
    if (p.kind !== 'current' && !p.between)
      ctx.addIssue({ code: 'custom', message: '电压/波形测量点需要 between', path: ['between'] })
  })

// 步骤完成条件：某测量点读数落在区间内
export const Expectation = z.object({
  measurePoint: z.string().min(1),
  min: z.number(),
  max: z.number(),
})

export const Column = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  unit: z.string().optional(),
  // 绑定测量点后可用"记录当前读数"（TSK-03）
  measurePoint: z.string().optional(),
  computed: z.string().optional(),
})

// 明显不合理数据的提示（TSK-03）
export const SanityRule = z.object({
  column: z.string().min(1),
  min: z.number().optional(),
  max: z.number().optional(),
  message: z.string().min(1),
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

export const Step = z.object({ id: z.string().min(1), text: z.string().min(1), expect: Expectation.optional() })

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
    const owner = new Map<string, number>()
    p.reference.nets.forEach((net, i) => {
      net.forEach((ref, j) => {
        const prev = owner.get(ref)
        if (prev !== undefined)
          ctx.addIssue({
            code: 'custom',
            message: `插孔 ${ref} 同时出现在网络 ${prev} 和 ${i}`,
            path: ['reference', 'nets', i, j],
          })
        owner.set(ref, i)
      })
    })
    const points = new Set(p.reference.measurePoints.map((m) => m.id))
    p.steps.forEach((s, i) => {
      if (s.expect && !points.has(s.expect.measurePoint))
        ctx.addIssue({
          code: 'custom',
          message: `测量点 ${s.expect.measurePoint} 不存在`,
          path: ['steps', i, 'expect', 'measurePoint'],
        })
    })
    const tables = new Map(p.dataTables.map((t) => [t.id, new Set(t.columns.map((c) => c.id))]))
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
