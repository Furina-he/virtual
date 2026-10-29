// 仿真会话协议（技术设计 §4.3）。renderer ↔ main ↔ sim 三方共用，消息全部经 zod 校验。
import { z } from 'zod'

export const ProbeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['v', 'i']),
  node: z.string().min(1).optional(),
  nodeRef: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
})
export type Probe = z.infer<typeof ProbeSchema>

export const AnalysisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('op') }),
  z.object({ kind: z.literal('tran'), step: z.number().positive(), continuous: z.literal(true) }),
  z.object({
    kind: z.literal('ac'),
    fStart: z.number().positive(),
    fStop: z.number().positive(),
    points: z.number().int().positive(),
  }),
])
export type Analysis = z.infer<typeof AnalysisSchema>

export const ResistorElementSchema = z
  .string()
  .regex(/^(?:[Rr][A-Za-z0-9_]+|[Rr]\.[Xx][A-Za-z0-9_]+\.[Rr][A-Za-z0-9_]+)$/)
export const ParameterTargetSchema = z.object({ element: ResistorElementSchema, value: z.number().positive().finite() })
export const ParameterTargetsSchema = z.object({
  param: z.string().regex(/^[A-Za-z_]\w*$/),
  elements: z.array(ResistorElementSchema).min(1),
})
export const ParameterChangeSchema = z.object({
  param: z.string().regex(/^[A-Za-z_]\w*$/),
  value: z.number().finite(),
  targets: z.array(ParameterTargetSchema).min(1).optional(),
})
export type ParameterChange = z.infer<typeof ParameterChangeSchema>
const ParameterChangesSchema = z.array(ParameterChangeSchema).min(1)

export const SimCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('load'),
    netlist: z.string().min(1),
    probes: z.array(ProbeSchema),
    analysis: AnalysisSchema,
    parameterTargets: z.array(ParameterTargetsSchema).optional(),
  }),
  z.object({ type: z.literal('run') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('stop') }),
  // 运行中改参数（ADR-009）：param 为网表全局参数名（p_<实例>_<参数>），拼进 ngspice 命令，只允许标识符
  z.object({
    type: z.literal('alter'),
    requestId: z.string().min(1).optional(),
    changes: ParameterChangesSchema,
  }),
  z.object({
    type: z.literal('setPacing'),
    mode: z.enum(['realtime', 'window']),
    windowSec: z.number().positive().optional(),
  }),
])
export type SimCommand = z.infer<typeof SimCommandSchema>

export const SimErrorCodeSchema = z.enum(['no-convergence', 'singular', 'model', 'crash'])

export const SimEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('loaded'), vectors: z.array(z.string()) }),
  z.object({
    type: z.literal('altered'),
    requestId: z.string().min(1).optional(),
    simTime: z.number().finite().nonnegative(),
    changes: ParameterChangesSchema,
  }),
  z.object({ type: z.literal('op'), values: z.record(z.string(), z.number()) }),
  // seq 为会话内块序号，从 0 连续递增，用于检测丢块；data 中数组按 transfer 发送
  z.object({
    type: z.literal('chunk'),
    seq: z.number().int().nonnegative(),
    t0: z.number(),
    dt: z.number().positive(),
    data: z.record(z.string(), z.instanceof(Float32Array)),
  }),
  // 读数快照（§4.2，10 Hz）：probeId → 最新值
  z.object({ type: z.literal('readings'), simTime: z.number(), values: z.record(z.string(), z.number()) }),
  z.object({
    type: z.literal('status'),
    state: z.enum(['idle', 'running', 'paused', 'error']),
    simTime: z.number(),
  }),
  z.object({
    type: z.literal('error'),
    code: SimErrorCodeSchema,
    message: z.string(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
  }),
  z.object({ type: z.literal('log'), line: z.string() }),
])
export type SimEvent = z.infer<typeof SimEventSchema>
export type SimChunk = Extract<SimEvent, { type: 'chunk' }>
export type SimAltered = Extract<SimEvent, { type: 'altered' }>

/** Update only declared, single-assignment .param lines for successful session/restart replay. */
export function patchNetlistParameters(netlist: string, changes: readonly ParameterChange[]): string {
  const requested = new Map<string, ParameterChange>()
  const matches = new Map<string, number>()
  for (const change of changes) {
    ParameterChangeSchema.parse(change)
    const key = change.param.toLowerCase()
    if (requested.has(key)) throw new Error(`Duplicate parameter: ${change.param}`)
    requested.set(key, change)
  }
  const lines = netlist.split(/\r?\n/).map((line) => {
    const match = /^\s*\.param\s+([A-Za-z_]\w*)\s*=\s*(\S+)\s*$/i.exec(line)
    const key = match?.[1]?.toLowerCase()
    const change = key ? requested.get(key) : undefined
    if (!change) return line
    matches.set(key as string, (matches.get(key as string) ?? 0) + 1)
    return `.param ${match?.[1]}=${change.value}`
  })
  for (const key of requested.keys()) {
    if (matches.get(key) !== 1) throw new Error(`Unknown, duplicate or unsupported parameter: ${key}`)
  }
  return lines.join('\n')
}

// main ↔ sim 进程消息（parentPort），renderer 不直接使用
export type SimHostMessage = { type: 'command'; command: SimCommand } | { type: 'port' }
export type SimChildMessage =
  | { type: 'altered'; event: SimAltered }
  | { type: 'parameter-error'; event: Extract<SimEvent, { type: 'error' }> }

// IPC 通道名
export const SIM_CHANNEL = {
  command: 'sim:command',
  requestPort: 'sim:request-port',
  port: 'sim:port',
  restarted: 'sim:restarted',
} as const

// preload 用 window.postMessage 把端口交给页面时的标记
export const SIM_PORT_MESSAGE = 'virtual:sim-port'
