import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import { Module } from '../../src/shared/schema/module.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'

const library = readFileSync('content/models/spice/opamp.lib', 'utf8')
const module = Module.parse(JSON.parse(readFileSync('content/modules/mod-voltage-follower/module.json', 'utf8')))
const board = expandLocalLibraries(readFileSync('content/modules/mod-voltage-follower/module.cir', 'utf8'), {
  'opamp.lib': library,
})
const ng = NgSpice.open(resolve(import.meta.dirname, '../../resources/ngspice'))
const solve = (lines: string[]) => {
  ng.load(['Approved 5V high-input follower estimate', board, ...lines, '.end'].join('\n'))
  ng.run()
  return ng
}
const op = (supply: number, input: number, extra: string[] = []) => {
  solve([`VS vcc 0 ${supply}`, `VIN in 0 ${input}`, 'XAD vcc 0 in out mod_voltage_follower', ...extra, '.op'])
  return { out: ng.getVector('out')[0] as number, inputCurrent: ng.getVector('vin#branch')[0] as number }
}

describe('approved independently modelled TLV9001 follower adapter', () => {
  it('preserves a separately named part estimate, four jacks and internal feedback/100n decoupling', () => {
    expect(module.jacks.map((jack) => jack.id)).toEqual(['VCC', 'GND', 'IN', 'OUT'])
    expect(module.controls).toEqual([])
    expect(board).toContain('XBUF OUT GND IN OUT VCC TLV9001_EST')
    expect(board).toContain('Cdecouple VCC GND 100n')
    expect(library).toContain('.subckt UA741 1 2 3 4 5 6 7 8')
    expect(library).toContain('NOT a TI SPICE model')
    expect(board).not.toContain('.include')
  })

  it('follows the approved timer voltage range with high input impedance and no permanent unpowered gain', () => {
    for (const voltage of [0.1, 5 / 3, 2.5, 10 / 3]) {
      const actual = op(5, voltage)
      expect(Math.abs(actual.out - voltage)).toBeLessThan(0.002)
      expect(Math.abs(actual.inputCurrent)).toBeLessThan(20e-12)
    }
    expect(Math.abs(op(0, 2.5).out)).toBeLessThan(1e-6)
    expect(Math.abs(op(1, 2.5).out)).toBeLessThan(1e-6)
  })

  it('supports the real CV equivalent source without modifying that source or its 3.333k input resistance', () => {
    for (const input of [0, 5 / 3, 10 / 3]) {
      const actual = op(5, input, ['VCV bias 0 3.333333333333', 'Rcv out bias 13.333333333333k'])
      // Near the negative rail, the finite sink stage adds 20mV*atanh(I/1mA), not ideal rail tracking.
      let expectedOutput = input
      if (input === 0) {
        let lo = 0.02
        let hi = 0.05
        for (let i = 0; i < 60; i++) {
          const value = (lo + hi) / 2
          const sink = (10 / 3 - value) / (40000 / 3)
          if (value > 0.02 + 0.02 * Math.atanh(sink / 0.001)) hi = value
          else lo = value
        }
        expectedOutput = (lo + hi) / 2
      }
      expect(Math.abs(actual.out - expectedOutput)).toBeLessThan(0.002)
      expect(Math.abs((actual.out - 10 / 3) / (40000 / 3))).toBeLessThan(0.251e-3)
    }
    expect(Math.abs(op(5, 2.5, ['ILOAD out 0 250u']).out - 2.5)).toBeLessThan(0.002)
    expect(Math.abs(op(5, 2.5, ['ILOAD 0 out 250u']).out - 2.5)).toBeLessThan(0.002)
    expect(op(5, 6).out).toBeLessThanOrEqual(4.9801)
    expect(op(5, -1).out).toBeGreaterThanOrEqual(0.0199)
  })

  it('has finite bandwidth and supplies only its conservative bounded output current', () => {
    solve([
      'VS vcc 0 5',
      'VIN in 0 SIN(2.5 0.2 1000)',
      'XAD vcc 0 in out mod_voltage_follower',
      '.tran 20n 0.002 0.001 20n',
    ])
    const input = ng.getVector('in')
    const output = ng.getVector('out')
    let error = 0
    for (let i = 0; i < input.length; i++)
      error = Math.max(error, Math.abs((input[i] as number) - (output[i] as number)))
    expect(error).toBeLessThan(0.002)

    solve([
      'VS vcc 0 5',
      'VIN in 0 SIN(2.5 0.05 2000000)',
      'XAD vcc 0 in out mod_voltage_follower',
      '.tran 5n 0.00005 0.00004 5n',
    ])
    const fast = ng.getVector('out')
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const value of fast) {
      lo = Math.min(lo, value)
      hi = Math.max(hi, value)
    }
    expect(hi - lo).toBeLessThan(0.07)
    expect(hi - lo).toBeGreaterThan(0.02)
    const loaded = op(5, 2.5, ['RL out 0 8'])
    expect(loaded.out / 8).toBeLessThanOrEqual(0.00101)
    expect(loaded.out).toBeLessThan(0.02)
  })

  it('isolates a slow RC oscillator from the unchanged CV divider and preserves genuine gradual control voltage', () => {
    const timers = readFileSync('content/models/spice/timers.lib', 'utf8')
    const lines = [
      'VS vcc 0 5',
      'RA vcc dis 10k',
      'RB dis th 150k',
      'CT th 0 4.7u',
      'CC ctrl 0 10n',
      'XT 0 th lf vcc ctrl th dis vcc NE555',
      'XAD vcc 0 th buffered mod_voltage_follower',
      'R5 buffered cv 10k',
      'Rdiv1 vcc cv 5k',
      'Rdiv2 cv mid 5k',
      'Rdiv3 mid 0 5k',
      'CVB cv 0 10n',
      '.save v(th) v(lf) v(cv)',
      '.tran 2u 3.6 0 2u',
    ]
    ng.load(['Approved buffer RC isolation proof', board, timers, ...lines, '.end'].join('\n'))
    ng.command('esave none')
    ng.run()
    const time = ng.getVector('time')
    const lf = ng.getVector('lf')
    const th = ng.getVector('th')
    const cv = ng.getVector('cv')
    const rises: number[] = []
    let capMin = Number.POSITIVE_INFINITY
    let capMax = Number.NEGATIVE_INFINITY
    let cvMin = Number.POSITIVE_INFINITY
    let cvMax = Number.NEGATIVE_INFINITY
    for (let i = 1; i < time.length; i++) {
      if ((time[i] as number) > 0.5 && (lf[i - 1] as number) < 1.65 && (lf[i] as number) >= 1.65) {
        const fraction = (1.65 - (lf[i - 1] as number)) / ((lf[i] as number) - (lf[i - 1] as number))
        rises.push((time[i - 1] as number) + fraction * ((time[i] as number) - (time[i - 1] as number)))
      }
      if ((time[i] as number) < 1.4) continue
      capMin = Math.min(capMin, th[i] as number)
      capMax = Math.max(capMax, th[i] as number)
      cvMin = Math.min(cvMin, cv[i] as number)
      cvMax = Math.max(cvMax, cv[i] as number)
    }
    expect(rises.length).toBeGreaterThanOrEqual(3)
    const period = ((rises.at(-1) as number) - (rises[0] as number)) / (rises.length - 1)
    const expected = Math.LN2 * (10000 + 2 * 150000) * 4.7e-6
    expect(Math.abs(period / expected - 1)).toBeLessThan(0.01)
    expect(capMin).toBeLessThan(1.7)
    expect(capMax).toBeGreaterThan(3.3)
    expect(cvMin).toBeGreaterThan(2.89)
    expect(cvMin).toBeLessThan(2.94)
    expect(cvMax).toBeGreaterThan(3.3)
    expect(cvMax).toBeLessThan(3.35)
    console.log(
      `Approved RC isolation: period=${period}s, C=${capMin}..${capMax}V, CV=${cvMin}..${cvMax}V; original CV divider unchanged`,
    )
  }, 30_000)
})
