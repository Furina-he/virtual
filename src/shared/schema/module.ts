import { z } from 'zod'
import { ContentId, Jack, JackId, ParamName, uniqueBy } from './common.ts'

// 技术设计 §3.1
export const ModuleControl = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    kind: z.enum(['pot', 'switch', 'rotary', 'resistorBox']),
    param: ParamName,
    range: z.tuple([z.number(), z.number()]).optional(),
    steps: z.array(z.number()).min(2).optional(),
    step: z.number().positive().optional(),
    stepLabels: z.array(z.string().min(1)).optional(),
    targets: z
      .array(
        z.object({
          element: z.string().regex(/^[Rr][A-Za-z0-9_]*$/),
          scale: z.number().finite().optional(),
          offset: z.number().finite().optional(),
          min: z.number().positive().optional(),
          values: z.array(z.number().positive()).optional(),
        }),
      )
      .min(1)
      .optional(),
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
    if (c.step && !c.range) ctx.addIssue({ code: 'custom', message: 'step 需要 range', path: ['step'] })
    if (c.steps && new Set(c.steps).size !== c.steps.length)
      ctx.addIssue({ code: 'custom', message: '档位值不能重复', path: ['steps'] })
    if (c.stepLabels && (!c.steps || c.stepLabels.length !== c.steps.length))
      ctx.addIssue({ code: 'custom', message: 'stepLabels 必须与 steps 一一对应', path: ['stepLabels'] })
    c.targets?.forEach((target, index) => {
      if (target.values && (!c.steps || target.values.length !== c.steps.length))
        ctx.addIssue({
          code: 'custom',
          message: '电阻目标 values 必须与控件 steps 一一对应',
          path: ['targets', index, 'values'],
        })
      if (target.values && (target.scale !== undefined || target.offset !== undefined || target.min !== undefined))
        ctx.addIssue({ code: 'custom', message: '电阻档位映射不能混用线性换算', path: ['targets', index] })
    })
  })

export const ModuleIndicator = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.enum(['led', 'lamp', 'segment7', 'motor']),
    probe: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('speaker'),
    between: z.tuple([JackId, JackId]),
    audio: z.object({ fullScale: z.number().positive() }),
  }),
])

export const ModuleSimulation = z.object({
  analysis: z.literal('tran'),
  maxStep: z.number().positive(),
  pacing: z.enum(['realtime', 'window']).optional(),
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
    simulation: ModuleSimulation.optional(),
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
    const parameters = new Set<string>()
    const targetElements = new Set<string>()
    m.controls.forEach((control, index) => {
      if (parameters.has(control.param.toLowerCase()))
        ctx.addIssue({ code: 'custom', message: `控件参数 ${control.param} 重复`, path: ['controls', index, 'param'] })
      parameters.add(control.param.toLowerCase())
      for (const target of control.targets ?? []) {
        const name = target.element.toLowerCase()
        if (targetElements.has(name))
          ctx.addIssue({
            code: 'custom',
            message: `电阻目标 ${target.element} 被多个控件重复声明`,
            path: ['controls', index, 'targets'],
          })
        targetElements.add(name)
      }
    })
    m.indicators.forEach((indicator, index) => {
      if (indicator.kind !== 'speaker') return
      indicator.between.forEach((jack, end) => {
        if (!ids.has(jack))
          ctx.addIssue({
            code: 'custom',
            message: `扬声器插孔 ${jack} 不存在`,
            path: ['indicators', index, 'between', end],
          })
      })
      if (indicator.between[0] === indicator.between[1])
        ctx.addIssue({ code: 'custom', message: '扬声器测量两端不能相同', path: ['indicators', index, 'between'] })
    })
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
export type ModuleControl = z.infer<typeof ModuleControl>
export type ModuleIndicator = z.infer<typeof ModuleIndicator>
