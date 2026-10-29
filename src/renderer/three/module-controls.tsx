import { type ThreeEvent, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useRef } from 'react'
import type { Object3D } from 'three'
import { knobAngle } from '@/components/instruments/rotary-knob-values'
import { selectModuleControl, setModuleControl } from '@/features/practice/module-controls'
import { moduleCatalog } from '@/features/practice/practice-content'
import { useCircuit } from '@/features/practice/wiring-state'
import type { ModuleControl } from '../../shared/schema/module'
import type { AssetAnchor } from './anchors'

function controlValue(control: ModuleControl, previous: number, steps: number): number {
  if (control.steps) {
    const index = control.steps.indexOf(previous)
    return control.steps[Math.max(0, Math.min(control.steps.length - 1, index + steps))] ?? previous
  }
  const [min, max] = control.range ?? [0, 1]
  const step = control.step ?? (max - min) / 100
  return Math.max(min, Math.min(max, min + Math.round((previous + steps * step - min) / step) * step))
}

function ControlTarget({
  instanceId,
  control,
  anchor,
  enabled,
}: {
  instanceId: string
  control: ModuleControl
  anchor: AssetAnchor
  enabled: boolean
}) {
  const camera = useThree((state) => state.controls) as { enabled: boolean } | null
  const canvas = useThree((state) => state.gl.domElement)
  const value = useCircuit((state) => state.controlValues[`${instanceId}.${control.id}`] ?? control.default)
  const drag = useRef<{ y: number; value: number; pointerId: number } | null>(null)
  const stop = useCallback(() => {
    const pointer = drag.current?.pointerId
    drag.current = null
    if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer)
    if (camera) camera.enabled = true
  }, [canvas, camera])
  useEffect(() => {
    const cancel = () => stop()
    const move = (event: PointerEvent) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      setModuleControl(
        instanceId,
        control.id,
        controlValue(control, current.value, Math.round((current.y - event.clientY) / 8)),
      )
    }
    window.addEventListener('blur', cancel)
    canvas.addEventListener('pointercancel', cancel)
    canvas.addEventListener('pointerup', cancel)
    canvas.addEventListener('pointermove', move)
    return () => {
      window.removeEventListener('blur', cancel)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('pointerup', cancel)
      canvas.removeEventListener('pointermove', move)
      stop()
    }
  }, [canvas, stop, instanceId, control])
  const begin = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    if (!enabled || event.button !== 0) return
    selectModuleControl(instanceId, control.id)
    if (control.kind === 'switch' && control.steps) {
      const index = control.steps.indexOf(value)
      setModuleControl(instanceId, control.id, control.steps[(index + 1) % control.steps.length] ?? value)
      return
    }
    drag.current = { y: event.clientY, value, pointerId: event.pointerId }
    canvas.setPointerCapture(event.pointerId)
    if (camera) camera.enabled = false
  }
  return (
    <group position={anchor.position} quaternion={anchor.quaternion}>
      <mesh
        position={[0, 0, 0.011]}
        onPointerOver={(event) => event.stopPropagation()}
        onPointerDown={begin}
        onPointerMove={(event) => {
          event.stopPropagation()
        }}
        onPointerUp={(event) => {
          event.stopPropagation()
          stop()
        }}
      >
        <sphereGeometry args={[control.kind === 'switch' ? 0.008 : 0.012, 12, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}

export function ModuleControls3D({
  model,
  instanceId,
  assetId,
  anchors,
  enabled,
}: {
  model: Object3D
  instanceId: string
  assetId: string
  anchors: AssetAnchor[]
  enabled: boolean
}) {
  const module = moduleCatalog.find((entry) => entry.id === assetId)
  const values = useCircuit((state) => state.controlValues)
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    for (const control of module?.controls ?? []) {
      const moving = model.getObjectByName(`MOVING_${control.id}`)
      if (!moving) continue
      const value = values[`${instanceId}.${control.id}`] ?? control.default
      if (control.kind === 'switch') moving.rotation.x = value === control.steps?.[0] ? -Math.PI / 8 : Math.PI / 8
      else {
        const min = control.range?.[0] ?? Math.min(...(control.steps ?? [0]))
        const max = control.range?.[1] ?? Math.max(...(control.steps ?? [1]))
        moving.rotation.z = (-knobAngle(value, min, max) * Math.PI) / 180
      }
    }
    invalidate()
  }, [module, model, instanceId, values, invalidate])
  return (
    <>
      {module?.controls.map((control) => {
        const anchor = anchors.find(
          (entry) => entry.id === control.id && (entry.kind === 'KNOB' || entry.kind === 'SW'),
        )
        return anchor ? (
          <ControlTarget key={control.id} instanceId={instanceId} control={control} anchor={anchor} enabled={enabled} />
        ) : null
      })}
    </>
  )
}
