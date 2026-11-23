import type { FaultDef } from '../../shared/schema/index.ts'
import { AssembleError } from './errors.ts'

const OPEN_R = '1G'
const SHORT_R = '1m'

function primarySubcktBounds(lines: readonly string[]): { start: number; end: number } {
  const start = lines.findIndex((line) => /^\s*\.subckt\s+/i.test(line))
  if (start < 0) return { start: -1, end: lines.length }
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string
    if (/^\s*\.subckt\b/i.test(line)) depth++
    else if (/^\s*\.ends\b/i.test(line)) {
      depth--
      if (depth === 0) return { start, end: i }
    }
  }
  return { start, end: lines.length }
}

/** 提取主子电路内的可排故元件位号（排除铜箔短接 Rcu_* 与开关辅助电阻 RK*） */
export function listSubcktElements(subckt: string): { name: string; prefix: string }[] {
  const lines = subckt.split(/\r?\n/)
  const { start, end } = primarySubcktBounds(lines)
  const items: { name: string; prefix: string }[] = []
  for (let i = start + 1; i < end; i++) {
    const trimmed = (lines[i] as string).trim()
    if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('.') || trimmed.startsWith('+')) continue
    const name = trimmed.split(/\s+/)[0] ?? ''
    if (!name || /^Rcu_/i.test(name) || /^RK[A-Z0-9_]+$/i.test(name)) continue
    items.push({ name, prefix: (name[0] ?? '').toUpperCase() })
  }
  return items
}

/**
 * 在子电路文本中改写故障元件（技术设计 §8、FLT-01）。
 * 支持两端无源元件/二极管、三端晶体管（Q/J）及子电路芯片（X）的开路、短路、参数漂移与损坏模型替换。
 */
