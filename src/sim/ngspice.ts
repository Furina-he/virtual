// ngspice-47 共享库的 koffi 绑定（技术设计 §5.1）。
// 只依赖 node 内置模块与 koffi，不引用 Electron，可直接放进 utilityProcess（T0.4）。
// 注意：ngspice.dll 每个进程只能加载、初始化一次；ControlledExit 之后实例作废，
// 由上层重启 sim 进程恢复（技术设计 §4.4）。
import { join } from 'node:path'
import koffi, { type TypeObject } from 'koffi'

export type NgErrorCode = 'no-convergence' | 'singular' | 'model' | 'crash'

const MESSAGES: Record<NgErrorCode, string> = {
  'no-convergence': '电路仿真不收敛，请检查接线是否正确、是否存在短路或开路',
  singular: '电路存在悬空节点或电压源直接并联，无法求解，请检查接线',
  model: '电路描述有误，无法载入仿真，请检查元件与接线',
  crash: '仿真内核异常退出，正在重启仿真',
}

export class NgSpiceError extends Error {
  readonly code: NgErrorCode
  readonly detail: string
  constructor(code: NgErrorCode, detail: string) {
    super(MESSAGES[code])
    this.name = 'NgSpiceError'
    this.code = code
    this.detail = detail
  }
}

// 按 ngspice 输出原文归类错误
export function classifyError(text: string): NgErrorCode {
  if (/singular matrix/i.test(text)) return 'singular'
  if (
    /timestep too small|no convergence|gmin stepping failed|source stepping failed|iteration limit|convergence/i.test(
      text,
    )
  )
    return 'no-convergence'
  return 'model'
}

const SendChar = koffi.proto('int SendChar(const char *msg, int id, void *user)')
const SendStat = koffi.proto('int SendStat(const char *msg, int id, void *user)')
const ControlledExit = koffi.proto('int ControlledExit(int status, bool immediate, bool quit, int id, void *user)')
const SendData = koffi.proto('int SendData(void *data, int count, int id, void *user)')
// 必须注册，否则 ngspice 不建立 SendData 所需的向量表，bg_run 期间收不到数据
const SendInitData = koffi.proto('int SendInitData(void *data, int id, void *user)')
const BGThreadRunning = koffi.proto('int BGThreadRunning(bool notRunning, int id, void *user)')

// vecvaluesall / vecvalues，见 sharedspice.h
const VecValues = koffi.struct('vecvalues', {
  name: 'const char *',
  creal: 'double',
  cimag: 'double',
  is_scale: 'bool',
  is_complex: 'bool',
})
const VecValuesAll = koffi.struct('vecvaluesall', { veccount: 'int', vecindex: 'int', vecsa: 'void *' })
const VectorInfo = koffi.struct('vector_info', {
  v_name: 'const char *',
  v_type: 'int',
  v_flags: 'short',
  v_realdata: 'void *',
  v_compdata: 'void *',
  v_length: 'int',
})

export type DataHandler = (index: number, names: string[], values: Float64Array) => void

export interface NgSpiceOptions {
  onLog?: (line: string) => void
  onStatus?: (status: string) => void
  /** ngspice 后台线程逐点回调，仅首次 open 时的设置生效；values 为复用缓冲，须立即拷走。上层须自行攒块，不要逐点跨线程发送（PRD 14.2） */
  onData?: DataHandler
  onBgRunning?: (running: boolean) => void
  onExit?: (status: number) => void
}

// 运行时依赖须先于 ngspice.dll 载入，否则 Windows 只在 exe 目录查找
const RUNTIME_DLLS = ['libomp140.x86_64.dll', 'sndfile.dll', 'samplerate.dll']
const LOG_KEEP = 200

let instance: NgSpice | undefined

export class NgSpice {
  /** 打开 ngspice。dir 为 resources/ngspice 所在目录；同一进程重复调用返回同一实例 */
  static open(dir: string, options: NgSpiceOptions = {}): NgSpice {
    if (instance) {
      if (instance.dir !== dir) throw new Error(`ngspice 已从 ${instance.dir} 加载，不能再从 ${dir} 加载`)
      instance.options = options
      return instance
    }
    instance = new NgSpice(dir, options)
    return instance
  }

  readonly dir: string
  private options: NgSpiceOptions
  private log: string[] = []
  // 当前操作期间的输出与失败标记
  private opLines: string[] = []
  private failed = false
  private exited = false
  private dataNames: string[] = []
  private dataAddr = 0n
  private dataPtrs: unknown[] = []
  private dataValues = new Float64Array(0)
  private readonly fn
  private readonly readBufs = new Map<string, Float64Array>()
  // 回调须常驻，防止被回收
  private readonly callbacks: bigint[] = []

