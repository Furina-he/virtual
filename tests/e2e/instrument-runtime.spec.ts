import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

let app: ElectronApplication
let page: Page
let errors: string[]

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })
const meterPanel = (name: string) => page.getByRole('region', { name, exact: true })

async function addWire(a: string, b: string) {
  await addInstrumentWireFromList(page, a, b)
}

async function wireDg01VoltagePoint() {
  await addWire('ins-dc-power.CH1P', 'comp1.IM_IN')
  await addWire('comp1.IM_OUT', 'comp1.RB_1')
  await addWire('comp1.RB_2', 'comp1.RC_1')
  await addWire('comp1.RC_2', 'ins-dc-power.CH1N')
  await addWire('ins-dc-voltmeter.POS', 'comp1.RC_1')
  await addWire('ins-dc-voltmeter.NEG', 'comp1.RC_2')
}

async function reading(panelName: string) {
  const panel = await openInstrumentPanel(page, panelName)
  const output = panel.locator('output[data-instance-id]')
  await expect(output).toHaveAttribute('data-status', /^(ok|overload)$/)
  return output
}

async function threeScreenReading(instanceId: string, screenId = 'MAIN') {
  const raw = await viewport().getAttribute('data-instrument-screen-readings')
  if (!raw) return ''
  const values = JSON.parse(raw) as Record<string, { text?: string; status?: string }>
  const value = values[`${instanceId}.${screenId}`]
  return value ? `${value.status}:${value.text}` : ''
}

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-instrument-runtime-')) },
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
})

test.afterEach(async () => {
  await app.close()
  expect(errors).toEqual([])
})

test('DG-01 实际接线读数随电压表内阻变化，且 2 V 档显示 OL.', async () => {
  await wireDg01VoltagePoint()
  await page.getByRole('button', { name: '上电', exact: true }).click()
  const panel = await openInstrumentPanel(page, '直流数字电压表')
  const output = await reading('直流数字电压表')
  await expect(output).toHaveAttribute('data-reading', '5.00')
  await expect(output).toHaveAttribute('data-unit', 'V')
  await expect.poll(() => threeScreenReading('ins-dc-voltmeter')).toBe('ok:5.00')

  const resistance = panel.getByRole('combobox', { name: '输入内阻', exact: true })
  await resistance.click()
  await page.getByRole('option', { name: '10 kΩ', exact: true }).click()
  await expect(panel.locator('[data-panel-id="ins-dc-voltmeter"]')).toHaveAttribute('data-internal-resistance', '10000')
  await expect.poll(async () => output.getAttribute('data-status')).toBe('ok')
  await expect.poll(async () => output.getAttribute('data-reading')).not.toBe('5.00')
  const lowResistanceReading = Number(await output.getAttribute('data-reading'))
  expect(lowResistanceReading).toBeGreaterThan(0)
  expect(lowResistanceReading).toBeLessThan(5.0)
  await expect
    .poll(async () => {
      const screen = await threeScreenReading('ins-dc-voltmeter')
      return screen.startsWith('ok:') ? Number(screen.slice(3)) : Number.NaN
    })
    .toBe(lowResistanceReading)

  const range = panel.getByRole('combobox', { name: '量程', exact: true })
  await range.click()
  await page.getByRole('option', { name: '2 V', exact: true }).click()
  await expect(output).toHaveAttribute('data-status', 'overload')
  await expect(output).toHaveAttribute('data-reading', 'OL.')
  await expect.poll(() => threeScreenReading('ins-dc-voltmeter')).toBe('overload:OL.')
})

test('万用表电流档接在电压插孔时阻止上电并给出错档提示', async () => {
  await dragInstrumentToSlot(page)
  await addWire('ins-dc-power.CH1P', 'meter1.VOHM')
  await addWire('ins-dc-power.CH1N', 'meter1.COM')
  const panel = meterPanel('数字万用表')
  const range = panel.getByRole('combobox', { name: '档位', exact: true })
  await range.click()
  await page.getByRole('option', { name: '直流电流 20 mA', exact: true }).click()
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '断电', exact: true })).toHaveCount(0)
  await expect(editor().getByRole('status')).toContainText(/插孔与档位不匹配|电流档/)
  await expect(panel.locator('output[data-instance-id="meter1"]')).toHaveAttribute('data-status', 'wrong-jacks')
})

test('公共慢速状态提示：正常实时不误报，细步长慢于实时出现告警，恢复或断电后清除', async () => {
  test.setTimeout(90_000)
  await page.evaluate(() => {
    location.hash = '#/practice/DG-19'
  })
  await expect(page.getByRole('button', { name: '拖放 双通道数字示波器', exact: true })).toBeVisible()
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  const scope = meterPanel('双通道数字示波器')
  await expect(scope.locator('canvas[data-instance-id="scope1"]')).toBeVisible()
  await addWire('scope1.OUT', 'scope1.CH1')
  await addWire('scope1.GND', 'dc1.TH_USN')

  const choose = async (label: string, option: string) => {
    await scope.getByRole('combobox', { name: label, exact: true }).click()
    await page.getByRole('option', { name: option, exact: true }).click()
  }
  const setOutFreq = async (hz: string) => {
    const input = scope.getByRole('spinbutton', { name: '内置信号源 频率精确值', exact: true })
    await input.fill(hz)
    await input.press('Enter')
  }
  const simStatus = page.locator('[data-simulation-status]')
  const slowNotice = page.locator('[data-simulation-slow-notice="true"]')

  // 正常实时（50 Hz / 10 ms/div，步长 20 µs）：运行超过 2 s 不应误报慢速
  await setOutFreq('50')
  await choose('时基 s/div', '10 ms/div')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await expect(simStatus).toHaveAttribute('data-simulation-status', '实时测量', { timeout: 10_000 })
  await page.waitForTimeout(2200)
  await expect(simStatus).toHaveAttribute('data-simulation-slow', 'false')
  await expect(slowNotice).toHaveCount(0)

  // 切到更细步长（1000 Hz / 1 ms/div，步长 1 µs）使真实求解显著慢于实时，状态栏出现公共慢速告警
  await setOutFreq('1000')
  await choose('时基 s/div', '1 ms/div')
  await expect(simStatus).toHaveAttribute('data-simulation-slow', 'true', { timeout: 15_000 })
  await expect(slowNotice).toBeVisible()
  await expect(slowNotice).toContainText(/慢于实时（(?:<0\.01|\d+\.\d{2})×）/)
  const ratio = Number(await simStatus.getAttribute('data-realtime-ratio'))
  expect(Number.isFinite(ratio)).toBe(true)
  expect(ratio).toBeGreaterThanOrEqual(0)
  expect(ratio).toBeLessThan(0.85)

  // 恢复常规步长后慢速告警自动消除
  await setOutFreq('50')
  await choose('时基 s/div', '10 ms/div')
  await expect(simStatus).toHaveAttribute('data-simulation-slow', 'false', { timeout: 10_000 })
  await expect(slowNotice).toHaveCount(0)

  // 再次进入慢速后断电，慢速告警立即清除
  await setOutFreq('1000')
  await choose('时基 s/div', '1 ms/div')
  await expect(simStatus).toHaveAttribute('data-simulation-slow', 'true', { timeout: 15_000 })
  await page.getByRole('button', { name: '断电', exact: true }).click()
  await expect(simStatus).toHaveAttribute('data-simulation-status', '未运行')
  await expect(simStatus).toHaveAttribute('data-simulation-slow', 'false')
  await expect(slowNotice).toHaveCount(0)
})
