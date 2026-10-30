import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type ElectronApplication, expect, type Page } from '@playwright/test'
import type { LongWindow, LongWindowSnapshot } from '../../../src/domain/instruments/long-window'
import { formatSeconds } from '../../../src/domain/instruments/scope'
import type { WaveformWindow } from '../../../src/domain/task/measurements'
import { analyzeTone } from '../../../src/shared/audio/tone'
import type { SimCommand, SimEvent } from '../../../src/shared/ipc/sim'
import { Project } from '../../../src/shared/schema/project'
import { dragInstrumentToSlot } from './instruments'

export const sd22Project = Project.parse(JSON.parse(readFileSync('content/projects/SD-22/project.json', 'utf8')))
export const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
export const sd22Steps = (page: Page) => region(page, '实训步骤')
export const sd22Data = (page: Page) => region(page, '实训数据记录')
const editor = (page: Page) => region(page, '接线编辑')

export type Sd22Client = {
  stats: { blocks: number; lostBlocks: number; lastSeq: number; points: number; sessions: number; restarts: number }
  send(command: SimCommand): Promise<void>
  onEvent(listener: (event: Exclude<SimEvent, { type: 'chunk' }>) => void): () => void
  buffer(id: string): { capacity: number; length: number; data: Float32Array; lastTime: number; dt: number }
  observation(id: string): LongWindow
}
export type Sd22ScopeSummary = {
  state: string
  revision: number
  channels: {
    id: string
    vpp: number | null
    mean: number | null
    min: number | null
    max: number | null
    frequency: number | null
    period: number | null
    window?: WaveformWindow
    traceMode?: string
  }[]
}
type AudioOutput = {
  feed(samples: Float32Array, t0: number, dt: number): void
  stop(): void
}
type AudioModule = {
  SimAudioOutput: {
    create(
      ctx: BaseAudioContext,
      mode: 'pcm' | 'synth',
      rate: number,
      options?: { fullScale?: number; prebufferSec?: number; destination?: AudioNode },
    ): Promise<AudioOutput>
  }
}

export async function mouseJack(page: Page, label: string, ref: string) {
  const trigger = editor(page).getByRole('combobox', { name: label, exact: true })
  await trigger.click()
  const option = page.locator(`[role="option"][data-jack-ref="${ref}"]`)
  await option.scrollIntoViewIfNeeded()
  await option.hover()
  await option.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toHaveAttribute('data-selected-jack', ref)
}

export async function sd22Wire(page: Page, a: string, b: string) {
  const before = Number(await editor(page).getAttribute('data-wire-count'))
  await mouseJack(page, '接线起点', a)
  await mouseJack(page, '接线终点', b)
  const add = editor(page).getByRole('button', { name: '添加导线', exact: true })
  await add.scrollIntoViewIfNeeded()
  await expect(add).toBeInViewport({ ratio: 1 })
  await add.click()
  await expect(editor(page)).toHaveAttribute('data-wire-count', String(before + 1))
}

export async function sd22Nets(page: Page, nets: string[][]) {
  for (const [first, ...rest] of nets) {
    if (!first) throw new Error('Empty SD-22 reference net')
    for (const ref of rest) await sd22Wire(page, first, ref)
  }
}

export async function sd22RemoveLeads(page: Page, prefix: string) {
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
  const leads = editor(page).locator(`li[data-wire-a^="${prefix}"], li[data-wire-b^="${prefix}"]`)
  while (await leads.count()) {
    const before = await leads.count()
    await leads
      .first()
      .getByRole('button', { name: /^删除导线 \d+$/ })
      .click()
    await expect(leads).toHaveCount(before - 1)
  }
}

export async function sd22Off(page: Page) {
  const off = page.getByRole('button', { name: '断电', exact: true })
  if (await off.count()) await off.click()
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
}

export async function sd22Tab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

