import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'

interface CatalogAsset {
  id: string
  kind: string
  mounting?: 'fixed' | 'desktop'
  jacks: unknown[]
  controls: unknown[]
  screens: unknown[]
  leds?: unknown[]
  slots?: unknown[]
}

declare global {
  interface Window {
    __assetBootSnapshots?: { state: string; powerEnabled: boolean; rendered: boolean }[]
  }
}

const catalog: { assets: CatalogAsset[]; preview: { placements: { assetId: string }[] } } = JSON.parse(
  readFileSync('assets/layouts/catalog.json', 'utf8'),
)
// Practice mode mounts fixed console instruments and modules at boot. Desktop
// instruments remain cabinet inventory until the learner places them.
const placedAssets = catalog.preview.placements
  .map((placement) => {
    const asset = catalog.assets.find((item) => item.id === placement.assetId)
    if (!asset) throw new Error(`Missing preview asset ${placement.assetId}`)
    return asset
  })
  .filter((asset) => asset.mounting !== 'desktop')
const expectedAnchors = placedAssets.reduce(
  (total, asset) =>
    total +
    asset.jacks.length +
    asset.controls.length +
    asset.screens.length +
    (asset.leds?.length ?? 0) +
    (asset.slots?.length ?? 0),
  0,
)
const expectedJacks = placedAssets.reduce((total, asset) => total + asset.jacks.length, 0)

let app: ElectronApplication
let win: Page
let userData: string
let pageErrors: string[]
let consoleErrors: string[]

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'virtual-assets-e2e-'))
  app = await electron.launch({ args: ['.'], env: { ...process.env, VIRTUAL_USER_DATA: userData } })
  win = await app.firstWindow()
  pageErrors = []
  consoleErrors = []
  win.on('pageerror', (error) => pageErrors.push(error.message))
  win.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
})

test.afterEach(async () => {
  await app.close()
})

async function expectNoPageOverflow() {
  const size = await win.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width)
  expect(size.scrollHeight).toBeLessThanOrEqual(size.height)
}

