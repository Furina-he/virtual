import type { Module, ModuleControl } from '../../shared/schema/module.ts'

export type ModuleParameter = {
  controlRef: string
  param: string
  value: number
  targets?: { element: string; value: number }[]
}

export function moduleParameterName(instanceId: string, param: string): string {
  return `p_${instanceId.replace(/[^A-Za-z0-9_]/g, '_')}_${param}`
}

export function moduleControlValid(control: ModuleControl, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (control.steps && !control.steps.includes(value)) return false
  if (control.range) {
    const [min, max] = control.range
    if (value < min || value > max) return false
    if (control.step) {
      const index = (value - min) / control.step
      if (Math.abs(index - Math.round(index)) > 1e-8) return false
    }
  }
  return true
}

export function moduleParameters(
  modules: readonly { instanceId: string; module: Module }[],
  values: Readonly<Record<string, number>>,
): ModuleParameter[] {
  const seen = new Set<string>()
  return modules.flatMap(({ instanceId, module }) =>
    module.controls.map((control) => {
      const controlRef = `${instanceId}.${control.id}`
      const value = values[controlRef] ?? control.default
      if (!moduleControlValid(control, value))
        throw new Error(`${module.name}的控件 ${control.label ?? control.id} 设置无效。`)
      const param = moduleParameterName(instanceId, control.param)
      if (seen.has(param.toLowerCase())) throw new Error(`模块参数映射重复：${param}。`)
      seen.add(param.toLowerCase())
      const targets = control.targets?.map((target) => {
        const resistance = target.values
          ? target.values[control.steps?.indexOf(value) ?? -1]
          : target.min === undefined
            ? value * (target.scale ?? 1) + (target.offset ?? 0)
            : Math.max(target.min, value * (target.scale ?? 1) + (target.offset ?? 0))
        if (typeof resistance !== 'number' || !Number.isFinite(resistance) || resistance <= 0)
          throw new Error(`${module.name}的控件 ${control.label ?? control.id} 电阻目标无效。`)
        return {
          element: `r.x${instanceId.replace(/[^A-Za-z0-9_]/g, '_')}.${target.element.toLowerCase()}`,
          value: resistance,
        }
      })
      return { controlRef, param, value, ...(targets ? { targets } : {}) }
    }),
  )
}
