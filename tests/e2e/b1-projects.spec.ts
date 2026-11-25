import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

// M2 B1（DG-01~09）核心能力 Electron 端到端定向验证：
// 1. DG-01 正式元件箱高阻分压加载误差与 2 V 超量程 OL.
// 2. DG-03 单臂电桥 + 指针式检流计拓扑判定与运行中连续调 Rbox 指零
// 3. DG-09 双大挂箱（dc1 + comp1）并行挂载与 Cu50 温度旋钮实时响应

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
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-b1-e2e-')) },
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
  if (hash) {
    await page.evaluate((target) => {
      window.location.hash = target
    }, hash)
  }
  await expect(page.getByRole('banner').getByRole('heading')).toContainText(expectedTitle, { timeout: 20_000 })
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false', { timeout: 15_000 })
}

test.afterEach(async () => {
  await app.close()
  expect(errors).toEqual([])
})

async function setInstrumentInput(panelName: string, inputLabel: string, value: string) {
  const panel = await openInstrumentPanel(page, panelName)
  const input = panel.getByRole('spinbutton', { name: inputLabel, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

async function setModuleControlExact(instanceId: string, controlId: string, value: string) {
  await page.getByRole('tab', { name: '模块控件', exact: true }).click()
  const panel = moduleControls()
  await expect(panel).toBeVisible()
  if ((await panel.getAttribute('data-instance-id')) !== instanceId) {
    await panel.getByRole('combobox', { name: '选择实训模块', exact: true }).click()
    await page.locator(`[role="option"][data-instance-id="${instanceId}"]`).click()
    await expect(panel).toHaveAttribute('data-instance-id', instanceId)
  }
  const control = panel.locator(`[data-control-id="${controlId}"]`)
  const input = control.getByRole('spinbutton')
  await input.fill(value)
  await input.press('Enter')
}

async function selectInPanel(panelName: string, label: string, option: string) {
  const panel = await openInstrumentPanel(page, panelName)
  await panel.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test('DG-01 正式元件箱高阻分压、内阻加载误差与接线检查', async () => {
  await launchAt('', 'DG-01')

  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'comp1.IM_IN'],
    ['comp1.IM_OUT', 'comp1.RB_1'],
    ['comp1.RB_2', 'comp1.RC_1'],
    ['comp1.RC_2', 'ins-dc-power.CH1N'],
    ['ins-dc-voltmeter.POS', 'comp1.RC_1'],
    ['ins-dc-voltmeter.NEG', 'comp1.RC_2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }
  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const vmOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect(vmOut).toHaveAttribute('data-reading', '10.00', { timeout: 10_000 })

  await selectInPanel('直流数字电压表', '输入内阻', '10 kΩ')
  await expect(vmOut).toHaveAttribute('data-reading', '8.57', { timeout: 10_000 })

  await selectInPanel('直流数字电压表', '输入内阻', '1 kΩ')
  await expect(vmOut).toHaveAttribute('data-reading', '3.75', { timeout: 10_000 })

  await selectInPanel('直流数字电压表', '输入内阻', '10 MΩ')
  await selectInPanel('直流数字电压表', '量程', '2 V')
  await expect(vmOut).toHaveAttribute('data-status', 'overload', { timeout: 10_000 })
  await expect(vmOut).toHaveAttribute('data-reading', 'OL.')
})

test('DG-03 单臂电桥接指针式检流计通过拓扑检查并运行中调 Rbox 指零', async () => {
  await launchAt('#/practice/DG-03', 'DG-03')

  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '指针式检流计')
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'comp1.BR_P'],
    ['comp1.BR_L', 'comp1.RX_1'],
    ['comp1.BR_R', 'comp1.RBOX_1'],
    ['comp1.RX_2', 'comp1.BR_N'],
    ['comp1.RBOX_2', 'comp1.BR_N'],
    ['comp1.BR_N', 'ins-dc-power.CH1N'],
    ['ins-galvanometer1.POS', 'comp1.BR_L'],
    ['ins-galvanometer1.NEG', 'comp1.BR_R'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  // 步骤推进到电桥测 Rx（第 2 步，索引 1），检查接线应不报检流计多余短接
  await page.getByRole('tab', { name: '步骤', exact: true }).click()
  await page.getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const galvOut = (await openInstrumentPanel(page, '指针式检流计')).locator(
    'output[data-instance-id="ins-galvanometer1"]',
  )
  await expect(galvOut).toHaveAttribute('data-status', 'overload', { timeout: 10_000 })

  // 上电运行中经 ADR-009 实时将 Rbox 调至 470 Ω，电桥平衡指零
  await setModuleControlExact('comp1', 'RBOX', '470')
  await expect(galvOut).toHaveAttribute('data-status', 'ok', { timeout: 10_000 })
  await expect
    .poll(async () => Math.abs(Number(await galvOut.getAttribute('data-reading'))), { timeout: 10_000 })
    .toBeLessThan(0.5)
})

test('DG-09 双大挂箱（dc1 + comp1）并行挂载与 Cu50 测温电桥 0→100 ℃ 实时标定', async () => {
  await launchAt('#/practice/DG-09', 'DG-09')

  // 验证左右两大挂箱均已出现在模块控件列表中
  await page.getByRole('tab', { name: '模块控件', exact: true }).click()
  await moduleControls().getByRole('combobox', { name: '选择实训模块', exact: true }).click()
  await expect(page.locator('[role="option"][data-instance-id="dc1"]')).toBeVisible()
  await expect(page.locator('[role="option"][data-instance-id="comp1"]')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'comp1.BR_P'],
    ['comp1.BR_L', 'comp1.CU_1'],
    ['comp1.BR_R', 'comp1.RBOX_1'],
    ['comp1.CU_2', 'comp1.BR_N'],
    ['comp1.RBOX_2', 'comp1.BR_N'],
    ['comp1.BR_N', 'ins-dc-power.CH1N'],
    ['ins-dc-voltmeter.POS', 'comp1.BR_L'],
    ['ins-dc-voltmeter.NEG', 'comp1.BR_R'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setModuleControlExact('comp1', 'RBOX', '50')
  await setModuleControlExact('comp1', 'T_CU50', '0')
  await selectInPanel('直流数字电压表', '量程', '200 mV')

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const vmOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect(vmOut).toHaveAttribute('data-status', 'ok', { timeout: 10_000 })
  await expect
    .poll(async () => Math.abs(Number(await vmOut.getAttribute('data-reading'))), { timeout: 10_000 })
    .toBeLessThan(0.5)

  // 运行中调 Cu50 温度旋钮至 100 ℃，桥压升至约 114 mV
  await setModuleControlExact('comp1', 'T_CU50', '100')
  await expect
    .poll(async () => Number(await vmOut.getAttribute('data-reading')), { timeout: 10_000 })
    .toBeGreaterThan(110)
  expect(Number(await vmOut.getAttribute('data-reading'))).toBeLessThan(118)
})
