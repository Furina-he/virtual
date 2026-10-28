import { type CheckInput, circuitPartition, jackLabeler, type WiringIssue, wiredJacks } from './common.ts'

/**
 * 危险接法检测（WIR-06，技术设计 §6 第 4 步），与参考电路无关，上电前与仿真中都要查。
 * 这里只做拓扑可判定的两类；超量程、电解电容反压依赖仿真结果，在仪表逻辑中判定。
 */
export function detectDanger(input: CheckInput): WiringIssue[] {
  const label = jackLabeler(input)
  const wired = wiredJacks(input)
  const issues: WiringIssue[] = []
  const outputs = input.instruments.flatMap(({ instanceId, instrument }) =>
    (instrument.outputs ?? []).map(([p, n]) => ({
      p: `${instanceId}.${p}`,
      n: `${instanceId}.${n}`,
    })),
  )
  const shortedByAmmeter = new Set<string>()

  // 电流表两端直接跨在电源输出两端
  for (const { instanceId, instrument } of input.instruments)
    instrument.measure?.series.forEach(([a, b], pair) => {
      const ra = `${instanceId}.${a}`
      const rb = `${instanceId}.${b}`
      if (!wired.has(ra) || !wired.has(rb)) return
      const uf = circuitPartition(input, { instanceId, pair })
      for (const out of outputs) {
        const across =
          (uf.find(ra) === uf.find(out.p) && uf.find(rb) === uf.find(out.n)) ||
          (uf.find(ra) === uf.find(out.n) && uf.find(rb) === uf.find(out.p))
        if (!across) continue
        shortedByAmmeter.add(out.p)
        issues.push({
          severity: 'error',
          code: 'ammeter-across-source',
          message: `${instrument.name}并联在电源两端（${label(out.p)} 与 ${label(out.n)}），熔断器已断开。断电后把电流表串入被测支路，再更换熔断器。`,
          jacks: [ra, rb, out.p, out.n],
        })
      }
    })

  // 电源输出被导线直接短接（经电流表短接的已在上面报过）
  const full = circuitPartition(input)
  for (const out of outputs) {
    if (shortedByAmmeter.has(out.p) || full.find(out.p) !== full.find(out.n)) continue
    issues.push({
      severity: 'error',
      code: 'source-short',
      message: `${label(out.p)} 与 ${label(out.n)} 被导线直接短接，电源过流保护已动作。断电后拆除短接的导线。`,
      jacks: [out.p, out.n],
    })
  }
  return issues
}