export async function sd22Choose(page: Page, panelName: string, label: string, optionName: string) {
  await sd22Tab(page, '仪表')
  const trigger = region(page, panelName).getByRole('combobox', { name: label, exact: true })
  await trigger.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
}

export async function sd22Exact(page: Page, panelName: string, label: string, value: number) {
  await sd22Tab(page, '仪表')
  const input = region(page, panelName).getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(String(value))
  await input.press('Enter')
  await expect(input).toHaveValue(String(value))
}

export async function sd22Timebase(page: Page, seconds: number) {
  await sd22Choose(page, '双通道数字示波器', '时基 s/div', `${formatSeconds(seconds)}/div`)
}

export async function sd22ScopeLeads(page: Page, ch1: string, ch2?: string) {
  await sd22Off(page)
  await sd22RemoveLeads(page, 'scope1.')
  await sd22Wire(page, 'scope1.GND', 'timer1.GND1')
  await sd22Wire(page, 'scope1.CH1', ch1)
  if (ch2) await sd22Wire(page, 'scope1.CH2', ch2)
  await sd22Choose(page, '双通道数字示波器', 'CH1 耦合', 'DC 直流耦合')
  await sd22Choose(page, '双通道数字示波器', 'CH2 耦合', 'DC 直流耦合')
  await sd22Choose(page, '双通道数字示波器', 'CH1 V/div', '1 V/div')
  await sd22Choose(page, '双通道数字示波器', 'CH2 V/div', '1 V/div')
}

export async function sd22Scope(page: Page): Promise<Sd22ScopeSummary | undefined> {
  const canvas = page.locator('canvas[data-instance-id="scope1"]')
  const raw = (await canvas.count()) ? await canvas.getAttribute('data-scope') : null
  return raw ? (JSON.parse(raw) as Sd22ScopeSummary) : undefined
}

/** Check real bounded stream history; the actual record still goes through the production task store. */
export async function sd22RequestedWindows(page: Page, requests: { channel: number; windowSec: number }[]) {
  return page.evaluate((windows): Record<string, LongWindowSnapshot> => {
    const client = window.__simClient as unknown as Sd22Client
    const observed: Record<string, LongWindowSnapshot> = {}
    for (const { channel, windowSec } of windows) {
      const key = `${channel}:${windowSec}`
      if (!observed[key]) observed[key] = client.observation(`scope:scope1:CH${channel}`).snapshot(windowSec)
    }
    return observed
  }, requests)
}

export async function sd22Setup(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    location.hash = '/practice/SD-22'
  })
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText(`SD-22 ${sd22Project.title}`)
  await page.waitForLoadState('networkidle')
  await expect(region(page, '3D 实训台')).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(region(page, '3D 实训台')).toHaveAttribute('data-camera-moving', 'false')
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  await sd22Exact(page, '直流稳压电源', 'CH1 电压', 5)
  await sd22Exact(page, '直流稳压电源', 'CH2 电压', 0)
}

type SoundAudit = {
  mode: string
  rate: number
  fullScale: number
  createdAt: number
  stoppedAt: number | null
  context: AudioContext
  feeds: number
  samples: number
  first: number | null
  end: number | null
  dt: number
  gaps: number
  nonfinite: number
  min: number
  max: number
  maxFeedGapMs: number
  lastFeedAt: number | null
  scheduled: { f0: number; at: number; now: number; wall: number; simEnd: number | null }[]
}
type Evidence = {
  commands: { type: string; at: number; analysis?: unknown; pacing?: unknown; probes?: unknown; requestId?: string }[]
  events: { type: string; at: number; requestId?: string; simTime?: number; detail?: string }[]
  outputs: SoundAudit[]
  longTasks: { at: number; duration: number }[]
}
type WindowEvidence = Window & { __sd22Evidence: Evidence }

