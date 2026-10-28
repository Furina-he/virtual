export function clampKnobValue(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0 || max < min) return min
  const snapped = min + Math.round((value - min) / step) * step
  return Number(Math.min(max, Math.max(min, snapped)).toPrecision(12))
}

export function knobAngle(value: number, min: number, max: number): number {
  if (max <= min || !Number.isFinite(value)) return -135
  return -135 + Math.min(1, Math.max(0, (value - min) / (max - min))) * 270
}
