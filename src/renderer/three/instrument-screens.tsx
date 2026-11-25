import { decodeSegment7Mask, isMeasurementInstrument, parseSegment7ModeMask, resolveScope } from '@domain/instruments'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { CanvasTexture, type Material, MeshBasicMaterial, type Object3D, SRGBColorSpace } from 'three'
import { knobAngle } from '@/components/instruments/rotary-knob-values'
import { paintScope } from '@/components/instruments/scope-painter'
import { instrumentScreenTargets, screenReadingKey } from '@/components/instruments/screen-targets'
import {
  getInstrumentReading,
  type InstrumentReading,
  readingIsWarning,
  readingStatusLabel,
  subscribeInstrumentReadings,
} from '@/lib/instrument-readings'
import { acquireScope, type ScopeSummary, scopeSummary } from '@/lib/scope-acquisition'
import { useInstrumentPanels } from '@/stores/instrument-panels'

type ScreenBinding = {
  id: string
  mesh: ReturnType<typeof instrumentScreenTargets>[number]['mesh']
  context: CanvasRenderingContext2D
  texture: CanvasTexture
  material: MeshBasicMaterial
  original: Material | Material[]
}

const renderedScreens = new WeakMap<HTMLCanvasElement, Record<string, { text: string; unit: string; status: string }>>()
const renderedScopes = new WeakMap<HTMLCanvasElement, Record<string, ScopeSummary>>()
/** 3D 示波器屏幕纹理刷新上限 */
const SCOPE_TEXTURE_MS = 33

function scopePanel(instanceId: string) {
  const panel = useInstrumentPanels.getState().panels.find((entry) => entry.id === instanceId)
  return panel?.instrument.scope ? panel : undefined
}

function paintGalvanometer(context: CanvasRenderingContext2D, reading: InstrumentReading) {
  const { width, height } = context.canvas
  const style = getComputedStyle(document.documentElement)
  const fg = style.getPropertyValue(readingIsWarning(reading) ? '--warning' : '--foreground').trim()
  const accent = style.getPropertyValue('--destructive').trim()
  context.fillStyle = style.getPropertyValue('--muted').trim()
  context.fillRect(0, 0, width, height)

  const cx = width / 2
  const cy = height * 0.88
  const radius = Math.min(width * 0.42, height * 0.72)
  const maxRad = (45 * Math.PI) / 180

  context.strokeStyle = fg
  context.lineWidth = Math.max(2, height * 0.015)
  context.beginPath()
  context.arc(cx, cy, radius, -Math.PI / 2 - maxRad, -Math.PI / 2 + maxRad)
  context.stroke()

  context.fillStyle = fg
  context.font = `${Math.round(height * 0.09)}px "JetBrains Mono Variable", monospace`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (const mark of [-1, -0.5, 0, 0.5, 1]) {
    const theta = -Math.PI / 2 + mark * maxRad
    context.beginPath()
    context.moveTo(cx + Math.cos(theta) * (radius * 0.88), cy + Math.sin(theta) * (radius * 0.88))
    context.lineTo(cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius)
    context.stroke()
    context.fillText(
      mark === 0 ? '0' : `${mark > 0 ? '+' : ''}${mark * 100}`,
      cx + Math.cos(theta) * (radius * 0.72),
      cy + Math.sin(theta) * (radius * 0.72),
    )
  }

  const deflection = Math.max(-1, Math.min(1, reading.deflection ?? 0))
  const needleTheta = -Math.PI / 2 + deflection * maxRad
  context.strokeStyle = accent
  context.lineWidth = Math.max(3, height * 0.022)
  context.beginPath()
  context.moveTo(cx, cy)
  context.lineTo(cx + Math.cos(needleTheta) * (radius * 0.92), cy + Math.sin(needleTheta) * (radius * 0.92))
  context.stroke()

  context.fillStyle = fg
  context.beginPath()
  context.arc(cx, cy, Math.max(4, height * 0.03), 0, Math.PI * 2)
  context.fill()

  context.font = `${Math.round(height * 0.11)}px "JetBrains Mono Variable", monospace`
  context.textAlign = 'right'
  context.fillText(`${reading.text} ${reading.unit}`.trim(), width - height * 0.08, height * 0.14)
}

