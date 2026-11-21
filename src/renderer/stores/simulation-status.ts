import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { RuntimeStatus } from '../lib/instrument-runtime'

const INITIAL_STATUS: RuntimeStatus = { state: 'off', message: '未运行' }

/** 独立仿真状态切片（技术设计 §5.4）：仅状态栏订阅，不引起工作台和 3D 视口重渲染。 */
export const simulationStatusStore = createStore<RuntimeStatus>()(() => INITIAL_STATUS)

export function setSimulationStatus(status: RuntimeStatus): void {
  simulationStatusStore.setState(status, true)
}

export function resetSimulationStatus(): void {
  simulationStatusStore.setState(INITIAL_STATUS, true)
}

export function useSimulationStatus<T>(selector: (state: RuntimeStatus) => T): T {
  return useStore(simulationStatusStore, selector)
}
