import type { MeasurePoint } from '../../shared/schema/project.ts'
import { checkInstrumentJacks } from '../instruments/index.ts'
import type { MeasurementPlan, MeterPlan } from '../measurement/plan.ts'
import { circuitPartition } from '../wiring-check/common.ts'

export type ReadingValue = { status: string; value?: number | null }
export type MeasurementSnapshot = {
  /** The renderer verifies this is the current, ready runtime job before supplying the snapshot. */
  current: boolean
  plan: MeasurementPlan
  readings: Readonly<Record<string, ReadingValue>>
}
export type CapturedMeasurement = {
  measurePoint: string
  instanceId: string
  displayValueSI: number
  referenceValueSI: number
  reversed: boolean
}
export type CaptureResult =
  | { ok: true; measurement: CapturedMeasurement; message: string }
  | {
      ok: false
      reason: 'not-current' | 'unsupported' | 'not-connected' | 'unavailable' | 'ambiguous'
      message: string
      candidates?: string[]
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
  const map = (r: string) => {
    const [owner, jack] = r.split('.')
    const known = [...input.modules, ...input.instruments].some((entry) => entry.instanceId === owner)
    const placed = input.instruments.find((entry) => entry.instrument.id === owner)
    return known ? r : placed ? `${placed.instanceId}.${jack}` : undefined
  }
  const [a, b] = points.map(map)
  if (!a || !b) return undefined
  const positive = `${instanceId}.${config.positiveJack}`
  const negative = `${instanceId}.${config.negativeJack}`
  const pair = input.instruments
    .find((entry) => entry.instanceId === instanceId)
    ?.instrument.measure?.series.findIndex(([p, n]) => p === config.positiveJack && n === config.negativeJack)
  if (current && (pair === undefined || pair < 0)) return undefined
  const uf = circuitPartition(input, current ? { instanceId, pair: pair as number } : undefined)
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
  if (point.kind === 'waveform')
    return { ok: false, reason: 'unsupported', message: '波形记录尚未开放，请使用电压或电流测量点。' }
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

/** Values remain SI until a compatible table column explicitly selects a display unit. */
export function tableValue(point: MeasurePoint, measurement: CapturedMeasurement, unit?: string): number | undefined {
  if (measurement.measurePoint !== point.id || !Number.isFinite(measurement.referenceValueSI)) return undefined
  const scales: Record<string, number> =
    point.kind === 'voltage' ? { V: 1, mV: 1e-3 } : point.kind === 'current' ? { A: 1, mA: 1e-3, uA: 1e-6 } : {}
  const scale = scales[unit ?? (point.kind === 'voltage' ? 'V' : 'A')]
  return scale === undefined ? undefined : measurement.referenceValueSI / scale
}
