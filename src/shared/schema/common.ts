import { z } from 'zod'

// 模块、仪表 ID：小写字母开头，小写字母/数字/连字符，如 mod-dc-circuit、ins-dc-voltmeter
export const ContentId = z.string().regex(/^[a-z][a-z0-9-]*$/, '只能用小写字母、数字、连字符，且以字母开头')
// 模块/仪表实例 ID，规则同上，如 dc1
export const InstanceId = ContentId
// 插孔 ID 兼作 .subckt 端口名与 GLB 锚点 JACK_<id>（PRD 16.5）
export const JackId = z.string().regex(/^[A-Z][A-Z0-9_]*$/, '只能用大写字母、数字、下划线，且以字母开头')
// 全局插孔引用 <实例ID>.<插孔ID>（ADR-008）
export const JackRef = z.string().regex(/^[a-z][a-z0-9-]*\.[A-Z][A-Z0-9_]*$/, '格式应为 <实例ID>.<插孔ID>')
export const ParamName = z.string().regex(/^[a-z_][a-z0-9_]*$/i, '网表参数名只能用字母、数字、下划线')

export const Jack = z.object({
  id: JackId,
  label: z.string(),
  kind: z.enum(['banana4', 'pin', 'bnc']),
  polarityHint: z.enum(['+', '-']).optional(),
})

/** 检查数组里 key 不重复，重复时报到对应元素的字段上 */
export function uniqueBy<T>(key: keyof T & string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<unknown>()
    items.forEach((item, i) => {
      const v = item[key]
      if (seen.has(v)) ctx.addIssue({ code: 'custom', message: `${key} 重复：${String(v)}`, path: [i, key] })
      seen.add(v)
    })
  }
}

export type Jack = z.infer<typeof Jack>
