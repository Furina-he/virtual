import {
  adjustableSources,
  computeScopeAutoSet,
  formatSeconds,
  formatVoltage,
  isMeasurementInstrument,
  resolveDcSupply,
  resolveInstrument,
  resolveScope,
  resolveSource,
  SCOPE_POSITION_LIMIT,
  SCOPE_TRIGGER_LEVEL_LIMIT,
  sourceKey,
  WATTMETER_DISPLAY_MODES,
  WAVEFORM_LABEL,
} from '@domain/instruments'
import { Html } from '@react-three/drei'
import { type ThreeEvent, useThree } from '@react-three/fiber'
import { Minus, Plus, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { type Object3D, OctahedronGeometry } from 'three'
import { clampKnobValue, formatEngineeringValue, knobAngle } from '@/components/instruments/rotary-knob-values'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { acquireScope } from '@/lib/scope-acquisition'
import { instrumentDockStore } from '@/stores/instrument-dock'
import { type PanelDef, useInstrumentPanels } from '@/stores/instrument-panels'
import { taskStore } from '@/stores/task'
import type { AssetAnchor } from './anchors'
import { useBenchView } from './bench-view'
import { readHighlightColor } from './jack-node'

export type InstrumentControlSlider = {
  value: number
  min: number
  max: number
  step: number
  setValue: (next: number) => void
}

export type InstrumentControlPreset = {
  label: string
  active: boolean
  apply: () => void
}

export type InstrumentControlBinding = {
  label: string
  valueText: string
  isSwitch: boolean
  slider?: InstrumentControlSlider
  presets?: readonly InstrumentControlPreset[]
  adjust: (steps: number, coarse?: boolean) => void
  clickToggle?: () => void
}

const SHARED_HIT_GEOMETRY = new OctahedronGeometry(1, 0)
const CLICK_DRAG_THRESHOLD_PX = 4

function decadeFreqStep(freq: number): number {
  if (freq < 10) return 0.5
  if (freq < 100) return 5
  if (freq < 1000) return 50
  if (freq < 10_000) return 500
  return 5000
}

/** 将仪器 GLB 的 KNOB_ / SW_ 锚点映射为统一的 3D 交互与浮窗绑定（技术设计 §10.3，T1.9B）。 */
export function resolveInstrumentControlBinding(
  panel: PanelDef | undefined,
  anchorName: string,
  anchorKind: 'KNOB' | 'SW',
): InstrumentControlBinding | null {
  if (!panel) return null
  const { instrument, settings, id: instanceId } = panel
  const commit = (patch: Record<string, unknown>) => {
    useInstrumentPanels.getState().setSettings(instanceId, patch)
    instrumentDockStore.getState().selectInstrument(instanceId, { expandFixed: true })
    if (taskStore.getState().bottomTab !== 'instruments') taskStore.setState({ bottomTab: 'instruments' })
  }

  // 1. 显式声明了 anchor 的连续设定控件（直流稳压电源、三相交流调压电源等）
  const declared = instrument.settingsControls?.find((entry) => entry.anchor === anchorName)
  if (declared) {
    const current = typeof settings[declared.id] === 'number' ? (settings[declared.id] as number) : declared.default
    const presets: InstrumentControlPreset[] =
      instrument.kind === 'dcSupply' && (declared.id === 'ch1_v' || declared.id === 'ch2_v')
        ? [5, 6, 12]
            .filter((preset) => preset >= declared.min && preset <= declared.max)
            .map((preset) => ({
              label: `${preset} V`,
              active: Math.abs(current - preset) < 1e-6,
              apply: () => commit({ [declared.id]: preset }),
            }))
        : []
    return {
      label: declared.label,
      valueText: formatEngineeringValue(current, declared.unit),
      isSwitch: false,
      slider: {
        value: current,
        min: declared.min,
        max: declared.max,
        step: declared.step,
        setValue: (next) => commit({ [declared.id]: clampKnobValue(next, declared.min, declared.max, declared.step) }),
      },
      presets: presets.length ? presets : undefined,
      adjust: (steps, coarse = false) => {
        const latestPanel = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
        const latestVal =
          typeof latestPanel?.settings[declared.id] === 'number'
            ? (latestPanel.settings[declared.id] as number)
            : declared.default
        const multiplier = coarse ? 5 : 1
        const next = clampKnobValue(
          latestVal + steps * declared.step * multiplier,
          declared.min,
          declared.max,
          declared.step,
        )
        commit({ [declared.id]: next })
      },
    }
  }

  // 2. 直流稳压电源双路模式开关
  if (instrument.kind === 'dcSupply' && anchorName === 'SW_OUTPUT') {
    const dc = resolveDcSupply(instrument, settings)
    const toggle = () => {
      const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
      const latestDc = resolveDcSupply(instrument, latest?.settings ?? settings)
      commit({ tracking: latestDc.tracking ? 0 : 1 })
    }
    return {
      label: '双路模式',
      valueText: dc.tracking ? '串联跟踪 ±V' : '独立双路',
      isSwitch: true,
      adjust: () => toggle(),
      clickToggle: toggle,
    }
  }

  // 3. 功率表显示量切换
  if (instrument.kind === 'wattmeter' && anchorName === 'SW_MODE') {
    const config = resolveInstrument(instrument, settings)
    const mode = config.wattmeter?.displayMode ?? 'P'
    const stepMode = (delta: number) => {
      const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
      const latestMode = resolveInstrument(instrument, latest?.settings ?? settings).wattmeter?.displayMode ?? 'P'
      const idx = WATTMETER_DISPLAY_MODES.indexOf(latestMode)
      const next =
        WATTMETER_DISPLAY_MODES[(idx + delta + WATTMETER_DISPLAY_MODES.length) % WATTMETER_DISPLAY_MODES.length]
      if (next) commit({ displayMode: next })
    }
    return {
      label: '显示量',
      valueText: mode === 'pf' ? 'cosφ' : mode,
      isSwitch: true,
      adjust: (steps) => stepMode(Math.sign(steps) || 1),
      clickToggle: () => stepMode(1),
    }
  }

  // 4. 交流毫伏表双通道切换
  if (instrument.inputChannels && instrument.inputChannels.length > 1 && anchorName === 'SW_CHANNEL') {
    const channels = instrument.inputChannels
    const config = resolveInstrument(instrument, settings)
    const currentId = config.channelId ?? channels[0]?.id ?? 'CH1'
    const currentLabel = channels.find((ch) => ch.id === currentId)?.label ?? currentId
    const cycle = (delta: number) => {
      const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
      const cur = resolveInstrument(instrument, latest?.settings ?? settings).channelId ?? channels[0]?.id
      const idx = channels.findIndex((ch) => ch.id === cur)
      const next = channels[(idx + delta + channels.length) % channels.length]
      if (next) commit({ channel: next.id })
    }
    return {
      label: '输入通道',
      valueText: currentLabel,
      isSwitch: true,
      adjust: (steps) => cycle(Math.sign(steps) || 1),
      clickToggle: () => cycle(1),
    }
  }

  // 5. 常规测量仪表的量程/档位旋钮或开关
  if (
    isMeasurementInstrument(instrument) &&
    instrument.ranges.length > 1 &&
    (anchorName === 'SW_RANGE' || anchorName === 'KNOB_RANGE' || anchorName === 'KNOB_FUNCTION')
  ) {
    const config = resolveInstrument(instrument, settings)
    const currentIndex = Math.max(
      0,
      instrument.ranges.findIndex((r) => r.id === config.range.id),
    )
    const stepRange = (delta: number, wrap: boolean) => {
      const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
      const curId = resolveInstrument(instrument, latest?.settings ?? settings).range.id
      const idx = instrument.ranges.findIndex((r) => r.id === curId)
      const nextIdx = wrap
        ? (idx + delta + instrument.ranges.length) % instrument.ranges.length
        : Math.max(0, Math.min(instrument.ranges.length - 1, idx + delta))
      const next = instrument.ranges[nextIdx]
      if (next) commit({ range: next.id })
    }
    const isSwitch = anchorKind === 'SW'
    return {
      label: instrument.kind === 'multimeter' ? '档位' : '量程',
      valueText: config.range.label ?? config.range.id,
      isSwitch,
      slider: isSwitch
        ? undefined
        : {
            value: currentIndex,
            min: 0,
            max: instrument.ranges.length - 1,
            step: 1,
            setValue: (next) => {
              const target = instrument.ranges[Math.round(next)]
              if (target) commit({ range: target.id })
            },
          },
      adjust: (steps) => stepRange(steps, false),
      clickToggle: isSwitch ? () => stepRange(1, true) : undefined,
    }
  }

  // 6. 示波器旋钮与按键
  if (instrument.scope) {
    const scope = resolveScope(instrument, settings)
    const { config } = scope
    const stepDiscrete = (key: string, values: readonly number[], currentVal: number, steps: number) => {
      const idx = Math.max(0, values.indexOf(currentVal))
      const next = values[Math.max(0, Math.min(values.length - 1, idx + steps))]
      if (next !== undefined) commit({ [key]: next })
    }
    switch (anchorName) {
      case 'KNOB_CH1_SCALE': {
        const curVal = scope.channels[0]?.voltsPerDiv ?? 1
        const curIdx = Math.max(0, config.voltsPerDiv.indexOf(curVal))
        return {
          label: 'CH1 V/div',
          valueText: `${formatVoltage(curVal)}/div`,
          isSwitch: false,
          slider: {
            value: curIdx,
            min: 0,
            max: config.voltsPerDiv.length - 1,
            step: 1,
            setValue: (idx) => {
              const next = config.voltsPerDiv[Math.round(idx)]
              if (next !== undefined) commit({ ch1_vdiv: next })
            },
          },
          adjust: (steps) => {
            const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
            const cur = resolveScope(instrument, latest?.settings ?? settings).channels[0]?.voltsPerDiv ?? 1
            stepDiscrete('ch1_vdiv', config.voltsPerDiv, cur, steps)
          },
        }
      }
      case 'KNOB_CH2_SCALE': {
        const curVal = scope.channels[1]?.voltsPerDiv ?? 1
        const curIdx = Math.max(0, config.voltsPerDiv.indexOf(curVal))
        return {
          label: 'CH2 V/div',
          valueText: `${formatVoltage(curVal)}/div`,
          isSwitch: false,
          slider: {
            value: curIdx,
            min: 0,
            max: config.voltsPerDiv.length - 1,
            step: 1,
            setValue: (idx) => {
              const next = config.voltsPerDiv[Math.round(idx)]
              if (next !== undefined) commit({ ch2_vdiv: next })
            },
          },
          adjust: (steps) => {
            const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
            const cur = resolveScope(instrument, latest?.settings ?? settings).channels[1]?.voltsPerDiv ?? 1
            stepDiscrete('ch2_vdiv', config.voltsPerDiv, cur, steps)
          },
        }
      }
      case 'KNOB_CH1_POSITION':
      case 'KNOB_CH2_POSITION': {
        const chIdx = anchorName === 'KNOB_CH1_POSITION' ? 0 : 1
        const key = chIdx === 0 ? 'ch1_pos' : 'ch2_pos'
        const curPos = scope.channels[chIdx]?.position ?? 0
        return {
          label: `CH${chIdx + 1} 垂直位移`,
          valueText: `${curPos} div`,
          isSwitch: false,
          slider: {
            value: curPos,
            min: -SCOPE_POSITION_LIMIT,
            max: SCOPE_POSITION_LIMIT,
            step: 0.1,
            setValue: (next) =>
              commit({ [key]: clampKnobValue(next, -SCOPE_POSITION_LIMIT, SCOPE_POSITION_LIMIT, 0.1) }),
          },
          presets: [{ label: '归零', active: Math.abs(curPos) < 1e-6, apply: () => commit({ [key]: 0 }) }],
          adjust: (steps, coarse = false) => {
            const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
            const cur = resolveScope(instrument, latest?.settings ?? settings).channels[chIdx]?.position ?? 0
            commit({
              [key]: clampKnobValue(
                cur + steps * (coarse ? 0.5 : 0.1),
                -SCOPE_POSITION_LIMIT,
                SCOPE_POSITION_LIMIT,
                0.1,
              ),
            })
          },
        }
      }
      case 'KNOB_TIMEBASE': {
        const curIdx = Math.max(0, config.secondsPerDiv.indexOf(scope.secondsPerDiv))
        return {
          label: '时基 s/div',
          valueText: `${formatSeconds(scope.secondsPerDiv)}/div`,
          isSwitch: false,
          slider: {
            value: curIdx,
            min: 0,
            max: config.secondsPerDiv.length - 1,
            step: 1,
            setValue: (idx) => {
              const next = config.secondsPerDiv[Math.round(idx)]
              if (next !== undefined) commit({ tdiv: next })
            },
          },
          adjust: (steps) => {
            const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
            const cur = resolveScope(instrument, latest?.settings ?? settings).secondsPerDiv
            stepDiscrete('tdiv', config.secondsPerDiv, cur, steps)
          },
        }
      }
      case 'KNOB_TRIGGER':
        return {
          label: '触发电平',
          valueText: `${scope.trigger.level} V`,
          isSwitch: false,
          slider: {
            value: scope.trigger.level,
            min: -SCOPE_TRIGGER_LEVEL_LIMIT,
            max: SCOPE_TRIGGER_LEVEL_LIMIT,
            step: 0.05,
            setValue: (next) =>
              commit({ trig_level: clampKnobValue(next, -SCOPE_TRIGGER_LEVEL_LIMIT, SCOPE_TRIGGER_LEVEL_LIMIT, 0.01) }),
          },
          presets: [
            { label: '0 V', active: Math.abs(scope.trigger.level) < 1e-6, apply: () => commit({ trig_level: 0 }) },
          ],
          adjust: (steps, coarse = false) => {
            const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
            const cur = resolveScope(instrument, latest?.settings ?? settings).trigger.level
            commit({
              trig_level: clampKnobValue(
                cur + steps * (coarse ? 0.5 : 0.1),
                -SCOPE_TRIGGER_LEVEL_LIMIT,
                SCOPE_TRIGGER_LEVEL_LIMIT,
                0.01,
              ),
            })
          },
        }
      case 'SW_RUN': {
        const toggleRun = () => {
          const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
          const cur = resolveScope(instrument, latest?.settings ?? settings).running
          commit({ run: cur ? 0 : 1 })
        }
        return {
          label: '运行 / 冻结',
          valueText: scope.running ? '运行中' : '已冻结',
          isSwitch: true,
          adjust: () => toggleRun(),
          clickToggle: toggleRun,
        }
      }
      case 'SW_AUTO': {
        const autoSet = () => {
          const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
          if (!latest) return
          const resolved = resolveScope(instrument, latest.settings)
          const frame = acquireScope(instanceId, instrument, latest.settings)
          const patch = computeScopeAutoSet(resolved, frame.measurements)
          if (patch) commit(patch)
        }
        return {
          label: '自动设置',
          valueText: '匹配当前信号',
          isSwitch: true,
          adjust: () => autoSet(),
          clickToggle: autoSet,
        }
      }
      default:
        return null
    }
  }

  // 7. 函数信号发生器
  if (instrument.kind === 'funcGen' && instrument.signalSources?.length) {
    const sources = adjustableSources(instrument)
    const chIdx = typeof settings.display_ch === 'number' ? settings.display_ch : 0
    const source = sources[chIdx] ?? sources[0]
    if (!source) return null
    const resolved = resolveSource(instrument, settings, source)
    switch (anchorName) {
      case 'KNOB_VALUE':
        if (!source.frequency) return null
        return {
          label: `${source.label} 频率`,
          valueText: formatEngineeringValue(resolved.frequency, 'Hz'),
          isSwitch: false,
          slider: {
            value: Math.log10(Math.max(1, resolved.frequency)),
            min: Math.log10(Math.max(1, source.frequency.min)),
            max: Math.log10(Math.max(10, source.frequency.max)),
            step: 0.02,
            setValue: (logVal) => {
              if (!source.frequency) return
              const hz = clampKnobValue(10 ** logVal, source.frequency.min, source.frequency.max, 0.1)
              commit({ [sourceKey(source, 'freq')]: hz })
            },
          },
          presets: [
            { value: 100, label: '100 Hz' },
            { value: 1000, label: '1 kHz' },
            { value: 10_000, label: '10 kHz' },
          ]
            .filter((p) => source.frequency && p.value >= source.frequency.min && p.value <= source.frequency.max)
            .map((p) => ({
              label: p.label,
              active: Math.abs(resolved.frequency - p.value) < 1e-6,
              apply: () => commit({ [sourceKey(source, 'freq')]: p.value }),
            })),
          adjust: (steps, coarse = false) => {
            const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
            const activeIdx = typeof latest?.settings.display_ch === 'number' ? latest.settings.display_ch : 0
            const activeSource = sources[activeIdx] ?? source
            if (!activeSource.frequency) return
            const cur = resolveSource(instrument, latest?.settings ?? settings, activeSource).frequency
            const delta = decadeFreqStep(cur) * (coarse ? 5 : 1) * steps
            const next = clampKnobValue(cur + delta, activeSource.frequency.min, activeSource.frequency.max, 0.1)
            commit({ [sourceKey(activeSource, 'freq')]: next })
          },
        }
      case 'KNOB_ADJUST':
        if (!source.amplitude) return null
        return {
          label: `${source.label} 幅值`,
          valueText: `${resolved.amplitude} Vpp`,
          isSwitch: false,
          slider: {
            value: resolved.amplitude,
            min: source.amplitude.min,
            max: source.amplitude.max,
            step: 0.1,
            setValue: (next) => {
              if (!source.amplitude) return
              commit({
                [sourceKey(source, 'amp')]: clampKnobValue(next, source.amplitude.min, source.amplitude.max, 0.01),
              })
            },
          },
          adjust: (steps, coarse = false) => {
            const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
            const activeIdx = typeof latest?.settings.display_ch === 'number' ? latest.settings.display_ch : 0
            const activeSource = sources[activeIdx] ?? source
            if (!activeSource.amplitude) return
            const cur = resolveSource(instrument, latest?.settings ?? settings, activeSource).amplitude
            const next = clampKnobValue(
              cur + steps * (coarse ? 0.5 : 0.1),
              activeSource.amplitude.min,
              activeSource.amplitude.max,
              0.01,
            )
            commit({ [sourceKey(activeSource, 'amp')]: next })
          },
        }
      case 'SW_CH_SELECT': {
        const toggleCh = () => {
          const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
          const cur = typeof latest?.settings.display_ch === 'number' ? latest.settings.display_ch : 0
          commit({ display_ch: (cur + 1) % sources.length })
        }
        return {
          label: '通道选择',
          valueText: source.label,
          isSwitch: true,
          adjust: () => toggleCh(),
          clickToggle: toggleCh,
        }
      }
      case 'SW_WAVEFORM': {
        const cycleWave = (delta: number) => {
          const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
          const activeIdx = typeof latest?.settings.display_ch === 'number' ? latest.settings.display_ch : 0
          const activeSource = sources[activeIdx] ?? source
          const curWave = resolveSource(instrument, latest?.settings ?? settings, activeSource).waveform
          const idx = activeSource.waveforms.indexOf(curWave)
          const nextIdx = (idx + delta + activeSource.waveforms.length) % activeSource.waveforms.length
          commit({ [sourceKey(activeSource, 'wave')]: nextIdx })
        }
        return {
          label: `${source.label} 波形`,
          valueText: WAVEFORM_LABEL[resolved.waveform],
          isSwitch: true,
          adjust: (steps) => cycleWave(Math.sign(steps) || 1),
          clickToggle: () => cycleWave(1),
        }
      }
      case 'SW_OUTPUT': {
        const toggleOut = () => {
          const latest = useInstrumentPanels.getState().panels.find((item) => item.id === instanceId)
          const activeIdx = typeof latest?.settings.display_ch === 'number' ? latest.settings.display_ch : 0
          const activeSource = sources[activeIdx] ?? source
          const curOn = resolveSource(instrument, latest?.settings ?? settings, activeSource).enabled
          commit({ [sourceKey(activeSource, 'on')]: curOn ? 0 : 1 })
        }
        return {
          label: `${source.label} 输出`,
          valueText: resolved.enabled ? '输出开' : '输出关',
          isSwitch: true,
          adjust: () => toggleOut(),
          clickToggle: toggleOut,
        }
      }
      default:
        return null
    }
  }

  return null
}

function InstrumentControlTarget({
  instanceId,
  anchor,
  binding,
  enabled,
}: {
  instanceId: string
  anchor: AssetAnchor
  binding: InstrumentControlBinding
  enabled: boolean
}) {
  const camera = useThree((state) => state.controls) as { enabled: boolean } | null
  const canvas = useThree((state) => state.gl.domElement)
  const key = `${instanceId}.${anchor.id}`
  const hovered = useBenchView((state) => state.hoveredControl === key)
  const popoverActive = useBenchView((state) => state.activeKnobPopover?.controlKey === key)
  const invalidate = useThree((state) => state.invalidate)
  const highlight = useMemo(readHighlightColor, [])
  const radius = binding.isSwitch ? 0.009 : 0.014
  const bindingRef = useRef(binding)
  bindingRef.current = binding

  useEffect(() => {
    if (hovered || popoverActive) invalidate()
    return () => invalidate()
  }, [hovered, popoverActive, invalidate])

  const drag = useRef<{ x: number; y: number; lastSteps: number; moved: boolean; pointerId: number } | null>(null)

  const stop = useCallback(
    (clientX?: number, clientY?: number) => {
      const current = drag.current
      drag.current = null
      if (current && canvas.hasPointerCapture(current.pointerId)) canvas.releasePointerCapture(current.pointerId)
      if (camera) camera.enabled = true
      // 未发生垂直拖拽的单击：就地弹出 Popover 微调浮窗（T1.9B，消除 3D 滚轮冲突）
      if (current && !current.moved && !bindingRef.current.isSwitch) {
        useBenchView.getState().setActiveKnobPopover({
          instanceId,
          anchorName: anchor.name,
          controlKey: key,
          x: clientX ?? current.x,
          y: clientY ?? current.y,
        })
      }
    },
    [canvas, camera, instanceId, anchor.name, key],
  )

  useEffect(() => {
    const cancel = () => {
      const current = drag.current
      drag.current = null
      if (current && canvas.hasPointerCapture(current.pointerId)) canvas.releasePointerCapture(current.pointerId)
      if (camera) camera.enabled = true
    }
    const move = (event: PointerEvent) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      if (
        !current.moved &&
        Math.hypot(event.clientX - current.x, event.clientY - current.y) > CLICK_DRAG_THRESHOLD_PX
      ) {
        current.moved = true
      }
      if (!current.moved) return
      const totalSteps = Math.round((current.y - event.clientY) / 10)
      const delta = totalSteps - current.lastSteps
      if (delta === 0) return
      current.lastSteps = totalSteps
      bindingRef.current.adjust(delta, event.shiftKey)
    }
    const up = (event: PointerEvent) => {
      if (drag.current && drag.current.pointerId === event.pointerId) {
        stop(event.clientX, event.clientY)
      }
    }
    window.addEventListener('blur', cancel)
    canvas.addEventListener('pointercancel', cancel)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('blur', cancel)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointermove', move)
      cancel()
    }
  }, [canvas, camera, stop])

  const begin = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    if (!enabled || event.button !== 0) return
    if (bindingRef.current.isSwitch && bindingRef.current.clickToggle) {
      bindingRef.current.clickToggle()
      return
    }
    drag.current = { x: event.clientX, y: event.clientY, lastSteps: 0, moved: false, pointerId: event.pointerId }
    canvas.setPointerCapture(event.pointerId)
    if (camera) camera.enabled = false
  }

  return (
    <group position={anchor.position} quaternion={anchor.quaternion}>
      <mesh
        position={[0, 0, 0.012]}
        scale={radius}
        geometry={SHARED_HIT_GEOMETRY}
        onPointerOver={(event) => {
          event.stopPropagation()
          useBenchView.getState().setHover({ hoveredControl: key, hoveredJack: null, hoveredWire: null })
          canvas.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          if (useBenchView.getState().hoveredControl === key) useBenchView.getState().setHover({ hoveredControl: null })
        }}
        onPointerDown={begin}
        onPointerMove={(event) => {
          event.stopPropagation()
        }}
        onPointerUp={(event) => {
          event.stopPropagation()
          stop(event.clientX, event.clientY)
        }}
      >
        <meshBasicMaterial visible={false} />
      </mesh>
      {(hovered || popoverActive) && (
        <>
          <mesh position={[0, 0, 0.002]} raycast={() => null}>
            <ringGeometry args={[radius * 0.85, radius, 32]} />
            <meshBasicMaterial color={highlight} toneMapped={false} />
          </mesh>
          {hovered && !popoverActive && (
            <Html center position={[0, 0.024, 0.014]} style={{ pointerEvents: 'none' }}>
              <span
                data-instrument-control-tip={key}
                className="pointer-events-none whitespace-nowrap rounded-sm border bg-popover px-1.5 py-0.5 font-mono text-xs text-popover-foreground shadow-xs"
              >
                {binding.label}：{binding.valueText}
              </span>
            </Html>
          )}
        </>
      )}
    </group>
  )
}

