import type { WireColor } from '@shared/schema/circuit'

export const wireColors: { value: WireColor; label: string }[] = [
  { value: 'red', label: '红色' },
  { value: 'black', label: '黑色' },
  { value: 'yellow', label: '黄色' },
  { value: 'green', label: '绿色' },
  { value: 'blue', label: '蓝色' },
  { value: 'lightBlue', label: '淡蓝色（N）' },
  { value: 'yellowGreen', label: '黄绿双色（PE）' },
  { value: 'white', label: '白色' },
]

/** Cord sag in metres. */
export const wireSlacks = [0.02, 0.06, 0.12, 0.2, 0.3, 0.4] as const
export const defaultWireSlack = 0.12
