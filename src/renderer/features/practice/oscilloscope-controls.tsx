import {
  COUPLINGS,
  formatSeconds,
  formatVoltage,
  resolveScope,
  SCOPE_POSITION_LIMIT,
  SCOPE_TRIGGER_LEVEL_LIMIT,
  TRIGGER_MODES,
  TRIGGER_SLOPES,
} from '@domain/instruments'
import type { Instrument } from '@shared/schema/instrument'
import { OscilloscopeScreen } from '@/components/instruments/oscilloscope-screen'
import { RotaryKnob } from '@/components/instruments/rotary-knob'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { SettingSelect, SignalSourceControls } from './signal-generator-controls'

type Settings = Record<string, unknown>
type Change = (patch: Record<string, number>) => void

const COUPLING_LABEL = { dc: 'DC 直流耦合', ac: 'AC 交流耦合', gnd: 'GND 接地' } as const
const MODE_LABEL = { auto: '自动', normal: '常规', single: '单次' } as const
const SLOPE_LABEL = { rise: '上升沿', fall: '下降沿' } as const

/** 示波器面板（INS-09/10）：屏幕 + 垂直、水平、触发、内置信号源 */
export function OscilloscopeControls({
  instanceId,
  instrument,
  settings,
  onChange,
}: {
  instanceId: string
  instrument: Instrument
  settings: Settings
  onChange: Change
}) {
  const scope = resolveScope(instrument, settings)
  const { config } = scope
  return (
    <div className="@container flex flex-col gap-3">
      <OscilloscopeScreen instanceId={instanceId} channelIds={config.channels.map((channel) => channel.id)} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant={scope.running ? 'outline' : 'default'}
          aria-pressed={!scope.running}
          onClick={() => onChange({ run: scope.running ? 0 : 1 })}
        >
          {scope.running ? '停止' : '运行'}
        </Button>
        <Button
          variant="outline"
          onClick={() => onChange({ trig_mode: TRIGGER_MODES.indexOf('single'), arm: scope.arm + 1, run: 1 })}
        >
          单次
        </Button>
      </div>
      {scope.channels.map((channel, index) => {
        const prefix = channel.id.toLowerCase()
        return (
          <section key={channel.id} aria-label={`${channel.label} 垂直`} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-medium">{channel.label} 垂直</h4>
              <Button
                size="sm"
                variant={channel.enabled ? 'default' : 'outline'}
                aria-pressed={channel.enabled}
                aria-label={`${channel.label} 显示`}
                onClick={() => onChange({ [`${prefix}_on`]: channel.enabled ? 0 : 1 })}
              >
                {channel.enabled ? '开' : '关'}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
              <RotaryKnob
                label={`${channel.label} V/div`}
                value={config.voltsPerDiv.indexOf(channel.voltsPerDiv)}
                min={0}
                max={config.voltsPerDiv.length - 1}
                options={config.voltsPerDiv.map((value, i) => ({ value: i, label: `${formatVoltage(value)}/div` }))}
                onChange={(i) => {
                  const value = config.voltsPerDiv[i]
                  if (value !== undefined) onChange({ [`${prefix}_vdiv`]: value })
                }}
              />
              <RotaryKnob
                label={`${channel.label} 垂直位移`}
                value={channel.position}
                min={-SCOPE_POSITION_LIMIT}
                max={SCOPE_POSITION_LIMIT}
                step={0.1}
                unit="div"
                onChange={(value) => onChange({ [`${prefix}_pos`]: value })}
              />
              <SettingSelect
                label={`${channel.label} 耦合`}
                value={COUPLINGS.indexOf(channel.coupling)}
                options={COUPLINGS.map((coupling) => COUPLING_LABEL[coupling])}
                onChange={(value) => onChange({ [`${prefix}_coupling`]: value })}
              />
            </div>
            {index < scope.channels.length - 1 && <Separator />}
          </section>
        )
      })}
      <Separator />
      <section aria-label="水平" className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
        <RotaryKnob
          label="时基 s/div"
          value={config.secondsPerDiv.indexOf(scope.secondsPerDiv)}
          min={0}
          max={config.secondsPerDiv.length - 1}
          options={config.secondsPerDiv.map((value, i) => ({ value: i, label: `${formatSeconds(value)}/div` }))}
          onChange={(i) => {
            const value = config.secondsPerDiv[i]
            if (value !== undefined) onChange({ tdiv: value })
          }}
        />
        <RotaryKnob
          label="水平位移"
          value={scope.horizontalPosition}
          min={-config.divisions.x / 2}
          max={config.divisions.x / 2}
          step={0.1}
          unit="div"
          onChange={(value) => onChange({ hpos: value })}
        />
      </section>
      <Separator />
      <section aria-label="触发" className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
        <SettingSelect
          label="触发方式"
          value={TRIGGER_MODES.indexOf(scope.trigger.mode)}
          options={TRIGGER_MODES.map((mode) => MODE_LABEL[mode])}
          onChange={(value) => onChange({ trig_mode: value })}
        />
        <SettingSelect
          label="触发源"
          value={scope.trigger.source}
          options={scope.channels.map((channel) => channel.label)}
          onChange={(value) => onChange({ trig_src: value })}
        />
        <SettingSelect
          label="触发边沿"
          value={TRIGGER_SLOPES.indexOf(scope.trigger.slope)}
          options={TRIGGER_SLOPES.map((slope) => SLOPE_LABEL[slope])}
          onChange={(value) => onChange({ trig_slope: value })}
        />
        <RotaryKnob
          label="触发电平"
          value={scope.trigger.level}
          min={-SCOPE_TRIGGER_LEVEL_LIMIT}
          max={SCOPE_TRIGGER_LEVEL_LIMIT}
          step={0.01}
          unit="V"
          onChange={(value) => onChange({ trig_level: value })}
        />
      </section>
      {(instrument.signalSources ?? []).map((source) => (
        <section key={source.id} aria-label={source.label} className="flex flex-col gap-2">
          <Separator />
          <h4 className="text-xs font-medium">
            {source.label}（{source.positiveJack} 对 {source.negativeJack}）
          </h4>
          <SignalSourceControls instrument={instrument} source={source} settings={settings} onChange={onChange} />
        </section>
      ))}
    </div>
  )
}
