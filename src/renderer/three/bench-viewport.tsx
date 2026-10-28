import { useDroppable } from '@dnd-kit/react'
import { CameraControls, ContactShadows, Environment, Html, useEnvironment, useGLTF } from '@react-three/drei'
import { addAfterEffect, Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
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
import { Euler, type Mesh, Vector3 } from 'three'
import { Button } from '@/components/ui/button'
import {
  BENCH_DROP_ID,
  INSTRUMENT_DRAG_TYPE,
  useDraggingInstrument,
  useInstrumentPlacement,
} from '@/features/practice/instrument-placement'
import { desktopSlots } from '@/features/practice/wiring-context'
import {
  useActivePlacements,
  useCircuit,
  useWiringJacks,
  type WiringJack,
  wiringScene,
} from '@/features/practice/wiring-state'
import { collectAnchors } from './anchors'
import {
  assetsForPlacements,
  type CameraPreset,
  cameraView,
  catalog,
  localEnvironment,
  previewAssets,
  previewFov,
} from './asset-catalog'
import { jackStackCount, patchCordGeometry } from './cord-geometry'
import { InstrumentScreens } from './instrument-screens'
import { createSlotTargets, pickInstrumentSlot, type SlotTarget } from './instrument-slot-picking'
import { JackNode3D, readHighlightColor } from './jack-node'
import { cloneQualityModel } from './model-quality'
import { DraftCord, PatchCords3D } from './patch-cords'
import { qualityOptions, qualityPreset, useQuality } from './quality-store'
import { useWiringInteraction } from './wiring-interaction'

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

function PreviewCamera({
  preset,
  onManualControl,
  region,
}: {
  preset: CameraPreset | null
  onManualControl: () => void
  region: RefObject<HTMLElement | null>
}) {
  const controls = useRef<CameraControls>(null)
  const first = useRef(true)
  const transitionId = useRef(0)
  const aspect = useThree((state) => state.size.width / state.size.height)
  const reducedMotion = useReducedMotion()
  const pending = useCircuit((state) => state.pendingJack)
  const dragging = useDraggingInstrument()
  useEffect(() => {
    if (!controls.current || !preset) return
    const { position, target } = cameraView(preset, aspect)
    const transition = !first.current && !reducedMotion
    const id = ++transitionId.current
    first.current = false
    if (region.current) region.current.dataset.cameraMoving = String(transition)
    void controls.current.setLookAt(...position, ...target, transition).then(() => {
      if (region.current && transitionId.current === id) region.current.dataset.cameraMoving = 'false'
    })
  }, [preset, reducedMotion, region, aspect])
  return (
    <CameraControls
      ref={controls}
      makeDefault
      enabled={!pending && !dragging}
      minDistance={0.45}
      maxDistance={6}
      minPolarAngle={0.08}
      maxPolarAngle={Math.PI / 2}
      smoothTime={0.18}
      onControlStart={onManualControl}
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

function SceneMetrics({
  region,
  onContextLost,
  jacks,
  actualJacks,
  slots,
}: {
  region: RefObject<HTMLElement | null>
  onContextLost: () => void
  jacks: WorldJack[]
  actualJacks: WiringJack[]
  slots: SlotTarget[]
}) {
  const gl = useThree((state) => state.gl)
  const projection = useMemo(() => new Vector3(), [])
  const viewDirection = useMemo(() => new Vector3(), [])
  const wires = useCircuit((state) => state.wires)
  const placed = useCircuit((state) => state.placedInstruments)
  const frameCount = useRef(0)
  const wireTargets = useMemo(
    () =>
      wires.map((wire) => {
        const { midpoint, geometry } = patchCordGeometry(wire, actualJacks, wires, wiringScene.workSurface)
        geometry.dispose()
        return { wire, midpoint }
      }),
    [wires, actualJacks],
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
    region.current.dataset.jackTargets = JSON.stringify(
      jacks.map((jack) => {
        projection.copy(jack.position).project(camera)
        return {
          id: jack.id,
          assetId: jack.assetId,
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
              position={target.position.clone().add(new Vector3(0, 0.02, 0))}
              style={{ pointerEvents: 'none' }}
            >
              <span className="whitespace-nowrap rounded-sm border bg-background px-1 py-0.5 font-mono text-xs text-foreground">
                {String(target.userData.instrumentSlot)}
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
}: {
  onReady: (summary: PreviewSummary) => void
  region: RefObject<HTMLElement | null>
  onContextLost: () => void
  enabled: boolean
}) {
  const quality = useQuality((state) => state.quality)
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
        const resource = cloneQualityModel(source, quality)
        return { ...item, ...resource, anchors: collectAnchors(resource.model) }
      }),
    [assets, loaded, quality],
  )
  useEffect(() => {
    if (region.current)
      region.current.dataset.maxTextureSize = String(Math.max(...models.map((item) => item.largestTexture)))
    return () => {
      for (const resource of models) resource.dispose()
    }
  }, [models, region])
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
  const pending = useCircuit((state) => state.pendingJack)
  const wires = useCircuit((state) => state.wires)
  const interaction = useWiringInteraction(actualJacks, region, enabled)
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
        key={`${quality}:${placements.map((placement) => placement.instanceId).join(',')}`}
        region={region}
        summary={summary}
        onReady={onReady}
      />
      <SceneMetrics
        region={region}
        onContextLost={onContextLost}
        jacks={worldJacks}
        actualJacks={actualJacks}
        slots={slots}
      />
      <InstrumentSlotTargets targets={slots} />
      <PatchCords3D jacks={actualJacks} highlight={highlight} />
      <DraftCord jacks={actualJacks} draft={interaction.draft} meshRef={draftMesh} />
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
          {asset.kind === 'instrument' && <InstrumentScreens model={model} instanceId={instanceId} />}
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
                onStart={interaction.start}
              />
            ))}
        </group>
      ))}
    </>
  )
}

