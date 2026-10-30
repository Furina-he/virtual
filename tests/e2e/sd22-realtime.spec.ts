import { mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import {
  region,
  type Sd22Client,
  sd22Evidence,
  sd22Nets,
  sd22Observe,
  sd22Off,
  sd22Project,
  sd22RecordingAudio,
  sd22Scope,
  sd22ScopeLeads,
  sd22Setup,
  sd22StartRecording,
  sd22StopRecording,
  sd22Tab,
  sd22Timebase,
} from './helpers/sd22'

for (const mode of ['ambulance', 'fire-buffered'] as const) {
  test(`SD-22 正式 ${mode} 电路：实际接线、示波器与唯一声音流的实时性能（不是步骤验收替代）`, async () => {
    test.setTimeout(180_000)
    const app = await electron.launch({
      args: ['.'],
      env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), `virtual-sd22-${mode}-`)) },
    })
    let recording = false
    let primaryFailure: unknown
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const stem = resolve(`build/sd22-${mode}-realtime`)
    try {
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window?.setMinimumSize(320, 240)
        window?.setContentSize(1366, 768)
        window?.webContents.setZoomFactor(1)
      })
      await sd22Setup(page)
      await sd22Observe(page)
      await sd22StartRecording(app, page)
      recording = true
      const nets = sd22Project.steps.find((step) => step.id === `wire-${mode}`)?.referenceNets
      if (!nets) throw new Error(`Missing complete ${mode} step topology`)
      await sd22Nets(page, nets)
      await sd22ScopeLeads(page, 'timer1.T1_OUT', 'timer1.T1_TH')
      await sd22Timebase(page, 0.2)
      await page.screenshot({ path: `${stem}-wired.png` })
      await page.getByRole('button', { name: '上电', exact: true }).click()
      await expect
        .poll(
          () =>
            page.evaluate(() => (window.__simClient as unknown as Sd22Client).buffer('indicator:timer1:LS1').length),
          { timeout: 5000 },
        )
        .toBeGreaterThan(0)
      const baseline = await page.evaluate(() => ({
        at: performance.now(),
        time: (window.__simClient as unknown as Sd22Client).buffer('indicator:timer1:LS1').lastTime,
      }))
      await app.evaluate(({ app }) => app.getAppMetrics())
      await page.waitForTimeout(8000)
      const metrics = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((metric) => ({
          type: metric.type,
          name: metric.name,
          pid: metric.pid,
          cpuPercent: metric.cpu.percentCPUUsage,
          workingSetKiB: metric.memory.workingSetSize,
        })),
      )
      const stream = await page.evaluate(() => {
        const client = window.__simClient as unknown as Sd22Client
        const raw = client.buffer('indicator:timer1:LS1')
        const low = client.observation('scope:scope1:CH1').snapshot(16)
        const capacitor = client.observation('scope:scope1:CH2').snapshot(16)
        const envelope = client.observation('scope:scope1:CH1').traces(16)
        return {
          at: performance.now(),
          lastTime: raw.lastTime,
          rawStep: raw.dt,
          capacity: raw.capacity,
          rawBytes: raw.data.byteLength,
          low,
          capacitor,
          envelopePoints: envelope?.min.length,
        }
      })
      const evidence = await sd22Evidence(page)
      const cpu = metrics.find((metric) => metric.type === 'Utility' && metric.name === 'virtual-sim')
      const runningTasks = evidence.longTasks.filter((task) => task.at >= baseline.at)
      const result = {
        mode,
        claim: 'Actual formal circuit performance diagnostic; not a completed teaching workflow.',
        wallSeconds: (stream.at - baseline.at) / 1000,
        simulatedSeconds: stream.lastTime - baseline.time,
        realtimeRatio: (stream.lastTime - baseline.time) / ((stream.at - baseline.at) / 1000),
        cpu,
        cpuSingleCorePercent: (cpu?.cpuPercent ?? -1) * cpus().length,
        measurementConditions:
          '1 Mohm || 20 pF CH2 loads C1; recording and read-only audit overhead included. Raw Electron CPU percentage retained; the multiplied figure is only a logical-core-normalized estimate.',
        metrics,
        stream,
        scope: await sd22Scope(page),
        maxRunningLongTaskMs: Math.max(0, ...runningTasks.map((task) => task.duration)),
        evidence,
      }
      writeFileSync(`${stem}.json`, `${JSON.stringify(result, null, 2)}\n`)
      console.log(`Formal SD-22 realtime: ${JSON.stringify({ ...result, evidence: undefined, metrics: undefined })}`)
      await page.screenshot({ path: `${stem}-running.png` })
      // Keep the mandatory 8 s realtime result intact. This additional wall-time observation
      // documents slow physical cycles and actual sound; it cannot turn the failed ratio green.
      await page.waitForTimeout(30_000)
      const continued = await page.evaluate(() => {
        const client = window.__simClient as unknown as Sd22Client
        return {
          at: performance.now(),
          low: client.observation('scope:scope1:CH1').snapshot(4),
          capacitor: client.observation('scope:scope1:CH2').snapshot(4),
          stats: { ...client.stats },
        }
      })
      const continuedEvidence = await sd22Evidence(page)
      writeFileSync(
        `${stem}-continued.json`,
        `${JSON.stringify({ continued, evidence: continuedEvidence }, null, 2)}\n`,
      )
      await page.screenshot({ path: `${stem}-continued.png` })
      await sd22Tab(page, '数据记录')
      await page.getByRole('button', { name: '记录读数', exact: true }).click()
      await page.screenshot({ path: `${stem}-record-state.png` })
      await sd22Off(page)
      await expect
        .poll(async () => (await sd22Evidence(page)).outputs.every((output) => output.contextState === 'closed'))
        .toBe(true)
      const stopped = await sd22Evidence(page)
      writeFileSync(`${stem}-stopped.json`, `${JSON.stringify(stopped, null, 2)}\n`)
      await page.getByRole('button', { name: '重置', exact: true }).click()
      await page
        .getByRole('dialog', { name: '重置当前实训？', exact: true })
        .getByRole('button', { name: '确认重置', exact: true })
        .click()
      await expect(region(page, '接线编辑')).toHaveAttribute('data-wire-count', '0')

      expect(errors).toEqual([])
      expect(evidence.stats.lostBlocks).toBe(0)
      expect(evidence.stats.lastSeq + 1).toBe(evidence.stats.blocks)
      expect(stream.rawStep).toBeLessThanOrEqual(2e-6)
      expect(stream.capacity).toBe(262_144)
      expect(stream.rawBytes).toBe(1 << 20)
      expect(stream.envelopePoints).toBeLessThanOrEqual(2048)
      const output = evidence.outputs.find((item) => item.feeds > 0)
      expect(output?.mode).toBe('synth')
      expect(output?.fullScale).toBe(5)
      expect(output?.gaps).toBe(0)
      expect(output?.nonfinite).toBe(0)
      expect(output?.min).toBeLessThan(0)
      expect(output?.max).toBeGreaterThan(0)
      expect(evidence.outputs.filter((item) => item.stoppedAt === null)).toHaveLength(1)
      expect(
        evidence.commands
          .filter((command) => command.type === 'setPacing')
          .every((command) => (command.pacing as { mode: string }).mode === 'realtime'),
      ).toBe(true)
      expect(result.maxRunningLongTaskMs).toBeLessThan(50)
      expect(result.realtimeRatio).toBeGreaterThan(0.95)
      expect(result.realtimeRatio).toBeLessThan(1.1)
      expect(stream.low.measurement?.completeCycles).toBeGreaterThanOrEqual(2)
      expect(Math.abs((stream.low.measurement?.frequency ?? 0) / 0.933644982 - 1)).toBeLessThan(0.01)
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      try {
        if (recording) {
          try {
            await sd22StopRecording(page, `${stem}.webm`)
            const audio = await sd22RecordingAudio(page, `${stem}.webm`)
            writeFileSync(`${stem}-recorded-audio.json`, `${JSON.stringify(audio, null, 2)}\n`)
            expect(audio.rms).toBeGreaterThan(0.002)
            expect(audio.audibleToneFrames).toBeGreaterThan(100)
            await test.info().attach(`${mode} actual app window and audio, performance diagnostic`, {
              path: `${stem}.webm`,
              contentType: 'video/webm',
            })
          } catch (error) {
            const diagnostic = {
              audioFailure: String(error),
              primaryFailure: primaryFailure ? String(primaryFailure) : null,
            }
            writeFileSync(`${stem}-audio-failure.json`, `${JSON.stringify(diagnostic, null, 2)}\n`)
            await test.info().attach(`${mode} audio recording failure`, {
              body: JSON.stringify(diagnostic),
              contentType: 'application/json',
            })
            expect.soft(diagnostic.audioFailure, 'Actual recorded audio must decode and be non-silent').toBe('')
          }
        }
      } finally {
        await app.close()
      }
    }
  })
}
