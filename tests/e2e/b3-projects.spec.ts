import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

// M2 B3（MD-01~09）代表项目 Electron 端到端定向验证：
// 1. MD-01 模拟电路挂箱（mod-analog-base）：2CW51 稳压电路接线检查与 CH1 6→12 V 稳压实测
// 2. MD-04 两级放大与负反馈实验板（mod-analog-fb）：开环高增益与带电切换深负反馈增益大幅下降
// 3. MD-06 场效应管恒流充电器（mod-app-charger）：50/100/200 mA 实时切档恒流与锂电池电压爬升
// 4. MD-09 双挂箱对称正负稳压电源（mod-analog-base + mod-power-reg）：±12.0 V 对称输出与 120 Ω 满载稳压

test.setTimeout(120_000)

let app: ElectronApplication
let page: Page
let errors: string[]

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })
const moduleControls = () => page.getByRole('region', { name: '模块控件', exact: true })

async function launchAt(hash: string, expectedTitle: string) {
  errors = []
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-b3-e2e-')) },
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setMinimumSize(320, 240)
    win?.setContentSize(1366, 768)
    win?.webContents.setZoomFactor(1)
  })
  await page.waitForFunction(() => Math.abs(window.innerWidth - 1366) <= 2 && Math.abs(window.innerHeight - 768) <= 2)
  await page.evaluate((target) => {
    window.location.hash = target
  }, hash)
  await expect(page.getByRole('banner').getByRole('heading')).toContainText(expectedTitle, { timeout: 20_000 })
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false', { timeout: 15_000 })
}

test.afterEach(async () => {
  await app.close()
  expect(errors).toEqual([])
})

async function selectModuleOption(instanceId: string, controlId: string, optionLabel: string) {
  await page.getByRole('tab', { name: '模块控件', exact: true }).click()
  const panel = moduleControls()
  await expect(panel).toBeVisible()
  if ((await panel.getAttribute('data-instance-id')) !== instanceId) {
    await panel.getByRole('combobox', { name: '选择实训模块', exact: true }).click()
    await page.locator(`[role="option"][data-instance-id="${instanceId}"]`).click()
    await expect(panel).toHaveAttribute('data-instance-id', instanceId)
  }
  const control = panel.locator(`[data-control-id="${controlId}"]`)
  await control.getByRole('combobox').click()
  await page.getByRole('option', { name: optionLabel, exact: true }).click()
}

