import { useFrame, useThree } from '@react-three/fiber'
import type { Wire, WireColor } from '@shared/schema/circuit'
import { type RefObject, useEffect, useMemo } from 'react'
import { BackSide, Color, type Mesh, type Vector3 } from 'three'
import { circuitStore, useCircuit, type WiringJack, wiringScene } from '@/features/practice/wiring-state'
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

export function wireColorValue(color: WireColor) {
  return new Color(colors[color])
}

function selectWire(id: string) {
  circuitStore.getState().selectWire(id)
}

function Cord({
  wire,
  jacks,
  wires,
  selected,
  highlight,
}: {
  wire: Wire
  jacks: WiringJack[]
  wires: Wire[]
  selected: boolean
  highlight: Color
}) {
  const { geometry, outline } = useMemo(() => {
    const { geometry } = patchCordGeometry(wire, jacks, wires, wiringScene.workSurface)
    const outline = geometry.clone()
    const positions = outline.getAttribute('position')
    const normals = outline.getAttribute('normal')
    for (let index = 0; index < positions.count; index++)
      positions.setXYZ(
        index,
        positions.getX(index) + normals.getX(index) * 0.0009,
        positions.getY(index) + normals.getY(index) * 0.0009,
        positions.getZ(index) + normals.getZ(index) * 0.0009,
      )
    return { geometry, outline }
  }, [wire, jacks, wires])
  useEffect(
    () => () => {
      geometry.dispose()
      outline.dispose()
    },
    [geometry, outline],
  )
  return (
    <group>
      {selected && (
        <mesh geometry={outline} raycast={() => null}>
          <meshBasicMaterial color={highlight} side={BackSide} toneMapped={false} />
        </mesh>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: R3F mesh; keyboard selection is available in the wiring list. */}
      <mesh
        geometry={geometry}
        onClick={(event) => {
          event.stopPropagation()
          selectWire(wire.id)
        }}
        userData={{ wireId: wire.id }}
      >
        <meshStandardMaterial
          color={wire.color === 'yellowGreen' ? 'white' : wireColorValue(wire.color)}
          vertexColors={wire.color === 'yellowGreen'}
          roughness={0.8}
          emissive={selected ? highlight : 'black'}
          emissiveIntensity={selected ? 0.5 : 0}
        />
      </mesh>
    </group>
  )
}

function CordBatch({
  wires,
  allWires,
  jacks,
  color,
}: {
  wires: Wire[]
  allWires: Wire[]
  jacks: WiringJack[]
  color: WireColor
}) {
  const batch = useMemo(() => {
    let triangles = 0
    const intervals: { lastTriangle: number; id: string }[] = []
    const parts = wires.map((wire) => {
      const { geometry } = patchCordGeometry(wire, jacks, allWires, wiringScene.workSurface)
      triangles += (geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3
      intervals.push({ lastTriangle: triangles, id: wire.id })
      return geometry
    })
    return { geometry: joinedGeometry(parts), intervals }
  }, [wires, allWires, jacks])
  useEffect(() => () => batch.geometry.dispose(), [batch])
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: R3F mesh, not a DOM element; the wiring list provides keyboard selection.
    <mesh
      geometry={batch.geometry}
      userData={{ ignoreWiringHit: true }}
      onClick={(event) => {
        event.stopPropagation()
        const wire = batch.intervals.find((item) => (event.faceIndex ?? -1) < item.lastTriangle)
        if (wire) selectWire(wire.id)
      }}
    >
      <meshStandardMaterial
        color={color === 'yellowGreen' ? 'white' : wireColorValue(color)}
        vertexColors={color === 'yellowGreen'}
        roughness={0.8}
      />
    </mesh>
  )
}

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
  const color = useCircuit((state) => state.wireColor)
  const wires = useCircuit((state) => state.wires)
  const start = useMemo(() => {
    const jack = jacks.find((entry) => entry.ref === pending)
    return jack
      ? plugPosition(jack, wires.filter((wire) => wire.a === pending || wire.b === pending).length).exit
      : null
  }, [jacks, pending, wires])
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
      <meshBasicMaterial color={wireColorValue(color)} transparent opacity={0.8} />
    </mesh>
  )
}

export function PatchCords3D({ jacks, highlight }: { jacks: WiringJack[]; highlight: Color }) {
  const wires = useCircuit((state) => state.wires)
  const selected = useCircuit((state) => state.selectedWireId)
  const groups = useMemo(() => {
    const grouped = new Map<WireColor, Wire[]>()
    for (const wire of wires) {
      if (wire.id === selected) continue
      const group = grouped.get(wire.color) ?? []
      group.push(wire)
      grouped.set(wire.color, group)
    }
    return grouped
  }, [wires, selected])
  if (wires.length <= 20)
    return (
      <>
        {wires.map((wire) => (
          <Cord
            key={wire.id}
            wire={wire}
            wires={wires}
            jacks={jacks}
            selected={wire.id === selected}
            highlight={highlight}
          />
        ))}
      </>
    )
  return (
    <>
      {[...groups].map(([color, entries]) => (
        <CordBatch key={color} wires={entries} allWires={wires} jacks={jacks} color={color} />
      ))}
      {wires
        .filter((wire) => wire.id === selected)
        .map((wire) => (
          <Cord key={wire.id} wire={wire} wires={wires} jacks={jacks} selected highlight={highlight} />
        ))}
    </>
  )
}
