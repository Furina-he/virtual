import { Settings } from '@shared/schema/settings'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Quality = Settings['quality']

interface QualityPreset {
  id: Quality
  label: string
  textureSize: number
  shadows: number
  dpr: [number, number]
}
const mediumPreset: QualityPreset = { id: 'medium', label: '中', textureSize: 1536, shadows: 512, dpr: [1, 1.5] }
export const qualityOptions: QualityPreset[] = [
  { id: 'high', label: '高', textureSize: 2048, shadows: 1024, dpr: [1, 2] },
  mediumPreset,
  { id: 'low', label: '低', textureSize: 1024, shadows: 0, dpr: [1, 1] },
]

interface QualityState {
  quality: Quality
  setQuality: (quality: Quality) => void
}

export const useQuality = create<QualityState>()(
  persist((set) => ({ quality: 'medium', setQuality: (quality) => set({ quality }) }), {
    name: 'virtual-ee-lab:quality',
    partialize: ({ quality }) => ({ quality }),
    merge: (stored, current) => {
      const result = Settings.pick({ quality: true }).safeParse(stored)
      return { ...current, quality: result.success ? result.data.quality : 'medium' }
    },
  }),
)

export function qualityPreset(quality: Quality) {
  return qualityOptions.find((item) => item.id === quality) ?? mediumPreset
}
