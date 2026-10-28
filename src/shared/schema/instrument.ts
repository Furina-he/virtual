import { z } from 'zod'
import { ContentId, Jack, JackId, uniqueBy } from './common.ts'

// 技术设计 §3.2
export const InstrumentMode = z.enum(['dcv', 'acv', 'dca', 'aca', 'ohm', 'diode', 'continuity'])

export const InstrumentAccuracy = z.object({
  percentReading: z.number().nonnegative().optional(),
  percentFullScale: z.number().nonnegative().optional(),
  digits: z.number().int().nonnegative().optional(),
})

export const InstrumentRange = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  mode: InstrumentMode.optional(),
  // full / resolution 始终是 SI 值；displayUnit 只控制读数显示，不改变电路参数。
  full: z.number().positive(),
  unit: z.string().min(1),
  displayUnit: z.enum(['V', 'mV', 'A', 'mA', 'uA', 'Ω', 'kΩ', 'MΩ']).optional(),
  internalR: z.number().positive().optional(),
  resolution: z.number().positive(),
  positiveJack: JackId.optional(),
  negativeJack: JackId.optional(),
  accuracy: InstrumentAccuracy.optional(),
  // 电阻/二极管/通断档的内置电池测试源，电压、电流及安全阈值均用 SI 单位。
  testSource: z
    .object({
      voltage: z.number().positive(),
      current: z.number().positive(),
      safetyVoltage: z.number().positive(),
      continuityThreshold: z.number().positive().optional(),
    })
    .optional(),
})

