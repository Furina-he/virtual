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
  const showJackLabels = useBenchView((state) => state.showJackLabels)
  const nearby = useBenchView((state) => state.nearbyJacks.includes(globalId))
  const persistent = useBenchView((state) => state.persistentLabels.find((item) => item.id === globalId))
  const diagnosticHighlighted = useBenchView(
    (state) => Boolean(state.highlightedLink?.jacks.includes(globalId)) || state.pulsingJack === globalId,
  )
  const pulsing = useBenchView((state) => state.pulsingJack === globalId)
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    if (hovered || pending || nearby || persistent || diagnosticHighlighted || pulsing) invalidate()
  }, [hovered, pending, nearby, persistent, diagnosticHighlighted, pulsing, invalidate])
  return (
    <group position={anchor.position} quaternion={anchor.quaternion}>
      {showJackLabels && persistent && !hovered && !pulsing && (
        <Html center position={[0, 0, 0.012]} style={{ pointerEvents: 'none' }}>
          <span
            data-persistent-jack-label={globalId}
            style={{ transform: `translate(${persistent.offsetX}px, ${persistent.offsetY}px)` }}
            className="pointer-events-none inline-block rounded-sm border bg-background/95 px-1 py-0.5 text-xs leading-none whitespace-nowrap text-foreground shadow-xs"
          >
            {anchor.label}
          </span>
        </Html>
      )}
      {showJackLabels && !persistent && nearby && !hovered && !pulsing && (
        <Html center position={[0, 0.016, 0.012]} style={{ pointerEvents: 'none' }}>
          <span
            data-jack-label={globalId}
            className="pointer-events-none rounded-sm border bg-background/90 px-1 text-xs whitespace-nowrap text-foreground shadow-xs"
          >
            {anchor.label}
          </span>
        </Html>
      )}
      {(hovered || pending || diagnosticHighlighted) && (
        <>
          <mesh position={[0, 0, 0.002]} userData={{ ignoreWiringHit: true }} raycast={() => null}>
            <ringGeometry args={[0.006, 0.0085, 24]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
          {pulsing && (
            <>
              <mesh position={[0, 0, 0.0025]} userData={{ ignoreWiringHit: true }} raycast={() => null}>
                <ringGeometry args={[0.01, 0.013, 24]} />
                <meshBasicMaterial color={color} transparent opacity={0.85} toneMapped={false} />
              </mesh>
              <Html center position={[0, 0.022, 0.014]} style={{ pointerEvents: 'none' }}>
                <span
                  data-pulsing-jack-badge={globalId}
                  className="pointer-events-none rounded-sm border border-primary bg-primary px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-primary-foreground shadow-sm"
                >
                  {anchor.label}
                </span>
              </Html>
            </>
          )}
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
