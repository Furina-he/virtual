import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, openInstrumentPanel } from './helpers/instruments'

const fullFlowTitle = 'DG-05 真实接线、单表逐次测量、六列记录、步骤完成和重置'
const recordingsDir = resolve('build/t015-recordings')
const columns = ['i1', 'i2', 'i3', 'u-fa', 'u-ad', 'u-de'] as const
type ColumnId = (typeof columns)[number]
type RecordedValue = { value: number; source: string }

let app: ElectronApplication | undefined
let page: Page
let errors: string[] = []
let recording: ReturnType<Page['video']> = null

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })
const steps = () => page.getByRole('region', { name: '实训步骤', exact: true })
const data = () => page.getByRole('region', { name: '实训数据记录', exact: true })
const panel = (name: string) => page.getByRole('region', { name, exact: true })
const cell = (column: ColumnId) =>
  data().locator(`input[data-table-id="kirchhoff"][data-row-index="0"][data-column-id="${column}"]`)

test.setTimeout(180_000)

test.beforeEach(async () => {
  const info = test.info()
  errors = []
  recording = null
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-dg05-project-')) },
    ...(info.title === fullFlowTitle
      ? { recordVideo: { dir: recordingsDir, size: { width: 1366, height: 768 } } }
      : {}),
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  recording = page.video()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setMinimumSize(320, 240)
    window?.setContentSize(1366, 768)
    window?.webContents.setZoomFactor(1)
  })
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.location.hash = '/practice/DG-05'
  })
  await expect(
    page.getByRole('banner').getByRole('heading', { name: 'DG-05 基尔霍夫定律的验证与应用', exact: true }),
  ).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false')
  await page.waitForFunction(() => Math.abs(window.innerWidth - 1366) <= 2 && Math.abs(window.innerHeight - 768) <= 2)
})

test.afterEach(async () => {
  const info = test.info()
  await app?.close()
  app = undefined
  if (recording) {
    const path = await recording.path()
    expect(statSync(path).size, 'The real Electron recording is saved on close').toBeGreaterThan(0)
    await info.attach('DG-05 实际操作录屏', { path, contentType: 'video/webm' })
  }
  expect(errors).toEqual([])
})