  private constructor(dir: string, options: NgSpiceOptions) {
    this.dir = dir
    this.options = options
    // spinit 中 codemodel 路径依赖该变量，须在 DLL 载入前设置（DLL 的 CRT 载入时复制环境）
    process.env.SPICE_LIB_DIR = join(dir, 'share', 'ngspice').replaceAll('\\', '/')
    for (const name of RUNTIME_DLLS) koffi.load(join(dir, name))
    const lib = koffi.load(join(dir, 'ngspice.dll'))
    this.fn = {
      init: lib.func(
        'int ngSpice_Init(SendChar *, SendStat *, ControlledExit *, SendData *, SendInitData *, BGThreadRunning *, void *)',
      ),
      circ: lib.func('int ngSpice_Circ(const char **lines)'),
      command: lib.func('int ngSpice_Command(const char *cmd)'),
      running: lib.func('bool ngSpice_running()'),
      vecInfo: lib.func('void *ngGet_Vec_Info(const char *name)'),
      allVecs: lib.func('void *ngSpice_AllVecs(const char *plot)'),
      curPlot: lib.func('const char *ngSpice_CurPlot()'),
      memcpy: koffi.load('msvcrt.dll').func('void *memcpy(_Out_ double *dst, uintptr_t src, size_t n)'),
    }
    const reg = (f: (...args: never[]) => number, proto: TypeObject) => {
      const cb = koffi.register(f, koffi.pointer(proto))
      this.callbacks.push(cb)
      return cb
    }
    this.fn.init(
      reg((msg: string) => this.onChar(msg), SendChar),
      reg((msg: string) => {
        this.options.onStatus?.(msg)
        return 0
      }, SendStat),
      reg((status: number) => {
        // 不退出进程，只把实例标记为作废
        this.exited = true
        this.opLines.push(`ControlledExit status=${status}`)
        this.options.onExit?.(status)
        return 0
      }, ControlledExit),
      // 每个点都要从后台线程排队回 JS 主线程，开销大；不需要逐点数据时不注册
      options.onData ? reg((data: unknown) => this.onData(data), SendData) : null,
      reg(() => {
        this.dataAddr = 0n
        return 0
      }, SendInitData),
      reg((notRunning: boolean) => {
        this.options.onBgRunning?.(!notRunning)
        return 0
      }, BGThreadRunning),
      null,
    )
  }

  private onChar(msg: string): number {
    // ngspice 每行带 "stdout " / "stderr " 前缀
    const line = msg.replace(/^std(out|err) /, '')
    this.log.push(line)
    if (this.log.length > LOG_KEEP) this.log.shift()
    this.opLines.push(line)
    if (this.opLines.length > LOG_KEEP) this.opLines.shift()
    // 警告（含 gmin 步进失败）不算失败，只有 Error / aborted 才算
    if (/^\s*error|aborted|could not be simulated/i.test(line)) this.failed = true
    this.options.onLog?.(line)
    return 0
  }

  private onData(data: unknown): number {
    const handler = this.options.onData
    if (!handler) return 0
    // ngspice 每个点复用同一组结构体，首次解码后缓存各 vecvalues 指针，逐点只按偏移读 creal。
    // Electron 禁止指向外部内存的 ArrayBuffer，不能用 koffi.view
    const addr = koffi.address(data)
    if (addr !== this.dataAddr) {
      const all = koffi.decode(data, VecValuesAll) as { veccount: number; vecsa: unknown }
      this.dataPtrs = koffi.decode(all.vecsa, koffi.array('void *', all.veccount)) as unknown[]
      this.dataNames = this.dataPtrs.map((p) => (koffi.decode(p, VecValues) as { name: string }).name)
      this.dataValues = new Float64Array(all.veccount)
      this.dataAddr = addr
    }
    const ptrs = this.dataPtrs
    // vecvalues 布局：name 指针 8 字节，creal 在偏移 8
    for (let i = 0; i < ptrs.length; i++) this.dataValues[i] = koffi.decode(ptrs[i], 8, 'double') as number
    const index = koffi.decode(data, 4, 'int') as number
    handler(index, this.dataNames, this.dataValues)
    return 0
  }

  private detail(): string {
    return this.opLines.join('\n')
  }

  private ensureAlive(): void {
    if (this.exited) throw new NgSpiceError('crash', this.detail())
  }

