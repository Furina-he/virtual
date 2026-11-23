import type { AssembleInput, InstrumentInput } from '../../domain/circuit/assemble'
import {
  adjustableSources,
  checkInstrumentJacks,
  classifyCurrentSource,
  classifyDcChannel,
  formatFrequency,
  formatVoltage,
  isSelfPoweredMode,
  measureSignal,
  PowerWindow,
  readInstrument,
  resolveAcSupply,
  resolveScope,
  resolveSource,
  WAVEFORM_LABEL,
} from '../../domain/instruments'
import { LONG_WINDOW_SECONDS, type LongWindowSnapshot } from '../../domain/instruments/long-window'
import { RmsWindow } from '../../domain/instruments/rms-window'
import type { SignalMeasurement } from '../../domain/instruments/scope'
import { formatRealtimeRatio, type SimulationPace, SimulationPaceMonitor } from '../../domain/measurement/pace'
import {
  buildMeasurementPlan,
  METER_RMS_WINDOW,
  type MeasurementPlan,
  moduleControlChanges,
  sameSimulation,
} from '../../domain/measurement/plan'
import type { MeasurementSnapshot, WaveformReading } from '../../domain/task'
import type { WaveformWindow } from '../../domain/task/measurements'
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
import { acquireScope, resetScopeAcquisition } from './scope-acquisition'
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

export type RuntimeStatus = {
  state: 'off' | 'pending' | 'ready' | 'protected' | 'error'
  message: string
  pace?: SimulationPace
}
const PACE_PUBLISH_INTERVAL_MS = 500
type RuntimeJob = {
  revision: number
  input: AssembleInput
  powered: boolean
  plan: MeasurementPlan
  preflight: boolean
  external: Record<string, number>
}
type ScopeSampleState = { dt: number; nextTime: number; lastTime: number; points: number }

type SnapshotReader = (windowSeconds?: readonly number[]) => MeasurementSnapshot | undefined
let measurementSnapshotReader: SnapshotReader | undefined

function validateWindowSeconds(windowSeconds: readonly number[]): number[] {
  const unique = new Set<number>()
  for (const seconds of windowSeconds) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > LONG_WINDOW_SECONDS)
      throw new RangeError(`Observation window must be finite and in (0, ${LONG_WINDOW_SECONDS}]`)
    unique.add(seconds)
  }
  return [...unique].sort((a, b) => a - b)
}

function snapshotWindow(
  snapshot: LongWindowSnapshot,
  seconds: number,
  revision: number,
): {
  measurement: SignalMeasurement | null
  window: WaveformWindow
  complete: boolean
} {
  const window: WaveformWindow = {
    ...snapshot.window,
    source: 'stream',
    revision,
    frozen: false,
  }
  const covered =
    Number.isFinite(window.start) &&
    Number.isFinite(window.end) &&
    Number.isFinite(window.rawStep) &&
    window.rawStep > 0 &&
    window.end + window.rawStep >= window.start + seconds - Math.max(1e-9, seconds * 1e-9)
  return { measurement: snapshot.measurement, window, complete: covered }
}

function rawMeasurement(data: Float32Array, dt: number): SignalMeasurement | null {
  const measured = measureSignal(data, dt)
  if (!measured) return null
  let sum = 0
  for (const value of data) sum += value
  // Requested DC statistics must describe this exact tail, not measureSignal's cycle-only mean.
  return { ...measured, mean: sum / data.length }
}

/** Capture synchronously from the current job, never from the delayed UI view. */
export function currentMeasurementSnapshot(windowSeconds: readonly number[] = []): MeasurementSnapshot | undefined {
  return measurementSnapshotReader?.(windowSeconds)
}

