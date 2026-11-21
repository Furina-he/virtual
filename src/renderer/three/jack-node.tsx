import { Html } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { Color, SRGBColorSpace } from 'three'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AssetAnchor } from './anchors'
import { useBenchView } from './bench-view'

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

/** Visual ring and label only; picking is screen-space in `useWiringInteraction` (技术设计 §10.3). */
export function JackNode3D({
  anchor,
  globalId,
  assetName,
  color,
  stackCount,
  pending,
}: {
  anchor: AssetAnchor
  globalId: string
  assetName: string
  color: Color
  stackCount: number
  pending: boolean
}) {
  const hovered = useBenchView((state) => state.hoveredJack === globalId)
  const nearby = useBenchView((state) => state.nearbyJacks.includes(globalId))
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    if (hovered || pending || nearby) invalidate()
  }, [hovered, pending, nearby, invalidate])
  return (
    <group position={anchor.position} quaternion={anchor.quaternion}>
      {nearby && !hovered && (
        <Html center position={[0, 0.016, 0.012]} style={{ pointerEvents: 'none' }}>
          <span
            data-jack-label={globalId}
            className="pointer-events-none rounded-sm border bg-background/90 px-1 text-xs whitespace-nowrap text-foreground shadow-xs"
          >
            {anchor.label}
          </span>
        </Html>
      )}
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
