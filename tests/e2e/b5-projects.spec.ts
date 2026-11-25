import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

// M2 B5（SD-01~12）代表项目 Electron 端到端定向验证：
// 1. SD-01 基本逻辑门电路：+5V 供电、板载 H/L 电平指示与 (0,0)→(1,1) 实时真值翻转
// 2. SD-06 CD4511 译码/驱动：0→5 实时译码、/LT=0 灯测全亮 8 与 /BI=0 消隐全灭
// 3. SD-08 74LS194 双向移位寄存器：手动单次脉冲并行置数 1010 → 右移 0101 实时验证
// 4. SD-12 74LS161 反馈清零六进制计数器：数码管 0~5 循环与示波器 10 Hz / 1.67 Hz 六分频实测

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
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-b5-e2e-')) },
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

async function openControls(instanceId: string) {
  await page.getByRole('tab', { name: '模块控件', exact: true }).click()
  const panel = moduleControls()
  await expect(panel).toBeVisible()
  if ((await panel.getAttribute('data-instance-id')) !== instanceId) {
    await panel.getByRole('combobox', { name: '选择实训模块', exact: true }).click()
    await page.locator(`[role="option"][data-instance-id="${instanceId}"]`).click()
    await expect(panel).toHaveAttribute('data-instance-id', instanceId)
  }
  return panel
}

async function selectModuleOption(instanceId: string, controlId: string, optionLabel: string) {
  const panel = await openControls(instanceId)
  const control = panel.locator(`[data-control-id="${controlId}"]`)
  await control.getByRole('combobox').click()
  await page.getByRole('option', { name: optionLabel, exact: true }).click()
}

