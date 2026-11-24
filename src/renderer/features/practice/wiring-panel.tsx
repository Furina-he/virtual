import type { WiringIssue } from '@domain/wiring-check'
import type { Wire, WireColor } from '@shared/schema/circuit'
import { Cable, ChevronsUpDown, Crosshair, Plus, Redo2, Trash2, Undo2 } from 'lucide-react'
import { memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBenchView } from '@/three/bench-view'
import { defaultWireSlack, wireColors, wireSlacks } from './wire-options'
import { circuitStore, jackName, useCircuit, useHistorySize, useWiringJacks } from './wiring-state'

function shortcutAvailable() {
  return !document.querySelector(
    '[role="dialog"]:not([data-state="closed"]), [role="listbox"]:not([data-state="closed"])',
  )
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
  // Esc backs out one level: the pending wire first, then the device close-up.
  useHotkeys(
    'escape',
    () => {
      const state = circuitStore.getState()
      if (state.pendingJack) state.cancelConnection()
      else useBenchView.getState().leaveFocus()
    },
    options,
  )
  useHotkeys('home', () => useBenchView.getState().setPreset('work'), options)
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

const JackSelect = memo(function JackSelect({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (ref: string) => void
  label: string
}) {
  const jacks = useWiringJacks()
  const [open, setOpen] = useState(false)
  const deviceGroups = useMemo(() => {
    const grouped = new Map<string, typeof jacks>()
    for (const jack of jacks) {
      const list = grouped.get(jack.instanceId) ?? []
      list.push(jack)
      grouped.set(jack.instanceId, list)
    }
    return [...grouped.entries()].map(([instanceId, groupJacks]) => ({ instanceId, jacks: groupJacks }))
  }, [jacks])
  const selectedJack = jacks.find((jack) => jack.ref === value)
  const selected = selectedJack?.ref ?? ''
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          data-selected-jack={selected}
          className="w-full max-w-full min-w-0 justify-between overflow-hidden px-2.5 font-normal"
        >
          <span className="truncate text-xs">
            {selectedJack ? `${selectedJack.deviceName} · ${selectedJack.label} (${selectedJack.id})` : '选择插孔'}
          </span>
          <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0 data-closed:animate-none">
        {open && (
          <Command>
            <CommandInput autoFocus placeholder="搜索设备、插孔名或编号…" aria-label={`搜索${label}`} />
            <CommandList>
              <CommandEmpty>未找到匹配的插孔</CommandEmpty>
              {deviceGroups.map((device) => (
                <CommandGroup key={device.instanceId} heading={device.jacks[0]?.deviceName ?? device.instanceId}>
                  {device.jacks.map((jack) => (
                    <CommandItem
                      key={jack.ref}
                      value={`${jack.deviceName} ${jack.label} ${jack.id} ${jack.ref}`}
                      data-jack-ref={jack.ref}
                      data-checked={selected === jack.ref}
                      onSelect={() => {
                        useBenchView.getState().setHover({ hoveredJack: jack.ref })
                        onChange(jack.ref)
                        setOpen(false)
                      }}
                    >
                      <span className="truncate text-xs">
                        {jack.deviceName} · {jack.label} ({jack.id})
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
})

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
          value={String(wire.slack ?? defaultWireSlack)}
          disabled={powered}
          onValueChange={(value) => updateWire(wire.id, { slack: Number(value) })}
        >
          <SelectTrigger aria-label="走线垂度" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {wireSlacks.map((value) => (
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

const ISSUE_CODE_LABEL: Record<WiringIssue['code'], string> = {
  'missing-connection': '缺少连线',
  'extra-connection': '多了连线',
  'measure-missing': '待接表',
  'measure-polarity': '极性接反',
  'ammeter-across-source': '电流表并联电源',
  'source-short': '电源短接',
}

export function WiringPanel() {
  const wires = useCircuit((state) => state.wires)
  const selected = useCircuit((state) => state.selectedWireId)
  const wireColor = useCircuit((state) => state.wireColor)
  const autoWireColor = useCircuit((state) => state.autoWireColor)
  const pending = useCircuit((state) => state.pendingJack)
  const pendingRewire = useCircuit((state) => state.pendingRewire)
  const notice = useCircuit((state) => state.notice)
  const powered = useCircuit((state) => state.powered)
  const diagnosticIssues = useBenchView((state) => state.diagnosticIssues)
  const diagnosticNotice = useBenchView((state) => state.diagnosticNotice)
  const showStructuredDiagnostics =
    diagnosticIssues.length > 0 && (diagnosticNotice === null || diagnosticNotice === notice)
  const jacks = useWiringJacks()
  const { undoCount, redoCount } = useHistorySize()
  const [tab, setTab] = useState('wires')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const autoColorId = useId()
  const selectedWire = wires.find((wire) => wire.id === selected)
  const prevWiresRef = useRef(wires)
  useEffect(() => {
    if (prevWiresRef.current !== wires) {
      prevWiresRef.current = wires
      if (useBenchView.getState().diagnosticIssues.length > 0) {
        useBenchView.getState().clearDiagnostics()
      }
    }
  }, [wires])
  return (
    <section
      aria-label="接线编辑"
      className="flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto"
      data-wire-count={wires.length}
      data-undo-count={undoCount}
      data-redo-count={redoCount}
      data-auto-wire-color={autoWireColor ? 'on' : 'off'}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
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
      <div className="min-w-0 shrink-0 space-y-2 border-b p-3">
        <p className="text-xs text-muted-foreground">
          拖动插孔连接，或从列表选择两端；按住 <Kbd>Alt</Kbd> 点插孔可拔插改接。<Kbd>Esc</Kbd> 取消。
        </p>
        {powered && <p className="text-xs text-warning">当前已上电，请先断电再修改接线。</p>}
        {showStructuredDiagnostics ? (
          <ScrollArea
            key={`issues:${diagnosticIssues.length}:${notice ?? ''}`}
            type="auto"
            role="region"
            aria-label="接线诊断报告"
            className="h-20 min-w-0 scroll-m-1 rounded-sm border bg-muted/30"
          >
            <ul role="status" data-diagnostic-list className="divide-y pr-3">
              {diagnosticIssues.map((issue, index) => {
                const startJack = issue.jacks[0]
                const endJack = issue.jacks[1]
                const pair = startJack && endJack ? ([startJack, endJack] as const) : undefined
                const isDanger = issue.code === 'source-short' || issue.code === 'ammeter-across-source'
                const sourceType = isDanger ? 'danger' : 'diagnostic'
                return (
                  <li
                    key={`${issue.code}:${issue.jacks.join(':')}:${issue.message}`}
                    data-diagnostic-issue={issue.code}
                    data-issue-jacks={issue.jacks.join(',')}
                    title={issue.message}
                    className="space-y-0.5 px-2 py-1 text-xs leading-snug hover:bg-accent/60"
                    onMouseEnter={() => {
                      if (issue.jacks.length) {
                        useBenchView.getState().setHighlightedLink({
                          jacks: issue.jacks,
                          guidePair: pair,
                          source: sourceType,
                        })
                      }
                    }}
                    onMouseLeave={() => useBenchView.getState().setHighlightedLink(null)}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className={
                          isDanger
                            ? 'inline-block font-medium text-destructive'
                            : 'inline-block font-medium text-warning'
                        }
                      >
                        {ISSUE_CODE_LABEL[issue.code]}
                      </span>
                      {startJack && (
                        <Button
                          size="xs"
                          variant="outline"
                          data-locate-issue={index}
                          aria-label={`定位问题 ${index + 1}`}
                          className="h-5 shrink-0 px-1.5"
                          onClick={() => useBenchView.getState().locateJack(startJack, pair, sourceType)}
                        >
                          <Crosshair className="size-3" />
                          定位
                        </Button>
                      )}
                    </div>
                    <p className="break-words text-foreground">
                      {startJack && endJack ? `${jackName(startJack)} → ${jackName(endJack)}` : issue.message}
                    </p>
                  </li>
                )
              })}
            </ul>
          </ScrollArea>
        ) : (
          notice && (
            <ScrollArea
              key={notice}
              type="auto"
              role="region"
              aria-label="接线诊断报告"
              className="h-20 min-w-0 scroll-m-1"
            >
              <p role="status" className="break-words pr-3 pb-1 text-xs leading-relaxed text-warning">
                {notice}
              </p>
            </ScrollArea>
          )
        )}
        {pending && (
          <p className="break-words text-xs">
            {pendingRewire ? `正在改接（固定端）：${jackName(pending)}` : `正在连接：${jackName(pending)}`}
            <Button size="sm" variant="ghost" onClick={() => circuitStore.getState().cancelConnection()}>
              {pendingRewire ? '取消改接' : '取消接线'}
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
        <div className="flex min-w-0 items-center justify-between gap-2">
          <label
            htmlFor={autoColorId}
            title="开启后按正极红、地/负极黑、信号蓝/黄/绿轮换自动预选颜色"
            className="min-w-0 truncate text-xs text-muted-foreground"
          >
            自动极性色
          </label>
          <Switch
            id={autoColorId}
            aria-label="自动极性色"
            className="shrink-0"
            checked={autoWireColor}
            onCheckedChange={(checked) => circuitStore.getState().setAutoWireColor(checked)}
          />
        </div>
      </div>
      {/* Keep the endpoint form usable even at the minimum properties-panel height. */}
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-60 min-w-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="w-full shrink-0 justify-start border-b px-2">
          <TabsTrigger value="wires">接线列表</TabsTrigger>
          <TabsTrigger value="properties">导线属性</TabsTrigger>
        </TabsList>
        <TabsContent value="wires" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <form
            aria-label="选择插孔接线"
            className="min-w-0 shrink-0 space-y-2 border-b p-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (circuitStore.getState().addWire(from, to)) {
                useBenchView.getState().setHover({ hoveredJack: null })
              }
            }}
          >
            <JackSelect label="接线起点" value={from} onChange={setFrom} />
            <JackSelect label="接线终点" value={to} onChange={setTo} />
            <Button
              className="w-full scroll-m-2"
              type="submit"
              variant="outline"
              disabled={!jacks.some((jack) => jack.ref === from) || !jacks.some((jack) => jack.ref === to)}
            >
              <Plus />
              添加导线
            </Button>
          </form>
          <ScrollArea type="auto" className="min-h-0 flex-1">
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
          </ScrollArea>
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
