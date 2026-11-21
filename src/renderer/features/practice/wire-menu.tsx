import { Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useBenchView } from '@/three/bench-view'
import { defaultWireSlack, wireColors, wireSlacks } from './wire-options'
import { circuitStore, useCircuit } from './wiring-state'

/** Right-click menu for a 3D wire (技术设计 §10.3): delete, recolour, change sag. */
export function WireContextMenu() {
  const menu = useBenchView((state) => state.wireMenu)
  const wire = useCircuit((state) => state.wires.find((item) => item.id === menu?.id))
  const powered = useCircuit((state) => state.powered)
  const close = () => useBenchView.getState().setWireMenu(null)
  if (!menu || !wire) return null
  const index = circuitStore.getState().wires.findIndex((item) => item.id === wire.id) + 1
  return (
    <DropdownMenu open onOpenChange={(open) => !open && close()}>
      <DropdownMenuTrigger asChild>
        {/* Zero-size anchor at the click point; the menu itself is portalled. */}
        <span aria-hidden="true" className="fixed size-0" style={{ left: menu.x, top: menu.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48" aria-label={`导线 ${index} 菜单`}>
        <DropdownMenuLabel>导线 {index}</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={powered}>颜色</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={wire.color}
              onValueChange={(color) =>
                circuitStore.getState().updateWire(wire.id, {
                  color: wireColors.find((item) => item.value === color)?.value ?? wire.color,
                })
              }
            >
              {wireColors.map((color) => (
                <DropdownMenuRadioItem key={color.value} value={color.value}>
                  {color.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={powered}>走线垂度</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={String(wire.slack ?? defaultWireSlack)}
              onValueChange={(value) => circuitStore.getState().updateWire(wire.id, { slack: Number(value) })}
            >
              {wireSlacks.map((value) => (
                <DropdownMenuRadioItem key={value} value={String(value)}>
                  {Math.round(value * 100)} cm
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={powered}
          onSelect={() => circuitStore.getState().deleteWire(wire.id)}
        >
          <Trash2 />
          删除导线
          <DropdownMenuShortcut>Delete</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
