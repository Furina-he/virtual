import type { CameraControls } from '@react-three/drei'
import { type ThreeEvent, useThree } from '@react-three/fiber'
import { type RefObject, useCallback, useEffect, useRef } from 'react'
import { Plane, Raycaster, Vector2, Vector3 } from 'three'
import { circuitStore, useCircuit, type WiringJack } from '@/features/practice/wiring-state'
import type { DragDraft } from './patch-cords'

interface DragState {
  pointerId: number
  source: string
  start: Vector2
  moved: boolean
}

export function useWiringInteraction(jacks: WiringJack[], region: RefObject<HTMLElement | null>, enabled: boolean) {
  const { gl, camera, scene, invalidate } = useThree()
  const controls = useThree((state) => state.controls) as CameraControls | null
  const pending = useCircuit((state) => state.pendingJack)
  const drag = useRef<DragState | null>(null)
  const draft = useRef<DragDraft>({ target: new Vector3(), revision: 0 })
  const raycaster = useRef(new Raycaster())
  const pointer = useRef(new Vector2())
  const plane = useRef(new Plane(new Vector3(0, 0, 1)))
  const originalTouchAction = useRef('')

  const release = useCallback(() => {
    const active = drag.current
    drag.current = null
    if (active && gl.domElement.hasPointerCapture(active.pointerId))
      gl.domElement.releasePointerCapture(active.pointerId)
    gl.domElement.style.touchAction = originalTouchAction.current
    if (controls) controls.enabled = circuitStore.getState().pendingJack === null
  }, [gl, controls])

  const cancel = useCallback(() => {
    release()
    circuitStore.getState().cancelConnection()
    invalidate()
  }, [release, invalidate])

  useEffect(() => {
    if (!pending || !enabled) {
      if (drag.current) release()
      if (!enabled) circuitStore.getState().cancelConnection()
      return
    }
    const jack = jacks.find((entry) => entry.ref === pending)
    if (jack && !drag.current) {
      draft.current.target.set(...jack.position).add(new Vector3(0.04, -0.04, 0.08))
      draft.current.revision++
      plane.current.constant = -(jack.position[2] + 0.08)
      invalidate()
    }
  }, [pending, enabled, jacks, invalidate, release])

  useEffect(() => {
    const pick = (event: PointerEvent) => {
      const bounds = gl.domElement.getBoundingClientRect()
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        return { inside: false, jack: null }
      pointer.current.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      )
      raycaster.current.setFromCamera(pointer.current, camera)
      const hits = raycaster.current.intersectObjects(scene.children, true)
      const source = circuitStore.getState().pendingJack
      const hit = hits.find(
        (item) =>
          item.object.userData.jackRef !== source &&
          !item.object.userData.wireId &&
          !item.object.userData.ignoreWiringHit,
      )
      return {
        inside: true,
        jack: typeof hit?.object.userData.jackRef === 'string' ? (hit.object.userData.jackRef as string) : null,
      }
    }
    const move = (event: PointerEvent) => {
      if (!circuitStore.getState().pendingJack) return
      const active = drag.current
      if (active && event.pointerId !== active.pointerId) return
      if (active && active.start.distanceTo(new Vector2(event.clientX, event.clientY)) > 4) active.moved = true
      const hit = pick(event)
      if (hit.jack) {
        const target = jacks.find((item) => item.ref === hit.jack)
        if (target) draft.current.target.set(...target.position)
      } else if (hit.inside) raycaster.current.ray.intersectPlane(plane.current, draft.current.target)
      draft.current.revision++
      if (region.current) region.current.dataset.draftTarget = hit.jack ?? ''
      invalidate()
    }
    const up = (event: PointerEvent) => {
      const active = drag.current
      if (!active || event.pointerId !== active.pointerId || event.button !== 0) return
      const hit = pick(event)
      release()
      if (hit.jack && hit.jack !== active.source) {
        circuitStore.getState().cancelConnection()
        circuitStore.getState().addWire(active.source, hit.jack)
      } else if (active.moved || !hit.inside) circuitStore.getState().cancelConnection()
      invalidate()
    }
    const lost = () => {
      if (drag.current) cancel()
    }
    gl.domElement.addEventListener('pointermove', move)
    gl.domElement.addEventListener('pointerup', up)
    gl.domElement.addEventListener('pointercancel', cancel)
    gl.domElement.addEventListener('lostpointercapture', lost)
    window.addEventListener('blur', cancel)
    return () => {
      gl.domElement.removeEventListener('pointermove', move)
      gl.domElement.removeEventListener('pointerup', up)
      gl.domElement.removeEventListener('pointercancel', cancel)
      gl.domElement.removeEventListener('lostpointercapture', lost)
      window.removeEventListener('blur', cancel)
      release()
    }
  }, [gl, camera, scene, jacks, region, invalidate, release, cancel])

  const start = useCallback(
    (ref: string, event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 0 || !enabled) return
      event.stopPropagation()
      event.nativeEvent.stopImmediatePropagation()
      const state = circuitStore.getState()
      if (state.pendingJack && state.pendingJack !== ref) {
        state.cancelConnection()
        state.addWire(state.pendingJack, ref)
        return
      }
      if (!state.setPendingJack(ref) && state.pendingJack !== ref) return
      const jack = jacks.find((entry) => entry.ref === ref)
      if (!jack) return
      if (controls) controls.enabled = false
      drag.current = {
        pointerId: event.pointerId,
        source: ref,
        start: new Vector2(event.clientX, event.clientY),
        moved: false,
      }
      originalTouchAction.current = gl.domElement.style.touchAction
      gl.domElement.style.touchAction = 'none'
      gl.domElement.setPointerCapture(event.pointerId)
      plane.current.constant = -(jack.position[2] + 0.08)
      draft.current.target.set(...jack.position).add(new Vector3(0, 0, 0.06))
      draft.current.revision++
      invalidate()
    },
    [enabled, jacks, gl, controls, invalidate],
  )
  return { start, draft, cancel }
}
