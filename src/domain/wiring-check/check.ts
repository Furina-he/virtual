import type { Project } from '../../shared/schema/index.ts'
import { UnionFind } from '../circuit/union-find.ts'
import {
  applyModuleInternals,
  type CheckInput,
  circuitPartition,
  jackLabeler,
  meterJacks,
  type WiringIssue,
  wiredJacks,
} from './common.ts'

type Reference = Project['reference']

/**
 * 参考拓扑里的实例 ID 换成台面上的实际实例 ID。
 * 固定仪表的实例 ID 就是仪表 id；学员放置的台式仪表在参考中按仪表 id 书写，映射到台面上该仪表的实例。
 */
function refMapper(input: CheckInput): (r: string) => string {
  const instances = new Set([...input.modules, ...input.instruments].map((x) => x.instanceId))
  return (r) => {
    const dot = r.indexOf('.')
    const inst = r.slice(0, dot)
    if (instances.has(inst)) return r
    const placed = input.instruments.find((i) => i.instrument.id === inst)
    return placed ? `${placed.instanceId}${r.slice(dot)}` : r
  }
}

function classesOf(uf: UnionFind<string>, universe: string[]): Map<string, string[]> {
  const byRoot = new Map<string, string[]>()
  for (const j of universe) {
    const r = uf.find(j)
    const g = byRoot.get(r)
    if (g) g.push(j)
    else byRoot.set(r, [j])
  }
  return byRoot
}

/** 拓扑比对：比较两个插孔划分，差异转为可读提示（技术设计 §6 第 1、2 步） */
export function checkTopology(input: CheckInput, reference: Reference): WiringIssue[] {
  const label = jackLabeler(input)
  const map = refMapper(input)
  const meters = meterJacks(input)

  const student = circuitPartition(input)
  const expected = new UnionFind<string>()
  // 参考电路中电流表按短路处理，电流插座等同接通
  applyModuleInternals(expected, input, new Set())
  for (const { instanceId, instrument } of input.instruments)
    for (const j of instrument.jacks) expected.add(`${instanceId}.${j.id}`)
  for (const net of reference.nets) {
    const [first, ...rest] = net.map(map)
    for (const j of rest) expected.union(first as string, j)
  }

  const universe = [...new Set([...student.groups().flat(), ...expected.groups().flat()])].filter((j) => !meters.has(j))
  const issues: WiringIssue[] = []
  const wired = wiredJacks(input)
  // 每组里优先挑学员实际接了线的插孔做代表，提示更好理解
  const pick = (group: string[]) => group.find((j) => wired.has(j)) ?? (group[0] as string)

  for (const group of classesOf(expected, universe).values()) {
    const pieces = [...classesOf(student, group).values()]
    const [head, ...others] = pieces
    if (!head) continue
    for (const piece of others)
      issues.push({
        severity: 'error',
        code: 'missing-connection',
        message: `${label(pick(head))} 应与 ${label(pick(piece))} 相连。`,
        jacks: [pick(head), pick(piece)],
      })
  }
  for (const group of classesOf(student, universe).values()) {
    const pieces = [...classesOf(expected, group).values()]
    const [head, ...others] = pieces
    if (!head) continue
    for (const piece of others)
      issues.push({
        severity: 'error',
        code: 'extra-connection',
        message: `${label(pick(head))} 与 ${label(pick(piece))} 之间多了连线，这两点不应相连。`,
        jacks: [pick(head), pick(piece)],
      })
  }
  return issues
}

/** 测量点检查：电压表跨接在 between 两点，电流表串在 branch 中（技术设计 §6 第 3 步） */
export function checkMeasurePoints(input: CheckInput, reference: Reference): WiringIssue[] {
  const label = jackLabeler(input)
  const map = refMapper(input)
  const wired = wiredJacks(input)
  const full = circuitPartition(input)
  const issues: WiringIssue[] = []

  for (const mp of reference.measurePoints) {
    if (mp.kind === 'current' && mp.branch) {
      const [x, y] = mp.branch.map(map) as [string, string]
      let found: 'ok' | 'reversed' | undefined
      for (const { instanceId, instrument } of input.instruments) {
        instrument.measure?.series.forEach(([a, b], pair) => {
          const ra = `${instanceId}.${a}`
          const rb = `${instanceId}.${b}`
          if (found === 'ok' || !wired.has(ra) || !wired.has(rb)) return
          // 去掉这块表的短接后，两端应分别落在支路两侧
          const uf = circuitPartition(input, { instanceId, pair })
          if (uf.find(x) === uf.find(y)) return
          if (uf.find(ra) === uf.find(x) && uf.find(rb) === uf.find(y)) found = 'ok'
          else if (uf.find(ra) === uf.find(y) && uf.find(rb) === uf.find(x)) found = 'reversed'
        })
      }
      if (found === 'reversed')
        issues.push({
          severity: 'warning',
          code: 'measure-polarity',
          message: `测量 ${mp.id} 的电流表极性接反，读数为负。电流应从电流表正端流入。`,
          jacks: [x, y],
        })
      else if (!found)
        issues.push({
          severity: 'error',
          code: 'measure-missing',
          message: `测量 ${mp.id} 需要把电流表串入 ${label(x)} 与 ${label(y)} 之间。`,
          jacks: [x, y],
        })
      continue
    }
    if (!mp.between) continue
    const [p, n] = mp.between.map(map) as [string, string]
    let found: 'ok' | 'reversed' | undefined
    for (const { instanceId, instrument } of input.instruments)
      for (const [a, b] of instrument.measure?.voltage ?? []) {
        const ra = `${instanceId}.${a}`
        const rb = `${instanceId}.${b}`
        if (found === 'ok' || !wired.has(ra) || !wired.has(rb)) continue
        if (full.find(ra) === full.find(p) && full.find(rb) === full.find(n)) found = 'ok'
        else if (full.find(ra) === full.find(n) && full.find(rb) === full.find(p)) found = 'reversed'
      }
    const what = mp.kind === 'waveform' ? '示波器探头' : '电压表'
    if (found === 'reversed')
      issues.push({
        severity: 'warning',
        code: 'measure-polarity',
        message: `测量 ${mp.id} 的${what}正负端接反，读数为负。正端应接 ${label(p)}。`,
        jacks: [p, n],
      })
    else if (!found)
      issues.push({
        severity: 'error',
        code: 'measure-missing',
        message: `测量 ${mp.id} 需要把${what}接在 ${label(p)} 与 ${label(n)} 两端。`,
        jacks: [p, n],
      })
  }
  return issues
}

/** "检查接线"：拓扑 + 测量点。仪表接法不参与拓扑判定（WIR-03） */
export function checkWiring(input: CheckInput, reference: Reference) {
  const topology = checkTopology(input, reference)
  const measurements = checkMeasurePoints(input, reference)
  return {
    circuitOk: topology.length === 0,
    measurementsOk: measurements.every((i) => i.severity !== 'error'),
    issues: [...topology, ...measurements],
  }
}
