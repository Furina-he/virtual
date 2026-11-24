import { useThree } from '@react-three/fiber'
import { type RefObject, useCallback, useEffect, useMemo, useRef } from 'react'
import { type Object3D, Plane, Raycaster, Vector2, Vector3 } from 'three'
import { circuitStore, useCircuit, type WiringJack } from '@/features/practice/wiring-state'
import { dismissBenchOnboarding } from './bench-onboarding'
import { useBenchView } from './bench-view'
import { type DragDraft, wireEndpointPositions } from './patch-cords'
import {
  facesCamera,
  isOccluded,
  JACK_PICK_RADIUS_PX,
  nearestPolyline,
  nearestTarget,
  pickableDevices,
  pointerInCanvas,
  projectToCanvas,
  type ScreenPoint,
  targetsWithin,
  toNdc,
} from './screen-picking'

interface DragState {
  pointerId: number
  source: string
  start: Vector2
  moved: boolean
}

export interface CordPath {
  id: string
  path: Vector3[]
}

type ScreenJack = ScreenPoint & { id: string; device: string; world: Vector3 }

/** A click that moves less than this is a click, not a pan or a wire drag. */
const CLICK_SLOP_PX = 4
/** Screen pick radius for a selected wire's plug-end replug spheres (T1.9B). */
const ENDPOINT_HANDLE_RADIUS_PX = 14
/** Occlusion is ray-tested only for the nearest few screen candidates. */
const OCCLUSION_CANDIDATES = 4
/** Screen labels: only the nearest few jacks, and only where the device leaves room for text. */
const LABEL_RADIUS_PX = 64
const LABEL_SPACING_PX = 28
const MAX_LABELS = 4
/** A wire started by the first click of a double click is undone when the double click focuses the device. */
const DOUBLE_CLICK_MS = 600

/**
 * Screen-space picking for jacks and wires (技术设计 §10.3). Left button operates; a pending wire keeps
 * zoom, pan and rotate available. Devices whose jacks are still too small on screen focus on click instead.
 */
