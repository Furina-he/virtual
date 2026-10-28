import type { StoreApi } from 'zustand'

/**
 * 让一个 zustand store 在主窗口与弹出窗口之间保持一致（ADR-007）。
 * 只同步 pick 选出的可序列化部分；高频仿真数据不走这里（技术设计 §4.2）。
 */
export function syncAcrossWindows<T extends object>(
  store: StoreApi<T>,
  key: string,
  pick: (state: T) => Partial<T>,
): () => void {
  let applying = false
  const apply = (state: unknown) => {
    applying = true
    store.setState(state as Partial<T>)
    applying = false
  }
  void window.api.sync.get(key).then((cached) => {
    // 先打开的窗口把自己的初始状态发布出去，后打开的窗口取缓存
    if (cached === undefined) window.api.sync.publish(key, pick(store.getState()))
    else apply(cached)
  })
  const offUpdate = window.api.sync.onUpdate((msg) => {
    if (msg.key === key) apply(msg.state)
  })
  const offStore = store.subscribe((state) => {
    if (!applying) window.api.sync.publish(key, pick(state))
  })
  return () => {
    offUpdate()
    offStore()
  }
}
