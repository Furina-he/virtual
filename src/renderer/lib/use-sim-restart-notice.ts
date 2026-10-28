import { useEffect } from 'react'
import { toast } from 'sonner'
import { getSimClient } from './sim-client'

/** sim 进程崩溃自动重启后提示（技术设计 §4.4）；挂在主布局一次即可 */
export function useSimRestartNotice(): void {
  useEffect(() => getSimClient().onRestarted(() => toast('仿真已重启')), [])
}