/** 3D 旋钮就地微调浮窗（T1.9B，DESIGN.md、技术设计 §10.3）：浮窗内提供 −/+、滑块、预设与安全滚轮调节，不与 3D 缩放冲突。 */
export function InstrumentKnobPopover() {
  const popover = useBenchView((state) => state.activeKnobPopover)
  const panel = useInstrumentPanels((state) =>
    popover ? state.panels.find((entry) => entry.id === popover.instanceId) : undefined,
  )
  const close = () => useBenchView.getState().setActiveKnobPopover(null)
  if (!popover || !panel) return null
  const binding = resolveInstrumentControlBinding(panel, popover.anchorName, 'KNOB')
  if (!binding) return null
  const slider = binding.slider
  return (
    <Popover open onOpenChange={(open) => !open && close()}>
      <PopoverAnchor asChild>
        <span aria-hidden="true" className="fixed size-0" style={{ left: popover.x, top: popover.y }} />
      </PopoverAnchor>
      <PopoverContent
        align="center"
        side="top"
        sideOffset={10}
        data-knob-popover={popover.controlKey}
        aria-label={`${binding.label}微调浮窗`}
        className="w-60 space-y-2.5 p-3"
        onWheel={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const dir = Math.sign(-event.deltaY)
          if (dir !== 0) binding.adjust(dir, event.shiftKey)
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium">{binding.label}</span>
          <div className="flex items-center gap-1">
            <span data-knob-popover-value className="font-mono text-xs tabular-nums text-primary">
              {binding.valueText}
            </span>
            <Button size="icon-xs" variant="ghost" aria-label="关闭微调浮窗" onClick={close}>
              <X />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`减小 ${binding.label}`}
            onClick={() => binding.adjust(-1, false)}
          >
            <Minus />
          </Button>
          {slider ? (
            <Slider
              aria-label={`${binding.label}滑块`}
              value={[slider.value]}
              min={slider.min}
              max={slider.max}
              step={slider.step}
              onValueChange={(values) => {
                const next = values[0]
                if (next !== undefined) slider.setValue(next)
              }}
              className="flex-1"
            />
          ) : (
            <span className="flex-1 text-center font-mono text-xs text-muted-foreground">{binding.valueText}</span>
          )}
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`增大 ${binding.label}`}
            onClick={() => binding.adjust(1, false)}
          >
            <Plus />
          </Button>
        </div>
        {binding.presets && binding.presets.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {binding.presets.map((preset) => (
              <Button
                key={preset.label}
                size="xs"
                variant={preset.active ? 'default' : 'outline'}
                onClick={preset.apply}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">浮窗内滚轮可微调，按住 Shift 粗调</p>
      </PopoverContent>
    </Popover>
  )
}

/** 3D 仪器旋钮与开关直控（技术设计 §10.3，T1.9B）：零滚轮冲突；悬停提示，单击开关切换，单击旋钮弹出微调浮窗并同步 3D MOVING_ 节点。 */
export const InstrumentControls3D = memo(function InstrumentControls3D({
  model,
  instanceId,
  anchors,
  enabled,
}: {
  model: Object3D
  instanceId: string
  anchors: AssetAnchor[]
  enabled: boolean
}) {
  const panel = useInstrumentPanels((state) => state.panels.find((entry) => entry.id === instanceId))
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    if (!panel) return
    let moved = false
    for (const anchor of anchors) {
      if (anchor.kind !== 'KNOB' && anchor.kind !== 'SW') continue
      const moving = model.getObjectByName(`MOVING_${anchor.id}`)
      if (!moving) continue
      const binding = resolveInstrumentControlBinding(panel, anchor.name, anchor.kind)
      if (!binding?.slider) continue
      moving.rotation.z = (-knobAngle(binding.slider.value, binding.slider.min, binding.slider.max) * Math.PI) / 180
      moved = true
    }
    if (moved) invalidate()
  }, [model, anchors, panel, invalidate])

  if (!panel) return null
  return (
    <>
      {anchors
        .filter((anchor) => anchor.kind === 'KNOB' || anchor.kind === 'SW')
        .map((anchor) => {
          const binding = resolveInstrumentControlBinding(panel, anchor.name, anchor.kind as 'KNOB' | 'SW')
          if (!binding) return null
          return (
            <InstrumentControlTarget
              key={anchor.name}
              instanceId={instanceId}
              anchor={anchor}
              binding={binding}
              enabled={enabled}
            />
          )
        })}
    </>
  )
})
