import { missingReferenceLinks } from '@domain/wiring-check'
import { Html, Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import type { Wire, WireColor } from '@shared/schema/circuit'
import { ArrowLeftRight, Palette, Trash2 } from 'lucide-react'
import { memo, type RefObject, useEffect, useMemo } from 'react'
import { BackSide, Color, type Mesh, Vector3 } from 'three'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { wireColors } from '@/features/practice/wire-options'
import { circuitStore, useCircuit, type WiringJack, wiringScene } from '@/features/practice/wiring-state'
import { useBenchView } from './bench-view'
import { draftCordGeometry, joinedGeometry, patchCordGeometry, plugPosition } from './cord-geometry'

const colors: Record<WireColor, string> = {
  red: 'rgb(193, 40, 40)',
  black: 'rgb(30, 33, 35)',
  yellow: 'rgb(236, 188, 29)',
  green: 'rgb(38, 129, 72)',
  blue: 'rgb(31, 99, 177)',
  lightBlue: 'rgb(103, 183, 217)',
  yellowGreen: 'rgb(224, 193, 38)',
  white: 'rgb(219, 219, 219)',
}

/** 导线透视（X-Ray）透明度（技术设计 §10.3，T1.9A）。 */
export const WIRE_XRAY_OPACITY = 0.22

export function wireColorValue(color: WireColor) {
  return new Color(colors[color])
}

const EMPTY_WIRE_SET: ReadonlySet<string> = new Set()

/** 计算与指定插孔处于同一电气连通网络内的所有导线 ID（BFS，用于悬停等电位微亮）。 */
export function wiresInJackNet(wires: readonly Wire[], jackRef: string | null): ReadonlySet<string> {
  if (!jackRef || !wires.length) return EMPTY_WIRE_SET
  const result = new Set<string>()
  const visitedJacks = new Set<string>([jackRef])
  const queue: string[] = [jackRef]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const wire of wires) {
      if (wire.a === current || wire.b === current) {
        result.add(wire.id)
        const other = wire.a === current ? wire.b : wire.a
        if (!visitedJacks.has(other)) {
          visitedJacks.add(other)
          queue.push(other)
        }
      }
    }
  }
  return result.size > 0 ? result : EMPTY_WIRE_SET
}

const Cord = memo(function Cord({
  wire,
  jacks,
  wires,
  selected,
  netHighlighted,
  dimmed,
  highlight,
  overlay = false,
}: {
  wire: Wire
  jacks: WiringJack[]
  wires: Wire[]
  selected: boolean
  netHighlighted: boolean
  dimmed: boolean
  highlight: Color
  overlay?: boolean
}) {
  const geometry = useMemo(
    () => patchCordGeometry(wire, jacks, wires, wiringScene.workSurface).geometry,
    [wire, jacks, wires],
  )
  const outline = useMemo(() => {
    if (!selected) return null
    const copy = geometry.clone()
    const positions = copy.getAttribute('position')
    const normals = copy.getAttribute('normal')
    for (let index = 0; index < positions.count; index++)
      positions.setXYZ(
        index,
        positions.getX(index) + normals.getX(index) * 0.0009,
        positions.getY(index) + normals.getY(index) * 0.0009,
        positions.getZ(index) + normals.getZ(index) * 0.0009,
      )
    return copy
  }, [geometry, selected])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => outline?.dispose(), [outline])
  return (
    <group>
      {selected && outline && (
        <mesh geometry={outline} raycast={() => null}>
          <meshBasicMaterial color={highlight} side={BackSide} toneMapped={false} />
        </mesh>
      )}
      {/* Selection is screen-space picking in useWiringInteraction; the wiring list covers keyboard use. */}
      <mesh geometry={geometry} userData={{ wireId: wire.id }}>
        <meshStandardMaterial
          color={wire.color === 'yellowGreen' ? 'white' : wireColorValue(wire.color)}
          vertexColors={wire.color === 'yellowGreen'}
          roughness={0.8}
          emissive={selected || netHighlighted ? highlight : 'black'}
          emissiveIntensity={selected ? 0.5 : netHighlighted ? 0.35 : 0}
          transparent={dimmed}
          opacity={dimmed ? WIRE_XRAY_OPACITY : 1}
          depthWrite={!dimmed}
          polygonOffset={overlay}
          polygonOffsetFactor={overlay ? -2 : 0}
          polygonOffsetUnits={overlay ? -2 : 0}
        />
      </mesh>
    </group>
  )
})