  // 执行一段操作，若期间 ngspice 报错则转为 NgSpiceError
  private guard(fallback: NgErrorCode, act: () => number): void {
    this.ensureAlive()
    this.opLines = []
    this.failed = false
    const rc = act()
    if (this.exited) throw new NgSpiceError('crash', this.detail())
    if (rc === 0 && !this.failed) return
    const detail = this.detail()
    throw new NgSpiceError(this.failed ? classifyError(detail) : fallback, detail || `rc=${rc}`)
  }

  /** 载入网表（首行为标题，须以 .end 结尾），替换此前的电路 */
  load(netlist: string): void {
    this.ensureAlive()
    this.fn.command('destroy all')
    this.fn.command('remcirc')
    const lines = netlist.split(/\r?\n/)
    this.guard('model', () => this.fn.circ([...lines, null]))
    // 语法错误时 ngspice 可能只打印错误而不建电路
    if (!this.fn.curPlot()) throw new NgSpiceError('model', this.detail())
  }

  /** 执行 ngspice 命令；报错时抛出 NgSpiceError */
  command(cmd: string): void {
    this.guard('model', () => this.fn.command(cmd))
  }

  /**
   * 释放 ngspice 为已执行命令保留的控制结构。每条 ngSpice_Command 约占 0.3 KB 且不会自动释放，
   * 连续时间片推进每秒几十条命令，须定期调用（T0.6 实测）。后台线程运行中不可调用。
   */
  freeCommandMemory(): void {
    this.ensureAlive()
    this.fn.command(null)
  }

  /** 同步执行网表中的分析 */
  run(): void {
    this.guard('no-convergence', () => this.fn.command('run'))
  }

  running(): boolean {
    return !this.exited && this.fn.running()
  }

  currentPlot(): string {
    return this.fn.curPlot() ?? ''
  }

  /** 读取向量实部（复数向量取实部） */
  getVector(name: string): Float64Array {
    this.ensureAlive()
    const p = this.fn.vecInfo(name)
    if (!p) throw new NgSpiceError('model', `向量不存在: ${name}`)
    const info = koffi.decode(p, VectorInfo) as { v_realdata: unknown; v_compdata: unknown; v_length: number }
    const n = info.v_length
    if (n <= 0) return new Float64Array(0)
    if (info.v_realdata) return Float64Array.from(koffi.decode(info.v_realdata, koffi.array('double', n)) as number[])
    const c = koffi.decode(info.v_compdata, koffi.array('double', n * 2)) as number[]
    return Float64Array.from({ length: n }, (_, i) => c[i * 2] ?? 0)
  }

  /** 向量当前点数；不存在时返回 -1 */
  vectorLength(name: string): number {
    this.ensureAlive()
    const p = this.fn.vecInfo(name)
    if (!p) return -1
    return (koffi.decode(p, VectorInfo) as { v_length: number }).v_length
  }

  /**
   * 读取实数向量从 start 起的新增部分；后台线程运行中不可调用（向量可能正在扩容）。
   * 返回按向量名复用的缓冲区视图，下次读同名向量前有效。用 memcpy 拷入复用缓冲：
   * koffi.decode 每次新建 TypedArray，在连续运行中 RSS 持续上涨（T0.6 实测约 2 MB/min）。
   */
  readVector(name: string, start: number): Float64Array {
    this.ensureAlive()
    const p = this.fn.vecInfo(name)
    if (!p) throw new NgSpiceError('model', `向量不存在: ${name}`)
    const info = koffi.decode(p, VectorInfo) as { v_realdata: unknown; v_length: number }
    const n = info.v_length - start
    if (n <= 0 || !info.v_realdata) return new Float64Array(0)
    let buf = this.readBufs.get(name)
    if (!buf || buf.length < n) {
      buf = new Float64Array(Math.max(n, (buf?.length ?? 0) * 2, 4096))
      this.readBufs.set(name, buf)
    }
    this.fn.memcpy(buf, koffi.address(info.v_realdata) + BigInt(start * 8), n * 8)
    return buf.subarray(0, n)
  }

  /** 当前 plot（或指定 plot）的全部向量名 */
  vectors(plot = this.currentPlot()): string[] {
    this.ensureAlive()
    const p = this.fn.allVecs(plot)
    const names: string[] = []
    if (!p) return names
    for (let i = 0; ; i++) {
      const s = koffi.decode(p, i * 8, 'const char *') as string | null
      if (!s) break
      names.push(s)
    }
    return names
  }

  /** 最近的 ngspice 输出，供日志页使用 */
  recentLog(): string[] {
    return [...this.log]
  }
}
