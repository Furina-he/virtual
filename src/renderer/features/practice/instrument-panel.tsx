import {
  DC_CURRENT_SOURCE_RANGES,
  isMeasurementInstrument,
  resolveDcSupply,
  resolveInstrument,
  WATTMETER_DISPLAY_MODES,
  type WattmeterDisplayMode,
} from '@domain/instruments'
import { memo, useId } from 'react'
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

export const InstrumentPanel = memo(function InstrumentPanel({
  panel,
  className,
}: {
  panel: PanelDef
  className?: string
}) {
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
  const settingsControls = instrument.settingsControls ?? []
  const syncedOutputs = (instrument.signalSources ?? []).filter((entry) => entry.syncTo)

  const renderSettingsControls = () => (
    <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
      {settingsControls.map((control) => {
        const currentValue =
          typeof panel.settings[control.id] === 'number' ? (panel.settings[control.id] as number) : control.default
        const voltagePresets =
          instrument.kind === 'dcSupply' && (control.id === 'ch1_v' || control.id === 'ch2_v')
            ? [5, 6, 12].filter((preset) => preset >= control.min && preset <= control.max)
            : []
        return (
          <div key={control.id} className="flex min-w-0 flex-col gap-1.5">
            <RotaryKnob
              label={control.label}
              value={currentValue}
              min={control.min}
              max={control.max}
              step={control.step}
              unit={control.unit}
              onChange={(value) => setSettings(panel.id, { [control.id]: value })}
            />
            {voltagePresets.length > 0 && (
              <fieldset aria-label={`${control.label}常用预设`} className="flex flex-wrap gap-1 border-0 p-0">
                {voltagePresets.map((preset) => (
                  <Button
                    key={preset}
                    size="xs"
                    variant={Math.abs(currentValue - preset) < 1e-6 ? 'default' : 'outline'}
                    onClick={() => setSettings(panel.id, { [control.id]: preset })}
                  >
                    {preset} V
                  </Button>
                ))}
              </fieldset>
            )}
          </div>
        )
      })}
    </div>
  )

  return (
    <div
      className={cn('@container flex min-w-0 flex-col gap-3 p-3', className)}
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
      ) : instrument.kind === 'dcSupply' ? (
        (() => {
          const dc = resolveDcSupply(instrument, panel.settings)
          return (
            <div className="flex flex-col gap-3 @md:flex-row @md:items-start" data-wide-panel-layout="dcSupply">
              <div className="flex min-w-0 flex-col gap-2 @md:sticky @md:top-0 @md:w-5/12" data-panel-screen-pane>
                <div className="grid grid-cols-2 gap-2">
                  <SevenSegDisplay instanceId={panel.id} screenId="CH1" label="CH1 输出读数" />
                  <SevenSegDisplay instanceId={panel.id} screenId="CH2" label="CH2 输出读数" />
                  <SevenSegDisplay instanceId={panel.id} screenId="V5" label="+5V 固定输出读数" />
                  <SevenSegDisplay instanceId={panel.id} screenId="IS" label="恒流源 Is 输出读数" />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">双路模式</span>
                  <Button
                    size="xs"
                    variant={dc.tracking ? 'default' : 'outline'}
                    aria-pressed={dc.tracking}
                    onClick={() => setSettings(panel.id, { tracking: dc.tracking ? 0 : 1 })}
                  >
                    {dc.tracking ? '串联跟踪 ±V' : '独立双路'}
                  </Button>
                </div>
                {dc.currentSource && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">恒流源档位</span>
                    <fieldset className="flex gap-1 border-0 p-0" aria-label="恒流源档位选择">
                      {DC_CURRENT_SOURCE_RANGES.map((rangeMa, index) => (
                        <Button
                          key={rangeMa}
                          size="xs"
                          variant={dc.currentSource?.rangeMa === rangeMa ? 'default' : 'outline'}
                          onClick={() => setSettings(panel.id, { is_range: index })}
                        >
                          {rangeMa} mA
                        </Button>
                      ))}
                    </fieldset>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  支持 CV/CC 自动限流、CH1−与CH2+外接串联正负电源、固定 +5 V/1 A 及 0~500 mA 恒流源。
                </p>
              </div>
              <div className="@container min-w-0 flex-1">{renderSettingsControls()}</div>
            </div>
          )
        })()
      ) : instrument.kind === 'acSupply' ? (
        <div className="flex flex-col gap-3 @md:flex-row @md:items-start" data-wide-panel-layout="acSupply">
          <div className="flex min-w-0 flex-col gap-2 @md:sticky @md:top-0 @md:w-5/12" data-panel-screen-pane>
            <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
              <SevenSegDisplay instanceId={panel.id} screenId="PHASE" label="PHASE 输出读数" />
              <SevenSegDisplay instanceId={panel.id} screenId="LINE" label="LINE 输出读数" />
            </div>
            <p className="text-xs text-muted-foreground">
              三相四线 U / V / W / N（50 Hz 互差 120°），线电压 = √3 × 相电压，单相取任一相与 N。
            </p>
          </div>
          <div className="@container min-w-0 flex-1">{renderSettingsControls()}</div>
        </div>
      ) : instrument.signalSources?.length ? (
        <div className="flex flex-col gap-3 @md:flex-row @md:items-start" data-wide-panel-layout="funcGen">
          <div className="flex min-w-0 flex-col gap-2 @md:sticky @md:top-0 @md:w-2/5" data-panel-screen-pane>
            {(asset?.screens ?? [{ id: 'MAIN' }]).map((screen) => (
              <SevenSegDisplay
                key={screen.id}
                instanceId={panel.id}
                screenId={screen.id === 'MAIN' ? 'main' : screen.id}
                label={`${screen.id} 输出读数`}
              />
            ))}
            {syncedOutputs.map((entry) => (
              <p key={entry.id} className="text-xs text-muted-foreground">
                {entry.label}输出跟随 {entry.syncTo} 的频率与占空比，电平 0~{entry.ttlHigh} V。各路输出内阻{' '}
                {entry.outputR} Ω，共用 GND。
              </p>
            ))}
          </div>
          <div className="@container min-w-0 flex-1">
            <SignalGeneratorControls
              instrument={instrument}
              settings={panel.settings}
              onChange={(patch) => setSettings(panel.id, patch)}
              hideSyncedNotes
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 @md:flex-row @md:items-start" data-wide-panel-layout="measurement">
          <div className="flex min-w-0 flex-col gap-2 @md:sticky @md:top-0 @md:w-5/12" data-panel-screen-pane>
            {instrument.kind === 'galvanometer' ? (
              <GalvanometerDisplay instanceId={panel.id} />
            ) : (
              <SevenSegDisplay instanceId={panel.id} />
            )}
            {config?.wattmeter && (
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
          </div>
          {config && (
            <div className="flex min-w-0 flex-1 flex-col gap-3">
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
              {settingsControls.length > 0 && renderSettingsControls()}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
