import type { Instrument } from '@shared/schema/instrument'
import { beforeEach, describe, expect, it } from 'vitest'
import { instrumentDockStore, resolveDockPanels } from './instrument-dock'
import type { PanelDef } from './instrument-panels'

function makePanel(id: string, title: string, kind: Instrument['kind'], mounting: 'fixed' | 'desktop'): PanelDef {
  return {
    id,
    title,
    settings: {},
    instrument: {
      id,
      name: title,
      kind,
      mounting,
      model: `models/${id}.glb`,
      spiceTemplate: '',
      jacks: [],
      ranges: [],
      ...(kind === 'scope'
        ? {
            scope: {
              channels: [
                { id: 'CH1', label: 'CH1', jack: 'CH1' },
                { id: 'CH2', label: 'CH2', jack: 'CH2' },
              ],
              groundJack: 'GND',
              divisions: { x: 10, y: 8 },
              voltsPerDiv: [0.5, 1, 2],
              secondsPerDiv: [0.001, 0.002],
              defaultVoltsPerDiv: 1,
              defaultSecondsPerDiv: 0.001,
              inputR: 1e6,
              inputC: 15e-12,
              samplesPerScreen: 1000,
            },
          }
        : {}),
    } as unknown as Instrument,
  }
}

describe('T1.9B instrumentDockStore & resolveDockPanels', () => {
  beforeEach(() => {
    instrumentDockStore.getState().resetDock()
  })

  const basePanels: PanelDef[] = [
    makePanel('ins-dc-power', '直流稳压电源', 'dcSupply', 'fixed'),
    makePanel('ins-ac-power', '三相调压交流电源', 'acSupply', 'fixed'),
    makePanel('ins-dc-voltmeter', '直流数字电压表', 'dcv', 'fixed'),
    makePanel('ins-dc-ammeter', '直流数字毫安表', 'dca', 'fixed'),
  ]

  it('T1.9B 默认仅激活项目主电源，未接线固定表归入其他固定表下拉', () => {
    const resolved = resolveDockPanels(basePanels, new Set(), instrumentDockStore.getState())
    expect(resolved.activePanels.map((p) => p.id)).toEqual(['ins-dc-power'])
    expect(resolved.inactiveFixedPanels.map((p) => p.id)).toEqual([
      'ins-ac-power',
      'ins-dc-voltmeter',
      'ins-dc-ammeter',
    ])
    expect(resolved.displayedPanels.map((p) => p.id)).toEqual(['ins-dc-power'])
  })

  it('T1.9B 已放置台式表与已接线固定表自动进入活跃集合并按优先级排序', () => {
    const panels = [
      ...basePanels,
      makePanel('generator1', '双通道函数信号发生器', 'funcGen', 'desktop'),
      makePanel('scope1', '双通道数字示波器', 'scope', 'desktop'),
    ]
    const resolved = resolveDockPanels(panels, new Set(['ins-dc-voltmeter']), instrumentDockStore.getState())
    expect(resolved.activePanels.map((p) => p.id)).toEqual(['scope1', 'generator1', 'ins-dc-power', 'ins-dc-voltmeter'])
    expect(resolved.displayedPanels.map((p) => p.id)).toEqual(['scope1'])
  })

  it('T1.9B 支持手动展开固定表并切换单表/双表对比视图', () => {
    instrumentDockStore.getState().selectInstrument('ins-dc-ammeter', { expandFixed: true })
    instrumentDockStore.getState().setLayoutMode('dual')
    const resolved = resolveDockPanels(basePanels, new Set(), instrumentDockStore.getState())
    expect(resolved.activePanels.map((p) => p.id)).toEqual(['ins-dc-power', 'ins-dc-ammeter'])
    expect(resolved.displayedPanels.map((p) => p.id)).toEqual(['ins-dc-ammeter', 'ins-dc-power'])

    // 再切主表时上一台自动退至副表位，最多并排 2 台
    instrumentDockStore.getState().selectInstrument('ins-dc-voltmeter', { expandFixed: true })
    const next = resolveDockPanels(basePanels, new Set(), instrumentDockStore.getState())
    expect(next.displayedPanels.map((p) => p.id)).toEqual(['ins-dc-voltmeter', 'ins-dc-ammeter'])
  })
})
