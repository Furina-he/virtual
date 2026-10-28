// 仿真会话（技术设计 §4.3、§5.4）：一次 load 对应一个会话。
// 连续 tran 用 "stop when time > T" 切成时间片推进：每片结束后台线程自行停下，
// 在片间隙一次性读出本片新增的向量数据、攒块推送，并处理暂停、重新载入和节奏控制。
// 内存：ngspice 把整个 tran 的点都留在向量里（10 分钟约 1 GB）。每读出 TRIM_POINTS 个点就用
// "let v = v[末点]" 把本 plot 每个向量截成 1 点：let 对已有向量原地换数据缓冲，tran 写入用的 dvec 指针不变，
// 电路与 XSPICE 状态不受影响，不需要重启 tran（重启会丢数字状态、源相位从 0 开始）。
// XSPICE 事件节点历史另用 "esave none" 关闭；已执行命令的控制结构每片用 ngSpice_Command(NULL) 释放。
// 运行中改参数（ADR-009）：片间隙 "alterparam p=v" + "reset"，reset 重新展开参数，tran 时间与状态继续。
// 不用 SendData 逐点回调：koffi 把每个点从后台线程排队回 JS 主线程，Electron 中实测
// 只有约 2.7 万点/秒，20 µs 步长跟不上实时；也不在后台线程运行中调 bg_halt（会与排队回调互等）。
import type { Analysis, Probe, SimCommand, SimEvent } from '../shared/ipc/sim'
import { Chunker } from './chunker'
import { classifyError, NgSpice, NgSpiceError } from './ngspice'

type Emit = (event: SimEvent) => void
type State = 'idle' | 'running' | 'paused' | 'error'
type Load = Extract<SimCommand, { type: 'load' }>

/** 每块最多点数 */
export const BLOCK_POINTS = 2048
const READINGS_MS = 100
/** 每个时间片的仿真时长（秒） */
const SLICE_SEC = 0.05
/** 每读出这么多点截断一次向量（每个向量约 400 KB） */
export const TRIM_POINTS = 50_000
/** window 节奏下示波器刷新周期：每周期至少推进一个窗口 */
const WINDOW_REFRESH_SEC = 0.1
/** 落后墙钟超过此值时放弃追赶（避免卡顿后突发快进） */
const MAX_LAG_SEC = 1
// ngspice 按 tstop/tstep 预估输出内存，打印步长取大值避免预估超限；实际步长由 tmax 限定
const TRAN_STOP = 1e6
const TRAN_PRINT = 10

// 时间片推进的例行输出，不转发到日志
const NOISE =
  /condition met|pause requested|simulation interrupted|Reference value|Background thread stopped|would set breakpoint|Reset re-loads circuit|^Circuit: /i

function vecName(node: string): string | undefined {
  return node === '0' ? undefined : node.toLowerCase()
}

function saveList(probes: Probe[]): string[] {
  const out = new Set<string>()
  for (const p of probes) {
    if (p.kind === 'i' && p.source) out.add(`i(${p.source.toLowerCase()})`)
    for (const n of [p.node, p.nodeRef]) {
      const v = n && vecName(n)
      if (p.kind === 'v' && v) out.add(`v(${v})`)
    }
  }
  return [...out]
}

function analysisLine(a: Analysis): string {
  if (a.kind === 'op') return '.op'
  if (a.kind === 'ac') return `.ac dec ${a.points} ${a.fStart} ${a.fStop}`
  return `.tran ${TRAN_PRINT} ${TRAN_STOP} 0 ${a.step}`
}

/** 去掉网表里的分析语句与 .end，按会话分析类型重新追加 */
export function buildNetlist(cmd: Load): string {
  const body = cmd.netlist.split(/\r?\n/).filter((l) => !/^\s*\.(tran|op|ac|dc|save|end)\b/i.test(l))
  const save = saveList(cmd.probes)
  return [...body, ...(save.length ? [`.save ${save.join(' ')}`] : []), analysisLine(cmd.analysis), '.end'].join('\n')
}

export class SimSession {
  private ng: NgSpice
  private state: State = 'idle'
  private current?: Load
  private chunker?: Chunker
  private started = false
  private bgRunning = false
  private sliceEnd = 0
  private simTime = 0
  // 节奏基准：paceSim 时刻对应墙钟 paceWall（秒），rate 为仿真/墙钟速度上限
  private paceSim = 0
  private paceWall = 0
  private rate = 1
  /** 截断向量的累计次数（测试用） */
  trims = 0
  // 后台线程运行中收到的命令，片结束后按序执行
  private readonly queue: (() => void)[] = []
  private bgErrors: string[] = []
  private resumeTimer?: ReturnType<typeof setTimeout>
  private resumeNow?: ReturnType<typeof setImmediate>
  /** 已读出的向量点数 */
  private readIdx = 0
  private probeValues = new Float64Array(0)
  private readonly timers: ReturnType<typeof setInterval>[] = []

