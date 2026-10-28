import { isMeasurementInstrument, resolveInstrument } from '@domain/instruments'
import { useId } from 'react'
import { RotaryKnob } from '@/components/instruments/rotary-knob'
import { SevenSegDisplay } from '@/components/instruments/seven-seg-display'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { type PanelDef, useInstrumentPanels } from '@/stores/instrument-panels'
import assetData from '../../../../assets/layouts/catalog.json'

export type { PanelDef } from '@/stores/instrument-panels'

function resistanceLabel(value: number): string {
  if (value >= 1e6) return `${Number((value / 1e6).toPrecision(6))} MΩ`
  if (value >= 1e3) return `${Number((value / 1e3).toPrecision(6))} kΩ`
  return `${Number(value.toPrecision(6))} Ω`
}

export function InstrumentPanel({ panel, className }: { panel: PanelDef; className?: string }) {
  const setSettings = useInstrumentPanels((state) => state.setSettings)
  const resistanceId = useId()
  const instrument = panel.instrument
  const measurement = isMeasurementInstrument(instrument)
  let config: ReturnType<typeof resolveInstrument> | undefined
  let configError: string | undefined
  if (measurement) {
    try {
      config = resolveInstrument(instrument, panel.settings)
    } catch (error) {
      configError = error instanceof Error ? error.message : '仪表设置无效，请恢复默认设置。'
    }
  }
  const asset = assetData.assets.find((entry) => entry.id === instrument.id)
  const rangeIndex = config ? instrument.ranges.findIndex((range) => range.id === config.range.id) : 0
  const canChooseImpedance = config && (config.mode === 'dcv' || config.mode === 'acv') && instrument.internalROptions

  return (
    <div
      className={cn('flex min-w-0 flex-col gap-3 p-3', className)}
      data-panel-id={panel.id}
      data-range={config?.range.id}
      data-internal-resistance={config?.internalR}
    >
      {configError && (
        <p role="alert" className="text-xs text-destructive">
          {configError}
        </p>
      )}
      {measurement ? (
        <SevenSegDisplay instanceId={panel.id} />
      ) : (
        (asset?.screens ?? [{ id: 'MAIN' }]).map((screen) => (
          <SevenSegDisplay
            key={screen.id}
            instanceId={panel.id}
            screenId={screen.id === 'MAIN' ? 'main' : screen.id}
            label={`${screen.id} 输出读数`}
          />
        ))
      )}
      {config && (
        <>
          <RotaryKnob
            label={instrument.kind === 'multimeter' ? '档位' : '量程'}
            value={rangeIndex}
            min={0}
            max={instrument.ranges.length - 1}
            options={instrument.ranges.map((range, index) => ({ value: index, label: range.label ?? range.id }))}
            onChange={(index) => {
              const next = instrument.ranges[index]
              if (next) setSettings(panel.id, { range: next.id })
            }}
          />
          {canChooseImpedance && (
            <div className="flex flex-col gap-1">
              <label htmlFor={resistanceId} className="text-xs text-muted-foreground">
                输入内阻
              </label>
              <Select
                value={String(config.internalR)}
                onValueChange={(next) => setSettings(panel.id, { internalR: Number(next) })}
              >
                <SelectTrigger id={resistanceId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {canChooseImpedance.map((resistance) => (
                    <SelectItem key={resistance} value={String(resistance)}>
                      {resistanceLabel(resistance)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {!canChooseImpedance && config.internalR && <div>内阻 {resistanceLabel(config.internalR)}</div>}
            <div>
              分辨率 {Number((config.resolution / config.displayScale).toPrecision(6))} {config.unit}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            测量插孔：{instrument.jacks.find((jack) => jack.id === config.positiveJack)?.label} /{' '}
            {instrument.jacks.find((jack) => jack.id === config.negativeJack)?.label}
          </p>
        </>
      )}
      {(instrument.settingsControls ?? []).map((control) => (
        <RotaryKnob
          key={control.id}
          label={control.label}
          value={
            typeof panel.settings[control.id] === 'number' ? (panel.settings[control.id] as number) : control.default
          }
          min={control.min}
          max={control.max}
          step={control.step}
          unit={control.unit}
          onChange={(value) => setSettings(panel.id, { [control.id]: value })}
        />
      ))}
      {instrument.kind === 'dcSupply' && (
        <p className="text-xs text-muted-foreground">当前为恒压输出；恒流限流待后续实现。</p>
      )}
    </div>
  )
}
