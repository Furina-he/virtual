import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

// M2 B4（MD-10~19）代表项目 Electron 端到端定向验证：
// 1. MD-12 LM386 集成音响功放：静态中点 4.5 V 与 20× → 200× 实时增益切换
// 2. MD-16 MQ-2 气敏烟雾报警器：0 ppm 待机 → 500 ppm 实时触发报警翻转
// 3. MD-18 三波形函数发生器竞赛（TSK-08）：开始倒计时 → 默认不达标 → 调校频率与幅值并分步验证 3/3 100% 达标
// 4. MD-19 RC 文氏桥正弦波振荡器：1.0 kHz 稳幅正弦起振与实时切至 2.0 kHz

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
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-b4-e2e-')) },
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

async function setModuleNumber(instanceId: string, controlId: string, value: string) {
  await page.getByRole('tab', { name: '模块控件', exact: true }).click()
  const panel = moduleControls()
  await expect(panel).toBeVisible()
  if ((await panel.getAttribute('data-instance-id')) !== instanceId) {
    await panel.getByRole('combobox', { name: '选择实训模块', exact: true }).click()
    await page.locator(`[role="option"][data-instance-id="${instanceId}"]`).click()
    await expect(panel).toHaveAttribute('data-instance-id', instanceId)
  }
  const input = panel.locator(`[data-control-id="${controlId}"]`).getByRole('spinbutton')
  await input.fill(value)
  await input.press('Enter')
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

const readScope = async (channelIdx: 0 | 1) => {
  const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
  if (!raw) return { vpp: 0, frequency: 0 }
  const parsed = JSON.parse(raw) as { channels?: Array<{ vpp: number | null; frequency: number | null }> }
  return {
    vpp: parsed.channels?.[channelIdx]?.vpp ?? 0,
    frequency: parsed.channels?.[channelIdx]?.frequency ?? 0,
  }
}

test('MD-12 LM386 集成音响功放：4.5 V 静态中点与 20× → 200× 实时增益切换', async () => {
  await launchAt('#/practice/MD-12', 'MD-12')

  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'lm1.AMP_VS'],
    ['ins-dc-power.CH1N', 'lm1.AMP_GND1'],
    ['generator1.CH1', 'lm1.AMP_IN'],
    ['generator1.GND', 'lm1.AMP_GND2'],
    ['ins-dc-voltmeter.POS', 'lm1.AMP_OUT'],
    ['ins-dc-voltmeter.NEG', 'lm1.AMP_GND1'],
    ['scope1.CH1', 'lm1.AMP_WIP'],
    ['scope1.CH2', 'lm1.AMP_SPK_P'],
    ['scope1.GND', 'lm1.AMP_SPK_N'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '9')
  await setInstrumentInput('双通道函数信号发生器', 'CH1 频率精确值', '1000')
  await setInstrumentInput('双通道函数信号发生器', 'CH1 幅值精确值', '0.04')
  await setModuleNumber('lm1', 'VOL_POT', '100')
  await selectInPanel('双通道数字示波器', 'CH2 V/div', '1 V/div')
  await selectInPanel('双通道数字示波器', '时基 s/div', '500 μs/div')

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const vmOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect
    .poll(async () => Math.abs(Number(await vmOut.getAttribute('data-reading')) - 4.5), { timeout: 15_000 })
    .toBeLessThan(0.2)

  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(1)).vpp, { timeout: 15_000 }).toBeGreaterThan(0.55)
  const vpp20 = (await readScope(1)).vpp
  expect(vpp20).toBeLessThan(1.0)

  // 带电切换至 200×：输出幅值跃升至 > 3.5 Vpp
  await selectModuleOption('lm1', 'SW_GAIN', '200× (46 dB，1–8 接 10 µF)')
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(1)).vpp, { timeout: 15_000 }).toBeGreaterThan(3.5)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('MD-16 MQ-2 气敏烟雾报警器：0 ppm 待机与 500 ppm 实时触发比较器翻转', async () => {
  await launchAt('#/practice/MD-16', 'MD-16')

  await dragInstrumentToSlot(page, 'SLOT_DESK_2', '数字万用表')
  for (const [a, b] of [
    ['ins-dc-power.V5P', 'smk1.SMK_VCC'],
    ['ins-dc-power.V5N', 'smk1.SMK_GND1'],
    ['ins-dc-voltmeter.POS', 'smk1.SMK_VS'],
    ['ins-dc-voltmeter.NEG', 'smk1.SMK_GND1'],
    ['meter1.VOHM', 'smk1.SMK_CMP'],
    ['meter1.COM', 'smk1.SMK_GND2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const vsOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect
    .poll(async () => Number(await vsOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(0.8)
  expect(Number(await vsOut.getAttribute('data-reading'))).toBeLessThan(1.15)

  const cmpOut = (await openInstrumentPanel(page, '数字万用表')).locator('output[data-instance-id="meter1"]')
  await expect
    .poll(async () => Number(await cmpOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeLessThan(0.3)

  // 带电将烟雾浓度调至 500 ppm：比较器翻转至高电平（> 2.5 V）
  await selectModuleOption('smk1', 'SMOKE_PPM', '中度烟雾 (500 ppm)')
  await openInstrumentPanel(page, '数字万用表')
  await expect
    .poll(async () => Number(await cmpOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(2.5)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('MD-18 TSK-08 三波形函数发生器竞赛：限时启动、自主调频调幅并达成 3/3 100%', async () => {
  await launchAt('#/practice/MD-18', 'MD-18')

  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'oa1.OA_VP'],
    ['ins-dc-power.CH1P', 'oa1.FG_EN'],
    ['ins-dc-power.CH1N', 'ins-dc-power.CH2P'],
    ['ins-dc-power.CH1N', 'oa1.OA_GND1'],
    ['ins-dc-power.CH2N', 'oa1.OA_VM'],
    ['scope1.CH1', 'oa1.FG_SQ'],
    ['scope1.CH2', 'oa1.FG_SIN'],
    ['scope1.GND', 'oa1.OA_GND2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await setInstrumentInput('直流稳压电源', 'CH2 电压精确值', '12')
  await selectInPanel('双通道数字示波器', 'CH1 V/div', '5 V/div')
  await selectInPanel('双通道数字示波器', 'CH2 V/div', '2 V/div')
  await selectInPanel('双通道数字示波器', '时基 s/div', '500 μs/div')

  // 打开步骤栏并启动竞赛倒计时
  await page.getByRole('tab', { name: '步骤', exact: true }).click()
  const compPanel = page.locator('[data-competition-panel]')
  await expect(compPanel).toBeVisible()
  await compPanel.getByRole('button', { name: '开始竞赛', exact: true }).click()
  await expect(compPanel).toHaveAttribute('data-competition-status', 'running')

  // 调校频率电阻 8 kΩ（补偿 LM324 压摆率，f ≈ 1570 Hz）与正弦幅值 75%（≈4.2 Vpp）
  await setModuleNumber('oa1', 'R_FG_FREQ', '8')
  await setModuleNumber('oa1', 'R_FG_AMP', '75')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(0)).frequency, { timeout: 20_000 }).toBeGreaterThan(1350)
  await expect.poll(async () => (await readScope(1)).vpp, { timeout: 20_000 }).toBeGreaterThan(3.4)

  // 首轮核验：频率 + 正弦幅值通过（2/3）
  await compPanel.getByRole('button', { name: '核验竞赛指标', exact: true }).click()
  await expect(compPanel.locator('[data-criterion-id="freq_1500"]')).toHaveAttribute('data-criterion-passed', 'true')
  await expect(compPanel.locator('[data-criterion-id="sin_4vpp"]')).toHaveAttribute('data-criterion-passed', 'true')

  // 断电将 CH2 改接三角波 FG_TRI，复测后达成 3/3 (100%)
  await page.getByRole('button', { name: '断电', exact: true }).click()
  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await editor().getByRole('button', { name: '删除导线 7', exact: true }).click()
  await addInstrumentWireFromList(page, 'scope1.CH2', 'oa1.FG_TRI')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(1)).vpp, { timeout: 20_000 }).toBeGreaterThan(9.5)

  await compPanel.getByRole('button', { name: '核验竞赛指标', exact: true }).click()
  await expect(compPanel).toHaveAttribute('data-competition-status', 'passed')
  await expect(compPanel).toHaveAttribute('data-competition-score', '100')
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('MD-19 RC 文氏桥正弦波振荡器：1.0 kHz 起振稳幅与 2.0 kHz 实时换档', async () => {
  await launchAt('#/practice/MD-19', 'MD-19')

  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'oa1.OA_VP'],
    ['ins-dc-power.CH1P', 'oa1.WIEN_EN'],
    ['ins-dc-power.CH1N', 'ins-dc-power.CH2P'],
    ['ins-dc-power.CH1N', 'oa1.OA_GND1'],
    ['ins-dc-power.CH2N', 'oa1.OA_VM'],
    ['scope1.CH1', 'oa1.WIEN_OUT'],
    ['scope1.CH2', 'oa1.WIEN_P'],
    ['scope1.GND', 'oa1.OA_GND2'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await setInstrumentInput('直流稳压电源', 'CH2 电压精确值', '12')
  await selectInPanel('双通道数字示波器', 'CH1 V/div', '2 V/div')
  await selectInPanel('双通道数字示波器', '时基 s/div', '500 μs/div')

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(0)).frequency, { timeout: 20_000 }).toBeGreaterThan(900)
  expect((await readScope(0)).frequency).toBeLessThan(1100)
  expect((await readScope(0)).vpp).toBeGreaterThan(2.0)

  // 带电切换至 2.0 kHz 档
  await selectModuleOption('oa1', 'SW_WIEN_C', '2.0 kHz (7.96 nF)')
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(0)).frequency, { timeout: 20_000 }).toBeGreaterThan(1800)
  expect((await readScope(0)).frequency).toBeLessThan(2200)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})
