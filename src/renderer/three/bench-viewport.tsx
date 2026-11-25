import { useDroppable } from '@dnd-kit/react'
import { canToggleReferenceOverlay, type GuideMode } from '@domain/task'
import { CameraControls, ContactShadows, Environment, Html, useEnvironment, useGLTF } from '@react-three/drei'
import { addAfterEffect, Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { Power, X } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import {
  Component,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Box3, Euler, Mesh, NeutralToneMapping, type Object3D, Vector3 } from 'three'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  BENCH_DROP_ID,
  INSTRUMENT_DRAG_TYPE,
  useDraggingInstrument,
  useInstrumentPlacement,
} from '@/features/practice/instrument-placement'
import { desktopSlots, placementSignature, slotDisplayName } from '@/features/practice/wiring-context'
import {
  jackName,
  useActivePlacements,
  useCircuit,
  useWiringJacks,
  type WiringJack,
  wiringScene,
} from '@/features/practice/wiring-state'
import { cn } from '@/lib/utils'
import { useInstrumentPanels } from '@/stores/instrument-panels'
import { settingsStore } from '@/stores/settings'
import { collectAnchors } from './anchors'
import {
  activeWorkView,
  assetsForPlacements,
  type Box3Like,
  type CameraPreset,
  cameraView,
  catalog,
  computeActiveBenchBounds,
  focusView,
  localEnvironment,
  previewFov,
} from './asset-catalog'
import { BenchOnboarding } from './bench-onboarding'
import { focusedInstance, useBenchView } from './bench-view'
import { jackStackCount, patchCordGeometry } from './cord-geometry'
import { InstrumentControls3D, InstrumentKnobPopover } from './instrument-controls'
import { InstrumentScreens } from './instrument-screens'
import { createSlotTargets, pickInstrumentSlot, type SlotTarget } from './instrument-slot-picking'
import { layoutVisibleJackLabels } from './jack-label-layout'
import { JackNode3D, readHighlightColor } from './jack-node'
import { cloneQualityModel } from './model-quality'
import { ModuleControls3D } from './module-controls'
import { DiagnosticGuideCord, DraftCord, GuideCords, PatchCords3D, wireEndpointPositions } from './patch-cords'
import { qualityOptions, qualityPreset, useQuality } from './quality-store'
import { QuickTargetWiringDock } from './quick-target-wiring-dock'
import { pickableDevices } from './screen-picking'
import { type CordPath, useWiringInteraction } from './wiring-interaction'

type LoadState = 'loading' | 'ready' | 'error'
type PreviewSummary = { assets: number; anchors: number; jacks: number }

function FailureMessage({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p>无法显示本地 3D 资产。</p>
      <p className="text-xs text-muted-foreground">请重试；若仍无法显示，请检查资源完整性及显卡驱动。</p>
      <Button variant="outline" onClick={onRetry}>
        重新加载
      </Button>
    </div>
  )
}

class AssetBoundary extends Component<
  { children: ReactNode; onError: () => void; onRetry: () => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    console.error('Local asset preview failed:', error)
    this.props.onError()
  }

  render() {
    return this.state.failed ? <FailureMessage onRetry={this.props.onRetry} /> : this.props.children
  }
}

/** 技术设计 §10.3：右键受限旋转，水平方向 ±45°，不转到台子背面和台面以下。 */
const AZIMUTH_LIMIT = Math.PI / 4
const benchBoundary = new Box3(new Vector3(-1, 0.75, -0.5), new Vector3(1, 1.75, 0.5))
const focusBox = new Box3()

type ButtonAction = CameraControls['mouseButtons']['left'] & CameraControls['mouseButtons']['wheel']
type ControlsWithActions = CameraControls & {
  constructor: { ACTION: Record<'NONE' | 'ROTATE' | 'TRUCK' | 'DOLLY', ButtonAction> }
}

