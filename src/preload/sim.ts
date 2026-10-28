import { ipcRenderer } from 'electron'
import { SIM_CHANNEL, SIM_PORT_MESSAGE, type SimCommand, SimCommandSchema } from '../shared/ipc/sim'

// MessagePort 不能经 contextBridge 传递，改用 window.postMessage 转交页面（技术设计 §4.2）
ipcRenderer.on(SIM_CHANNEL.port, (e) => {
  window.postMessage(SIM_PORT_MESSAGE, '*', e.ports)
})

// 仿真控制通道与数据端口申请（技术设计 §4.2、§4.3）
export const sim = {
  /** 发送控制命令；参数不合法时抛错，不发出 */
  send: (command: SimCommand): Promise<void> =>
    ipcRenderer.invoke(SIM_CHANNEL.command, SimCommandSchema.parse(command)),
  /** 申请数据端口，端口以 window message（data 为 SIM_PORT_MESSAGE）送达；sim 重启后会自动再送一次 */
  requestPort: (): Promise<void> => ipcRenderer.invoke(SIM_CHANNEL.requestPort),
  onRestarted: (listener: () => void): (() => void) => {
    const handler = () => listener()
    ipcRenderer.on(SIM_CHANNEL.restarted, handler)
    return () => ipcRenderer.removeListener(SIM_CHANNEL.restarted, handler)
  },
}