const CordBatch = memo(function CordBatch({
  wires,
  allWires,
  jacks,
  color,
  dimmed,
}: {
  wires: Wire[]
  allWires: Wire[]
  jacks: WiringJack[]
  color: WireColor
  dimmed: boolean
}) {
  const geometry = useMemo(
    () =>
      joinedGeometry(wires.map((wire) => patchCordGeometry(wire, jacks, allWires, wiringScene.workSurface).geometry)),
    [wires, allWires, jacks],
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <mesh geometry={geometry} userData={{ ignoreWiringHit: true }}>
      <meshStandardMaterial
        color={color === 'yellowGreen' ? 'white' : wireColorValue(color)}
        vertexColors={color === 'yellowGreen'}
        roughness={0.8}
        transparent={dimmed}
        opacity={dimmed ? WIRE_XRAY_OPACITY : 1}
        depthWrite={!dimmed}
      />
    </mesh>
  )
})

export interface DragDraft {
  target: Vector3
  revision: number
}

export function DraftCord({
  jacks,
  draft,
  meshRef,
}: {
  jacks: WiringJack[]
  draft: RefObject<DragDraft>
  meshRef: RefObject<Mesh | null>
}) {
  const pending = useCircuit((state) => state.pendingJack)
  const pendingRewire = useCircuit((state) => state.pendingRewire)
  const wireColor = useCircuit((state) => state.wireColor)
  const wires = useCircuit((state) => state.wires)
  const color = pendingRewire
    ? (wires.find((entry) => entry.id === pendingRewire.wireId)?.color ?? wireColor)
    : wireColor
  const start = useMemo(() => {
    const jack = jacks.find((entry) => entry.ref === pending)
    if (!jack) return null
    const existing = wires.filter(
      (wire) => wire.id !== pendingRewire?.wireId && (wire.a === pending || wire.b === pending),
    ).length
    return plugPosition(jack, existing).exit
  }, [jacks, pending, pendingRewire, wires])
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    if (start) invalidate()
  }, [invalidate, start])
  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh || !start) return
    if (mesh.userData.revision === draft.current.revision) return
    const geometry = draftCordGeometry(start.toArray(), draft.current.target.toArray(), wiringScene.workSurface)
    mesh.geometry.dispose()
    mesh.geometry = geometry
    mesh.userData.revision = draft.current.revision
  })
  if (!start) return null
  return (
    <mesh ref={meshRef} raycast={() => null}>
      <bufferGeometry />
      <meshBasicMaterial color={wireColorValue(color)} transparent opacity={0.85} />
    </mesh>
  )
}

function sampleAlongPath(path: readonly [number, number, number][], distance: number): Vector3 {
  if (path.length === 0) return new Vector3()
  if (path.length === 1) return new Vector3(...(path[0] as [number, number, number]))
  let walked = 0
  for (let i = 0; i < path.length - 1; i++) {
    const p0 = path[i] as [number, number, number]
    const p1 = path[i + 1] as [number, number, number]
    const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    if (walked + segLen >= distance && segLen > 1e-6) {
      const t = Math.max(0, Math.min(1, (distance - walked) / segLen))
      return new Vector3(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t)
    }
    walked += segLen
  }
  return new Vector3(...(path[path.length - 1] as [number, number, number]))
}

export function wireEndpointPositions(
  wire: Wire,
  jacks: readonly WiringJack[],
  wires: readonly Wire[],
): { a: Vector3; b: Vector3; midpoint: Vector3 } | null {
  const ja = jacks.find((jack) => jack.ref === wire.a)
  const jb = jacks.find((jack) => jack.ref === wire.b)
  if (!ja || !jb) return null
  const { geometry, midpoint, path } = patchCordGeometry(wire, jacks, wires as Wire[], wiringScene.workSurface)
  geometry.dispose()
  let totalLen = 0
  for (let i = 0; i < path.length - 1; i++) {
    const p0 = path[i] as [number, number, number]
    const p1 = path[i + 1] as [number, number, number]
    totalLen += Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
  }
  // 把拔插手柄落在插头护套后方沿导线 2.8 cm 处，避免与插孔中心叠插重合（T1.9B）
  const offset = Math.min(0.028, totalLen * 0.16)
  return {
    a: sampleAlongPath(path, offset),
    b: sampleAlongPath(path, Math.max(0, totalLen - offset)),
    midpoint,
  }
}