const presets: { id: CameraPreset; label: string }[] = [
  { id: 'work', label: '操作视角' },
  { id: 'front', label: '正视' },
  { id: 'top', label: '俯视' },
]

export function BenchViewport3D({ onReadyChange }: { onReadyChange?: (ready: boolean) => void }) {
  const region = useRef<HTMLElement>(null)
  const startupTime = useRef(performance.now())
  const [attempt, setAttempt] = useState(0)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [summary, setSummary] = useState<PreviewSummary>({ assets: 0, anchors: 0, jacks: 0 })
  const [preset, setPreset] = useState<CameraPreset | null>('work')
  const [contextLost, setContextLost] = useState(false)
  const quality = useQuality((state) => state.quality)
  const setQuality = useQuality((state) => state.setQuality)
  const settings = qualityPreset(quality)
  const wires = useCircuit((state) => state.wires)
  const powered = useCircuit((state) => state.powered)
  const placements = useActivePlacements()
  const placed = useCircuit((state) => state.placedInstruments)
  const dragging = useDraggingInstrument()
  const drop = useDroppable({
    id: BENCH_DROP_ID,
    accept: INSTRUMENT_DRAG_TYPE,
    disabled: loadState !== 'ready' || powered,
  })
  const pending = useCircuit((state) => state.pendingJack)
  const wireColor = useCircuit((state) => state.wireColor)
  const shadowKey = `${quality}:${placements.map((placement) => placement.instanceId).join(',')}:${wires.map((wire) => `${wire.id}:${wire.slack}`).join(',')}`
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
  const onManualControl = useCallback(() => setPreset(null), [])
  const retry = () => {
    startupTime.current = performance.now()
    if (region.current) {
      delete region.current.dataset.readyAfterFrame
      delete region.current.dataset.startupMs
    }
    try {
      useGLTF.clear(previewAssets().map((item) => item.url))
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
      data-wire-color={wireColor}
      data-placed-instruments={JSON.stringify(
        placed.map(({ instanceId, instrumentId, slot }) => ({ instanceId, instrumentId, slot })),
      )}
      data-dragging-instrument={dragging ?? ''}
    >
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-3 py-2">
        <p className="mr-auto text-xs text-muted-foreground">仪表选取与接线编辑</p>
        <fieldset aria-label="预设视角" className="flex items-center gap-1">
          {presets.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={preset === item.id ? 'secondary' : 'ghost'}
              aria-pressed={preset === item.id}
              disabled={loadState !== 'ready'}
              onClick={() => setPreset(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </fieldset>
        <fieldset aria-label="画质" className="flex items-center gap-1">
          {qualityOptions.map((item) => (
            <Button
              key={item.id}
              size="sm"
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
        <AssetBoundary key={attempt} onError={onError} onRetry={retry}>
          {contextLost ? (
            <FailureMessage onRetry={retry} />
          ) : (
            <Canvas
              frameloop="demand"
              dpr={settings.dpr}
              camera={{ position: catalog.preview.camera.position, fov: previewFov, near: 0.02, far: 20 }}
              gl={{ antialias: true, alpha: true }}
              fallback={<p>当前设备无法显示 3D 画布。</p>}
            >
              <PreviewCamera preset={preset} onManualControl={onManualControl} region={region} />
              <ambientLight intensity={0.3} />
              <directionalLight position={[3, 5, 4]} intensity={1.4} />
              <Suspense fallback={null}>
                <Environment files={localEnvironment} environmentIntensity={0.6} />
                <PreviewModels
                  onReady={onReady}
                  region={region}
                  onContextLost={onContextLost}
                  enabled={loadState === 'ready'}
                />
                {settings.shadows > 0 && (
                  <ContactShadows
                    key={shadowKey}
                    position={[0, 0.002, 0]}
                    opacity={0.28}
                    scale={5}
                    blur={2.5}
                    far={2}
                    resolution={settings.shadows}
                    frames={1}
                  />
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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t bg-background px-3 py-1 text-xs text-muted-foreground">
        <span>{pending ? '拖到另一插孔完成接线 · Esc 取消' : '插孔拖动接线 · 空白处旋转 · 右键平移 · 滚轮缩放'}</span>
        <span aria-live="polite" className="font-mono">
          {loadState === 'ready' ? `${summary.assets} 模型 / ${summary.anchors} 锚点` : '本地资源'}
        </span>
      </div>
    </section>
  )
}