export const Instrument = z
  .object({
    id: ContentId,
    name: z.string().min(1),
    kind: z.enum([
      'dcv',
      'dca',
      'acv',
      'aca',
      'multimeter',
      'dcSupply',
      'funcGen',
      'scope',
      'wattmeter',
      'acMillivolt',
      'galvanometer',
    ]),
    // fixed：按原型固定在控制屏上，随实训台出现，只露出插孔供学员接外部线；
    // desktop：放在仪表柜，学员按任务选取放到桌面（原型选型说明 Q-A）
    mounting: z.enum(['fixed', 'desktop']),
    // fixed 类在控制屏上的安装位，同时用作实例 ID 来源
    fixedSlot: z
      .string()
      .regex(/^SLOT_[A-Z0-9_]+$/)
      .optional(),
    model: z.string().min(1),
    jacks: z.array(Jack).min(1).superRefine(uniqueBy('id')),
    ranges: z.array(InstrumentRange).superRefine(uniqueBy('id')).default([]),
    defaultRange: z.string().min(1).optional(),
    internalROptions: z.array(z.number().positive()).min(1).optional(),
    // Implemented settings, distinct from the asset's complete physical control inventory.
    settingsControls: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
          anchor: z.string().regex(/^(KNOB|SW)_[A-Z0-9_]+$/),
          label: z.string().min(1),
          unit: z.string().min(1),
          min: z.number(),
          max: z.number(),
          step: z.number().positive(),
          default: z.number(),
        }),
      )
      .superRefine(uniqueBy('id'))
      .optional(),
    accuracyClass: z.number().positive().optional(),
    // 等效电路模板（网表行）。占位符：{J:插孔ID} 节点，{X} 实例后缀，{R} 当前档位内阻，{S:设置名=默认值} 设置值
    spiceTemplate: z.string().min(1),
    // 接线检查用（技术设计 §6）。有 measure 的是测量仪表，拓扑比对时去掉：
    // voltage 为电压测量端（正, 负），按开路处理；series 为串入端，按短路处理
    measure: z
      .object({
        voltage: z.array(z.tuple([JackId, JackId])).default([]),
        series: z.array(z.tuple([JackId, JackId])).default([]),
      })
      .optional(),
    // 电源输出端（正, 负），用于危险接法检测
    outputs: z.array(z.tuple([JackId, JackId])).optional(),
  })
  .superRefine((ins, ctx) => {
    const ids = new Set(ins.jacks.map((j) => j.id))
    if (ins.defaultRange && !ins.ranges.some((range) => range.id === ins.defaultRange))
      ctx.addIssue({ code: 'custom', message: '默认量程不存在', path: ['defaultRange'] })
    ins.ranges.forEach((range, i) => {
      const mode = range.mode ?? ins.kind
      const units =
        mode === 'dcv' || mode === 'acv' || mode === 'diode'
          ? ['V', 'mV']
          : mode === 'dca' || mode === 'aca'
            ? ['A', 'mA', 'uA']
            : mode === 'ohm' || mode === 'continuity'
              ? ['Ω', 'kΩ', 'MΩ']
              : undefined
      if (units && range.unit !== units[0])
        ctx.addIssue({ code: 'custom', message: '量程和分辨率必须使用该模式的 SI 单位', path: ['ranges', i, 'unit'] })
      if (units && range.displayUnit && !units.includes(range.displayUnit))
        ctx.addIssue({ code: 'custom', message: '显示单位与测量模式不符', path: ['ranges', i, 'displayUnit'] })
      if (ins.kind !== 'multimeter' && range.mode && range.mode !== ins.kind)
        ctx.addIssue({ code: 'custom', message: '固定功能仪表的档位模式与种类不符', path: ['ranges', i, 'mode'] })
      for (const field of ['positiveJack', 'negativeJack'] as const)
        if (range[field] && !ids.has(range[field]))
          ctx.addIssue({ code: 'custom', message: `插孔 ${range[field]} 不存在`, path: ['ranges', i, field] })
      if (range.resolution >= range.full)
        ctx.addIssue({ code: 'custom', message: '分辨率必须小于量程', path: ['ranges', i, 'resolution'] })
      if (range.positiveJack && range.positiveJack === range.negativeJack)
        ctx.addIssue({ code: 'custom', message: '测量正负插孔不能相同', path: ['ranges', i, 'negativeJack'] })
      if (ins.kind === 'multimeter' && (!range.mode || !range.positiveJack || !range.negativeJack))
        ctx.addIssue({ code: 'custom', message: '万用表档位需要模式和正负测量插孔', path: ['ranges', i] })
      if (range.mode === 'ohm' || range.mode === 'diode' || range.mode === 'continuity') {
        if (!range.testSource)
          ctx.addIssue({ code: 'custom', message: '该档位需要限压限流测试源', path: ['ranges', i, 'testSource'] })
        if (range.mode === 'continuity' && range.testSource?.continuityThreshold === undefined)
          ctx.addIssue({ code: 'custom', message: '通断档需要蜂鸣阈值', path: ['ranges', i, 'testSource'] })
      }
    })
    ins.settingsControls?.forEach((control, i) => {
      if (control.min >= control.max || control.default < control.min || control.default > control.max)
        ctx.addIssue({ code: 'custom', message: '控件范围或默认值无效', path: ['settingsControls', i] })
    })
    const pairs: [string, [string, string][] | undefined][] = [
      ['measure.voltage', ins.measure?.voltage],
      ['measure.series', ins.measure?.series],
      ['outputs', ins.outputs],
    ]
    for (const [field, list] of pairs)
      list?.forEach((pair, i) => {
        pair.forEach((jack, k) => {
          if (!ids.has(jack))
            ctx.addIssue({ code: 'custom', message: `插孔 ${jack} 不存在`, path: [...field.split('.'), i, k] })
        })
      })
    if (ins.mounting === 'fixed' && !ins.fixedSlot)
      ctx.addIssue({ code: 'custom', message: '固定在控制屏上的仪表需要 fixedSlot', path: ['fixedSlot'] })
    if (ins.mounting === 'desktop' && ins.fixedSlot)
      ctx.addIssue({ code: 'custom', message: '台式仪表不应有 fixedSlot', path: ['fixedSlot'] })
  })

export type Instrument = z.infer<typeof Instrument>
export type InstrumentRange = z.infer<typeof InstrumentRange>
export type InstrumentMode = z.infer<typeof InstrumentMode>
export type InstrumentAccuracy = z.infer<typeof InstrumentAccuracy>
