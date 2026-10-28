import { isMeasurementInstrument } from '@domain/instruments'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { CanvasTexture, type Material, MeshBasicMaterial, type Object3D, SRGBColorSpace } from 'three'
import { knobAngle } from '@/components/instruments/rotary-knob-values'
import { instrumentScreenTargets, screenReadingKey } from '@/components/instruments/screen-targets'
import {
  getInstrumentReading,
  type InstrumentReading,
  readingIsWarning,
  readingStatusLabel,
  subscribeInstrumentReadings,
} from '@/lib/instrument-readings'
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

function paintReading(context: CanvasRenderingContext2D, reading: InstrumentReading) {
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
      surface.width = 512
      surface.height = Math.max(96, Math.min(384, Math.round((512 * target.height) / target.width)))
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
    void document.fonts
      .load('64px "DSEG7 Classic"')
      .then(refresh)
      .catch(() => undefined)
    refresh()
    return () => {
      disposed = true
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
      }
      bindings.current = []
      const region = canvas.closest<HTMLElement>('[aria-label="3D 实训台"]')
      if (region) region.dataset.instrumentScreenReadings = JSON.stringify(renderedScreens.get(canvas) ?? {})
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
    for (const binding of bindings.current) {
      const reading = getInstrumentReading(instanceId, screenReadingKey(binding.id))
      paintReading(binding.context, reading)
      binding.texture.needsUpdate = true
      binding.mesh.userData.reading = reading.text
      binding.mesh.userData.readingStatus = reading.status
      rendered[`${instanceId}.${binding.id}`] = { text: reading.text, unit: reading.unit, status: reading.status }
    }
    const region = canvas.closest<HTMLElement>('[aria-label="3D 实训台"]')
    if (region) region.dataset.instrumentScreenReadings = JSON.stringify(rendered)
  })
  return null
}
