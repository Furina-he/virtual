import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot } from './helpers/instruments'

let app: ElectronApplication
let page: Page
let errors: string[]

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const cabinet = () => page.getByRole('region', { name: '仪表柜', exact: true })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-instrument-placement-')) },
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

test('默认操作视角由学员拖入万用表，已占用安装位不覆盖或自动接线', async () => {
  await expect(viewport()).toHaveAttribute('data-camera-preset', 'work')
  await expect(cabinet()).toHaveAttribute('data-placed-count', '0')
  await expect(viewport()).toHaveAttribute('data-jack-count', '32')
  await expect(cabinet().getByRole('button', { name: /拖放 直流/ })).toHaveCount(0)
  await dragInstrumentToSlot(page)
  await expect(cabinet()).toHaveAttribute('data-placed-count', '1')
  await expect(cabinet().locator('[data-placed-instrument="meter1"]')).toContainText('SLOT_DESK_2')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
  await expect(viewport()).toHaveAttribute('data-jack-count', '36')
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')
  const placements = await viewport().getAttribute('data-placed-instruments')
  const history = await editor().getAttribute('data-undo-count')
  await dragInstrumentToSlot(page)
  await expect(viewport()).toHaveAttribute('data-dragging-instrument', '')
  await expect(cabinet()).toHaveAttribute('data-placed-count', '1')
  await expect(viewport()).toHaveAttribute('data-placed-instruments', placements ?? '')
  await expect(editor()).toHaveAttribute('data-undo-count', history ?? '')
  await expect(cabinet().getByRole('status')).toContainText(/已有仪表|未命中/)
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')
})

test('移除仪表及外线作为一步撤销，恢复相同实例插孔和导线', async () => {
  await dragInstrumentToSlot(page)
  await expect(cabinet()).toHaveAttribute('data-placed-count', '1')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
  await addInstrumentWireFromList(page, 'ins-dc-power.CH1P', 'meter1.VOHM')
  await addInstrumentWireFromList(page, 'ins-dc-power.CH1N', 'meter1.COM')
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
  const original = await viewport().getAttribute('data-wire-endpoints')
  const placements = await viewport().getAttribute('data-placed-instruments')
  await cabinet().getByRole('button', { name: '移除 meter1', exact: true }).click()
  await expect(cabinet()).toHaveAttribute('data-placed-count', '0')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
  await expect(viewport()).toHaveAttribute('data-jack-count', '32')
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')
  await editor().getByRole('combobox', { name: '接线终点', exact: true }).click()
  await expect(page.locator('[role="option"][data-jack-ref^="meter1."]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await viewport().getByRole('button', { name: '操作视角', exact: true }).focus()
  await page.keyboard.press('Control+z')
  await expect(cabinet()).toHaveAttribute('data-placed-count', '1')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
  await expect(viewport()).toHaveAttribute('data-jack-count', '36')
  await expect(viewport()).toHaveAttribute('data-wire-endpoints', original ?? '')
  await expect(viewport()).toHaveAttribute('data-placed-instruments', placements ?? '')
  await editor().getByRole('combobox', { name: '接线终点', exact: true }).click()
  await expect(page.locator('[role="option"][data-jack-ref^="meter1."]')).toHaveCount(4)
  await page.keyboard.press('Escape')
  await viewport().getByRole('button', { name: '操作视角', exact: true }).focus()
  await page.keyboard.press('Control+Shift+z')
  await expect(cabinet()).toHaveAttribute('data-placed-count', '0')
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')
})
