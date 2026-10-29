import type { MeasurePoint } from '../../shared/schema/project.ts'
import { UnionFind } from '../circuit/union-find.ts'
import { checkInstrumentJacks } from '../instruments/index.ts'
import type { Coupling, SignalMeasurement } from '../instruments/scope.ts'
import type { MeasurementPlan, MeterPlan } from '../measurement/plan.ts'
import { applyModuleInternals, type CheckInput, circuitPartition, wiredJacks } from '../wiring-check/common.ts'

export type ReadingValue = { status: string; value?: number | null }
export type WaveformReading = {
  instanceId: string
  channelId: string
  positiveRef: string
  negativeRef: string
  coupling: Coupling
  current: boolean
  measurement: SignalMeasurement | null
}
export type MeasurementSnapshot = {
  /** The renderer verifies this is the current, ready runtime job before supplying the snapshot. */
  current: boolean
  plan: MeasurementPlan
  readings: Readonly<Record<string, ReadingValue>>
  waveforms?: readonly WaveformReading[]
}
export type CapturedMeasurement = {
  measurePoint: string
  instanceId: string
  displayValueSI: number
  referenceValueSI: number
  reversed: boolean
  channelId?: string
}
export type CaptureResult =
  | { ok: true; measurement: CapturedMeasurement; message: string }
  | {
      ok: false
      reason: 'not-current' | 'unsupported' | 'not-connected' | 'unavailable' | 'ambiguous'
      message: string
      candidates?: string[]
    }

function physicalVoltagePartition(input: CheckInput): UnionFind<string> {
  const uf = new UnionFind<string>()
  applyModuleInternals(uf, input, wiredJacks(input))
  for (const { instanceId, instrument } of input.instruments)
    for (const jack of instrument.jacks) uf.add(`${instanceId}.${jack.id}`)
  for (const wire of input.wires) uf.union(wire.a, wire.b)
  return uf
}

function mapRef(plan: MeasurementPlan, ref: string): string | undefined {
  const [owner, jack] = ref.split('.')
  const module = plan.checkInput.modules.find((entry) => entry.instanceId === owner)
  const instrument =
    plan.checkInput.instruments.find((entry) => entry.instanceId === owner) ??
    plan.checkInput.instruments.find((entry) => entry.instrument.id === owner)
  const entry = module ?? instrument
  const definition = module?.module ?? instrument?.instrument
  return entry && definition?.jacks.some((item) => item.id === jack) ? `${entry.instanceId}.${jack}` : undefined
}

function orientation(plan: MeasurementPlan, point: MeasurePoint, meter: MeterPlan): 1 | -1 | undefined {
  const { config, instanceId } = meter
  const current = point.kind === 'current'
  if (
    point.kind === 'waveform' ||
    (point.mode && point.mode !== config.mode) ||
    (current ? !['dca', 'aca'].includes(config.mode) : !['dcv', 'acv'].includes(config.mode)) ||
    config.passive ||
    checkInstrumentJacks(config, meter.connectedJacks) ||
    !(current ? meter.currentProbe : meter.voltageProbe)
  )
    return undefined
  const input = plan.checkInput
  const points = current ? point.branch : point.between
  if (!points) return undefined
  const [a, b] = points.map((ref) => mapRef(plan, ref))
  if (!a || !b) return undefined
  const positive = `${instanceId}.${config.positiveJack}`
  const negative = `${instanceId}.${config.negativeJack}`
  const pair = input.instruments
    .find((entry) => entry.instanceId === instanceId)
    ?.instrument.measure?.series.findIndex(([p, n]) => p === config.positiveJack && n === config.negativeJack)
  if (current && (pair === undefined || pair < 0)) return undefined
  const uf = current ? circuitPartition(input, { instanceId, pair: pair as number }) : physicalVoltagePartition(input)
  // A second parallel meter or an unopened current socket bypasses the candidate's current measurement.
  if (current && uf.find(a) === uf.find(b)) return undefined
  if (uf.find(positive) === uf.find(a) && uf.find(negative) === uf.find(b)) return 1
  if (uf.find(positive) === uf.find(b) && uf.find(negative) === uf.find(a)) return -1
  return undefined
}

export function captureMeasurePoint(
  snapshot: MeasurementSnapshot | undefined,
  point: MeasurePoint,
  selectedInstanceId?: string,
): CaptureResult {
  if (!snapshot?.current)
    return { ok: false, reason: 'not-current', message: '当前读数尚未就绪，请等待仿真更新后再记录。' }
  if (point.kind === 'waveform') {
    if (!snapshot.waveforms)
      return { ok: false, reason: 'unsupported', message: '当前快照未提供示波器采样，不能记录波形测量。' }
    return captureWaveform(snapshot, point, selectedInstanceId)
  }
  const matches = snapshot.plan.meters.flatMap((meter) => {
    const sign = orientation(snapshot.plan, point, meter)
    return sign === undefined ? [] : [{ meter, sign }]
  })
  if (matches.length > 1 && !selectedInstanceId)
    return {
      ok: false,
      reason: 'ambiguous',
      message: '有多块仪表连接到该测量点，请选择要记录的仪表。',
      candidates: matches.map(({ meter }) => meter.instanceId),
    }
  const match = selectedInstanceId ? matches.find(({ meter }) => meter.instanceId === selectedInstanceId) : matches[0]
  if (!match)
    return { ok: false, reason: 'not-connected', message: `请将正确档位的仪表接到测量点 ${point.id} 后再记录。` }
  const reading = snapshot.readings[match.meter.instanceId]
  const ac = match.meter.config.mode === 'acv' || match.meter.config.mode === 'aca'
  if (
    reading?.status !== 'ok' ||
    typeof reading.value !== 'number' ||
    !Number.isFinite(reading.value) ||
    (ac && reading.value < 0)
  )
    return { ok: false, reason: 'unavailable', message: '当前仪表没有可记录的有效读数，请检查量程、接线和上电状态。' }
  const value = reading.value === 0 ? 0 : reading.value
  return {
    ok: true,
    measurement: {
      measurePoint: point.id,
      instanceId: match.meter.instanceId,
      displayValueSI: value,
      referenceValueSI: value === 0 || ac ? value : match.sign * value,
      reversed: match.sign === -1,
    },
    message:
      match.sign === -1
        ? ac
          ? '仪表正负端接反，有效值为非负幅度，记录数值不因反接改变。'
          : '仪表正负端接反，保留仪表显示值，并按测量点参考方向记录。'
        : `测量点 ${point.id} 的当前读数可记录。`,
  }
}

