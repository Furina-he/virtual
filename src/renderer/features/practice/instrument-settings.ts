import type { InstrumentInput } from '../../../domain/circuit/assemble'
import { getInstrumentDefaults } from '../../../domain/instruments'
import type { CircuitState } from '../../../shared/schema/circuit'
import { instrumentCatalog } from './practice-content'
import { circuitStore, wiringScene } from './wiring-state'

export function benchInstruments(state: CircuitState = circuitStore.getState()): InstrumentInput[] {
  const fixed = wiringScene.placements.flatMap(({ assetId, instanceId }) => {
    const instrument = instrumentCatalog.find((entry) => entry.id === assetId && entry.mounting === 'fixed')
    if (!instrument) return []
    const settings: Record<string, unknown> = { ...getInstrumentDefaults(instrument) }
    for (const [key, value] of Object.entries(state.controlValues)) {
      if (!key.startsWith(`${instanceId}.`)) continue
      const setting = key.slice(instanceId.length + 1)
      settings[setting] = setting === 'range' ? instrument.ranges[value]?.id : value
    }
    return [{ instanceId, instrument, settings }]
  })
  const desktop = state.placedInstruments.map(({ instanceId, instrumentId, settings }) => {
    const instrument = instrumentCatalog.find((entry) => entry.id === instrumentId)
    if (!instrument) throw new Error(`Missing instrument configuration: ${instrumentId}`)
    return { instanceId, instrument, settings: { ...getInstrumentDefaults(instrument), ...settings } }
  })
  return [...fixed, ...desktop]
}

export function setBenchInstrumentSettings(instanceId: string, patch: Record<string, unknown>): void {
  const state = circuitStore.getState()
  const entry = benchInstruments(state).find((item) => item.instanceId === instanceId)
  if (!entry) return
  const { instrument } = entry
  for (const [key, value] of Object.entries(patch)) {
    const control = instrument.settingsControls?.find((item) => item.id === key)
    const valid =
      key === 'range'
        ? instrument.ranges.some((range) => range.id === value)
        : typeof value === 'number' && Number.isFinite(value)
          ? key === 'internalR'
            ? instrument.internalROptions?.includes(value)
            : key === 'accuracyOffset'
              ? Math.abs(value) <= 1
              : control && value >= control.min && value <= control.max
          : false
    if (!valid) {
      circuitStore.setState({ notice: '仪表设置无效，请选择标注的档位或参数范围。' })
      return
    }
  }
  if (instrument.mounting === 'desktop') {
    state.setInstrumentSettings(instanceId, patch)
  } else {
    state.setControlValues(
      Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [
          `${instanceId}.${key}`,
          key === 'range' ? instrument.ranges.findIndex((range) => range.id === value) : (value as number),
        ]),
      ),
    )
  }
}
