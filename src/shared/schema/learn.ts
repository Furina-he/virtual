import { z } from 'zod'
import { ContentId } from './common.ts'

export const LearnCategory = z.enum(['concept', 'theory', 'component', 'ic', 'instrument-tool'])
export type LearnCategory = z.infer<typeof LearnCategory>

export const LearnSections = z.object({
  structure: z.string().min(1),
  symbol: z.string().min(1),
  parameters: z.string().min(1),
  troubleshooting: z.string().min(1),
})

export const LearnResource = z.object({
  id: ContentId,
  category: LearnCategory,
  subcategory: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1),
  summary: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  model: z.string().min(1).optional(),
  relatedInstruments: z.array(ContentId).default([]),
  relatedModules: z.array(ContentId).default([]),
  specs: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).default([]),
  sections: LearnSections,
})

export type LearnResource = z.infer<typeof LearnResource>