/** Observe the sole production output without replacing its samples, parameters, destination, or clock. */
export async function sd22Observe(page: Page) {
  await page.evaluate(async () => {
    const evidence: Evidence = { commands: [], events: [], outputs: [], longTasks: [] }
    const target = window as unknown as WindowEvidence
    target.__sd22Evidence = evidence
    const client = window.__simClient as unknown as Sd22Client
    const send = client.send.bind(client)
    client.send = (command) => {
      if (evidence.commands.length < 512)
        evidence.commands.push({
          type: command.type,
          at: performance.now(),
          ...(command.type === 'load'
            ? { analysis: command.analysis, probes: command.probes, requestId: command.requestId }
            : command.type === 'setPacing'
              ? { pacing: command }
              : {}),
        })
      return send(command)
    }
    client.onEvent((event) => {
      if (!['loaded', 'status', 'error'].includes(event.type) || evidence.events.length >= 1024) return
      evidence.events.push({
        type: event.type,
        at: performance.now(),
        ...('requestId' in event ? { requestId: event.requestId } : {}),
        ...('simTime' in event ? { simTime: event.simTime } : {}),
        ...('detail' in event ? { detail: event.detail } : {}),
      })
    })
    const mod = await (window.__loadSimAudio as unknown as () => Promise<AudioModule>)()
    const create = mod.SimAudioOutput.create.bind(mod.SimAudioOutput)
    mod.SimAudioOutput.create = async (ctx, mode, rate, options = {}) => {
      const output = await create(ctx, mode, rate, options)
      const audit: SoundAudit = {
        mode,
        rate,
        fullScale: options.fullScale ?? 5,
        context: ctx as AudioContext,
        createdAt: performance.now(),
        stoppedAt: null,
        feeds: 0,
        samples: 0,
        first: null,
        end: null,
        dt: 0,
        gaps: 0,
        nonfinite: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        maxFeedGapMs: 0,
        lastFeedAt: null,
        scheduled: [],
      }
      evidence.outputs.push(audit)
      const osc = (output as unknown as { osc?: OscillatorNode }).osc
      if (osc) {
        const ramp = osc.frequency.linearRampToValueAtTime.bind(osc.frequency)
        osc.frequency.linearRampToValueAtTime = (value, time) => {
          if (audit.scheduled.length < 4096)
            audit.scheduled.push({
              f0: value,
              at: time,
              now: ctx.currentTime,
              wall: performance.now(),
              simEnd: audit.end,
            })
          return ramp(value, time)
        }
      }
      const feed = output.feed.bind(output)
      output.feed = (samples, t0, dt) => {
        const now = performance.now()
        if (audit.end !== null && Math.abs(t0 - audit.end - dt) > dt * 0.01) audit.gaps++
        if (audit.lastFeedAt !== null) audit.maxFeedGapMs = Math.max(audit.maxFeedGapMs, now - audit.lastFeedAt)
        audit.lastFeedAt = now
        audit.first ??= t0
        audit.end = t0 + (samples.length - 1) * dt
        audit.dt = dt
        audit.feeds++
        audit.samples += samples.length
        for (const value of samples) {
          if (!Number.isFinite(value)) audit.nonfinite++
          else {
            audit.min = Math.min(audit.min, value)
            audit.max = Math.max(audit.max, value)
          }
        }
        feed(samples, t0, dt)
      }
      const stop = output.stop.bind(output)
      output.stop = () => {
        audit.stoppedAt ??= performance.now()
        stop()
      }
      return output
    }
    new PerformanceObserver((list) => {
      for (const item of list.getEntries())
        if (evidence.longTasks.length < 512) evidence.longTasks.push({ at: item.startTime, duration: item.duration })
    }).observe({ type: 'longtask', buffered: false })
  })
}

export async function sd22Evidence(page: Page) {
  return page.evaluate(() => {
    const evidence = (window as unknown as WindowEvidence).__sd22Evidence
    const client = window.__simClient as unknown as Sd22Client
    if (!evidence)
      return {
        outputs: [],
        commands: [],
        events: [],
        longTasks: [],
        stats: { ...client.stats },
      }
    return {
      ...evidence,
      outputs: evidence.outputs.map(({ context, ...output }) => ({ ...output, contextState: context.state })),
      stats: { ...client.stats },
    }
  })
}

