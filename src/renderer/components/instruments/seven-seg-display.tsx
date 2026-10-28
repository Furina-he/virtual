import { useEffect, useRef } from 'react'
import {
  getInstrumentReading,
  readingIsWarning,
  readingStatusLabel,
  subscribeInstrumentReadings,
} from '@/lib/instrument-readings'
import { cn } from '@/lib/utils'

export function SevenSegDisplay({
  instanceId,
  screenId = 'main',
  label = '读数',
  className,
}: {
  instanceId: string
  screenId?: string
  label?: string
  className?: string
}) {
  const output = useRef<HTMLOutputElement>(null)
  const digits = useRef<HTMLSpanElement>(null)
  const unit = useRef<HTMLSpanElement>(null)
  const mode = useRef<HTMLSpanElement>(null)
  const status = useRef<HTMLSpanElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const render = () => {
      const reading = getInstrumentReading(instanceId, screenId)
      if (!output.current || !digits.current || !unit.current || !mode.current || !status.current || !notice.current)
        return
      digits.current.textContent = reading.text
      unit.current.textContent = reading.unit
      mode.current.textContent = reading.mode ?? ''
      status.current.textContent = readingStatusLabel(reading)
      if (notice.current.textContent !== (reading.message ?? '')) notice.current.textContent = reading.message ?? ''
      output.current.dataset.reading = reading.text
      output.current.dataset.status = reading.status
      output.current.dataset.unit = reading.unit
      output.current.style.color = `var(${readingIsWarning(reading) ? '--warning' : '--foreground'})`
    }
    render()
    return subscribeInstrumentReadings(instanceId, render)
  }, [instanceId, screenId])

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <output
        ref={output}
        aria-label={label}
        aria-live="off"
        data-instance-id={instanceId}
        data-screen-id={screenId}
        className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted px-3 py-2"
      >
        <span className="flex min-w-0 justify-between gap-2 text-xs">
          <span ref={mode} className="font-mono" />
          <span ref={status} />
        </span>
        <span className="flex items-baseline justify-end gap-2 whitespace-nowrap">
          <span ref={digits} className="font-lcd text-2xl tabular-nums">
            --.---
          </span>
          <span ref={unit} className="font-mono text-sm" />
        </span>
      </output>
      <p ref={notice} role="status" aria-live="polite" className="text-xs text-muted-foreground" />
    </div>
  )
}
