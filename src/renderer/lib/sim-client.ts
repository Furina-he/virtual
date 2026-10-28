// 渲染端仿真客户端（技术设计 §4.2）：接收数据端口，把采样块写进各探针的环形缓冲。
// 高频数据只进 RingBuffer，绝不进 React state；读数快照、状态等低频事件通过 onEvent 分发。
import { SIM_PORT_MESSAGE, type SimCommand, type SimEvent, SimEventSchema } from '@shared/ipc/sim'
import { RingBuffer } from './ring-buffer'

/** 每个探针默认保留的点数（约 1 MB） */
const DEFAULT_CAPACITY = 1 << 18

type LowFreqEvent = Exclude<SimEvent, { type: 'chunk' }>
/** 采样块监听（音频输出等需要逐块处理的消费者）；在消息回调中同步调用，不得写 React state */
export type SamplesListener = (samples: Float32Array, t0: number, dt: number) => void

export interface SimStats {
  /** 当前会话收到的块数 */
  blocks: number
  /** 按块序号缺口统计的丢块数（累计） */
  lostBlocks: number
  /** 当前会话最后一个块序号，-1 表示尚无 */
  lastSeq: number
  /** 当前会话收到的点数（单探针） */
  points: number
  /** 收到 loaded 的次数 */
  sessions: number
  restarts: number
}

export class SimClient {
  readonly stats: SimStats = { blocks: 0, lostBlocks: 0, lastSeq: -1, points: 0, sessions: 0, restarts: 0 }
  private readonly buffers = new Map<string, RingBuffer>()
  private readonly listeners = new Set<(e: LowFreqEvent) => void>()
  private readonly restartListeners = new Set<() => void>()
  private readonly sampleListeners = new Map<string, Set<SamplesListener>>()
  private port?: MessagePort

  constructor() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data !== SIM_PORT_MESSAGE) return
      const port = e.ports[0]
      if (port) this.attach(port)
    })
    window.api.sim.onRestarted(() => {
      this.stats.restarts++
      for (const l of this.restartListeners) l()
    })
    void window.api.sim.requestPort()
  }

  send(command: SimCommand): Promise<void> {
    return window.api.sim.send(command)
  }

  /** 探针的环形缓冲；在 rAF / useFrame 中读取 */
  buffer(probeId: string): RingBuffer {
    let b = this.buffers.get(probeId)
    if (!b) {
      b = new RingBuffer(DEFAULT_CAPACITY)
      this.buffers.set(probeId, b)
    }
    return b
  }

  /** 订阅低频事件（loaded / op / readings / status / error / log） */
  onEvent(listener: (e: LowFreqEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 订阅某探针的采样块（如扬声器节点 → 音频输出，SIM-13） */
  onSamples(probeId: string, listener: SamplesListener): () => void {
    let set = this.sampleListeners.get(probeId)
    if (!set) {
      set = new Set()
      this.sampleListeners.set(probeId, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  onRestarted(listener: () => void): () => void {
    this.restartListeners.add(listener)
    return () => this.restartListeners.delete(listener)
  }

  private attach(port: MessagePort): void {
    this.port?.close()
    this.port = port
    port.onmessage = (e) => this.receive(e.data)
    port.start()
  }

  private receive(raw: unknown): void {
    const parsed = SimEventSchema.safeParse(raw)
    if (!parsed.success) return
    const ev = parsed.data
    if (ev.type === 'chunk') {
      this.onChunk(ev)
      return
    }
    if (ev.type === 'loaded') {
      // 新会话：清空缓冲，块序号重新从 0 计
      for (const b of this.buffers.values()) b.clear()
      Object.assign(this.stats, { blocks: 0, lastSeq: -1, points: 0 })
      this.stats.sessions++
    }
    for (const l of this.listeners) l(ev)
  }

  private onChunk(ev: Extract<SimEvent, { type: 'chunk' }>): void {
    const s = this.stats
    if (ev.seq !== s.lastSeq + 1) s.lostBlocks += Math.max(1, ev.seq - s.lastSeq - 1)
    s.lastSeq = ev.seq
    s.blocks++
    let n = 0
    for (const [id, samples] of Object.entries(ev.data)) {
      this.buffer(id).push(samples, ev.t0, ev.dt)
      const ls = this.sampleListeners.get(id)
      if (ls) for (const l of ls) l(samples, ev.t0, ev.dt)
      n = samples.length
    }
    s.points += n
  }
}

let client: SimClient | undefined

/** 全局唯一客户端，首次调用时申请数据端口 */
export function getSimClient(): SimClient {
  if (!client) {
    client = new SimClient()
    // 供 e2e 检查块序号与丢块统计
    Object.assign(window, { __simClient: client })
    // 供 e2e 验证音频原型（独立 chunk，按需加载）
    Object.assign(window, { __loadSimAudio: () => import('./audio/sim-audio') })
  }
  return client
}
