import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildBidirectionalJackMap,
  extractSchematicJackLinks,
  findMatchingSchematicLinks,
  resolveJackRefFromElement,
  resolveSchematicJackClick,
} from './schematic-link'

describe('T1.8 TSK-02 原理图插孔标识解析与双向高亮映射', () => {
  const dcJacks = ['dc1.KH_I1A', 'dc1.KH_I1B', 'dc1.KH_U1P', 'dc1.KH_U1N', 'dc1.KH_F', 'dc1.KH_A', 'ins-dc-power.CH1P']

  it('TSK-02 支持 data-jack、data-jack-id 与 JACK_* id 三种原理图插孔声明格式', () => {
    const svg = `
      <svg viewBox="0 0 200 100">
        <circle id="JACK_KH_I1A" data-jack="dc1.KH_I1A" cx="20" cy="20" r="4"/>
        <g data-jack-id="KH_U1P"><circle cx="50" cy="20" r="4"/></g>
        <circle id="JACK_KH_F" cx="80" cy="20" r="4"/>
        <circle id="JACK_UNKNOWN" cx="110" cy="20" r="4"/>
      </svg>
    `
    const links = extractSchematicJackLinks(svg, dcJacks)
    expect(links.map((item) => [item.attrName, item.attrValue, item.jackRef])).toEqual([
      ['data-jack', 'dc1.KH_I1A', 'dc1.KH_I1A'],
      ['data-jack-id', 'KH_U1P', 'dc1.KH_U1P'],
      ['id', 'JACK_KH_F', 'dc1.KH_F'],
    ])

    const map = buildBidirectionalJackMap(links)
    expect(map.toJackRef.get('data-jack=dc1.KH_I1A')).toBe('dc1.KH_I1A')
    expect(map.toJackRef.get('data-jack-id=KH_U1P')).toBe('dc1.KH_U1P')
    expect(map.toSchematicKeys.get('dc1.KH_F')).toEqual(['id=JACK_KH_F'])
    expect(findMatchingSchematicLinks('dc1.KH_U1P', links)).toHaveLength(1)
    expect(findMatchingSchematicLinks('dc1.NON_EXISTENT', links)).toEqual([])
  })

  it('TSK-02 歧义短插孔名不误匹配，显式 data-jack 优先精确匹配', () => {
    const multiBoardJacks = ['board1.VCC', 'board2.VCC', 'board1.OUT']
    expect(resolveJackRefFromElement({ dataJackId: 'VCC' }, multiBoardJacks)).toBeNull()
    expect(resolveJackRefFromElement({ dataJack: 'board2.VCC', dataJackId: 'VCC' }, multiBoardJacks)?.jackRef).toBe(
      'board2.VCC',
    )
    expect(resolveJackRefFromElement({ dataJackId: 'OUT' }, multiBoardJacks)?.jackRef).toBe('board1.OUT')
  })

  it('TSK-02 真实 DG-05、MD-07、SD-22 原理图 SVG 插孔全部正确映射到台面全局 JackRef', () => {
    const dg05Svg = readFileSync(resolve('content/projects/DG-05/schematic.svg'), 'utf8')
    const dg05Jacks = [
      'dc1.KH_I1A',
      'dc1.KH_I1B',
      'dc1.KH_I2A',
      'dc1.KH_I2B',
      'dc1.KH_I3A',
      'dc1.KH_I3B',
      'dc1.KH_U1P',
      'dc1.KH_U1N',
      'dc1.KH_U2P',
      'dc1.KH_U2N',
      'dc1.KH_F',
      'dc1.KH_A',
      'dc1.KH_B',
      'dc1.KH_E',
      'dc1.KH_D',
      'dc1.KH_C',
    ]
    const dg05Links = extractSchematicJackLinks(dg05Svg, dg05Jacks)
    expect(dg05Links.map((item) => item.jackRef)).toEqual(dg05Jacks)

    const md07Svg = readFileSync(resolve('content/projects/MD-07/schematic.svg'), 'utf8')
    const ampJacks = [
      'amp1.AMP_US',
      'amp1.AMP_UI',
      'amp1.AMP_UB',
      'amp1.AMP_UC',
      'amp1.AMP_UE',
      'amp1.AMP_UO',
      'amp1.AMP_RL',
      'amp1.AMP_VCC',
      'amp1.AMP_GND2',
      'amp1.AMP_GND1',
    ]
    const md07Links = extractSchematicJackLinks(md07Svg, ampJacks)
    expect(md07Links.map((item) => item.jackRef)).toEqual(ampJacks)

    const sd22Svg = readFileSync(resolve('content/projects/SD-22/schematic.svg'), 'utf8')
    const sd22SampleJacks = ['timer1.VCC1', 'timer1.GND1', 'timer1.T1_TH', 'timer1.T2_CV', 'timer1.SPK_P']
    const sd22Links = extractSchematicJackLinks(sd22Svg, sd22SampleJacks)
    expect(sd22Links.map((item) => item.jackRef)).toEqual(expect.arrayContaining(sd22SampleJacks))
  })

  it('T1.9B 原理图两点直连契约：首点设起点、次点直连、复点同孔取消', () => {
    expect(resolveSchematicJackClick(null, 'dc1.KH_U1P')).toEqual({ action: 'start', source: 'dc1.KH_U1P' })
    expect(resolveSchematicJackClick('dc1.KH_U1P', 'dc1.KH_I1A')).toEqual({
      action: 'complete',
      source: 'dc1.KH_U1P',
      target: 'dc1.KH_I1A',
    })
    expect(resolveSchematicJackClick('dc1.KH_U1P', 'dc1.KH_U1P')).toEqual({ action: 'cancel', source: 'dc1.KH_U1P' })
  })
})
