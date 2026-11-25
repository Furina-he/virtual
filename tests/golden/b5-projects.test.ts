import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AssembleInput } from '../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../src/domain/circuit/libraries.ts'
import {
  evaluateSegment7,
  getInstrumentDefaults,
  measureSignal,
  readInstrument,
} from '../../src/domain/instruments/index.ts'
import { buildMeasurementPlan } from '../../src/domain/measurement/plan.ts'
import {
  createFaultFlowState,
  type MeasurementSnapshot,
  observeFaultSymptom,
  recordFaultMeasurement,
  repairFault,
  scopedReference,
  startFaultSession,
  submitFaultDiagnosis,
  verifyFaultRepair,
} from '../../src/domain/task/index.ts'
import { checkWiring, detectDanger } from '../../src/domain/wiring-check/index.ts'
import type { SimEvent } from '../../src/shared/ipc/sim.ts'
import { Instrument, Module, Project } from '../../src/shared/schema/index.ts'
import { SimSession } from '../../src/sim/session.ts'

type ProjectFault = NonNullable<Project['faults']>[number]

// M2 B5（SD-01~09、SD-11、SD-12；SD-10 已由 m1-projects.test.ts 覆盖）真实 ngspice 全流程金标准验证：
// 覆盖 7 块数字挂箱、18 款新增 74LS 芯片 + CD4511、逻辑电平 H/L 指示、七段数码管译码、
// 各类触发器/移位寄存器/二五十进制/可逆/N 进制计数器及 SD-03/SD-06/SD-12 共 9 项预设数电排故闭环（FLT-04）。

const loadJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const loadIns = (id: string) => Instrument.parse(loadJson(`content/instruments/${id}/instrument.json`))
const loadMod = (id: string) => Module.parse(loadJson(`content/modules/${id}/module.json`))
const loadProject = (id: string) => Project.parse(loadJson(`content/projects/${id}/project.json`))

const LIBRARIES = {
  'ttl.lib': readFileSync('content/models/spice/ttl.lib', 'utf8'),
  'cmos.lib': readFileSync('content/models/spice/cmos.lib', 'utf8'),
}
const loadModCir = (id: string) =>
  expandLocalLibraries(readFileSync(`content/modules/${id}/module.cir`, 'utf8'), LIBRARIES)

const modGates = loadMod('mod-dig-gates')
const cirGates = loadModCir('mod-dig-gates')
const modMsi = loadMod('mod-dig-msi')
const cirMsi = loadModCir('mod-dig-msi')
const modArith = loadMod('mod-dig-arith')
const cirArith = loadModCir('mod-dig-arith')
const modFf = loadMod('mod-dig-ff')
const cirFf = loadModCir('mod-dig-ff')
const modShift = loadMod('mod-dig-shift')
const cirShift = loadModCir('mod-dig-shift')
const modCntUd = loadMod('mod-dig-cnt-ud')
const cirCntUd = loadModCir('mod-dig-cnt-ud')
const modCntN = loadMod('mod-dig-cnt-n')
const cirCntN = loadModCir('mod-dig-cnt-n')

const dcPower = loadIns('ins-dc-power')
const dcVolt = loadIns('ins-dc-voltmeter')
const scope = loadIns('ins-oscilloscope')

