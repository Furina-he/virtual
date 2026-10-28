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
  const to = await instrumentSlotPoint(page, slotId)
  const x = from.x + from.width / 2
  const y = from.y + from.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 12, y, { steps: 4 })
  await expect(page.getByRole('region', { name: '3D 实训台', exact: true })).toHaveAttribute(
    'data-dragging-instrument',
    /.+/,
  )
  await page.mouse.move(to.x, to.y, { steps: 16 })
  await page.mouse.up()
}

export async function addInstrumentWireFromList(page: Page, aRef: string, bRef: string) {
  const editor = page.getByRole('region', { name: '接线编辑', exact: true })
  for (const [label, ref] of [
    ['接线起点', aRef],
    ['接线终点', bRef],
  ]) {
    await editor.getByRole('combobox', { name: label, exact: true }).click()
    await page.locator(`[role="option"][data-jack-ref="${ref}"]`).click()
  }
  await editor.getByRole('button', { name: '添加导线', exact: true }).click()
}
