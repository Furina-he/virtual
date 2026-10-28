import type { AssembleInput } from '../../domain/circuit/assemble'
import { checkInstrumentJacks, isSelfPoweredMode, readInstrument, rms } from '../../domain/instruments'
import {
  buildMeasurementPlan,
  METER_RMS_WINDOW,
  METER_SAMPLE_STEP,
  type MeasurementPlan,
} from '../../domain/measurement/plan'
import { detectDanger } from '../../domain/wiring-check'
import type { SimEvent } from '../../shared/ipc/sim'
import type { CircuitState } from '../../shared/schema/circuit'
import { benchInstruments, setBenchInstrumentSettings } from '../features/practice/instrument-settings'
import { moduleCatalog, moduleNetlist } from '../features/practice/practice-content'
import { circuitStore, getActivePlacements } from '../features/practice/wiring-state'
import { connectInstrumentPanels } from '../stores/instrument-panels'
import { clearInstrumentReadings, type InstrumentReading, setInstrumentReading } from './instrument-readings'
import { getSimClient } from './sim-client'

const blank = (status: InstrumentReading['status'], message: string, unit = ''): InstrumentReading => ({
  text: '--.---',
  unit,
  status,
  message,
  beep: false,
})

export function benchCircuitInput(state: CircuitState = circuitStore.getState()): AssembleInput {
  return {
    title: 'Learner instrument circuit',
    modules: getActivePlacements().flatMap(({ instanceId, assetId }) => {
      const module = moduleCatalog.find((entry) => entry.id === assetId)
      return module ? [{ instanceId, module, subckt: moduleNetlist(module) }] : []
    }),
    instruments: benchInstruments(state),
    wires: state.wires,
    controlValues: state.controlValues,
    analysis: [],
  }
}

type RuntimeStatus = { state: 'off' | 'pending' | 'ready' | 'protected' | 'error'; message: string }
type RuntimeJob = {
  revision: number
  input: AssembleInput
  powered: boolean
  plan: MeasurementPlan
  preflight: boolean
  external: Record<string, number>
}

