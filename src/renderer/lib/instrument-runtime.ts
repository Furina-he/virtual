import type { AssembleInput, InstrumentInput } from '../../domain/circuit/assemble'
import {
  adjustableSources,
  checkInstrumentJacks,
  formatFrequency,
  formatVoltage,
  isSelfPoweredMode,
  measureSignal,
  readInstrument,
  resolveScope,
  resolveSource,
  WAVEFORM_LABEL,
} from '../../domain/instruments'
import { RmsWindow } from '../../domain/instruments/rms-window'
import {
  buildMeasurementPlan,
  METER_RMS_WINDOW,
  type MeasurementPlan,
  moduleControlChanges,
  sameSimulation,
} from '../../domain/measurement/plan'
import type { MeasurementSnapshot, WaveformReading } from '../../domain/task'
import { detectDanger } from '../../domain/wiring-check'
import type { SimEvent } from '../../shared/ipc/sim'
import type { CircuitState } from '../../shared/schema/circuit'
import { benchInstruments, setBenchInstrumentSettings } from '../features/practice/instrument-settings'
import { moduleCatalog, moduleNetlist } from '../features/practice/practice-content'
import { circuitStore, getActivePlacements } from '../features/practice/wiring-state'
import { connectInstrumentPanels } from '../stores/instrument-panels'
import {
  clearInstrumentReadings,
  getInstrumentReading,
  type InstrumentReading,
  setInstrumentReading,
} from './instrument-readings'
import { createModuleAudio } from './module-audio'
import { getSimClient } from './sim-client'

const blank = (status: InstrumentReading['status'], message: string, unit = ''): InstrumentReading => ({
  text: '--.---',
  unit,
  status,
  message,
  beep: false,
})

/** 信号发生器屏幕：显示当前选中通道的设定值（设定值显示，不是测量值） */
export function generatorReading(
  { instrument, settings }: InstrumentInput,
  powered: boolean,
): InstrumentReading | undefined {
  const sources = adjustableSources(instrument)
  if (!sources.length || instrument.scope) return undefined
  const selected = typeof settings.display_ch === 'number' ? settings.display_ch : 0
  const source = sources[selected] ?? sources[0]
  if (!source) return undefined
  const resolved = resolveSource(instrument, settings, source)
  const frequency = formatFrequency(resolved.frequency)
  const amplitude =
    resolved.waveform === 'ttl' ? 'TTL' : `${formatVoltage(resolved.amplitude)}pp ${formatVoltage(resolved.offset)}`
  return {
    text: frequency.text,
    unit: frequency.unit,
    status: powered ? 'ok' : 'off',
    label: !powered ? '已断电' : resolved.enabled ? '输出开' : '输出关',
    mode: `${source.label} ${WAVEFORM_LABEL[resolved.waveform]} ${amplitude}`,
    value: resolved.frequency,
  }
}

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

let measurementSnapshotReader: (() => MeasurementSnapshot | undefined) | undefined

/** Capture synchronously from the current job, never from the delayed UI view. */
export function currentMeasurementSnapshot(): MeasurementSnapshot | undefined {
  return measurementSnapshotReader?.()
}

