import type { Wire, WireColor } from '@shared/schema/circuit'
import { Cable, Plus, Redo2, Trash2, Undo2 } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { circuitStore, jackName, useCircuit, useHistorySize, useWiringJacks } from './wiring-state'

const wireColors: { value: WireColor; label: string }[] = [
  { value: 'red', label: '红色' },
  { value: 'black', label: '黑色' },
  { value: 'yellow', label: '黄色' },
  { value: 'green', label: '绿色' },
  { value: 'blue', label: '蓝色' },
  { value: 'lightBlue', label: '淡蓝色（N）' },
  { value: 'yellowGreen', label: '黄绿双色（PE）' },
  { value: 'white', label: '白色' },
]

function shortcutAvailable() {
  return !document.querySelector('[role="dialog"], [role="listbox"]')
}

export function WiringShortcuts() {
  const options = { enabled: shortcutAvailable, preventDefault: true }
  useHotkeys('ctrl+z', () => circuitStore.getState().undo(), options)
  useHotkeys('ctrl+shift+z', () => circuitStore.getState().redo(), options)
  useHotkeys(
    'delete',
    () => {
      const state = circuitStore.getState()
      if (state.selectedWireId) state.deleteWire(state.selectedWireId)
    },
    options,
  )
  useHotkeys('escape', () => circuitStore.getState().cancelConnection(), options)
  return null
}

