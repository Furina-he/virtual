import type { FaultDef } from '../../shared/schema/index.ts'
import { AssembleError } from './errors.ts'

const OPEN_R = '1G'
const SHORT_R = '1m'

/**
 * 在子电路文本中改写故障元件（技术设计 §8）。只处理两端元件的开路/短路/漂移，
 * 以及按 params.model 替换模型名的"损坏"。
 */
export function injectFault(subckt: string, element: string, fault: FaultDef): string {
  const lines = subckt.split('\n')
  const idx = lines.findIndex((l) => l.trim().split(/\s+/)[0]?.toLowerCase() === element.toLowerCase())
  if (idx < 0) throw new AssembleError('content', `故障目标元件 ${element} 不在子电路中`)
  const tokens = (lines[idx] as string).trim().split(/\s+/)
  const [name, n1, n2] = tokens
  if (!name || !n1 || !n2) throw new AssembleError('content', `故障目标元件 ${element} 格式不对`)

  switch (fault.kind) {
    case 'open': {
      // 第二端改接内部节点，再串 1 GΩ
      const mid = `fault_open_${name}`
      tokens[2] = mid
      lines.splice(idx, 1, tokens.join(' '), `Rfault_open_${name} ${mid} ${n2} ${OPEN_R}`)
      break
    }
    case 'short':
      lines.splice(idx + 1, 0, `Rfault_short_${name} ${n1} ${n2} ${SHORT_R}`)
      break
    case 'drift': {
      const value = fault.params?.value
      if (value === undefined) throw new AssembleError('content', `故障 ${fault.id} 缺少 params.value`)
      tokens[3] = String(value)
      lines[idx] = tokens.join(' ')
      break
    }
    case 'dead': {
      const model = fault.params?.model
      if (model === undefined) throw new AssembleError('content', `故障 ${fault.id} 缺少 params.model`)
      tokens[tokens.length - 1] = String(model)
      lines[idx] = tokens.join(' ')
      break
    }
  }
  return lines.join('\n')
}