test('本地 GLB 与 HDRI 加载、锚点识别、三种视角可用，且无外网请求', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setContentSize(1366, 768)
  })
  await win.waitForFunction(() => Math.abs(innerWidth - 1366) <= 2 && Math.abs(innerHeight - 768) <= 2)
  const viewport = win.getByRole('region', { name: '3D 实训台' })
  await expect(viewport).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport).toHaveAttribute('data-ready-after-frame', 'true')
  await expect(win.getByRole('button', { name: '上电', exact: true })).toBeEnabled()
  expect(Number(await viewport.getAttribute('data-startup-ms'))).toBeGreaterThan(0)
  console.log(`3D scene ready after ${await viewport.getAttribute('data-startup-ms')} ms`)
  await expect(viewport).toHaveAttribute('data-assets-loaded', String(placedAssets.length))
  await expect(viewport).toHaveAttribute('data-anchor-count', String(expectedAnchors))
  await expect(viewport).toHaveAttribute('data-jack-count', String(expectedJacks))
  await expect(viewport.getByText('仪表选取与接线编辑')).toBeVisible()
  await expect(viewport.locator('canvas')).toBeVisible()
  await expect.poll(async () => Number(await viewport.getAttribute('data-triangles'))).toBeGreaterThan(0)
  await expect.poll(async () => Number(await viewport.getAttribute('data-draw-calls'))).toBeGreaterThan(0)
  await expectNoPageOverflow()

  for (const [label, id] of [
    ['正视', 'front'],
    ['俯视', 'top'],
    ['操作视角', 'work'],
  ] as const) {
    const previous = await viewport.getAttribute('data-camera-position')
    const button = viewport.getByRole('button', { name: label, exact: true })
    await button.focus()
    await win.keyboard.press('Enter')
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(viewport).toHaveAttribute('data-camera-preset', id)
    await expect.poll(() => viewport.getAttribute('data-camera-position')).not.toBe(previous)
    await expect(viewport).toHaveAttribute('data-camera-moving', 'false')
  }

  expect(Number(await viewport.getAttribute('data-draw-calls'))).toBeLessThanOrEqual(100)
  expect(Number(await viewport.getAttribute('data-triangles'))).toBeLessThanOrEqual(150_000)
  await win.screenshot({ path: test.info().outputPath('asset-preview.png') })

  for (const label of ['显示/收起左栏', '显示/收起右栏', '显示/收起底栏']) {
    await win.getByRole('button', { name: label, exact: true }).click()
  }
  for (const id of ['left', 'right']) {
    await expect
      .poll(async () => (await win.locator(`[data-slot="resizable-panel"]#${id}`).boundingBox())?.width)
      .toBe(0)
  }
  await expect
    .poll(async () => (await win.locator('[data-slot="resizable-panel"]#bottom').boundingBox())?.height)
    .toBe(0)
  await expect(viewport).toHaveAttribute('data-camera-moving', 'false')
  await expect
    .poll(async () => {
      const frame = await viewport.locator('[data-slot="bench-canvas-frame"]').boundingBox()
      const canvas = await viewport.locator('canvas').boundingBox()
      return (
        !!frame && !!canvas && Math.abs(frame.width - canvas.width) < 1 && Math.abs(frame.height - canvas.height) < 1
      )
    })
    .toBe(true)
  const canvasBounds = await viewport.locator('canvas').boundingBox()
  expect(canvasBounds).not.toBeNull()
  if (!canvasBounds) throw new Error('Missing preview canvas')
  await expect(viewport).toHaveAttribute(
    'data-canvas-size',
    `${Math.round(canvasBounds.width)},${Math.round(canvasBounds.height)}`,
  )
  await expectNoPageOverflow()
  const targets: { id: string; assetId: string; label: string; x: number; y: number; visible: boolean }[] = JSON.parse(
    (await viewport.getAttribute('data-jack-targets')) ?? '[]',
  )
  const module = placedAssets.find((asset) => asset.kind === 'module')
  const jack = targets.find(
    (target) =>
      target.assetId === module?.id &&
      target.visible &&
      target.x > 0.1 &&
      target.x < 0.9 &&
      target.y > 0.1 &&
      target.y < 0.9,
  )
  expect(jack, 'a real module jack projects inside the canvas').toBeDefined()
  if (!jack) throw new Error('No projected jack to exercise')
  await win.mouse.move(canvasBounds.x + jack.x * canvasBounds.width, canvasBounds.y + jack.y * canvasBounds.height)
  const label = win.locator('[data-slot="tooltip-content"][data-jack-id]')
  await expect(label).toBeVisible()
  await expect(label).toHaveAttribute('data-jack-id', jack.id)
  await expect(label).toContainText(jack.label)
  await expectNoPageOverflow()
  await win.screenshot({ path: test.info().outputPath('asset-preview-expanded.png') })
  await win.mouse.move(20, 20)
  await expect(label).toBeHidden()
  await expectNoPageOverflow()

  const externalResources = await win.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((item) => item.name)
      .filter((url) => /^https?:/i.test(url)),
  )
  expect(externalResources).toEqual([])
  expect(existsSync(join(userData, 'logs', 'network-blocked.log'))).toBe(false)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('显卡上下文丢失显示恢复提示，重载后仍能显示本地模型', async () => {
  const viewport = win.getByRole('region', { name: '3D 实训台' })
  await expect(viewport).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await viewport.locator('canvas').evaluate((canvas) => {
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
  })
  await expect(viewport).toHaveAttribute('data-assets-state', 'error')
  await expect(win.getByRole('button', { name: '上电', exact: true })).toBeDisabled()
  await expect(viewport.getByRole('alert')).toContainText('无法显示本地 3D 资产。')
  await expect(viewport.getByRole('status')).toBeHidden()
  await viewport.getByRole('button', { name: '重新加载' }).click()
  await expect(viewport).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport).toHaveAttribute('data-ready-after-frame', 'true')
  await expect(win.getByRole('button', { name: '上电', exact: true })).toBeEnabled()
  await expect(viewport).toHaveAttribute('data-assets-loaded', String(placedAssets.length))
  await expect(viewport).toHaveAttribute('data-anchor-count', String(expectedAnchors))
  expect(pageErrors).toEqual([])
})

test('3D 首帧预热完成前禁止上电，正常加载没有错误态', async () => {
  await win.addInitScript(() => {
    window.__assetBootSnapshots = []
    new MutationObserver(() => {
      const region = document.querySelector<HTMLElement>('[aria-label="3D 实训台"]')
      const power = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '上电')
      if (!region?.dataset.assetsState || !power) return
      const snapshot = {
        state: region.dataset.assetsState,
        powerEnabled: !power.disabled,
        rendered: region.dataset.readyAfterFrame === 'true',
      }
      const snapshots = window.__assetBootSnapshots
      if (JSON.stringify(snapshots?.at(-1)) !== JSON.stringify(snapshot)) snapshots?.push(snapshot)
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-assets-state', 'data-ready-after-frame', 'disabled'],
    })
  })
  await win.reload()
  await expect(win.getByRole('button', { name: '上电', exact: true })).toBeEnabled({ timeout: 30_000 })
  const snapshots = await win.evaluate(() => window.__assetBootSnapshots ?? [])
  expect(snapshots.some((snapshot) => snapshot.state === 'loading')).toBe(true)
  expect(snapshots.some((snapshot) => snapshot.state === 'error')).toBe(false)
  expect(
    snapshots.filter((snapshot) => snapshot.powerEnabled && (snapshot.state !== 'ready' || !snapshot.rendered)),
  ).toEqual([])
  expect(pageErrors).toEqual([])
})
