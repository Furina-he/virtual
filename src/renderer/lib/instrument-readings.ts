export type InstrumentReading = {
  text: string
  unit: string
  status:
    | 'ok'
    | 'overload'
    | 'wrong-jacks'
    | 'external-voltage'
    | 'disconnected'
    | 'invalid'
    | 'off'
    | 'pending'
    | 'error'
    | 'unsupported'
  message?: string
  mode?: string
  negative?: boolean
  beep?: boolean
  value?: number | null
  rawValue?: number | null
}

export type InstrumentReadingsSnapshot = Record<string, Record<string, InstrumentReading>>

export const PENDING_INSTRUMENT_READING: InstrumentReading = {
  text: '--.---',
  unit: '',
  status: 'pending',
  message: '等待仿真读数。',
}

function sameReading(a: InstrumentReading | undefined, b: InstrumentReading): boolean {
  if (!a) return false
  const keys = Object.keys(b) as (keyof InstrumentReading)[]
  return Object.keys(a).length === keys.length && keys.every((key) => Object.is(a[key], b[key]))
}

/** Latest samples live outside React; only the newest value is announced at 10 Hz. */
export function createInstrumentReadingChannel(intervalMs = 100) {
  const values = new Map<string, Map<string, InstrumentReading>>()
  const listeners = new Map<string, Set<() => void>>()
  const observers = new Set<() => void>()
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFlush = Number.NEGATIVE_INFINITY

  function schedule() {
    if (timer !== undefined) return
    timer = setTimeout(
      () => {
        timer = undefined
        lastFlush = Date.now()
        const changed = [...dirty]
        dirty.clear()
        for (const id of changed) for (const listener of listeners.get(id) ?? []) listener()
        if (changed.length) for (const observer of observers) observer()
      },
      Math.max(0, intervalMs - (Date.now() - lastFlush)),
    )
  }

  function set(instanceId: string, reading: InstrumentReading, screenId = 'main') {
    let screens = values.get(instanceId)
    if (!screens) {
      screens = new Map()
      values.set(instanceId, screens)
    }
    if (sameReading(screens.get(screenId), reading)) return
    screens.set(screenId, { ...reading })
    dirty.add(instanceId)
    schedule()
  }

  function clear(instanceId?: string) {
    const ids = instanceId === undefined ? [...values.keys()] : [instanceId]
    for (const id of ids) {
      if (!values.delete(id)) continue
      dirty.add(id)
    }
    if (dirty.size) schedule()
  }

  return {
    set,
    clear,
    get: (instanceId: string, screenId = 'main'): InstrumentReading =>
      values.get(instanceId)?.get(screenId) ?? values.get(instanceId)?.get('main') ?? PENDING_INSTRUMENT_READING,
    subscribe(instanceId: string, listener: () => void): () => void {
      let group = listeners.get(instanceId)
      if (!group) {
        group = new Set()
        listeners.set(instanceId, group)
      }
      group.add(listener)
      return () => {
        group.delete(listener)
        if (!group.size) listeners.delete(instanceId)
      }
    },
    subscribeAll(listener: () => void): () => void {
      observers.add(listener)
      return () => observers.delete(listener)
    },
    snapshot(): InstrumentReadingsSnapshot {
      return Object.fromEntries(
        [...values].map(([id, screens]) => [
          id,
          Object.fromEntries([...screens].map(([key, value]) => [key, { ...value }])),
        ]),
      )
    },
    replace(snapshot: InstrumentReadingsSnapshot) {
      for (const id of values.keys()) if (!Object.hasOwn(snapshot, id)) clear(id)
      for (const [id, screens] of Object.entries(snapshot)) {
        const previous = values.get(id)
        if (previous)
          for (const key of previous.keys())
            if (!Object.hasOwn(screens, key)) {
              previous.delete(key)
              dirty.add(id)
            }
        for (const [screenId, reading] of Object.entries(screens)) set(id, reading, screenId)
      }
      if (dirty.size) schedule()
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      dirty.clear()
      values.clear()
      listeners.clear()
      observers.clear()
    },
  }
}

export const instrumentReadings = createInstrumentReadingChannel()
export const setInstrumentReading = instrumentReadings.set
export const getInstrumentReading = instrumentReadings.get
export const clearInstrumentReadings = instrumentReadings.clear
export const subscribeInstrumentReadings = instrumentReadings.subscribe

export function readingStatusLabel(reading: InstrumentReading): string {
  switch (reading.status) {
    case 'ok':
      return reading.beep ? '通断蜂鸣' : reading.negative ? '反向极性' : '测量中'
    case 'overload':
      return '超量程'
    case 'wrong-jacks':
      return '插孔与档位不匹配'
    case 'external-voltage':
      return '检测到外部电压'
    case 'disconnected':
      return '测量线未接齐'
    case 'off':
      return '已断电'
    case 'pending':
      return '等待读数'
    case 'unsupported':
      return '此功能尚未接入'
    default:
      return '无法测量'
  }
}

export function readingIsWarning(reading: InstrumentReading): boolean {
  return ['overload', 'wrong-jacks', 'external-voltage', 'invalid', 'error'].includes(reading.status)
}