function PreviewCamera({
  models,
  region,
  loadState,
  activeInstanceIdsKey,
}: {
  models: RefObject<Map<string, Object3D>>
  region: RefObject<HTMLElement | null>
  loadState: LoadState
  activeInstanceIdsKey: string
}) {
  const controls = useRef<CameraControls>(null)
  const firstFramed = useRef(true)
  const transitionId = useRef(0)
  const aspect = useThree((state) => state.size.width / state.size.height)
  const invalidate = useThree((state) => state.invalidate)
  const reducedMotion = useReducedMotion()
  const dragging = useDraggingInstrument()
  const preset = useBenchView((state) => state.preset)
  const request = useBenchView((state) => state.request)
  useEffect(() => {
    const current = controls.current as ControlsWithActions | null
    if (!current) return
    const { ACTION } = current.constructor
    // Left operates and pans on empty space, right rotates, middle pans, wheel zooms toward the cursor.
    current.mouseButtons.left = ACTION.TRUCK
    current.mouseButtons.middle = ACTION.TRUCK
    current.mouseButtons.right = ACTION.ROTATE
    current.mouseButtons.wheel = ACTION.DOLLY
    current.setBoundary(benchBoundary)
  }, [])
  useEffect(() => {
    if (!controls.current) return
    const isDragging = dragging !== null
    // 拖拽仪表时平滑拉远至全桌面安装位可见视图，确保 SLOT_DESK_1..4 与 SLOT_SCOPE 全部可落点（T1.9B）
    if (isDragging) {
      const view = cameraView('work', aspect)
      const transition = !firstFramed.current && !reducedMotion
      const id = ++transitionId.current
      if (region.current) {
        region.current.dataset.cameraMoving = String(transition)
        region.current.dataset.cameraViewMode = 'drag-slots'
      }
      void controls.current.setLookAt(...view.position, ...view.target, transition).then(() => {
        if (region.current && transitionId.current === id) {
          region.current.dataset.cameraMoving = 'false'
          invalidate()
        }
      })
      return
    }
    // `request` re-runs this for a repeated selection of the same preset after manual navigation.
    if (!preset || !Number.isFinite(request)) {
      if (region.current) region.current.dataset.cameraViewMode = 'custom'
      return
    }
    const instance = focusedInstance(preset)
    const model = instance ? models.current.get(instance) : undefined
    if (instance && !model) {
      if (loadState === 'ready') useBenchView.getState().setPreset('work')
      return
    }
    let view: ReturnType<typeof cameraView>
    let viewMode = 'preset'
    if (model) {
      view = focusView(focusBox.setFromObject(model), aspect)
      viewMode = 'focus'
    } else if (preset === 'work') {
      const activeIds = activeInstanceIdsKey ? activeInstanceIdsKey.split(',') : []
      const boxes: Box3Like[] = []
      for (const activeId of activeIds) {
        const entry = models.current.get(activeId)
        if (!entry) continue
        const box = new Box3().setFromObject(entry)
        if (!box.isEmpty()) boxes.push({ min: box.min, max: box.max })
      }
      const activeBounds = computeActiveBenchBounds(boxes)
      view = activeBounds ? activeWorkView(activeBounds, aspect) : cameraView('work', aspect)
      viewMode = activeBounds ? 'active' : 'preset'
    } else {
      view = cameraView(preset as CameraPreset, aspect)
    }
    const transition = !firstFramed.current && !reducedMotion
    const id = ++transitionId.current
    if (loadState === 'ready') firstFramed.current = false
    if (region.current) {
      region.current.dataset.cameraMoving = String(transition)
      region.current.dataset.cameraViewMode = viewMode
    }
    void controls.current.setLookAt(...view.position, ...view.target, transition).then(() => {
      if (region.current && transitionId.current === id) {
        region.current.dataset.cameraMoving = 'false'
        invalidate()
      }
    })
  }, [preset, request, reducedMotion, region, aspect, models, dragging, loadState, activeInstanceIdsKey, invalidate])
  return (
    <CameraControls
      ref={controls}
      makeDefault
      enabled={!dragging}
      dollyToCursor
      minDistance={0.2}
      maxDistance={6}
      minPolarAngle={0.08}
      maxPolarAngle={Math.PI / 2}
      minAzimuthAngle={-AZIMUTH_LIMIT}
      maxAzimuthAngle={AZIMUTH_LIMIT}
      smoothTime={0.18}
      onControlStart={() => {
        const view = useBenchView.getState()
        view.setPreset(null)
        if (view.activeKnobPopover) view.setActiveKnobPopover(null)
      }}
    />
  )
}

interface WorldJack {
  id: string
  assetId: string
  label: string
  position: Vector3
  normal: Vector3
}

interface WorldInstrumentControl extends WorldJack {
  instanceId: string
  anchor: ReturnType<typeof collectAnchors>[number]
}

