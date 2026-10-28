import { z } from 'zod'
import { ContentId, InstanceId, JackRef } from './common.ts'

// 导线颜色按电气惯例（PRD 15.2）
export const WireColor = z.enum(['red', 'black', 'yellow', 'green', 'blue', 'lightBlue', 'yellowGreen', 'white'])

export const Wire = z
  .object({
    id: z.string().min(1),
    a: JackRef,
    b: JackRef,
    color: WireColor,
    label: z.string().optional(),
    // Visual midpoint sag below the endpoint chord, in meters (not extra cable length).
    slack: z.number().min(0.02).max(0.4).optional(),
  })
  .refine((w) => w.a !== w.b, { message: '导线两端不能是同一插孔', path: ['b'] })

export const PlacedInstrument = z.object({
  instanceId: InstanceId,
  instrumentId: ContentId,
  slot: z.string().regex(/^SLOT_[A-Z0-9_]+$/),
  settings: z.record(z.string(), z.unknown()),
})

// 技术设计 §3.4。只有 wires、placedInstruments、controlValues 进入撤销栈
export const CircuitState = z.object({
  placedInstruments: z.array(PlacedInstrument),
  wires: z.array(Wire),
  controlValues: z.record(z.string(), z.number()),
  powered: z.boolean(),
  activeFault: z.string().optional(),
})

export type WireColor = z.infer<typeof WireColor>
export type Wire = z.infer<typeof Wire>
export type CircuitState = z.infer<typeof CircuitState>
