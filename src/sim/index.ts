// sim 子进程入口（utilityProcess，技术设计 §4.1）。
// parentPort：main 下发控制命令与数据端口；数据端口：直连渲染端，推送 SimEvent。
import type { MessagePortMain } from 'electron'
import { SimCommandSchema, type SimEvent, type SimHostMessage } from '../shared/ipc/sim'
import { SimSession } from './session'

const dir = process.env.VIRTUAL_NGSPICE_DIR
if (!dir) throw new Error('缺少 VIRTUAL_NGSPICE_DIR')

const ports = new Set<MessagePortMain>()

// MessagePortMain 只能 transfer 端口，Float32Array 走结构化克隆（每块拷贝一次）
function send(event: SimEvent): void {
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
