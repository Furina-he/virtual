import {
  COUPLINGS,
  CURSOR_MODES,
  computeScopeAutoSet,
  formatSeconds,
  formatVoltage,
  resolveScope,
  SCOPE_POSITION_LIMIT,
  SCOPE_TRIGGER_LEVEL_LIMIT,
  TRIGGER_MODES,
  TRIGGER_SLOPES,
} from '@domain/instruments'
import type { Instrument } from '@shared/schema/instrument'
import { toast } from 'sonner'
import { captureScopePng, OscilloscopeScreen } from '@/components/instruments/oscilloscope-screen'
import { RotaryKnob } from '@/components/instruments/rotary-knob'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { acquireScope } from '@/lib/scope-acquisition'
import { addReportScreenshot, useTask } from '@/stores/task'
import { SettingSelect, SignalSourceControls } from './signal-generator-controls'

type Settings = Record<string, unknown>
type Change = (patch: Record<string, number>) => void

const COUPLING_LABEL = { dc: 'DC 直流耦合', ac: 'AC 交流耦合', gnd: 'GND 接地' } as const
const MODE_LABEL = { auto: '自动', normal: '常规', single: '单次' } as const
const SLOPE_LABEL = { rise: '上升沿', fall: '下降沿' } as const
const CURSOR_MODE_LABEL = { off: '关', time: '时间光标 Δt', voltage: '电压光标 ΔV' } as const

/** 示波器面板（INS-09/10/11，T1.9A 左屏右控横版布局 + 自动设置辅助） */
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
  const screenshotCount = useTask(
    (state) => state.screenshots.filter((entry) => entry.instanceId === instanceId).length,
  )
  const cursorLimit = scope.cursors.mode === 'voltage' ? config.divisions.y / 2 : config.divisions.x / 2

  const handleCaptureToReport = () => {
    const captured = captureScopePng(instanceId)
    if (!captured) return
    addReportScreenshot({
      instanceId,
      instrumentTitle: captured.instrumentTitle,
      dataUrl: captured.dataUrl,
      displayMode: scope.displayMode,
      frozen: captured.summary.state === 'stopped',
      summaryText: captured.summaryText,
    })
  }

  const handleAutoSet = () => {
    const frame = acquireScope(instanceId, instrument, settings)
    const patch = computeScopeAutoSet(scope, frame.measurements)
    if (!patch) {
      toast.info('当前暂无可自动匹配的输入波形，请先上电并接通通道信号。')
      return
    }
    onChange(patch)
  }

  return (
    <div className="@container flex flex-col gap-3">
      <div className="flex flex-col gap-3 @md:flex-row @md:items-start" data-scope-layout>
        <div className="flex min-w-0 flex-col gap-2 @md:sticky @md:top-0 @md:w-1/2" data-scope-screen-pane>
          <OscilloscopeScreen instanceId={instanceId} channelIds={config.channels.map((channel) => channel.id)} />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant={scope.running ? 'outline' : 'default'}
              aria-pressed={!scope.running}
              onClick={() => onChange({ run: scope.running ? 0 : 1 })}
            >
              {scope.running ? '停止' : '运行'}
            </Button>
            <Button
              size="sm"
              variant={scope.running ? 'outline' : 'default'}
              aria-pressed={!scope.running}
              onClick={() => onChange({ run: scope.running ? 0 : 1 })}
            >
              {scope.running ? '冻结波形' : '解除冻结'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onChange({ trig_mode: TRIGGER_MODES.indexOf('single'), arm: scope.arm + 1, run: 1 })}
            >
              单次
            </Button>
            <Button size="sm" variant="outline" onClick={handleAutoSet}>
              自动设置
            </Button>
            <Button
              size="sm"
              variant={scope.displayMode === 'xy' ? 'default' : 'outline'}
              aria-pressed={scope.displayMode === 'xy'}
              onClick={() => onChange({ xy: scope.displayMode === 'xy' ? 0 : 1 })}
            >
              X-Y 模式
            </Button>
            <Button size="sm" variant="outline" onClick={handleCaptureToReport}>
              截图入报告
            </Button>
            {screenshotCount > 0 && (
              <span data-scope-screenshot-count={screenshotCount} className="font-mono text-xs text-muted-foreground">
                已存 {screenshotCount} 张
              </span>
            )}
          </div>
        </div>
        <div className="@container flex min-w-0 flex-1 flex-col gap-3">
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
          <Separator />
          <section aria-label="光标测量" className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
            <SettingSelect
              label="光标模式"
              value={CURSOR_MODES.indexOf(scope.cursors.mode)}
              options={CURSOR_MODES.map((mode) => CURSOR_MODE_LABEL[mode])}
              onChange={(value) => onChange({ cursor_mode: value })}
            />
            <SettingSelect
              label="光标通道"
              value={scope.cursors.source}
              options={scope.channels.map((channel) => channel.label)}
              onChange={(value) => onChange({ cursor_src: value })}
            />
            {scope.cursors.mode !== 'off' && (
              <>
                <RotaryKnob
                  label="光标 A"
                  value={Math.max(-cursorLimit, Math.min(cursorLimit, scope.cursors.a))}
                  min={-cursorLimit}
                  max={cursorLimit}
                  step={0.1}
                  unit="div"
                  onChange={(value) => onChange({ cursor_a: value })}
                />
                <RotaryKnob
                  label="光标 B"
                  value={Math.max(-cursorLimit, Math.min(cursorLimit, scope.cursors.b))}
                  min={-cursorLimit}
                  max={cursorLimit}
                  step={0.1}
                  unit="div"
                  onChange={(value) => onChange({ cursor_b: value })}
                />
              </>
            )}
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
      </div>
    </div>
  )
}