function paintSegment7(context: CanvasRenderingContext2D, reading: InstrumentReading, mask: number) {
  const { width, height } = context.canvas
  const style = getComputedStyle(document.documentElement)
  const bg = style.getPropertyValue('--muted').trim()
  const onColor = style.getPropertyValue('--destructive').trim()
  const offColor = style.getPropertyValue('--border').trim()
  const labelColor = style.getPropertyValue('--muted-foreground').trim()
  context.fillStyle = bg
  context.fillRect(0, 0, width, height)

  if (reading.label) {
    context.fillStyle = labelColor
    context.font = `${Math.max(18, Math.round(height * 0.08))}px "Noto Sans SC Variable", sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'top'
    context.fillText(reading.label, width / 2, height * 0.04)
  }

  const state = decodeSegment7Mask(reading.status === 'ok' ? mask : 0)
  const top = height * 0.17
  const drawH = height * 0.74
  const drawW = Math.min(width * 0.62, drawH * 0.56)
  const left = (width - drawW) / 2
  const t = Math.max(10, Math.round(drawW * 0.14))
  const midY = top + drawH / 2
  const gap = t * 0.24

  const drawHBar = (x: number, y: number, w: number, lit: boolean) => {
    context.save()
    context.globalAlpha = lit ? 1 : 0.22
    context.fillStyle = lit ? onColor : offColor
    const half = t / 2
    context.beginPath()
    context.moveTo(x + gap, y)
    context.lineTo(x + gap + half, y - half)
    context.lineTo(x + w - gap - half, y - half)
    context.lineTo(x + w - gap, y)
    context.lineTo(x + w - gap - half, y + half)
    context.lineTo(x + gap + half, y + half)
    context.closePath()
    context.fill()
    context.restore()
  }

  const drawVBar = (x: number, y: number, h: number, lit: boolean) => {
    context.save()
    context.globalAlpha = lit ? 1 : 0.22
    context.fillStyle = lit ? onColor : offColor
    const half = t / 2
    context.beginPath()
    context.moveTo(x, y + gap)
    context.lineTo(x + half, y + gap + half)
    context.lineTo(x + half, y + h - gap - half)
    context.lineTo(x, y + h - gap)
    context.lineTo(x - half, y + h - gap - half)
    context.lineTo(x - half, y + gap + half)
    context.closePath()
    context.fill()
    context.restore()
  }

  const halfH = drawH / 2
  const [a, b, c, d, e, f, g] = state.lit
  drawHBar(left, top, drawW, a)
  drawVBar(left + drawW, top, halfH, b)
  drawVBar(left + drawW, midY, halfH, c)
  drawHBar(left, top + drawH, drawW, d)
  drawVBar(left, midY, halfH, e)
  drawVBar(left, top, halfH, f)
  drawHBar(left, midY, drawW, g)
}

function paintReading(context: CanvasRenderingContext2D, reading: InstrumentReading, galvanometer = false) {
  const segMask = parseSegment7ModeMask(reading.mode)
  if (segMask !== undefined) {
    paintSegment7(context, reading, segMask)
    return
  }
  if (galvanometer) {
    paintGalvanometer(context, reading)
    return
  }
  const { width, height } = context.canvas
  const style = getComputedStyle(document.documentElement)
  const padding = Math.round(height * 0.1)
  context.fillStyle = style.getPropertyValue('--muted').trim()
  context.fillRect(0, 0, width, height)
  context.fillStyle = style.getPropertyValue(readingIsWarning(reading) ? '--warning' : '--foreground').trim()
  context.textBaseline = 'middle'
  context.font = `${Math.round(height * 0.13)}px "Noto Sans SC Variable", sans-serif`
  context.textAlign = 'left'
  context.fillText(reading.mode ?? '', padding, padding * 1.7)
  context.textAlign = 'right'
  context.fillText(readingStatusLabel(reading), width - padding, padding * 1.7)

  context.font = `${Math.round(height * 0.18)}px "JetBrains Mono Variable", monospace`
  const unitWidth = reading.unit ? context.measureText(reading.unit).width + padding : 0
  context.fillText(reading.unit, width - padding, height * 0.71)
  let fontSize = Math.round(height * 0.51)
  context.font = `${fontSize}px "DSEG7 Classic", monospace`
  const available = width - padding * 2 - unitWidth
  const measured = context.measureText(reading.text).width
  if (measured > available) {
    fontSize = Math.floor((fontSize * available) / measured)
    context.font = `${fontSize}px "DSEG7 Classic", monospace`
  }
  context.fillText(reading.text, width - padding - unitWidth, height * 0.67)
}

/** Attach live textures to the existing GLB; no extra screen planes or React reading state. */
export function InstrumentScreens({ model, instanceId }: { model: Object3D; instanceId: string }) {
  const invalidate = useThree((state) => state.invalidate)
  const canvas = useThree((state) => state.gl.domElement)
  const bindings = useRef<ScreenBinding[]>([])
  const dirty = useRef(true)

  useEffect(() => {
    let disposed = false
    const targets = instrumentScreenTargets(model)
    const grids = targets.flatMap((target) =>
      target.grid ? [{ node: target.grid, visible: target.grid.visible }] : [],
    )
    const screens = targets.map((target): ScreenBinding => {
      const surface = document.createElement('canvas')
      surface.width = scopePanel(instanceId) ? 768 : 512
      surface.height = Math.max(96, Math.min(480, Math.round((surface.width * target.height) / target.width)))
      const context = surface.getContext('2d')
      if (!context) throw new Error('Instrument screen requires Canvas 2D')
      const texture = new CanvasTexture(surface)
      texture.colorSpace = SRGBColorSpace
      const material = new MeshBasicMaterial({ map: texture, toneMapped: false })
      material.name = `${target.mesh.name}_LIVE`
      const original = target.mesh.material
      target.mesh.material = material
      return { id: target.id, mesh: target.mesh, context, texture, material, original }
    })
    for (const grid of grids) grid.node.visible = false
    bindings.current = screens

    const refresh = () => {
      if (disposed) return
      dirty.current = true
      invalidate()
    }
    const knobs: { node: Object3D; moving: Object3D; rotation: number }[] = []
    model.traverse((node) => {
      if (!node.name.startsWith('KNOB_')) return
      const moving = node.getObjectByName(`MOVING_${node.name.slice('KNOB_'.length)}`)
      if (moving) knobs.push({ node, moving, rotation: moving.rotation.z })
    })
    const syncKnobs = () => {
      const panel = useInstrumentPanels.getState().panels.find((entry) => entry.id === instanceId)
      if (!panel) return
      for (const knob of knobs) {
        const control = panel.instrument.settingsControls?.find((entry) => entry.anchor === knob.node.name)
        let degrees: number | undefined
        if (control) {
          const value = panel.settings[control.id]
          degrees = knobAngle(typeof value === 'number' ? value : control.default, control.min, control.max)
        } else if (knobs.length === 1 && isMeasurementInstrument(panel.instrument)) {
          const range = panel.settings.range ?? panel.instrument.defaultRange ?? panel.instrument.ranges[0]?.id
          degrees = knobAngle(
            panel.instrument.ranges.findIndex((entry) => entry.id === range),
            0,
            panel.instrument.ranges.length - 1,
          )
        } else if (panel.instrument.scope) {
          const scope = resolveScope(panel.instrument, panel.settings)
          const { config } = scope
          switch (knob.node.name) {
            case 'KNOB_CH1_SCALE':
              degrees = knobAngle(
                config.voltsPerDiv.indexOf(scope.channels[0]?.voltsPerDiv ?? config.voltsPerDiv[0] ?? 1),
                0,
                config.voltsPerDiv.length - 1,
              )
              break
            case 'KNOB_CH2_SCALE':
              degrees = knobAngle(
                config.voltsPerDiv.indexOf(scope.channels[1]?.voltsPerDiv ?? config.voltsPerDiv[0] ?? 1),
                0,
                config.voltsPerDiv.length - 1,
              )
              break
            case 'KNOB_CH1_POSITION':
              degrees = knobAngle(scope.channels[0]?.position ?? 0, -4, 4)
              break
            case 'KNOB_CH2_POSITION':
              degrees = knobAngle(scope.channels[1]?.position ?? 0, -4, 4)
              break
            case 'KNOB_TIMEBASE':
              degrees = knobAngle(config.secondsPerDiv.indexOf(scope.secondsPerDiv), 0, config.secondsPerDiv.length - 1)
              break
            case 'KNOB_TRIGGER':
              degrees = knobAngle(scope.trigger.level, -20, 20)
              break
          }
        }
        if (degrees !== undefined) knob.moving.rotation.z = knob.rotation - (degrees * Math.PI) / 180
      }
      refresh()
    }
    syncKnobs()
    const offSettings = useInstrumentPanels.subscribe(syncKnobs)
    const offReadings = subscribeInstrumentReadings(instanceId, refresh)
    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    // 示波器波形：采样到达或设置变化时才请求重绘（frameloop="demand"），2D 面板读同一缓存帧
    let scopeRevision = -1
    let scopeSettings: unknown
    const scopeTimer = setInterval(() => {
      const panel = scopePanel(instanceId)
      if (!panel) return
      const frame = acquireScope(instanceId, panel.instrument, panel.settings)
      if (frame.revision === scopeRevision && panel.settings === scopeSettings) return
      scopeRevision = frame.revision
      scopeSettings = panel.settings
      refresh()
    }, SCOPE_TEXTURE_MS)
    void document.fonts
      .load('64px "DSEG7 Classic"')
      .then(refresh)
      .catch(() => undefined)
    refresh()
    return () => {
      disposed = true
      clearInterval(scopeTimer)
      observer.disconnect()
      offReadings()
      offSettings()
      for (const knob of knobs) knob.moving.rotation.z = knob.rotation
      for (const grid of grids) grid.node.visible = grid.visible
      for (const screen of screens) {
        if (screen.mesh.material === screen.material) screen.mesh.material = screen.original
        screen.texture.dispose()
        screen.material.dispose()
        const rendered = renderedScreens.get(canvas)
        if (rendered) delete rendered[`${instanceId}.${screen.id}`]
        const scopes = renderedScopes.get(canvas)
        if (scopes) delete scopes[`${instanceId}.${screen.id}`]
      }
      bindings.current = []
      const region = canvas.closest<HTMLElement>('[aria-label="3D 实训台"]')
      if (region) {
        region.dataset.instrumentScreenReadings = JSON.stringify(renderedScreens.get(canvas) ?? {})
        region.dataset.instrumentScopeScreens = JSON.stringify(renderedScopes.get(canvas) ?? {})
      }
    }
  }, [model, instanceId, invalidate, canvas])

  useFrame(() => {
    if (!dirty.current) return
    dirty.current = false
    let rendered = renderedScreens.get(canvas)
    if (!rendered) {
      rendered = {}
      renderedScreens.set(canvas, rendered)
    }
    const panel = scopePanel(instanceId)
    let scopes = renderedScopes.get(canvas)
    if (!scopes) {
      scopes = {}
      renderedScopes.set(canvas, scopes)
    }
    for (const binding of bindings.current) {
      if (panel) {
        const frame = acquireScope(instanceId, panel.instrument, panel.settings)
        const settings = resolveScope(panel.instrument, panel.settings)
        paintScope(binding.context, frame, settings)
        binding.texture.needsUpdate = true
        scopes[`${instanceId}.${binding.id}`] = scopeSummary(frame, settings)
        continue
      }
      const reading = getInstrumentReading(instanceId, screenReadingKey(binding.id))
      const currentPanel = useInstrumentPanels.getState().panels.find((entry) => entry.id === instanceId)
      paintReading(binding.context, reading, currentPanel?.instrument.kind === 'galvanometer')
      binding.texture.needsUpdate = true
      binding.mesh.userData.reading = reading.text
      binding.mesh.userData.readingStatus = reading.status
      rendered[`${instanceId}.${binding.id}`] = { text: reading.text, unit: reading.unit, status: reading.status }
    }
    const region = canvas.closest<HTMLElement>('[aria-label="3D 实训台"]')
    if (region) {
      region.dataset.instrumentScreenReadings = JSON.stringify(rendered)
      if (panel) region.dataset.instrumentScopeScreens = JSON.stringify(scopes)
    }
  })
  return null
}
