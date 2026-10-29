import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { addInstrumentWireFromList } from './helpers/instruments'

test('模块开关经公共 alter 更新真实读数，且不重新载入仿真会话', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-module-runtime-')) },
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const region = page.getByRole('region', { name: '3D 实训台', exact: true })
    await expect(region).toHaveAttribute('data-assets-state', 'ready', { timeout: 30000 })
    for (const [a, b] of [
      ['ins-dc-power.CH1P', 'dc1.KH_U1P'],
      ['ins-dc-power.CH1N', 'dc1.KH_U1N'],
      ['ins-dc-voltmeter.POS', 'dc1.KH_F'],
      ['ins-dc-voltmeter.NEG', 'dc1.KH_E'],
    ])
      await addInstrumentWireFromList(page, a as string, b as string)
    await page.getByRole('button', { name: '上电', exact: true }).click()
    const output = page.getByRole('region', { name: '直流数字电压表', exact: true }).locator('output[data-instance-id]')
    await expect(output).toHaveAttribute('data-status', 'ok')
    await expect(output).toHaveAttribute('data-reading', '6.00')
    const sessions = await page.evaluate(
      () => (window.__simClient as unknown as { stats: { sessions: number } }).stats.sessions,
    )
    await page.getByRole('tab', { name: '模块控件', exact: true }).click()
    const control = page
      .getByRole('region', { name: '模块控件', exact: true })
      .getByRole('combobox', { name: 'K1', exact: true })
    await control.press('Enter')
    const off = page.getByRole('option', { name: '0', exact: true })
    await off.focus()
    await off.press('Enter')
    await expect(control).toHaveAttribute('aria-expanded', 'false')
    await expect(output).toHaveAttribute('data-status', 'ok')
    await expect.poll(async () => Number(await output.getAttribute('data-reading'))).toBeLessThan(0.01)
    const after = await page.evaluate(
      () => (window.__simClient as unknown as { stats: { sessions: number } }).stats.sessions,
    )
    expect(after).toBe(sessions)
    await page.getByRole('button', { name: '断电', exact: true }).click()
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
