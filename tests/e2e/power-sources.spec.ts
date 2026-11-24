import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, openInstrumentPanel } from './helpers/instruments'

let app: ElectronApplication
let page: Page
let errors: string[]

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })

async function addWire(a: string, b: string) {
  await addInstrumentWireFromList(page, a, b)
}

async function setExact(panelName: string, label: string, value: string) {
  const panel = await openInstrumentPanel(page, panelName)
  const input = panel.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

async function threeScreenReading(instanceId: string, screenId = 'MAIN') {
  const raw = await viewport().getAttribute('data-instrument-screen-readings')
  if (!raw) return ''
  const values = JSON.parse(raw) as Record<string, { text?: string; status?: string; unit?: string }>
  const value = values[`${instanceId}.${screenId}`]
  return value ? `${value.status}:${value.text}:${value.unit ?? ''}` : ''
}

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-power-sources-')) },
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await page.evaluate(() => {
    location.hash = '#/practice/bench'
  })
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
})

test.afterEach(async () => {
  await app.close()
  expect(errors).toEqual([])
})

test('T1.2 INS-07 直流稳压电源 CV/CC 限流自动切换与三档恒流源测量', async () => {
  // Wire CH1 across dc1 R5 = 330 Ω (KH_D to KH_C); at 24 V, load current is 24 / 330 ≈ 72.7 mA
  await setExact('直流稳压电源', 'CH1 电压', '24')
  await setExact('直流稳压电源', 'CH1 限流', '0.2')
  await addWire('ins-dc-power.CH1P', 'dc1.KH_D')
  await addWire('ins-dc-power.CH1N', 'dc1.KH_C')

  // Wire Constant Current Source (20 mA range, set to 15 mA) through dc1 R1 = 510 Ω (KH_F to KH_A) and DC ammeter
  await setExact('直流稳压电源', '恒流源电流', '15')
  await (await openInstrumentPanel(page, '直流数字毫安表')).getByRole('combobox', { name: '量程', exact: true }).click()
  await page.getByRole('option', { name: '20 mA', exact: true }).click()
  await addWire('ins-dc-power.ISP', 'ins-dc-ammeter.POS')
  await addWire('ins-dc-ammeter.NEG', 'dc1.KH_F')
  await addWire('dc1.KH_A', 'ins-dc-power.ISN')

  await page.getByRole('button', { name: '上电', exact: true }).click()

  const dcaOut = (await openInstrumentPanel(page, '直流数字毫安表')).locator(
    'output[data-instance-id="ins-dc-ammeter"]',
  )
  await expect(dcaOut).toHaveAttribute('data-reading', '15.00', { timeout: 10_000 })

  const activeDcPanel = await openInstrumentPanel(page, '直流稳压电源')
  const ch1Out = activeDcPanel.locator('output[data-instance-id="ins-dc-power"][data-screen-id="CH1"]')
  const isOut = activeDcPanel.locator('output[data-instance-id="ins-dc-power"][data-screen-id="IS"]')

  await expect(ch1Out).toHaveAttribute('data-status', 'ok', { timeout: 10_000 })
  await expect(ch1Out).toHaveAttribute('data-reading', '24.00')
  await expect(ch1Out).toContainText('CV 稳压')

  await expect(isOut).toHaveAttribute('data-status', 'ok')
  await expect(isOut).toHaveAttribute('data-reading', '15.00')
  await expect(isOut).toContainText('CC 恒流')

  // Lower CH1 current limit to 0.03 A (30 mA) => 30 mA * 330 Ω = 9.90 V, entering CC mode!
  await setExact('直流稳压电源', 'CH1 限流', '0.03')
  await expect(ch1Out).toContainText('CC 限流', { timeout: 10_000 })
  await expect(ch1Out).toHaveAttribute('data-reading', '9.90')
  await expect.poll(() => threeScreenReading('ins-dc-power', 'CH1')).toBe('ok:9.90:V')
})

test('T1.2 SIM-04 三相调压交流电源相电压/线电压 √3 关系与真实接线测量', async () => {
  const acPanel = await openInstrumentPanel(page, '三相调压交流电源')
  const phaseScreen = acPanel.locator('output[data-instance-id="ins-ac-power"][data-screen-id="PHASE"]')
  const lineScreen = acPanel.locator('output[data-instance-id="ins-ac-power"][data-screen-id="LINE"]')

  // Default u_phase = 220 V => line = 381.1 V
  await expect(phaseScreen).toHaveAttribute('data-reading', '220.0')
  await expect(lineScreen).toHaveAttribute('data-reading', '381.1')

  // Adjust variac to 100 V phase => 173.2 V line, and measure line voltage U-V with AC voltmeter
  await setExact('三相调压交流电源', '相电压调压', '100')
  await expect(phaseScreen).toHaveAttribute('data-reading', '100.0')
  await expect(lineScreen).toHaveAttribute('data-reading', '173.2')

  await addWire('ins-ac-power.U', 'ins-ac-voltmeter.U')
  await addWire('ins-ac-power.V', 'ins-ac-voltmeter.STAR')
  await addWire('ins-ac-power.N', 'dc1.KH_E')

  await page.getByRole('button', { name: '上电', exact: true }).click()

  const acvOut = (await openInstrumentPanel(page, '交流数字电压表')).locator(
    'output[data-instance-id="ins-ac-voltmeter"]',
  )
  await expect(acvOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  const measuredLine = Number(await acvOut.getAttribute('data-reading'))
  expect(measuredLine).toBeGreaterThan(171.5)
  expect(measuredLine).toBeLessThan(174.9)
  await expect.poll(() => threeScreenReading('ins-ac-power', 'LINE')).toBe('ok:173.2:V')
})