/** 选中/悬停导线的可视化端点拔插手柄与中点微型操作条（技术设计 §10.3，T1.9B）。 */
function ActiveWireOverlay({
  wire,
  jacks,
  wires,
  selected,
  powered,
  highlight,
}: {
  wire: Wire
  jacks: WiringJack[]
  wires: Wire[]
  selected: boolean
  powered: boolean
  highlight: Color
}) {
  const wireMenuOpen = useBenchView((state) => state.wireMenu !== null)
  const positions = useMemo(() => wireEndpointPositions(wire, jacks, wires), [wire, jacks, wires])
  if (!positions || powered) return null
  const radius = selected ? 0.008 : 0.006
  return (
    <group>
      <mesh position={positions.a} raycast={() => null}>
        <sphereGeometry args={[radius, 16, 12]} />
        <meshBasicMaterial color={highlight} toneMapped={false} />
      </mesh>
      <mesh position={positions.b} raycast={() => null}>
        <sphereGeometry args={[radius, 16, 12]} />
        <meshBasicMaterial color={highlight} toneMapped={false} />
      </mesh>
      {selected && !wireMenuOpen && (
        <Html center position={positions.midpoint} style={{ pointerEvents: 'none' }}>
          <div
            role="toolbar"
            aria-label="导线快捷操作"
            data-wire-micro-toolbar={wire.id}
            onPointerDown={(event) => event.stopPropagation()}
            className="pointer-events-auto -translate-y-7 flex items-center gap-0.5 rounded-md border bg-popover/95 p-0.5 text-popover-foreground shadow-md"
          >
            <Button
              size="xs"
              variant="ghost"
              disabled={powered}
              onClick={() => circuitStore.getState().startRewire(wire.id, 'a')}
            >
              <ArrowLeftRight className="size-3" />
              改接起点
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={powered}
              onClick={() => circuitStore.getState().startRewire(wire.id, 'b')}
            >
              <ArrowLeftRight className="size-3" />
              改接终点
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="ghost" disabled={powered} aria-label="更换导线颜色">
                  <Palette className="size-3" />
                  换色
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuRadioGroup
                  value={wire.color}
                  onValueChange={(color) => {
                    const matched = wireColors.find((item) => item.value === color)
                    if (matched) circuitStore.getState().updateWire(wire.id, { color: matched.value })
                  }}
                >
                  {wireColors.map((color) => (
                    <DropdownMenuRadioItem key={color.value} value={color.value}>
                      {color.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="xs"
              variant="ghost"
              disabled={powered}
              className="text-destructive hover:text-destructive"
              onClick={() => circuitStore.getState().deleteWire(wire.id)}
            >
              <Trash2 className="size-3" />
              删除
            </Button>
          </div>
        </Html>
      )}
    </group>
  )
}

export function PatchCords3D({
  jacks,
  highlight,
  region,
}: {
  jacks: WiringJack[]
  highlight: Color
  region?: RefObject<HTMLElement | null>
}) {
  const wires = useCircuit((state) => state.wires)
  const powered = useCircuit((state) => state.powered)
  const selected = useCircuit((state) => state.selectedWireId)
  const pending = useCircuit((state) => state.pendingJack)
  const pendingRewire = useCircuit((state) => state.pendingRewire)
  const wireXRay = useBenchView((state) => state.wireXRay)
  const altHeld = useBenchView((state) => state.altHeld)
  const hoveredJack = useBenchView((state) => state.hoveredJack)
  const hoveredWire = useBenchView((state) => state.hoveredWire)
  const invalidate = useThree((state) => state.invalidate)

  const xRayActive = wireXRay || altHeld || Boolean(pending)
  const visibleWires = useMemo(
    () => (pendingRewire ? wires.filter((wire) => wire.id !== pendingRewire.wireId) : wires),
    [wires, pendingRewire],
  )
  const activeOverlayWire = useMemo(() => {
    if (pending) return null
    const id = selected ?? hoveredWire
    if (!id) return null
    return visibleWires.find((wire) => wire.id === id) ?? null
  }, [pending, selected, hoveredWire, visibleWires])
  const netHighlighted = useMemo(() => wiresInJackNet(visibleWires, hoveredJack), [visibleWires, hoveredJack])

  useEffect(() => {
    if (region?.current) {
      region.current.dataset.wireXrayActive = xRayActive ? 'on' : 'off'
      region.current.dataset.netHighlightedWires = String(netHighlighted.size)
      region.current.dataset.activeWireOverlay = activeOverlayWire?.id ?? ''
    }
    invalidate()
  }, [xRayActive, netHighlighted, activeOverlayWire, region, invalidate])

  const groups = useMemo(() => {
    const grouped = new Map<WireColor, Wire[]>()
    for (const wire of visibleWires) {
      if (wire.id === selected) continue
      const group = grouped.get(wire.color) ?? []
      group.push(wire)
      grouped.set(wire.color, group)
    }
    return grouped
  }, [visibleWires, selected])

  const overlayNode = activeOverlayWire ? (
    <ActiveWireOverlay
      wire={activeOverlayWire}
      jacks={jacks}
      wires={visibleWires}
      selected={activeOverlayWire.id === selected}
      powered={powered}
      highlight={highlight}
    />
  ) : null

  if (visibleWires.length <= 20)
    return (
      <>
        {visibleWires.map((wire) => {
          const isSelected = wire.id === selected
          const isNet = netHighlighted.has(wire.id)
          const dimmed = xRayActive && !isSelected && !isNet
          return (
            <Cord
              key={wire.id}
              wire={wire}
              wires={visibleWires}
              jacks={jacks}
              selected={isSelected}
              netHighlighted={isNet}
              dimmed={dimmed}
              highlight={highlight}
            />
          )
        })}
        {overlayNode}
      </>
    )
  return (
    <>
      {[...groups].map(([color, entries]) => (
        <CordBatch
          key={color}
          wires={entries}
          allWires={visibleWires}
          jacks={jacks}
          color={color}
          dimmed={xRayActive}
        />
      ))}
      {visibleWires
        .filter((wire) => wire.id === selected || netHighlighted.has(wire.id))
        .map((wire) => (
          <Cord
            key={wire.id}
            wire={wire}
            wires={visibleWires}
            jacks={jacks}
            selected={wire.id === selected}
            netHighlighted={netHighlighted.has(wire.id)}
            dimmed={false}
            highlight={highlight}
            overlay={wire.id !== selected}
          />
        ))}
      {overlayNode}
    </>
  )
}

/** 单条诊断/步骤悬停或定位的 3D 引导虚线（T1.9B）：不触发 CordBatch 重建；自主模式下屏蔽过程引导。 */
export function DiagnosticGuideCord({
  jacks,
  color,
  region,
  guideMode,
}: {
  jacks: WiringJack[]
  color: Color
  region: RefObject<HTMLElement | null>
  guideMode: 'guided' | 'free'
}) {
  const highlighted = useBenchView((state) => state.highlightedLink)
  const invalidate = useThree((state) => state.invalidate)
  const pair = useMemo(() => {
    if (!highlighted?.guidePair) return null
    if (guideMode === 'free' && highlighted.source === 'step') return null
    const [a, b] = highlighted.guidePair
    if (!jacks.some((jack) => jack.ref === a) || !jacks.some((jack) => jack.ref === b)) return null
    const guide: Wire = { id: `diag:${a}:${b}`, a, b, color: 'white' }
    const { geometry, path } = patchCordGeometry(guide, jacks, [guide], wiringScene.workSurface)
    geometry.dispose()
    return { key: `${a}:${b}`, path }
  }, [highlighted, jacks, guideMode])

  useEffect(() => {
    const element = region.current
    if (element) {
      if (pair) element.dataset.diagnosticGuideLink = pair.key
      else delete element.dataset.diagnosticGuideLink
    }
    invalidate()
    return () => {
      if (element) delete element.dataset.diagnosticGuideLink
    }
  }, [pair, region, invalidate])

  if (!pair) return null
  return (
    <Line
      points={pair.path}
      color={color}
      lineWidth={2.5}
      dashed
      dashSize={0.014}
      gapSize={0.008}
      toneMapped={false}
      raycast={() => null}
    />
  )
}

/** Dashed cords for reference links the student has not wired yet (PRD WIR-08). */
export function GuideCords({
  jacks,
  nets,
  color,
  region,
}: {
  jacks: WiringJack[]
  nets: readonly (readonly string[])[]
  color: Color
  region: RefObject<HTMLElement | null>
}) {
  const wires = useCircuit((state) => state.wires)
  const paths = useMemo(() => {
    const placed = new Set(jacks.map((jack) => jack.ref))
    return missingReferenceLinks(nets, wires)
      .filter(([a, b]) => placed.has(a) && placed.has(b))
      .map(([a, b]) => {
        const guide: Wire = { id: `guide:${a}:${b}`, a, b, color: 'white' }
        const { geometry, path } = patchCordGeometry(guide, jacks, [guide], wiringScene.workSurface)
        geometry.dispose()
        return { id: guide.id, path }
      })
  }, [jacks, nets, wires])
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    const element = region.current
    if (element) element.dataset.guideLinks = paths.map((item) => item.id.slice('guide:'.length)).join(' ')
    invalidate()
    return () => {
      if (element) delete element.dataset.guideLinks
    }
  }, [paths, region, invalidate])
  return (
    <>
      {paths.map((item) => (
        <Line
          key={item.id}
          points={item.path}
          color={color}
          lineWidth={2}
          dashed
          dashSize={0.012}
          gapSize={0.008}
          toneMapped={false}
          raycast={() => null}
        />
      ))}
    </>
  )
}
