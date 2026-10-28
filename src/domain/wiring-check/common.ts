import type { Instrument, Module } from '../../shared/schema/index.ts'
import { UnionFind } from '../circuit/union-find.ts'

// 接线检查的公共输入与工具（技术设计 §6）

export type CheckInput = {
  modules: { instanceId: string; module: Module }[]
  /** 台面上的全部仪表：固定在控制屏上的与学员放置的 */
  instruments: { instanceId: string; instrument: Instrument }[]
  wires: { a: string; b: string }[]
}

export type WiringIssue = {
  severity: 'error' | 'warning'
  code:
    | 'missing-connection'
    | 'extra-connection'
    | 'measure-missing'
    | 'measure-polarity'
    | 'ammeter-across-source'
    | 'source-short'
  /** 面向学员的中文提示（PRD 15.4） */
  message: string
  /** 相关插孔，供 3D 台面与原理图高亮 */
  jacks: string[]
}

const ref = (inst: string, jack: string) => `${inst}.${jack}`

/** 插孔的可读名称：模块或仪表名 + 丝印，如"电路基础实验挂箱（一） 的 A" */
export function jackLabeler(input: CheckInput): (jackRef: string) => string {
  const labels = new Map<string, string>()
  for (const { instanceId, module } of input.modules)
    for (const j of module.jacks) labels.set(ref(instanceId, j.id), `${module.name}的 ${j.label}`)
  for (const { instanceId, instrument } of input.instruments)
    for (const j of instrument.jacks) labels.set(ref(instanceId, j.id), `${instrument.name}的 ${j.label}`)
  return (r) => labels.get(r) ?? r
}

/** 学员接了导线的插孔 */
export function wiredJacks(input: CheckInput): Set<string> {
  return new Set(input.wires.flatMap((w) => [w.a, w.b]))
}

/**
 * 模块内部的固定连接：同铜箔网络、短接帽、未插电流插头的电流插座。
 * 电流插座两端都接了导线时视为插入了电流插头，插座断开。
 */
export function applyModuleInternals(uf: UnionFind<string>, input: CheckInput, wired: Set<string>): void {
  for (const { instanceId, module } of input.modules) {
    for (const j of module.jacks) uf.add(ref(instanceId, j.id))
    for (const net of module.commonNets ?? [])
      for (const jack of net.slice(1)) uf.union(ref(instanceId, net[0] as string), ref(instanceId, jack))
    for (const jp of module.internalJumpers ?? []) {
      const a = ref(instanceId, jp.a)
      const b = ref(instanceId, jp.b)
      if (jp.kind === 'currentSocket' && wired.has(a) && wired.has(b)) continue
      uf.union(a, b)
    }
  }
}

export function isMeter(instrument: Instrument): boolean {
  return instrument.measure !== undefined
}

/**
 * 按"电流表短路、电压表开路"规则得到的网络划分（只含模块与电源插孔）。
 * skipSeries：不短接的串入端（检查某块电流表本身时使用）。
 */
export function circuitPartition(input: CheckInput, skipSeries?: { instanceId: string; pair: number }) {
  const wired = wiredJacks(input)
  const uf = new UnionFind<string>()
  applyModuleInternals(uf, input, wired)
  for (const { instanceId, instrument } of input.instruments) {
    for (const j of instrument.jacks) uf.add(ref(instanceId, j.id))
    instrument.measure?.series.forEach(([a, b], i) => {
      const skip = skipSeries?.instanceId === instanceId && skipSeries.pair === i
      // 串入端两头都接了线才算串入
      const ra = ref(instanceId, a)
      const rb = ref(instanceId, b)
      if (!skip && wired.has(ra) && wired.has(rb)) uf.union(ra, rb)
    })
  }
  for (const w of input.wires) uf.union(w.a, w.b)
  return uf
}

/** 测量仪表的插孔集合，拓扑比对时从划分中去掉 */
export function meterJacks(input: CheckInput): Set<string> {
  const set = new Set<string>()
  for (const { instanceId, instrument } of input.instruments)
    if (isMeter(instrument)) for (const j of instrument.jacks) set.add(ref(instanceId, j.id))
  return set
}
