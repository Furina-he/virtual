import {
  isMeasurementInstrument,
  resolveInstrument,
  WATTMETER_DISPLAY_MODES,
  type WattmeterDisplayMode,
} from '@domain/instruments'
import { useId } from 'react'
import { GalvanometerDisplay } from '@/components/instruments/galvanometer-display'
import { RotaryKnob } from '@/components/instruments/rotary-knob'
import { SevenSegDisplay } from '@/components/instruments/seven-seg-display'
import { WattmeterSummary } from '@/components/instruments/wattmeter-summary'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { type PanelDef, useInstrumentPanels } from '@/stores/instrument-panels'
import assetData from '../../../../assets/layouts/catalog.json'
import { OscilloscopeControls } from './oscilloscope-controls'
import { SignalGeneratorControls } from './signal-generator-controls'

export type { PanelDef } from '@/stores/instrument-panels'

const WATTMETER_MODE_LABELS: Record<WattmeterDisplayMode, string> = {
  P: 'P (W)',
  pf: 'cosφ',
  S: 'S (VA)',
  Q: 'Q (var)',
  U: 'U (V)',
  I: 'I (A)',
}

function resistanceLabel(value: number): string {
  if (value >= 1e6) return `${Number((value / 1e6).toPrecision(6))} MΩ`
  if (value >= 1e3) return `${Number((value / 1e3).toPrecision(6))} kΩ`
  return `${Number(value.toPrecision(6))} Ω`
}

function capacitanceLabel(value: number): string {
  if (value >= 1e-6) return `${Number((value * 1e6).toPrecision(4))} µF`
  if (value >= 1e-9) return `${Number((value * 1e9).toPrecision(4))} nF`
  return `${Number((value * 1e12).toPrecision(4))} pF`
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
      {instrument.scope ? (
        <OscilloscopeControls
          instanceId={panel.id}
          instrument={instrument}
          settings={panel.settings}
          onChange={(patch) => setSettings(panel.id, patch)}
        />
      ) : instrument.kind === 'galvanometer' ? (
        <GalvanometerDisplay instanceId={panel.id} />
      ) : measurement ? (
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
          {config.wattmeter && (
            <>
              <fieldset className="flex flex-wrap gap-1 border-0 p-0" aria-label="功率表显示量切换">
                {WATTMETER_DISPLAY_MODES.map((mode) => (
                  <Button
                    key={mode}
                    size="xs"
                    variant={config.wattmeter?.displayMode === mode ? 'default' : 'outline'}
                    onClick={() => setSettings(panel.id, { displayMode: mode })}
                  >
                    {WATTMETER_MODE_LABELS[mode]}
                  </Button>
                ))}
              </fieldset>
              <WattmeterSummary instanceId={panel.id} />
            </>
          )}
          {instrument.inputChannels && instrument.inputChannels.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">输入通道</span>
              <fieldset className="flex gap-1 border-0 p-0" aria-label="输入通道选择">
                {instrument.inputChannels.map((channel) => (
                  <Button
                    key={channel.id}
                    size="xs"
                    variant={config.channelId === channel.id ? 'default' : 'outline'}
                    onClick={() => setSettings(panel.id, { channel: channel.id })}
                  >
                    {channel.label}
                  </Button>
                ))}
              </fieldset>
            </div>
          )}
          {instrument.ranges.length > 1 && (
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
          )}
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
            {!canChooseImpedance && config.internalR && (
              <div>
                内阻 {resistanceLabel(config.internalR)}
                {config.inputC ? ` ∥ ${capacitanceLabel(config.inputC)}` : ''}
              </div>
            )}
            {config.wattmeter && <div>电流端内阻 {resistanceLabel(config.wattmeter.currentR)}</div>}
            <div>
              分辨率 {Number((config.resolution / config.displayScale).toPrecision(6))} {config.unit}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {config.wattmeter ? (
              <>
                电压端：{instrument.jacks.find((jack) => jack.id === config.positiveJack)?.label} /{' '}
                {instrument.jacks.find((jack) => jack.id === config.negativeJack)?.label} · 电流端：
                {instrument.jacks.find((jack) => jack.id === config.wattmeter?.currentPositiveJack)?.label} /{' '}
                {instrument.jacks.find((jack) => jack.id === config.wattmeter?.currentNegativeJack)?.label}
              </>
            ) : (
              <>
                测量插孔：{instrument.jacks.find((jack) => jack.id === config.positiveJack)?.label} /{' '}
                {instrument.jacks.find((jack) => jack.id === config.negativeJack)?.label}
              </>
            )}
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
      {!!instrument.signalSources?.length && !instrument.scope && (
        <SignalGeneratorControls
          instrument={instrument}
          settings={panel.settings}
          onChange={(patch) => setSettings(panel.id, patch)}
        />
      )}
      {instrument.kind === 'dcSupply' && (
        <p className="text-xs text-muted-foreground">当前为恒压输出；恒流限流待后续实现。</p>
      )}
    </div>
  )
}
