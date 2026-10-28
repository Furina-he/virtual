import type { FaultDef, Instrument, Module } from '../../shared/schema/index.ts'
import {
  getRangeSettings,
  InstrumentConfigurationError,
  instrumentTemplate,
  isMeasurementInstrument,
  resolveInstrument,
} from '../instruments/index.ts'
import { AssembleError } from './errors.ts'
import { injectFault } from './fault.ts'
import { UnionFind } from './union-find.ts'

// 技术设计 §5.2。纯函数：调用方负责读取 module.cir 等文件。

export type ModuleInput = { instanceId: string; module: Module; subckt: string }
export type InstrumentInput = { instanceId: string; instrument: Instrument; settings: Record<string, unknown> }

export type AssembleInput = {
  title: string
  modules: ModuleInput[]
  instruments: InstrumentInput[]
  wires: { a: string; b: string }[]
  /** "<实例ID>.<控件ID>" → 值 */
  controlValues: Record<string, number>
  /** 接地插孔：所在网络为节点 0 */
  ground?: string
  fault?: FaultDef
  /** 分析与控制语句，如 [".op"] */
  analysis: string[]
}

export type AssembleOutput = {
  netlist: string
  /** 插孔全局 ID → 节点名 */
  nodeOf: Record<string, string>
  /** 网络划分：每组为同一节点上的插孔（已排序），供拓扑比对 */
  nets: string[][]
  /** 仪表实例 ID → 模板中 {X} 的取值，用于拼探针向量名 */
  instrumentSuffix: Record<string, string>
}

const LEAK_R = '1T'

/** 实例 ID 转网表安全名：连字符换成下划线 */
export const spiceSafe = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_')

function parseSubckt(text: string): { name: string; ports: string[]; params: string[] } {
  const header = text.split('\n').find((l) => /^\s*\.subckt\s/i.test(l))
  if (!header) throw new AssembleError('content', '子电路缺少 .subckt 行')
  const [head = '', paramPart = ''] = header.trim().split(/\s+params:\s*/i)
  const [, name = '', ...ports] = head.split(/\s+/)
  const params = [...paramPart.matchAll(/([A-Za-z_]\w*)\s*=/g)].map((m) => m[1] as string)
  return { name, ports, params }
}

function expandTemplate(ins: InstrumentInput, suffix: string, nodeOf: (jack: string) => string): string {
  const { instrument, settings } = ins
  let template = instrument.spiceTemplate
  let range: ReturnType<typeof getRangeSettings> | undefined
  try {
    if (instrument.ranges.length) range = getRangeSettings(instrument, settings)
    if (isMeasurementInstrument(instrument)) template = instrumentTemplate(resolveInstrument(instrument, settings))
  } catch (error) {
    if (error instanceof InstrumentConfigurationError) throw new AssembleError('content', error.message)
    throw error
  }
  return template.replace(/\{([A-Z]):?([^}]*)\}/g, (whole, tag: string, arg: string) => {
    switch (tag) {
      case 'X':
        return suffix
      case 'J': {
        if (!instrument.jacks.some((j) => j.id === arg))
          throw new AssembleError('content', `${instrument.id} 模板引用了不存在的插孔 ${arg}`)
        return nodeOf(`${ins.instanceId}.${arg}`)
      }
      case 'R':
        if (range?.internalR === undefined)
          throw new AssembleError('content', `${instrument.id} 档位 ${range?.range.id} 没有内阻`)
        return String(range.internalR)
      case 'S': {
        const [key = '', fallback] = arg.split('=')
        const control = instrument.settingsControls?.find((candidate) => candidate.id === key)
        const v = settings[key] ?? control?.default ?? (fallback === undefined ? undefined : Number(fallback))
        if (v === undefined) throw new AssembleError('content', `${instrument.id} 缺少设置 ${key}`)
        if (typeof v !== 'number' || !Number.isFinite(v))
          throw new AssembleError('content', `${instrument.id} 设置 ${key} 不是有限数值`)
        if (control && (v < control.min || v > control.max))
          throw new AssembleError('content', `${instrument.id} 设置 ${key} 超出允许范围`)
        return String(v)
      }
      default:
        throw new AssembleError('content', `${instrument.id} 模板占位符无法识别：${whole}`)
    }
  })
}

