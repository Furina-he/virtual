import { z } from 'zod'
import { ContentId, InstanceId, uniqueBy } from './common.ts'

export const ScenePosition = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])

// Content-owned placement fixture until project loading and the instrument cabinet are connected.
export const BenchScene = z.object({
  id: ContentId,
  schemaVersion: z.literal(1),
  camera: z.object({ position: ScenePosition, target: ScenePosition }),
  workSurface: z
    .object({ min: ScenePosition, max: ScenePosition })
    .refine(
      ({ min, max }) => min[0] < max[0] && min[2] < max[2] && min[1] === max[1],
      'Work surface must have increasing X/Z bounds and a shared Y height',
    )
    .optional(),
  placements: z
    .array(
      z.object({
        assetId: ContentId,
        instanceId: InstanceId,
        position: ScenePosition,
        rotation: ScenePosition.optional(),
        slot: z
          .string()
          .regex(/^SLOT_[A-Z0-9_]+$/)
          .optional(),
      }),
    )
    .min(1)
    .superRefine(uniqueBy('instanceId')),
})

export type BenchScene = z.infer<typeof BenchScene>
