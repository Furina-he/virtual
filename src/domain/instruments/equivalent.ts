import { isCurrentMode, isSelfPoweredMode, type ResolvedInstrument } from './config.ts'

export type InstrumentProbe = {
  positiveNode: string
  negativeNode: string
  currentVector?: string
}

/** Templates retain the assembler's existing {J:...}/{X} contract. */
export function instrumentTemplate(config: ResolvedInstrument): string {
  const p = `{J:${config.positiveJack}}`
  const n = `{J:${config.negativeJack}}`
  if (config.mode === 'power' && config.wattmeter) {
    const ip = `{J:${config.wattmeter.currentPositiveJack}}`
    const ineg = `{J:${config.wattmeter.currentNegativeJack}}`
    if (config.passive) return `Rpassive_v_{X} ${p} ${n} 1T\nRpassive_i_{X} ${ip} ${ineg} 1T`
    return [
      `Rvol_{X} ${p} ${n} ${config.internalR}`,
      `Rsh_{X} ${ip} m_{X} ${config.wattmeter.currentR}`,
      `Vsense_{X} m_{X} ${ineg} DC 0`,
    ].join('\n')
  }
  if (config.passive) return `Rpassive_{X} ${p} ${n} 1T`
  if (isCurrentMode(config.mode)) return `Rsh_{X} ${p} m_{X} ${config.internalR}\nVsense_{X} m_{X} ${n} DC 0`
  if (isSelfPoweredMode(config.mode) && config.testSource) {
    const { voltage, current } = config.testSource
    // The source cannot sink external current. Its injected current is bounded,
    // and it switches off at the compliance voltage even for an open circuit.
    return [
      `Btest_{X} ${n} mt_{X} I=max(0,min(${current},(${voltage}-v(${p},${n}))/${voltage / current}))`,
      `Vtest_sense_{X} mt_{X} ${p} DC 0`,
      `Rin_{X} ${p} ${n} ${config.internalR}`,
    ].join('\n')
  }
  if (config.instrument.inputChannels?.length) {
    const lines: string[] = []
    for (const channel of config.instrument.inputChannels) {
      const cp = `{J:${channel.positiveJack}}`
      const cn = `{J:${channel.negativeJack}}`
      const id = channel.id.toLowerCase()
      lines.push(`Rin_${id}_{X} ${cp} ${cn} ${config.internalR}`)
      if (config.inputC) lines.push(`Cin_${id}_{X} ${cp} ${cn} ${config.inputC}`)
    }
    return lines.join('\n')
  }
  return config.inputC
    ? `Rin_{X} ${p} ${n} ${config.internalR}\nCin_{X} ${p} ${n} ${config.inputC}`
    : `Rin_{X} ${p} ${n} ${config.internalR}`
}

export function instrumentProbe(
  config: ResolvedInstrument,
  instanceId: string,
  nodeOf: Record<string, string>,
): InstrumentProbe {
  const safe = instanceId.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()
  const positiveNode = nodeOf[`${instanceId}.${config.positiveJack}`]
  const negativeNode = nodeOf[`${instanceId}.${config.negativeJack}`]
  if (positiveNode === undefined || negativeNode === undefined) throw new Error(`仪表 ${instanceId} 的测量节点不存在。`)
  return {
    positiveNode,
    negativeNode,
    ...(!config.passive && (isCurrentMode(config.mode) || isSelfPoweredMode(config.mode) || config.mode === 'power')
      ? { currentVector: `${isSelfPoweredMode(config.mode) ? 'vtest_sense' : 'vsense'}_${safe}#branch` }
      : {}),
  }
}
