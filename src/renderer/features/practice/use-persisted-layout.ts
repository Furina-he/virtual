import { useDefaultLayout } from 'react-resizable-panels'

// 分栏尺寸存 localStorage，重启后恢复（PRD 15.3）
export function usePersistedLayout(id: string) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id, storage: localStorage })
  return { id, defaultLayout, onLayoutChanged }
}
