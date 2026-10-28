import { z } from 'zod'
import { CircuitState } from './circuit.ts'
import { ProjectId } from './project.ts'

export const SAVE_SCHEMA_VERSION = 1

// 技术设计 §9：userData/saves/<projectId>.json
export const SaveFile = z.object({
  schemaVersion: z.literal(SAVE_SCHEMA_VERSION),
  projectId: ProjectId,
  updatedAt: z.iso.datetime(),
  // 不存上电状态，恢复后一律断电
  circuit: CircuitState.omit({ powered: true }),
  completedSteps: z.array(z.string()),
  // 数据表 id → 行 → 列 id → 值，未填为 null
  tables: z.record(z.string(), z.array(z.record(z.string(), z.number().nullable()))),
  answers: z.record(z.string(), z.string()).default({}),
  // 排故过程记录（FLT-05）
  faultLog: z
    .object({
      measurements: z.number().int().nonnegative(),
      wrongGuesses: z.number().int().nonnegative(),
      seconds: z.number().nonnegative(),
    })
    .optional(),
})

export type SaveFile = z.infer<typeof SaveFile>
