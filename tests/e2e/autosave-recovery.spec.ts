import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList } from './helpers/instruments'

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const stepsPanel = (page: Page) => page.getByRole('region', { name: '实训步骤', exact: true })
const dataPanel = (page: Page) => page.getByRole('region', { name: '实训数据记录', exact: true })

test('T1.7 WIR-05 NFR-04 2 s 防抖自动存档、强杀重启崩溃恢复（恢复后断电）与手动存档读取', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-autosave-recovery-'))
  const autosaveFile = join(userData, 'saves', 'DG-05.autosave')
  const manualSaveFile = join(userData, 'saves', 'DG-05.json')

  // 第一阶段：接线、填表、填思考题并保持上电，等待 2 s 自动存档落盘后强杀进程模拟崩溃
  const app1 = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: userData },
  })
  const errors1: string[] = []
  let killed = false
  try {
    const page1 = await app1.firstWindow()
    page1.on('pageerror', (error) => errors1.push(error.message))
    await expect(viewport(page1)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await page1.evaluate(() => {
      location.hash = '#/practice/DG-05'
    })
    await expect(page1.getByRole('banner').getByRole('heading')).toContainText('DG-05 基尔霍夫定律的验证与应用')
    await expect(viewport(page1)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    // 连接 2 根导线
    await addInstrumentWireFromList(page1, 'ins-dc-power.CH1P', 'dc1.KH_U1P')
    await addInstrumentWireFromList(page1, 'ins-dc-power.CH1N', 'dc1.KH_U1N')
    await expect(page1.getByText('导线：2')).toBeVisible()

    // 填写数据表记录
    await page1.getByRole('tab', { name: '数据记录', exact: true }).click()
    const i1Cell = dataPanel(page1).locator('input[data-table-id="kirchhoff"][data-row-index="0"][data-column-id="i1"]')
    await i1Cell.fill('0.00191')
    await i1Cell.press('Enter')

    // 填写思考题作答
    await page1.getByRole('tab', { name: '步骤', exact: true }).click()
    const q1 = stepsPanel(page1).getByRole('textbox', { name: '思考题 1 作答', exact: true })
    await q1.fill('I2 实际电流方向与参考方向相反。')

    // 保持上电状态，验证崩溃恢复后不会保持带电
    await page1.getByRole('button', { name: '上电', exact: true }).click()
    await expect(page1.getByText('已上电', { exact: true })).toBeVisible()

    // 等待 2 s 防抖自动存档完成并落盘
    await expect(page1.locator('[data-autosave-state="saved"]')).toBeVisible({ timeout: 10_000 })
    expect(existsSync(autosaveFile)).toBe(true)
    const rawAutosave = JSON.parse(readFileSync(autosaveFile, 'utf8')) as {
      circuit: { wires: unknown[]; powered?: boolean }
    }
    expect(rawAutosave.circuit.wires).toHaveLength(2)
    expect(rawAutosave.circuit.powered).toBeUndefined()
    expect(errors1).toEqual([])

    // 强杀进程模拟异常崩溃退出
    const proc = app1.process()
    const exitPromise = new Promise<void>((resolve) => {
      proc.once('exit', () => resolve())
    })
    proc.kill('SIGKILL')
    await exitPromise
    killed = true
  } finally {
    if (!killed) await app1.close().catch(() => {})
  }

  // 第二阶段：使用同一 userData 重启应用，进入 DG-05 验证崩溃恢复提示与一键恢复
  const app2 = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: userData },
  })
  const errors2: string[] = []
  try {
    const page2 = await app2.firstWindow()
    page2.on('pageerror', (error) => errors2.push(error.message))
    await expect(viewport(page2)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await page2.evaluate(() => {
      location.hash = '#/practice/DG-05'
    })
    await expect(page2.getByRole('banner').getByRole('heading')).toContainText('DG-05 基尔霍夫定律的验证与应用')

    // 检测到未正常关闭的 .autosave 弹出崩溃恢复对话框
    const recoveryDialog = page2.getByRole('dialog', { name: '检测到未保存的自动存档' })
    await expect(recoveryDialog).toBeVisible({ timeout: 10_000 })
    await expect(recoveryDialog).toContainText('2 根导线')

    // 一键恢复自动存档：恢复全部导线、表格与思考题，且强制处于断电状态
    await recoveryDialog.getByRole('button', { name: '恢复自动存档', exact: true }).click()
    await expect(recoveryDialog).toBeHidden()
    await expect(page2.getByText('未上电')).toBeVisible()
    await expect(page2.getByText('导线：2')).toBeVisible()

    await page2.getByRole('tab', { name: '数据记录', exact: true }).click()
    const restoredI1 = dataPanel(page2).locator(
      'input[data-table-id="kirchhoff"][data-row-index="0"][data-column-id="i1"]',
    )
    await expect(restoredI1).toHaveValue('0.00191')

    await page2.getByRole('tab', { name: '步骤', exact: true }).click()
    const restoredQ1 = stepsPanel(page2).getByRole('textbox', { name: '思考题 1 作答', exact: true })
    await expect(restoredQ1).toHaveValue('I2 实际电流方向与参考方向相反。')

    // 第三阶段：手动保存进度 -> 确认重置清空台面 -> 读取手动存档恢复全部接线与数据（仍保持断电）
    await page2.getByRole('button', { name: '存档', exact: true }).click()
    await page2.getByRole('menuitem', { name: '保存进度', exact: true }).click()
    await expect.poll(() => existsSync(manualSaveFile)).toBe(true)
    expect(existsSync(autosaveFile)).toBe(false)

    await page2.getByRole('button', { name: '重置', exact: true }).click()
    await page2.getByRole('button', { name: '确认重置', exact: true }).click()
    await expect(page2.getByText('导线：0')).toBeVisible()
    await page2.getByRole('tab', { name: '数据记录', exact: true }).click()
    await expect(restoredI1).toHaveValue('')

    await page2.getByRole('button', { name: '存档', exact: true }).click()
    await page2.getByRole('menuitem', { name: '读取存档', exact: true }).click()
    await expect(page2.getByText('未上电')).toBeVisible()
    await expect(page2.getByText('导线：2')).toBeVisible()
    await expect(restoredI1).toHaveValue('0.00191')

    expect(errors2).toEqual([])
  } finally {
    await app2.close()
  }
})
