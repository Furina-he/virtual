import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dev, include, LIB_DIR, lib, run } from './helpers'

// NE555 DIP-8：1 GND 2 TRIG 3 OUT 4 RESET 5 CTRL 6 THR 7 DIS 8 VCC
function astable(libLine: string, vcc = true) {
  return run([
    libLine,
    vcc ? 'VCC vcc 0 DC 5' : 'Rvcc vcc 0 1G',
    'RA vcc dis 10k',
    'RB dis th 10k',
    'C1 th 0 10n',
    'C5 ctrl 0 10n',
    'X1 0 th out vcc ctrl th dis vcc NE555',
    'RL out 0 10k',
    '.tran 0.1u 3m 0 0.1u',
  ])
}

function risingEdges(t: Float64Array, v: Float64Array, level: number): number[] {
  const out: number[] = []
  for (let i = 1; i < v.length; i++) {
    const v0 = v[i - 1] ?? 0
    const v1 = v[i] ?? 0
    if (v0 < level && v1 >= level) {
      const t0 = t[i - 1] ?? 0
      const t1 = t[i] ?? 0
      out.push(t0 + ((level - v0) / (v1 - v0)) * (t1 - t0))
    }
  }
  return out
}

describe('NE555', () => {
  it('多谐振荡频率与 1.44/((Ra+2Rb)C) 偏差 ≤5%', () => {
    const s = astable(lib('timers.lib'))
    const edges = risingEdges(s.getVector('time'), s.getVector('out'), 1.65).filter((x) => x > 0.5e-3)
    expect(edges.length).toBeGreaterThan(5)
    const period = ((edges.at(-1) ?? 0) - (edges[0] ?? 0)) / (edges.length - 1)
    const f = 1 / period
    const theory = 1.44 / ((10e3 + 2 * 10e3) * 10e-9)
    console.log(`NE555 f=${f.toFixed(1)} Hz 理论 ${theory.toFixed(1)} Hz 偏差 ${(dev(f, theory) * 100).toFixed(2)}%`)
    expect(dev(f, theory)).toBeLessThanOrEqual(0.05)
    const vmax = Math.max(...s.getVector('out'))
    expect(vmax).toBeGreaterThan(3)
  })

  it('VCC 未接时不振荡、输出无高电平', () => {
    const s = astable(lib('timers.lib'), false)
    expect(Math.max(...s.getVector('out'))).toBeLessThan(0.5)
  })

  it('.include 支持含空格与中文的绝对路径', () => {
    const dir = mkdtempSync(join(tmpdir(), '模型 库 '))
    try {
      const file = resolve(dir, '定时器 timers.lib')
      copyFileSync(resolve(LIB_DIR, 'timers.lib'), file)
      const s = astable(include(file))
      expect(Math.max(...s.getVector('out'))).toBeGreaterThan(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
