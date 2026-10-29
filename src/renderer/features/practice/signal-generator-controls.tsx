import { adjustableSources, resolveSource, sourceKey, WAVEFORM_LABEL } from '@domain/instruments'
import type { Instrument, SignalSource } from '@shared/schema/instrument'
import { useId } from 'react'
import { RotaryKnob } from '@/components/instruments/rotary-knob'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Settings = Record<string, unknown>
type Change = (patch: Record<string, number>) => void

export function SettingSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: number
  options: string[]
  disabled?: boolean
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option, index) => (
            <SelectItem key={option} value={String(index)}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** 一路信号源的设置：波形、频率、幅值（峰峰值）、偏置、占空比、输出开关 */
export function SignalSourceControls({
  instrument,
  source,
  settings,
  onChange,
}: {
  instrument: Instrument
  source: SignalSource
  settings: Settings
  onChange: Change
}) {
  const resolved = resolveSource(instrument, settings, source)
  const ttl = resolved.waveform === 'ttl'
  const dutyApplies = resolved.waveform === 'square' || ttl
  return (
    <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2" data-source-id={source.id}>
      <SettingSelect
        label={`${source.label} 波形`}
        value={source.waveforms.indexOf(resolved.waveform)}
        options={source.waveforms.map((wave) => WAVEFORM_LABEL[wave])}
        onChange={(index) => onChange({ [sourceKey(source, 'wave')]: index })}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">{source.label} 输出</span>
        <Button
          variant={resolved.enabled ? 'default' : 'outline'}
          aria-pressed={resolved.enabled}
          onClick={() => onChange({ [sourceKey(source, 'on')]: resolved.enabled ? 0 : 1 })}
        >
          {resolved.enabled ? '输出开' : '输出关'}
        </Button>
      </div>
      {source.frequency && (
        <RotaryKnob
          label={`${source.label} 频率`}
          value={resolved.frequency}
          min={source.frequency.min}
          max={source.frequency.max}
          step={0.1}
          unit="Hz"
          onChange={(value) => onChange({ [sourceKey(source, 'freq')]: value })}
        />
      )}
      {source.amplitude && (
        <RotaryKnob
          label={`${source.label} 幅值`}
          value={ttl ? source.ttlHigh : resolved.amplitude}
          min={source.amplitude.min}
          max={source.amplitude.max}
          step={0.01}
          unit="Vpp"
          disabled={ttl}
          onChange={(value) => onChange({ [sourceKey(source, 'amp')]: value })}
        />
      )}
      {source.offset && (
        <RotaryKnob
          label={`${source.label} 直流偏置`}
          value={ttl ? source.ttlHigh / 2 : resolved.offset}
          min={source.offset.min}
          max={source.offset.max}
          step={0.01}
          unit="V"
          disabled={ttl}
          onChange={(value) => onChange({ [sourceKey(source, 'offset')]: value })}
        />
      )}
      {source.duty && (
        <RotaryKnob
          label={`${source.label} 占空比`}
          value={resolved.duty * 100}
          min={source.duty.min}
          max={source.duty.max}
          step={1}
          unit="%"
          disabled={!dutyApplies}
          onChange={(value) => onChange({ [sourceKey(source, 'duty')]: value })}
        />
      )}
    </div>
  )
}

/** 函数信号发生器（INS-08）：通道切换后编辑该通道；屏幕显示所选通道的设定值 */
export function SignalGeneratorControls({
  instrument,
  settings,
  onChange,
}: {
  instrument: Instrument
  settings: Settings
  onChange: Change
}) {
  const sources = adjustableSources(instrument)
  const selected = typeof settings.display_ch === 'number' ? settings.display_ch : 0
  const source = sources[selected] ?? sources[0]
  const synced = (instrument.signalSources ?? []).filter((entry) => entry.syncTo)
  if (!source) return null
  return (
    <div className="@container flex flex-col gap-3">
      {sources.length > 1 ? (
        <Tabs
          value={String(selected)}
          onValueChange={(next) => onChange({ display_ch: Number(next) })}
          className="gap-3"
        >
          <TabsList aria-label="通道切换">
            {sources.map((entry, index) => (
              <TabsTrigger key={entry.id} value={String(index)}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {sources.map((entry, index) => (
            <TabsContent key={entry.id} value={String(index)} className="min-w-0">
              <SignalSourceControls instrument={instrument} source={entry} settings={settings} onChange={onChange} />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <SignalSourceControls instrument={instrument} source={source} settings={settings} onChange={onChange} />
      )}
      {synced.map((entry) => (
        <p key={entry.id} className="text-xs text-muted-foreground">
          {entry.label}输出跟随 {entry.syncTo} 的频率与占空比，电平 0~{entry.ttlHigh} V。各路输出内阻 {entry.outputR}{' '}
          Ω，共用 GND。
        </p>
      ))}
    </div>
  )
}
