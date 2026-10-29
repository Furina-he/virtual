import { moduleControlValid } from '@domain/circuit/module-controls'
import { create } from 'zustand'
import { RotaryKnob } from '@/components/instruments/rotary-knob'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

export function ModuleProperties() {
  const tab = moduleSelection((state) => state.tab)
  const selected = moduleSelection((state) => state.instanceId)
  const placements = useActivePlacements()
  const values = useCircuit((state) => state.controlValues)
  const modules = placements.flatMap((placement) => {
    const module = moduleCatalog.find((entry) => entry.id === placement.assetId)
    return module?.controls.length ? [{ instanceId: placement.instanceId, module }] : []
  })
  const active = modules.find((entry) => entry.instanceId === selected) ?? modules[0]
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => moduleSelection.setState({ tab: value })}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList variant="line" className="w-full justify-start border-b px-2">
        <TabsTrigger value="wiring">接线</TabsTrigger>
        <TabsTrigger value="controls">模块控件</TabsTrigger>
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
              {modules.map((entry) => (
                <SelectItem key={entry.instanceId} value={entry.instanceId}>
                  {entry.module.name} ({entry.instanceId})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            可在台面操作旋钮和开关，或精确设置数值；上电时仅修改已声明参数，不重接电路。
          </p>
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
    </Tabs>
  )
}
