// sim 子进程入口（utilityProcess，技术设计 §4.1）。
// parentPort：main 下发控制命令与数据端口；数据端口：直连渲染端，推送 SimEvent。
import type { MessagePortMain } from 'electron'
import koffi from 'koffi'
import { type SimChildMessage, SimCommandSchema, type SimEvent, type SimHostMessage } from '../shared/ipc/sim'
import { SimSession } from './session'

// Windows 11 混合架构（P/E 核）下，Chromium utilityProcess 在窗口非前台/被遮挡时可能被系统纳入
// EcoQoS（效率模式）并调度到能效核，导致连续实时仿真出现 ~1.7× 突降；此处显式关闭本子进程的
// 电源节流并提升到 ABOVE_NORMAL，不依赖特定 CPU 核数，旧系统或非 Windows 静默跳过。
function disableWindowsEcoQos(): void {
  if (process.platform !== 'win32') return
  try {
    const k32 = koffi.load('kernel32.dll')
    const GetCurrentProcess = k32.func('void* __stdcall GetCurrentProcess()')
    const SetPriorityClass = k32.func('int __stdcall SetPriorityClass(void* hProcess, uint32_t dwPriorityClass)')
    koffi.struct('SIM_PROCESS_POWER_THROTTLING_STATE', {
      Version: 'uint32_t',
      ControlMask: 'uint32_t',
      StateMask: 'uint32_t',
    })
    const SetProcessInformation = k32.func(
      'int __stdcall SetProcessInformation(void* hProcess, int ProcessInformationClass, SIM_PROCESS_POWER_THROTTLING_STATE* ProcessInformation, uint32_t ProcessInformationSize)',
    )
    const current = GetCurrentProcess()
    SetPriorityClass(current, 0x00008000)
    // ProcessPowerThrottling = 4; Version = 1; PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 1; StateMask = 0（禁用 EcoQoS）
    SetProcessInformation(current, 4, { Version: 1, ControlMask: 1, StateMask: 0 }, 12)
  } catch {
    // 非受支持系统版本静默回退默认调度
  }
}

disableWindowsEcoQos()

const dir = process.env.VIRTUAL_NGSPICE_DIR
if (!dir) throw new Error('缺少 VIRTUAL_NGSPICE_DIR')

const ports = new Set<MessagePortMain>()

// MessagePortMain 只能 transfer 端口，Float32Array 走结构化克隆（每块拷贝一次）
function send(event: SimEvent): void {
  if (event.type === 'altered') {
    const message: SimChildMessage = { type: 'altered', event }
    process.parentPort.postMessage(message)
  } else if (event.type === 'error' && event.requestId) {
    const message: SimChildMessage = { type: 'parameter-error', event }
    process.parentPort.postMessage(message)
  }
  for (const port of ports) port.postMessage(event)
}

const session = new SimSession(dir, send, () => process.exit(1))

process.parentPort.on('message', (e) => {
  const msg = e.data as SimHostMessage
  if (msg.type === 'port') {
    const port = e.ports[0]
    if (!port) return
    ports.add(port)
    port.on('close', () => ports.delete(port))
    port.start()
    return
  }
  if (msg.type === 'command') {
    const parsed = SimCommandSchema.safeParse(msg.command)
    if (parsed.success) session.handle(parsed.data)
    else send({ type: 'log', line: `无效仿真命令：${parsed.error.message}` })
  }
})