/** Electron captures this app's own frame and audio, not system loopback or a second synthesizer. */
export async function sd22StartRecording(app: ElectronApplication, page: Page) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.session.setDisplayMediaRequestHandler((request, grant) => {
      if (!request.frame) grant(null)
      else grant({ video: request.frame, audio: request.frame, enableLocalEcho: true })
    })
  })
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true })
    if (stream.getAudioTracks().length !== 1) throw new Error('The actual app audio track is missing')
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    const stop = async () => {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('The actual app recorder did not stop')), 10_000)
        recorder.onerror = (event) => {
          clearTimeout(timer)
          reject(new Error(`Actual app recording failed: ${event.type}`))
        }
        recorder.onstop = () => {
          clearTimeout(timer)
          done()
        }
        if (recorder.state === 'inactive') {
          clearTimeout(timer)
          done()
        } else recorder.stop()
      })
      for (const track of stream.getTracks()) track.stop()
      const blob = new Blob(chunks, { type: recorder.mimeType })
      Object.assign(window, { __sd22RecordedBlob: blob })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }
    recorder.start(1000)
    Object.assign(window, { __sd22StopRecording: stop })
  })
}

export async function sd22StopRecording(page: Page, path: string) {
  const bytes = await page.evaluate(async () => {
    const stop = (window as unknown as { __sd22StopRecording?: () => Promise<number[]> }).__sd22StopRecording
    return stop ? stop() : null
  })
  if (bytes) writeFileSync(resolve(path), Buffer.from(bytes))
  return Boolean(bytes)
}

/** Decode the actual recorded Opus track with Chromium; no playback or extra synthesis. */
export async function sd22RecordingAudio(page: Page, path: string) {
  const decoded = await page.evaluate(async () => {
    const blob = (window as unknown as { __sd22RecordedBlob?: Blob }).__sd22RecordedBlob
    if (!blob) throw new Error('The actual recorded app blob is missing')
    const decoder = new AudioContext({ sampleRate: 44_100 })
    try {
      const audio = await decoder.decodeAudioData(await blob.arrayBuffer())
      const samples = audio.getChannelData(0)
      let energy = 0
      let peak = 0
      for (const value of samples) {
        energy += value * value
        peak = Math.max(peak, Math.abs(value))
      }
      const windows: { start: number; samples: number[] }[] = []
      const from = Math.max(0, audio.duration - 30)
      const seconds = Math.min(0.05, audio.duration)
      for (let i = 0; i < 64; i++) {
        const start = from + ((audio.duration - from - seconds) * i) / 63
        const offset = Math.round(start * audio.sampleRate)
        windows.push({
          start,
          samples: Array.from(samples.subarray(offset, offset + Math.round(seconds * audio.sampleRate))),
        })
      }
      return {
        sampleRate: audio.sampleRate,
        duration: audio.duration,
        rms: Math.sqrt(energy / samples.length),
        peak,
        windows,
      }
    } finally {
      await decoder.close()
    }
  })
  const tones = decoded.windows
    .flatMap((clip) => analyzeTone(clip.samples, clip.start, 1 / decoded.sampleRate))
    .filter((frame) => frame.rms > 0.002 && frame.f0 > 500 && frame.f0 < 2000)
  return {
    source: resolve(path),
    decoder: 'Chromium AudioContext.decodeAudioData (decoder only, no output nodes)',
    sampleRate: decoded.sampleRate,
    duration: decoded.duration,
    rms: decoded.rms,
    peak: decoded.peak,
    audibleToneFrames: tones.length,
    minFrequency: Math.min(...tones.map((frame) => frame.f0)),
    maxFrequency: Math.max(...tones.map((frame) => frame.f0)),
    tones,
  }
}
