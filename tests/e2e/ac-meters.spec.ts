import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

let app: ElectronApplication
let page: Page
let errors: string[]

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const meterPanel = (name: string) => page.getByRole('region', { name, exact: true })

async function addWire(a: string, b: string) {
  await addInstrumentWireFromList(page, a, b)
}

async function threeScreenReading(instanceId: string, screenId = 'MAIN') {
  const raw = await viewport().getAttribute('data-instrument-screen-readings')
  if (!raw) return ''
  const values = JSON.parse(raw) as Record<string, { text?: string; status?: string; unit?: string }>
  const value = values[`${instanceId}.${screenId}`]
  return value ? `${value.status}:${value.text}:${value.unit ?? ''}` : ''
}

async function setExact(panelName: string, label: string, value: string) {
  const panel = await openInstrumentPanel(page, panelName)
  const input = panel.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-ac-meters-')) },
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await page.evaluate(() => {
    location.hash = '#/practice/bench'
  })
  await expect(page.getByRole('button', { name: '拖放 双通道交流毫伏表', exact: true })).toBeVisible()
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
})

test.afterEach(async () => {
  await app.close()
  expect(errors).toEqual([])
})

test('T1.1 INS-05 / INS-12 固定交流电压表、电流表与功率表真实采样与多量切换', async () => {
  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await setExact('双通道函数信号发生器', 'CH1 频率', '50')
  await setExact('双通道函数信号发生器', 'CH1 幅值', '20')

  // Switch AC voltmeter to 10 V and AC ammeter to 100 mA
  await (await openInstrumentPanel(page, '交流数字电压表')).getByRole('combobox', { name: '量程', exact: true }).click()
  await page.getByRole('option', { name: '10 V', exact: true }).click()
  await (await openInstrumentPanel(page, '交流数字电流表')).getByRole('combobox', { name: '量程', exact: true }).click()
  await page.getByRole('option', { name: '100 mA', exact: true }).click()

  // Parallel load at dc1.KH_D: R3 (510) || R4 (510) || R5 (330) ≈ 143.0 Ω (KH_A, KH_E, KH_C tied to GND)
  await addWire('generator1.CH1', 'ins-ac-ammeter.I')
  await addWire('ins-ac-ammeter.STAR', 'ins-power-meter.I')
  await addWire('ins-power-meter.I_STAR', 'dc1.KH_D')
  await addWire('dc1.KH_A', 'generator1.GND')
  await addWire('dc1.KH_E', 'generator1.GND')
  await addWire('dc1.KH_C', 'generator1.GND')
  await addWire('dc1.KH_D', 'ins-ac-voltmeter.U')
  await addWire('generator1.GND', 'ins-ac-voltmeter.STAR')
  await addWire('dc1.KH_D', 'ins-power-meter.U')
  await addWire('generator1.GND', 'ins-power-meter.U_STAR')

  await page.getByRole('button', { name: '上电', exact: true }).click()

  const acvOut = (await openInstrumentPanel(page, '交流数字电压表')).locator(
    'output[data-instance-id="ins-ac-voltmeter"]',
  )
  await expect(acvOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  const uVal = Number(await acvOut.getAttribute('data-reading'))

  const acaOut = (await openInstrumentPanel(page, '交流数字电流表')).locator(
    'output[data-instance-id="ins-ac-ammeter"]',
  )
  await expect(acaOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  const iVal = Number(await acaOut.getAttribute('data-reading'))

  // 20 Vpp = 7.071 Vrms; Rtotal = 50 + 2 + 0.05 + 143.02 = 195.07 Ω -> I ≈ 36.25 mA, U ≈ 5.18 V
  expect(uVal).toBeGreaterThan(4.9)
  expect(uVal).toBeLessThan(5.4)
  expect(iVal).toBeGreaterThan(34)
  expect(iVal).toBeLessThan(39)

  const wattPanel = await openInstrumentPanel(page, '单相功率与功率因数表')
  const wattOut = wattPanel.locator('output[data-instance-id="ins-power-meter"]')
  await expect(wattOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })

  const summary = wattPanel.locator('[data-wattmeter-summary="ins-power-meter"]')
  await expect(summary.locator('[data-metric="loadNature"]')).toHaveText('阻性 R')
  const pfSummary = Number(await summary.locator('[data-metric="pf"]').textContent())
  expect(pfSummary).toBeGreaterThan(0.99)

  // Switch wattmeter display mode to cosφ and verify 2D + 3D update immediately
  await wattPanel.getByRole('button', { name: 'cosφ', exact: true }).click()
  await expect(wattOut).toHaveAttribute('data-unit', 'cosφ')
  await expect(wattOut).toHaveAttribute('data-reading', /^1\.000$|^0\.99\d$/)
  await expect.poll(() => threeScreenReading('ins-power-meter')).toMatch(/^ok:(1\.000|0\.99\d):cosφ$/)
})

test('T1.1 INS-13 / INS-14 拖放双通道交流毫伏表与指针式检流计并同步 2D/3D 读数', async () => {
  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await dragInstrumentToSlot(page, 'SLOT_DESK_2', '双通道交流毫伏表')
  await dragInstrumentToSlot(page, 'SLOT_DESK_3', '指针式检流计')

  // Configure signal generator CH1: 1 kHz, 0.2 Vpp (70.71 mVrms)
  await setExact('双通道函数信号发生器', 'CH1 频率', '1000')
  await setExact('双通道函数信号发生器', 'CH1 幅值', '0.2')

  // Set AC millivoltmeter to 100 mV range
  const mvPanel = await openInstrumentPanel(page, '双通道交流毫伏表')
  await mvPanel.getByRole('combobox', { name: '量程', exact: true }).click()
  await page.getByRole('option', { name: '100 mV', exact: true }).click()

  // Divider on dc1: R1 (510) between KH_F and KH_A, R3 (510) between KH_A and KH_D
  await addWire('generator1.CH1', 'dc1.KH_F')
  await addWire('dc1.KH_D', 'generator1.GND')
  await addWire('dc1.KH_F', 'ins-ac-millivoltmeter1.CH1')
  await addWire('dc1.KH_A', 'ins-ac-millivoltmeter1.CH2')
  await addWire('generator1.GND', 'ins-ac-millivoltmeter1.GND')

  // Galvanometer branch on DC power CH1 through TH_USP (R6 330 Ω + R7 510 Ω = 840 Ω) + 1 kΩ galvanometer
  await addWire('ins-dc-power.CH1P', 'ins-galvanometer1.POS')
  await addWire('ins-galvanometer1.NEG', 'dc1.TH_USP')
  await addWire('dc1.TH_USN', 'ins-dc-power.CH1N')

  await page.getByRole('button', { name: '上电', exact: true }).click()

  // Verify AC millivoltmeter CH1 vs CH2 (~67 mV vs ~33 mV)
  const mvOut = (await openInstrumentPanel(page, '双通道交流毫伏表')).locator(
    'output[data-instance-id="ins-ac-millivoltmeter1"]',
  )
  await expect(mvOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  const ch1Mv = Number(await mvOut.getAttribute('data-reading'))
  expect(ch1Mv).toBeGreaterThan(60)
  expect(ch1Mv).toBeLessThan(72)
  await expect
    .poll(() => threeScreenReading('ins-ac-millivoltmeter1'))
    .toBe(`ok:${await mvOut.getAttribute('data-reading')}:mV`)

  await meterPanel('双通道交流毫伏表').getByRole('button', { name: 'CH2', exact: true }).click()
  await expect
    .poll(async () => Number(await mvOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeLessThan(ch1Mv * 0.6)
  const ch2Mv = Number(await mvOut.getAttribute('data-reading'))
  expect(ch2Mv).toBeGreaterThan(28)

  // Verify galvanometer pegs to positive overload (+1) at 6 V and shows OL. on 2D & 3D
  const galvOut = (await openInstrumentPanel(page, '指针式检流计')).locator(
    'output[data-instance-id="ins-galvanometer1"]',
  )
  await expect(galvOut).toHaveAttribute('data-status', 'overload', { timeout: 10_000 })
  await expect(galvOut).toHaveAttribute('data-reading', 'OL.')
  await expect(galvOut).toHaveAttribute('data-deflection', '1.000')
  await expect.poll(() => threeScreenReading('ins-galvanometer1')).toBe('overload:OL.:uA')

  // Set CH1 = 0.1 V via exact input to bring galvanometer into linear ±100 µA range
  await setExact('直流稳压电源', 'CH1 电压', '0.1')
  const galvOutAfter = (await openInstrumentPanel(page, '指针式检流计')).locator(
    'output[data-instance-id="ins-galvanometer1"]',
  )
  await expect(galvOutAfter).toHaveAttribute('data-status', 'ok', { timeout: 10_000 })
  const microAmps = Number(await galvOutAfter.getAttribute('data-reading'))
  // 0.1 V / (330 + 510 + 1000) = 54.3 µA
  expect(microAmps).toBeGreaterThan(45)
  expect(microAmps).toBeLessThan(65)
  const deflPos = Number(await galvOutAfter.getAttribute('data-deflection'))
  expect(deflPos).toBeGreaterThan(0.45)
  expect(deflPos).toBeLessThan(0.65)
})
