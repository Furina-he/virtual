import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SimAltered, SimChunk, SimEvent } from '../../src/shared/ipc/sim'
import { SimSession } from '../../src/sim/session'

const events: SimEvent[] = []
const session = new SimSession(
  resolve(import.meta.dirname, '../../resources/ngspice'),
  (event) => events.push(event),
  () => {},
)
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

async function until(condition: () => boolean, timeout = 3000) {
  const end = performance.now() + timeout
  while (!condition() && performance.now() < end) await wait(10)
  expect(events.filter((event) => event.type === 'error')).toEqual([])
  expect(condition()).toBe(true)
}

function chunks() {
  return events.filter((event): event is SimChunk => event.type === 'chunk')
}
function latestTime() {
  const last = chunks().at(-1)
  return last ? last.t0 + (Object.values(last.data)[0]?.length ?? 0) * last.dt : 0
}

function expectContinuous() {
  const data = chunks()
  expect(events.filter((event) => event.type === 'loaded')).toHaveLength(1)
  data.forEach((chunk, i) => {
    expect(chunk.seq).toBe(i)
    if (!i) return
    const previous = data[i - 1] as SimChunk
    expect(chunk.t0).toBeCloseTo(previous.t0 + (Object.values(previous.data)[0]?.length ?? 0) * previous.dt, 10)
  })
}

async function load(
  body: string[],
  probes: string[],
  step: number,
  parameterTargets?: { param: string; elements: string[] }[],
) {
  events.length = 0
  session.handle({
    type: 'load',
    netlist: ['Generic live module parameters', ...body, '.end'].join('\n'),
    probes: probes.map((node) => ({ id: node, kind: 'v', node })),
    analysis: { kind: 'tran', step, continuous: true },
    parameterTargets,
  })
  session.handle({ type: 'setPacing', mode: 'realtime' })
  session.handle({ type: 'run' })
  await until(() => latestTime() >= 0.3)
}

async function alter(param: string, value: number, requestId: string, direct?: string): Promise<SimAltered> {
  session.handle({
    type: 'alter',
    requestId,
    changes: [{ param, value, ...(direct ? { targets: [{ element: direct, value }] } : {}) }],
  })
  await until(() => events.some((event) => event.type === 'altered' && event.requestId === requestId))
  const ack = events.find((event): event is SimAltered => event.type === 'altered' && event.requestId === requestId)
  if (!ack) throw new Error('Missing applied parameter acknowledgement')
  await until(() => latestTime() > ack.simTime + 0.3)
  session.handle({ type: 'pause' })
  await wait(80)
  return ack
}

afterAll(() => session.dispose())

