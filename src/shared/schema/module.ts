import { z } from 'zod'
import { ContentId, Jack, JackId, ParamName, uniqueBy } from './common.ts'

// 技术设计 §3.1
export const ModuleControl = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['pot', 'switch', 'rotary', 'resistorBox']),
    param: ParamName,
    range: z.tuple([z.number(), z.number()]).optional(),
    steps: z.array(z.number()).min(2).optional(),
    unit: z.string(),
    default: z.number(),
  })
  .superRefine((c, ctx) => {
    if (!c.range && !c.steps) ctx.addIssue({ code: 'custom', message: '需要 range 或 steps', path: ['range'] })
    if (c.range) {
      const [lo, hi] = c.range
      if (lo >= hi) ctx.addIssue({ code: 'custom', message: 'range 下限应小于上限', path: ['range'] })
      if (c.default < lo || c.default > hi)
        ctx.addIssue({ code: 'custom', message: 'default 不在 range 内', path: ['default'] })
    }
    if (c.steps && !c.steps.includes(c.default))
      ctx.addIssue({ code: 'custom', message: 'default 不在 steps 中', path: ['default'] })
  })

export const ModuleIndicator = z.object({
  id: z.string().min(1),
  kind: z.enum(['led', 'lamp', 'segment7', 'motor', 'speaker']),
  probe: z.string().min(1),
})

export const Module = z
  .object({
    id: ContentId,
    name: z.string().min(1),
    // 挂箱挂在控制屏凹槽，实验板装在挂箱实验板位或台面（原型选型说明 §3）
    form: z.enum(['box', 'board']),
    model: z.string().min(1),
    netlist: z.string().min(1),
    jacks: z.array(Jack).min(1).superRefine(uniqueBy('id')),
    controls: z.array(ModuleControl).superRefine(uniqueBy('id')).default([]),
    indicators: z.array(ModuleIndicator).superRefine(uniqueBy('id')).default([]),
    // jumper：短接帽，始终接通；currentSocket：电流插座，常闭，两端都插上导线（插入电流插头）时断开
    // 板上同一铜箔网络的插孔组（如 U1- 与 E），接线检查按同一节点处理
    commonNets: z.array(z.array(JackId).min(2)).optional(),
    internalJumpers: z
      .array(
        z.object({
          id: z.string().min(1),
          kind: z.enum(['jumper', 'currentSocket']).default('jumper'),
          a: JackId,
          b: JackId,
        }),
      )
      .optional(),
  })
  .superRefine((m, ctx) => {
    const ids = new Set(m.jacks.map((j) => j.id))
    m.commonNets?.forEach((net, i) => {
      net.forEach((jack, k) => {
        if (!ids.has(jack)) ctx.addIssue({ code: 'custom', message: `插孔 ${jack} 不存在`, path: ['commonNets', i, k] })
      })
    })
    m.internalJumpers?.forEach((jp, i) => {
      for (const end of ['a', 'b'] as const)
        if (!ids.has(jp[end]))
          ctx.addIssue({ code: 'custom', message: `插孔 ${jp[end]} 不存在`, path: ['internalJumpers', i, end] })
    })
  })

export type Module = z.infer<typeof Module>