/** One producer owns measurements and the continuity tone, including when panels are popped out. */
export function connectInstrumentRuntime(onStatus: (status: RuntimeStatus) => void): () => void {
  const sim = getSimClient()
  let revision = 0
  let job: RuntimeJob | undefined
  let publishedJob: RuntimeJob | undefined
  let parameterRequest = 0
  let loadBoundary: { requestId: string; applied: boolean; resolve: () => void } | undefined
  const parameterRequests = new Set<string>()
  let pendingAlter: { requestId: string; afterTime?: number } | undefined
  let requestedPaused = false
  let requestedResumeAfter: number | undefined
  let waveformAfterTime = Number.NEGATIVE_INFINITY
  const waveformBoundary = new Map<string, number>()
  const scopeContinuity = new Map<string, ScopeSampleState>()
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
  let lastStatusState: RuntimeStatus['state'] = 'off'
  let lastStatusMessage = '未运行'
  let lastSlow = false
  let lastRatioText = ''
  let lastPacePublishedAt = Number.NEGATIVE_INFINITY
  const paceMonitor = new SimulationPaceMonitor()
  const rmsWindows = new Map<string, RmsWindow>()
  const powerWindows = new Map<string, PowerWindow>()
  const waveformScratch = new Float32Array(65_536)
  let offMeterSamples: (() => void)[] = []
  let offScopeSamples: (() => void)[] = []
  const snapshotReader = (requestedSeconds: readonly number[] = []): MeasurementSnapshot | undefined =>
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
          waveforms: snapshotWaveforms(job, validateWindowSeconds(requestedSeconds)),
        }
      : undefined
  measurementSnapshotReader = snapshotReader

  function resetScopeContinuity(current?: RuntimeJob): void {
    for (const off of offScopeSamples) off()
    offScopeSamples = []
    scopeContinuity.clear()
    if (!current || typeof sim.onSamples !== 'function') return
    const probes = new Set(
      current.plan.scopes.flatMap((scope) =>
        scope.channels.flatMap((channel) => (channel.probe ? [channel.probe] : [])),
      ),
    )
    for (const probe of probes) {
      offScopeSamples.push(
        sim.onSamples(probe, (samples, t0, dt) => {
          const previous = scopeContinuity.get(probe)
          const tolerance = Math.max(
            dt * 1e-6,
            4 * Number.EPSILON * Math.max(dt, Math.abs(t0), Math.abs(previous?.nextTime ?? t0)),
          )
          const continuous =
            previous !== undefined && previous.dt === dt && Math.abs(t0 - previous.nextTime) <= tolerance
          const points = continuous
            ? Math.min(waveformScratch.length, previous.points + samples.length)
            : samples.length
          scopeContinuity.set(probe, {
            dt,
            nextTime: t0 + samples.length * dt,
            lastTime: t0 + (samples.length - 1) * dt,
            points,
          })
        }),
      )
    }
  }

  function snapshotWaveforms(current: RuntimeJob, requestedSeconds: readonly number[] = []): WaveformReading[] {
    return current.plan.scopes.flatMap((scope) => {
      const input = current.input.instruments.find((entry) => entry.instanceId === scope.instanceId)
      if (!input?.instrument.scope) return []
      const settings = resolveScope(input.instrument, input.settings)
      const frame = acquireScope(
        scope.instanceId,
        input.instrument,
        input.settings,
        performance.now(),
        (id) => sim.buffer(id),
        typeof sim.observation === 'function' ? (id) => sim.observation(id) : undefined,
      )
      const channelSamples = new Map<string, { samples: Float32Array; dt: number; lastTime: number }>()
      const probeByChannel = new Map(
        scope.channels.flatMap((channel) => (channel.probe ? [[channel.id, channel.probe] as const] : [])),
      )
      const streamCache = new Map<string, Map<number, ReturnType<typeof snapshotWindow>>>()
      const requestedCaptured: WaveformReading[] = []
      const streamSnapshot = (probe: string, seconds: number) => {
        let byWindow = streamCache.get(probe)
        if (!byWindow) {
          byWindow = new Map()
          streamCache.set(probe, byWindow)
        }
        const cached = byWindow.get(seconds)
        if (cached) return cached
        const observation = typeof sim.observation === 'function' ? sim.observation(probe) : undefined
        const result = observation
          ? snapshotWindow(observation.snapshot(seconds), seconds, current.revision)
          : undefined
        if (result) byWindow.set(seconds, result)
        return result
      }
      const captured = scope.channels.flatMap((channel, index) => {
        const configured = input.instrument.scope?.channels[index]
        const displayed = settings.channels[index]
        if (!configured || !displayed) return []
        const allowed =
          !!channel.probe &&
          channel.groundWired &&
          displayed.enabled &&
          settings.running &&
          !(settings.trigger.mode === 'single' && frame.state === 'stopped') &&
          displayed.coupling !== 'gnd' &&
          current.powered &&
          !pendingAlter &&
          current === publishedJob
        let measurement: ReturnType<typeof measureSignal> = null
        let window: WaveformWindow | undefined
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
            window = {
              start: buffer.lastTime - (retained - 1) * buffer.dt,
              end: buffer.lastTime,
              rawStep: buffer.dt,
              completeCycles: measurement?.completeCycles ?? 0,
              source: 'raw',
              revision: current.revision,
              frozen: false,
            }
            channelSamples.set(channel.id, { samples: samples.slice(), dt: buffer.dt, lastTime: buffer.lastTime })
          }
          if (typeof sim.observation === 'function') {
            const seconds = Math.min(
              LONG_WINDOW_SECONDS,
              Math.max(settings.secondsPerDiv * settings.config.divisions.x * 2, 0.2),
            )
            const stream = streamSnapshot(channel.probe, seconds)
            const extended = stream ? { measurement: stream.measurement, window: stream.window } : undefined
            if (
              extended?.measurement &&
              extended.window.completeCycles >= 2 &&
              extended.window.completeCycles > (measurement?.completeCycles ?? 0)
            ) {
              measurement = extended.measurement
              window = extended.window
            }
            if (
              settings.secondsPerDiv * settings.config.divisions.x > buffer.capacity * buffer.dt &&
              extended?.measurement
            ) {
              measurement = extended.measurement
              window = extended.window
            }
          }
        }
        const base: WaveformReading = {
          instanceId: scope.instanceId,
          channelId: channel.id,
          positiveRef: `${scope.instanceId}.${configured.positiveJack}`,
          negativeRef: `${scope.instanceId}.${configured.negativeJack}`,
          coupling: displayed.coupling,
          current: allowed && measurement !== null,
          measurement,
          ...(window ? { window } : {}),
        }
        const requested = requestedSeconds.map((seconds) => {
          const identity = {
            instanceId: scope.instanceId,
            channelId: channel.id,
            positiveRef: `${scope.instanceId}.${configured.positiveJack}`,
            negativeRef: `${scope.instanceId}.${configured.negativeJack}`,
            coupling: displayed.coupling,
            requestedWindowSec: seconds,
          }
          const bounded = channel.probe ? streamSnapshot(channel.probe, seconds) : undefined
          const sourceBuffer = channel.probe ? sim.buffer(channel.probe) : undefined
          const alignmentTolerance = sourceBuffer ? Math.max(sourceBuffer.dt * 1e-6, 1e-12) : 0
          const aligned = Boolean(
            bounded?.window &&
              sourceBuffer &&
              bounded.window.rawStep === sourceBuffer.dt &&
              Math.abs(bounded.window.end - sourceBuffer.lastTime) <= alignmentTolerance,
          )
          const resumed = Boolean(
            requestedResumeAfter === undefined ||
              (bounded?.window !== undefined && bounded.window.start >= requestedResumeAfter - alignmentTolerance),
          )
          const usable =
            allowed &&
            !requestedPaused &&
            bounded?.complete === true &&
            bounded?.measurement !== null &&
            aligned &&
            resumed &&
            !(settings.trigger.mode === 'single' && frame.state === 'stopped')
          return {
            ...identity,
            current: usable,
            measurement: usable ? (bounded?.measurement ?? null) : null,
            ...(bounded?.window ? { window: bounded.window } : {}),
            ...(usable && bounded?.measurement ? { statistics: bounded.measurement } : {}),
          } satisfies WaveformReading
        })
        requestedCaptured.push(...requested)
        return [base]
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
              instanceId: positive.instanceId,
              channelId: `${positive.channelId}-${negative.channelId}`,
              positiveRef: positive.positiveRef,
              negativeRef: negative.positiveRef,
              coupling: positive.coupling,
              current: measurement !== null,
              measurement,
              window: {
                start: a.lastTime - (count - 1) * a.dt,
                end: a.lastTime,
                rawStep: a.dt,
                completeCycles: measurement?.completeCycles ?? 0,
                source: 'raw' as const,
                revision: current.revision,
                frozen: false,
              },
            },
          ]
        }),
      )
      const requestedDifference = requestedSeconds.flatMap((seconds) =>
        requestedCaptured.flatMap((positive) =>
          requestedCaptured.flatMap((negative) => {
            if (
              positive.channelId === negative.channelId ||
              positive.requestedWindowSec !== seconds ||
              negative.requestedWindowSec !== seconds ||
              positive.coupling !== 'dc' ||
              negative.coupling !== 'dc' ||
              positive.negativeRef !== negative.negativeRef
            )
              return []
            const a = channelSamples.get(positive.channelId)
            const b = channelSamples.get(negative.channelId)
            const identity: WaveformReading = {
              instanceId: positive.instanceId,
              channelId: `${positive.channelId}-${negative.channelId}`,
              positiveRef: positive.positiveRef,
              negativeRef: negative.positiveRef,
              coupling: positive.coupling,
              requestedWindowSec: seconds,
              current: false,
              measurement: null,
            }
            if (!a || !b || a.dt !== b.dt || Math.abs(a.lastTime - b.lastTime) > a.dt * 1e-6) return [identity]
            const count = Math.ceil(seconds / a.dt)
            const probeA = probeByChannel.get(positive.channelId)
            const probeB = probeByChannel.get(negative.channelId)
            const continuityA = probeA ? scopeContinuity.get(probeA) : undefined
            const continuityB = probeB ? scopeContinuity.get(probeB) : undefined
            const rawStart = a.lastTime - (count - 1) * a.dt
            if (
              count < 2 ||
              count > waveformScratch.length ||
              a.samples.length < count ||
              b.samples.length < count ||
              !continuityA ||
              !continuityB ||
              continuityA.dt !== a.dt ||
              continuityB.dt !== b.dt ||
              continuityA.points < count ||
              continuityB.points < count ||
              Math.abs(continuityA.lastTime - a.lastTime) > a.dt * 1e-6 ||
              Math.abs(continuityB.lastTime - b.lastTime) > b.dt * 1e-6 ||
              (requestedResumeAfter !== undefined && rawStart < requestedResumeAfter - a.dt * 1e-6)
            )
              return [identity]
            const data = new Float32Array(count)
            for (let i = 0; i < count; i++)
              data[i] =
                (a.samples[a.samples.length - count + i] as number) -
                (b.samples[b.samples.length - count + i] as number)
            const measured = rawMeasurement(data, a.dt)
            if (!measured || requestedPaused || !positive.current || !negative.current) return [identity]
            const requestedWindow: WaveformWindow = {
              start: a.lastTime - (count - 1) * a.dt,
              end: a.lastTime,
              rawStep: a.dt,
              completeCycles: measured.completeCycles ?? 0,
              source: 'raw',
              revision: current.revision,
              frozen: false,
            }
            return [
              { ...identity, current: true, measurement: measured, statistics: measured, window: requestedWindow },
            ]
          }),
        ),
      )
      return [...captured, ...requestedCaptured, ...difference, ...requestedDifference]
    })
  }

  function status(state: RuntimeStatus['state'], message: string, pace?: SimulationPace) {
    const slow = pace?.slow === true
    const ratioText =
      slow && pace?.realtimeRatio !== null && pace?.realtimeRatio !== undefined
        ? formatRealtimeRatio(pace.realtimeRatio)
        : ''
    const key = `${state}:${message}`
    const structuralChange = key !== lastStatus || slow !== lastSlow
    if (!structuralChange) {
      if (!slow || ratioText === lastRatioText) return
      const now = performance.now()
      if (now - lastPacePublishedAt < PACE_PUBLISH_INTERVAL_MS) return
      lastPacePublishedAt = now
    } else if (slow) {
      lastPacePublishedAt = performance.now()
    } else {
      lastPacePublishedAt = Number.NEGATIVE_INFINITY
    }
    lastStatus = key
    lastStatusState = state
    lastStatusMessage = message
    lastSlow = slow
    lastRatioText = ratioText
    onStatus(pace ? { state, message, pace } : { state, message })
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
        for (const screenId of ['CH1', 'CH2', 'V5', 'IS']) setInstrumentReading(entry.instanceId, reading, screenId)
      } else if (entry.instrument.kind === 'acSupply') {
        for (const screenId of ['PHASE', 'LINE']) setInstrumentReading(entry.instanceId, reading, screenId)
      } else setInstrumentReading(entry.instanceId, reading)
      for (const channel of entry.instrument.scope?.channels ?? [])
        setInstrumentReading(entry.instanceId, reading, channel.id)
    }
  }

  function showGenerators(input: AssembleInput, powered: boolean) {
    for (const entry of input.instruments) {
      const reading = generatorReading(entry, powered)
      if (reading) setInstrumentReading(entry.instanceId, reading)
      if (entry.instrument.kind === 'acSupply') {
        const ac = resolveAcSupply(entry.instrument, entry.settings)
        const phaseVal = Math.round(ac.phaseVoltageRms * 10) / 10
        const lineVal = Math.round(ac.lineVoltageRms * 10) / 10
        setInstrumentReading(
          entry.instanceId,
          {
            text: phaseVal.toFixed(1),
            unit: 'V',
            status: powered ? 'ok' : 'off',
            label: powered ? '输出开' : '已断电',
            mode: '50Hz 相电压',
            value: phaseVal,
          },
          'PHASE',
        )
        setInstrumentReading(
          entry.instanceId,
          {
            text: lineVal.toFixed(1),
            unit: 'V',
            status: powered ? 'ok' : 'off',
            label: powered ? '√3 线电压' : '已断电',
            mode: '50Hz 线电压',
            value: lineVal,
          },
          'LINE',
        )
      }
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
    powerWindows.clear()
  }

  function manuallyFrozenScopes(): Set<string> {
    const state = circuitStore.getState()
    if (!state.powered) return new Set()
    const frozen = new Set<string>()
    for (const entry of benchInstruments(state)) {
      if (!entry.instrument.scope) continue
      const resolved = resolveScope(entry.instrument, entry.settings)
      if (!resolved.running) frozen.add(entry.instanceId)
    }
    return frozen
  }

  function invalidate() {
    revision++
    job = undefined
    publishedJob = undefined
    pendingAlter = undefined
    parameterRequests.clear()
    loadBoundary?.resolve()
    loadBoundary = undefined
    waveformAfterTime = Number.NEGATIVE_INFINITY
    waveformBoundary.clear()
    requestedPaused = false
    requestedResumeAfter = undefined
    resetScopeContinuity()
    resetScopeAcquisition(undefined, { preserveFrozenIds: manuallyFrozenScopes() })
    moduleAudio?.dispose()
    moduleAudio = undefined
    clearTimeout(timer)
    clearTimeout(timeout)
    paceMonitor.reset()
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
    loadBoundary?.resolve()
    const requestId = `measurement-load-${crypto.randomUUID()}`
    let acknowledge!: () => void
    const loaded = new Promise<void>((resolve) => {
      acknowledge = resolve
    })
    loadBoundary = { requestId, applied: false, resolve: acknowledge }
    job = next
    publishedJob = undefined
    ownsSession = true
    if (next.plan.command.analysis.kind === 'tran') {
      for (const meter of next.plan.meters) {
        if (meter.config.mode === 'power') {
          if (!meter.voltageProbe || !meter.currentProbe || powerWindows.has(meter.instanceId)) continue
          const window = new PowerWindow(METER_RMS_WINDOW)
          powerWindows.set(meter.instanceId, window)
          offMeterSamples.push(
            sim.onSamples(meter.voltageProbe, (data, t0, dt) => {
              if (job === next && loadBoundary?.applied) window.pushVoltage(data, t0, dt)
            }),
            sim.onSamples(meter.currentProbe, (data, t0, dt) => {
              if (job === next && loadBoundary?.applied) window.pushCurrent(data, t0, dt)
            }),
          )
          continue
        }
        const probe =
          meter.config.mode === 'acv'
            ? meter.voltageProbe
            : meter.config.mode === 'aca'
              ? meter.currentProbe
              : undefined
        if (!probe || rmsWindows.has(probe)) continue
        const window = new RmsWindow(METER_RMS_WINDOW)
        rmsWindows.set(probe, window)
        offMeterSamples.push(
          sim.onSamples(probe, (data, t0, dt) => {
            if (job === next && loadBoundary?.applied) window.push(data, t0, dt)
          }),
        )
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
    // IPC receipt is not the session boundary: old tail chunks precede the matching native loaded event.
    void Promise.all([sim.send({ ...next.plan.command, requestId }), loaded, speakers?.ready])
      .then(async () => {
        if (
          disposed ||
          job !== next ||
          loadBoundary?.requestId !== requestId ||
          !loadBoundary.applied ||
          next.plan.command.analysis.kind !== 'tran'
        )
          return
        await sim.send(next.plan.pacing)
        while (!disposed && job === next && loadBoundary?.requestId === requestId) {
          const currentAudio = moduleAudio
          await currentAudio?.ready
          if (disposed || job !== next || loadBoundary?.requestId !== requestId) return
          if (currentAudio !== moduleAudio) continue
          await sim.send({ type: 'run' })
          return
        }
      })
      .catch(() => {
        // A superseded load may reject after a newer circuit revision started.
        if (!disposed && job === next && next.revision === revision) failure('无法发送仪表仿真请求。请断电后重试。')
      })
  }

  function update(force = false) {
    if (disposed || protecting) return
    const state = circuitStore.getState()
    if (!force && job && loadBoundary?.applied && !job.preflight && job.powered === state.powered) {
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
          paceMonitor.reset()
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
          job.plan = candidate
          showGenerators(input, state.powered)
          for (const meter of candidate.meters) {
            if (meter.config.mode !== 'power' || !state.powered) continue
            const metrics = powerWindows.get(meter.instanceId)?.value
            if (!metrics) continue
            const reading = readInstrument(meter.config, {
              connectedJacks: meter.connectedJacks,
              power: metrics,
            })
            setInstrumentReading(meter.instanceId, {
              ...reading,
              mode: meterModeLabel(meter.config, metrics.loadNature),
            })
          }
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
        if (issue) setInstrumentReading(meter.instanceId, { ...issue, mode: meterModeLabel(meter.config) })
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

  function meterModeLabel(
    config: MeasurementPlan['meters'][number]['config'],
    loadNature?: 'R' | 'L' | 'C' | 'NONE',
  ): string {
    if (config.mode === 'power' && config.wattmeter) {
      const modeName: Record<typeof config.wattmeter.displayMode, string> = {
        P: '有功 P',
        pf: 'cosφ',
        S: '视在 S',
        Q: '无功 Q',
        U: '电压 U',
        I: '电流 I',
      }
      const suffix = loadNature && loadNature !== 'NONE' ? ` (${loadNature})` : ''
      return `${modeName[config.wattmeter.displayMode]}${suffix}`
    }
    if (config.instrument.kind === 'galvanometer') return 'G ±100µA'
    if (config.channelId) return `${config.channelId} ACV`
    return config.mode.toUpperCase()
  }

  function publish(current: RuntimeJob, values: Record<string, number>, transient: boolean, simTime?: number) {
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
        power: undefined as PowerWindow['value'],
      }
      if (transient && meter.config.mode === 'power') {
        if (meter.voltageProbe && meter.currentProbe) {
          const metrics = powerWindows.get(meter.instanceId)?.value
          if (!metrics) {
            waiting = true
            setInstrumentReading(meter.instanceId, blank('pending', '正在采集功率计算窗口。', meter.config.unit))
            continue
          }
          sample.power = metrics
        }
      } else if (transient && (meter.config.mode === 'acv' || meter.config.mode === 'aca')) {
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
      setInstrumentReading(meter.instanceId, {
        ...reading,
        mode: meterModeLabel(meter.config, reading.metrics?.loadNature),
      })
      audible ||= reading.beep
      warning ||= reading.status === 'external-voltage'
    }
    for (const supply of current.plan.supplies) {
      if (!current.powered) continue
      const rawValue = values[supply.voltageProbe]
      const value =
        rawValue !== undefined && Number.isFinite(rawValue)
          ? rawValue
          : !supply.wired
            ? (supply.channel?.voltageSet ?? 0)
            : undefined
      if (value === undefined || !Number.isFinite(value)) continue
      const currentVal = values[supply.currentProbe] ?? 0
      if (supply.kind === 'currentSource' && supply.currentSource) {
        const csStatus = classifyCurrentSource(
          supply.currentSource,
          value,
          Number.isFinite(currentVal) ? currentVal : 0,
          supply.wired,
        )
        const decimals = supply.currentSource.rangeMa === 2 ? 3 : supply.currentSource.rangeMa === 20 ? 2 : 1
        const step = 10 ** -decimals
        const roundedMa = Math.round(csStatus.currentMa / step) * step
        setInstrumentReading(
          supply.instanceId,
          {
            text: roundedMa.toFixed(decimals),
            unit: 'mA',
            status: 'ok',
            value: roundedMa * 1e-3,
            rawValue: csStatus.currentMa * 1e-3,
            mode: `${supply.currentSource.rangeMa}mA档 · ${csStatus.voltage.toFixed(1)}V`,
            label: csStatus.state === 'OPEN' ? '开路限压' : csStatus.state === 'OFF' ? '待接线' : 'CC 恒流',
            ...(csStatus.state === 'OPEN'
              ? { message: '恒流源输出端开路或负载阻值过大，已触发 30 V 合规限压保护。' }
              : {}),
          },
          supply.screenId,
        )
        continue
      }
      const { resolution, displayScale, unit } = supply.range
      const rounded = Math.round(value / resolution) * resolution
      const chStatus = supply.channel
        ? classifyDcChannel(supply.channel, value, Number.isFinite(currentVal) ? currentVal : 0)
        : { mode: 'CV' as const, voltage: value, current: 0 }
      setInstrumentReading(
        supply.instanceId,
        {
          text: (rounded / displayScale).toFixed(Math.max(0, -Math.floor(Math.log10(resolution / displayScale)))),
          unit,
          status: 'ok',
          value: rounded,
          rawValue: value,
          mode: `${chStatus.mode} · ${(chStatus.current * 1000).toFixed(0)}mA`,
          label: chStatus.mode === 'CC' ? 'CC 限流' : 'CV 稳压',
        },
        supply.screenId,
      )
    }
    showScopes(current.input, current.plan, current.powered, true)
    publishedJob = current
    beep(audible)
    const pace =
      transient && !requestedPaused && simTime !== undefined
        ? paceMonitor.record(simTime, performance.now())
        : undefined
    status(
      warning ? 'protected' : waiting ? 'pending' : 'ready',
      warning ? '带电回路：表内测试源已关闭' : waiting ? '采集有效值窗口' : transient ? '实时测量' : '直流工作点已更新',
      pace,
    )
  }

  const offEvents = sim.onEvent((event: Exclude<SimEvent, { type: 'chunk' }>) => {
    const current = job
    if (!current || current.revision !== revision || disposed) return
    if (event.type === 'loaded') {
      if (!loadBoundary || event.requestId !== loadBoundary.requestId) {
        if (loadBoundary?.applied) failure('仿真会话已变更，请重新上电后继续测量。')
        return
      }
      const replayed = loadBoundary.applied
      requestedPaused = false
      requestedResumeAfter = undefined
      paceMonitor.reset()
      if (lastSlow) status(lastStatusState, lastStatusMessage)
      resetScopeContinuity(current)
      loadBoundary.applied = true
      loadBoundary.resolve()
      publishedJob = undefined
      waveformAfterTime = Number.NEGATIVE_INFINITY
      waveformBoundary.clear()
      resetScopeAcquisition(undefined, { preserveFrozenIds: manuallyFrozenScopes() })
      for (const window of rmsWindows.values()) window.clear()
      for (const window of powerWindows.values()) window.clear()
      if (replayed && moduleAudio && current.plan.command.analysis.kind === 'tran') {
        moduleAudio.dispose()
        const replacement = createModuleAudio(sim, current.plan.speakers, current.plan.command.analysis.step)
        moduleAudio = replacement
        void replacement.ready.catch(() => {
          if (!disposed && job === current && moduleAudio === replacement) failure('无法启动模块声音，请断电后重试。')
        })
      }
      moduleAudio?.activate()
      return
    }
    if (event.type === 'altered') {
      if (event.requestId) parameterRequests.delete(event.requestId)
      if (event.requestId !== pendingAlter?.requestId) return
      pendingAlter = { requestId: event.requestId as string, afterTime: event.simTime }
      requestedPaused = false
      requestedResumeAfter = event.simTime
      paceMonitor.reset()
      resetScopeContinuity(current)
      waveformAfterTime = event.simTime
      waveformBoundary.clear()
      for (const scope of current.plan.scopes) {
        for (const channel of scope.channels) {
          if (channel.probe) waveformBoundary.set(channel.probe, sim.buffer(channel.probe).written)
        }
      }
      for (const window of rmsWindows.values()) window.clear()
      for (const window of powerWindows.values()) window.clear()
      return
    }
    if (event.type === 'error') {
      if (
        event.requestId &&
        event.requestId !== loadBoundary?.requestId &&
        event.requestId !== pendingAlter?.requestId &&
        !parameterRequests.has(event.requestId)
      )
        return
      failure(event.message)
      return
    }
    if (event.type === 'status') {
      if (event.state === 'paused' || event.state === 'idle') {
        requestedPaused = true
        requestedResumeAfter = event.simTime
        paceMonitor.reset()
        if (lastSlow) status(lastStatusState, lastStatusMessage)
        resetScopeContinuity()
        for (const scope of current.plan.scopes) {
          for (const channel of scope.channels) {
            if (!channel.probe) continue
            sim.observation?.(channel.probe).clear()
          }
        }
      } else if (event.state === 'running') {
        requestedPaused = false
        requestedResumeAfter = event.simTime
        paceMonitor.reset()
        resetScopeContinuity(current)
        for (const scope of current.plan.scopes) {
          for (const channel of scope.channels) {
            if (channel.probe) sim.observation?.(channel.probe).clear()
          }
        }
      }
    }
    if (!loadBoundary?.applied || (event.type !== 'op' && event.type !== 'readings')) return
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
    publish(
      current,
      event.values,
      event.type === 'readings' && current.plan.command.analysis.kind === 'tran',
      event.type === 'readings' ? event.simTime : undefined,
    )
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
