import { useEffect, useRef } from 'react'
import { getInstrumentReading, subscribeInstrumentReadings } from '@/lib/instrument-readings'
import { cn } from '@/lib/utils'

const NATURE_TEXT = {
  R: '阻性 R',
  L: '感性 L',
  C: '容性 C',
  NONE: '无负载',
} as const

export function WattmeterSummary({ instanceId, className }: { instanceId: string; className?: string }) {
  const pRef = useRef<HTMLSpanElement>(null)
  const qRef = useRef<HTMLSpanElement>(null)
  const sRef = useRef<HTMLSpanElement>(null)
  const pfRef = useRef<HTMLSpanElement>(null)
  const uRef = useRef<HTMLSpanElement>(null)
  const iRef = useRef<HTMLSpanElement>(null)
  const natureRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const render = () => {
      const metrics = getInstrumentReading(instanceId, 'main').metrics
      if (
        !pRef.current ||
        !qRef.current ||
        !sRef.current ||
        !pfRef.current ||
        !uRef.current ||
        !iRef.current ||
        !natureRef.current
      )
        return
      if (!metrics) {
        pRef.current.textContent = '--'
        qRef.current.textContent = '--'
        sRef.current.textContent = '--'
        pfRef.current.textContent = '--'
        uRef.current.textContent = '--'
        iRef.current.textContent = '--'
        natureRef.current.textContent = '--'
        return
      }
      pRef.current.textContent = `${metrics.P.toFixed(1)} W`
      qRef.current.textContent = `${metrics.Q.toFixed(1)} var`
      sRef.current.textContent = `${metrics.S.toFixed(1)} VA`
      pfRef.current.textContent = metrics.pf.toFixed(3)
      uRef.current.textContent = `${metrics.U.toFixed(1)} V`
      iRef.current.textContent = `${metrics.I.toFixed(3)} A`
      natureRef.current.textContent = NATURE_TEXT[metrics.loadNature]
    }
    render()
    return subscribeInstrumentReadings(instanceId, render)
  }, [instanceId])

  return (
    <div
      data-wattmeter-summary={instanceId}
      className={cn('grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border bg-muted/40 px-2.5 py-2 text-xs', className)}
    >
      <div className="flex justify-between gap-1">
        <span className="text-muted-foreground">P</span>
        <span ref={pRef} className="font-mono tabular-nums" data-metric="P">
          --
        </span>
      </div>
      <div className="flex justify-between gap-1">
        <span className="text-muted-foreground">cosφ</span>
        <span ref={pfRef} className="font-mono tabular-nums" data-metric="pf">
          --
        </span>
      </div>
      <div className="flex justify-between gap-1">
        <span className="text-muted-foreground">S</span>
        <span ref={sRef} className="font-mono tabular-nums" data-metric="S">
          --
        </span>
      </div>
      <div className="flex justify-between gap-1">
        <span className="text-muted-foreground">Q</span>
        <span ref={qRef} className="font-mono tabular-nums" data-metric="Q">
          --
        </span>
      </div>
      <div className="flex justify-between gap-1">
        <span className="text-muted-foreground">U</span>
        <span ref={uRef} className="font-mono tabular-nums" data-metric="U">
          --
        </span>
      </div>
      <div className="flex justify-between gap-1">
        <span className="text-muted-foreground">I</span>
        <span ref={iRef} className="font-mono tabular-nums" data-metric="I">
          --
        </span>
      </div>
      <div className="col-span-2 flex justify-between gap-1 border-t pt-1">
        <span className="text-muted-foreground">负载性质</span>
        <span ref={natureRef} className="font-mono" data-metric="loadNature">
          --
        </span>
      </div>
    </div>
  )
}