function SceneMetrics({
  region,
  onContextLost,
  jacks,
  actualJacks,
  cords,
  slots,
  controls,
  instrumentControls,
}: {
  region: RefObject<HTMLElement | null>
  onContextLost: () => void
  jacks: WorldJack[]
  actualJacks: WiringJack[]
  cords: (CordPath & { midpoint: Vector3 })[]
  slots: SlotTarget[]
  controls: WorldJack[]
  instrumentControls: WorldInstrumentControl[]
}) {
  const gl = useThree((state) => state.gl)
  const cameraControls = useThree((state) => state.controls) as CameraControls | null
  const projection = useMemo(() => new Vector3(), [])
  const viewDirection = useMemo(() => new Vector3(), [])
  const wires = useCircuit((state) => state.wires)
  const selectedWireId = useCircuit((state) => state.selectedWireId)
  const pending = useCircuit((state) => state.pendingJack)
  const placed = useCircuit((state) => state.placedInstruments)
  const controlValues = useCircuit((state) => state.controlValues)
  const frameCount = useRef(0)
  const lastLabelSignature = useRef('')
  const wireTargets = useMemo(
    () =>
      cords.flatMap(({ id, midpoint }) => {
        const wire = wires.find((entry) => entry.id === id)
        return wire ? [{ wire, midpoint }] : []
      }),
    [cords, wires],
  )
  useEffect(() => {
    const lost = (event: Event) => {
      event.preventDefault()
      onContextLost()
    }
    gl.domElement.addEventListener('webglcontextlost', lost)
    return () => gl.domElement.removeEventListener('webglcontextlost', lost)
  }, [gl, onContextLost])
  // Demand rendering keeps an idle preview quiet; frame data never enters React state.
  useFrame(({ camera, size }) => {
    if (!region.current) return
    region.current.dataset.canvasSize = `${Math.round(size.width)},${Math.round(size.height)}`
    region.current.dataset.renderedFrames = String(++frameCount.current)
    region.current.dataset.dpr = String(gl.getPixelRatio())
    region.current.dataset.drawCalls = String(gl.info.render.calls)
    region.current.dataset.triangles = String(gl.info.render.triangles)
    region.current.dataset.cameraPosition = camera.position
      .toArray()
      .map((value) => value.toFixed(3))
      .join(',')
    if (cameraControls) region.current.dataset.cameraAzimuth = cameraControls.azimuthAngle.toFixed(4)
    const projected = jacks.map((jack) => {
      projection.copy(jack.position).project(camera)
      return {
        id: jack.id,
        assetId: jack.assetId,
        device: jack.id.slice(0, jack.id.indexOf('.')),
        label: jack.label,
        ref: jack.id,
        stackCount: jackStackCount(wires, jack.id),
        x: (projection.x + 1) / 2,
        y: (1 - projection.y) / 2,
        visible:
          Math.abs(projection.x) < 1 &&
          Math.abs(projection.y) < 1 &&
          Math.abs(projection.z) < 1 &&
          viewDirection.subVectors(camera.position, jack.position).dot(jack.normal) > 0,
      }
    })
    // Same rule as the picker: a device is wired directly once its jacks are far enough apart on screen.
    const pickable = pickableDevices(
      projected
        .filter((jack) => jack.visible)
        .map((jack) => ({ device: jack.device, x: jack.x * size.width, y: jack.y * size.height })),
    )
    region.current.dataset.jackTargets = JSON.stringify(
      projected.map(({ device, ...jack }) => ({ ...jack, pickable: jack.visible && pickable.has(device) })),
    )
    // 特写常驻防重叠插孔标注：仅在聚焦单台设备且镜头静止、开启“插孔标注”时按签名增量更新，零每帧抖动（T1.9B）
    const viewState = useBenchView.getState()
    const focusedId = focusedInstance(viewState.preset)
    const cameraMoving = region.current.dataset.cameraMoving === 'true'
    if (!viewState.showJackLabels || !focusedId) {
      if (viewState.persistentLabels.length > 0) viewState.setPersistentLabels([])
      if (lastLabelSignature.current) lastLabelSignature.current = ''
      region.current.dataset.persistentLabelCount = '0'
    } else if (!cameraMoving) {
      const labelSig = `${focusedId}|${Math.round(size.width)}x${Math.round(size.height)}|${camera.position.x.toFixed(2)},${camera.position.y.toFixed(2)},${camera.position.z.toFixed(2)}|${pending ?? ''}`
      if (labelSig !== lastLabelSignature.current) {
        lastLabelSignature.current = labelSig
        const candidates = projected
          .filter((jack) => jack.visible && jack.device === focusedId)
          .map((jack) => ({
            id: jack.id,
            label: jack.label,
            x: jack.x * size.width,
            y: jack.y * size.height,
            priority: jack.id === pending ? 3 : jack.stackCount > 0 ? 1 : 0,
          }))
        const laidOut = layoutVisibleJackLabels(candidates, {
          viewportWidth: size.width,
          viewportHeight: size.height,
        })
        viewState.setPersistentLabels(laidOut)
        region.current.dataset.persistentLabelCount = String(laidOut.length)
      }
    }
    region.current.dataset.moduleControlTargets = JSON.stringify(
      controls.map((control) => {
        projection.copy(control.position).project(camera)
        return {
          id: control.id,
          x: (projection.x + 1) / 2,
          y: (1 - projection.y) / 2,
          value: controlValues[control.id],
          visible:
            Math.abs(projection.x) < 1 &&
            Math.abs(projection.y) < 1 &&
            Math.abs(projection.z) < 1 &&
            viewDirection.subVectors(camera.position, control.position).dot(control.normal) > 0,
        }
      }),
    )
    const panelsById = new Map(useInstrumentPanels.getState().panels.map((entry) => [entry.id, entry]))
    region.current.dataset.instrumentControlTargets = JSON.stringify(
      instrumentControls.flatMap((control) => {
        const panel = panelsById.get(control.instanceId)
        if (!panel) return []
        projection.copy(control.position).project(camera)
        return [
          {
            id: control.id,
            instanceId: control.instanceId,
            controlId: control.anchor.id,
            label: control.label,
            x: (projection.x + 1) / 2,
            y: (1 - projection.y) / 2,
            visible:
              Math.abs(projection.x) < 1 &&
              Math.abs(projection.y) < 1 &&
              Math.abs(projection.z) < 1 &&
              viewDirection.subVectors(camera.position, control.position).dot(control.normal) > 0,
          },
        ]
      }),
    )
    region.current.dataset.wireTargets = JSON.stringify(
      wireTargets.map(({ wire, midpoint }) => {
        projection.copy(midpoint).project(camera)
        return {
          id: wire.id,
          a: wire.a,
          b: wire.b,
          color: wire.color,
          x: (projection.x + 1) / 2,
          y: (1 - projection.y) / 2,
        }
      }),
    )
    const selectedWire = !pending && selectedWireId ? wires.find((entry) => entry.id === selectedWireId) : undefined
    const selectedHandles = selectedWire ? wireEndpointPositions(selectedWire, actualJacks, wires) : null
    region.current.dataset.wireEndpointHandles = JSON.stringify(
      selectedWire && selectedHandles
        ? (['a', 'b'] as const).map((end) => {
            projection.copy(selectedHandles[end]).project(camera)
            return {
              wireId: selectedWire.id,
              end,
              jack: selectedWire[end],
              x: (projection.x + 1) / 2,
              y: (1 - projection.y) / 2,
              visible: Math.abs(projection.x) < 1 && Math.abs(projection.y) < 1 && Math.abs(projection.z) < 1,
            }
          })
        : [],
    )
    region.current.dataset.slotTargets = JSON.stringify(
      slots.map((slot) => {
        projection.copy(slot.position).project(camera)
        return {
          id: slot.userData.instrumentSlot,
          x: (projection.x + 1) / 2,
          y: (1 - projection.y) / 2,
          visible: Math.abs(projection.x) < 1 && Math.abs(projection.y) < 1 && Math.abs(projection.z) < 1,
          occupied: placed.some((instrument) => instrument.slot === slot.userData.instrumentSlot),
        }
      }),
    )
  })
  return null
}

