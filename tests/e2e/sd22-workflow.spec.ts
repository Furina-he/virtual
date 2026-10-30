import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import type { SignalMeasurement } from '../../src/domain/instruments/scope'
import type { WaveformWindow } from '../../src/domain/task/measurements'
import { requiredMeasurements } from '../../src/domain/task/progress'
import type { Step } from '../../src/shared/schema/project'
import {
  region,
  sd22Choose,
  sd22Data,
  sd22Evidence,
  sd22Nets,
  sd22Observe,
  sd22Off,
  sd22Project,
  sd22RecordingAudio,
  sd22RemoveLeads,
  sd22RequestedWindows,
  sd22Scope,
  sd22ScopeLeads,
  sd22Setup,
  sd22StartRecording,
  sd22Steps,
  sd22StopRecording,
  sd22Tab,
  sd22Timebase,
  sd22Wire,
} from './helpers/sd22'

const cell = (page: Page, table: string, column: string) =>
  sd22Data(page).locator(`input[data-table-id="${table}"][data-column-id="${column}"][data-row-index="0"]`)

async function completed(page: Page, id: string) {
  await sd22Tab(page, '步骤')
  await expect(sd22Steps(page)).toHaveAttribute('data-current-step', id)
  await sd22Steps(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expect(sd22Steps(page).locator(`li[data-step-id="${id}"]`)).toHaveAttribute('data-step-state', 'completed')
}

async function showTable(page: Page, id: string) {
  await sd22Tab(page, '数据记录')
  const table = sd22Project.dataTables.find((item) => item.id === id)
  if (!table) throw new Error(`Missing teaching table ${id}`)
  const select = sd22Data(page).getByRole('combobox', { name: '记录数据表', exact: true })
  await select.click()
  await page.getByRole('option', { name: table.title, exact: true }).click()
  await expect(sd22Data(page)).toHaveAttribute('data-task-table', id)
}

function displayedChannel(pointId: string): number {
  return pointId.startsWith('control-') || pointId.startsWith('lf-cap-') ? 1 : 0
}

async function ready(page: Page, step: Step): Promise<boolean> {
  const scope = await sd22Scope(page)
  const ranges = [...(step.expect ? [step.expect] : []), ...(step.expects ?? [])]
  const points = requiredMeasurements(step).map((id) =>
    sd22Project.reference.measurePoints.find((item) => item.id === id),
  )
  const requests = points.flatMap((point) =>
    point?.windowSec === undefined ? [] : [{ channel: displayedChannel(point.id) + 1, windowSec: point.windowSec }],
  )
  const requested = await sd22RequestedWindows(page, requests)
  return points.every((point) => {
    if (point?.kind !== 'waveform') return false
    const windowSec = point.windowSec
    const observed = windowSec === undefined ? undefined : requested[`${displayedChannel(point.id) + 1}:${windowSec}`]
    const channel =
      observed?.measurement ?? (windowSec === undefined ? scope?.channels[displayedChannel(point.id)] : undefined)
    const quantity = point.quantity ?? 'vpp'
    const value = channel?.[quantity]
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    const window = observed?.window ?? scope?.channels[displayedChannel(point.id)]?.window
    if ((window?.completeCycles ?? 0) < (point.minCycles ?? 0)) return false
    if (windowSec !== undefined) {
      if (!window || !(window.rawStep > 0)) return false
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(window.start), Math.abs(window.end), windowSec) * 8
      if (window.end - window.start + window.rawStep + tolerance < windowSec) return false
    }
    return ranges.every((range) => range.measurePoint !== point.id || (value >= range.min && value <= range.max))
  })
}

