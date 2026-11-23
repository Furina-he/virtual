import { z } from 'zod'
import { ContentId, Jack, JackId, uniqueBy } from './common.ts'

// 技术设计 §3.2
export const InstrumentMode = z.enum(['dcv', 'acv', 'dca', 'aca', 'ohm', 'diode', 'continuity', 'power'])

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
  displayUnit: z.enum(['V', 'mV', 'A', 'mA', 'uA', 'Ω', 'kΩ', 'MΩ', 'W', 'var', 'VA']).optional(),
  internalR: z.number().positive().optional(),
  inputC: z.number().positive().optional(),
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

export const InputChannel = z.object({
  id: JackId,
  label: z.string().min(1),
  positiveJack: JackId,
  negativeJack: JackId,
})

export const WattmeterConfig = z.object({
  voltageJacks: z.tuple([JackId, JackId]),
  currentJacks: z.tuple([JackId, JackId]),
  maxVoltage: z.number().positive(),
  maxCurrent: z.number().positive(),
  voltageR: z.number().positive(),
  currentR: z.number().positive(),
})

// 函数信号发生器与示波器内置信号源（INS-08/10）。幅值为峰峰值，占空比为百分数，均为 SI 单位。
export const SignalWaveform = z.enum(['sine', 'square', 'triangle', 'sawtooth', 'ttl'])
const Bounded = z
  .object({ min: z.number(), max: z.number(), default: z.number() })
  .refine((v) => v.min < v.max && v.default >= v.min && v.default <= v.max, '范围或默认值无效')

export const SignalSource = z.object({
  id: JackId,
  label: z.string().min(1),
  positiveJack: JackId,
  negativeJack: JackId,
  outputR: z.number().positive(),
  waveforms: z.array(SignalWaveform).min(1),
  // 跟随另一路的频率与占空比（如 TTL 同步输出），自身不提供频率设置
  syncTo: JackId.optional(),
  frequency: Bounded.optional(),
  amplitude: Bounded.optional(),
  offset: Bounded.optional(),
  duty: Bounded.optional(),
  ttlHigh: z.number().positive().default(5),
})