const events: SimEvent[] = []
const session = new SimSession(
  resolve(import.meta.dirname, '../../resources/ngspice'),
  (event) => events.push(event),
  () => {},
)
afterAll(() => session.dispose())

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing expected value: ${label}`)
  return value
}

function defaultIns(
  instanceId: string,
  instrument: Instrument,
  overrides: Record<string, number | string | boolean> = {},
) {
  return {
    instanceId,
    instrument,
    settings: { ...getInstrumentDefaults(instrument), ...overrides },
  }
}

async function pauseAndIdle(): Promise<void> {
  session.handle({ type: 'pause' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await wait(10)
    for (const ev of events.splice(0)) {
      if (ev.type === 'status' && (ev.state === 'paused' || ev.state === 'idle')) return
    }
  }
}

function assertWiringClean(
  project: Project,
  stepId: string | undefined,
  plan: ReturnType<typeof buildMeasurementPlan>,
) {
  const step = stepId ? project.steps.find((s) => s.id === stepId) : undefined
  const report = checkWiring(plan.checkInput, scopedReference(project, step))
  expect(report.issues, `${project.id}/${stepId ?? 'default'}`).toEqual([])
  expect(report.circuitOk).toBe(true)
  expect(report.measurementsOk).toBe(true)
  expect(detectDanger(plan.checkInput)).toEqual([])
}

async function runDigital(
  input: AssembleInput,
  durationSec: number,
  options: {
    settleSec?: number
    stepOverride?: number
    alters?: Array<{ atSec: number; controlValues: Record<string, number> }>
  } = {},
) {
  const plan = buildMeasurementPlan(input, true, 'b5-tran')
  const step = options.stepOverride ?? (plan.command.analysis.kind === 'tran' ? plan.command.analysis.step : 0.0005)
  const loadCmd = {
    ...plan.command,
    analysis: { kind: 'tran' as const, step, continuous: true as const },
  }
  events.length = 0
  session.handle(loadCmd)
  session.handle({
    type: 'setPacing',
    mode: 'window',
    ...(options.alters?.length ? { windowSec: 0.002 } : {}),
  })

  const probeIds = loadCmd.probes.map((p) => p.id)
  const times: number[] = []
  const channels: Record<string, number[]> = Object.fromEntries(probeIds.map((id) => [id, []]))
  const alters = [...(options.alters ?? [])].sort((a, b) => a.atSec - b.atSec)
  const alterTimes: number[] = []
  let nextAlterIdx = 0
  let alterPending = false
  let curControls = { ...input.controlValues }
  let loaded = false
  let dtOut = step
  const logs: string[] = []
  const deadline = Date.now() + 25_000

  while (Date.now() < deadline) {
    await wait(5)
    for (const ev of events.splice(0)) {
      if (ev.type === 'log') logs.push(ev.line)
      if (ev.type === 'error') throw new Error(`${ev.message} (${ev.detail ?? ''})\n${logs.slice(-12).join('\n')}`)
      if (ev.type === 'loaded') {
        loaded = true
        session.handle({ type: 'run' })
      }
      if (ev.type === 'altered') {
        alterTimes.push(ev.simTime)
        alterPending = false
        session.handle({ type: 'run' })
      }
      if (ev.type === 'chunk' && loaded) {
        dtOut = ev.dt
        const firstArr = Object.values(ev.data)[0]
        const count = firstArr?.length ?? 0
        if (count === 0) continue
        for (let i = 0; i < count; i++) times.push(ev.t0 + i * ev.dt)
        for (const id of probeIds) {
          const arr = channels[id] as number[]
          const src = ev.data[id]
          if (!src) continue
          for (let i = 0; i < src.length; i++) arr.push(src[i] ?? 0)
        }
        const simNow = ev.t0 + count * ev.dt
        if (
          !alterPending &&
          nextAlterIdx < alters.length &&
          simNow >= (alters[nextAlterIdx]?.atSec ?? Number.POSITIVE_INFINITY)
        ) {
          const item = alters[nextAlterIdx++]
          if (item) {
            alterPending = true
            curControls = { ...curControls, ...item.controlValues }
            const nextPlan = buildMeasurementPlan({ ...input, controlValues: curControls }, true, 'b5-alter')
            const changes = nextPlan.parameters.map((p) => ({
              param: p.param,
              value: p.value,
              ...(p.targets ? { targets: p.targets } : {}),
            }))
            session.handle({ type: 'pause' })
            session.handle({ type: 'alter', changes })
          }
        }
        if (!alterPending && nextAlterIdx >= alters.length && simNow >= durationSec) {
          await pauseAndIdle()
          const settle = options.settleSec ?? durationSec * 0.4
          const startIdx = Math.max(
            times.findIndex((t) => t >= settle),
            0,
          )
          const endIdx = times.length
          const lastVal = (probeId: string) => defined(channels[probeId], `probe ${probeId}`).at(-1) ?? 0
          const ledLevel = (instanceId: string, indicatorId: string): 0 | 1 => {
            const led = defined(
              plan.leds.find((l) => l.instanceId === instanceId && l.indicatorId === indicatorId),
              `led ${instanceId}.${indicatorId}`,
            )
            return lastVal(led.probe) >= led.threshold ? 1 : 0
          }
          const segChar = (instanceId: string, indicatorId: string, idx?: number) => {
            const seg = defined(
              plan.segment7s.find((s) => s.instanceId === instanceId && s.indicatorId === indicatorId),
              `seg ${instanceId}.${indicatorId}`,
            )
            const k = idx ?? endIdx - 1
            return evaluateSegment7(
              seg.probes.map((p) => channels[p]?.[k]),
              seg.threshold,
            ).char
          }
          const segSequence = (instanceId: string, indicatorId: string) => {
            const out: string[] = []
            let prev = ''
            let run = 0
            for (let k = startIdx; k < endIdx; k++) {
              const ch = segChar(instanceId, indicatorId, k)
              if (ch === prev) {
                run++
              } else {
                prev = ch
                run = 1
              }
              // 至少连续 2 个网格点（≥4 ms）才视为稳态字形，过滤单点线性插值跨越跳变沿产生的瞬态伪字形
              if (ch && run === 2 && out.at(-1) !== ch) out.push(ch)
            }
            return out
          }
          const freq = (probeId: string) => {
            const arr = Float32Array.from(defined(channels[probeId], `probe ${probeId}`).slice(startIdx, endIdx))
            return measureSignal(arr, dtOut)?.frequency ?? 0
          }
          const meterReadings: Record<string, ReturnType<typeof readInstrument>> = {}
          const rawV: Record<string, number> = {}
          for (const meter of plan.meters) {
            const v = meter.voltageProbe ? lastVal(meter.voltageProbe) : undefined
            if (v !== undefined) rawV[meter.instanceId] = v
            meterReadings[meter.instanceId] = readInstrument(meter.config, {
              voltage: v,
              current: meter.currentProbe ? lastVal(meter.currentProbe) : undefined,
              connectedJacks: meter.connectedJacks,
            })
          }
          const scopeWaveforms = plan.scopes.flatMap((sc) =>
            sc.channels.flatMap((ch) => {
              if (!ch.probe) return []
              const arr = Float32Array.from(defined(channels[ch.probe], `scope ${ch.probe}`).slice(startIdx, endIdx))
              const meas = measureSignal(arr, dtOut)
              const cfg = input.instruments
                .find((i) => i.instanceId === sc.instanceId)
                ?.instrument.scope?.channels.find((c) => c.id === ch.id)
              if (!cfg) return []
              return [
                {
                  instanceId: sc.instanceId,
                  channelId: ch.id,
                  positiveRef: `${sc.instanceId}.${cfg.positiveJack}`,
                  negativeRef: `${sc.instanceId}.${cfg.negativeJack}`,
                  coupling: 'dc' as const,
                  current: meas !== null,
                  measurement: meas,
                },
              ]
            }),
          )
          return {
            plan,
            times,
            alterTimes,
            channels,
            lastVal,
            ledLevel,
            segChar,
            segSequence,
            freq,
            rawV,
            snapshot: {
              current: true,
              plan,
              readings: meterReadings,
              waveforms: scopeWaveforms,
            } satisfies MeasurementSnapshot,
          }
        }
      }
    }
  }
  throw new Error(`Timed out running digital transient: ${input.title}\n${logs.slice(-10).join('\n')}`)
}

function runFaultClosedLoop(
  project: Project,
  fault: ProjectFault,
  badSnapshot: MeasurementSnapshot,
  fixedSnapshot: MeasurementSnapshot,
) {
  let flow = createFaultFlowState()
  flow = startFaultSession(project, flow, { mode: 'preset', faultId: fault.id, nowMs: 100 }).state
  flow = observeFaultSymptom(project, flow, { powered: true, nowMs: 200 }).state
  flow = recordFaultMeasurement(project, flow, { snapshot: badSnapshot, nowMs: 300 }).state
  const diag = submitFaultDiagnosis(project, flow, { target: fault.target, kind: fault.kind, nowMs: 400 })
  expect(diag.ok, `${project.id}/${fault.id} diag`).toBe(true)
  flow = repairFault(project, diag.state, { powered: false, nowMs: 500 }).state
  const verified = verifyFaultRepair(project, flow, { powered: true, snapshot: fixedSnapshot, nowMs: 600 })
  expect(verified.ok, `${project.id}/${fault.id} verify`).toBe(true)
  expect(verified.state.stage).toBe('completed')
}

describe('M2 B5（SD-01~09、SD-11、SD-12）真实 ngspice 金标准与数电排故验证', () => {
  it('SD-01：六种基本 TTL 逻辑门四组输入真值表与板载 H/L 电平指示', async () => {
    const project = loadProject('SD-01')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'dg1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'dg1.GND' },
      { a: 'dg1.K0', b: 'dg1.G_A' },
      { a: 'dg1.K1', b: 'dg1.G_B' },
      { a: 'dg1.Y_NAND', b: 'dg1.LED0' },
      { a: 'dg1.Y_XOR', b: 'dg1.LED1' },
      { a: 'ins-dc-voltmeter.POS', b: 'dg1.Y_AND' },
      { a: 'ins-dc-voltmeter.NEG', b: 'dg1.GND' },
    ]
    for (const [a, b] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const) {
      const res = await runDigital(
        {
          title: `SD-01 ${a}${b}`,
          modules: [{ instanceId: 'dg1', module: modGates, subckt: cirGates }],
          instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' })],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'dg1.SW_K0': a, 'dg1.SW_K1': b },
          analysis: [],
        },
        0.004,
      )
      if (a === 0 && b === 0) assertWiringClean(project, 'wire', res.plan)
      expect(res.ledLevel('dg1', 'L_NAND')).toBe(!(a && b) ? 1 : 0)
      expect(res.ledLevel('dg1', 'L_NOR')).toBe(!(a || b) ? 1 : 0)
      expect(res.ledLevel('dg1', 'L_NOT')).toBe(!a ? 1 : 0)
      expect(res.ledLevel('dg1', 'L_AND')).toBe(a && b ? 1 : 0)
      expect(res.ledLevel('dg1', 'L_OR')).toBe(a || b ? 1 : 0)
      expect(res.ledLevel('dg1', 'L_XOR')).toBe(a !== b ? 1 : 0)
      expect(res.ledLevel('dg1', 'L_LED0')).toBe(!(a && b) ? 1 : 0)
      expect(res.ledLevel('dg1', 'L_LED1')).toBe(a !== b ? 1 : 0)
      if (a === 1 && b === 1) expect(res.rawV['ins-dc-voltmeter']).toBeGreaterThan(2.9)
      else expect(res.rawV['ins-dc-voltmeter']).toBeLessThan(0.3)
    }
  })

  it('SD-02：74LS148 优先编码器禁能、空闲、全 8 级辅助请求及 /I7 最高优先级覆盖', async () => {
    const project = loadProject('SD-02')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'msi1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'msi1.GND' },
      { a: 'msi1.K0', b: 'msi1.E_I1' },
      { a: 'msi1.K1', b: 'msi1.E_I4' },
      { a: 'msi1.K2', b: 'msi1.E_I7' },
      { a: 'msi1.K3', b: 'msi1.E_EI' },
    ]
    const runCase = (ctrl: Record<string, number>) =>
      runDigital(
        {
          title: `SD-02 ${JSON.stringify(ctrl)}`,
          modules: [{ instanceId: 'msi1', module: modMsi, subckt: cirMsi }],
          instruments: [defaultIns('ins-dc-power', dcPower)],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: ctrl,
          analysis: [],
        },
        0.004,
      )
    const read = (r: Awaited<ReturnType<typeof runCase>>) => [
      r.ledLevel('msi1', 'L_A2'),
      r.ledLevel('msi1', 'L_A1'),
      r.ledLevel('msi1', 'L_A0'),
      r.ledLevel('msi1', 'L_GS'),
      r.ledLevel('msi1', 'L_EO'),
    ]
    // /EI=1 禁能 -> 全高
    const dis = await runCase({ 'msi1.SW_K0': 0, 'msi1.SW_K1': 0, 'msi1.SW_K2': 0, 'msi1.SW_K3': 1, 'msi1.ENC_EXT': 0 })
    assertWiringClean(project, 'wire', dis.plan)
    expect(read(dis)).toEqual([1, 1, 1, 1, 1])
    // /EI=0 无请求 -> /EO=0, /GS=1
    const idle = await runCase({
      'msi1.SW_K0': 1,
      'msi1.SW_K1': 1,
      'msi1.SW_K2': 1,
      'msi1.SW_K3': 0,
      'msi1.ENC_EXT': 0,
    })
    expect(read(idle)).toEqual([1, 1, 1, 1, 0])
    // 辅助请求 /I5 低（ENC_EXT=4）-> ~5 = 010, /GS=0, /EO=1
    const i5 = await runCase({ 'msi1.SW_K0': 1, 'msi1.SW_K1': 1, 'msi1.SW_K2': 1, 'msi1.SW_K3': 0, 'msi1.ENC_EXT': 4 })
    expect(read(i5)).toEqual([0, 1, 0, 0, 1])
    // 同时拉低 /I1,/I4,/I7 -> /I7 优先输出 000
    const p7 = await runCase({ 'msi1.SW_K0': 0, 'msi1.SW_K1': 0, 'msi1.SW_K2': 0, 'msi1.SW_K3': 0, 'msi1.ENC_EXT': 0 })
    expect(read(p7)).toEqual([0, 0, 0, 0, 1])
  })

  it('SD-03：74LS138 译码、74LS151 奇校验、74LS153 异或及 3 项预设故障闭环（FLT-04）', async () => {
    const project = loadProject('SD-03')
    const baseWires = [
      { a: 'ins-dc-power.V5P', b: 'msi1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'msi1.GND' },
      { a: 'msi1.K0', b: 'msi1.SEL_A' },
      { a: 'msi1.K1', b: 'msi1.SEL_B' },
      { a: 'msi1.K2', b: 'msi1.SEL_C' },
      { a: 'msi1.K3', b: 'msi1.DEC_G1' },
    ]
    // 正常四地址校验（0, 3, 5, 7）
    for (const addr of [0, 3, 5, 7]) {
      const a = addr & 1
      const b = (addr >> 1) & 1
      const c = (addr >> 2) & 1
      const res = await runDigital(
        {
          title: `SD-03 addr=${addr}`,
          modules: [{ instanceId: 'msi1', module: modMsi, subckt: cirMsi }],
          instruments: [defaultIns('ins-dc-power', dcPower)],
          wires: baseWires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'msi1.SW_K0': a, 'msi1.SW_K1': b, 'msi1.SW_K2': c, 'msi1.SW_K3': 1 },
          analysis: [],
        },
        0.004,
      )
      if (addr === 0) assertWiringClean(project, 'wire', res.plan)
      expect(res.ledLevel('msi1', 'L_Y0')).toBe(addr === 0 ? 0 : 1)
      expect(res.ledLevel('msi1', 'L_Y3')).toBe(addr === 3 ? 0 : 1)
      expect(res.ledLevel('msi1', 'L_Y5')).toBe(addr === 5 ? 0 : 1)
      expect(res.ledLevel('msi1', 'L_Y7')).toBe(addr === 7 ? 0 : 1)
      expect(res.ledLevel('msi1', 'L_M151')).toBe((a ^ b ^ c) as 0 | 1)
      expect(res.ledLevel('msi1', 'L_M153')).toBe((a ^ b) as 0 | 1)
    }

    // 3 项预设故障六步排故闭环
    const faults = defined(project.faults, 'SD-03 faults')
    expect(faults).toHaveLength(3)
    const testProbeFor: Record<string, { jack: string; ctrl: Record<string, number>; badCheck: (v: number) => void }> =
      {
        'flt-138-g1-short': {
          jack: 'msi1.DEC_Y0',
          ctrl: { 'msi1.SW_K0': 0, 'msi1.SW_K1': 0, 'msi1.SW_K2': 0, 'msi1.SW_K3': 1 },
          badCheck: (v) => expect(v).toBeGreaterThan(2.7),
        },
        'flt-151-g-stuck': {
          jack: 'msi1.MUX151_Y',
          ctrl: { 'msi1.SW_K0': 1, 'msi1.SW_K1': 1, 'msi1.SW_K2': 1, 'msi1.SW_K3': 1 },
          badCheck: (v) => expect(v).toBeLessThan(0.5),
        },
        'flt-153-g-stuck': {
          jack: 'msi1.MUX153_1Y',
          ctrl: { 'msi1.SW_K0': 1, 'msi1.SW_K1': 0, 'msi1.SW_K2': 0, 'msi1.SW_K3': 1 },
          badCheck: (v) => expect(v).toBeLessThan(0.5),
        },
      }
    for (const fault of faults) {
      const spec = defined(testProbeFor[fault.id], fault.id)
      const wires = [
        ...baseWires,
        { a: 'ins-dc-voltmeter.POS', b: spec.jack },
        { a: 'ins-dc-voltmeter.NEG', b: 'msi1.GND' },
      ]
      const bad = await runDigital(
        {
          title: `SD-03 bad ${fault.id}`,
          modules: [{ instanceId: 'msi1', module: modMsi, subckt: cirMsi }],
          instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' })],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: spec.ctrl,
          fault,
          analysis: [],
        },
        0.004,
      )
      spec.badCheck(defined(bad.rawV['ins-dc-voltmeter'], fault.id))

      const fixed = await runDigital(
        {
          title: `SD-03 fixed ${fault.id}`,
          modules: [{ instanceId: 'msi1', module: modMsi, subckt: cirMsi }],
          instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' })],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: spec.ctrl,
          analysis: [],
        },
        0.004,
      )
      runFaultClosedLoop(project, fault, bad.snapshot, fixed.snapshot)
    }
  }, 30_000)

  it('SD-04：74LS183 一位全加器与 74LS283 四位超前进位加法（含满进位链 9+6+1=16 与 15+15+1=31）', async () => {
    const project = loadProject('SD-04')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'ar1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'ar1.GND' },
      { a: 'ar1.K0', b: 'ar1.FA_A' },
      { a: 'ar1.K1', b: 'ar1.FA_B' },
      { a: 'ar1.K2', b: 'ar1.FA_CI' },
      { a: 'ar1.K2', b: 'ar1.AD4_C0' },
    ]
    for (const [k0, k1, k2, opA, opB] of [
      [1, 1, 0, 5, 3],
      [1, 1, 1, 9, 6],
      [0, 1, 1, 15, 15],
    ] as const) {
      const res = await runDigital(
        {
          title: `SD-04 ${opA}+${opB}+${k2}`,
          modules: [{ instanceId: 'ar1', module: modArith, subckt: cirArith }],
          instruments: [defaultIns('ins-dc-power', dcPower)],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'ar1.SW_K0': k0, 'ar1.SW_K1': k1, 'ar1.SW_K2': k2, 'ar1.OP_A': opA, 'ar1.OP_B': opB },
          analysis: [],
        },
        0.004,
      )
      if (opA === 5) assertWiringClean(project, 'wire', res.plan)
      const sum1 = k0 + k1 + k2
      expect(res.ledLevel('ar1', 'L_FAS')).toBe(sum1 & 1)
      expect(res.ledLevel('ar1', 'L_FACO')).toBe((sum1 >> 1) & 1)
      const sum4 =
        res.ledLevel('ar1', 'L_S0') +
        2 * res.ledLevel('ar1', 'L_S1') +
        4 * res.ledLevel('ar1', 'L_S2') +
        8 * res.ledLevel('ar1', 'L_S3') +
        16 * res.ledLevel('ar1', 'L_C4')
      expect(sum4).toBe(opA + opB + k2)
    }
  })

  it('SD-05：74LS85 四位数值比较器 A>B / A<B / A=B 及低位级联透传', async () => {
    const project = loadProject('SD-05')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'ar1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'ar1.GND' },
      { a: 'ar1.K0', b: 'ar1.CMP_IGT' },
      { a: 'ar1.K3', b: 'ar1.CMP_IEQ' },
      { a: 'ar1.K1', b: 'ar1.CMP_ILT' },
    ]
    for (const [opA, opB, igt, ieq, ilt, exp] of [
      [5, 3, 0, 1, 0, [1, 0, 0]],
      [3, 11, 0, 1, 0, [0, 0, 1]],
      [9, 9, 0, 1, 0, [0, 1, 0]],
      [9, 9, 1, 0, 0, [1, 0, 0]],
      [9, 9, 0, 0, 1, [0, 0, 1]],
    ] as const) {
      const res = await runDigital(
        {
          title: `SD-05 ${opA} vs ${opB}`,
          modules: [{ instanceId: 'ar1', module: modArith, subckt: cirArith }],
          instruments: [defaultIns('ins-dc-power', dcPower)],
          wires,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'ar1.OP_A': opA, 'ar1.OP_B': opB, 'ar1.SW_K0': igt, 'ar1.SW_K3': ieq, 'ar1.SW_K1': ilt },
          analysis: [],
        },
        0.004,
      )
      if (opA === 5) assertWiringClean(project, 'wire', res.plan)
      expect([res.ledLevel('ar1', 'L_GT'), res.ledLevel('ar1', 'L_EQ'), res.ledLevel('ar1', 'L_LT')]).toEqual([...exp])
    }
  })

  it('SD-06：CD4511 译码/灯测/消隐及 3 项显示排故闭环（含数码管缺段，FLT-04）', async () => {
    const project = loadProject('SD-06')
    const baseWires = [
      { a: 'ins-dc-power.V5P', b: 'dg1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'dg1.GND' },
      { a: 'dg1.GND', b: 'dg1.CD_LE' },
      { a: 'dg1.K0', b: 'dg1.CD_A' },
      { a: 'dg1.K1', b: 'dg1.CD_B' },
      { a: 'dg1.K2', b: 'dg1.CD_C' },
      { a: 'dg1.K3', b: 'dg1.CD_D' },
      { a: 'dg1.K4', b: 'dg1.CD_LT' },
      { a: 'dg1.K5', b: 'dg1.CD_BI' },
    ]
    const runCd = (
      ctrl: Record<string, number>,
      extraWires: Array<{ a: string; b: string }> = [],
      fault?: ProjectFault,
    ) =>
      runDigital(
        {
          title: `SD-06 ${fault?.id ?? 'ok'}`,
          modules: [{ instanceId: 'dg1', module: modGates, subckt: cirGates }],
          instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('ins-dc-voltmeter', dcVolt, { range: 'r20' })],
          wires: [...baseWires, ...extraWires],
          ground: 'ins-dc-power.V5N',
          controlValues: ctrl,
          ...(fault ? { fault } : {}),
          analysis: [],
        },
        0.004,
      )

    // 正常译码 5 (0101)、10 (消隐)、/LT=0 (灯测 8)、/BI=0 (消隐)
    const d5 = await runCd({
      'dg1.SW_K0': 1,
      'dg1.SW_K1': 0,
      'dg1.SW_K2': 1,
      'dg1.SW_K3': 0,
      'dg1.SW_K4': 1,
      'dg1.SW_K5': 1,
    })
    assertWiringClean(project, 'wire', d5.plan)
    expect(d5.segChar('dg1', 'DISP1')).toBe('5')
    const d10 = await runCd({
      'dg1.SW_K0': 0,
      'dg1.SW_K1': 1,
      'dg1.SW_K2': 0,
      'dg1.SW_K3': 1,
      'dg1.SW_K4': 1,
      'dg1.SW_K5': 1,
    })
    expect(d10.segChar('dg1', 'DISP1')).toBe('')
    const lt = await runCd({
      'dg1.SW_K0': 1,
      'dg1.SW_K1': 0,
      'dg1.SW_K2': 0,
      'dg1.SW_K3': 0,
      'dg1.SW_K4': 0,
      'dg1.SW_K5': 0,
    })
    expect(lt.segChar('dg1', 'DISP1')).toBe('8')
    const bi = await runCd({
      'dg1.SW_K0': 0,
      'dg1.SW_K1': 0,
      'dg1.SW_K2': 0,
      'dg1.SW_K3': 0,
      'dg1.SW_K4': 1,
      'dg1.SW_K5': 0,
    })
    expect(bi.segChar('dg1', 'DISP1')).toBe('')

    // 3 项故障六步闭环（含数码管 a 段缺段）
    const faults = defined(project.faults, 'SD-06 faults')
    expect(faults).toHaveLength(3)
    const probeByFault: Record<string, { jack: string; badCheck: (v: number) => void }> = {
      'flt-sega-open': { jack: 'dg1.CD_SEGA', badCheck: (v) => expect(v).toBeLessThan(0.2) },
      'flt-bi-short': { jack: 'dg1.CD_BI', badCheck: (v) => expect(v).toBeLessThan(0.3) },
      'flt-lt-short': { jack: 'dg1.CD_LT', badCheck: (v) => expect(v).toBeLessThan(0.3) },
    }
    const ctrl0 = { 'dg1.SW_K0': 0, 'dg1.SW_K1': 0, 'dg1.SW_K2': 0, 'dg1.SW_K3': 0, 'dg1.SW_K4': 1, 'dg1.SW_K5': 1 }
    for (const fault of faults) {
      const spec = defined(probeByFault[fault.id], fault.id)
      const meterWires = [
        { a: 'ins-dc-voltmeter.POS', b: spec.jack },
        { a: 'ins-dc-voltmeter.NEG', b: 'dg1.GND' },
      ]
      const bad = await runCd(ctrl0, meterWires, fault)
      spec.badCheck(defined(bad.rawV['ins-dc-voltmeter'], fault.id))
      if (fault.id === 'flt-sega-open') expect(bad.segChar('dg1', 'DISP1')).not.toBe('0')
      if (fault.id === 'flt-lt-short') expect(bad.segChar('dg1', 'DISP1')).toBe('8')

      const fixed = await runCd(ctrl0, meterWires)
      runFaultClosedLoop(project, fault, bad.snapshot, fixed.snapshot)
    }
  }, 30_000)

  it("SD-07：RS / D (74LS74 上升沿) / JK (74LS112 下降沿) 触发器边沿对比与 T' 二分频", async () => {
    const project = loadProject('SD-07')
    const baseWires = [
      { a: 'ins-dc-power.V5P', b: 'ff1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'ff1.GND' },
      { a: 'ff1.K0', b: 'ff1.RS_S' },
      { a: 'ff1.K0', b: 'ff1.D_PRE' },
      { a: 'ff1.K0', b: 'ff1.JK_PRE' },
      { a: 'ff1.K1', b: 'ff1.RS_R' },
      { a: 'ff1.K1', b: 'ff1.D_CLR' },
      { a: 'ff1.K1', b: 'ff1.JK_CLR' },
      { a: 'ff1.K2', b: 'ff1.D_D' },
      { a: 'ff1.K2', b: 'ff1.JK_J' },
      { a: 'ff1.K3', b: 'ff1.JK_K' },
      { a: 'ff1.CP_MAN', b: 'ff1.D_CP' },
      { a: 'ff1.CP_MAN', b: 'ff1.JK_CP' },
    ]
    // 按 50 ms 时间片边界施加单次脉冲：0.05 s 上升沿（74LS74 立即置 1，74LS112 保持 0）；0.10 s 下降沿（74LS112 翻转至 1）
    const edge = await runDigital(
      {
        title: 'SD-07 edge',
        modules: [{ instanceId: 'ff1', module: modFf, subckt: cirFf }],
        instruments: [defaultIns('ins-dc-power', dcPower)],
        wires: baseWires,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'ff1.SW_K0': 1, 'ff1.SW_K1': 1, 'ff1.SW_K2': 1, 'ff1.SW_K3': 1, 'ff1.CP_BTN': 0 },
        analysis: [],
      },
      0.16,
      {
        alters: [
          { atSec: 0.05, controlValues: { 'ff1.CP_BTN': 1 } },
          { atSec: 0.1, controlValues: { 'ff1.CP_BTN': 0 } },
        ],
      },
    )
    assertWiringClean(project, 'wire', edge.plan)
    // 上升沿之后、下降沿之前：D_Q=1, JK_Q=0
    const tMid = defined(edge.alterTimes[0], 'SD-07 alterTimes[0]') + 0.02
    const idxMid = edge.times.findIndex((t) => t >= tMid)
    const dProbe = defined(
      edge.plan.leds.find((l) => l.indicatorId === 'L_D_Q'),
      'L_D_Q',
    ).probe
    const jkProbe = defined(
      edge.plan.leds.find((l) => l.indicatorId === 'L_JK_Q'),
      'L_JK_Q',
    ).probe
    expect(edge.channels[dProbe]?.[idxMid] ?? 0).toBeGreaterThan(2.7)
    expect(edge.channels[jkProbe]?.[idxMid] ?? 9).toBeLessThan(0.5)
    // t=0.16 s（下降沿之后）：两者均为 1
    expect(edge.ledLevel('ff1', 'L_D_Q')).toBe(1)
    expect(edge.ledLevel('ff1', 'L_JK_Q')).toBe(1)

    // 连续 10 Hz 时钟下 JK (J=K=1) 精准二分频 ≈ 5 Hz
    const div2Wires = [
      ...baseWires.filter((w) => !(w.a === 'ff1.CP_MAN' && w.b === 'ff1.JK_CP')),
      { a: 'ff1.CLK_OUT', b: 'ff1.JK_CP' },
      { a: 'scope1.CH1', b: 'ff1.CLK_OUT' },
      { a: 'scope1.CH2', b: 'ff1.JK_Q' },
      { a: 'scope1.GND', b: 'ff1.GND' },
    ]
    const div2 = await runDigital(
      {
        title: 'SD-07 div2',
        modules: [{ instanceId: 'ff1', module: modFf, subckt: cirFf }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.2 })],
        wires: div2Wires,
        ground: 'ins-dc-power.V5N',
        controlValues: {
          'ff1.SW_K0': 1,
          'ff1.SW_K1': 1,
          'ff1.SW_K2': 1,
          'ff1.SW_K3': 1,
          'ff1.CLK_RATE': 10,
        },
        analysis: [],
      },
      0.85,
      { settleSec: 0.15, stepOverride: 0.001 },
    )
    assertWiringClean(project, 'test_div2', div2.plan)
    expect(div2.freq('scope:scope1:CH1')).toBeGreaterThan(9.5)
    expect(div2.freq('scope:scope1:CH1')).toBeLessThan(10.5)
    expect(div2.freq('scope:scope1:CH2')).toBeGreaterThan(4.7)
    expect(div2.freq('scope:scope1:CH2')).toBeLessThan(5.3)
  }, 30_000)

  it('SD-08：74LS194 双向移位寄存器并行置数 1010 → 右移 0101 → 保持 0101 → 左移 0010', async () => {
    const project = loadProject('SD-08')
    const wires = [
      { a: 'ins-dc-power.V5P', b: 'sh1.VCC' },
      { a: 'ins-dc-power.V5P', b: 'sh1.SH_CLR' },
      { a: 'ins-dc-power.V5P', b: 'sh1.SH_SR' },
      { a: 'ins-dc-power.V5N', b: 'sh1.GND' },
      { a: 'ins-dc-power.V5N', b: 'sh1.SH_SL' },
      { a: 'sh1.K0', b: 'sh1.SH_S0' },
      { a: 'sh1.K1', b: 'sh1.SH_S1' },
      { a: 'sh1.CP_MAN', b: 'sh1.SH_CP' },
    ]
    const res = await runDigital(
      {
        title: 'SD-08 shift',
        modules: [{ instanceId: 'sh1', module: modShift, subckt: cirShift }],
        instruments: [defaultIns('ins-dc-power', dcPower)],
        wires,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'sh1.SW_K0': 1, 'sh1.SW_K1': 1, 'sh1.PAR_DATA': 10, 'sh1.CP_BTN': 0 },
        analysis: [],
      },
      0.55,
      {
        alters: [
          // 0.05s: 并行置数 1010 (DCBA=1010 -> QA=0,QB=1,QC=0,QD=1)
          { atSec: 0.05, controlValues: { 'sh1.CP_BTN': 1 } },
          { atSec: 0.12, controlValues: { 'sh1.CP_BTN': 0, 'sh1.SW_K1': 0, 'sh1.SW_K0': 1 } },
          // 0.20s: 右移 (SR=1) -> QA=1,QB=0,QC=1,QD=0 (DCBA=0101 = 5)
          { atSec: 0.2, controlValues: { 'sh1.CP_BTN': 1 } },
          { atSec: 0.27, controlValues: { 'sh1.CP_BTN': 0, 'sh1.SW_K1': 0, 'sh1.SW_K0': 0 } },
          // 0.34s: 保持 -> 仍为 0101 (5)
          { atSec: 0.34, controlValues: { 'sh1.CP_BTN': 1 } },
          { atSec: 0.41, controlValues: { 'sh1.CP_BTN': 0, 'sh1.SW_K1': 1, 'sh1.SW_K0': 0 } },
          // 0.48s: 左移 (SL=0) -> QD=0,QC=0,QB=1,QA=0 (DCBA=0010 = 2)
          { atSec: 0.48, controlValues: { 'sh1.CP_BTN': 1 } },
        ],
      },
    )
    assertWiringClean(project, 'wire', res.plan)
    const wordAt = (tq: number) => {
      const idx = res.times.findIndex((t) => t >= tq)
      return (['L_QA', 'L_QB', 'L_QC', 'L_QD'] as const).reduce((acc, id, bit) => {
        const probe = defined(
          res.plan.leds.find((l) => l.indicatorId === id),
          id,
        ).probe
        return acc + ((res.channels[probe]?.[idx] ?? 0) >= 1.8 ? 1 << bit : 0)
      }, 0)
    }
    expect(wordAt(defined(res.alterTimes[0], 'SD-08 alter 0') + 0.02)).toBe(0b1010)
    expect(wordAt(defined(res.alterTimes[2], 'SD-08 alter 2') + 0.02)).toBe(0b0101)
    expect(wordAt(defined(res.alterTimes[4], 'SD-08 alter 4') + 0.02)).toBe(0b0101)
    expect(wordAt(defined(res.alterTimes[6], 'SD-08 alter 6') + 0.02)).toBe(0b0010)
  })

  it('SD-09：74LS90 8421 BCD（0→9→0、f_Q3=f_CLK/10）与 5421 对称方波十分频（f_Q0=f_CLK/10）', async () => {
    const project = loadProject('SD-09')
    const w8421 = [
      { a: 'ins-dc-power.V5P', b: 'cnt1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'cnt1.GND' },
      { a: 'cnt1.GND', b: 'cnt1.C90_R9' },
      { a: 'cnt1.CLK_OUT', b: 'cnt1.C90_CP0' },
      { a: 'cnt1.C90_Q0', b: 'cnt1.C90_CP1' },
      { a: 'cnt1.C90_Q0', b: 'cnt1.DISP_A' },
      { a: 'cnt1.C90_Q1', b: 'cnt1.DISP_B' },
      { a: 'cnt1.C90_Q2', b: 'cnt1.DISP_C' },
      { a: 'cnt1.C90_Q3', b: 'cnt1.DISP_D' },
      { a: 'cnt1.K0', b: 'cnt1.C90_R0' },
      { a: 'scope1.CH1', b: 'cnt1.C90_CP0' },
      { a: 'scope1.CH2', b: 'cnt1.C90_Q3' },
      { a: 'scope1.GND', b: 'cnt1.GND' },
    ]
    const r8421 = await runDigital(
      {
        title: 'SD-09 8421',
        modules: [{ instanceId: 'cnt1', module: modCntUd, subckt: cirCntUd }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.5 })],
        wires: w8421,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'cnt1.CLK_RATE': 10, 'cnt1.SW_K0': 0 },
        analysis: [],
      },
      2.6,
      { settleSec: 0.05, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'wire', r8421.plan)
    expect(r8421.segSequence('cnt1', 'DISP_CNT').slice(0, 11)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '0',
    ])
    expect(r8421.freq('scope:scope1:CH1')).toBeGreaterThan(9.5)
    expect(r8421.freq('scope:scope1:CH2')).toBeGreaterThan(0.92)
    expect(r8421.freq('scope:scope1:CH2')).toBeLessThan(1.08)

    // 5421 接法：CLK_OUT→CP1，Q3→CP0，测 Q0 频率 ≈ 1 Hz
    const w5421 = [
      { a: 'ins-dc-power.V5P', b: 'cnt1.VCC' },
      { a: 'ins-dc-power.V5N', b: 'cnt1.GND' },
      { a: 'cnt1.GND', b: 'cnt1.C90_R9' },
      { a: 'cnt1.CLK_OUT', b: 'cnt1.C90_CP1' },
      { a: 'cnt1.C90_Q3', b: 'cnt1.C90_CP0' },
      { a: 'cnt1.C90_Q0', b: 'cnt1.DISP_A' },
      { a: 'cnt1.C90_Q1', b: 'cnt1.DISP_B' },
      { a: 'cnt1.C90_Q2', b: 'cnt1.DISP_C' },
      { a: 'cnt1.C90_Q3', b: 'cnt1.DISP_D' },
      { a: 'cnt1.K0', b: 'cnt1.C90_R0' },
      { a: 'scope1.CH2', b: 'cnt1.C90_Q0' },
      { a: 'scope1.GND', b: 'cnt1.GND' },
    ]
    const r5421 = await runDigital(
      {
        title: 'SD-09 5421',
        modules: [{ instanceId: 'cnt1', module: modCntUd, subckt: cirCntUd }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.5 })],
        wires: w5421,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'cnt1.CLK_RATE': 10, 'cnt1.SW_K0': 0 },
        analysis: [],
      },
      2.6,
      { settleSec: 0.1, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'mode5421', r5421.plan)
    expect(r5421.freq('scope:scope1:CH2')).toBeGreaterThan(0.92)
    expect(r5421.freq('scope:scope1:CH2')).toBeLessThan(1.08)
  }, 30_000)

  it('SD-11：74LS192 可逆十进制计数器加计数 0→9→0 (/CO≈1Hz) 与减计数 0→9→8→…→0 (/BO≈1Hz)', async () => {
    const project = loadProject('SD-11')
    const wUp = [
      { a: 'ins-dc-power.V5P', b: 'cnt1.VCC' },
      { a: 'ins-dc-power.V5P', b: 'cnt1.C192_DN' },
      { a: 'ins-dc-power.V5N', b: 'cnt1.GND' },
      { a: 'cnt1.CLK_OUT', b: 'cnt1.C192_UP' },
      { a: 'cnt1.K0', b: 'cnt1.C192_CLR' },
      { a: 'cnt1.K1', b: 'cnt1.C192_LD' },
      { a: 'cnt1.C192_Q0', b: 'cnt1.DISP_A' },
      { a: 'cnt1.C192_Q1', b: 'cnt1.DISP_B' },
      { a: 'cnt1.C192_Q2', b: 'cnt1.DISP_C' },
      { a: 'cnt1.C192_Q3', b: 'cnt1.DISP_D' },
      { a: 'scope1.CH1', b: 'cnt1.C192_UP' },
      { a: 'scope1.CH2', b: 'cnt1.C192_CO' },
      { a: 'scope1.GND', b: 'cnt1.GND' },
    ]
    const rUp = await runDigital(
      {
        title: 'SD-11 up',
        modules: [{ instanceId: 'cnt1', module: modCntUd, subckt: cirCntUd }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.5 })],
        wires: wUp,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'cnt1.CLK_RATE': 10, 'cnt1.SW_K0': 0, 'cnt1.SW_K1': 1 },
        analysis: [],
      },
      2.6,
      { settleSec: 0.02, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'wire', rUp.plan)
    expect(rUp.segSequence('cnt1', 'DISP_CNT').slice(0, 11)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '0',
    ])
    expect(rUp.freq('scope:scope1:CH2')).toBeGreaterThan(0.92)
    expect(rUp.freq('scope:scope1:CH2')).toBeLessThan(1.08)

    const wDn = [
      { a: 'ins-dc-power.V5P', b: 'cnt1.VCC' },
      { a: 'ins-dc-power.V5P', b: 'cnt1.C192_UP' },
      { a: 'ins-dc-power.V5N', b: 'cnt1.GND' },
      { a: 'cnt1.CLK_OUT', b: 'cnt1.C192_DN' },
      { a: 'cnt1.K0', b: 'cnt1.C192_CLR' },
      { a: 'cnt1.K1', b: 'cnt1.C192_LD' },
      { a: 'cnt1.C192_Q0', b: 'cnt1.DISP_A' },
      { a: 'cnt1.C192_Q1', b: 'cnt1.DISP_B' },
      { a: 'cnt1.C192_Q2', b: 'cnt1.DISP_C' },
      { a: 'cnt1.C192_Q3', b: 'cnt1.DISP_D' },
      { a: 'scope1.CH2', b: 'cnt1.C192_BO' },
      { a: 'scope1.GND', b: 'cnt1.GND' },
    ]
    const rDn = await runDigital(
      {
        title: 'SD-11 down',
        modules: [{ instanceId: 'cnt1', module: modCntUd, subckt: cirCntUd }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.5 })],
        wires: wDn,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'cnt1.CLK_RATE': 10, 'cnt1.SW_K0': 0, 'cnt1.SW_K1': 1 },
        analysis: [],
      },
      2.6,
      { settleSec: 0.02, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'down_count', rDn.plan)
    expect(rDn.segSequence('cnt1', 'DISP_CNT').slice(0, 11)).toEqual([
      '0',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
      '3',
      '2',
      '1',
      '0',
    ])
    expect(rDn.freq('scope:scope1:CH2')).toBeGreaterThan(0.92)
    expect(rDn.freq('scope:scope1:CH2')).toBeLessThan(1.08)
  }, 30_000)

  it('SD-12：74LS161 反馈清零六进制、同步置数六进制、74LS160 十进制及 3 项故障闭环（FLT-04）', async () => {
    const project = loadProject('SD-12')
    const wClear = [
      { a: 'ins-dc-power.V5P', b: 'cn1.VCC' },
      { a: 'ins-dc-power.V5P', b: 'cn1.C161_LD' },
      { a: 'ins-dc-power.V5N', b: 'cn1.GND' },
      { a: 'cn1.CLK_OUT', b: 'cn1.C161_CP' },
      { a: 'cn1.C161_Q0', b: 'cn1.DISP_A' },
      { a: 'cn1.C161_Q1', b: 'cn1.FB_A' },
      { a: 'cn1.C161_Q1', b: 'cn1.DISP_B' },
      { a: 'cn1.C161_Q2', b: 'cn1.FB_B' },
      { a: 'cn1.C161_Q2', b: 'cn1.DISP_C' },
      { a: 'cn1.C161_Q3', b: 'cn1.DISP_D' },
      { a: 'cn1.FB_Y', b: 'cn1.C161_CLR' },
      { a: 'scope1.CH1', b: 'cn1.C161_CP' },
      { a: 'scope1.CH2', b: 'cn1.C161_Q2' },
      { a: 'scope1.GND', b: 'cn1.GND' },
    ]
    const rClear = await runDigital(
      {
        title: 'SD-12 mod6 clear',
        modules: [{ instanceId: 'cn1', module: modCntN, subckt: cirCntN }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.2 })],
        wires: wClear,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'cn1.CLK_RATE': 10 },
        analysis: [],
      },
      1.8,
      { settleSec: 0.02, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'wire', rClear.plan)
    expect(rClear.segSequence('cn1', 'DISP_N').slice(0, 7)).toEqual(['0', '1', '2', '3', '4', '5', '0'])
    expect(rClear.freq('scope:scope1:CH2')).toBeGreaterThan(1.55)
    expect(rClear.freq('scope:scope1:CH2')).toBeLessThan(1.8)

    // 同步反馈置数法（LD_VAL=10 -> 模 6，f_RCO ≈ 1.67 Hz）
    const wPreset = [
      { a: 'ins-dc-power.V5P', b: 'cn1.VCC' },
      { a: 'ins-dc-power.V5P', b: 'cn1.C161_CLR' },
      { a: 'ins-dc-power.V5N', b: 'cn1.GND' },
      { a: 'cn1.CLK_OUT', b: 'cn1.C161_CP' },
      { a: 'cn1.C161_RCO', b: 'cn1.FB_A' },
      { a: 'cn1.C161_RCO', b: 'cn1.FB_B' },
      { a: 'cn1.FB_Y', b: 'cn1.C161_LD' },
      { a: 'cn1.C161_Q0', b: 'cn1.DISP_A' },
      { a: 'cn1.C161_Q1', b: 'cn1.DISP_B' },
      { a: 'cn1.C161_Q2', b: 'cn1.DISP_C' },
      { a: 'cn1.C161_Q3', b: 'cn1.DISP_D' },
      { a: 'scope1.CH1', b: 'cn1.C161_CP' },
      { a: 'scope1.CH2', b: 'cn1.C161_RCO' },
      { a: 'scope1.GND', b: 'cn1.GND' },
    ]
    const rPreset = await runDigital(
      {
        title: 'SD-12 mod6 preset',
        modules: [{ instanceId: 'cn1', module: modCntN, subckt: cirCntN }],
        instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.2 })],
        wires: wPreset,
        ground: 'ins-dc-power.V5N',
        controlValues: { 'cn1.CLK_RATE': 10, 'cn1.LD_VAL': 10 },
        analysis: [],
      },
      3.5,
      { settleSec: 1.6, stepOverride: 0.002 },
    )
    assertWiringClean(project, 'mod6_preset', rPreset.plan)
    expect(rPreset.freq('scope:scope1:CH2')).toBeGreaterThan(1.55)
    expect(rPreset.freq('scope:scope1:CH2')).toBeLessThan(1.8)

    // 3 项预设故障六步闭环（含反馈断线退化为十六进制、ENP 停振、/CLR 短路）
    const faults = defined(project.faults, 'SD-12 faults')
    expect(faults).toHaveLength(3)
    for (const fault of faults) {
      const bad = await runDigital(
        {
          title: `SD-12 bad ${fault.id}`,
          modules: [{ instanceId: 'cn1', module: modCntN, subckt: cirCntN }],
          instruments: [defaultIns('ins-dc-power', dcPower), defaultIns('scope1', scope, { timebase: 0.2 })],
          wires: wClear,
          ground: 'ins-dc-power.V5N',
          controlValues: { 'cn1.CLK_RATE': 10 },
          fault,
          analysis: [],
        },
        2.0,
        { settleSec: 0.05, stepOverride: 0.002 },
      )
      const fBad = bad.freq('scope:scope1:CH2')
      if (fault.id === 'flt-fb-open') {
        expect(fBad).toBeGreaterThan(1.1)
        expect(fBad).toBeLessThan(1.4) // 退化为十六进制 -> f_Q2 = f_CLK/8 = 1.25 Hz
      } else {
        expect(fBad).toBeLessThan(0.2) // 停滞于 0
      }

      runFaultClosedLoop(project, fault, bad.snapshot, rClear.snapshot)
    }
  }, 30_000)
})
