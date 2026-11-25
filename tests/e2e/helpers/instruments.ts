import { expect, type Page } from '@playwright/test'

export type ProjectedInstrumentSlot = {
  id: string
  x: number
  y: number
  visible: boolean
  occupied: boolean
}

export async function instrumentSlotPoint(page: Page, slotId: string) {
  const viewport = page.getByRole('region', { name: '3D 实训台', exact: true })
  await expect(viewport).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport).toHaveAttribute('data-camera-moving', 'false')
  const slots = JSON.parse((await viewport.getAttribute('data-slot-targets')) ?? '[]') as ProjectedInstrumentSlot[]
  const slot = slots.find((item) => item.id === slotId)
  const canvas = await viewport.locator('canvas').boundingBox()
  expect(slot?.visible, `${slotId} is visible in the current camera`).toBe(true)
  if (!slot || !canvas) throw new Error(`Cannot project desktop slot ${slotId}`)
  return { x: canvas.x + slot.x * canvas.width, y: canvas.y + slot.y * canvas.height }
}

export async function dragInstrumentToSlot(page: Page, slotId = 'SLOT_DESK_2', instrumentName = '数字万用表') {
  const source = page.getByRole('button', { name: `拖放 ${instrumentName}`, exact: true })
  await source.scrollIntoViewIfNeeded()
  const from = await source.boundingBox()
  if (!from) throw new Error(`Instrument cabinet entry is not visible: ${instrumentName}`)
  const x = from.x + from.width / 2
  const y = from.y + from.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 12, y, { steps: 4 })
  await expect(page.getByRole('region', { name: '3D 实训台', exact: true })).toHaveAttribute(
    'data-dragging-instrument',
    /.+/,
  )
  // 拖拽态触发相机平滑显露全部桌面安装位后再读取精确投影坐标（T1.9B）
  const to = await instrumentSlotPoint(page, slotId)
  await page.mouse.move(to.x, to.y, { steps: 16 })
  await expect(page.locator('[data-slot="bench-canvas-frame"]')).toHaveAttribute('data-drop-target', 'true')
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '3D 实训台', exact: true })).toHaveAttribute(
    'data-dragging-instrument',
    '',
  )
}

export async function selectJackFromList(page: Page, label: string, ref: string) {
  const editor = page.getByRole('region', { name: '接线编辑', exact: true })
  const trigger = editor.getByRole('combobox', { name: label, exact: true })
  // Keep stationary pointer hover from competing with this selection sequence.
  await page.mouse.move(0, 0)
  await trigger.scrollIntoViewIfNeeded()
  await expect
    .poll(
      async () => {
        if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
          await trigger.click()
        }
        return (await trigger.getAttribute('aria-expanded')) === 'true'
      },
      { timeout: 5_000, intervals: [150, 300, 500] },
    )
    .toBe(true)
  const search = page.getByRole('combobox', { name: `搜索${label}`, exact: true })
  await expect(search).toBeVisible()
  await search.fill(ref)
  const option = page.locator(`[role="option"][data-jack-ref="${ref}"]`)
  await expect(option).toBeVisible()
  await option.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toHaveAttribute('data-selected-jack', ref)
}

export async function openInstrumentPanel(page: Page, instrumentName: string) {
  const instrumentsTab = page.getByRole('tab', { name: '仪表', exact: true })
  if ((await instrumentsTab.getAttribute('aria-selected')) !== 'true') {
    await instrumentsTab.click()
  }
  const existing = page.getByRole('region', { name: instrumentName, exact: true })
  if (await existing.isVisible()) return existing

  const readingsBar = page.locator('[data-live-readings-bar]')
  const chip = readingsBar.locator(`[data-live-reading-chip][data-instrument-title="${instrumentName}"]`)
  if ((await chip.count()) > 0) {
    await chip.first().click()
    await expect(existing).toBeVisible()
    return existing
  }

  const otherFixedTrigger = page.locator('[data-other-fixed-trigger]')
  if (await otherFixedTrigger.isVisible()) {
    await otherFixedTrigger.click()
    const item = page.getByRole('menuitem', { name: instrumentName, exact: true })
    if ((await item.count()) > 0) {
      await item.click()
      await expect(existing).toBeVisible()
      return existing
    }
    await page.keyboard.press('Escape')
  }

  await expect(existing).toBeVisible()
  return existing
}

export async function enableDualInstrumentDock(page: Page) {
  const instrumentsTab = page.getByRole('tab', { name: '仪表', exact: true })
  if ((await instrumentsTab.getAttribute('aria-selected')) !== 'true') {
    await instrumentsTab.click()
  }
  const dual = page.locator('[data-dock-mode="dual"]')
  await expect(dual).toBeEnabled()
  await dual.click()
  await expect(dual).toHaveAttribute('aria-pressed', 'true')
}

export async function addInstrumentWireFromList(page: Page, aRef: string, bRef: string) {
  const editor = page.getByRole('region', { name: '接线编辑', exact: true })
  for (const [label, ref] of [
    ['接线起点', aRef],
    ['接线终点', bRef],
  ] as const) {
    await selectJackFromList(page, label, ref)
  }
  await editor.getByRole('button', { name: '添加导线', exact: true }).click()
}
