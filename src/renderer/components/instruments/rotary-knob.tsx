import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { clampKnobValue, knobAngle } from './rotary-knob-values'

type KnobOption = { value: number; label: string }

export function RotaryKnob({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  options,
  disabled = false,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  options?: KnobOption[]
  disabled?: boolean
  onChange: (value: number) => void
}) {
  const labelId = useId()
  const hintId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const select = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ y: number; value: number; pointer: number } | null>(null)
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const editing = useRef(false)
  const latest = useRef({ value, min, max, step, disabled, onChange })
  latest.current = { value, min, max, step, disabled, onChange }

  useEffect(() => {
    if (!editing.current) setDraft(String(value))
  }, [value])

  const change = (next: number) => {
    const current = latest.current
    if (current.disabled) return
    const clamped = clampKnobValue(next, current.min, current.max, current.step)
    if (clamped === current.value) return
    current.value = clamped
    current.onChange(clamped)
  }
  const changeRef = useRef(change)
  changeRef.current = change
  useEffect(() => {
    const element = button.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      const current = latest.current
      if (current.disabled || event.deltaY === 0) return
      event.preventDefault()
      changeRef.current(current.value + (event.deltaY < 0 ? current.step : -current.step))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  const exactEntry = () => {
    if (disabled) return
    if (options) {
      select.current?.focus()
      setOpen(true)
    } else {
      input.current?.focus()
      input.current?.select()
    }
  }
  const commitDraft = () => {
    editing.current = false
    const next = Number(draft)
    if (!draft.trim() || !Number.isFinite(next) || next < min || next > max) {
      setError(true)
      return
    }
    setError(false)
    const clamped = clampKnobValue(next, min, max, step)
    setDraft(String(clamped))
    change(clamped)
  }
  const selectedLabel = options?.find((option) => option.value === value)?.label

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={labelId} className="text-xs text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-3">
        <Button
          ref={button}
          type="button"
          role="slider"
          variant="outline"
          className="relative size-12 touch-none rounded-full p-0"
          aria-label={`${label}旋钮`}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={selectedLabel ?? `${value} ${unit}`.trim()}
          aria-describedby={hintId}
          disabled={disabled}
          onPointerDown={(event) => {
            if (event.button !== 0 || disabled) return
            event.stopPropagation()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = { y: event.clientY, value, pointer: event.pointerId }
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (!start || start.pointer !== event.pointerId) return
            change(start.value + Math.round((start.y - event.clientY) / 8) * step)
          }}
          onPointerUp={(event) => {
            drag.current = null
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
          onLostPointerCapture={() => {
            drag.current = null
          }}
          onBlur={() => {
            drag.current = null
          }}
          onDoubleClick={exactEntry}
          onKeyDown={(event) => {
            const next: Record<string, number> = {
              ArrowUp: value + step,
              ArrowRight: value + step,
              ArrowDown: value - step,
              ArrowLeft: value - step,
              PageUp: value + step * 10,
              PageDown: value - step * 10,
              Home: min,
              End: max,
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              exactEntry()
            } else if (next[event.key] !== undefined) {
              event.preventDefault()
              change(next[event.key] as number)
            }
          }}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-2 rounded-full border bg-secondary"
            style={{ transform: `rotate(${knobAngle(value, min, max)}deg)` }}
          >
            <span className="absolute inset-x-3 top-0 h-3 bg-foreground" />
          </span>
        </Button>
        <div className="min-w-0 flex-1">
          {options ? (
            <Select
              value={String(value)}
              onValueChange={(next) => change(Number(next))}
              open={open}
              onOpenChange={setOpen}
              disabled={disabled}
            >
              <SelectTrigger ref={select} aria-labelledby={labelId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                ref={input}
                type="number"
                value={draft}
                min={min}
                max={max}
                step={step}
                disabled={disabled}
                aria-label={`${label}精确值`}
                aria-invalid={error}
                aria-describedby={error ? hintId : undefined}
                className="font-mono"
                onFocus={() => {
                  editing.current = true
                }}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setError(false)
                }}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitDraft()
                  }
                  if (event.key === 'Escape') {
                    setDraft(String(value))
                    setError(false)
                    editing.current = false
                  }
                }}
              />
              <span className="text-xs">{unit}</span>
            </div>
          )}
        </div>
      </div>
      <p id={hintId} className={error ? 'text-xs text-destructive' : 'sr-only'}>
        {error ? `请输入 ${min} 至 ${max} ${unit} 的数值。` : '上下拖动或滚轮微调；方向键调整，双击或 Enter 精确设置。'}
      </p>
    </div>
  )
}