function captureWaveform(snapshot: MeasurementSnapshot, point: MeasurePoint, selected?: string): CaptureResult {
  const a = point.between && mapRef(snapshot.plan, point.between[0])
  const b = point.between && mapRef(snapshot.plan, point.between[1])
  if (!a || !b) return { ok: false, reason: 'not-connected', message: '该波形测量点未配置有效的两端插孔。' }
  const uf = physicalVoltagePartition(snapshot.plan.checkInput)
  const matches = (snapshot.waveforms ?? [])
    .flatMap((reading) => {
      const positive = mapRef(snapshot.plan, reading.positiveRef)
      const negative = mapRef(snapshot.plan, reading.negativeRef)
      if (!positive || !negative) return []
      const sign =
        uf.find(positive) === uf.find(a) && uf.find(negative) === uf.find(b)
          ? 1
          : uf.find(positive) === uf.find(b) && uf.find(negative) === uf.find(a)
            ? -1
            : 0
      return sign ? [{ reading, sign }] : []
    })
    .filter(
      ({ reading }) =>
        !selected || selected === reading.instanceId || selected === `${reading.instanceId}.${reading.channelId}`,
    )
    .filter((candidate, index, candidates) => {
      if (selected || !candidate.reading.channelId.includes('-')) return true
      const pair = candidate.reading.channelId.split('-').sort().join('-')
      return !candidates
        .slice(0, index)
        .some(
          (previous) =>
            previous.reading.instanceId === candidate.reading.instanceId &&
            previous.reading.channelId.includes('-') &&
            previous.reading.channelId.split('-').sort().join('-') === pair,
        )
    })
  if (matches.length > 1)
    return {
      ok: false,
      reason: 'ambiguous',
      message: '多个示波器通道连接到该测量点，请选择记录来源通道。',
      candidates: matches.map(({ reading }) => `${reading.instanceId}.${reading.channelId}`),
    }
  const match = matches[0]
  if (!match)
    return { ok: false, reason: 'not-connected', message: `请将示波器通道和 GND 接到波形测量点 ${point.id}。` }
  const { reading, sign } = match
  const measured = reading.measurement
  const quantity = point.quantity ?? 'vpp'
  if (
    !reading.current ||
    !measured ||
    reading.coupling === 'gnd' ||
    (['mean', 'min', 'max'].includes(quantity) && reading.coupling !== 'dc')
  )
    return {
      ok: false,
      reason: 'unavailable',
      message: '当前通道数据尚未就绪或耦合设置不符。直流均值/极值请使用 DC 耦合并接好 GND。',
    }
  const value = measured[quantity]
  if (typeof value !== 'number' || !Number.isFinite(value))
    return { ok: false, reason: 'unavailable', message: '当前波形尚无有效测量，请调整时基并等待完整采样。' }
  const reference =
    sign === 1 || ['vpp', 'frequency', 'period'].includes(quantity)
      ? value
      : quantity === 'min'
        ? -measured.max
        : quantity === 'max'
          ? -measured.min
          : -value
  if (!Number.isFinite(reference) || (['vpp', 'frequency', 'period'].includes(quantity) && value < 0))
    return { ok: false, reason: 'unavailable', message: '波形测量量无效，请等待有效采样。' }
  return {
    ok: true,
    measurement: {
      measurePoint: point.id,
      instanceId: reading.instanceId,
      channelId: reading.channelId,
      displayValueSI: value,
      referenceValueSI: reference === 0 ? 0 : reference,
      reversed: sign === -1,
    },
    message:
      sign === -1
        ? '示波器测量端接反；均值和极值按参考方向换算，峰峰值、频率和周期不变。'
        : `波形测量点 ${point.id} 已使用当前真实采样。`,
  }
}

export function measurementUnit(point: MeasurePoint): string {
  return point.kind === 'current'
    ? 'A'
    : point.kind === 'waveform' && point.quantity === 'frequency'
      ? 'Hz'
      : point.kind === 'waveform' && point.quantity === 'period'
        ? 's'
        : 'V'
}

/** Values remain SI until a compatible table column explicitly selects a display unit. */
export function tableValue(point: MeasurePoint, measurement: CapturedMeasurement, unit?: string): number | undefined {
  if (measurement.measurePoint !== point.id || !Number.isFinite(measurement.referenceValueSI)) return undefined
  const si = measurementUnit(point)
  const scales: Record<string, number> =
    si === 'V'
      ? { V: 1, mV: 1e-3 }
      : si === 'A'
        ? { A: 1, mA: 1e-3, uA: 1e-6 }
        : si === 'Hz'
          ? { Hz: 1, kHz: 1e3 }
          : { s: 1, ms: 1e-3, us: 1e-6 }
  const scale = scales[unit ?? si]
  return scale === undefined ? undefined : measurement.referenceValueSI / scale
}
