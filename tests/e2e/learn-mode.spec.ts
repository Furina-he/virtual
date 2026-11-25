import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { dragInstrumentToSlot } from './helpers/instruments'

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const viewer3d = (page: Page) => page.getByRole('region', { name: '3D 器件查看器', exact: true })

test('T1.9 LRN-01~LRN-08 学习模式分类树检索、3D 查看器拆解/剖切、四项内容 Tab 与从实训台跳转', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-learn-mode-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: userData },
  })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    // 1. 从实训台拖入示波器，点击仪表面板上的“查看器件资料”直接跳转至 /learn 对应示波器条目（LRN-08）
    await page.evaluate(() => {
      location.hash = '#/practice/MD-07'
    })
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
    await page.getByRole('button', { name: '查看 双通道数字示波器 器件资料', exact: true }).click()

    await expect(page.locator('[data-page="learn"]')).toBeVisible()
    await expect(page.getByRole('main', { name: '资源详情' })).toHaveAttribute(
      'data-selected-resource',
      'ins-learn-oscilloscope',
    )
    await expect(viewer3d(page)).toHaveAttribute('data-viewer-state', 'ready', { timeout: 30_000 })

    // 2. 验证 3D 查看器爆炸拆解与剖切面交互控制（LRN-04）
    const explodeSlider = viewer3d(page).locator('[data-slider="explode"] [role="slider"]')
    await explodeSlider.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => Number(await viewer3d(page).getAttribute('data-explode'))).toBeGreaterThan(0)

    const sectionSwitch = viewer3d(page).getByRole('switch', { name: '开启剖切面' })
    await sectionSwitch.click()
    await expect(viewer3d(page)).toHaveAttribute('data-section-enabled', 'true')
    const sectionSlider = viewer3d(page).locator('[data-slider="section"] [role="slider"]')
    await sectionSlider.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => Number(await viewer3d(page).getAttribute('data-section-offset'))).toBeGreaterThan(0)

    // 3. 验证四项内容详情 Tab（结构原理、符号识别、参数计算、故障处理）均可完整查看
    for (const [label, key] of [
      ['结构原理', 'structure'],
      ['符号识别', 'symbol'],
      ['参数计算', 'parameters'],
      ['故障处理', 'troubleshooting'],
    ] as const) {
      await page.getByRole('tab', { name: label, exact: true }).click()
      const panel = page.locator(`[data-learn-section="${key}"]`)
      await expect(panel).toBeVisible()
      expect((await panel.textContent())?.trim().length ?? 0).toBeGreaterThan(20)
    }

    // 4. 验证五类资源分类树过滤、M2 全量计数与关键字全文检索（LRN-01/LRN-03/LRN-06/LRN-07）
    const tree = page.getByRole('complementary', { name: '资源分类树', exact: true })
    for (const cat of ['concept', 'theory', 'component', 'ic', 'instrument-tool']) {
      await expect(tree.locator(`[data-category-filter="${cat}"]`)).toBeVisible()
    }
    await expect(tree.locator('[data-category-filter="component"]')).toContainText('90')
    await expect(tree.locator('[data-category-filter="ic"]')).toContainText('38')
    await expect(tree.locator('[data-category-filter="instrument-tool"]')).toContainText('17')

    await tree.locator('[data-category-filter="component"]').click()
    await expect(page.locator('[data-learn-item="cmp-carbon-resistor"]')).toBeVisible()
    await expect(page.locator('[data-learn-item="cmp-bjt-npn"]')).toBeVisible()

    // 切回全部并按关键字检索 NE555、CD4511 (DIP-16)、LM317 (TO-220) 与电工工具（组合钳/电烙铁）
    await tree.locator('[data-category-filter="all"]').click()
    const searchInput = page.getByRole('searchbox', { name: '检索学习资源', exact: true })
    await searchInput.fill('NE555')
    await expect(page.locator('[data-learn-item="ic-ne555"]')).toBeVisible()
    await page.locator('[data-learn-item="ic-ne555"]').click()
    await expect(page.getByRole('main', { name: '资源详情' })).toHaveAttribute('data-selected-resource', 'ic-ne555')
    await expect(viewer3d(page)).toHaveAttribute('data-viewer-state', 'ready', { timeout: 30_000 })

    // 验证新增 DIP-16 与电工工具 3D 母版模型在离线 3D 查看器中正常就绪
    await searchInput.fill('CD4511')
    await page.locator('[data-learn-item="ic-cd4511"]').click()
    await expect(page.getByRole('main', { name: '资源详情' })).toHaveAttribute('data-selected-resource', 'ic-cd4511')
    await expect(viewer3d(page)).toHaveAttribute('data-viewer-state', 'ready', { timeout: 30_000 })

    await searchInput.fill('恒温电烙铁')
    await page.locator('[data-learn-item="tool-soldering-iron"]').click()
    await expect(page.getByRole('main', { name: '资源详情' })).toHaveAttribute(
      'data-selected-resource',
      'tool-soldering-iron',
    )
    await expect(viewer3d(page)).toHaveAttribute('data-viewer-state', 'ready', { timeout: 30_000 })

    await searchInput.fill('组合钳')
    await expect(page.locator('[data-learn-item="tool-combination-pliers"]')).toBeVisible()

    // 5. 点击“返回实训台”顺畅回到原实训项目
    await page.getByRole('button', { name: '返回实训台', exact: true }).click()
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('MD-07 三极管放大电路故障排除')

    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
