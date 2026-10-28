// PRD 15.2：数值与单位之间空一格，位数跟随分辨率
export function formatReading(value: number, unit: string, decimals: number): string {
  return `${value.toFixed(decimals)} ${unit}`
}
