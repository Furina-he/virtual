import { CameraControls, ContactShadows, Environment, useGLTF } from '@react-three/drei'
import { addAfterEffect, Canvas, useThree } from '@react-three/fiber'
import { RotateCcw } from 'lucide-react'
import { type ComponentRef, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Box3, DoubleSide, type Material, Mesh, NeutralToneMapping, type Object3D, Plane, Vector3 } from 'three'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { localEnvironment } from '@/three/asset-catalog'
import type { LearnResource } from '../../../shared/schema/learn'
import { resolveLearnModelUrl } from './learn-content'

type MeshEntry = {
  mesh: Mesh
  basePosition: Vector3
  direction: Vector3
  materials: Material[]
}

function DeviceModelScene({
  url,
  explode,
  sectionEnabled,
  sectionOffset,
  onReady,
}: {
  url: string
  explode: number
  sectionEnabled: boolean
  sectionOffset: number
  onReady: (meshCount: number) => void
}) {
  // PRD 14.2：显式禁用 Draco/Meshopt 远程与 WASM 解码器，保证严格离线与 CSP 合规
  const gltf = useGLTF(url, false, false)
  const invalidate = useThree((state) => state.invalidate)

  const prepared = useMemo(() => {
    const root = gltf.scene.clone(true)
    const rawBox = new Box3().setFromObject(root)
    const size = rawBox.getSize(new Vector3())
    const center = rawBox.getCenter(new Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 1e-4)
    const scale = 1.15 / maxDim

    root.scale.setScalar(scale)
    root.position.set(-center.x * scale, -rawBox.min.y * scale + 0.04, -center.z * scale)
    root.updateMatrixWorld(true)

    const normBox = new Box3().setFromObject(root)
    const normCenter = normBox.getCenter(new Vector3())

    const meshes: Mesh[] = []
    root.traverse((obj: Object3D) => {
      if (obj instanceof Mesh) meshes.push(obj)
    })

    const entries: MeshEntry[] = meshes.map((mesh, index) => {
      const meshBox = new Box3().setFromObject(mesh)
      const meshCenter = meshBox.getCenter(new Vector3())
      const offset = meshCenter.sub(normCenter)
      let direction: Vector3
      if (offset.lengthSq() > 1e-5) {
        direction = offset.normalize()
      } else {
        const angle = (index / Math.max(meshes.length, 1)) * Math.PI * 2
        direction = new Vector3(Math.cos(angle) * 0.6, 0.55 + (index % 3) * 0.25, Math.sin(angle) * 0.6).normalize()
      }

      const clonedMaterials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((mat) => {
        const next = mat.clone()
        next.side = DoubleSide
        next.clipShadows = true
        return next
      })
      mesh.material = Array.isArray(mesh.material) ? clonedMaterials : (clonedMaterials[0] ?? mesh.material)

      return {
        mesh,
        basePosition: mesh.position.clone(),
        direction,
        materials: clonedMaterials,
      }
    })

    return { root, entries, halfDepth: Math.max((normBox.max.z - normBox.min.z) * 0.55, 0.35), scale }
  }, [gltf.scene])

  useEffect(() => {
    return () => {
      for (const entry of prepared.entries) {
        for (const mat of entry.materials) mat.dispose()
      }
    }
  }, [prepared])

  useEffect(() => {
    const distance = (explode * 0.42) / Math.max(prepared.scale, 1e-3)
    const clipPlane = sectionEnabled ? new Plane(new Vector3(0, 0, -1), sectionOffset * prepared.halfDepth) : null

    for (const entry of prepared.entries) {
      entry.mesh.position.copy(entry.basePosition).addScaledVector(entry.direction, distance)
      for (const mat of entry.materials) {
        mat.clippingPlanes = clipPlane ? [clipPlane] : []
        mat.needsUpdate = true
      }
    }
    invalidate()
  }, [prepared, explode, sectionEnabled, sectionOffset, invalidate])

  useEffect(() => {
    const unsubscribe = addAfterEffect(() => {
      onReady(prepared.entries.length)
    })
    invalidate()
    return unsubscribe
  }, [prepared.entries.length, onReady, invalidate])

  return <primitive object={prepared.root} />
}