function blockOccludedJacks(event: ThreeEvent<PointerEvent | MouseEvent>) {
  event.stopPropagation()
}

function PreviewWarmup({
  region,
  summary,
  onReady,
}: {
  region: RefObject<HTMLElement | null>
  summary: PreviewSummary
  onReady: (summary: PreviewSummary) => void
}) {
  const gl = useThree((state) => state.gl)
  const invalidate = useThree((state) => state.invalidate)
  const frameStart = useRef<number | null>(null)
  const complete = useRef(false)
  useFrame(() => {
    if (!complete.current) frameStart.current = performance.now()
  })
  useEffect(() => {
    // GLB decoding is not readiness: the first render also compiles shaders and filters the HDRI.
    const unsubscribe = addAfterEffect(() => {
      if (complete.current || frameStart.current === null || gl.info.render.triangles === 0) return
      complete.current = true
      if (region.current) {
        region.current.dataset.readyAfterFrame = 'true'
      }
      onReady(summary)
    })
    invalidate()
    return unsubscribe
  }, [gl, invalidate, onReady, region, summary])
  return null
}

function InstrumentSlotTargets({ targets }: { targets: SlotTarget[] }) {
  const { picker } = useInstrumentPlacement()
  const { camera, gl, scene, invalidate } = useThree()
  const dragging = useDraggingInstrument()
  const placed = useCircuit((state) => state.placedInstruments)
  const highlight = useMemo(readHighlightColor, [])
  useEffect(() => {
    const resolve = (point: { x: number; y: number }) => {
      scene.updateMatrixWorld(true)
      return pickInstrumentSlot(point, gl.domElement.getBoundingClientRect(), camera, targets, scene.children)
    }
    picker.current = resolve
    return () => {
      if (picker.current === resolve) picker.current = null
    }
  }, [picker, camera, gl, scene, targets])
  useEffect(() => {
    for (const target of targets) {
      target.material.color.copy(highlight)
      target.material.opacity = dragging ? 0.22 : 0
    }
    invalidate()
  }, [dragging, highlight, invalidate, targets])
  return (
    <>
      {targets.map((target) => (
        <group key={target.name}>
          <primitive object={target} dispose={null} />
          {dragging && (
            <Html
              center
              zIndexRange={[10, 0]}
              position={target.position.clone().add(new Vector3(0, 0.02, 0))}
              style={{ pointerEvents: 'none' }}
            >
              <span
                data-slot-id={String(target.userData.instrumentSlot)}
                title={String(target.userData.instrumentSlot)}
                className="whitespace-nowrap rounded-sm border bg-background px-1.5 py-0.5 text-xs text-foreground shadow-sm"
              >
                {slotDisplayName(String(target.userData.instrumentSlot))}
                {placed.some((instrument) => instrument.slot === target.userData.instrumentSlot) ? ' · 已占用' : ''}
              </span>
            </Html>
          )}
        </group>
      ))}
    </>
  )
}