export function assembleNetlist(input: AssembleInput): AssembleOutput {
  const uf = new UnionFind<string>()
  const jackOwners = new Map<string, Set<string>>()
  const register = (instanceId: string, jackIds: string[]) => {
    if (jackOwners.has(instanceId)) throw new AssembleError('content', `实例 ID 重复：${instanceId}`)
    jackOwners.set(instanceId, new Set(jackIds))
    for (const j of jackIds) uf.add(`${instanceId}.${j}`)
  }
  for (const m of input.modules)
    register(
      m.instanceId,
      m.module.jacks.map((j) => j.id),
    )
  for (const i of input.instruments)
    register(
      i.instanceId,
      i.instrument.jacks.map((j) => j.id),
    )

  const checkRef = (ref: string) => {
    const [inst = '', jack = ''] = ref.split('.')
    if (!jackOwners.get(inst)?.has(jack)) throw new AssembleError('wiring', `导线连到了不存在的插孔 ${ref}`)
  }
  const wired = new Set<string>()
  for (const w of input.wires) {
    checkRef(w.a)
    checkRef(w.b)
    wired.add(w.a)
    wired.add(w.b)
    uf.union(w.a, w.b)
  }
  // 短接帽始终接通；电流插座两端都插了导线（插入电流插头）时断开
  for (const m of input.modules)
    for (const jp of m.module.internalJumpers ?? []) {
      const a = `${m.instanceId}.${jp.a}`
      const b = `${m.instanceId}.${jp.b}`
      if (jp.kind === 'currentSocket' && wired.has(a) && wired.has(b)) continue
      uf.union(a, b)
    }

  if (input.ground) checkRef(input.ground)
  const groundRoot = input.ground ? uf.find(input.ground) : undefined

  // 节点命名与网络划分：按组内最小插孔 ID 排序，保证等效接法得到相同结果
  const nets = uf
    .groups()
    .map((g) => [...g].sort())
    .sort((x, y) => ((x[0] ?? '') < (y[0] ?? '') ? -1 : 1))
  const nodeOf: Record<string, string> = {}
  nets.forEach((net, i) => {
    const isGround = groundRoot !== undefined && uf.find(net[0] as string) === groundRoot
    for (const ref of net) nodeOf[ref] = isGround ? '0' : `n${i + 1}`
  })
  const node = (ref: string) => nodeOf[ref] as string

  const out: string[] = [`* ${input.title}`]
  const params: string[] = []
  const instances: string[] = []
  const subckts = new Map<string, string>()
  const [faultInst, ...faultRest] = input.fault ? input.fault.target.split('.') : []

  for (const m of input.modules) {
    const { name, ports, params: subParams } = parseSubckt(m.subckt)
    const jackIds = m.module.jacks.map((j) => j.id)
    if (ports.join(' ') !== jackIds.join(' '))
      throw new AssembleError('content', `${m.module.id} 子电路端口与 jacks 顺序不一致`)
    let subName = name
    let text = m.subckt
    if (input.fault && faultInst === m.instanceId) {
      subName = `${name}__${spiceSafe(m.instanceId)}`
      text = injectFault(text, faultRest.join('.'), input.fault).replace(
        new RegExp(`(\\.(subckt|ends)\\s+)${name}\\b`, 'gi'),
        `$1${subName}`,
      )
    }
    subckts.set(subName, text)
    const safe = spiceSafe(m.instanceId)
    const assigns: string[] = []
    for (const c of m.module.controls) {
      if (!subParams.includes(c.param))
        throw new AssembleError('content', `${m.module.id} 子电路没有参数 ${c.param}（控件 ${c.id}）`)
      const value = input.controlValues[`${m.instanceId}.${c.id}`] ?? c.default
      // 全局参数便于运行中 alterparam（ADR-009）
      const global = `p_${safe}_${c.param}`
      params.push(`.param ${global}=${value}`)
      assigns.push(`${c.param}={${global}}`)
    }
    const portNodes = jackIds.map((j) => node(`${m.instanceId}.${j}`))
    instances.push(`X${safe} ${portNodes.join(' ')} ${subName}${assigns.length ? ` ${assigns.join(' ')}` : ''}`)
  }

  const instrumentSuffix: Record<string, string> = {}
  const instrumentLines: string[] = []
  for (const i of input.instruments) {
    // 没接线的仪表不进网表
    if (!i.instrument.jacks.some((j) => wired.has(`${i.instanceId}.${j.id}`))) continue
    const suffix = spiceSafe(i.instanceId)
    instrumentSuffix[i.instanceId] = suffix
    instrumentLines.push(`* 仪表 ${i.instanceId}`, expandTemplate(i, suffix, node))
  }

  // 每个非地节点 1 TΩ 对地泄放（第 4 步）。ngspice 遇浮空节点不报错而给出无意义结果，此步必做
  const leaks = [...new Set(Object.values(nodeOf))].filter((n) => n !== '0').map((n) => `Rleak_${n} ${n} 0 ${LEAK_R}`)

  out.push(...subckts.values(), ...params, ...instances, ...instrumentLines, ...leaks, ...input.analysis, '.end')
  return { netlist: out.join('\n'), nodeOf, nets, instrumentSuffix }
}
