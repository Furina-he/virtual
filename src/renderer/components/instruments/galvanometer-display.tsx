import { useEffect, useRef } from 'react'
import {
  getInstrumentReading,
  readingIsWarning,
  readingStatusLabel,
  subscribeInstrumentReadings,
} from '@/lib/instrument-readings'
import { cn } from '@/lib/utils'

const MAX_ANGLE_DEG = 45

export function GalvanometerDisplay({
  instanceId,
  label = '检流计读数',
  className,
}: {
  instanceId: string
  label?: string
  className?: string
}) {
  const output = useRef<HTMLOutputElement>(null)
  const needle = useRef<SVGLineElement>(null)
  const digits = useRef<HTMLSpanElement>(null)
  const unit = useRef<HTMLSpanElement>(null)
  const status = useRef<HTMLSpanElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const render = () => {
      const reading = getInstrumentReading(instanceId, 'main')
      if (!output.current || !needle.current || !digits.current || !unit.current || !status.current || !notice.current)
        return
      const deflection = reading.deflection ?? 0
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(deflection) ? deflection : 0))
      const angle = clamped * MAX_ANGLE_DEG
      needle.current.setAttribute('transform', `rotate(${angle.toFixed(2)} 100 96)`)
      digits.current.textContent = reading.text
      unit.current.textContent = reading.unit
      status.current.textContent = readingStatusLabel(reading)
      if (notice.current.textContent !== (reading.message ?? '')) notice.current.textContent = reading.message ?? ''
      output.current.dataset.reading = reading.text
      output.current.dataset.status = reading.status
      output.current.dataset.unit = reading.unit
      output.current.dataset.deflection = clamped.toFixed(3)
      output.current.style.color = `var(${readingIsWarning(reading) ? '--warning' : '--foreground'})`
    }
    render()
    return subscribeInstrumentReadings(instanceId, render)
  }, [instanceId])

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <output
        ref={output}
        aria-label={label}
        aria-live="off"
        data-instance-id={instanceId}
        data-screen-id="main"
        className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted px-3 py-2"
      >
        <span className="flex min-w-0 justify-between gap-2 text-xs">
          <span className="font-mono">G ±100 µA</span>
          <span ref={status} />
        </span>
        <svg viewBox="0 0 200 108" className="h-24 w-full" role="img" aria-label="零位居中指针表头">
          <path
            d="M 38 64 A 74 74 0 0 1 162 64"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.35"
            strokeWidth="2"
          />
          {[-1, -0.5, 0, 0.5, 1].map((mark) => {
            const rad = ((mark * MAX_ANGLE_DEG - 90) * Math.PI) / 180
            const x1 = 100 + Math.cos(rad) * 66
            const y1 = 96 + Math.sin(rad) * 66
            const x2 = 100 + Math.cos(rad) * 74
            const y2 = 96 + Math.sin(rad) * 74
            const tx = 100 + Math.cos(rad) * 55
            const ty = 96 + Math.sin(rad) * 55
            const labelText = mark === 0 ? '0' : `${mark > 0 ? '+' : ''}${mark * 100}`
            return (
              <g key={mark}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={mark === 0 ? 2.2 : 1.4} />
                <text
                  x={tx}
                  y={ty}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="currentColor"
                  fontSize="9"
                  fontFamily="var(--font-mono)"
                >
                  {labelText}
                </text>
              </g>
            )
          })}
          <line
            ref={needle}
            x1="100"
            y1="96"
            x2="100"
            y2="28"
            stroke="var(--destructive)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="100" cy="96" r="4" fill="currentColor" />
        </svg>
        <span className="flex items-baseline justify-end gap-2 whitespace-nowrap">
          <span ref={digits} className="font-lcd text-xl tabular-nums">
            --.---
          </span>
          <span ref={unit} className="font-mono text-xs" />
        </span>
      </output>
      <p ref={notice} role="status" aria-live="polite" className="text-xs text-muted-foreground" />
    </div>
  )
}
