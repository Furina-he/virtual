import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { selectJackFromList } from './helpers/instruments'

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const schematic = (page: Page) => page.getByRole('region', { name: '交互式原理图', exact: true })

test('T1.8 TSK-02 首页项目分组、设置持久化、演示模式字号 ×1.25、Ctrl+K 命令面板跳转与原理图—台面插孔双向高亮', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-nav-schematic-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: userData },
  })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    // 1. 通过顶栏“返回”按钮进入首页，验证三子模块分组目录
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.locator('[data-page="home"]')).toBeVisible()
    await expect(page.getByRole('tab', { name: '电工基础', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '模拟电子', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '数字电子', exact: true })).toBeVisible()
    await expect(page.locator('[data-home-project="DG-05"]')).toBeVisible()

    // 切换“模拟电子”Tab 验证 MD-03 与 MD-07 分组展示
    await page.getByRole('tab', { name: '模拟电子', exact: true }).click()
    await expect(page.locator('[data-home-project="MD-03"]')).toBeVisible()
    await expect(page.locator('[data-home-project="MD-07"]')).toBeVisible()

    // 2. 使用 Ctrl+K 打开命令面板并跳转到 DG-05 实训项目
    await page.keyboard.press('Control+k')
    const cmdInput = page.getByRole('combobox', { name: '搜索命令或项目', exact: true })
    await expect(cmdInput).toBeVisible()
    await cmdInput.fill('DG-05')
    await page.getByRole('option', { name: /DG-05/ }).click()
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('DG-05 基尔霍夫定律的验证与应用')
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    // 3. 验证演示模式字号 ×1.25（根字号从 16px 放大到 20px = 1.25×）与收起次要面板
    const baseFontSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    )
    expect(baseFontSize).toBeCloseTo(16, 1)

    await page.getByRole('button', { name: '切换演示模式', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '1.25')
    const demoFontSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    )
    expect(demoFontSize / baseFontSize).toBeCloseTo(1.25, 2)

    // 关闭演示模式恢复 1× 并恢复工作区面板
    await page.getByRole('button', { name: '切换演示模式', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '1')

    // 4. 打开设置弹窗切换深色主题，再切回浅色主题
    await page.getByRole('button', { name: '系统设置', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: '系统设置' })
    await expect(settingsDialog).toBeVisible()
    await settingsDialog.getByRole('combobox', { name: '设置界面主题', exact: true }).click()
    await page.getByRole('option', { name: '深色', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await settingsDialog.getByRole('combobox', { name: '设置界面主题', exact: true }).click()
    await page.getByRole('option', { name: '浅色', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.keyboard.press('Escape')
    await expect(settingsDialog).toBeHidden()

    // 5. 原理图与 3D 台面/接线面板双向高亮联动（TSK-02）
    await page.getByRole('tab', { name: '原理图', exact: true }).click()
    await expect(schematic(page)).toBeVisible()
    await expect(schematic(page)).toHaveAttribute('data-schematic-linked-count', '16')

    // 方向 A：悬停原理图中的插孔 dc1.KH_I1A -> 3D 实训台 data-hovered-jack 同步高亮
    const svgJack = schematic(page).locator('[data-linked-jack="dc1.KH_I1A"]')
    await expect(svgJack).toBeVisible()
    await svgJack.hover()
    await expect(viewport(page)).toHaveAttribute('data-hovered-jack', 'dc1.KH_I1A')
    await expect(svgJack).toHaveAttribute('data-schematic-highlighted', 'true')
    await expect(schematic(page).locator('[data-schematic-status]')).toContainText('dc1.KH_I1A')

    // 方向 B：在右侧接线面板选择插孔 dc1.KH_U2P -> 原理图对应节点同步高亮
    await selectJackFromList(page, '接线起点', 'dc1.KH_U2P')
    await expect(viewport(page)).toHaveAttribute('data-hovered-jack', 'dc1.KH_U2P')
    await expect(schematic(page).locator('[data-linked-jack="dc1.KH_U2P"]')).toHaveAttribute(
      'data-schematic-highlighted',
      'true',
    )

    // 6. 验证 F1 快捷键切回实训指导标签页
    await page.keyboard.press('F1')
    await expect(page.getByRole('tab', { name: '实训指导', exact: true })).toHaveAttribute('aria-selected', 'true')

    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