/** One producer owns measurements and the continuity tone, including when panels are popped out. */
export function connectInstrumentRuntime(onStatus: (status: RuntimeStatus) => void): () => void {
  const sim = getSimClient()
  let revision = 0
  let job: RuntimeJob | undefined
  let publishedJob: RuntimeJob | undefined
  let parameterRequest = 0
  const parameterRequests = new Set<string>()
  let pendingAlter: { requestId: string; afterTime?: number } | undefined
  let waveformAfterTime = Number.NEGATIVE_INFINITY
  const waveformBoundary = new Map<string, number>()
  let moduleAudio: ReturnType<typeof createModuleAudio> | undefined
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
  const rmsWindows = new Map<string, RmsWindow>()
  const waveformScratch = new Float32Array(65_536)
  let offMeterSamples: (() => void)[] = []
  const snapshotReader = (): MeasurementSnapshot | undefined =>
    job
      ? {
          current:
            !disposed &&
            !pendingAlter &&
            !job.preflight &&
            job === publishedJob &&
            job.powered === circuitStore.getState().powered,
          plan: job.plan,
          readings: Object.fromEntries(
            job.plan.meters.map((meter) => [meter.instanceId, getInstrumentReading(meter.instanceId)]),
          ),
          waveforms: snapshotWaveforms(job),
        }
      : undefined
  measurementSnapshotReader = snapshotReader

  function snapshotWaveforms(current: RuntimeJob): WaveformReading[] {
    return current.plan.scopes.flatMap((scope) => {
      const input = current.input.instruments.find((entry) => entry.instanceId === scope.instanceId)
      if (!input?.instrument.scope) return []
      const settings = resolveScope(input.instrument, input.settings)
      const channelSamples = new Map<string, { samples: Float32Array; dt: number; lastTime: number }>()
      const captured = scope.channels.flatMap((channel, index) => {
        const configured = input.instrument.scope?.channels[index]
        const displayed = settings.channels[index]
        if (!configured || !displayed) return []
        const allowed =
          !!channel.probe &&
          channel.groundWired &&
          displayed.enabled &&
          settings.running &&
          displayed.coupling !== 'gnd' &&
          current.powered &&
          !pendingAlter &&
          current === publishedJob
        let measurement: ReturnType<typeof measureSignal> = null
        if (allowed && channel.probe) {
          const buffer = sim.buffer(channel.probe)
          const available = Number.isFinite(waveformAfterTime)
            ? Math.max(0, Math.ceil((buffer.lastTime - waveformAfterTime) / buffer.dt))
            : buffer.length
          const count = Math.min(waveformScratch.length, buffer.length, available)
          const retained = Math.min(count, Math.max(0, buffer.written - (waveformBoundary.get(channel.probe) ?? 0)))
          if (retained > 1 && buffer.dt > 0) {
            const samples = waveformScratch.subarray(0, retained)
            buffer.copyLatest(samples)
            measurement = measureSignal(samples, buffer.dt)
            channelSamples.set(channel.id, { samples: samples.slice(), dt: buffer.dt, lastTime: buffer.lastTime })
          }
        }
        return [
          {
            instanceId: scope.instanceId,
            channelId: channel.id,
            positiveRef: `${scope.instanceId}.${configured.positiveJack}`,
            negativeRef: `${scope.instanceId}.${configured.negativeJack}`,
            coupling: displayed.coupling,
            current: allowed && measurement !== null,
            measurement,
          },
        ]
      })
      const difference = captured.flatMap((positive) =>
        captured.flatMap((negative) => {
          if (
            positive.channelId === negative.channelId ||
            !positive.current ||
            !negative.current ||
            positive.coupling !== 'dc' ||
            negative.coupling !== 'dc' ||
            positive.negativeRef !== negative.negativeRef
          )
            return []
          const a = channelSamples.get(positive.channelId)
          const b = channelSamples.get(negative.channelId)
          if (!a || !b || a.dt !== b.dt || Math.abs(a.lastTime - b.lastTime) > a.dt * 1e-6) return []
          const count = Math.min(a.samples.length, b.samples.length)
          const data = new Float32Array(count)
          for (let i = 0; i < count; i++)
            data[i] =
              (a.samples[a.samples.length - count + i] as number) - (b.samples[b.samples.length - count + i] as number)
          const measurement = measureSignal(data, a.dt)
          return [
            {
              ...positive,
              channelId: `${positive.channelId}-${negative.channelId}`,
              negativeRef: negative.positiveRef,
              current: measurement !== null,
              measurement,
            },
          ]
        }),
      )
      return [...captured, ...difference]
    })
  }

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
      for (const channel of entry.instrument.scope?.channels ?? [])
        setInstrumentReading(entry.instanceId, reading, channel.id)
    }
  }

  function showGenerators(input: AssembleInput, powered: boolean) {
    for (const entry of input.instruments) {
      const reading = generatorReading(entry, powered)
      if (reading) setInstrumentReading(entry.instanceId, reading)
    }
  }

  function showScopes(input: AssembleInput, plan: MeasurementPlan, powered: boolean, collecting: boolean) {
    if (!powered) return
    for (const entry of input.instruments) {
      const config = entry.instrument.scope
      if (!config) continue
      const scope = plan.scopes.find((item) => item.instanceId === entry.instanceId)
      const live = scope?.channels.some((channel) => channel.probe)
      const active = collecting
        ? { text: '', unit: '', status: 'ok' as const, label: '采集中' }
        : blank('pending', '等待仿真读数。')
      setInstrumentReading(
        entry.instanceId,
        live ? active : blank('disconnected', '请将被测信号接入 CH1 或 CH2，并把 GND 接到被测电路的参考端。'),
      )
      for (const channel of config.channels) {
        const connection = scope?.channels.find((item) => item.id === channel.id)
        setInstrumentReading(
          entry.instanceId,
          connection?.probe
            ? {
                ...active,
                ...(connection.groundWired
                  ? {}
                  : { message: `${channel.id} 的 GND 未接线，读数以示波器自身地为参考。` }),
              }
            : blank('disconnected', `${channel.id} 未接线。`),
          channel.id,
        )
      }
    }
  }

  function clearRms() {
    for (const off of offMeterSamples) off()
    offMeterSamples = []
    rmsWindows.clear()
  }

  function invalidate() {
    revision++
    job = undefined
    publishedJob = undefined
    pendingAlter = undefined
    parameterRequests.clear()
    waveformAfterTime = Number.NEGATIVE_INFINITY
    waveformBoundary.clear()
    moduleAudio?.dispose()
    moduleAudio = undefined
    clearTimeout(timer)
    clearTimeout(timeout)
    clearRms()
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
    clearRms()
    job = next
    publishedJob = undefined
    ownsSession = true
    if (next.plan.command.analysis.kind === 'tran') {
      for (const meter of next.plan.meters) {
        const probe =
          meter.config.mode === 'acv'
            ? meter.voltageProbe
            : meter.config.mode === 'aca'
              ? meter.currentProbe
              : undefined
        if (!probe || rmsWindows.has(probe)) continue
        const window = new RmsWindow(METER_RMS_WINDOW)
        rmsWindows.set(probe, window)
        offMeterSamples.push(sim.onSamples(probe, (data, t0, dt) => window.push(data, t0, dt)))
      }
    }
    const speakers =
      next.powered && !next.preflight && next.plan.command.analysis.kind === 'tran'
        ? createModuleAudio(sim, next.plan.speakers, next.plan.command.analysis.step)
        : undefined
    moduleAudio?.dispose()
    moduleAudio = speakers
    clearTimeout(timeout)
    timeout = setTimeout(() => failure('仿真未及时返回读数。请断电后重试，并检查接线。'), 8000)
    void sim
      .send(next.plan.command)
      .then(async () => {
        if (disposed || job !== next || next.plan.command.analysis.kind !== 'tran') return
        await speakers?.ready
        if (disposed || job !== next) return
        await sim.send(next.plan.pacing)
        if (!disposed && job === next) await sim.send({ type: 'run' })
      })
      .catch(() => {
        // A superseded load may reject after a newer circuit revision started.
        if (!disposed && job === next && next.revision === revision) failure('无法发送仪表仿真请求。请断电后重试。')
      })
  }

  function update(force = false) {
    if (disposed || protecting) return
    const state = circuitStore.getState()
    if (!force && job && !job.preflight && job.powered === state.powered) {
      try {
        const input = benchCircuitInput(state)
        const candidate = buildMeasurementPlan(input, state.powered, `m${revision}`)
        const changes = moduleControlChanges(job.plan, candidate)
        if (changes?.length && state.powered) {
          const current = job
          const requestId = `module-${revision}-${++parameterRequest}`
          current.input = input
          current.plan = candidate
          publishedJob = undefined
          pendingAlter = { requestId }
          parameterRequests.add(requestId)
          status('pending', '正在更新模块参数')
          clearTimeout(timeout)
          timeout = setTimeout(() => failure('模块参数未及时更新。请断电后重试。'), 8000)
          void sim.send({ type: 'alter', requestId, changes }).catch(() => {
            if (!disposed && job === current && pendingAlter?.requestId === requestId)
              failure('无法更新模块参数。请断电后重试。')
          })
          return
        }
        if (sameSimulation(candidate, job.plan)) {
          job.input = input
          showGenerators(input, state.powered)
          return
        }
      } catch {
        // 完整更新会报告同一错误
      }
    }
    invalidate()
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
      showGenerators(input, state.powered)
      showScopes(input, plan, state.powered, false)
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
          // Aggregate complete raw-sample windows without depending on waveform history capacity.
          const value = rmsWindows.get(id)?.value
          if (value === undefined) {
            waiting = true
            setInstrumentReading(meter.instanceId, blank('pending', '正在采集交流有效值窗口。', meter.config.unit))
            continue
          }
          if (meter.config.mode === 'acv') sample.rmsVoltage = value
          else sample.rmsCurrent = value
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
    showScopes(current.input, current.plan, current.powered, true)
    publishedJob = current
    beep(audible)
    status(
      warning ? 'protected' : waiting ? 'pending' : 'ready',
      warning ? '带电回路：表内测试源已关闭' : waiting ? '采集有效值窗口' : transient ? '实时测量' : '直流工作点已更新',
    )
  }

  const offEvents = sim.onEvent((event: Exclude<SimEvent, { type: 'chunk' }>) => {
    const current = job
    if (!current || current.revision !== revision || disposed) return
    if (event.type === 'loaded') {
      publishedJob = undefined
      waveformAfterTime = Number.NEGATIVE_INFINITY
      waveformBoundary.clear()
      for (const window of rmsWindows.values()) window.clear()
      return
    }
    if (event.type === 'altered') {
      if (event.requestId) parameterRequests.delete(event.requestId)
      if (event.requestId !== pendingAlter?.requestId) return
      pendingAlter = { requestId: event.requestId as string, afterTime: event.simTime }
      waveformAfterTime = event.simTime
      waveformBoundary.clear()
      for (const scope of current.plan.scopes) {
        for (const channel of scope.channels) {
          if (channel.probe) waveformBoundary.set(channel.probe, sim.buffer(channel.probe).written)
        }
      }
      for (const window of rmsWindows.values()) window.clear()
      return
    }
    if (event.type === 'error') {
      if (event.requestId && event.requestId !== pendingAlter?.requestId && !parameterRequests.has(event.requestId))
        return
      failure(event.message)
      return
    }
    if (event.type !== 'op' && event.type !== 'readings') return
    if (pendingAlter) {
      if (
        pendingAlter.afterTime === undefined ||
        (event.type === 'readings' && event.simTime <= pendingAlter.afterTime)
      )
        return
      pendingAlter = undefined
    }
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
    if (ownsSession) update(true)
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
    if (measurementSnapshotReader === snapshotReader) measurementSnapshotReader = undefined
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
