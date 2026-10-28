import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot } from './helpers/instruments'

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
  await addWire('ins-dc-power.CH1P', 'dc1.TH_USP')
  await addWire('ins-dc-power.CH1N', 'dc1.TH_USN')
  await addWire('ins-dc-voltmeter.POS', 'dc1.TH_A')
  await addWire('ins-dc-voltmeter.NEG', 'dc1.TH_B')
}

async function reading(panelName: string) {
  const output = meterPanel(panelName).locator('output[data-instance-id]')
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
  const panel = meterPanel('直流数字电压表')
  const output = await reading('直流数字电压表')
  await expect(output).toHaveAttribute('data-reading', '3.64')
  await expect(output).toHaveAttribute('data-unit', 'V')
  await expect.poll(() => threeScreenReading('ins-dc-voltmeter')).toBe('ok:3.64')

  const resistance = panel.getByRole('combobox', { name: '输入内阻', exact: true })
  await resistance.click()
  await page.getByRole('option', { name: '10 kΩ', exact: true }).click()
  await expect(panel.locator('[data-panel-id="ins-dc-voltmeter"]')).toHaveAttribute('data-internal-resistance', '10000')
  await expect.poll(async () => output.getAttribute('data-status')).toBe('ok')
  await expect.poll(async () => output.getAttribute('data-reading')).not.toBe('3.64')
  const lowResistanceReading = Number(await output.getAttribute('data-reading'))
  expect(lowResistanceReading).toBeGreaterThan(0)
  expect(lowResistanceReading).toBeLessThan(3.64)
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