async function selectInPanel(panelName: string, label: string, option: string) {
  const panel = await openInstrumentPanel(page, panelName)
  await panel.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

const ledOf = (instanceId: string, ledId: string) =>
  moduleControls().locator(`[data-module-led="${instanceId}.${ledId}"]`)

test('SD-01 基本逻辑门：六种门电路 H/L 指示与 (0,0) → (1,1) 实时翻转', async () => {
  await launchAt('#/practice/SD-01', 'SD-01')

  for (const [a, b] of [
    ['ins-dc-power.V5P', 'dg1.VCC'],
    ['ins-dc-power.V5N', 'dg1.GND'],
    ['dg1.K0', 'dg1.G_A'],
    ['dg1.K1', 'dg1.G_B'],
    ['dg1.Y_NAND', 'dg1.LED0'],
    ['dg1.Y_XOR', 'dg1.LED1'],
    ['ins-dc-voltmeter.POS', 'dg1.Y_AND'],
    ['ins-dc-voltmeter.NEG', 'dg1.GND'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openControls('dg1')
  await expect(ledOf('dg1', 'L_NAND')).toHaveAttribute('data-led-level', 'H', { timeout: 15_000 })
  await expect(ledOf('dg1', 'L_NOR')).toHaveAttribute('data-led-level', 'H')
  await expect(ledOf('dg1', 'L_NOT')).toHaveAttribute('data-led-level', 'H')
  await expect(ledOf('dg1', 'L_AND')).toHaveAttribute('data-led-level', 'L')
  await expect(ledOf('dg1', 'L_OR')).toHaveAttribute('data-led-level', 'L')
  await expect(ledOf('dg1', 'L_XOR')).toHaveAttribute('data-led-level', 'L')

  // 带电切换至 (1,1)：NAND/NOR/NOT/XOR 变 L，AND/OR 变 H 且直流电压表测得 VOH > 2.7 V
  await selectModuleOption('dg1', 'SW_K0', '高电平 H (1)')
  await selectModuleOption('dg1', 'SW_K1', '高电平 H (1)')
  await expect(ledOf('dg1', 'L_AND')).toHaveAttribute('data-led-level', 'H', { timeout: 15_000 })
  await expect(ledOf('dg1', 'L_NAND')).toHaveAttribute('data-led-level', 'L')
  await expect(ledOf('dg1', 'L_XOR')).toHaveAttribute('data-led-level', 'L')
  const vmOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  await expect
    .poll(async () => Number(await vmOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(2.7)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('SD-06 CD4511 七段译码驱动：0→5 实时译码、/LT 灯测全亮 8 与 /BI 消隐', async () => {
  await launchAt('#/practice/SD-06', 'SD-06')

  for (const [a, b] of [
    ['ins-dc-power.V5P', 'dg1.VCC'],
    ['ins-dc-power.V5N', 'dg1.GND'],
    ['dg1.GND', 'dg1.CD_LE'],
    ['dg1.K0', 'dg1.CD_A'],
    ['dg1.K1', 'dg1.CD_B'],
    ['dg1.K2', 'dg1.CD_C'],
    ['dg1.K3', 'dg1.CD_D'],
    ['dg1.K4', 'dg1.CD_LT'],
    ['dg1.K5', 'dg1.CD_BI'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const panel = await openControls('dg1')
  const disp = panel.locator('[data-module-segment7="dg1.DISP1"]')
  await expect(disp).toHaveAttribute('data-segment7-char', '0', { timeout: 15_000 })

  // 输入 BCD 0101 = 5
  await selectModuleOption('dg1', 'SW_K0', '高电平 H (1)')
  await selectModuleOption('dg1', 'SW_K2', '高电平 H (1)')
  await expect(disp).toHaveAttribute('data-segment7-char', '5', { timeout: 15_000 })

  // /LT=0 灯测全亮 8（即使 /BI=0）
  await selectModuleOption('dg1', 'SW_K5', '低电平 L (0)')
  await selectModuleOption('dg1', 'SW_K4', '低电平 L (0)')
  await expect(disp).toHaveAttribute('data-segment7-char', '8', { timeout: 15_000 })

  // 恢复 /LT=1（保持 /BI=0）：全灭消隐
  await selectModuleOption('dg1', 'SW_K4', '高电平 H (1)')
  await expect(disp).toHaveAttribute('data-segment7-char', '-', { timeout: 15_000 })
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('SD-08 74LS194 双向移位寄存器：手动单次脉冲并行置数 1010 → 右移 0101', async () => {
  await launchAt('#/practice/SD-08', 'SD-08')

  for (const [a, b] of [
    ['ins-dc-power.V5P', 'sh1.VCC'],
    ['ins-dc-power.V5P', 'sh1.SH_CLR'],
    ['ins-dc-power.V5P', 'sh1.SH_SR'],
    ['ins-dc-power.V5N', 'sh1.GND'],
    ['ins-dc-power.V5N', 'sh1.SH_SL'],
    ['sh1.K0', 'sh1.SH_S0'],
    ['sh1.K1', 'sh1.SH_S1'],
    ['sh1.CP_MAN', 'sh1.SH_CP'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openControls('sh1')
  // 默认 S1=1, S0=1 并行置数 PAR_DATA=1010：手动单次脉冲上升沿载入
  await expect(ledOf('sh1', 'L_QA')).toHaveAttribute('data-led-level', 'L', { timeout: 15_000 })
  await selectModuleOption('sh1', 'CP_BTN', '高电平 (1)')
  await expect(ledOf('sh1', 'L_QD')).toHaveAttribute('data-led-level', 'H', { timeout: 15_000 })
  await expect(ledOf('sh1', 'L_QB')).toHaveAttribute('data-led-level', 'H')
  await expect(ledOf('sh1', 'L_QA')).toHaveAttribute('data-led-level', 'L')
  await expect(ledOf('sh1', 'L_QC')).toHaveAttribute('data-led-level', 'L')

  // 拉低脉冲并切至右移模式 (S1=0, S0=1, SR=1)，再给一个上升沿 -> 0101 (QA=H, QB=L, QC=H, QD=L)
  await selectModuleOption('sh1', 'CP_BTN', '低电平 (0)')
  await selectModuleOption('sh1', 'SW_K1', '低电平 L (0)')
  await selectModuleOption('sh1', 'CP_BTN', '高电平 (1)')
  await expect(ledOf('sh1', 'L_QA')).toHaveAttribute('data-led-level', 'H', { timeout: 15_000 })
  await expect(ledOf('sh1', 'L_QB')).toHaveAttribute('data-led-level', 'L')
  await expect(ledOf('sh1', 'L_QC')).toHaveAttribute('data-led-level', 'H')
  await expect(ledOf('sh1', 'L_QD')).toHaveAttribute('data-led-level', 'L')
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('SD-12 74LS161 反馈清零六进制计数器：数码管 0~5 循环与示波器 10 Hz / 1.67 Hz 六分频', async () => {
  await launchAt('#/practice/SD-12', 'SD-12')

  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.V5P', 'cn1.VCC'],
    ['ins-dc-power.V5P', 'cn1.C161_LD'],
    ['ins-dc-power.V5N', 'cn1.GND'],
    ['cn1.CLK_OUT', 'cn1.C161_CP'],
    ['cn1.C161_Q0', 'cn1.DISP_A'],
    ['cn1.C161_Q1', 'cn1.FB_A'],
    ['cn1.C161_Q1', 'cn1.DISP_B'],
    ['cn1.C161_Q2', 'cn1.FB_B'],
    ['cn1.C161_Q2', 'cn1.DISP_C'],
    ['cn1.C161_Q3', 'cn1.DISP_D'],
    ['cn1.FB_Y', 'cn1.C161_CLR'],
    ['scope1.CH1', 'cn1.C161_CP'],
    ['scope1.CH2', 'cn1.C161_Q2'],
    ['scope1.GND', 'cn1.GND'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await selectModuleOption('cn1', 'CLK_RATE', '10 Hz')
  const scopePanel = await openInstrumentPanel(page, '双通道数字示波器')
  const outOnBtn = scopePanel.getByRole('button', { name: '输出开', exact: true })
  if (await outOnBtn.count()) await outOnBtn.click()
  await selectInPanel('双通道数字示波器', '时基 s/div', '200 ms/div')
  await selectInPanel('双通道数字示波器', 'CH1 V/div', '2 V/div')
  await selectInPanel('双通道数字示波器', 'CH2 V/div', '2 V/div')

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect
    .poll(
      async () => {
        const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
        if (!raw) return false
        const parsed = JSON.parse(raw) as { channels?: Array<{ id: string; frequency: number | null }> }
        const ch1 = parsed.channels?.find((c) => c.id === 'CH1')?.frequency ?? 0
        const ch2 = parsed.channels?.find((c) => c.id === 'CH2')?.frequency ?? 0
        return ch1 >= 9.5 && ch1 <= 10.5 && ch2 >= 1.5 && ch2 <= 1.85
      },
      { timeout: 25_000 },
    )
    .toBe(true)

  const panel = await openControls('cn1')
  const ch = await panel.locator('[data-module-segment7="cn1.DISP_N"]').getAttribute('data-segment7-char')
  expect(['0', '1', '2', '3', '4', '5']).toContain(ch)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})
