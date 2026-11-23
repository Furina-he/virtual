import {
  buildXyTrace,
  formatFrequency,
  formatSeconds,
  formatVoltage,
  measureCursors,
  type ScopeSettings,
  triggerColumn,
  type XyPoint,
} from '@domain/instruments'
import type { ScopeFrame, ScopeState } from '@/lib/scope-acquisition'

// 2D OscilloscopeScreen 与 3D SCREEN_ 共用的绘制：网格、轨迹、触发标记、自动测量。颜色全部取自 CSS token。

const STATE_LABEL: Record<ScopeState, string> = {
  off: '无信号',
  auto: '自动',
  triggered: '已触发',
  waiting: '等待触发',
  ready: '单次待触发',
  stopped: '停止',
}
const COUPLING_LABEL = { dc: 'DC', ac: 'AC', gnd: 'GND' } as const
const CHANNEL_TOKENS = ['--scope-ch1', '--scope-ch2']

export function scopeStateLabel(state: ScopeState): string {
  return STATE_LABEL[state]
}

export function channelScaleText(settings: ScopeSettings, index: number): string {
  const channel = settings.channels[index]
  if (!channel) return ''
  if (!channel.enabled) return `${channel.label} 关`
  return `${channel.label} ${formatVoltage(channel.voltsPerDiv)}/div ${COUPLING_LABEL[channel.coupling]}`
}

/** 自动测量文字；未接入、关闭或 GND 耦合时为 "--" */
export function measurementText(frame: ScopeFrame, settings: ScopeSettings, index: number): string {
  const m = frame.measurements[index]
  if (!settings.channels[index]?.enabled || (!frame.traces[index] && !frame.envelopes?.[index]) || !m)
    return 'Vpp --  f --  T --'
  const f = m.frequency === null ? null : formatFrequency(m.frequency)
  return `Vpp ${formatVoltage(m.vpp)}  f ${f ? `${f.text} ${f.unit}` : '--'}  T ${m.period === null ? '--' : formatSeconds(m.period)}`
}

export function cursorMeasurementText(frame: ScopeFrame, settings: ScopeSettings): string {
  const cursors = measureCursors(settings, frame.traces, frame.measurements)
  if (!cursors) return ''
  if (cursors.mode === 'time') {
    const t1 = cursors.t1 !== null ? formatSeconds(cursors.t1) : '--'
    const t2 = cursors.t2 !== null ? formatSeconds(cursors.t2) : '--'
    const dt = cursors.deltaT !== null ? formatSeconds(cursors.deltaT) : '--'
    const f = cursors.frequency !== null ? formatFrequency(cursors.frequency) : null
    const freqText = f ? `${f.text} ${f.unit}` : '--'
    const dvText = cursors.deltaV !== null ? `  ΔV ${formatVoltage(cursors.deltaV)}` : ''
    return `光标(${cursors.sourceChannelId}) T1 ${t1}  T2 ${t2}  Δt ${dt}  1/|Δt| ${freqText}${dvText}`
  }
  const v1 = cursors.v1 !== null ? formatVoltage(cursors.v1) : '--'
  const v2 = cursors.v2 !== null ? formatVoltage(cursors.v2) : '--'
  const dv = cursors.deltaV !== null ? formatVoltage(cursors.deltaV) : '--'
  return `光标(${cursors.sourceChannelId}) V1 ${v1}  V2 ${v2}  ΔV ${dv}`
}

export function xyMeasurementText(frame: ScopeFrame, settings: ScopeSettings): string {
  if (settings.displayMode !== 'xy') return ''
  const { summary } = buildXyTrace(settings, frame.traces[0], frame.traces[1], frame.measurements)
  if (!summary) return 'X-Y 模式：需同时开启并接入 CH1 (X) 与 CH2 (Y)'
  return `X-Y 模式 (CH1→X, CH2→Y)  Vxpp ${formatVoltage(summary.xVpp)}  Vypp ${formatVoltage(summary.yVpp)}  ρ ${summary.correlation.toFixed(2)}`
}

const SANS = '"Noto Sans SC Variable", sans-serif'
const MONO = '"JetBrains Mono Variable", monospace'

/** 按可用宽度缩小字号，保证窄面板中文字不重叠、不截断 */
function fitFont(context: CanvasRenderingContext2D, text: string, size: number, family: string, maxWidth: number) {
  context.font = `${size}px ${family}`
  const width = context.measureText(text).width
  if (width > maxWidth && maxWidth > 0)
    context.font = `${Math.max(6, Math.floor((size * maxWidth) / width))}px ${family}`
}