function PreviewModels({
  onReady,
  region,
  onContextLost,
  enabled,
  registry,
  guideNets,
  guideMode,
}: {
  onReady: (summary: PreviewSummary) => void
  region: RefObject<HTMLElement | null>
  onContextLost: () => void
  enabled: boolean
  registry: RefObject<Map<string, Object3D>>
  guideNets: readonly (readonly string[])[]
  guideMode: GuideMode
}) {
  const showGuide = useBenchView((state) => state.showGuide)
  const quality = useQuality((state) => state.quality)
  const anisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy())
  const placements = useActivePlacements()
  const electricalJacks = useWiringJacks()
  const assets = useMemo(() => assetsForPlacements(placements), [placements])
  const urls = useMemo(() => assets.map((item) => item.url), [assets])
  // Plain GLBs + embedded WebP need neither Draco's CDN decoder nor Meshopt.
  const loaded = useGLTF(urls, false, false)
  const models = useMemo(
    () =>
      assets.map((item, index) => {
        const source = loaded[index]?.scene
        if (!source) throw new Error(`Missing loaded model: ${item.asset.id}`)
        const resource = cloneQualityModel(source, quality, anisotropy)
        // Lets screen picking map a ray hit back to its device (click/double-click focus).
        resource.model.userData.benchInstance = item.instanceId
        resource.model.userData.benchKind = item.asset.kind
        return { ...item, ...resource, anchors: collectAnchors(resource.model) }
      }),
    [assets, loaded, quality, anisotropy],
  )
  const solids = useRef<Object3D[]>([])
  useEffect(() => {
    if (region.current)
      region.current.dataset.maxTextureSize = String(Math.max(...models.map((item) => item.largestTexture)))
    registry.current.clear()
    const meshes: Object3D[] = []
    for (const item of models) {
      registry.current.set(item.instanceId, item.model)
      item.model.traverse((node) => {
        if (node instanceof Mesh) meshes.push(node)
      })
    }
    solids.current = meshes
    return () => {
      for (const resource of models) resource.dispose()
    }
  }, [models, region, registry])
  const highlight = useMemo(readHighlightColor, [])
  const slots = useMemo(
    () =>
      models.flatMap((item) =>
        item.asset.kind === 'bench'
          ? createSlotTargets(
              item.anchors,
              item,
              desktopSlots
                .filter((slot) => item.model.getObjectByName(slot.id)?.userData.mounting === 'desktop')
                .map((slot) => slot.id),
            )
          : [],
      ),
    [models],
  )
  useEffect(
    () => () => {
      for (const slot of slots) {
        slot.geometry.dispose()
        slot.material.dispose()
      }
    },
    [slots],
  )
  const worldJacks = useMemo(
    () =>
      models.flatMap((item) => {
        const rotation = new Euler(...(item.rotation ?? [0, 0, 0]))
        const origin = new Vector3(...item.position)
        return item.anchors
          .filter((anchor) => anchor.kind === 'JACK')
          .map((anchor) => ({
            id: `${item.instanceId}.${anchor.id}`,
            assetId: item.asset.id,
            label: anchor.label,
            position: anchor.position.clone().applyEuler(rotation).add(origin),
            normal: new Vector3(0, 0, 1).applyQuaternion(anchor.quaternion).applyEuler(rotation),
          }))
      }),
    [models],
  )
  const actualJacks = useMemo(
    () =>
      worldJacks.map((jack): WiringJack => {
        const metadata = electricalJacks.find((entry) => entry.ref === jack.id)
        if (!metadata) throw new Error(`Missing electrical metadata: ${jack.id}`)
        return { ...metadata, position: jack.position.toArray(), normal: jack.normal.toArray() }
      }),
    [worldJacks, electricalJacks],
  )
  const worldControls = useMemo(
    () =>
      models.flatMap((item) => {
        if (item.asset.kind !== 'module') return []
        const rotation = new Euler(...(item.rotation ?? [0, 0, 0]))
        const origin = new Vector3(...item.position)
        return item.anchors
          .filter((anchor) => anchor.kind === 'KNOB' || anchor.kind === 'SW')
          .map((anchor) => ({
            id: `${item.instanceId}.${anchor.id}`,
            assetId: item.asset.id,
            label: anchor.label,
            position: anchor.position
              .clone()
              .add(new Vector3(0, 0, 0.011).applyQuaternion(anchor.quaternion))
              .applyEuler(rotation)
              .add(origin),
            normal: new Vector3(0, 0, 1).applyQuaternion(anchor.quaternion).applyEuler(rotation),
          }))
      }),
    [models],
  )
  const worldInstrumentControls = useMemo(
    () =>
      models.flatMap((item): WorldInstrumentControl[] => {
        if (item.asset.kind !== 'instrument') return []
        const rotation = new Euler(...(item.rotation ?? [0, 0, 0]))
        const origin = new Vector3(...item.position)
        return item.anchors
          .filter((anchor) => anchor.kind === 'KNOB' || anchor.kind === 'SW')
          .map((anchor) => ({
            id: `${item.instanceId}.${anchor.id}`,
            instanceId: item.instanceId,
            assetId: item.asset.id,
            label: anchor.label,
            anchor,
            position: anchor.position
              .clone()
              .add(new Vector3(0, 0, 0.012).applyQuaternion(anchor.quaternion))
              .applyEuler(rotation)
              .add(origin),
            normal: new Vector3(0, 0, 1).applyQuaternion(anchor.quaternion).applyEuler(rotation),
          }))
      }),
    [models],
  )
  const pending = useCircuit((state) => state.pendingJack)
  const wires = useCircuit((state) => state.wires)
  const cords = useMemo(
    () =>
      wires.map((wire) => {
        const { geometry, midpoint, path } = patchCordGeometry(wire, actualJacks, wires, wiringScene.workSurface)
        geometry.dispose()
        return { id: wire.id, midpoint, path: path.map((point) => new Vector3(...point)) }
      }),
    [wires, actualJacks],
  )
  const interaction = useWiringInteraction(actualJacks, cords, solids, region, enabled)
  const draftMesh = useRef<Mesh>(null)
  const summary = useMemo(
    () => ({
      assets: models.length,
      anchors: models.reduce((total, item) => total + item.anchors.length, 0),
      jacks: models.reduce((total, item) => total + item.anchors.filter((anchor) => anchor.kind === 'JACK').length, 0),
    }),
    [models],
  )
  return (
    <>
      <PreviewWarmup
        key={`${quality}:${placementSignature(placements)}`}
        region={region}
        summary={summary}
        onReady={onReady}
      />
      <SceneMetrics
        region={region}
        onContextLost={onContextLost}
        jacks={worldJacks}
        actualJacks={actualJacks}
        cords={cords}
        slots={slots}
        controls={worldControls}
        instrumentControls={worldInstrumentControls}
      />
      <InstrumentSlotTargets targets={slots} />
      <PatchCords3D jacks={actualJacks} highlight={highlight} region={region} />
      <DraftCord jacks={actualJacks} draft={interaction.draft} meshRef={draftMesh} />
      <DiagnosticGuideCord jacks={actualJacks} color={highlight} region={region} guideMode={guideMode} />
      {showGuide && <GuideCords jacks={actualJacks} nets={guideNets} color={highlight} region={region} />}
      {models.map(({ asset, instanceId, position, rotation, model, anchors }) => (
        <group key={instanceId} position={position} rotation={rotation}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Opaque Three.js geometry blocks raycasts to hidden objects; not a DOM control. */}
          <primitive
            object={model}
            dispose={null}
            onPointerOver={blockOccludedJacks}
            onPointerMove={blockOccludedJacks}
            onPointerDown={blockOccludedJacks}
            onClick={blockOccludedJacks}
          />
          {asset.kind === 'instrument' && (
            <>
              <InstrumentScreens model={model} instanceId={instanceId} />
              <InstrumentControls3D model={model} instanceId={instanceId} anchors={anchors} enabled={enabled} />
            </>
          )}
          {asset.kind === 'module' && (
            <>
              {anchors.some((anchor) => anchor.kind === 'SCREEN') && (
                <InstrumentScreens model={model} instanceId={instanceId} />
              )}
              <ModuleControls3D
                model={model}
                instanceId={instanceId}
                assetId={asset.id}
                anchors={anchors}
                enabled={enabled}
              />
            </>
          )}
          {anchors
            .filter((anchor) => anchor.kind === 'JACK')
            .map((anchor) => (
              <JackNode3D
                key={anchor.name}
                anchor={anchor}
                globalId={`${instanceId}.${anchor.id}`}
                assetName={asset.name}
                color={highlight}
                stackCount={jackStackCount(wires, `${instanceId}.${anchor.id}`)}
                pending={pending === `${instanceId}.${anchor.id}`}
              />
            ))}
        </group>
      ))}
    </>
  )
}

