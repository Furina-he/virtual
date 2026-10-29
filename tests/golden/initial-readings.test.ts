import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { NgSpice } from '../../src/sim/ngspice.ts'
import { SimSession } from '../../src/sim/session.ts'

const dir = resolve(import.meta.dirname, '../../resources/ngspice')
const ng = NgSpice.open(dir)
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
const step = 1e-7

async function observeInitialReadings(sourceVoltage: number) {
  let samples = 0
  let lastSampleEnd: number | undefined
  let firstChunkWallMs: number | undefined
  let validReading = false
  const started = performance.now()
  const errors: string[] = []
  const snapshots: { simTime: number; sampleEnd?: number; supply: number; output: number }[] = []
  let session: SimSession
  session = new SimSession(
    dir,
    (event) => {
      if (event.type === 'error') errors.push(event.message)
      if (event.type === 'loaded') lastSampleEnd = undefined
      if (event.type === 'chunk') {
        const count = event.data.supply?.length ?? 0
        if (count) {
          samples += count
          lastSampleEnd = event.t0 + (count - 1) * event.dt
          firstChunkWallMs ??= performance.now() - started
        }
      }
      if (event.type !== 'readings') return
      snapshots.push({
        simTime: event.simTime,
        sampleEnd: lastSampleEnd,
        supply: event.values.supply as number,
        output: event.values.output as number,
      })
      if (lastSampleEnd !== undefined && event.simTime > 0) {
        validReading = true
        session.handle({ type: 'pause' })
      }
    },
    () => errors.push('Native simulation process exited'),
  )
  session.handle({
    type: 'load',
    requestId: `initial-${sourceVoltage}`,
    netlist: `Actual RC first-reading boundary\nVS supply 0 DC ${sourceVoltage}\nR1 supply output 1k\nC1 output 0 10u\nR2 output 0 1k\n.end`,
    probes: [
      { id: 'supply', kind: 'v', node: 'supply' },
      { id: 'output', kind: 'v', node: 'output' },
    ],
    analysis: { kind: 'tran', step, continuous: true },
  })
  session.handle({ type: 'setPacing', mode: 'realtime' })
  session.handle({ type: 'run' })
  try {
    const deadline = performance.now() + 4400
    while ((!validReading || ng.running()) && performance.now() < deadline && !errors.length) await wait(10)
    session.handle({ type: 'pause' })
    // Finish queued native callbacks before the next test replaces this process-wide session.
    await wait(20)
    const report = {
      sourceVoltage,
      step,
      samples,
      trims: session.trims,
      firstChunkWallMs,
      wallMs: performance.now() - started,
      snapshots,
      errors,
    }
    const build = resolve(import.meta.dirname, '../../build')
    mkdirSync(build, { recursive: true })
    const path = resolve(
      build,
      `initial-readings-${sourceVoltage}V-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`,
    )
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Actual first-reading boundary: ${path}; ${JSON.stringify(report)}`)
    return report
  } finally {
    session.dispose()
  }
}

describe('initial periodic readings follow real ngspice samples', () => {
  it.each([5, 0])('%s V source never reports an initialized value before its first actual sample', async (voltage) => {
    const result = await observeInitialReadings(voltage)
    expect(result.errors).toEqual([])
    expect(result.samples).toBeGreaterThan(0)
    expect(result.trims).toBeGreaterThan(0)
    expect(result.snapshots.length).toBeGreaterThan(0)
    for (const reading of result.snapshots) {
      expect(reading.sampleEnd, 'A current periodic reading must have prior actual sample evidence').toBeDefined()
      expect(reading.simTime).toBeGreaterThan(0)
      expect(reading.simTime).toBeGreaterThanOrEqual(reading.sampleEnd as number)
      expect(reading.simTime - (reading.sampleEnd as number)).toBeLessThanOrEqual(step * 1.01)
      expect(reading.supply).toBeCloseTo(voltage, 5)
      expect(reading.output).toBeCloseTo(voltage / 2, 5)
    }
  })

  it('allows a genuinely computed zero-volt working point at time zero without transient samples', () => {
    const events: SimEvent[] = []
    const session = new SimSession(
      dir,
      (event) => events.push(event),
      () => {},
    )
    try {
      session.handle({
        type: 'load',
        netlist: 'Real zero working point\nVS input 0 0\nR1 input 0 1k\n.end',
        probes: [{ id: 'zero', kind: 'v', node: 'input' }],
        analysis: { kind: 'op' },
      })
      expect(events.find((event) => event.type === 'op')).toMatchObject({ type: 'op', values: { zero: 0 } })
      expect(events.some((event) => event.type === 'chunk')).toBe(false)
    } finally {
      session.dispose()
    }
  })
})
