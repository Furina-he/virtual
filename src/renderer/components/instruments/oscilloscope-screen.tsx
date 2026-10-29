import { resolveScope } from '@domain/instruments'
import { useEffect, useRef } from 'react'
import { getInstrumentReading, readingIsWarning, readingStatusLabel } from '@/lib/instrument-readings'
import { acquireScope, scopeSummary } from '@/lib/scope-acquisition'
import { cn } from '@/lib/utils'
import { useInstrumentPanels } from '@/stores/instrument-panels'
import { channelScaleText, measurementText, paintScope, scopeStateLabel } from './scope-painter'

const SUMMARY_INTERVAL_MS = 100

/** 双通道实时波形屏：rAF 中从环形缓冲取帧并绘制，不经 React state（技术设计 §4.2） */
export function OscilloscopeScreen({
  instanceId,
  channelIds,
  className,
}: {
  instanceId: string
  channelIds: string[]
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const readout = useRef<HTMLDivElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    let frameId = 0
    let painted = -1
    let paintedSettings: unknown
    let summaryAt = 0
    let resized = true
    const observer = new ResizeObserver(() => {
      resized = true
    })
    observer.observe(element)
    const loop = (now: number) => {
      frameId = requestAnimationFrame(loop)
      const panel = useInstrumentPanels.getState().panels.find((entry) => entry.id === instanceId)
      if (!panel?.instrument.scope) return
      if (resized) {
        resized = false
        const ratio = window.devicePixelRatio || 1
        const width = Math.max(1, Math.round(element.clientWidth * ratio))
        const height = Math.max(1, Math.round(element.clientHeight * ratio))
        if (element.width !== width || element.height !== height) {
          element.width = width
          element.height = height
          painted = -1
        }
      }
      const frame = acquireScope(instanceId, panel.instrument, panel.settings, now)
      const settings = resolveScope(panel.instrument, panel.settings)
      if (frame.revision !== painted || paintedSettings !== panel.settings) {
        painted = frame.revision
        paintedSettings = panel.settings
        paintScope(context, frame, settings)
      }
      if (now - summaryAt >= SUMMARY_INTERVAL_MS) {
        summaryAt = now
        const summary = scopeSummary(frame, settings)
        const reading = getInstrumentReading(instanceId)
        const label = reading.status === 'ok' ? scopeStateLabel(summary.state) : readingStatusLabel(reading)
        element.dataset.scope = JSON.stringify(summary)
        element.dataset.state = summary.state
        element.setAttribute('aria-label', `示波器屏幕，${label}`)
        if (status.current) {
          if (status.current.textContent !== label) status.current.textContent = label
          status.current.style.color = `var(${readingIsWarning(reading) ? '--warning' : '--muted-foreground'})`
        }
        const messages = [
          reading.message,
          ...(reading.status === 'ok'
            ? settings.channels
                .filter((channel) => channel.enabled)
                .map((channel) => getInstrumentReading(instanceId, channel.id).message)
            : []),
        ]
        const message = [...new Set(messages.filter(Boolean))].join(' ')
        if (notice.current && notice.current.textContent !== message) notice.current.textContent = message
        // 读数行与屏幕同帧，10 Hz 直接写 DOM
        for (const row of readout.current?.querySelectorAll<HTMLElement>('[data-channel-index]') ?? []) {
          const index = Number(row.dataset.channelIndex)
          const text = `${channelScaleText(settings, index)}  ${measurementText(frame, settings, index)}`
          if (row.textContent !== text) row.textContent = text
        }
      }
    }
    frameId = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [instanceId])

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <p ref={notice} role="status" aria-live="polite" aria-atomic="true" className="text-xs text-muted-foreground" />
      <canvas
        ref={canvas}
        role="img"
        aria-label="示波器屏幕"
        data-instance-id={instanceId}
        className="aspect-video w-full rounded-md border"
      />
      <div ref={readout} className="flex min-w-0 flex-col font-mono text-xs text-muted-foreground">
        {channelIds.map((id, index) => (
          <span key={id} data-channel-index={index} className="truncate" />
        ))}
      </div>
      <p ref={status} className="text-xs text-muted-foreground" />
    </div>
  )
}