export function useWiringInteraction(
  jacks: WiringJack[],
  cords: CordPath[],
  solids: RefObject<Object3D[]>,
  region: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const { gl, camera, invalidate } = useThree()
  const pending = useCircuit((state) => state.pendingJack)
  const drag = useRef<DragState | null>(null)
  const pressed = useRef<{ x: number; y: number; onJack: boolean } | null>(null)
  const freshPending = useRef<{ ref: string; at: number } | null>(null)
  const draft = useRef<DragDraft>({ target: new Vector3(), revision: 0 })
  const raycaster = useRef(new Raycaster())
  const plane = useRef(new Plane(new Vector3(0, 0, 1)))
  const originalTouchAction = useRef('')
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const world = useMemo(
    () =>
      jacks.map((jack) => ({
        id: jack.ref,
        device: jack.instanceId,
        world: new Vector3(...jack.position),
        normal: new Vector3(...jack.normal),
      })),
    [jacks],
  )

  const release = useCallback(() => {
    const active = drag.current
    drag.current = null
    if (active && gl.domElement.hasPointerCapture(active.pointerId))
      gl.domElement.releasePointerCapture(active.pointerId)
    gl.domElement.style.touchAction = originalTouchAction.current
  }, [gl])

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
    // 快捷落点浮窗或原理图悬停其他插孔时，3D 预览导线实时吸附指向真实物理插孔（T1.9B）
    return useBenchView.subscribe((state, prev) => {
      if (state.hoveredJack === prev.hoveredJack || drag.current) return
      const targetRef = state.hoveredJack
      if (targetRef && targetRef !== pending) {
        const targetJack = jacks.find((entry) => entry.ref === targetRef)
        if (targetJack) {
          draft.current.target.set(...targetJack.position)
          draft.current.revision++
          if (region.current) region.current.dataset.draftTarget = targetRef
          invalidate()
        }
      }
    })
  }, [pending, enabled, jacks, invalidate, release, region])

  useEffect(() => {
    const canvas = gl.domElement
    const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight })
    const screenJacks = (): ScreenJack[] => {
      const bounds = size()
      const result: ScreenJack[] = []
      for (const jack of world) {
        if (!facesCamera(jack.world, jack.normal, camera)) continue
        const point = projectToCanvas(jack.world, camera, bounds)
        if (point) result.push({ ...point, id: jack.id, device: jack.device, world: jack.world })
      }
      return result
    }
    const pickJackHit = (point: ScreenPoint, visible: ScreenJack[]) => {
      const pickable = pickableDevices(visible)
      const candidates = targetsWithin(
        point,
        visible.filter((jack) => pickable.has(jack.device)),
        JACK_PICK_RADIUS_PX,
      )
        .slice(0, OCCLUSION_CANDIDATES)
        .filter((jack) => !isOccluded(jack.world, camera, solids.current ?? []))
      const target = nearestTarget(point, candidates, JACK_PICK_RADIUS_PX, useBenchView.getState().hoveredJack)
      if (!target) return null
      return { id: target.id, distance: Math.hypot(target.x - point.x, target.y - point.y) }
    }
    const pickJack = (point: ScreenPoint, visible: ScreenJack[]) => pickJackHit(point, visible)?.id ?? null
    const pickWire = (point: ScreenPoint) => {
      const bounds = size()
      return nearestPolyline(
        point,
        cords.map((cord) => ({
          id: cord.id,
          points: cord.path.flatMap((vertex) => projectToCanvas(vertex, camera, bounds) ?? []),
        })),
      )
    }
    const pickSelectedWireEndpoint = (
      point: ScreenPoint,
    ): { wireId: string; end: 'a' | 'b'; jackRef: string; distance: number } | null => {
      const state = circuitStore.getState()
      if (state.powered || state.pendingJack || !state.selectedWireId) return null
      const wire = state.wires.find((entry) => entry.id === state.selectedWireId)
      if (!wire) return null
      const positions = wireEndpointPositions(wire, jacks, state.wires)
      if (!positions) return null
      const bounds = size()
      let best: { wireId: string; end: 'a' | 'b'; jackRef: string; distance: number } | null = null
      for (const end of ['a', 'b'] as const) {
        const projected = projectToCanvas(positions[end], camera, bounds)
        if (!projected) continue
        const distance = Math.hypot(projected.x - point.x, projected.y - point.y)
        if (distance <= ENDPOINT_HANDLE_RADIUS_PX && (!best || distance < best.distance)) {
          best = { wireId: wire.id, end, jackRef: wire[end], distance }
        }
      }
      return best
    }
    const deviceAt = (point: ScreenPoint) => {
      raycaster.current.setFromCamera(toNdc(point, size()), camera)
      raycaster.current.far = Number.POSITIVE_INFINITY
      let node: Object3D | null = raycaster.current.intersectObjects(solids.current ?? [], false)[0]?.object ?? null
      while (node && !node.userData.benchInstance) node = node.parent
      return node && node.userData.benchKind !== 'bench' ? String(node.userData.benchInstance) : null
    }
    const setCursor = (value: string) => {
      if (canvas.style.cursor !== value) canvas.style.cursor = value
    }
    const point = (event: PointerEvent | MouseEvent) => pointerInCanvas(event, canvas.getBoundingClientRect())

    const move = (event: PointerEvent) => {
      const active = drag.current
      if (active && event.pointerId !== active.pointerId) return
      if (active && active.start.distanceTo(new Vector2(event.clientX, event.clientY)) > CLICK_SLOP_PX)
        active.moved = true
      const view = useBenchView.getState()
      const at = point(event)
      // A left/right/middle drag that started on empty space is a camera move; keep hover frozen.
      if (!active && event.buttons !== 0 && pressed.current) {
        setCursor('grabbing')
        return
      }
      const visible = at && enabledRef.current ? screenJacks() : []
      const jack = at && !view.hoveredControl ? pickJack(at, visible) : null
      const wire = at && !jack && !view.hoveredControl ? pickWire(at) : null
      view.setHover({ hoveredJack: jack, hoveredWire: wire })
      const roomy = pickableDevices(visible, LABEL_SPACING_PX)
      view.setNearbyJacks(
        at && !view.hoveredControl && view.showJackLabels && view.persistentLabels.length === 0
          ? targetsWithin(
              at,
              visible.filter((item) => roomy.has(item.device) && item.id !== jack),
              LABEL_RADIUS_PX,
            )
              .slice(0, MAX_LABELS)
              .map((item) => item.id)
          : [],
      )
      if (region.current) region.current.dataset.hoverJack = jack ?? ''
      const selectedEndpoint = at && !active && !view.hoveredControl ? pickSelectedWireEndpoint(at) : null
      if (selectedEndpoint) setCursor('grab')
      else if (view.hoveredControl || jack || wire) setCursor('pointer')
      else if (at && !active) {
        const device = deviceAt(at)
        setCursor(device && !pickableDevices(visible).has(device) ? 'zoom-in' : '')
      } else setCursor('')
      const source = circuitStore.getState().pendingJack
      if (!source) return
      if (jack && jack !== source) {
        const target = jacks.find((item) => item.ref === jack)
        if (target) draft.current.target.set(...target.position)
      } else if (at) {
        raycaster.current.setFromCamera(toNdc(at, size()), camera)
        raycaster.current.ray.intersectPlane(plane.current, draft.current.target)
      }
      draft.current.revision++
      if (region.current) region.current.dataset.draftTarget = jack && jack !== source ? jack : ''
      invalidate()
    }

    const start = (ref: string, event: PointerEvent) => {
      dismissBenchOnboarding()
      const state = circuitStore.getState()
      // 正在改接导线端：落入目标插孔时单步改接该端
      if (state.pendingRewire) {
        if (ref !== state.pendingRewire.fixedJack) {
          state.rewireEndpoint(state.pendingRewire.wireId, state.pendingRewire.end, ref)
        } else {
          state.cancelConnection()
        }
        return
      }
      // 断电按住 Alt 点/拖插孔：直接拔起连接到该插孔的导线端进入改接模式（T1.9A）
      if (event.altKey && !state.pendingJack) {
        const attached = [...state.wires].reverse().find((wire) => wire.a === ref || wire.b === ref)
        if (attached) {
          const end: 'a' | 'b' = attached.a === ref ? 'a' : 'b'
          if (!state.startRewire(attached.id, end)) return
          const fixedRef = end === 'a' ? attached.b : attached.a
          const fixedJack = jacks.find((entry) => entry.ref === fixedRef)
          const origJack = jacks.find((entry) => entry.ref === ref)
          if (!fixedJack) return
          drag.current = {
            pointerId: event.pointerId,
            source: fixedRef,
            start: new Vector2(event.clientX, event.clientY),
            moved: false,
          }
          originalTouchAction.current = canvas.style.touchAction
          canvas.style.touchAction = 'none'
          canvas.setPointerCapture(event.pointerId)
          plane.current.constant = -((origJack?.position[2] ?? fixedJack.position[2]) + 0.08)
          draft.current.target.set(...(origJack?.position ?? fixedJack.position)).add(new Vector3(0, 0, 0.06))
          draft.current.revision++
          invalidate()
          return
        }
      }
      if (state.pendingJack && state.pendingJack !== ref) {
        state.completeConnection(ref, { keepSource: event.shiftKey })
        return
      }
      const wasPending = state.pendingJack === ref
      if (!state.setPendingJack(ref) && !wasPending) return
      if (!wasPending) freshPending.current = { ref, at: performance.now() }
      const jack = jacks.find((entry) => entry.ref === ref)
      if (!jack) return
      drag.current = {
        pointerId: event.pointerId,
        source: ref,
        start: new Vector2(event.clientX, event.clientY),
        moved: false,
      }
      originalTouchAction.current = canvas.style.touchAction
      canvas.style.touchAction = 'none'
      canvas.setPointerCapture(event.pointerId)
      plane.current.constant = -(jack.position[2] + 0.08)
      draft.current.target.set(...jack.position).add(new Vector3(0, 0, 0.06))
      draft.current.revision++
      invalidate()
    }

    const down = (event: PointerEvent) => {
      const at = point(event)
      const press = at ? { x: event.clientX, y: event.clientY, onJack: false } : null
      pressed.current = press
      if (!press || !at || !enabledRef.current || event.button !== 0 || event.detail > 1) return
      if (useBenchView.getState().hoveredControl) return
      const visibleJacks = screenJacks()
      const jackHit = pickJackHit(at, visibleJacks)
      // 选中导线时左键点击护套端手柄直接拔插改接；但若指针更贴近可拾取插孔中心，优先支持同孔叠插新导线（T1.9B）
      const endpointHit = event.altKey ? null : pickSelectedWireEndpoint(at)
      if (endpointHit && (!jackHit || endpointHit.distance < jackHit.distance)) {
        const state = circuitStore.getState()
        const wire = state.wires.find((entry) => entry.id === endpointHit.wireId)
        if (wire) {
          event.stopPropagation()
          press.onJack = true
          dismissBenchOnboarding()
          if (!state.startRewire(wire.id, endpointHit.end)) return
          const fixedRef = endpointHit.end === 'a' ? wire.b : wire.a
          const fixedJack = jacks.find((entry) => entry.ref === fixedRef)
          const origJack = jacks.find((entry) => entry.ref === endpointHit.jackRef)
          if (!fixedJack) return
          drag.current = {
            pointerId: event.pointerId,
            source: fixedRef,
            start: new Vector2(event.clientX, event.clientY),
            moved: false,
          }
          originalTouchAction.current = canvas.style.touchAction
          canvas.style.touchAction = 'none'
          canvas.setPointerCapture(event.pointerId)
          plane.current.constant = -((origJack?.position[2] ?? fixedJack.position[2]) + 0.08)
          draft.current.target.set(...(origJack?.position ?? fixedJack.position)).add(new Vector3(0, 0, 0.06))
          draft.current.revision++
          invalidate()
          return
        }
      }
      const jack = jackHit?.id ?? null
      if (!jack) return
      // Jacks win over the camera: CameraControls listens on the parent and never sees this press.
      event.stopPropagation()
      press.onJack = true
      start(jack, event)
    }

    const up = (event: PointerEvent) => {
      const active = drag.current
      const press = pressed.current
      pressed.current = null
      if (active) {
        if (event.pointerId !== active.pointerId || event.button !== 0) return
        const at = point(event)
        const hit = at ? pickJack(at, screenJacks()) : null
        release()
        const state = circuitStore.getState()
        if (state.pendingRewire) {
          if (hit && hit !== active.source && (active.moved || hit !== state.pendingRewire.originalJack)) {
            state.rewireEndpoint(state.pendingRewire.wireId, state.pendingRewire.end, hit)
          } else if (active.moved || !at) {
            state.cancelConnection()
          }
        } else if (hit && hit !== active.source) {
          const ok = state.completeConnection(hit, { keepSource: event.shiftKey })
          if (!ok && !event.shiftKey) {
            circuitStore.setState({ pendingJack: null, pendingRewire: null })
          }
        } else if (active.moved || !at) state.cancelConnection()
        invalidate()
        return
      }
      if (!press || press.onJack || !enabledRef.current) return
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX) return
      // A right click that did not orbit opens the wire menu; a right drag stays a camera move.
      if (event.button === 2) {
        const at = point(event)
        const wire = at && !circuitStore.getState().pendingJack ? pickWire(at) : null
        if (!wire) return
        circuitStore.getState().selectWire(wire)
        useBenchView.getState().setWireMenu({ id: wire, x: event.clientX, y: event.clientY })
        return
      }
      if (event.button !== 0) return
      const at = point(event)
      if (!at || useBenchView.getState().hoveredControl) return
      const wire = pickWire(at)
      if (wire) {
        circuitStore.getState().selectWire(wire)
        return
      }
      const device = deviceAt(at)
      if (device && !pickableDevices(screenJacks()).has(device)) {
        dismissBenchOnboarding()
        useBenchView.getState().focus(device)
      }
    }

    const doubleClick = (event: MouseEvent) => {
      const at = point(event)
      if (!at || !enabledRef.current || useBenchView.getState().hoveredControl) return
      const device = deviceAt(at)
      if (!device) return
      dismissBenchOnboarding()
      const fresh = freshPending.current
      const state = circuitStore.getState()
      if (fresh && state.pendingJack === fresh.ref && performance.now() - fresh.at < DOUBLE_CLICK_MS)
        state.cancelConnection()
      freshPending.current = null
      useBenchView.getState().focus(device)
    }

    const leave = () => {
      if (drag.current) return
      useBenchView.getState().setHover({ hoveredJack: null, hoveredWire: null })
      useBenchView.getState().setNearbyJacks([])
      setCursor('')
    }
    const lost = () => {
      if (drag.current) cancel()
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerdown', down, { capture: true })
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('pointercancel', cancel)
    canvas.addEventListener('lostpointercapture', lost)
    document.addEventListener('pointerup', up)
    document.addEventListener('dblclick', doubleClick)
    window.addEventListener('blur', cancel)
    return () => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerdown', down, { capture: true })
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('lostpointercapture', lost)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('dblclick', doubleClick)
      window.removeEventListener('blur', cancel)
      canvas.style.cursor = ''
      release()
    }
  }, [gl, camera, jacks, world, cords, solids, region, invalidate, release, cancel])

  return { draft, cancel }
}
