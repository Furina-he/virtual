import { expect, type Page } from '@playwright/test'

export type ProjectedJack = {
  id: string
  assetId: string
  label: string
  x: number
  y: number
  visible: boolean
  pickable: boolean
  stackCount: number
}

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })

export async function projectedJacks(page: Page): Promise<ProjectedJack[]> {
  return JSON.parse((await viewport(page).getAttribute('data-jack-targets')) ?? '[]')
}

/** 技术设计 §10.3：设备特写，通过视口工具栏的“聚焦设备”下拉。 */
export async function focusDevice(page: Page, instanceId: string) {
  await viewport(page).getByRole('combobox', { name: '聚焦设备', exact: true }).click()
  await page.locator(`[role="option"][data-instance-id="${instanceId}"]`).click()
  await expect(viewport(page)).toHaveAttribute('data-camera-preset', `focus:${instanceId}`)
  await expect(viewport(page)).toHaveAttribute('data-camera-moving', 'false')
}

/** Canvas point of a jack that can be picked directly in the current view. */
export async function jackPoint(page: Page, ref: string) {
  // Metrics publish on the next rendered frame after the camera settles.
  await expect
    .poll(async () => (await projectedJacks(page)).find((item) => item.id === ref)?.pickable, {
      message: `${ref} is directly pickable`,
    })
    .toBe(true)
  const target = (await projectedJacks(page)).find((item) => item.id === ref)
  const box = await viewport(page).locator('canvas').boundingBox()
  if (!target || !box) throw new Error(`Cannot project jack ${ref}`)
  return { x: box.x + target.x * box.width, y: box.y + target.y * box.height }
}

/** Pick a jack only once its device is readable on screen; otherwise focus that device first. */
export async function pickableJackPoint(page: Page, ref: string) {
  const current = (await projectedJacks(page)).find((item) => item.id === ref)
  if (!current?.pickable) await focusDevice(page, ref.slice(0, ref.indexOf('.')))
  return jackPoint(page, ref)
}

/** Click-click wiring: the pending wire survives the camera move between the two devices. */
export async function clickWire(page: Page, a: string, b: string) {
  const from = await pickableJackPoint(page, a)
  await page.mouse.click(from.x, from.y)
  await expect(viewport(page)).toHaveAttribute('data-pending-jack', a)
  const to = await pickableJackPoint(page, b)
  await page.mouse.click(to.x, to.y)
  await expect(viewport(page)).toHaveAttribute('data-pending-jack', '')
}

/** Drag wiring between two jacks that are both pickable in the current view. */
export async function dragWire(page: Page, a: string, b: string) {
  const from = await jackPoint(page, a)
  const to = await jackPoint(page, b)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await expect(viewport(page)).toHaveAttribute('data-pending-jack', a)
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  await expect(viewport(page)).toHaveAttribute('data-pending-jack', '')
}