export const ScopeConfig = z.object({
  channels: z
    .array(z.object({ id: JackId, label: z.string().min(1), positiveJack: JackId, negativeJack: JackId }))
    .min(1)
    .superRefine(uniqueBy('id')),
  voltsPerDiv: z.array(z.number().positive()).min(1),
  secondsPerDiv: z.array(z.number().positive()).min(1),
  defaultVoltsPerDiv: z.number().positive(),
  defaultSecondsPerDiv: z.number().positive(),
  divisions: z.object({ x: z.number().int().positive(), y: z.number().int().positive() }),
  // 每屏采样点数上限，决定仿真步长下限（技术设计 §7）
  pointsPerScreen: z.number().int().positive().default(1000),
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
    signalSources: z.array(SignalSource).superRefine(uniqueBy('id')).optional(),
    scope: ScopeConfig.optional(),
    inputChannels: z.array(InputChannel).min(1).superRefine(uniqueBy('id')).optional(),
    wattmeter: WattmeterConfig.optional(),
  })
  .superRefine((ins, ctx) => {
    const ids = new Set(ins.jacks.map((j) => j.id))
    const kindMode: Partial<Record<typeof ins.kind, z.infer<typeof InstrumentMode>>> = {
      dcv: 'dcv',
      acv: 'acv',
      dca: 'dca',
      aca: 'aca',
      acMillivolt: 'acv',
      galvanometer: 'dca',
      wattmeter: 'power',
    }
    if (ins.defaultRange && !ins.ranges.some((range) => range.id === ins.defaultRange))
      ctx.addIssue({ code: 'custom', message: '默认量程不存在', path: ['defaultRange'] })
    ins.ranges.forEach((range, i) => {
      const mode = range.mode ?? kindMode[ins.kind]
      const units =
        mode === 'dcv' || mode === 'acv' || mode === 'diode'
          ? ['V', 'mV']
          : mode === 'dca' || mode === 'aca'
            ? ['A', 'mA', 'uA']
            : mode === 'ohm' || mode === 'continuity'
              ? ['Ω', 'kΩ', 'MΩ']
              : mode === 'power'
                ? ['W', 'VA', 'var']
                : undefined
      if (units && range.unit !== units[0])
        ctx.addIssue({ code: 'custom', message: '量程和分辨率必须使用该模式的 SI 单位', path: ['ranges', i, 'unit'] })
      if (units && range.displayUnit && !units.includes(range.displayUnit))
        ctx.addIssue({ code: 'custom', message: '显示单位与测量模式不符', path: ['ranges', i, 'displayUnit'] })
      if (ins.kind !== 'multimeter' && range.mode && range.mode !== kindMode[ins.kind])
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
    ins.signalSources?.forEach((source, i) => {
      for (const field of ['positiveJack', 'negativeJack'] as const)
        if (!ids.has(source[field]))
          ctx.addIssue({ code: 'custom', message: `插孔 ${source[field]} 不存在`, path: ['signalSources', i, field] })
      const master = source.syncTo ? ins.signalSources?.find((entry) => entry.id === source.syncTo) : undefined
      if (source.syncTo && (!master || master.syncTo))
        ctx.addIssue({
          code: 'custom',
          message: '同步输出必须跟随一路独立信号源',
          path: ['signalSources', i, 'syncTo'],
        })
      if (!source.syncTo && !source.frequency)
        ctx.addIssue({ code: 'custom', message: '独立信号源需要频率范围', path: ['signalSources', i, 'frequency'] })
      if (source.frequency && source.frequency.min <= 0)
        ctx.addIssue({ code: 'custom', message: '频率必须为正', path: ['signalSources', i, 'frequency'] })
      if (source.duty && (source.duty.min <= 0 || source.duty.max >= 100))
        ctx.addIssue({ code: 'custom', message: '占空比必须在 0~100% 之间', path: ['signalSources', i, 'duty'] })
      if (source.waveforms.some((wave) => wave !== 'ttl') && !source.amplitude)
        ctx.addIssue({ code: 'custom', message: '模拟波形需要幅值范围', path: ['signalSources', i, 'amplitude'] })
    })
    if (ins.scope) {
      const { channels, voltsPerDiv, secondsPerDiv, defaultVoltsPerDiv, defaultSecondsPerDiv } = ins.scope
      channels.forEach((channel, i) => {
        for (const field of ['positiveJack', 'negativeJack'] as const)
          if (!ids.has(channel[field]))
            ctx.addIssue({
              code: 'custom',
              message: `插孔 ${channel[field]} 不存在`,
              path: ['scope', 'channels', i, field],
            })
      })
      if (!voltsPerDiv.includes(defaultVoltsPerDiv))
        ctx.addIssue({ code: 'custom', message: '默认 V/div 不在档位表中', path: ['scope', 'defaultVoltsPerDiv'] })
      if (!secondsPerDiv.includes(defaultSecondsPerDiv))
        ctx.addIssue({ code: 'custom', message: '默认 s/div 不在档位表中', path: ['scope', 'defaultSecondsPerDiv'] })
    }
    ins.inputChannels?.forEach((channel, i) => {
      for (const field of ['positiveJack', 'negativeJack'] as const)
        if (!ids.has(channel[field]))
          ctx.addIssue({
            code: 'custom',
            message: `插孔 ${channel[field]} 不存在`,
            path: ['inputChannels', i, field],
          })
      if (channel.positiveJack === channel.negativeJack)
        ctx.addIssue({
          code: 'custom',
          message: '输入通道正负插孔不能相同',
          path: ['inputChannels', i, 'negativeJack'],
        })
    })
    if (ins.kind === 'wattmeter' && !ins.wattmeter)
      ctx.addIssue({ code: 'custom', message: '功率表缺少 wattmeter 回路配置', path: ['wattmeter'] })
    if (ins.wattmeter) {
      const all = [...ins.wattmeter.voltageJacks, ...ins.wattmeter.currentJacks]
      for (const [field, pair] of [
        ['voltageJacks', ins.wattmeter.voltageJacks],
        ['currentJacks', ins.wattmeter.currentJacks],
      ] as const) {
        pair.forEach((jack, k) => {
          if (!ids.has(jack))
            ctx.addIssue({ code: 'custom', message: `插孔 ${jack} 不存在`, path: ['wattmeter', field, k] })
        })
      }
      if (new Set(all).size !== 4)
        ctx.addIssue({ code: 'custom', message: '功率表电压与电流回路的 4 个插孔必须互不相同', path: ['wattmeter'] })
    }
    if (ins.mounting === 'fixed' && !ins.fixedSlot)
      ctx.addIssue({ code: 'custom', message: '固定在控制屏上的仪表需要 fixedSlot', path: ['fixedSlot'] })
    if (ins.mounting === 'desktop' && ins.fixedSlot)
      ctx.addIssue({ code: 'custom', message: '台式仪表不应有 fixedSlot', path: ['fixedSlot'] })
  })

export type Instrument = z.infer<typeof Instrument>
export type SignalSource = z.infer<typeof SignalSource>
export type SignalWaveform = z.infer<typeof SignalWaveform>
export type ScopeConfig = z.infer<typeof ScopeConfig>
export type InputChannel = z.infer<typeof InputChannel>
export type WattmeterConfig = z.infer<typeof WattmeterConfig>
export type InstrumentRange = z.infer<typeof InstrumentRange>
export type InstrumentMode = z.infer<typeof InstrumentMode>
export type InstrumentAccuracy = z.infer<typeof InstrumentAccuracy>
