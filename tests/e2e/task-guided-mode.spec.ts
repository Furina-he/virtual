import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, openInstrumentPanel } from './helpers/instruments'

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const stepsPanel = (page: Page) => page.getByRole('region', { name: '实训步骤', exact: true })
const dataPanel = (page: Page) => page.getByRole('region', { name: '实训数据记录', exact: true })

async function setExact(page: Page, panelName: string, label: string, value: string) {
  const panel = await openInstrumentPanel(page, panelName)
  const input = panel.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

test('T1.5 TSK-01/03/07 WIR-08 引导/自主模式切换联动 3D 参考虚线、步骤回看、多行数据表快捷记录与合理性提示', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-guided-mode-')) },
  })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await page.evaluate(() => {
      location.hash = '#/practice/MD-07'
    })
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('MD-07 三极管放大电路故障排除')
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    // 1. 引导模式下开启 3D 参考接线虚线，切换到自主模式后自动隐藏且禁止开启
    await expect(viewport(page)).toHaveAttribute('data-guide-mode', 'guided')
    await expect(viewport(page)).toHaveAttribute('data-reference-guide', 'off')
    await viewport(page).getByRole('button', { name: '参考接线', exact: true }).click()
    await expect(viewport(page)).toHaveAttribute('data-reference-guide', 'on')

    // 切换到左栏“步骤”标签页，核对引导模式过程提示与定位列表可见（文案已净化为中文测项名）
    await page.getByRole('tab', { name: '步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-guide-mode', 'guided')
    const measureHint = stepsPanel(page).locator('[data-step-hint="measure-locate"]')
    await expect(measureHint).toHaveAttribute('data-measure-points', 'uc')
    await expect(measureHint).toContainText('需测项：')
    await expect(stepsPanel(page).locator('[data-step-locate-list]')).toBeVisible()

    // 点击顶栏切换为“自主模式” -> 3D 参考虚线立即关闭，且步骤过程测点提示与定位列表全部隐藏
    await page.getByRole('button', { name: '切换引导或自主模式', exact: true }).click()
    await expect(viewport(page)).toHaveAttribute('data-guide-mode', 'free')
    await expect(viewport(page)).toHaveAttribute('data-reference-guide', 'off')
    await expect(viewport(page).locator('[data-guide-mode-notice]')).toContainText('自主模式')
    await expect(stepsPanel(page).locator('[data-step-hint="measure-locate"]')).toHaveCount(0)
    await expect(stepsPanel(page).locator('[data-step-locate-list]')).toHaveCount(0)

    // 在自主模式下点击“参考接线”按钮，保持 off 并给出状态提示
    await viewport(page).getByRole('button', { name: '参考接线', exact: true }).click()
    await expect(viewport(page)).toHaveAttribute('data-reference-guide', 'off')
    await expect(stepsPanel(page).locator('[data-task-notice]')).toContainText('自主模式')

    // 切换回引导模式
    await stepsPanel(page).getByRole('button', { name: '引导模式', exact: true }).click()
    await expect(viewport(page)).toHaveAttribute('data-guide-mode', 'guided')

    // 2. 接线并推进步骤，验证步骤回看聚焦与思考题作答保存
    await setExact(page, '直流稳压电源', 'CH1 电压', '12')
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1P', 'amp1.AMP_VCC')
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1N', 'amp1.AMP_GND1')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.POS', 'amp1.AMP_UC')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.NEG', 'amp1.AMP_GND1')

    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'draw-fault')
    await stepsPanel(page).getByRole('button', { name: '1. wire', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-focused-step', 'wire')

    // 填写思考题作答
    const q1Input = stepsPanel(page).getByRole('textbox', { name: '思考题 1 作答', exact: true })
    await q1Input.fill('需结合 UB 与 UE 区分偏置断路与负载短路')
    await expect(q1Input).toHaveValue('需结合 UB 与 UE 区分偏置断路与负载短路')

    // 3. 多行数据表快捷记录（记录至下一空行）与不合理手填值提示
    await page.getByRole('button', { name: '上电', exact: true }).click()
    await page.getByRole('tab', { name: '数据记录', exact: true }).click()
    await expect(dataPanel(page)).toBeVisible()

    const row0Uc = dataPanel(page).locator(
      'input[data-table-id="fault_points"][data-row-index="0"][data-column-id="uc"]',
    )
    const row1Uc = dataPanel(page).locator(
      'input[data-table-id="fault_points"][data-row-index="1"][data-column-id="uc"]',
    )

    // 等待电压表读数就绪后，连续点击两次“记录至下一空行”，分别自动写入第 1 行和第 2 行
    await expect
      .poll(async () => {
        const raw = await viewport(page).getAttribute('data-instrument-screen-readings')
        return raw?.includes('"ins-dc-voltmeter.MAIN":{"text":"5.87"') ?? false
      })
      .toBe(true)

    await dataPanel(page).getByRole('button', { name: '记录至下一空行', exact: true }).click()
    await expect(row0Uc).toHaveValue('5.87')
    await dataPanel(page).getByRole('button', { name: '记录至下一空行', exact: true }).click()
    await expect(row1Uc).toHaveValue('5.87')

    // 手填不合理 VCC 数值（25 V > 12.5 V 上限），触发 sanity 合理性提示
    const row0Vcc = dataPanel(page).locator(
      'input[data-table-id="fault_points"][data-row-index="0"][data-column-id="vcc"]',
    )
    await row0Vcc.fill('25')
    await row0Vcc.press('Enter')
    await expect(dataPanel(page).locator('[data-task-warnings]')).toContainText('排故标准供电为 12 V')

    await page.getByRole('button', { name: '断电', exact: true }).click()
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
