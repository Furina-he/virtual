import { z } from 'zod'

// PRD 15.3 设置页：画质档、主题、字号、默认引导模式、数据目录
export const Settings = z.object({
  quality: z.enum(['high', 'medium', 'low']).default('medium'),
  theme: z.enum(['light', 'dark']).default('light'),
  // 演示模式字号放大 1.25 倍（PRD 15.2）
  fontScale: z.union([z.literal(1), z.literal(1.25)]).default(1),
  guideMode: z.enum(['guided', 'free']).default('guided'),
  dataDir: z.string().min(1).optional(),
})

export type Settings = z.infer<typeof Settings>
