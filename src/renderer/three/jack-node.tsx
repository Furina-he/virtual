import { Html } from '@react-three/drei'
import { type ThreeEvent, useThree } from '@react-three/fiber'
import { useState } from 'react'
import { Color, MeshBasicMaterial, SphereGeometry, SRGBColorSpace } from 'three'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AssetAnchor } from './anchors'

const hitGeometry = new SphereGeometry(0.01, 10, 8)
const hitMaterial = new MeshBasicMaterial({ visible: false })

// Canvas resolves the existing CSS token to sRGB; Three does not parse OKLCH.
export function readHighlightColor() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) return new Color()
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return new Color().setRGB(r / 255, g / 255, b / 255, SRGBColorSpace)
}

export function JackNode3D({
  anchor,
  globalId,
  assetName,
  color,
  stackCount,
  pending,
  onStart,
}: {
  anchor: AssetAnchor
  globalId: string
  assetName: string
  color: Color
  stackCount: number
  pending: boolean
  onStart: (ref: string, event: ThreeEvent<PointerEvent>) => void
}) {
  const [hovered, setHovered] = useState(false)
  const invalidate = useThree((state) => state.invalidate)
  const hover = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    setHovered(true)
    invalidate()
  }
  return (
    <group position={anchor.position} quaternion={anchor.quaternion}>
      <mesh
        geometry={hitGeometry}
        material={hitMaterial}
        dispose={null}
        userData={{ jackRef: globalId }}
        onPointerDown={(event) => onStart(globalId, event)}
        onPointerOver={hover}
        onPointerOut={() => setHovered(false)}
      />
      {(hovered || pending) && (
        <>
          <mesh position={[0, 0, 0.002]} userData={{ ignoreWiringHit: true }} raycast={() => null}>
            <ringGeometry args={[0.006, 0.008, 24]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
          {hovered && (
            <Html center position={[0, 0.025, 0.012]} style={{ pointerEvents: 'none' }}>
              <TooltipProvider>
                <Tooltip open>
                  <TooltipTrigger asChild>
                    <span className="block size-1" aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent data-jack-id={globalId} className="pointer-events-none">
                    {assetName} · {anchor.label}（{anchor.id}）{stackCount > 0 ? ` · 叠插 ${stackCount}` : ''}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </Html>
          )}
        </>
      )}
    </group>
  )
}