async function capture(page: Page, id: string) {
  const step = sd22Project.steps.find((item) => item.id === id)
  const table = sd22Project.dataTables.find((item) => item.id === step?.dataTable)
  if (!step || !table) throw new Error(`Missing measurement-stage table for ${id}`)
  const columns = table.columns.filter((column) => !column.captureSteps || column.captureSteps.includes(id))
  const deadline = Date.now() + 15_000
  do {
    await sd22Tab(page, '仪表')
    await expect
      .poll(() => ready(page, step), { timeout: Math.max(1, deadline - Date.now()), intervals: [50] })
      .toBe(true)
    await page.getByRole('button', { name: '记录读数', exact: true }).click()
    if ((await sd22Steps(page).getAttribute('data-current-step')) !== id) break
  } while (Date.now() < deadline)
  await expect(sd22Steps(page).locator(`li[data-step-id="${id}"]`)).toHaveAttribute('data-step-state', 'completed')
  await showTable(page, table.id)
  const values: Record<
    string,
    {
      value: number
      source: string
      channel: string
      requestedWindowSec?: number
      window?: WaveformWindow
      statistics?: SignalMeasurement
    }
  > = {}
  for (const column of columns) {
    const input = cell(page, table.id, column.id)
    await expect(input).not.toHaveValue('')
    await expect(input).toHaveAttribute('data-captured-from', 'scope1')
    const point = sd22Project.reference.measurePoints.find((entry) => entry.id === column.measurePoint)
    let window: WaveformWindow | undefined
    let statistics: SignalMeasurement | undefined
    if (point?.windowSec !== undefined) {
      await expect(input).toHaveAttribute('data-requested-window-sec', String(point.windowSec))
      const rawWindow = await input.getAttribute('data-captured-window')
      expect(rawWindow, 'Recorded mean must retain its actual requested sampling window').not.toBeNull()
      window = JSON.parse(rawWindow as string) as WaveformWindow
      expect(window.source).toBe('stream')
      expect(window.frozen).toBe(false)
      expect(window.rawStep).toBeLessThanOrEqual(2e-6)
      expect(window.rawStep).toBeGreaterThan(0)
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(window.start), Math.abs(window.end), point.windowSec) * 8
      expect(window.end - window.start + window.rawStep + tolerance).toBeGreaterThanOrEqual(point.windowSec)
      const rawStatistics = await input.getAttribute('data-captured-statistics')
      expect(rawStatistics, 'Statistics must belong to the recorded window, not a later observation').not.toBeNull()
      statistics = JSON.parse(rawStatistics as string) as SignalMeasurement
      expect(statistics[point.quantity ?? 'vpp']).toBeCloseTo(Number(await input.inputValue()), 10)
      const ranges = [...(step.expect ? [step.expect] : []), ...(step.expects ?? [])]
      const sameWindowPoints = sd22Project.reference.measurePoints.filter(
        (entry) =>
          entry.kind === 'waveform' &&
          entry.windowSec === point.windowSec &&
          entry.between?.[0] === point.between?.[0] &&
          entry.between?.[1] === point.between?.[1],
      )
      for (const range of ranges) {
        const bound = sameWindowPoints.find((entry) => entry.id === range.measurePoint)
        if (!bound) continue
        const value = statistics[bound.quantity ?? 'vpp']
        expect(typeof value).toBe('number')
        expect(value).toBeGreaterThanOrEqual(range.min)
        expect(value).toBeLessThanOrEqual(range.max)
      }
    }
    values[column.id] = {
      value: Number(await input.inputValue()),
      source: (await input.getAttribute('data-captured-from')) ?? '',
      channel: (await input.getAttribute('data-captured-channel')) ?? '',
      ...(point?.windowSec === undefined ? {} : { requestedWindowSec: point.windowSec, window, statistics }),
    }
  }
  return values
}

