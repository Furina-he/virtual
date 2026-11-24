export function clampKnobValue(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0 || max < min) return min
  const snapped = min + Math.round((value - min) / step) * step
  return Number(Math.min(max, Math.max(min, snapped)).toPrecision(12))
}

export function stepKnobValue(
  value: number,
  min: number,
  max: number,
  step: number,
  deltaSteps: number,
  coarse = false,
): number {
  const factor = coarse ? 5 : 1
  return clampKnobValue(value + deltaSteps * step * factor, min, max, step)
}

export function knobAngle(value: number, min: number, max: number): number {
  if (max <= min || !Number.isFinite(value)) return -135
  return -135 + Math.min(1, Math.max(0, (value - min) / (max - min))) * 270
}

function cleanNumber(value: number, precision = 4): string {
  return String(Number(value.toPrecision(precision)))
}

/** 工程单位格式化（T1.9A/T1.9B）：将基础 SI 单位的 Ω / Hz / s / A / V / W / VA / var 转为易读工程前缀。 */
export function formatEngineeringValue(value: number, unit = ''): string {
  if (!Number.isFinite(value)) return unit ? `— ${unit}` : '—'
  const abs = Math.abs(value)
  const trimmed = unit.trim()
  if (trimmed === 'Ω') {
    if (abs >= 1e6) return `${cleanNumber(value / 1e6)} MΩ`
    if (abs >= 1e3) return `${cleanNumber(value / 1e3)} kΩ`
    return `${cleanNumber(value)} Ω`
  }
  if (trimmed === 'Hz') {
    if (abs >= 1e6) return `${cleanNumber(value / 1e6)} MHz`
    if (abs >= 1e3) return `${cleanNumber(value / 1e3)} kHz`
    return `${cleanNumber(value)} Hz`
  }
  if (trimmed === 's') {
    if (abs > 0 && abs < 1e-6) return `${cleanNumber(value * 1e9)} ns`
    if (abs > 0 && abs < 1e-3) return `${cleanNumber(value * 1e6)} µs`
    if (abs > 0 && abs < 1) return `${cleanNumber(value * 1e3)} ms`
    return `${cleanNumber(value)} s`
  }
  if (trimmed === 'A') {
    if (abs > 0 && abs < 1e-3) return `${cleanNumber(value * 1e6)} µA`
    if (abs > 0 && abs < 1) return `${cleanNumber(value * 1e3)} mA`
    return `${cleanNumber(value)} A`
  }
  if (trimmed === 'V') {
    if (abs > 0 && abs < 1) return `${cleanNumber(value * 1e3)} mV`
    return `${cleanNumber(value)} V`
  }
  if (trimmed === 'W' || trimmed === 'VA' || trimmed === 'var') {
    if (abs >= 1e3) return `${cleanNumber(value / 1e3)} k${trimmed}`
    if (abs > 0 && abs < 1) return `${cleanNumber(value * 1e3)} m${trimmed}`
    return `${cleanNumber(value)} ${trimmed}`
  }
  return trimmed ? `${cleanNumber(value, 6)} ${trimmed}` : cleanNumber(value, 6)
}