describe('generic module live parameters on the real ngspice DLL', () => {
  it('preserves a changed RC branch state and source absolute phase without loading a new plot', async () => {
    await load(
      [
        '.param p_box_r=10000',
        'Vstep in 0 PULSE(0 10 0.01 1u 1u 100 200)',
        'Rcharge in cap {p_box_r}',
        'Cstore cap 0 10u',
        'Vphase phase 0 SIN(0 1 100)',
        'Rphase phase 0 10k',
      ],
      ['cap', 'phase'],
      2e-5,
      [{ param: 'p_box_r', elements: ['rcharge'] }],
    )
    const ack = await alter('p_box_r', 20_000, 'rc-update', 'rcharge')
    expect(ack.changes).toEqual([{ param: 'p_box_r', value: 20_000, targets: [{ element: 'rcharge', value: 20_000 }] }])
    expect(ack.simTime).toBeGreaterThanOrEqual(0.25)
    const atChange = 10 * (1 - Math.exp(-(ack.simTime - 0.01) / 0.1))
    let maxRcError = 0
    let maxPhaseError = 0
    for (const chunk of chunks()) {
      for (let i = 0; i < (chunk.data.cap?.length ?? 0); i++) {
        const time = chunk.t0 + i * chunk.dt
        if (time < 0.011) continue
        const expected =
          time <= ack.simTime
            ? 10 * (1 - Math.exp(-(time - 0.01) / 0.1))
            : 10 + (atChange - 10) * Math.exp(-(time - ack.simTime) / 0.2)
        maxRcError = Math.max(maxRcError, Math.abs((chunk.data.cap?.[i] ?? 0) - expected))
        maxPhaseError = Math.max(
          maxPhaseError,
          Math.abs((chunk.data.phase?.[i] ?? 0) - Math.sin(2 * Math.PI * 100 * time)),
        )
      }
    }
    expect(maxRcError).toBeLessThan(0.02)
    expect(maxPhaseError).toBeLessThan(0.002)
    expectContinuous()
  })

  it('updates an on/off parameterized resistance without resetting the sine source timeline', async () => {
    await load(
      [
        '.param p_box_switch=1',
        'Vin in 0 SIN(0 2 100)',
        '.subckt test_switch P N params: sw=1\nRswitch P N {sw > 0.5 ? 1m : 1T}\n.ends test_switch',
        'Xbox in out test_switch params: sw={p_box_switch}',
        'Rload out 0 1k',
      ],
      ['in', 'out'],
      2e-5,
      [{ param: 'p_box_switch', elements: ['r.xbox.rswitch'] }],
    )
    session.handle({
      type: 'alter',
      requestId: 'switch-update',
      changes: [{ param: 'p_box_switch', value: 0, targets: [{ element: 'r.xbox.rswitch', value: 1e12 }] }],
    })
    await until(() => events.some((event) => event.type === 'altered' && event.requestId === 'switch-update'))
    const ack = events.find(
      (event): event is SimAltered => event.type === 'altered' && event.requestId === 'switch-update',
    ) as SimAltered
    await until(() => latestTime() > ack.simTime + 0.3)
    session.handle({ type: 'pause' })
    await wait(80)
    let maxPhaseError = 0
    let beforePeak = 0
    let afterPeak = 0
    for (const chunk of chunks()) {
      for (let i = 0; i < (chunk.data.in?.length ?? 0); i++) {
        const time = chunk.t0 + i * chunk.dt
        maxPhaseError = Math.max(
          maxPhaseError,
          Math.abs((chunk.data.in?.[i] ?? 0) - 2 * Math.sin(2 * Math.PI * 100 * time)),
        )
        if (time < ack.simTime - 0.001) beforePeak = Math.max(beforePeak, Math.abs(chunk.data.out?.[i] ?? 0))
        if (time > ack.simTime + 0.001) afterPeak = Math.max(afterPeak, Math.abs(chunk.data.out?.[i] ?? 0))
      }
    }
    expect(beforePeak).toBeGreaterThan(1.9)
    expect(afterPeak).toBeLessThan(1e-6)
    expect(maxPhaseError).toBeLessThan(0.002)
    expectContinuous()
  })

  it('acknowledges a real OP parameter change before publishing the recalculated DC point', () => {
    events.length = 0
    session.handle({
      type: 'load',
      netlist: 'Generic DC parameters\n.param p_box_r=1000\nV1 in 0 10\nR1 in out {p_box_r}\nR2 out 0 1000\n.end',
      probes: [{ id: 'out', kind: 'v', node: 'out' }],
      analysis: { kind: 'op' },
    })
    session.handle({ type: 'alter', requestId: 'dc-update', changes: [{ param: 'p_box_r', value: 3000 }] })
    const ack = events.findIndex((event) => event.type === 'altered' && event.requestId === 'dc-update')
    expect(ack).toBeGreaterThan(0)
    const op = events.slice(ack + 1).find((event) => event.type === 'op')
    expect(op?.type === 'op' && op.values.out).toBeCloseTo(2.5, 7)
    expect(events.filter((event) => event.type === 'loaded')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'error')).toEqual([])
  })

  it('rejects undeclared resistor targets without a success acknowledgement or continued simulation', () => {
    events.length = 0
    session.handle({
      type: 'load',
      netlist: 'Restricted targets\n.param p_box_r=1000\nV1 in 0 10\nR1 in out {p_box_r}\nR2 out 0 1000\n.end',
      probes: [{ id: 'out', kind: 'v', node: 'out' }],
      analysis: { kind: 'op' },
      parameterTargets: [{ param: 'p_box_r', elements: ['R1'] }],
    })
    session.handle({
      type: 'alter',
      requestId: 'undeclared',
      changes: [{ param: 'p_box_r', value: 3000, targets: [{ element: 'R2', value: 3000 }] }],
    })
    expect(events.some((event) => event.type === 'altered')).toBe(false)
    expect(events.find((event) => event.type === 'error')).toMatchObject({ requestId: 'undeclared', code: 'model' })
    expect(events.filter((event) => event.type === 'status').at(-1)).toMatchObject({ state: 'error' })
  })
})
