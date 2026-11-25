import { moduleControlValid } from '@domain/circuit/module-controls'
import { findLearnResourceForBenchTarget } from '@domain/learn/catalog'
import type { Project } from '@shared/schema/project'
import { BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { create } from 'zustand'
import { RotaryKnob } from '@/components/instruments/rotary-knob'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { learnCatalog } from '@/features/learn/learn-content'
import { getInstrumentReading, subscribeInstrumentReadings } from '@/lib/instrument-readings'
import type { Module } from '../../../shared/schema/module'
import { FaultPanel } from './fault-panel'
import { moduleCatalog } from './practice-content'
import { WiringPanel } from './wiring-panel'
import { circuitStore, getActivePlacements, useActivePlacements, useCircuit } from './wiring-state'

export const moduleSelection = create<{ tab: string; instanceId: string | null; controlId: string | null }>(() => ({
  tab: 'wiring',
  instanceId: null,
  controlId: null,
}))

export function selectModuleControl(instanceId: string, controlId: string): void {
  moduleSelection.setState({ tab: 'controls', instanceId, controlId })
}

export function resetModuleSelection(): void {
  moduleSelection.setState({ tab: 'wiring', instanceId: null, controlId: null })
}

export function setModuleControl(instanceId: string, controlId: string, value: number): boolean {
  const placement = getActivePlacements().find((entry) => entry.instanceId === instanceId)
  const module = moduleCatalog.find((entry) => entry.id === placement?.assetId)
  const control = module?.controls.find((entry) => entry.id === controlId)
  if (!control || !moduleControlValid(control, value)) {
    circuitStore.setState({ notice: '模块设置无效，请使用标注的范围或档位。' })
    return false
  }
  return circuitStore.getState().setControlValue(`${instanceId}.${control.id}`, value)
}

function ModuleSegment7Strip({ instanceId, module }: { instanceId: string; module: Module }) {
  const displays = module.indicators.filter(
    (entry): entry is Extract<Module['indicators'][number], { kind: 'segment7' }> => entry.kind === 'segment7',
  )
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!displays.length) return
    return subscribeInstrumentReadings(instanceId, () => setTick((n) => n + 1))
  }, [instanceId, displays.length])
  if (!displays.length) return null
  const combined = displays
    .map((disp) => {
      const reading = getInstrumentReading(instanceId, disp.id)
      return reading.status === 'ok' ? reading.text : '-'
    })
    .join('')
  return (
    <div
      data-module-segment7-group={instanceId}
      data-segment7-value={combined}
      className="space-y-2 rounded-sm border bg-muted/40 p-2.5"
    >
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>板载数码管实时显示</span>
        <span className="font-mono font-medium text-foreground">{combined}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {displays.map((disp) => {
          const reading = getInstrumentReading(instanceId, disp.id)
          const char = reading.status === 'ok' ? reading.text : '--'
          return (
            <div
              key={disp.id}
              data-module-segment7={`${instanceId}.${disp.id}`}
              data-segment7-char={char}
              data-segment7-status={reading.status}
              className="flex flex-col items-center rounded-sm border bg-background px-2 py-2"
            >
              <span className="text-xs text-muted-foreground">{disp.label ?? disp.id}</span>
              <span className="font-mono text-2xl font-semibold tracking-wider text-destructive">{char}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ModuleProperties({ project }: { project?: Project }) {
  const navigate = useNavigate()
  const location = useLocation()
  const tab = moduleSelection((state) => state.tab)
  const selected = moduleSelection((state) => state.instanceId)
  const placements = useActivePlacements()
  const values = useCircuit((state) => state.controlValues)
  const modules = placements.flatMap((placement) => {
    const module = moduleCatalog.find((entry) => entry.id === placement.assetId)
    const hasInteractive = Boolean(
      module && (module.controls.length || module.indicators.some((entry) => entry.kind === 'segment7')),
    )
    return hasInteractive && module ? [{ instanceId: placement.instanceId, module }] : []
  })
  const active = modules.find((entry) => entry.instanceId === selected) ?? modules[0]
  const activeLearnResource = active
    ? findLearnResourceForBenchTarget(learnCatalog, { moduleId: active.module.id })
    : undefined
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => moduleSelection.setState({ tab: value })}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList variant="line" className="w-full justify-start border-b px-2">
        <TabsTrigger value="wiring">接线</TabsTrigger>
        <TabsTrigger value="controls">模块控件</TabsTrigger>
        <TabsTrigger value="fault">排故</TabsTrigger>
      </TabsList>
      <TabsContent value="wiring" className="min-h-0 flex-1 overflow-hidden">
        <WiringPanel />
      </TabsContent>
      <TabsContent value="controls" className="min-h-0 flex-1 overflow-auto">
        <section aria-label="模块控件" data-instance-id={active?.instanceId ?? ''} className="space-y-3 p-3">
          <Select
            value={active?.instanceId ?? ''}
            onValueChange={(instanceId) => moduleSelection.setState({ instanceId, controlId: null })}
          >
            <SelectTrigger aria-label="选择实训模块" className="w-full">
              <SelectValue placeholder="无可调模块" />
            </SelectTrigger>
            <SelectContent>
              {modules.map((entry, index) => {
                const duplicated = modules.filter((other) => other.module.name === entry.module.name).length > 1
                return (
                  <SelectItem key={entry.instanceId} value={entry.instanceId} data-instance-id={entry.instanceId}>
                    {duplicated ? `${entry.module.name} #${index + 1}` : entry.module.name}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            可在台面操作旋钮和开关，或精确设置数值；上电时仅修改已声明参数，不重接电路。
          </p>
          {active && activeLearnResource && (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                navigate(`/learn/${activeLearnResource.id}`, {
                  state: { from: location.pathname },
                })
              }
            >
              <BookOpen className="size-3.5" />
              查看器件资料
            </Button>
          )}
          {active && <ModuleSegment7Strip instanceId={active.instanceId} module={active.module} />}
          {active?.module.controls.map((control) => {
            const steps = control.steps
            const actual = values[`${active.instanceId}.${control.id}`] ?? control.default
            const min = steps ? 0 : (control.range?.[0] ?? 0)
            const max = steps ? steps.length - 1 : (control.range?.[1] ?? 1)
            return (
              <div key={control.id} data-control-id={control.id}>
                <RotaryKnob
                  label={control.label ?? control.id}
                  value={steps ? steps.indexOf(actual) : actual}
                  min={min}
                  max={max}
                  unit={control.unit}
                  step={steps ? 1 : (control.step ?? (max - min) / 100)}
                  options={steps?.map((value, index) => ({
                    value: index,
                    label: control.stepLabels?.[index] ?? `${value} ${control.unit}`.trim(),
                  }))}
                  onChange={(value) => setModuleControl(active.instanceId, control.id, steps?.[value] ?? value)}
                />
              </div>
            )
          })}
          {!active && <p className="text-xs text-muted-foreground">当前项目没有已交付的可调模块。</p>}
        </section>
      </TabsContent>
      <TabsContent value="fault" className="min-h-0 flex-1 overflow-auto">
        <FaultPanel project={project} />
      </TabsContent>
    </Tabs>
  )
}