async function showSteps() {
  const tab = page.getByRole('tab', { name: '步骤', exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(steps()).toBeVisible()
}

async function showData() {
  const tab = page.getByRole('tab', { name: '数据记录', exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(data()).toHaveAttribute('data-task-project', 'DG-05')
  await expect(data()).toHaveAttribute('data-task-table', 'kirchhoff')
}

async function expectStep(id: string, completed: number) {
  await expect(steps()).toHaveAttribute('data-current-step', id)
  await expect(steps()).toHaveAttribute('data-completed-count', String(completed))
  if (id) await expect(steps().locator(`li[data-step-id="${id}"]`)).toHaveAttribute('data-step-state', 'current')
}

async function completeStep(current: string, next: string, completed: number) {
  await showSteps()
  await expect(steps()).toHaveAttribute('data-current-step', current)
  await steps().getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expectStep(next, completed)
  await expect(steps().locator(`li[data-step-id="${current}"]`)).toHaveAttribute('data-step-state', 'completed')
}

async function turnOff() {
  const off = page.getByRole('button', { name: '断电', exact: true })
  if (await off.count()) await off.click()
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
}

async function turnOn() {
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await expect(page.getByRole('button', { name: '断电', exact: true })).toBeVisible()
}

async function addWire(a: string, b: string) {
  const previous = Number(await editor().getAttribute('data-wire-count'))
  await addInstrumentWireFromList(page, a, b)
  await expect(editor()).toHaveAttribute('data-wire-count', String(previous + 1))
}

async function connectSources() {
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'dc1.KH_U1P'],
    ['ins-dc-power.CH1N', 'dc1.KH_U1N'],
    ['ins-dc-power.CH2P', 'dc1.KH_U2P'],
    ['ins-dc-power.CH2N', 'dc1.KH_U2N'],
  ] as const) {
    await addWire(a, b)
  }
  await expect(viewport()).toHaveAttribute('data-wire-count', '4')
}

async function setSourceValues() {
  const source = await openInstrumentPanel(page, '直流稳压电源')
  for (const [label, value] of [
    ['CH1 电压', 6],
    ['CH2 电压', 12],
  ] as const) {
    const input = source.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
    await input.fill(String(value))
    await input.press('Enter')
    await expect(input).toHaveValue(String(value))
    await expect(source.getByRole('slider', { name: `${label}旋钮`, exact: true })).toHaveAttribute(
      'aria-valuenow',
      String(value),
    )
  }
}

async function selectSetting(panelName: string, setting: string, optionName: string) {
  const target = await openInstrumentPanel(page, panelName)
  const trigger = target.getByRole('combobox', { name: setting, exact: true })
  await trigger.press('Enter')
  const option = page.getByRole('option', { name: optionName, exact: true })
  await option.focus()
  await expect(option).toBeFocused()
  await option.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toContainText(optionName)
}

async function removeMeterLeads(instanceId: string) {
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
  await editor().getByRole('tab', { name: '接线列表', exact: true }).click()
  const leads = editor().locator(`li[data-wire-a^="${instanceId}."], li[data-wire-b^="${instanceId}."]`)
  await expect(leads).toHaveCount(2)
  for (const remaining of [1, 0]) {
    await leads
      .first()
      .getByRole('button', { name: /^删除导线 \d+$/ })
      .click()
    await expect(leads).toHaveCount(remaining)
  }
  await expect(editor()).toHaveAttribute('data-wire-count', '4')
}

async function connectMeter(instanceId: string, positive: string, negative: string) {
  await addWire(`${instanceId}.POS`, positive)
  await addWire(`${instanceId}.NEG`, negative)
  await expect(editor()).toHaveAttribute('data-wire-count', '6')
}

async function screenReading(instanceId: string) {
  const raw = await viewport().getAttribute('data-instrument-screen-readings')
  if (!raw) return ''
  const readings = JSON.parse(raw) as Record<string, { status?: string; text?: string }>
  const reading = readings[`${instanceId}.MAIN`]
  return reading ? `${reading.status}:${reading.text}` : ''
}

async function expectMeterReading(panelName: string, instanceId: string, value: string, unit: string) {
  const target = await openInstrumentPanel(page, panelName)
  const output = target.locator(`output[data-instance-id="${instanceId}"]`)
  await expect(output).toHaveAttribute('data-status', 'ok')
  await expect(output).toHaveAttribute('data-reading', value)
  await expect(output).toHaveAttribute('data-unit', unit)
  await expect.poll(() => screenReading(instanceId)).toBe(`ok:${value}`)
  const dcPower = await openInstrumentPanel(page, '直流稳压电源')
  for (const [channel, reading] of [
    ['CH1', '6.00'],
    ['CH2', '12.00'],
  ] as const) {
    const source = dcPower.locator(`output[data-instance-id="ins-dc-power"][data-screen-id="${channel}"]`)
    await expect(source).toHaveAttribute('data-status', 'ok')
    await expect(source).toHaveAttribute('data-reading', reading)
  }
}

async function expectCells(recorded: ReadonlyMap<ColumnId, RecordedValue>) {
  await showData()
  await expect(data().locator('input[data-table-id="kirchhoff"]')).toHaveCount(6)
  for (const id of columns) {
    const field = cell(id)
    await expect(field).toHaveAttribute('data-measure-point', id)
    const value = recorded.get(id)
    if (!value) {
      await expect(field).toHaveValue('')
      await expect(field).toHaveAttribute('data-captured-from', '')
      continue
    }
    await expect.poll(async () => Number(await field.inputValue())).toBeCloseTo(value.value, 12)
    await expect(field).toHaveAttribute('data-captured-from', value.source)
    await expect
      .poll(async () => Number(await field.getAttribute('data-reference-value-si')))
      .toBeCloseTo(value.value, 12)
  }
}

const SOURCE_DISPLAY_NAME: Record<string, string> = {
  'ins-dc-ammeter': '直流数字毫安表',
  'ins-dc-voltmeter': '直流数字电压表',
}

async function recordPoint(
  id: ColumnId,
  value: number,
  source: string,
  next: string,
  completed: number,
  recorded: Map<ColumnId, RecordedValue>,
) {
  await expect(steps()).toHaveAttribute('data-current-step', id)
  const before = Number(await steps().getAttribute('data-completed-count'))
  await page.getByRole('button', { name: '记录读数', exact: true }).click()
  await expectStep(next, completed)
  expect(completed).toBe(before + 1)
  recorded.set(id, { value, source })
  await expectCells(recorded)
  // T1.9B 文案净化：反馈使用中文仪表名与工程精度，不向用户裸露 ins-* 内部编码
  await expect(data().locator('[data-task-notice]')).toContainText(SOURCE_DISPLAY_NAME[source] ?? source)
}

async function prepareAndWire() {
  await completeStep('prepare', 'wire', 1)
  await setSourceValues()
  await connectSources()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText('电路拓扑连接正确')
  await completeStep('wire', 'i1', 2)
}

test(fullFlowTitle, async () => {
  expect(recording, 'Electron launch enables a real video recorder').not.toBeNull()
  const size = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  expect(Math.abs(size.width - 1366)).toBeLessThanOrEqual(2)
  expect(Math.abs(size.height - 768)).toBeLessThanOrEqual(2)
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width)
  expect(size.scrollHeight).toBeLessThanOrEqual(size.height)
  const guide = page.getByRole('tabpanel', { name: '实训指导', exact: true })
  for (const section of ['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题']) {
    await expect(guide.getByRole('heading', { name: section, exact: true })).toHaveCount(1)
  }
  await expect(guide).toContainText('0.02 mA')
  await expect(guide).toContainText('6.004 V')
  const schematicTab = page.getByRole('tab', { name: '原理图', exact: true })
  await schematicTab.click()
  await expect(schematicTab).toHaveAttribute('aria-selected', 'true')
  const image = page.getByRole('img', { name: 'DG-05 原理图', exact: true })
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate(
        (element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true)
  await expect(image).toHaveAttribute('src', /\.svg(?:\?.*)?$/)
  await page.getByRole('button', { name: '放大原理图', exact: true }).click()
  const schematic = page.getByRole('dialog')
  await expect(schematic).toHaveCSS('opacity', '1')
  await expect(schematic.getByRole('img', { name: 'DG-05 放大原理图', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('dg05-schematic.png') })
  await page.keyboard.press('Escape')
  await expect(schematic).toBeHidden()

  await showSteps()
  await expectStep('prepare', 0)
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await prepareAndWire()
  await selectSetting('直流数字毫安表', '量程', '20 mA')
  await expect(panel('直流数字毫安表').locator('[data-panel-id="ins-dc-ammeter"]')).toHaveAttribute(
    'data-range',
    'r20m',
  )
  const recorded = new Map<ColumnId, RecordedValue>()

  for (const [id, positive, negative, display, value, next, completed] of [
    ['i1', 'dc1.KH_I1A', 'dc1.KH_I1B', '1.91', 0.00191, 'i2', 3],
    ['i2', 'dc1.KH_I2A', 'dc1.KH_I2B', '-5.95', -0.00595, 'i3', 4],
    ['i3', 'dc1.KH_I3A', 'dc1.KH_I3B', '7.84', 0.00784, 'u-fa', 5],
  ] as const) {
    await turnOff()
    if (recorded.size) await removeMeterLeads('ins-dc-ammeter')
    await connectMeter('ins-dc-ammeter', positive, negative)
    await turnOn()
    await expectMeterReading('直流数字毫安表', 'ins-dc-ammeter', display, 'mA')
    await recordPoint(id, value, 'ins-dc-ammeter', next, completed, recorded)
  }

  await turnOff()
  await removeMeterLeads('ins-dc-ammeter')
  await selectSetting('直流数字电压表', '输入内阻', '10 MΩ')
  await expect(panel('直流数字电压表').locator('[data-panel-id="ins-dc-voltmeter"]')).toHaveAttribute(
    'data-internal-resistance',
    '10000000',
  )
  for (const [index, id, positive, negative, range, display, value, next, completed] of [
    [0, 'u-fa', 'dc1.KH_F', 'dc1.KH_A', '2 V', '0.982', 0.982, 'u-ad', 6],
    [1, 'u-ad', 'dc1.KH_A', 'dc1.KH_D', '20 V', '4.04', 4.04, 'u-de', 7],
    [2, 'u-de', 'dc1.KH_D', 'dc1.KH_E', '2 V', '0.982', 0.982, 'analyse', 8],
  ] as const) {
    await turnOff()
    if (index) await removeMeterLeads('ins-dc-voltmeter')
    await selectSetting('直流数字电压表', '量程', range)
    await connectMeter('ins-dc-voltmeter', positive, negative)
    await turnOn()
    await expectMeterReading('直流数字电压表', 'ins-dc-voltmeter', display, 'V')
    await recordPoint(id, value, 'ins-dc-voltmeter', next, completed, recorded)
  }

  const i1 = Number(await cell('i1').inputValue())
  const i2 = Number(await cell('i2').inputValue())
  const i3 = Number(await cell('i3').inputValue())
  expect(i1 - i2 - i3).toBeCloseTo(0.00002, 12)
  const loop =
    Number(await cell('u-fa').inputValue()) +
    Number(await cell('u-ad').inputValue()) +
    Number(await cell('u-de').inputValue())
  expect(loop).toBeCloseTo(6.004, 12)
  await turnOff()
  await completeStep('analyse', '', 9)
  await expect(steps().getByRole('button', { name: '完成当前步骤', exact: true })).toBeDisabled()
  await expect(steps().locator('li[data-step-state="completed"]')).toHaveCount(9)
  await expectCells(recorded)
  await cell('i1').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('dg05-complete.png') })

  await page.getByRole('button', { name: '重置', exact: true }).click()
  const reset = page.getByRole('dialog', { name: '重置当前实训？', exact: true })
  await expect(reset).toBeVisible()
  await reset.getByRole('button', { name: '取消', exact: true }).click()
  await expect(reset).toBeHidden()
  await expectStep('', 9)
  await expect(editor()).toHaveAttribute('data-wire-count', '6')
  await expectCells(recorded)

  await page.getByRole('button', { name: '重置', exact: true }).click()
  await reset.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(reset).toBeHidden()
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expect(editor()).toHaveAttribute('data-undo-count', '0')
  await expect(editor()).toHaveAttribute('data-redo-count', '0')
  for (const label of ['接线起点', '接线终点']) {
    await expect(editor().getByRole('combobox', { name: label, exact: true })).toHaveAttribute('data-selected-jack', '')
  }
  await expect(editor().getByRole('button', { name: '添加导线', exact: true })).toBeDisabled()
  await showSteps()
  await expectStep('prepare', 0)
  await expectCells(new Map())
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
  await expect(editor().getByRole('button', { name: '撤销接线', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重置', exact: true }).focus()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Shift+z')
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expectCells(new Map())
})

test('DG-05 手填合理性提示不冒充测量证据，断电旧读数和错误测量位置不能完成步骤', async () => {
  await showSteps()
  await prepareAndWire()
  await showData()
  await cell('i1').fill('1.91')
  await cell('i1').press('Enter')
  await expect(data().locator('[data-task-warnings]')).toContainText('I1 超出推荐 20 mA 档的范围')
  await expect(cell('i1')).toHaveAttribute('data-captured-from', '')
  await expectStep('i1', 2)
  await cell('i1').fill('0.00191')
  await cell('i1').press('Enter')
  await expect(data().locator('[data-task-warnings]')).toHaveCount(0)
  await expectStep('i1', 2)
  await cell('i1').fill('')
  await cell('i1').press('Enter')

  await selectSetting('直流数字毫安表', '量程', '20 mA')
  await connectMeter('ins-dc-ammeter', 'dc1.KH_I1A', 'dc1.KH_I1B')
  await turnOn()
  await expectMeterReading('直流数字毫安表', 'ins-dc-ammeter', '1.91', 'mA')
  await turnOff()
  await page.getByRole('button', { name: '记录读数', exact: true }).click()
  await expectCells(new Map())
  await expectStep('i1', 2)
  await expect(data().locator('[data-task-notice]')).toContainText(/尚未就绪|有效读数|上电状态/)

  await removeMeterLeads('ins-dc-ammeter')
  await selectSetting('直流数字电压表', '量程', '2 V')
  await selectSetting('直流数字电压表', '输入内阻', '10 MΩ')
  await connectMeter('ins-dc-voltmeter', 'dc1.KH_F', 'dc1.KH_A')
  await turnOn()
  await expectMeterReading('直流数字电压表', 'ins-dc-voltmeter', '0.982', 'V')
  await showSteps()
  await steps().getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expectStep('i1', 2)
  await expect(steps().locator('[data-task-notice]')).toContainText(/正确档位.*测量点 i1/)
  await expectCells(new Map())
  await turnOff()
  await page.screenshot({ path: test.info().outputPath('dg05-recording-guards.png') })
})

test('跨项目切换清除上电、接线、表格与历史，返回 DG-05 重新初始化相同挂箱场景', async () => {
  await showSteps()
  await prepareAndWire()
  await selectSetting('直流数字毫安表', '量程', '20 mA')
  await connectMeter('ins-dc-ammeter', 'dc1.KH_I1A', 'dc1.KH_I1B')
  await turnOn()
  await expectMeterReading('直流数字毫安表', 'ins-dc-ammeter', '1.91', 'mA')
  const recorded = new Map<ColumnId, RecordedValue>()
  await recordPoint('i1', 0.00191, 'ins-dc-ammeter', 'i2', 3, recorded)
  await expect(editor()).toHaveAttribute('data-wire-count', '6')
  await expect(page.getByRole('button', { name: '断电', exact: true })).toBeVisible()

  await page.evaluate(() => {
    window.location.hash = '/practice/DG-01'
  })
  await expect(page.getByRole('banner').getByRole('heading')).toContainText('DG-01 ')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expect(editor()).toHaveAttribute('data-undo-count', '0')
  await expect(editor()).toHaveAttribute('data-redo-count', '0')
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '断电', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '记录读数', exact: true })).toBeEnabled()
  await showSteps()
  await expectStep('prepare', 0)
  await page.getByRole('tab', { name: '数据记录', exact: true }).click()
  await expect(data()).toHaveAttribute('data-task-project', 'DG-01')
  await expect(data()).toHaveAttribute('data-task-table', 'meter_error')
  await expect(data().locator('input[data-table-id="kirchhoff"]')).toHaveCount(0)

  await page.evaluate(() => {
    window.location.hash = '/practice/DG-05'
  })
  await expect(
    page.getByRole('banner').getByRole('heading', { name: 'DG-05 基尔霍夫定律的验证与应用', exact: true }),
  ).toBeVisible()
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expect(editor()).toHaveAttribute('data-undo-count', '0')
  await expect(editor()).toHaveAttribute('data-redo-count', '0')
  await showSteps()
  await expectStep('prepare', 0)
  await expectCells(new Map())
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
  for (const label of ['接线起点', '接线终点']) {
    await expect(editor().getByRole('combobox', { name: label, exact: true })).toHaveAttribute('data-selected-jack', '')
  }
  await expect(editor().getByRole('button', { name: '添加导线', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '重置', exact: true }).focus()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Shift+z')
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expectStep('prepare', 0)
  await expectCells(new Map())
})