export function injectFault(subckt: string, element: string, fault: FaultDef): string {
  const lines = subckt.split(/\r?\n/)
  const { start, end } = primarySubcktBounds(lines)
  let idx = -1
  for (let i = start + 1; i < end; i++) {
    const trimmed = (lines[i] as string).trim()
    if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('.')) continue
    if (trimmed.split(/\s+/)[0]?.toLowerCase() === element.toLowerCase()) {
      idx = i
      break
    }
  }
  if (idx < 0) throw new AssembleError('content', `故障目标元件 ${element} 不在子电路中`)
  const tokens = (lines[idx] as string).trim().split(/\s+/)
  const [name, n1, n2] = tokens
  if (!name || !n1 || !n2) throw new AssembleError('content', `故障目标元件 ${element} 格式不对`)
  const prefix = (name[0] ?? '').toUpperCase()
  const isThreeTerminal = (prefix === 'Q' || prefix === 'J') && tokens.length >= 5

  switch (fault.kind) {
    case 'open': {
      if (isThreeTerminal) {
        const terminal = String(fault.params?.terminal ?? 'c').toLowerCase()
        const termIdx = terminal === 'b' || terminal === 'g' ? 2 : terminal === 'e' || terminal === 's' ? 3 : 1
        const origNode = tokens[termIdx] as string
        const mid = `fault_open_${name}`
        tokens[termIdx] = mid
        lines.splice(idx, 1, tokens.join(' '), `Rfault_open_${name} ${mid} ${origNode} ${OPEN_R}`)
        break
      }
      // 第二端改接内部节点，再串 1 GΩ
      const mid = `fault_open_${name}`
      tokens[2] = mid
      lines.splice(idx, 1, tokens.join(' '), `Rfault_open_${name} ${mid} ${n2} ${OPEN_R}`)
      break
    }
    case 'short': {
      if (isThreeTerminal) {
        const pair = String(fault.params?.pair ?? 'ce').toLowerCase()
        const [nodeA, nodeB] =
          pair === 'be'
            ? [tokens[2] as string, tokens[3] as string]
            : pair === 'cb' || pair === 'bc'
              ? [tokens[1] as string, tokens[2] as string]
              : [tokens[1] as string, tokens[3] as string]
        lines.splice(idx + 1, 0, `Rfault_short_${name} ${nodeA} ${nodeB} ${SHORT_R}`)
        break
      }
      lines.splice(idx + 1, 0, `Rfault_short_${name} ${n1} ${n2} ${SHORT_R}`)
      break
    }
    case 'drift': {
      const value = fault.params?.value
      if (value === undefined || String(value).trim() === '')
        throw new AssembleError('content', `故障 ${fault.id} 缺少 params.value`)
      if (prefix === 'Q' && tokens.length >= 5) {
        const oldModel = tokens[tokens.length - 1] as string
        const driftModel = `${oldModel}__drift_${name}`
        tokens[tokens.length - 1] = driftModel
        lines.splice(
          idx,
          1,
          tokens.join(' '),
          `.model ${driftModel} NPN(IS=5e-15 BF=${String(value).trim()} NF=1 BR=2 NR=1)`,
        )
        break
      }
      lines[idx] = [name, n1, n2, String(value).trim()].join(' ')
      break
    }
    case 'dead': {
      const model = fault.params?.model
      if (model === undefined || String(model).trim() === '')
        throw new AssembleError('content', `故障 ${fault.id} 缺少 params.model`)
      const modelName = String(model).trim()
      if (prefix === 'Q' && tokens.length >= 5) {
        const nc = tokens[1] as string
        const nb = tokens[2] as string
        const ne = tokens[3] as string
        tokens[tokens.length - 1] = modelName
        const extras: string[] = []
        if (modelName === 'bjt_ce_short') {
          const isoB = `fault_dead_${name}_b`
          tokens[2] = isoB
          extras.push(
            `.model bjt_ce_short NPN(IS=1e-30 BF=1e-6 BR=1e-6 CJE=0 CJC=0)`,
            `Rfault_dead_iso_${name} ${isoB} ${nb} ${OPEN_R}`,
            `Rfault_dead_${name} ${nc} ${ne} ${fault.params?.r ?? '1'}`,
          )
        } else if (modelName === 'bjt_be_short') {
          const isoC = `fault_dead_${name}_c`
          tokens[1] = isoC
          extras.push(
            `.model bjt_be_short NPN(IS=1e-30 BF=1e-6 BR=1e-6 CJE=0 CJC=0)`,
            `Rfault_dead_iso_${name} ${isoC} ${nc} ${OPEN_R}`,
            `Rfault_dead_${name} ${nb} ${ne} ${fault.params?.r ?? '1'}`,
          )
        } else if (modelName === 'bjt_cb_short') {
          const isoE = `fault_dead_${name}_e`
          tokens[3] = isoE
          extras.push(
            `.model bjt_cb_short NPN(IS=1e-30 BF=1e-6 BR=1e-6 CJE=0 CJC=0)`,
            `Rfault_dead_iso_${name} ${isoE} ${ne} ${OPEN_R}`,
            `Rfault_dead_${name} ${nc} ${nb} ${fault.params?.r ?? '1'}`,
          )
        } else if (modelName === 'bjt_open' || modelName === 'bjt_be_open' || modelName === 'bjt_ce_open') {
          const isoB = `fault_dead_${name}_b`
          const isoC = `fault_dead_${name}_c`
          tokens[1] = isoC
          tokens[2] = isoB
          extras.push(
            `.model ${modelName} NPN(IS=1e-30 BF=1e-6 BR=1e-6 CJE=0 CJC=0)`,
            `Rfault_dead_c_${name} ${isoC} ${nc} ${OPEN_R}`,
            `Rfault_dead_b_${name} ${isoB} ${nb} ${OPEN_R}`,
          )
        }
        lines.splice(idx, 1, tokens.join(' '), ...extras)
        break
      }
      if (prefix === 'D' && tokens.length >= 4) {
        tokens[tokens.length - 1] = modelName
        const extras: string[] = []
        if (modelName === 'diode_short') {
          extras.push(
            `.model diode_short D(IS=1e-30 CJO=0)`,
            `Rfault_dead_${name} ${n1} ${n2} ${fault.params?.r ?? SHORT_R}`,
          )
        } else if (modelName === 'diode_open') {
          const iso = `fault_dead_${name}`
          tokens[2] = iso
          extras.push(`.model diode_open D(IS=1e-30 CJO=0)`, `Rfault_dead_${name} ${iso} ${n2} ${OPEN_R}`)
        }
        lines.splice(idx, 1, tokens.join(' '), ...extras)
        break
      }
      if (prefix === 'C') {
        if (modelName === 'cap_open') {
          lines[idx] = [name, n1, n2, '1f'].join(' ')
          break
        }
        if (modelName === 'cap_leak') {
          lines.splice(
            idx,
            1,
            [name, n1, n2, '1n'].join(' '),
            `Rfault_dead_${name} ${n1} ${n2} ${fault.params?.r ?? '100'}`,
          )
          break
        }
        if (modelName === 'cap_short') {
          lines.splice(idx, 1, [name, n1, n2, '1n'].join(' '), `Rfault_dead_${name} ${n1} ${n2} ${SHORT_R}`)
          break
        }
      }
      if (prefix === 'X' && (modelName === 'ic_stuck_low' || modelName === 'ic_stuck_high') && tokens.length >= 3) {
        const pin = Number(fault.params?.pin ?? 1)
        if (!Number.isInteger(pin) || pin < 1 || pin >= tokens.length - 1)
          throw new AssembleError('content', `故障 ${fault.id} 芯片引脚序号无效`)
        const boardNode = tokens[pin] as string
        const isoNode = `fault_dead_${name}_p${pin}`
        tokens[pin] = isoNode
        const railNode = String(fault.params?.rail ?? '0')
        lines.splice(
          idx,
          1,
          tokens.join(' '),
          `Rfault_dead_iso_${name} ${isoNode} 0 ${OPEN_R}`,
          `Rfault_dead_${name} ${boardNode} ${railNode} ${fault.params?.r ?? '20'}`,
        )
        break
      }
      tokens[tokens.length - 1] = modelName
      lines[idx] = tokens.join(' ')
      break
    }
  }
  return lines.join('\n')
}