test('SD-22 双模式完整真实操作：检查、供电、长周期/载频/CV/扬声器测量、声音、记录与断电重置', async () => {
  test.setTimeout(360_000)
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-sd22-workflow-')) },
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const stem = resolve(`build/sd22-workflow-${stamp}`)
  const records: Record<string, unknown> = {}
  let recording = false
  let complete = false
  let primaryFailure: unknown
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
    await completed(page, 'prepare')
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(region(page, '接线诊断报告')).toBeVisible()
    await page.screenshot({ path: `${stem}-unwired-report.png` })
    await sd22Nets(page, sd22Project.reference.nets)
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(region(page, '接线编辑').getByRole('status')).toContainText('电路拓扑连接正确。')
    await completed(page, 'wire-ambulance')
    await sd22Choose(page, '直流数字电压表', '量程', '20 V')
    await sd22Wire(page, 'ins-dc-voltmeter.POS', 'timer1.VCC1')
    await sd22Wire(page, 'ins-dc-voltmeter.NEG', 'timer1.GND1')
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await page.getByRole('button', { name: '上电', exact: true }).click()
    await expect(region(page, '直流数字电压表').locator('output')).toHaveAttribute('data-status', 'ok', {
      timeout: 5000,
    })
    await expect(region(page, '直流数字电压表').locator('output')).toHaveAttribute('data-reading', '5.00')
    await page.getByRole('button', { name: '记录读数', exact: true }).click()
    await expect(sd22Steps(page)).toHaveAttribute('data-current-step', 'ambulance-lf')
    await showTable(page, 'supply')
    await expect(cell(page, 'supply', 'u-vcc')).toHaveAttribute('data-captured-from', 'ins-dc-voltmeter')
    records.supply = Number(await cell(page, 'supply', 'u-vcc').inputValue())

    await sd22ScopeLeads(page, 'timer1.T1_OUT', 'timer1.T1_TH')
    await sd22Timebase(page, 0.2)
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await page.getByRole('button', { name: '上电', exact: true }).click()
    records['ambulance-lf'] = await capture(page, 'ambulance-lf')
    await sd22Tab(page, '仪表')
    await page.screenshot({ path: `${stem}-ambulance-lf.png` })
    records['ambulance-lf-evidence'] = await sd22Evidence(page)

    await sd22ScopeLeads(page, 'timer1.T2_OUT', 'timer1.T2_CV')
    await sd22Timebase(page, 0.0002)
    await page.getByRole('button', { name: '上电', exact: true }).click()
    const lowTone = await capture(page, 'ambulance-tone-low')
    records['ambulance-tone-low'] = lowTone
    expect(lowTone['cv-high']?.value).toBeGreaterThan(3.31)
    expect(lowTone['cv-high']?.value).toBeLessThan(3.34)
    const highTone = await capture(page, 'ambulance-tone-high')
    records['ambulance-tone-high'] = highTone
    expect(highTone['cv-low']?.value).toBeGreaterThan(2.49)
    expect(highTone['cv-low']?.value).toBeLessThan(2.51)
    await sd22Tab(page, '仪表')
    await page.screenshot({ path: `${stem}-ambulance-tones.png` })
    records['ambulance-tone-evidence'] = await sd22Evidence(page)

    await sd22ScopeLeads(page, 'timer1.SPK_P')
    await page.getByRole('button', { name: '上电', exact: true }).click()
    records['ambulance-speaker'] = await capture(page, 'ambulance-speaker')
    await sd22Off(page)
    await completed(page, 'record-ambulance')

    await sd22Off(page)
    const modulation = region(page, '接线编辑').locator('li[data-wire-a="timer1.T1_OUT"][data-wire-b="timer1.R5_1"]')
    await modulation.getByRole('button', { name: /^删除导线 \d+$/ }).click()
    for (const [a, b] of [
      ['ins-dc-power.CH1P', 'follower1.VCC'],
      ['ins-dc-power.CH1N', 'follower1.GND'],
      ['timer1.T1_TH', 'follower1.IN'],
      ['follower1.OUT', 'timer1.R5_1'],
    ] as const)
      await sd22Wire(page, a, b)
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(region(page, '接线编辑').getByRole('status')).toContainText('电路拓扑连接正确。')
    await completed(page, 'wire-fire-buffered')
    await sd22ScopeLeads(page, 'timer1.T1_OUT', 'timer1.T1_TH')
    await sd22Timebase(page, 0.2)
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await page.getByRole('button', { name: '上电', exact: true }).click()
    records['fire-buffered-lf'] = await capture(page, 'fire-buffered-lf')
    await sd22Tab(page, '仪表')
    await page.screenshot({ path: `${stem}-fire-lf.png` })

    await sd22ScopeLeads(page, 'timer1.T1_OUT', 'timer1.T2_CV')
    await page.getByRole('button', { name: '上电', exact: true }).click()
    records['fire-buffered-cv'] = await capture(page, 'fire-buffered-cv')
    await sd22Tab(page, '仪表')
    await page.screenshot({ path: `${stem}-fire-cv.png` })
    await sd22ScopeLeads(page, 'timer1.T2_OUT', 'timer1.T2_CV')
    await sd22Timebase(page, 0.0002)
    await page.getByRole('button', { name: '上电', exact: true }).click()
    for (const id of ['fire-buffered-tone-low', 'fire-buffered-tone-mid', 'fire-buffered-tone-high'])
      records[id] = await capture(page, id)
    await sd22Tab(page, '仪表')
    await page.screenshot({ path: `${stem}-fire-carrier.png` })
    records['fire-tone-evidence'] = await sd22Evidence(page)
    await sd22ScopeLeads(page, 'timer1.SPK_P')
    await page.getByRole('button', { name: '上电', exact: true }).click()
    records['fire-buffered-speaker'] = await capture(page, 'fire-buffered-speaker')
    await sd22Off(page)
    await completed(page, 'record-fire-buffered')
    await sd22Off(page)
    await completed(page, 'analyse')
    await expect(sd22Steps(page)).toHaveAttribute('data-completed-count', String(sd22Project.steps.length))
    await page.screenshot({ path: `${stem}-complete.png` })
    await expect
      .poll(async () => (await sd22Evidence(page)).outputs.every((output) => output.contextState === 'closed'))
      .toBe(true)
    const offEvidence = await sd22Evidence(page)
    await page.waitForTimeout(200)
    expect((await sd22Evidence(page)).outputs.map((output) => output.feeds)).toEqual(
      offEvidence.outputs.map((output) => output.feeds),
    )
    await page.getByRole('button', { name: '重置', exact: true }).click()
    await page
      .getByRole('dialog', { name: '重置当前实训？', exact: true })
      .getByRole('button', { name: '确认重置', exact: true })
      .click()
    await expect(region(page, '接线编辑')).toHaveAttribute('data-wire-count', '0')
    await sd22Tab(page, '步骤')
    await expect(sd22Steps(page)).toHaveAttribute('data-current-step', 'prepare')
    await expect(sd22Steps(page)).toHaveAttribute('data-completed-count', '0')
    await showTable(page, 'supply')
    await expect(cell(page, 'supply', 'u-vcc')).toHaveValue('')
    await sd22RemoveLeads(page, 'scope1.')
    expect(errors).toEqual([])
    complete = true
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    try {
      const result = {
        complete,
        claim: complete
          ? 'Both physical workflows completed; realtime performance is a separate mandatory result.'
          : 'Incomplete real workflow attempt; not SD-22 acceptance.',
        records,
        currentStep: await sd22Steps(page)
          .getAttribute('data-current-step')
          .catch(() => null),
        scope: await sd22Scope(page),
        evidence: await sd22Evidence(page),
        errors,
      }
      writeFileSync(`${stem}.json`, `${JSON.stringify(result, null, 2)}\n`)
      await page.screenshot({ path: `${stem}-last.png` })
      if (recording) {
        try {
          await sd22StopRecording(page, `${stem}.webm`)
          const audio = await sd22RecordingAudio(page, `${stem}.webm`)
          writeFileSync(`${stem}-recorded-audio.json`, `${JSON.stringify(audio, null, 2)}\n`)
          expect(audio.rms).toBeGreaterThan(0.002)
          expect(audio.audibleToneFrames).toBeGreaterThan(100)
          if (complete) copyFileSync(`${stem}.webm`, resolve('build/t015-sd22-workflow.webm'))
          await test
            .info()
            .attach('Actual SD-22 app window and app audio', { path: `${stem}.webm`, contentType: 'video/webm' })
        } catch (error) {
          const diagnostic = {
            audioFailure: String(error),
            primaryFailure: primaryFailure ? String(primaryFailure) : null,
          }
          writeFileSync(`${stem}-audio-failure.json`, `${JSON.stringify(diagnostic, null, 2)}\n`)
          await test.info().attach('Actual recording audio failure', {
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
