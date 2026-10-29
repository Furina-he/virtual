// sim 子进程宿主（技术设计 §4.2、§4.4）：启动/重启 utilityProcess，转发控制命令，
// 为每个渲染进程撮合一对 MessagePort 作为数据通道。
import { join } from 'node:path'
import { app, ipcMain, MessageChannelMain, type UtilityProcess, utilityProcess, type WebContents } from 'electron'
import {
  patchNetlistParameters,
  SIM_CHANNEL,
  type SimChildMessage,
  type SimCommand,
  SimCommandSchema,
  SimEventSchema,
  type SimHostMessage,
} from '../shared/ipc/sim'

type Load = Extract<SimCommand, { type: 'load' }>

// 连续快速崩溃时停止重启，避免坏网表反复拉起进程
const QUICK_CRASH_MS = 5000
const MAX_QUICK_CRASHES = 3

function ngspiceDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'ngspice') : join(app.getAppPath(), 'resources', 'ngspice')
}

export class SimHost {
  private child?: UtilityProcess
  private readonly clients = new Set<WebContents>()
  private lastLoad?: Load
  private pacing?: Extract<SimCommand, { type: 'setPacing' }>
  private readonly pendingParameters = new Map<string, Load>()
  private nextParameterRequest = 0
  private running = false
  private startedAt = 0
  private quickCrashes = 0
  private quitting = false

  constructor() {
    ipcMain.handle(SIM_CHANNEL.command, (_e, raw: unknown) => {
      let cmd = SimCommandSchema.parse(raw)
      if (cmd.type === 'alter') {
        cmd = { ...cmd, requestId: cmd.requestId ?? `host-alter-${++this.nextParameterRequest}` }
        if (this.lastLoad) this.pendingParameters.set(cmd.requestId as string, this.lastLoad)
      }
      this.track(cmd)
      this.post({ type: 'command', command: cmd })
    })
    ipcMain.handle(SIM_CHANNEL.requestPort, (e) => this.connect(e.sender))
    app.on('before-quit', () => {
      this.quitting = true
      this.child?.kill()
    })
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(): void {
    this.startedAt = Date.now()
    const child = utilityProcess.fork(join(__dirname, 'sim.js'), [], {
      serviceName: 'virtual-sim',
      env: { ...process.env, VIRTUAL_NGSPICE_DIR: ngspiceDir() },
      stdio: 'inherit',
    })
    this.child = child
    child.on('message', (raw: SimChildMessage) => {
      if (this.child !== child || (raw?.type !== 'altered' && raw?.type !== 'parameter-error')) return
      const parsed = SimEventSchema.safeParse(raw.event)
      if (!parsed.success) return
      if (parsed.data.type === 'error' && raw.type === 'parameter-error') {
        if (parsed.data.requestId) this.pendingParameters.delete(parsed.data.requestId)
        this.running = false
        return
      }
      if (parsed.data.type !== 'altered') return
      const event = parsed.data
      const load = event.requestId ? this.pendingParameters.get(event.requestId) : undefined
      if (event.requestId) this.pendingParameters.delete(event.requestId)
      if (!load || load !== this.lastLoad) return
      try {
        this.lastLoad = { ...load, netlist: patchNetlistParameters(load.netlist, event.changes) }
        for (const [requestId, owner] of this.pendingParameters) {
          if (owner === load) this.pendingParameters.set(requestId, this.lastLoad)
        }
      } catch (error) {
        console.error('Cannot persist the acknowledged module parameters', error)
      }
    })
    child.on('exit', (code) => this.onExit(child, code))
    for (const wc of this.clients) this.broker(wc)
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child || this.quitting) return
    this.child = undefined
    this.pendingParameters.clear()
    this.quickCrashes = Date.now() - this.startedAt < QUICK_CRASH_MS ? this.quickCrashes + 1 : 0
    if (this.quickCrashes > MAX_QUICK_CRASHES) {
      console.error(`sim 进程连续崩溃，停止重启（code=${code}）`)
      return
    }
    this.start()
    // 重新下发当前网表并恢复运行状态
    if (this.lastLoad) this.post({ type: 'command', command: this.lastLoad })
    if (this.pacing) this.post({ type: 'command', command: this.pacing })
    if (this.running) this.post({ type: 'command', command: { type: 'run' } })
    for (const wc of this.clients) wc.send(SIM_CHANNEL.restarted)
  }

  private track(cmd: SimCommand): void {
    if (cmd.type === 'load') {
      this.lastLoad = cmd
      this.pendingParameters.clear()
      this.running = false
    } else if (cmd.type === 'run') this.running = true
    else if (cmd.type === 'pause' || cmd.type === 'stop') this.running = false
    else if (cmd.type === 'setPacing') this.pacing = cmd
  }

  private post(msg: SimHostMessage, ports?: Electron.MessagePortMain[]): void {
    this.child?.postMessage(msg, ports)
  }

  // 渲染端（主窗口或面板窗口）请求数据端口；sim 重启后自动重新撮合
  private connect(wc: WebContents): void {
    if (!this.clients.has(wc)) {
      this.clients.add(wc)
      wc.once('destroyed', () => this.clients.delete(wc))
    }
    this.broker(wc)
  }

  private broker(wc: WebContents): void {
    if (!this.child || wc.isDestroyed()) return
    const { port1, port2 } = new MessageChannelMain()
    this.post({ type: 'port' }, [port1])
    wc.postMessage(SIM_CHANNEL.port, null, [port2])
  }
}