export function DeviceViewer3D({ resource }: { resource: LearnResource }) {
  const modelUrl = resolveLearnModelUrl(resource.model)
  const [explode, setExplode] = useState(0)
  const [sectionEnabled, setSectionEnabled] = useState(false)
  const [sectionOffset, setSectionOffset] = useState(0)
  const [ready, setReady] = useState(false)
  const [meshCount, setMeshCount] = useState(0)
  const controlsRef = useRef<ComponentRef<typeof CameraControls>>(null)
  const explodeLabelId = useId()
  const sectionSwitchId = useId()
  const sectionLabelId = useId()

  useEffect(() => {
    void controlsRef.current?.setLookAt(1.6, 1.1, 1.8, 0, 0.42, 0, false)
  }, [])

  const resetView = () => {
    setExplode(0)
    setSectionEnabled(false)
    setSectionOffset(0)
    void controlsRef.current?.setLookAt(1.6, 1.1, 1.8, 0, 0.42, 0, true)
  }

  if (!modelUrl) {
    return (
      <section
        aria-label="知识点原理视图"
        data-viewer-state="no-model"
        className="space-y-3 rounded-md border bg-muted/20 p-4"
      >
        <p className="text-sm font-medium">{resource.title} — 原理概览</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{resource.summary}</p>
        {resource.specs.length > 0 && (
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {resource.specs.map((spec) => (
              <div key={spec.label} className="rounded-sm border bg-background px-3 py-2">
                <dt className="text-xs text-muted-foreground">{spec.label}</dt>
                <dd className="font-mono text-xs font-medium">{spec.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    )
  }

  return (
    <section
      aria-label="3D 器件查看器"
      data-viewer-state={ready ? 'ready' : 'loading'}
      data-viewer-model={resource.model}
      data-explode={explode.toFixed(2)}
      data-section-enabled={sectionEnabled ? 'true' : 'false'}
      data-section-offset={sectionOffset.toFixed(2)}
      data-mesh-count={meshCount}
      className="flex flex-col overflow-hidden rounded-md border bg-muted/30"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span id={explodeLabelId} className="text-muted-foreground">
            爆炸拆解
          </span>
          <div className="w-28">
            <Slider
              data-slider="explode"
              aria-labelledby={explodeLabelId}
              min={0}
              max={100}
              step={5}
              value={[Math.round(explode * 100)]}
              onValueChange={(values) => setExplode((values[0] ?? 0) / 100)}
            />
          </div>
          <span className="w-9 font-mono text-muted-foreground">{Math.round(explode * 100)}%</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Switch
              id={sectionSwitchId}
              aria-label="开启剖切面"
              size="sm"
              checked={sectionEnabled}
              onCheckedChange={(checked) => setSectionEnabled(checked)}
            />
            <label id={sectionLabelId} htmlFor={sectionSwitchId}>
              剖切面
            </label>
          </div>
          <div className="w-24">
            <Slider
              data-slider="section"
              aria-labelledby={sectionLabelId}
              min={-100}
              max={100}
              step={5}
              disabled={!sectionEnabled}
              value={[Math.round(sectionOffset * 100)]}
              onValueChange={(values) => setSectionOffset((values[0] ?? 0) / 100)}
            />
          </div>
          <Button size="xs" variant="ghost" onClick={resetView}>
            <RotateCcw className="size-3" />
            复位
          </Button>
        </div>
      </div>

      <div className="relative h-64 w-full">
        <Canvas
          frameloop="demand"
          dpr={[1, 1.5]}
          camera={{ position: [1.6, 1.1, 1.8], fov: 36, near: 0.02, far: 30 }}
          gl={{ antialias: true, alpha: true, localClippingEnabled: true, toneMapping: NeutralToneMapping }}
          fallback={<p className="p-4 text-xs text-muted-foreground">当前设备无法渲染 3D 视图。</p>}
        >
          <ambientLight intensity={0.45} />
          <directionalLight position={[3, 5, 4]} intensity={1.3} />
          <CameraControls ref={controlsRef} makeDefault minDistance={0.6} maxDistance={6} />
          <Suspense fallback={null}>
            <Environment files={localEnvironment} environmentIntensity={0.65} />
            <DeviceModelScene
              url={modelUrl}
              explode={explode}
              sectionEnabled={sectionEnabled}
              sectionOffset={sectionOffset}
              onReady={(count) => {
                setMeshCount(count)
                setReady(true)
              }}
            />
            <ContactShadows position={[0, 0.01, 0]} opacity={0.3} scale={3} blur={2} far={2} frames={1} />
          </Suspense>
        </Canvas>
        {!ready && (
          <div
            role="status"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground"
          >
            正在加载本地 3D 模型…
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t bg-background px-3 py-1 text-xs text-muted-foreground">
        <span>左键旋转 · 右键平移 · 滚轮缩放 · 滑块控制拆解与剖切</span>
        <span className="font-mono">{ready ? `${meshCount} 部件` : '加载中'}</span>
      </div>
    </section>
  )
}