function ColorSelect({
  value,
  onChange,
  label,
  disabled,
}: {
  value: WireColor
  onChange: (color: WireColor) => void
  label: string
  disabled?: boolean
}) {
  return (
    <Select value={value} onValueChange={(color) => onChange(color as WireColor)} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {wireColors.map((color) => (
          <SelectItem key={color.value} value={color.value}>
            {color.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function JackSelect({ value, onChange, label }: { value: string; onChange: (ref: string) => void; label: string }) {
  const jacks = useWiringJacks()
  const placed = useCircuit((state) => state.placedInstruments)
  const deviceGroups = [...new Set(jacks.map((jack) => jack.instanceId))].map((instanceId) => ({
    instanceId,
    jacks: jacks.filter((jack) => jack.instanceId === instanceId),
  }))
  return (
    <Select value={jacks.some((jack) => jack.ref === value) ? value : ''} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-full min-w-0">
        <SelectValue placeholder="选择插孔" />
      </SelectTrigger>
      <SelectContent position="popper">
        {deviceGroups.map((device) => (
          <SelectGroup key={device.instanceId}>
            <SelectLabel>
              {device.jacks[0]?.deviceName} · {device.instanceId}
            </SelectLabel>
            {device.jacks.map((jack) => (
              <SelectItem key={jack.ref} value={jack.ref} data-jack-ref={jack.ref}>
                {jack.deviceName} · {jack.label} ({jack.id})
                {placed.some((instrument) => instrument.instanceId === device.instanceId)
                  ? ` · ${device.instanceId}`
                  : ''}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

function HistoryButton({
  label,
  keys,
  onClick,
  disabled,
  children,
}: {
  label: string
  keys: string
  onClick: () => void
  disabled: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="outline" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{keys}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

function WireProperties({ wire }: { wire: Wire }) {
  const updateWire = useCircuit((state) => state.updateWire)
  const powered = useCircuit((state) => state.powered)
  const [label, setLabel] = useState(wire.label ?? '')
  const id = useId()
  useEffect(() => setLabel(wire.label ?? ''), [wire.label])
  return (
    <section className="space-y-3 p-3" aria-label="选中导线属性">
      <p className="break-words text-xs">
        <span className="text-muted-foreground">起点：</span>
        {jackName(wire.a)}
      </p>
      <p className="break-words text-xs">
        <span className="text-muted-foreground">终点：</span>
        {jackName(wire.b)}
      </p>
      <label className="block space-y-1" htmlFor={id}>
        <span className="text-xs">导线标签</span>
        <Input
          id={id}
          value={label}
          maxLength={48}
          disabled={powered}
          placeholder="例如：电源正极"
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => updateWire(wire.id, { label: label.trim() })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
      </label>
      <div className="space-y-1">
        <span className="text-xs">颜色</span>
        <ColorSelect
          value={wire.color}
          label="选中导线颜色"
          disabled={powered}
          onChange={(color) => updateWire(wire.id, { color })}
        />
      </div>
      <div className="space-y-1">
        <span className="text-xs">走线垂度</span>
        <Select
          value={String(wire.slack ?? 0.12)}
          disabled={powered}
          onValueChange={(value) => updateWire(wire.id, { slack: Number(value) })}
        >
          <SelectTrigger aria-label="走线垂度" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[0.02, 0.06, 0.12, 0.2, 0.3, 0.4].map((value) => (
              <SelectItem key={value} value={String(value)}>
                {Math.round(value * 100)} cm
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button className="w-full" variant="outline" onClick={() => circuitStore.getState().deleteWire(wire.id)}>
        <Trash2 />
        删除选中导线<Kbd>Delete</Kbd>
      </Button>
    </section>
  )
}

export function WiringPanel() {
  const wires = useCircuit((state) => state.wires)
  const selected = useCircuit((state) => state.selectedWireId)
  const wireColor = useCircuit((state) => state.wireColor)
  const pending = useCircuit((state) => state.pendingJack)
  const notice = useCircuit((state) => state.notice)
  const powered = useCircuit((state) => state.powered)
  const jacks = useWiringJacks()
  const { undoCount, redoCount } = useHistorySize()
  const [tab, setTab] = useState('wires')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const selectedWire = wires.find((wire) => wire.id === selected)
  return (
    <section
      aria-label="接线编辑"
      className="flex h-full min-h-0 flex-col"
      data-wire-count={wires.length}
      data-undo-count={undoCount}
      data-redo-count={redoCount}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Cable className="size-4" />
        <h2 className="mr-auto text-sm font-medium">接线</h2>
        <span className="font-mono text-xs">{wires.length} 根</span>
        <HistoryButton
          label="撤销接线"
          keys="Ctrl+Z"
          disabled={!undoCount}
          onClick={() => circuitStore.getState().undo()}
        >
          <Undo2 />
        </HistoryButton>
        <HistoryButton
          label="重做接线"
          keys="Ctrl+Shift+Z"
          disabled={!redoCount}
          onClick={() => circuitStore.getState().redo()}
        >
          <Redo2 />
        </HistoryButton>
      </div>
      <div className="space-y-2 border-b p-3">
        <p className="text-xs text-muted-foreground">
          拖动插孔连接，或从列表选择两端。<Kbd>Esc</Kbd> 取消。
        </p>
        {powered && <p className="text-xs text-warning">当前已上电，请先断电再修改接线。</p>}
        {notice && (
          <p role="status" className="text-xs text-warning">
            {notice}
          </p>
        )}
        {pending && (
          <p className="break-words text-xs">
            正在连接：{jackName(pending)}
            <Button size="sm" variant="ghost" onClick={() => circuitStore.getState().cancelConnection()}>
              取消接线
            </Button>
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs">新导线</span>
          <ColorSelect
            value={wireColor}
            label="新导线颜色"
            onChange={(color) => circuitStore.getState().setWireColor(color)}
          />
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="w-full justify-start border-b px-2">
          <TabsTrigger value="wires">接线列表</TabsTrigger>
          <TabsTrigger value="properties">导线属性</TabsTrigger>
        </TabsList>
        <TabsContent value="wires" className="min-h-0 overflow-auto">
          <form
            aria-label="选择插孔接线"
            className="space-y-2 border-b p-3"
            onSubmit={(event) => {
              event.preventDefault()
              circuitStore.getState().addWire(from, to)
            }}
          >
            <JackSelect label="接线起点" value={from} onChange={setFrom} />
            <JackSelect label="接线终点" value={to} onChange={setTo} />
            <Button
              className="w-full"
              type="submit"
              variant="outline"
              disabled={!jacks.some((jack) => jack.ref === from) || !jacks.some((jack) => jack.ref === to)}
            >
              <Plus />
              添加导线
            </Button>
          </form>
          {wires.length ? (
            <ul className="divide-y">
              {wires.map((wire, index) => (
                <li
                  key={wire.id}
                  data-wire-id={wire.id}
                  data-wire-a={wire.a}
                  data-wire-b={wire.b}
                  data-wire-color={wire.color}
                  className="flex items-center gap-1 p-2"
                >
                  <button
                    type="button"
                    aria-label={`选择导线 ${index + 1}`}
                    aria-pressed={wire.id === selected}
                    onClick={() => circuitStore.getState().selectWire(wire.id)}
                    onDoubleClick={() => {
                      circuitStore.getState().selectWire(wire.id)
                      setTab('properties')
                    }}
                    className="min-w-0 flex-1 rounded-md px-1 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent"
                  >
                    <span className="block font-medium">
                      {wire.label || `导线 ${index + 1}`} ·{' '}
                      {wireColors.find((color) => color.value === wire.color)?.label}
                    </span>
                    <span className="block break-words text-muted-foreground">
                      {jackName(wire.a)} → {jackName(wire.b)}
                    </span>
                  </button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`删除导线 ${index + 1}`}
                    onClick={() => circuitStore.getState().deleteWire(wire.id)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-3 text-xs text-muted-foreground">还没有导线。选择电源和挂箱的插孔开始接线。</p>
          )}
          <div className="p-3">
            <Button
              variant="outline"
              className="w-full"
              disabled={!wires.length}
              onClick={() => {
                if (powered) circuitStore.getState().clearWires()
                else setClearOpen(true)
              }}
            >
              <Trash2 />
              清空接线
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="properties" className="min-h-0 overflow-auto">
          {selectedWire ? (
            <WireProperties key={selectedWire.id} wire={selectedWire} />
          ) : (
            <p className="p-3 text-xs text-muted-foreground">选择台面或列表中的导线，查看两端插孔并调整走线。</p>
          )}
        </TabsContent>
      </Tabs>
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空全部接线？</DialogTitle>
            <DialogDescription>将删除 {wires.length} 根导线。清空后可用 Ctrl+Z 撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                circuitStore.getState().clearWires()
                setClearOpen(false)
              }}
            >
              确认清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
