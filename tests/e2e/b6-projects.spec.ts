import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

// M2 B6（SD-13~21）定向 Electron E2E 验证：
// 1. SD-16：CD40106 施密特多谐振荡器 2.37 kHz 起振与在线 R_OSC 切频至 ~1.15 kHz
// 2. SD-17：声光控节能路灯（白天有声灭 → 黑夜拍手点亮 12 V / L_LAMP=H）
// 3. SD-20：32768 Hz 晶振 + CD4060 + 74LS74 2 Hz 与 1 Hz 实时秒脉冲
// 4. SD-21：伺服电机 60 槽光电测速 + mod-digital-logic 双挂箱直读 30 r/min 与在线调速 60 r/min

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
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-b6-e2e-')) },
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

async function setInstrumentInput(panelName: string, inputLabel: string, value: string) {
  const panel = await openInstrumentPanel(page, panelName)
  const input = panel.getByRole('spinbutton', { name: inputLabel, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

async function disableScopeSigGen() {
  const scopePanel = await openInstrumentPanel(page, '双通道数字示波器')
  const outOnBtn = scopePanel.getByRole('button', { name: '输出开', exact: true })
  if (await outOnBtn.count()) await outOnBtn.click()
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

test('SD-16 集成施密特触发器：CD40106 RC 多谐振荡器 2.37 kHz 起振与在线 R_OSC 切频', async () => {
  await launchAt('#/practice/SD-16', 'SD-16')

  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.V5P', 'pls1.VCC'],
    ['ins-dc-power.V5N', 'pls1.GND'],
    ['pls1.S106_OUT', 'pls1.OSC_R'],
    ['pls1.OSC_C', 'pls1.S106_IN'],
    ['scope1.CH1', 'pls1.S106_OUT'],
    ['scope1.GND', 'pls1.GND'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await disableScopeSigGen()
  await selectInPanel('双通道数字示波器', '时基 s/div', '200 μs/div')
  await selectInPanel('双通道数字示波器', 'CH1 V/div', '2 V/div')

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(0)).frequency, { timeout: 20_000 }).toBeGreaterThan(2150)

  // 在线切换 R_OSC=10 kΩ -> 频率降至 ~1.15 kHz
  await selectModuleOption('pls1', 'R_OSC', '10 kΩ')
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect
    .poll(
      async () => {
        const f = (await readScope(0)).frequency
        return f > 950 && f < 1300
      },
      { timeout: 20_000 },
    )
    .toBe(true)

  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('SD-17 声光控制节能路灯：白天有声灭 → 黑夜拍手点亮 12 V', async () => {
  await launchAt('#/practice/SD-17', 'SD-17')

  for (const [a, b] of [
    ['ins-dc-power.V5P', 'stl1.VCC'],
    ['ins-dc-power.CH1P', 'stl1.LAMP_V12'],
    ['ins-dc-power.V5N', 'stl1.GND'],
    ['ins-dc-power.CH1N', 'stl1.GND'],
    ['stl1.GND', 'stl1.LAMP_GND'],
    ['stl1.DRV_OUT', 'stl1.REL_IN'],
    ['stl1.REL_NO', 'stl1.LAMP_IN'],
    ['ins-dc-voltmeter.POS', 'stl1.LAMP_IN'],
    ['ins-dc-voltmeter.NEG', 'stl1.LAMP_GND'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await selectModuleOption('stl1', 'LIGHT_LUX', '500 lx (白天)')
  await selectModuleOption('stl1', 'SOUND_LVL', '拍手声 (触发)')

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  const voltOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
    'output[data-instance-id="ins-dc-voltmeter"]',
  )
  // 白天有声 -> 路灯熄灭 (< 0.5 V)
  await expect
    .poll(async () => Number(await voltOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeLessThan(0.5)

  // 切至黑夜 0 lx + 拍手声 -> 路灯点亮 (~12 V) 且 L_LAMP = H
  await selectModuleOption('stl1', 'LIGHT_LUX', '0 lx (黑夜)')
  await expect(moduleControls().locator('[data-module-led="stl1.L_LAMP"]')).toHaveAttribute('data-led-level', 'H', {
    timeout: 15_000,
  })
  await openInstrumentPanel(page, '直流数字电压表')
  await expect
    .poll(async () => Number(await voltOut.getAttribute('data-reading')), { timeout: 15_000 })
    .toBeGreaterThan(10.5)
  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('SD-20 秒脉冲信号发生器：32768 Hz 晶振经 CD4060 + 74LS74 输出 2 Hz 与 1 Hz 实时秒脉冲', async () => {
  await launchAt('#/practice/SD-20', 'SD-20')

  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.V5P', 'sec1.VCC'],
    ['ins-dc-power.V5N', 'sec1.GND'],
    ['sec1.XTAL_OUT', 'sec1.C4060_PHI'],
    ['sec1.K_MR', 'sec1.C4060_MR'],
    ['sec1.C4060_Q14', 'sec1.FF_CP'],
    ['sec1.FF_NQ', 'sec1.FF_D'],
    ['scope1.CH1', 'sec1.C4060_Q14'],
    ['scope1.CH2', 'sec1.FF_Q'],
    ['scope1.GND', 'sec1.GND'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await disableScopeSigGen()
  await selectInPanel('双通道数字示波器', '时基 s/div', '500 ms/div')
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
        const f2 = (await readScope(0)).frequency
        const f1 = (await readScope(1)).frequency
        return f2 >= 1.85 && f2 <= 2.15 && f1 >= 0.9 && f1 <= 1.1
      },
      { timeout: 25_000 },
    )
    .toBe(true)

  await page.getByRole('button', { name: '断电', exact: true }).click()
})

test('SD-21 伺服电机光电测速：双挂箱联合运行，30 r/min → 60 r/min 实时测频与数码管直读', async () => {
  await launchAt('#/practice/SD-21', 'SD-21')

  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  for (const [a, b] of [
    ['ins-dc-power.V5P', 'dig1.VCC'],
    ['ins-dc-power.V5P', 'spd1.VCC'],
    ['ins-dc-power.CH1P', 'spd1.VM_IN'],
    ['ins-dc-power.V5N', 'dig1.GND'],
    ['ins-dc-power.CH1N', 'dig1.GND'],
    ['dig1.GND', 'spd1.GND'],
    ['spd1.ENC_RAW', 'spd1.SCH_IN'],
    ['spd1.TACH_OUT', 'spd1.AND_A'],
    ['spd1.GATE_OUT', 'spd1.AND_B'],
    ['spd1.COUNT_OUT', 'dig1.U1_CP0'],
    ['spd1.RST_AUTO', 'dig1.U1_R0'],
    ['spd1.RST_AUTO', 'dig1.U2_R0'],
    ['dig1.U1_Q0', 'dig1.U1_CP1'],
    ['dig1.U1_Q0', 'dig1.D1_A'],
    ['dig1.U1_Q1', 'dig1.D1_B'],
    ['dig1.U1_Q2', 'dig1.D1_C'],
    ['dig1.U1_Q3', 'dig1.D1_D'],
    ['dig1.U1_Q3', 'dig1.U2_CP0'],
    ['dig1.U2_Q0', 'dig1.U2_CP1'],
    ['dig1.U2_Q0', 'dig1.D2_A'],
    ['dig1.U2_Q1', 'dig1.D2_B'],
    ['dig1.U2_Q2', 'dig1.D2_C'],
    ['dig1.U2_Q3', 'dig1.D2_D'],
    ['scope1.CH1', 'spd1.TACH_OUT'],
    ['scope1.GND', 'spd1.GND'],
  ] as const) {
    await addInstrumentWireFromList(page, a, b)
  }

  await setInstrumentInput('直流稳压电源', 'CH1 电压精确值', '12')
  await disableScopeSigGen()
  await selectInPanel('双通道数字示波器', '时基 s/div', '50 ms/div')
  await selectInPanel('双通道数字示波器', 'CH1 V/div', '2 V/div')

  await page.getByRole('tab', { name: '接线', exact: true }).click()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText(/电路拓扑.*连接正确。/)

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await openInstrumentPanel(page, '双通道数字示波器')
  // 默认 30 r/min -> TACH_OUT ≈ 30 Hz
  await expect.poll(async () => (await readScope(0)).frequency, { timeout: 20_000 }).toBeGreaterThan(28)

  // 等待 1 s 闸门结束后，数字挂箱二位数码管稳定显示 29~31
  const digPanel = await openControls('dig1')
  await expect
    .poll(
      async () => {
        const val = await digPanel.locator('[data-module-segment7-group="dig1"]').getAttribute('data-segment7-value')
        const n = val ? Number(val) : -1
        return n >= 29 && n <= 31
      },
      { timeout: 15_000 },
    )
    .toBe(true)

  // 在线调速至 60 r/min -> 示波器实时升至 ~60 Hz
  await selectModuleOption('spd1', 'SPEED_SET', '60 r/min (60 Hz)')
  await openInstrumentPanel(page, '双通道数字示波器')
  await expect.poll(async () => (await readScope(0)).frequency, { timeout: 20_000 }).toBeGreaterThan(56)

  await page.getByRole('button', { name: '断电', exact: true }).click()
})