  constructor(
    dir: string,
    private readonly emit: Emit,
    private readonly onFatal: () => void,
  ) {
    this.ng = NgSpice.open(dir, {
      onBgRunning: (running) => {
        this.bgRunning = running
        // 回调期间后台线程在等待返回，不能在这里调 ngspice
        if (!running) setImmediate(() => this.afterSlice())
      },
      onLog: (line) => this.onLog(line),
      onExit: () => {
        this.emit({ type: 'error', code: 'crash', message: new NgSpiceError('crash', '').message })
        setImmediate(this.onFatal)
      },
    })
    this.timers.push(setInterval(() => this.sendReadings(), READINGS_MS))
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t)
    this.cancelResume()
  }

  handle(cmd: SimCommand): void {
    switch (cmd.type) {
      case 'load':
        this.whenIdle(() => this.load(cmd))
        break
      case 'run':
        this.run()
        break
      case 'pause':
        if (this.state === 'running') this.setState('paused')
        break
      case 'stop':
        // 结束会话：重新载入同一网表，下次 run 从 0 开始（渲染端以 loaded 重置块序号）
        this.setState('idle')
        this.whenIdle(() => {
          if (this.current) this.load(this.current)
        })
        break
      case 'setPacing':
        // realtime：仿真时间跟墙钟；window：不受实时限制，有窗口长度时每 100 ms 至少推进一个窗口
        this.rate =
          cmd.mode === 'realtime' ? 1 : cmd.windowSec ? Math.max(1, cmd.windowSec / WINDOW_REFRESH_SEC) : Infinity
        this.resetPace()
        break
      case 'alter':
        this.whenIdle(() => this.alter(cmd.changes))
        break
    }
  }

  // 后台线程在跑（或已有排队命令）时推迟到片结束
  private whenIdle(act: () => void): void {
    this.cancelResume()
    if (this.bgRunning || this.queue.length) this.queue.push(act)
    else act()
  }

  private resetPace(): void {
    this.paceSim = this.simTime
    this.paceWall = performance.now() / 1000
  }

  // ADR-009：只改参数不改拓扑。alterparam 改全局 .param，reset 让 ngspice 重新代入；
  // 时间片间隙执行，tran 从当前时刻继续，电容电压与数字状态保留（tests/golden/sim-runtime.test.ts）
  private alter(changes: { param: string; value: number }[]): void {
    const cmd = this.current
    if (!cmd || this.state === 'error') return
    try {
      for (const c of changes) this.ng.command(`alterparam ${c.param}=${c.value}`)
      this.ng.command('reset')
      this.quietEvents()
      if (cmd.analysis.kind === 'op') this.runOp(cmd)
    } catch (e) {
      const detail = e instanceof NgSpiceError ? e.detail : String(e)
      this.emit({ type: 'log', line: `改参数失败：${detail}` })
    }
    if (this.state === 'running' && this.started && !this.bgRunning) this.scheduleResume()
  }

  // 不保留 XSPICE 事件节点历史（默认全部保留，长时间运行内存持续增长）；reset 后须重设
  private quietEvents(): void {
    try {
      this.ng.command('esave none')
    } catch {
      // 纯模拟电路没有事件节点
    }
  }

  private setState(state: State): void {
    this.state = state
    this.emit({ type: 'status', state, simTime: this.simTime })
  }

  private fail(e: unknown): void {
    const err = e instanceof NgSpiceError ? e : new NgSpiceError('model', String(e))
    this.emit({ type: 'error', code: err.code, message: err.message, detail: err.detail })
    this.setState('error')
  }

  private load(cmd: Load): void {
    this.current = cmd
    this.started = false
    this.simTime = 0
    // 旧会话剩余数据已在片结束时发完；渲染端以 loaded 事件为会话分界
    this.chunker = undefined
    this.readIdx = 0
    this.probeValues = new Float64Array(cmd.probes.length)
    try {
      this.ng.load(buildNetlist(cmd))
      this.quietEvents()
      this.emit({ type: 'loaded', vectors: saveList(cmd.probes) })
      if (cmd.analysis.kind === 'op') this.runOp(cmd)
      else if (cmd.analysis.kind === 'ac') throw new NgSpiceError('model', '交流分析尚未接入会话')
      else this.setState('idle')
    } catch (e) {
      this.fail(e)
    }
  }

  private runOp(cmd: Load): void {
    this.ng.run()
    const get = (n?: string) => {
      const v = n && vecName(n)
      return v ? (this.ng.getVector(v)[0] ?? 0) : 0
    }
    const values: Record<string, number> = {}
    for (const p of cmd.probes) {
      values[p.id] =
        p.kind === 'i'
          ? (this.ng.getVector(`${(p.source ?? '').toLowerCase()}#branch`)[0] ?? 0)
          : get(p.node) - get(p.nodeRef)
    }
    this.emit({ type: 'op', values })
    this.setState('idle')
  }

  private run(): void {
    this.whenIdle(() => {
      const cmd = this.current
      // 出错后须重新 load
      if (cmd?.analysis.kind !== 'tran' || this.state === 'error') return
      if (this.state === 'running' && this.started) {
        // 已在运行（等待节奏定时器），无需重复启动
        this.scheduleResume()
        return
      }
      const step = cmd.analysis.step
      try {
        this.setState('running')
        this.resetPace()
        if (!this.started) {
          const ids = cmd.probes.map((p) => p.id)
          this.chunker = new Chunker(ids, step, BLOCK_POINTS, (b) =>
            this.emit({ type: 'chunk', seq: b.seq, t0: b.t0, dt: b.dt, data: b.data }),
          )
          this.started = true
          this.nextSlice('bg_run')
        } else this.nextSlice('bg_resume')
      } catch (e) {
        this.fail(e)
      }
    })
  }

  private nextSlice(verb: 'bg_run' | 'bg_resume'): void {
    this.sliceEnd = this.simTime + SLICE_SEC
    this.bgErrors = []
    // 首片之前不能 delete all：.save 也是 debug 项，会被一并删掉而改为保存全部向量
    if (verb === 'bg_resume') this.ng.command('delete all')
    this.ng.command(`stop when time > ${this.sliceEnd}`)
    this.bgRunning = true
    this.ng.command(verb)
  }

  private afterSlice(): void {
    if (this.bgRunning) return
    try {
      this.drain()
      // 每条命令的控制结构 ngspice 不自动释放（约 0.3 KB/条），每片清一次
      this.ng.freeCommandMemory()
    } catch (e) {
      this.started = false
      this.fail(e)
      return
    }
    if (this.bgErrors.length) {
      const detail = this.bgErrors.join('\n')
      this.started = false
      this.fail(new NgSpiceError(classifyError(detail), detail))
      return
    }
    if (this.queue.length) {
      while (this.queue.length && !this.bgRunning) this.queue.shift()?.()
      if (this.bgRunning || this.state !== 'running') return
    }
    if (this.state !== 'running') {
      this.emit({ type: 'status', state: this.state, simTime: this.simTime })
      return
    }
    this.scheduleResume()
  }

  // 节奏：仿真领先（墙钟 × rate）就等，落后则立即继续
  private cancelResume(): void {
    clearTimeout(this.resumeTimer)
    if (this.resumeNow) clearImmediate(this.resumeNow)
    this.resumeNow = undefined
  }

  private scheduleResume(): void {
    this.cancelResume()
    let ahead = 0
    if (Number.isFinite(this.rate)) {
      ahead = (this.simTime - this.paceSim) / this.rate - (performance.now() / 1000 - this.paceWall)
      if (ahead < -MAX_LAG_SEC) this.resetPace()
    }
    const go = () => {
      this.resumeNow = undefined
      if (this.state !== 'running' || this.bgRunning) return
      try {
        this.nextSlice('bg_resume')
      } catch (e) {
        this.fail(e)
      }
    }
    // Windows 上 setTimeout 粒度约 15 ms，不需等待时用 setImmediate，否则每片白等一个时钟周期
    if (ahead > 0) this.resumeTimer = setTimeout(go, ahead * 1000)
    else this.resumeNow = setImmediate(go)
  }

  private onLog(line: string): void {
    if (NOISE.test(line)) return
    if (this.bgRunning && /^\s*error|aborted|could not be simulated/i.test(line)) this.bgErrors.push(line)
    this.emit({ type: 'log', line })
  }

  // 读出本片新增的点，插值到等间隔网格后攒块发出（技术设计 §5.1）
  private drain(): void {
    const cmd = this.current
    const chunker = this.chunker
    if (!cmd || !chunker) return
    const from = this.readIdx
    const time = this.ng.readVector('time', from)
    const n = time.length
    if (n === 0) return
    const read = (node?: string) => {
      const v = node && vecName(node)
      return v ? this.ng.readVector(v, from) : undefined
    }
    const series = cmd.probes.map((p): [Float64Array | undefined, Float64Array | undefined] =>
      p.kind === 'i'
        ? [this.ng.readVector(`${(p.source ?? '').toLowerCase()}#branch`, from), undefined]
        : [read(p.node), read(p.nodeRef)],
    )
    const pv = this.probeValues
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < pv.length; i++) {
        const [a, b] = series[i] as [Float64Array | undefined, Float64Array | undefined]
        pv[i] = (a?.[k] ?? 0) - (b?.[k] ?? 0)
      }
      chunker.push(time[k] as number, pv)
    }
    chunker.flush()
    this.readIdx = from + n
    this.simTime = time[n - 1] as number
    if (this.readIdx >= TRIM_POINTS) this.trim()
  }

  // 每个向量只留末点，下一片新数据从下标 1 开始
  private trim(): void {
    for (const v of this.ng.vectors()) {
      const n = this.ng.vectorLength(v)
      if (n > 1 && /^[\w.#]+$/.test(v)) this.ng.command(`let ${v} = ${v}[${n - 1}]`)
    }
    this.readIdx = 1
    this.trims++
  }

  private sendReadings(): void {
    const cmd = this.current
    if (this.state !== 'running' || !cmd || !this.chunker) return
    const values: Record<string, number> = {}
    cmd.probes.forEach((p, i) => {
      values[p.id] = this.probeValues[i] ?? 0
    })
    this.emit({ type: 'readings', simTime: this.simTime, values })
  }
}