async function selectInPanel(panelName: string, label: string, option: string) {
  const panel = await openInstrumentPanel(page, panelName)
  await panel.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function setInstrumentInput(panelName: string, inputLabel: string, value: string) {
  const panel = await openInstrumentPanel(page, panelName)
  const input = panel.getByRole('spinbutton', { name: inputLabel, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

test('MD-01 模拟电路挂箱：2CW51 稳压电路接线检查与 6→12 V 输入稳压验证', async () => {
  await launchAt('#/practice/MD-01', 'MD-01')

  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'ab1.R470_1'],
    ['ab1.R470_2', 'ab1.DZ_K'],
    ['ab1.DZ_A', 'ins-dc-power.CH1N'],
    ['ins-dc-voltmeter.POS', 'ab1.DZ_K'],
    ['ins-dc-voltmeter.NEG', 'ab1.DZ_A'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  // 步骤推进至阶段 2（zener_reg）
  await page.getByRole('tab', { name: '步骤', exact: true }).click()
  await page.getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await page.getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '6')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  const vmOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect(vmOut).toHaveAttribute('data-status', 'ok', { timeout: 10_000 })
  await expect
    .poll(async () => Number(await vmOut.getAttribute('data-reading')), { timeout: 10_000 })
    .toBeGreaterThan(3.2)
  const u6 = Number(await vmOut.getAttribute('data-reading'))
  expect(u6).toBeLessThan(3.48)

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await openInstrumentPanel(page, '直流数字电压表')
  await expect
    .poll(async () => Number(await vmOut.getAttribute('data-reading')), { timeout: 10_000 })
    .toBeGreaterThan(u6)
  expect(Number(await vmOut.getAttribute('data-reading'))).toBeLessThan(3.62)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('MD-04 两级放大与负反馈实验板：开环高增益与带电切换深负反馈闭环增益骤降', async () => {
  await launchAt('#/practice/MD-04', 'MD-04')

  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'fb1.FB_VCC'],
    ['ins-dc-power.CH1N', 'fb1.FB_GND1'],
    ['generator1.CH1', 'fb1.FB_US'],
    ['generator1.GND', 'fb1.FB_GND2'],
    ['scope1.CH1', 'fb1.FB_UI'],
    ['scope1.CH2', 'fb1.FB_UO'],
    ['scope1.GND', 'fb1.FB_GND2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await setInstrumentInput('双通道函数信号发生器', 'CH1 频率精确值', '1000')
  await setInstrumentInput('双通道函数信号发生器', 'CH1 幅值精确值', '0.03')
  await selectInPanel('双通道数字示波器', 'CH2 V/div', '1 V/div')
  await selectInPanel('双通道数字示波器', '时基 s/div', '500 μs/div')

  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const readCh2Vpp = async () => {
    const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
    if (!raw) return 0
    const parsed = JSON.parse(raw) as { channels?: Array<{ vpp: number | null }> }
    return parsed.channels?.[1]?.vpp ?? 0
  }
  // 开环下 30 mVpp 输入对应输出 > 2.0 Vpp
  await expect.poll(readCh2Vpp, { timeout: 15_000 }).toBeGreaterThan(2.0)

  // 带电切换至深负反馈（Rf=2.2kΩ）：输出峰峰值应显著降至 < 0.7 Vpp
  await selectModuleOption('fb1', 'SW_FB', '深负反馈 (Rf=2.2kΩ)')
  await expect.poll(readCh2Vpp, { timeout: 15_000 }).toBeLessThan(0.75)
  expect(await readCh2Vpp()).toBeGreaterThan(0.18)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('MD-06 场效应管恒流充电器：三档恒流实时切换与锂电池充电爬升', async () => {
  await launchAt('#/practice/MD-06', 'MD-06')

  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'chg1.CHG_VIN'],
    ['chg1.BAT_N', 'chg1.MOS_D'],
    ['ins-dc-power.CH1N', 'chg1.CHG_GND1'],
    ['ins-dc-ammeter.POS', 'chg1.ICHG_A'],
    ['ins-dc-ammeter.NEG', 'chg1.ICHG_B'],
    ['ins-dc-voltmeter.POS', 'chg1.BAT_P'],
    ['ins-dc-voltmeter.NEG', 'chg1.BAT_N'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await selectInPanel('直流数字毫安表', '量程', '2000 mA')

  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const amOut = (await openInstrumentPanel(page, '直流数字毫安表')).locator('output[data-instance-id="ins-dc-ammeter"]')
  await expect(amOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  await expect
    .poll(async () => Number(await amOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(90)
  expect(Number(await amOut.getAttribute('data-reading'))).toBeLessThan(115)

  // 带电切换至 200 mA 档：充电电流跃升至约 200 mA
  await selectModuleOption('chg1', 'I_SET', '200 mA (Rs=3.4Ω)')
  await expect
    .poll(async () => Number(await amOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(178)

  // 检查锂电池电压已经随恒流充电升至初始 3.2 V 以上
  const vmOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect
    .poll(async () => Number(await vmOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(3.4)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('MD-09 双挂箱对称正负直流稳压电源：LM7812 / LM7912 输出 ±12.0 V 与带载稳压', async () => {
  await launchAt('#/practice/MD-09', 'MD-09')

  await dragInstrumentToSlot(page, 'SLOT_DESK_2', '数字万用表')
  for (const [a, b] of [
    ['ins-ac-power.U', 'ab1.AC_P1'],
    ['ins-ac-power.N', 'ab1.AC_P2'],
    ['ab1.AC_S1', 'reg1.AC_1'],
    ['ab1.AC_S2', 'reg1.AC_2'],
    ['ab1.AC_CT', 'reg1.REG_GND'],
    ['reg1.RECT_P', 'reg1.REG78_IN'],
    ['reg1.RECT_N', 'reg1.REG79_IN'],
    ['reg1.REG78_OUT', 'reg1.LOAD_IN'],
    ['ins-dc-voltmeter.POS', 'reg1.REG78_OUT'],
    ['ins-dc-voltmeter.NEG', 'reg1.REG_GND'],
    ['meter1.VOHM', 'reg1.REG79_OUT'],
    ['meter1.COM', 'reg1.REG_GND2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const posOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect(posOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  await expect
    .poll(async () => Math.abs(Number(await posOut.getAttribute('data-reading')) - 12.0), { timeout: 15_000 })
    .toBeLessThan(0.2)

  const negOut = (await openInstrumentPanel(page, '数字万用表')).locator('output[data-instance-id="meter1"]')
  await expect(negOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  await expect
    .poll(async () => Math.abs(Number(await negOut.getAttribute('data-reading')) + 12.0), { timeout: 15_000 })
    .toBeLessThan(0.2)

  // 带电切换至满载 120 Ω（100 mA）：+12V 稳压输出仍保持在 12.00 V ± 0.2 V
  await selectModuleOption('reg1', 'SW_RLOAD', '满载 (120 Ω)')
  await openInstrumentPanel(page, '直流数字电压表')
  await expect
    .poll(async () => Math.abs(Number(await posOut.getAttribute('data-reading')) - 12.0), { timeout: 15_000 })
    .toBeLessThan(0.2)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})
