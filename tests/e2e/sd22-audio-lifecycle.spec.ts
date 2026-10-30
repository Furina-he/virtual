import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { region, sd22Evidence, sd22Nets, sd22Observe, sd22Off, sd22Project, sd22Setup, sd22Wire } from './helpers/sd22'

test('SD-22 正式扬声器：断电、真实断线、重上电、快速重置与换项目释放唯一生产者', async () => {
  test.setTimeout(180_000)
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-sd22-audio-life-')) },
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const report: Record<string, unknown> = {}
  const stem = resolve('build/sd22-audio-lifecycle')
  const sound = async () => (await sd22Evidence(page)).outputs.at(-1)
  const power = async () => {
    const previous = (await sd22Evidence(page)).outputs.length
    await page.getByRole('button', { name: '上电', exact: true }).click()
    await expect
      .poll(async () => (await sd22Evidence(page)).outputs.length, { timeout: 5000 })
      .toBeGreaterThan(previous)
    await expect.poll(async () => (await sound())?.feeds ?? 0, { timeout: 5000 }).toBeGreaterThan(0)
  }
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setMinimumSize(320, 240)
      window?.setContentSize(1366, 768)
      window?.webContents.setZoomFactor(1)
    })
    await sd22Setup(page)
    await sd22Observe(page)
    await sd22Nets(page, sd22Project.reference.nets)
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(region(page, '接线编辑').getByRole('status')).toContainText('电路拓扑连接正确。')
    await power()
    expect((await sound())?.min).toBeLessThan(0)
    expect((await sound())?.max).toBeGreaterThan(0)
    report.powered = await sd22Evidence(page)
    await sd22Off(page)
    await expect
      .poll(async () => (await sd22Evidence(page)).outputs.every((output) => output.contextState === 'closed'))
      .toBe(true)
    const stopped = await sound()
    await page.waitForTimeout(250)
    expect((await sound())?.feeds).toBe(stopped?.feeds)
    report.off = await sd22Evidence(page)

    const lead = region(page, '接线编辑').locator('li[data-wire-a="timer1.C5_N"][data-wire-b="timer1.SPK_P"]')
    await lead.getByRole('button', { name: /^删除导线 \d+$/ }).click()
    await power()
    await expect.poll(async () => (await sound())?.scheduled.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0)
    const disconnected = await sound()
    expect(Math.abs(disconnected?.min ?? 1)).toBeLessThan(1e-5)
    expect(Math.abs(disconnected?.max ?? 1)).toBeLessThan(1e-5)
    expect(disconnected?.scheduled.every((frame) => frame.f0 === 0)).toBe(true)
    report.disconnected = await sd22Evidence(page)
    await sd22Off(page)
    await sd22Wire(page, 'timer1.C5_N', 'timer1.SPK_P')
    await power()
    report.repowered = await sd22Evidence(page)
    const loads = (await sd22Evidence(page)).commands.filter((command) => command.type === 'load')
    expect(new Set(loads.map((load) => load.requestId)).size).toBe(loads.length)
    expect((await sd22Evidence(page)).outputs.filter((output) => output.stoppedAt === null)).toHaveLength(1)
    expect(
      (await sd22Evidence(page)).outputs.filter((output) => output.feeds > 0).every((output) => output.first === 0),
    ).toBe(true)

    await sd22Off(page)
    await page.getByRole('button', { name: '上电', exact: true }).click()
    // Reset through the UI while the new load is preparing; late resources must stay stopped.
    await page.getByRole('button', { name: '重置', exact: true }).click()
    await page
      .getByRole('dialog', { name: '重置当前实训？', exact: true })
      .getByRole('button', { name: '确认重置', exact: true })
      .click()
    await expect(region(page, '接线编辑')).toHaveAttribute('data-wire-count', '0')
    await expect
      .poll(async () => (await sd22Evidence(page)).outputs.every((output) => output.contextState === 'closed'))
      .toBe(true)
    await page.waitForTimeout(300)
    expect((await sd22Evidence(page)).outputs.every((output) => output.stoppedAt !== null)).toBe(true)
    report.reset = await sd22Evidence(page)

    await sd22Nets(page, sd22Project.reference.nets)
    await power()
    await page.getByRole('banner').getByRole('button', { name: '返回', exact: true }).click()
    await expect
      .poll(async () => (await sd22Evidence(page)).outputs.every((output) => output.contextState === 'closed'))
      .toBe(true)
    // The project-list/home UI is still unimplemented; use the same public route entry as existing E2E.
    await page.evaluate(() => {
      location.hash = '/practice/DG-05'
    })
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('DG-05')
    const switched = await sd22Evidence(page)
    await page.waitForTimeout(250)
    expect((await sd22Evidence(page)).outputs.map((output) => output.feeds)).toEqual(
      switched.outputs.map((output) => output.feeds),
    )
    report.switched = switched
    expect(errors).toEqual([])
  } finally {
    try {
      report.final = await sd22Evidence(page)
      report.errors = errors
      writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`)
      await page.screenshot({ path: `${stem}.png` })
    } finally {
      await app.close()
    }
  }
})
