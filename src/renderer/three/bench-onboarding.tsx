import { X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

const storageKey = 'bench-onboarding-v1'

/**
 * 首次进入的三步操作提示（T0.16 P1，PRD NFR-06）。卡片本身不拦截指针，只有关闭按钮可点，
 * 学员可以直接照着在下面的场景里操作。
 */
export function BenchOnboarding({ ready }: { ready: boolean }) {
  const [open, setOpen] = useState(() => localStorage.getItem(storageKey) !== 'done')
  if (!open || !ready) return null
  const dismiss = () => {
    localStorage.setItem(storageKey, 'done')
    setOpen(false)
  }
  return (
    <aside
      aria-label="操作提示"
      className="pointer-events-none absolute top-3 left-3 z-10 w-72 rounded-lg border bg-background/95 p-3 text-sm shadow-sm"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">三步上手</h2>
        <Button size="icon-sm" variant="ghost" className="pointer-events-auto" aria-label="知道了" onClick={dismiss}>
          <X />
        </Button>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>单击挂箱或仪表，镜头推近到正对特写。</li>
        <li>点一个插孔开始接线，再点另一个插孔完成；换设备时线头会跟着走。</li>
        <li>
          右键拖动旋转、滚轮缩放；<Kbd>Esc</Kbd> 退一级，<Kbd>Home</Kbd> 回全景。
        </li>
      </ol>
    </aside>
  )
}
