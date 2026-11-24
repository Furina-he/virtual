import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

const storageKey = 'bench-onboarding-v1'
const dismissListeners = new Set<() => void>()

/** 首次点击台面设备或插孔时自动关闭操作提示并持久化（T1.9B）。 */
export function dismissBenchOnboarding(): void {
  if (typeof localStorage !== 'undefined' && localStorage.getItem(storageKey) !== 'done') {
    localStorage.setItem(storageKey, 'done')
  }
  for (const listener of dismissListeners) listener()
}

/**
 * 首次进入的三步操作提示（T0.16 P1 / T1.9B，PRD NFR-06）。
 * 位于视口左下角且不拦截指针，不遮挡主挂箱与仪器；首次点击台面设备/插孔或点“知道了”即关闭持久化。
 */
export function BenchOnboarding({ ready }: { ready: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(storageKey) !== 'done')
  useEffect(() => {
    if (!open) return
    const handleDismiss = () => setOpen(false)
    dismissListeners.add(handleDismiss)
    return () => {
      dismissListeners.delete(handleDismiss)
    }
  }, [open])
  if (!open || !ready) return null
  return (
    <aside
      aria-label="操作提示"
      className="pointer-events-none absolute bottom-2.5 left-2.5 z-10 max-w-72 rounded-md border bg-background/95 px-2.5 py-2 text-xs leading-snug shadow-sm"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="font-medium text-foreground">操作指引</h2>
        <Button
          size="icon-xs"
          variant="ghost"
          className="pointer-events-auto"
          aria-label="知道了"
          onClick={dismissBenchOnboarding}
        >
          <X />
        </Button>
      </div>
      <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
        <li>单击挂箱或仪表进入正对特写，点插孔开始接线。</li>
        <li>跨设备连线可直接在右侧快捷落点面板点选目标端子。</li>
        <li>
          右键旋转、左键平移、滚轮缩放；<Kbd>Esc</Kbd> 退一级，<Kbd>Home</Kbd> 回全景。
        </li>
      </ol>
    </aside>
  )
}