export function paintScope(context: CanvasRenderingContext2D, frame: ScopeFrame, settings: ScopeSettings): void {
  const { width, height } = context.canvas
  const style = getComputedStyle(document.documentElement)
  const color = (token: string) => style.getPropertyValue(token).trim()
  const { x: divX, y: divY } = settings.config.divisions
  const font = Math.max(10, Math.round(height * 0.042))
  const header = Math.round(font * 1.8)
  const footer = Math.round(font * 2.6 * settings.channels.length + font * 0.4)
  const margin = Math.round(font * 0.8)
  const plotW = width - margin * 2
  const plotH = height - header - footer
  const div = Math.min(plotW / divX, plotH / divY)
  const left = Math.round((width - div * divX) / 2)
  const top = Math.round(header + (plotH - div * divY) / 2)
  const right = left + div * divX
  const bottom = top + div * divY
  const centerY = (top + bottom) / 2

  context.fillStyle = color('--scope-screen')
  context.fillRect(0, 0, width, height)

  // 网格：每格实线、中心轴细分刻度
  context.strokeStyle = color('--scope-grid')
  context.lineWidth = Math.max(1, width / 900)
  context.beginPath()
  for (let i = 0; i <= divX; i++) {
    const x = Math.round(left + i * div) + 0.5
    context.moveTo(x, top)
    context.lineTo(x, bottom)
  }
  for (let j = 0; j <= divY; j++) {
    const y = Math.round(top + j * div) + 0.5
    context.moveTo(left, y)
    context.lineTo(right, y)
  }
  const tick = div * 0.08
  const midX = (left + right) / 2
  for (let i = 0; i <= divX * 5; i++) {
    const x = left + (i * div) / 5
    context.moveTo(x, centerY - tick)
    context.lineTo(x, centerY + tick)
  }
  for (let j = 0; j <= divY * 5; j++) {
    const y = top + (j * div) / 5
    context.moveTo(midX - tick, y)
    context.lineTo(midX + tick, y)
  }
  context.stroke()

  context.textBaseline = 'middle'

  // 轨迹
  context.save()
  context.beginPath()
  context.rect(left, top, right - left, bottom - top)
  context.clip()
  context.lineWidth = Math.max(1.5, width / 500)
  context.lineJoin = 'round'
  if (settings.displayMode === 'xy') {
    const { points } = buildXyTrace(settings, frame.traces[0], frame.traces[1], frame.measurements)
    if (points.length >= 2) {
      const stride = Math.max(1, Math.floor(points.length / 2000))
      context.strokeStyle = color(CHANNEL_TOKENS[0] ?? '--scope-text')
      context.beginPath()
      for (let i = 0; i < points.length; i += stride) {
        const pt = points[i] as XyPoint
        const x = midX + pt.xDiv * div
        const y = centerY - pt.yDiv * div
        if (i === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.stroke()
    }
  } else {
    settings.channels.forEach((channel, index) => {
      const trace = frame.traces[index]
      const envelope = frame.envelopes?.[index]
      if (!channel.enabled || (!envelope && (!trace || trace.length < 2))) return
      const offset = channel.coupling === 'ac' ? (frame.measurements[index]?.mean ?? 0) : 0
      context.strokeStyle = color(CHANNEL_TOKENS[index] ?? '--scope-text')
      if (envelope) {
        context.beginPath()
        const end = envelope.end
        const start = end - settings.secondsPerDiv * divX
        for (let i = 0; i < envelope.min.length; i++) {
          const min = channel.coupling === 'gnd' ? 0 : (envelope.min[i] as number) - offset
          const max = channel.coupling === 'gnd' ? 0 : (envelope.max[i] as number) - offset
          if (!Number.isFinite(min) || !Number.isFinite(max)) continue
          const x = left + ((envelope.start + i * envelope.dt - start) / settings.secondsPerDiv) * div
          context.moveTo(x, centerY - (min / channel.voltsPerDiv + channel.position) * div)
          context.lineTo(x, centerY - (max / channel.voltsPerDiv + channel.position) * div)
        }
        context.stroke()
        return
      }
      if (!trace) return
      const pxPerPoint = div / frame.pointsPerDiv
      const stride = Math.max(1, Math.floor(trace.length / ((right - left) * 2)))
      context.strokeStyle = color(CHANNEL_TOKENS[index] ?? '--scope-text')
      context.beginPath()
      for (let i = 0; i < trace.length; i += stride) {
        const v = channel.coupling === 'gnd' ? 0 : (trace[i] as number) - offset
        const x = left + i * pxPerPoint
        const y = centerY - (v / channel.voltsPerDiv + channel.position) * div
        if (i === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.stroke()
    })
  }
  const cursors = measureCursors(settings, frame.traces, frame.measurements)
  if (cursors) {
    context.save()
    context.strokeStyle = color(CHANNEL_TOKENS[settings.cursors.source] ?? '--scope-text')
    context.lineWidth = Math.max(1, width / 700)
    context.setLineDash([4, 4])
    context.beginPath()
    if (cursors.mode === 'time') {
      const x1 = midX + cursors.aDiv * div
      const x2 = midX + cursors.bDiv * div
      context.moveTo(x1, top)
      context.lineTo(x1, bottom)
      context.moveTo(x2, top)
      context.lineTo(x2, bottom)
    } else {
      const y1 = centerY - cursors.aDiv * div
      const y2 = centerY - cursors.bDiv * div
      context.moveTo(left, y1)
      context.lineTo(right, y1)
      context.moveTo(left, y2)
      context.lineTo(right, y2)
    }
    context.stroke()
    context.restore()
  }
  context.restore()

  // 通道零电平标记（左）、触发电平（右）、触发位置（上）
  const marker = div * 0.22
  settings.channels.forEach((channel, index) => {
    if (!channel.enabled) return
    const y = Math.min(bottom, Math.max(top, centerY - channel.position * div))
    context.fillStyle = color(CHANNEL_TOKENS[index] ?? '--scope-text')
    context.beginPath()
    context.moveTo(left - 2, y)
    context.lineTo(left - 2 - marker, y - marker / 1.6)
    context.lineTo(left - 2 - marker, y + marker / 1.6)
    context.fill()
  })
  const source = settings.channels[settings.trigger.source]
  if (source?.enabled) {
    const y = centerY - (settings.trigger.level / source.voltsPerDiv + source.position) * div
    context.fillStyle = color(CHANNEL_TOKENS[settings.trigger.source] ?? '--scope-text')
    const clamped = Math.min(bottom, Math.max(top, y))
    context.beginPath()
    context.moveTo(right + 2, clamped)
    context.lineTo(right + 2 + marker, clamped - marker / 1.6)
    context.lineTo(right + 2 + marker, clamped + marker / 1.6)
    context.fill()
  }
  const trigX = left + triggerColumn(settings) * div
  context.fillStyle = color('--scope-text')
  context.beginPath()
  context.moveTo(trigX, top - 2)
  context.lineTo(trigX - marker / 1.6, top - 2 - marker)
  context.lineTo(trigX + marker / 1.6, top - 2 - marker)
  context.fill()

  // 顶栏：状态、时基/X-Y、触发
  const slope = settings.trigger.slope === 'rise' ? '↑' : '↓'
  const mode = { auto: '自动', normal: '常规', single: '单次' }[settings.trigger.mode]
  const state = scopeStateLabel(frame.state)
  context.fillStyle = color('--scope-text')
  context.textAlign = 'left'
  context.font = `${font}px ${SANS}`
  context.fillText(state, margin, header / 2)
  const stateWidth = context.measureText(state).width + font
  const timebaseInfo = settings.displayMode === 'xy' ? 'X-Y 模式' : `${formatSeconds(settings.secondsPerDiv)}/div`
  const info = `${timebaseInfo}  ${source?.label ?? ''} ${slope} ${formatVoltage(settings.trigger.level)} ${mode}`
  fitFont(context, info, font, SANS, width - margin * 2 - stateWidth)
  context.textAlign = 'right'
  context.fillText(info, width - margin, header / 2)

  // 底栏：每通道两行，档位与自动测量
  context.textAlign = 'left'
  settings.channels.forEach((_, index) => {
    context.fillStyle = color(CHANNEL_TOKENS[index] ?? '--scope-text')
    const y = bottom + font * (1.1 + index * 2.6)
    const scale = channelScaleText(settings, index)
    fitFont(context, scale, font, MONO, width - margin * 2)
    context.fillText(scale, margin, y)
    const values = measurementText(frame, settings, index)
    fitFont(context, values, font, MONO, width - margin * 2)
    context.fillText(values, margin, y + font * 1.2)
  })
}