const surface = wiringScene.workSurface
const worktop = surface && {
  height: surface.max[1],
  center: [(surface.min[0] + surface.max[0]) / 2, (surface.min[2] + surface.max[2]) / 2] as const,
  size: [surface.max[0] - surface.min[0], surface.max[2] - surface.min[2]] as const,
}

const presets: { id: CameraPreset; label: string }[] = [
  { id: 'work', label: '操作视角' },
  { id: 'front', label: '正视' },
  { id: 'top', label: '俯视' },
]

const noGuide: readonly (readonly string[])[] = []

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function quickDevicePriority(assetId: string, kind: string, isDesktop: boolean): number {
  if (kind === 'module') return 0
  if (isDesktop) return 1
  if (assetId === 'ins-dc-power' || assetId === 'ins-ac-power') return 2
  return 3
}

export function BenchViewport3D({
  onReadyChange,
  guideNets = noGuide,
  guideMode = 'guided',
  onGuideBlocked,
}: {
  onReadyChange?: (ready: boolean) => void
  /** Reference nets of the current step, drawn dashed when the guide toggle is on. */
  guideNets?: readonly (readonly string[])[]
  guideMode?: GuideMode
  onGuideBlocked?: (message: string) => void
}) {
  const showGuide = useBenchView((state) => state.showGuide)
  const wireXRay = useBenchView((state) => state.wireXRay)
  const showJackLabels = useBenchView((state) => state.showJackLabels)
  const pulsingJack = useBenchView((state) => state.pulsingJack)
  const altHeld = useBenchView((state) => state.altHeld)
  const effectiveGuideNets = guideMode === 'guided' ? guideNets : noGuide
  const guideActive = showGuide && guideMode === 'guided' && effectiveGuideNets.length > 0
  const region = useRef<HTMLElement>(null)
  const startupTime = useRef(performance.now())
  const [attempt, setAttempt] = useState(0)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [summary, setSummary] = useState<PreviewSummary>({ assets: 0, anchors: 0, jacks: 0 })
  const preset = useBenchView((state) => state.preset)
  const setPreset = useBenchView((state) => state.setPreset)
  const models = useRef(new Map<string, Object3D>())
  const [contextLost, setContextLost] = useState(false)
  const quality = useQuality((state) => state.quality)
  const setQuality = useQuality((state) => state.setQuality)
  const settings = qualityPreset(quality)
  const wires = useCircuit((state) => state.wires)
  const powered = useCircuit((state) => state.powered)
  const togglePower = useCircuit((state) => state.togglePower)
  const cancelConnection = useCircuit((state) => state.cancelConnection)
  const placements = useActivePlacements()
  const placed = useCircuit((state) => state.placedInstruments)
  const dragging = useDraggingInstrument()
  const drop = useDroppable({
    id: BENCH_DROP_ID,
    accept: INSTRUMENT_DRAG_TYPE,
    disabled: loadState !== 'ready' || powered,
  })
  const pending = useCircuit((state) => state.pendingJack)
  const pendingRewire = useCircuit((state) => state.pendingRewire)
  const wireColor = useCircuit((state) => state.wireColor)
  const xRayActive = wireXRay || altHeld || Boolean(pending)
  const devices = useMemo(
    () =>
      placements.flatMap((placement) => {
        const asset = catalog.assets.find((entry) => entry.id === placement.assetId)
        if (!asset || asset.kind === 'bench') return []
        const isDesktop = placed.some((item) => item.instanceId === placement.instanceId)
        return [
          {
            instanceId: placement.instanceId,
            assetId: asset.id,
            kind: asset.kind,
            name: asset.name,
            isDesktop,
            priority: quickDevicePriority(asset.id, asset.kind, isDesktop),
          },
        ]
      }),
    [placements, placed],
  )
  const quickDevices = useMemo(() => devices.slice().sort((a, b) => a.priority - b.priority), [devices])
  const activeInstanceIdsKey = useMemo(() => {
    const wiredInstances = new Set<string>()
    for (const wire of wires) {
      const aDot = wire.a.indexOf('.')
      const bDot = wire.b.indexOf('.')
      if (aDot > 0) wiredInstances.add(wire.a.slice(0, aDot))
      if (bDot > 0) wiredInstances.add(wire.b.slice(0, bDot))
    }
    const ids: string[] = []
    for (const device of devices) {
      const isActive =
        device.kind === 'module' ||
        device.isDesktop ||
        device.assetId === 'ins-dc-power' ||
        wiredInstances.has(device.instanceId)
      if (isActive) ids.push(device.instanceId)
    }
    ids.sort()
    return ids.join(',')
  }, [devices, wires])
  const focused = focusedInstance(preset)
  useEffect(() => {
    // A new session on the workbench always starts from the work view, not a stale close-up.
    useBenchView.getState().setPreset('work')
  }, [])
  useEffect(() => {
    // 原理图双向高亮与 3D 悬停直写 DOM data-hovered-jack，不触发 BenchViewport3D 整组件重渲染
    const syncHover = (hovered: string | null) => {
      if (region.current) region.current.dataset.hoveredJack = hovered ?? ''
    }
    syncHover(useBenchView.getState().hoveredJack)
    return useBenchView.subscribe((state, prev) => {
      if (state.hoveredJack !== prev.hoveredJack) syncHover(state.hoveredJack)
    })
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        useBenchView.getState().setAltHeld(true)
        return
      }
      if (
        loadState !== 'ready' ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableElement(event.target) ||
        document.querySelector('[role="dialog"], [role="listbox"]')
      ) {
        return
      }
      if (event.key >= '1' && event.key <= '9') {
        const target = quickDevices[Number(event.key) - 1]
        if (!target) return
        event.preventDefault()
        useBenchView.getState().focus(target.instanceId)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Alt') useBenchView.getState().setAltHeld(false)
    }
    const onBlur = () => useBenchView.getState().setAltHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      useBenchView.getState().setAltHeld(false)
    }
  }, [loadState, quickDevices])
  const shadowKey = `${quality}:${placementSignature(placements)}:${wires.map((wire) => `${wire.id}:${wire.slack}`).join(',')}`
  useEffect(() => {
    if (!placements.length) return
    startupTime.current = performance.now()
    if (region.current) delete region.current.dataset.readyAfterFrame
    setLoadState('loading')
  }, [placements])
  useEffect(() => {
    onReadyChange?.(loadState === 'ready')
  }, [loadState, onReadyChange])
  const onError = useCallback(() => setLoadState('error'), [])
  const onContextLost = useCallback(() => {
    setContextLost(true)
    setLoadState('error')
  }, [])
  const onReady = useCallback((next: PreviewSummary) => {
    if (region.current) region.current.dataset.startupMs = (performance.now() - startupTime.current).toFixed(1)
    setSummary(next)
    setLoadState('ready')
  }, [])
  const retry = () => {
    startupTime.current = performance.now()
    if (region.current) {
      delete region.current.dataset.readyAfterFrame
      delete region.current.dataset.startupMs
    }
    try {
      useGLTF.clear(assetsForPlacements(placements).map((item) => item.url))
    } catch {
      // Missing bundle files remain actionable through the same fallback.
    }
    useEnvironment.clear({ files: localEnvironment })
    setContextLost(false)
    setLoadState('loading')
    setSummary({ assets: 0, anchors: 0, jacks: 0 })
    setPreset('work')
    setAttempt((value) => value + 1)
  }
  return (
    <section
      ref={region}
      aria-label="3D 实训台"
      className="flex h-full min-h-0 flex-col bg-muted"
      data-assets-state={loadState}
      data-assets-loaded={summary.assets}
      data-anchor-count={summary.anchors}
      data-jack-count={summary.jacks}
      data-camera-preset={preset ?? 'custom'}
      data-camera-moving="false"
      data-quality={quality}
      data-shadows={settings.shadows > 0}
      data-wire-count={wires.length}
      data-wire-endpoints={JSON.stringify(wires.map(({ id, a, b, color, slack }) => ({ id, a, b, color, slack })))}
      data-pending-jack={pending ?? ''}
      data-pending-rewire={pendingRewire ? `${pendingRewire.wireId}:${pendingRewire.end}` : ''}
      data-wire-color={wireColor}
      data-wire-xray={xRayActive ? 'on' : 'off'}
      data-jack-labels={showJackLabels ? 'on' : 'off'}
      data-placed-instruments={JSON.stringify(
        placed.map(({ instanceId, instrumentId, slot }) => ({ instanceId, instrumentId, slot })),
      )}
      data-dragging-instrument={dragging ?? ''}
      data-guide-mode={guideMode}
      data-reference-guide={guideActive ? 'on' : 'off'}
      data-pulsing-jack={pulsingJack ?? ''}
    >
      <div
        data-slot="bench-toolbar"
        className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-background px-2.5 py-1"
      >
        <fieldset aria-label="预设视角" className="flex shrink-0 items-center gap-0.5">
          {presets.map((item) => (
            <Button
              key={item.id}
              size="xs"
              variant={preset === item.id ? 'secondary' : 'ghost'}
              aria-pressed={preset === item.id}
              disabled={loadState !== 'ready'}
              onClick={() => setPreset(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </fieldset>
        <Select
          value={focused ?? ''}
          onValueChange={(instanceId) => useBenchView.getState().focus(instanceId)}
          disabled={loadState !== 'ready'}
        >
          <SelectTrigger size="sm" aria-label="聚焦设备" className="h-7 w-36 shrink-0 text-xs">
            <SelectValue placeholder="聚焦设备" />
          </SelectTrigger>
          <SelectContent>
            {quickDevices.map((device) => (
              <SelectItem key={device.instanceId} value={device.instanceId} data-instance-id={device.instanceId}>
                {device.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="xs"
          variant={guideActive ? 'secondary' : 'ghost'}
          aria-pressed={guideActive}
          className="shrink-0"
          disabled={loadState !== 'ready' || (guideMode === 'guided' && !effectiveGuideNets.length)}
          onClick={() => {
            const check = canToggleReferenceOverlay(guideMode, guideNets)
            if (!check.allowed) {
              useBenchView.getState().setShowGuide(false)
              onGuideBlocked?.(check.message)
              return
            }
            useBenchView.getState().toggleGuide()
          }}
        >
          参考接线
        </Button>
        <Button
          size="xs"
          variant={wireXRay ? 'secondary' : 'ghost'}
          aria-pressed={wireXRay}
          className="shrink-0"
          disabled={loadState !== 'ready'}
          onClick={() => useBenchView.getState().toggleWireXRay()}
        >
          导线透视
        </Button>
        <Button
          size="xs"
          variant={showJackLabels ? 'secondary' : 'ghost'}
          aria-pressed={showJackLabels}
          className="shrink-0"
          disabled={loadState !== 'ready'}
          onClick={() => useBenchView.getState().toggleJackLabels()}
        >
          插孔标注
        </Button>
        {guideMode === 'free' && (
          <span data-guide-mode-notice className="shrink-0 text-xs text-warning">
            自主模式
          </span>
        )}
        <fieldset aria-label="画质" className="ml-auto flex shrink-0 items-center gap-0.5">
          {qualityOptions.map((item) => (
            <Button
              key={item.id}
              size="xs"
              variant={quality === item.id ? 'secondary' : 'ghost'}
              aria-label={`${item.label}画质`}
              aria-pressed={quality === item.id}
              disabled={loadState !== 'ready'}
              onClick={() => {
                if (quality === item.id) return
                startupTime.current = performance.now()
                if (region.current) delete region.current.dataset.readyAfterFrame
                setLoadState('loading')
                setQuality(item.id)
                void settingsStore.getState().updateSettings({ quality: item.id })
              }}
            >
              {item.label}
            </Button>
          ))}
        </fieldset>
      </div>
      <div
        ref={drop.ref}
        data-slot="bench-canvas-frame"
        data-drop-target={drop.isDropTarget}
        className="relative min-h-0 flex-1"
      >
        {pending && (
          <div
            data-pending-wire-banner
            className="pointer-events-none absolute top-2.5 left-2.5 z-10 flex items-center gap-1.5 rounded-md border border-primary/40 bg-background/95 px-2.5 py-1 text-xs shadow-sm"
          >
            <span className="font-medium text-primary">
              {pendingRewire ? `改接固定端：${jackName(pending)}` : `起点：${jackName(pending)}`}
            </span>
            <span className="text-muted-foreground">选目标插孔或按 Esc 取消</span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="pointer-events-auto"
              aria-label="取消当前接线"
              onClick={() => cancelConnection()}
            >
              <X />
            </Button>
          </div>
        )}
        <Button
          size="xs"
          variant="outline"
          data-viewport-power-badge={powered ? 'on' : 'off'}
          aria-label={powered ? '台面电源：开启（点击关闭）' : '台面电源：关闭（点击开启）'}
          aria-pressed={powered}
          title={powered ? '点击关闭台面电源' : '点击开启台面电源'}
          disabled={loadState !== 'ready' && !powered}
          onClick={togglePower}
          className={cn(
            'absolute top-2.5 right-2.5 z-10 gap-1.5 bg-background/95 shadow-sm',
            powered ? 'border-success/50 text-success' : 'text-muted-foreground',
          )}
        >
          <Power className="size-3" />
          <span>{powered ? '电源开' : '电源关'}</span>
        </Button>
        <BenchOnboarding ready={loadState === 'ready'} />
        <QuickTargetWiringDock />
        <InstrumentKnobPopover />
        <AssetBoundary key={attempt} onError={onError} onRetry={retry}>
          {contextLost ? (
            <FailureMessage onRetry={retry} />
          ) : (
            <Canvas
              frameloop="demand"
              dpr={settings.dpr}
              camera={{ position: catalog.preview.camera.position, fov: previewFov, near: 0.02, far: 20 }}
              gl={{ antialias: true, alpha: true, toneMapping: NeutralToneMapping }}
              fallback={<p>当前设备无法显示 3D 画布。</p>}
            >
              <PreviewCamera
                models={models}
                region={region}
                loadState={loadState}
                activeInstanceIdsKey={activeInstanceIdsKey}
              />
              <ambientLight intensity={0.3} />
              <directionalLight position={[3, 5, 4]} intensity={1.4} />
              <Suspense fallback={null}>
                <Environment files={localEnvironment} environmentIntensity={0.6} />
                <PreviewModels
                  onReady={onReady}
                  region={region}
                  onContextLost={onContextLost}
                  enabled={loadState === 'ready'}
                  registry={models}
                  guideNets={effectiveGuideNets}
                  guideMode={guideMode}
                />
                {settings.shadows > 0 && (
                  <>
                    <ContactShadows
                      key={`floor:${shadowKey}`}
                      position={[0, 0.002, 0]}
                      opacity={0.28}
                      scale={5}
                      blur={2.5}
                      far={2}
                      resolution={settings.shadows}
                      frames={1}
                    />
                    {/* Desktop instruments stand on the worktop, not the floor (技术设计 §10.3). */}
                    {worktop && (
                      <ContactShadows
                        key={`worktop:${shadowKey}`}
                        position={[worktop.center[0], worktop.height + 0.001, worktop.center[1]]}
                        opacity={0.35}
                        width={worktop.size[0]}
                        height={worktop.size[1]}
                        blur={1.6}
                        far={0.4}
                        resolution={settings.shadows}
                        frames={1}
                      />
                    )}
                  </>
                )}
              </Suspense>
            </Canvas>
          )}
        </AssetBoundary>
        {loadState === 'loading' && (
          <div
            role="status"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
          >
            正在加载本地 3D 资产…
          </div>
        )}
      </div>
    </section>
  )
}