/** One producer owns measurements and the continuity tone, including when panels are popped out. */
export function connectInstrumentRuntime(onStatus: (status: RuntimeStatus) => void): () => void {
  const sim = getSimClient()
  let revision = 0
  let job: RuntimeJob | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let previousState = circuitStore.getState()
  let disposed = false
  let protecting = false
  let ownsSession = false
  let audio: AudioContext | undefined
  let oscillator: OscillatorNode | undefined
  let gain: GainNode | undefined
  let sounding = false
  let lastStatus = ''
  const samples = new Float32Array(Math.round(METER_RMS_WINDOW / METER_SAMPLE_STEP))

  function status(state: RuntimeStatus['state'], message: string) {
    const key = `${state}:${message}`
    if (key === lastStatus) return
    lastStatus = key
    onStatus({ state, message })
  }

  function beep(on: boolean) {
    if (on === sounding) return
    sounding = on
    if (on && !audio) {
      audio = new AudioContext()
      oscillator = new OscillatorNode(audio, { type: 'sine', frequency: 2400 })
      gain = new GainNode(audio, { gain: 0 })
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start()
    }
    if (audio && gain) {
      if (on) void audio.resume().catch(() => {})
      gain.gain.setTargetAtTime(on ? 0.025 : 0, audio.currentTime, 0.008)
    }
  }

  function clearDisplays(input: AssembleInput, reading: InstrumentReading) {
    clearInstrumentReadings()
    for (const entry of input.instruments) {
      if (entry.instrument.kind === 'dcSupply') {
        for (const [index] of (entry.instrument.outputs ?? []).entries())
          setInstrumentReading(entry.instanceId, reading, `CH${index + 1}`)
      } else setInstrumentReading(entry.instanceId, reading)
    }
  }

  function invalidate() {
    revision++
    job = undefined
    clearTimeout(timer)
    clearTimeout(timeout)
    beep(false)
  }

  function failure(message: string) {
    if (disposed) return
    invalidate()
    if (ownsSession) void sim.send({ type: 'pause' }).catch(() => {})
    ownsSession = false
    clearDisplays(benchCircuitInput(), blank('error', message))
    status('error', message)
    protecting = true
    circuitStore.setState({ powered: false, pendingJack: null, notice: message })
    protecting = false
  }

  function start(next: RuntimeJob) {
    if (disposed || next.revision !== revision) return
    job = next
    ownsSession = true
    clearTimeout(timeout)
    timeout = setTimeout(() => failure('仿真未及时返回读数。请断电后重试，并检查接线。'), 8000)
    void sim
      .send(next.plan.command)
      .then(() => {
        if (!disposed && job === next && next.plan.command.analysis.kind === 'tran') return sim.send({ type: 'run' })
      })
      .catch(() => {
        // A superseded load may reject after a newer circuit revision started.
        if (!disposed && job === next && next.revision === revision) failure('无法发送仪表仿真请求。请断电后重试。')
      })
  }

  function update() {
    if (disposed || protecting) return
    invalidate()
    const state = circuitStore.getState()
    try {
      const input = benchCircuitInput(state)
      let plan = buildMeasurementPlan(input, state.powered, `m${revision}`)
      const wrong = plan.meters.find(
        (meter) => checkInstrumentJacks(meter.config, meter.connectedJacks)?.status === 'wrong-jacks',
      )
      const wrongIssue = wrong ? checkInstrumentJacks(wrong.config, wrong.connectedJacks) : undefined
      const danger = state.powered ? detectDanger(plan.checkInput)[0] : undefined
      if (state.powered && (danger || wrong)) {
        const message = danger
          ? danger.code === 'ammeter-across-source'
            ? '电流档并联在电源两端，已阻止上电。请先断电，把电流表串入支路后再测量。'
            : '电源输出被短接，已阻止上电。请断电后检查并拆除短接导线。'
          : (wrongIssue?.message ?? '当前档位与表笔插孔不匹配，请断电后调整接线。')
        if (ownsSession) void sim.send({ type: 'pause' }).catch(() => {})
        ownsSession = false
        clearDisplays(input, blank('error', message))
        if (wrongIssue && wrong) setInstrumentReading(wrong.instanceId, wrongIssue)
        status('protected', message)
        protecting = true
        circuitStore.setState({ powered: false, pendingJack: null, notice: message })
        protecting = false
        return
      }
      clearDisplays(input, blank(state.powered ? 'pending' : 'off', state.powered ? '等待仿真读数。' : '台面已断电。'))
      for (const meter of plan.meters) {
        const issue = checkInstrumentJacks(meter.config, meter.connectedJacks)
        if (issue) setInstrumentReading(meter.instanceId, { ...issue, mode: meter.config.mode.toUpperCase() })
      }
      if (!state.powered && !plan.needsPreflight) {
        if (ownsSession) void sim.send({ type: 'pause' }).catch(() => {})
        ownsSession = false
        status('off', '未运行')
        return
      }
      const preflight = plan.needsPreflight
      if (preflight) plan = buildMeasurementPlan(input, state.powered, `m${revision}p`, { preflight: true })
      status('pending', preflight ? '检查外部电压' : '正在计算')
      const next: RuntimeJob = { revision, input, powered: state.powered, plan, preflight, external: {} }
      timer = setTimeout(() => start(next), 40)
    } catch (error) {
      failure(error instanceof Error ? error.message : '无法建立仪表测量回路。请检查内容和接线。')
    }
  }

  function publish(current: RuntimeJob, values: Record<string, number>, transient: boolean) {
    let audible = false
    let warning = false
    let waiting = false
    for (const meter of current.plan.meters) {
      if (!current.powered && !isSelfPoweredMode(meter.config.mode)) continue
      const sample = {
        voltage: meter.voltageProbe ? values[meter.voltageProbe] : undefined,
        current: meter.currentProbe ? values[meter.currentProbe] : undefined,
        connectedJacks: meter.connectedJacks,
        externalVoltage: current.external[meter.instanceId],
        rmsVoltage: undefined as number | undefined,
        rmsCurrent: undefined as number | undefined,
      }
      if (transient && (meter.config.mode === 'acv' || meter.config.mode === 'aca')) {
        const id = meter.config.mode === 'acv' ? meter.voltageProbe : meter.currentProbe
        if (id) {
          const n = sim.buffer(id).copyLatest(samples)
          if (n < samples.length) {
            waiting = true
            setInstrumentReading(meter.instanceId, blank('pending', '正在采集交流有效值窗口。', meter.config.unit))
            continue
          }
          if (meter.config.mode === 'acv') sample.rmsVoltage = rms(samples)
          else sample.rmsCurrent = rms(samples)
        }
      }
      const reading = readInstrument(meter.config, sample)
      setInstrumentReading(meter.instanceId, { ...reading, mode: meter.config.mode.toUpperCase() })
      audible ||= reading.beep
      warning ||= reading.status === 'external-voltage'
    }
    for (const supply of current.plan.supplies) {
      if (!current.powered) continue
      const value = values[supply.voltageProbe]
      if (value === undefined || !Number.isFinite(value)) continue
      const { resolution, displayScale, unit } = supply.range
      const rounded = Math.round(value / resolution) * resolution
      setInstrumentReading(
        supply.instanceId,
        {
          text: (rounded / displayScale).toFixed(Math.max(0, -Math.floor(Math.log10(resolution / displayScale)))),
          unit,
          status: 'ok',
          value: rounded,
          rawValue: value,
          mode: 'DC',
        },
        supply.screenId,
      )
    }
    beep(audible)
    status(
      warning ? 'protected' : waiting ? 'pending' : 'ready',
      warning ? '带电回路：表内测试源已关闭' : waiting ? '采集有效值窗口' : transient ? '实时测量' : '直流工作点已更新',
    )
  }

  const offEvents = sim.onEvent((event: Exclude<SimEvent, { type: 'chunk' }>) => {
    const current = job
    if (!current || current.revision !== revision || disposed) return
    if (event.type === 'error') {
      failure(event.message)
      return
    }
    if (event.type !== 'op' && event.type !== 'readings') return
    if (!current.plan.command.probes.every((probe) => Object.hasOwn(event.values, probe.id))) return
    clearTimeout(timeout)
    if (current.preflight && event.type === 'op') {
      const blocked = new Set<string>()
      for (const meter of current.plan.meters) {
        if (!isSelfPoweredMode(meter.config.mode) || !meter.voltageProbe) continue
        const external = event.values[meter.voltageProbe]
        if (external === undefined) continue
        current.external[meter.instanceId] = external
        if (!Number.isFinite(external) || Math.abs(external) >= (meter.config.testSource?.safetyVoltage ?? 0))
          blocked.add(meter.instanceId)
      }
      const plan = buildMeasurementPlan(current.input, current.powered, `m${revision}a`, { blockedTestIds: blocked })
      start({ ...current, plan, preflight: false })
      return
    }
    publish(current, event.values, event.type === 'readings' && current.plan.command.analysis.kind === 'tran')
  })
  const offRestart = sim.onRestarted(() => {
    if (ownsSession) update()
  })
  const offState = circuitStore.subscribe((state) => {
    const changed =
      state.powered !== previousState.powered ||
      state.wires !== previousState.wires ||
      state.placedInstruments !== previousState.placedInstruments ||
      state.controlValues !== previousState.controlValues
    previousState = state
    if (changed) update()
  })
  const offPanels = connectInstrumentPanels({
    getSnapshot: () => ({
      panels: benchInstruments().map(({ instanceId, instrument, settings }) => ({
        id: instanceId,
        title: instrument.name,
        instrument,
        settings,
      })),
      powered: circuitStore.getState().powered,
    }),
    subscribe: (listener) => circuitStore.subscribe(listener),
    setSettings: setBenchInstrumentSettings,
  })
  update()
  return () => {
    disposed = true
    invalidate()
    offEvents()
    offRestart()
    offState()
    offPanels()
    if (ownsSession) void sim.send({ type: 'pause' }).catch(() => {})
    oscillator?.stop()
    if (audio) void audio.close()
  }
}
