import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

// M2 B2（DG-10~20）代表项目 Electron 端到端定向验证：
// 1. DG-11 阻容移相调光小挂箱（SLOT_BOX_S1）：DB3 + BTA06 移相调光与带电调 RP 有效电压下降
// 2. DG-15 三相灯组挂箱（SLOT_BOX_L1）：不对称 3-2-1 有中线 I_N 与断中线中性点位移 A 相骤降
// 3. DG-18 互感与铁芯变压器小挂箱（SLOT_BOX_S1）：220 V / 36 V 铁芯变压器空载到 25 Ω 带载外特性
// 4. DG-19 正式一阶暂态项目（SLOT_BOX_L1）：动态电路挂箱加载、接线检查与示波器实测 RC 暂态波形

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
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-b2-e2e-')) },
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

test('DG-11 阻容移相调光小挂箱：检查接线、上电实测并在带电调大 RP 时电压显著下降', async () => {
  await launchAt('#/practice/DG-11', 'DG-11')

  for (const [a, b] of [
    ['ins-ac-power.U', 'dim1.AC_L'],
    ['dim1.AC_L', 'dim1.LP_1'],
    ['dim1.LP_2', 'dim1.MT2'],
    ['dim1.MT2', 'dim1.RC_IN'],
    ['dim1.RC_MID', 'dim1.DB_1'],
    ['dim1.DB_2', 'dim1.GATE'],
    ['dim1.MT1', 'dim1.RC_N'],
    ['dim1.RC_N', 'dim1.AC_N'],
    ['dim1.AC_N', 'ins-ac-power.N'],
    ['ins-ac-voltmeter.U', 'dim1.LP_1'],
    ['ins-ac-voltmeter.STAR', 'dim1.LP_2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setModuleControlExact('dim1', 'RP_DIM', '10000')
  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const acvOut = (await openInstrumentPanel(page, '交流数字电压表')).locator(
    'output[data-instance-id="ins-ac-voltmeter"]',
  )
  await expect(acvOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  await expect
    .poll(async () => Number(await acvOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(195)

  // 带电增大移相电位器 RP 至 280 kΩ，导通角缩小，灯泡有效电压显著下降
  await setModuleControlExact('dim1', 'RP_DIM', '280000')
  await expect
    .poll(async () => Number(await acvOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeLessThan(115)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('DG-15 三相四线星形灯组：不对称有中线 I_N 与断中线中性点位移实时响应', async () => {
  await launchAt('#/practice/DG-15', 'DG-15')

  for (const [a, b] of [
    ['ins-ac-power.U', 'lamp3.U_IN'],
    ['ins-ac-power.V', 'lamp3.V_IN'],
    ['ins-ac-power.W', 'lamp3.W_IN'],
    ['lamp3.A2', 'lamp3.N_STAR'],
    ['lamp3.B2', 'lamp3.N_STAR'],
    ['lamp3.C2', 'lamp3.N_STAR'],
    ['lamp3.N_OUT', 'ins-ac-power.N'],
    ['ins-ac-ammeter.I', 'lamp3.IN_A'],
    ['ins-ac-ammeter.STAR', 'lamp3.IN_B'],
    ['ins-ac-voltmeter.U', 'lamp3.A1'],
    ['ins-ac-voltmeter.STAR', 'lamp3.A2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const acvOut = (await openInstrumentPanel(page, '交流数字电压表')).locator(
    'output[data-instance-id="ins-ac-voltmeter"]',
  )
  await expect(acvOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  await expect
    .poll(async () => Math.abs(Number(await acvOut.getAttribute('data-reading')) - 220), { timeout: 15_000 })
    .toBeLessThan(4)

  // 带电切换不对称 3-2-1（有中线）：中线电流升至约 0.315 A，A 相电压仍保持 220 V
  await selectModuleOption('lamp3', 'KB', '2 盏 (80W)')
  await selectModuleOption('lamp3', 'KC', '1 盏 (40W)')
  const acaOut = (await openInstrumentPanel(page, '交流数字电流表')).locator(
    'output[data-instance-id="ins-ac-ammeter"]',
  )
  await expect(acaOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  await expect
    .poll(async () => Number(await acaOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(0.29)
  expect(Number(await acaOut.getAttribute('data-reading'))).toBeLessThan(0.34)

  // 带电断开中线 KN：发生严重中性点位移，重负载 A 相电压骤降至约 164 V
  await selectModuleOption('lamp3', 'KN', '断开中线')
  const acvAgain = (await openInstrumentPanel(page, '交流数字电压表')).locator(
    'output[data-instance-id="ins-ac-voltmeter"]',
  )
  await expect
    .poll(async () => Number(await acvAgain.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeLessThan(172)
  expect(Number(await acvAgain.getAttribute('data-reading'))).toBeGreaterThan(154)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('DG-18 互感与铁芯变压器小挂箱：220 V / 36 V 变压器空载到 25 Ω 外特性电压下降', async () => {
  await launchAt('#/practice/DG-18', 'DG-18')

  for (const [a, b] of [
    ['ins-ac-power.U', 'xf1.TP_1'],
    ['ins-ac-power.N', 'xf1.TP_2'],
    ['xf1.TS_1', 'xf1.IM1_IN'],
    ['xf1.IM1_OUT', 'xf1.TL_1'],
    ['xf1.TS_2', 'xf1.TL_2'],
    ['ins-ac-voltmeter.U', 'xf1.TS_1'],
    ['ins-ac-voltmeter.STAR', 'xf1.TS_2'],
    ['ins-ac-ammeter.I', 'xf1.IM1_A'],
    ['ins-ac-ammeter.STAR', 'xf1.IM1_B'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await selectInPanel('交流数字电压表', '量程', '100 V')
  await selectInPanel('交流数字电流表', '量程', '5 A')

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const acvOut = (await openInstrumentPanel(page, '交流数字电压表')).locator(
    'output[data-instance-id="ins-ac-voltmeter"]',
  )
  await expect(acvOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
  await expect
    .poll(async () => Number(await acvOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(35.0)
  const uNoLoad = Number(await acvOut.getAttribute('data-reading'))
  expect(uNoLoad).toBeLessThan(36.8)

  // 带电接入 25 Ω 副边负载：副边电压平缓下降、副边电流升至约 1.3 A
  await selectModuleOption('xf1', 'SW_TLOAD', '25 Ω')
  await expect
    .poll(async () => Number(await acvOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeLessThan(uNoLoad - 1.0)
  const acaOut = (await openInstrumentPanel(page, '交流数字电流表')).locator(
    'output[data-instance-id="ins-ac-ammeter"]',
  )
  await expect
    .poll(async () => Number(await acaOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(1.2)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('DG-19 正式一阶暂态项目：动态电路挂箱加载、接线检查与示波器实测 RC 暂态波形', async () => {
  await launchAt('#/practice/DG-19', 'DG-19')

  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')

  for (const [a, b] of [
    ['generator1.CH1', 'rlc1.TR_1'],
    ['rlc1.TR_2', 'rlc1.TC_1'],
    ['rlc1.TC_2', 'generator1.GND'],
    ['scope1.CH1', 'rlc1.TR_1'],
    ['scope1.CH2', 'rlc1.TC_1'],
    ['scope1.GND', 'rlc1.TC_2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await page.getByRole('tab', { name: '步骤', exact: true }).click()
  await page.getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await selectInPanel('双通道函数信号发生器', 'CH1 波形', '方波')
  await setInstrumentInput('双通道函数信号发生器', 'CH1 频率精确值', '100')
  await setInstrumentInput('双通道函数信号发生器', 'CH1 幅值精确值', '4')
  await setInstrumentInput('双通道函数信号发生器', 'CH1 直流偏置精确值', '2')

  await selectInPanel('双通道数字示波器', 'CH1 V/div', '1 V/div')
  await selectInPanel('双通道数字示波器', 'CH2 V/div', '1 V/div')
  await selectInPanel('双通道数字示波器', '时基 s/div', '2 ms/div')

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await expect
    .poll(
      async () => {
        const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
        if (!raw) return false
        const parsed = JSON.parse(raw) as { channels?: Array<{ vpp: number | null }> }
        return (parsed.channels?.[0]?.vpp ?? 0) > 3.5 && (parsed.channels?.[1]?.vpp ?? 0) > 3.4
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})
