import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstrumentReadingChannel, readingIsWarning, readingStatusLabel } from './instrument-readings'

describe('instrument reading channel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the latest samples outside React and notifies at most 10 Hz', () => {
    const channel = createInstrumentReadingChannel()
    const listener = vi.fn()
    channel.subscribe('meter1', listener)
    channel.set('meter1', { text: '1.00', unit: 'V', status: 'ok' })
    vi.advanceTimersByTime(0)
    expect(listener).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 100; index++) channel.set('meter1', { text: `${index}`, unit: 'V', status: 'ok' })
    expect(channel.get('meter1').text).toBe('99')
    vi.advanceTimersByTime(99)
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(listener).toHaveBeenCalledTimes(2)
    channel.dispose()
  })

  it('does not notify for unchanged readings or unrelated instruments', () => {
    const channel = createInstrumentReadingChannel()
    const listener = vi.fn()
    const unsubscribe = channel.subscribe('meter1', listener)
    const reading = { text: 'OL.', unit: 'V', status: 'overload' as const }
    channel.set('meter1', reading)
    channel.set('other', reading)
    vi.advanceTimersByTime(0)
    expect(listener).toHaveBeenCalledTimes(1)
    channel.set('meter1', { ...reading })
    vi.advanceTimersByTime(100)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    channel.clear('meter1')
    vi.advanceTimersByTime(100)
    expect(listener).toHaveBeenCalledTimes(1)
    channel.dispose()
  })

  it('synchronizes separate supply screens and clears removed instances', () => {
    const main = createInstrumentReadingChannel()
    const popup = createInstrumentReadingChannel()
    main.set('supply', { text: '6.00', unit: 'V', status: 'ok' }, 'ch1')
    main.set('supply', { text: '12.00', unit: 'V', status: 'ok' }, 'ch2')
    popup.replace(main.snapshot())
    expect(popup.get('supply', 'ch1').text).toBe('6.00')
    expect(popup.get('supply', 'ch2').text).toBe('12.00')
    const copy = main.snapshot()
    const copiedChannel = copy.supply?.ch1
    expect(copiedChannel).toBeDefined()
    if (copiedChannel) copiedChannel.text = 'not authoritative'
    expect(main.get('supply', 'ch1').text).toBe('6.00')
    main.clear()
    popup.replace(main.snapshot())
    expect(popup.get('supply', 'ch1').status).toBe('pending')
    main.dispose()
    popup.dispose()
  })

  it('labels warnings and reversed polarity without relying on color', () => {
    expect(readingStatusLabel({ status: 'ok', text: '-1.00', unit: 'V', negative: true })).toBe('反向极性')
    expect(readingStatusLabel({ status: 'overload', text: 'OL.', unit: 'V' })).toBe('超量程')
    expect(readingIsWarning({ status: 'wrong-jacks', text: '----', unit: '' })).toBe(true)
    expect(readingIsWarning({ status: 'disconnected', text: '----', unit: '' })).toBe(false)
  })
})
