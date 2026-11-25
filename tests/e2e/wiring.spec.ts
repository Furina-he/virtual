import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { clickWire, dragWire, focusDevice, jackPoint, projectedJacks } from './helpers/bench'
import { selectJackFromList } from './helpers/instruments'

let app: ElectronApplication
let page: Page
let errors: string[]
const viewport = () => page.getByRole('region', { name: '3D 实训台' })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-wiring-')) },
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setMinimumSize(320, 240)
    window?.setContentSize(1366, 768)
    window?.webContents.setZoomFactor(1)
  })
  await page.waitForFunction(() => Math.abs(window.innerWidth - 1366) <= 2 && Math.abs(window.innerHeight - 768) <= 2)
  await page.evaluate(() => {
    window.location.hash = '#/practice/DG-05'
  })
  await expect(page.getByRole('banner').getByRole('heading')).toContainText('DG-05', { timeout: 20_000 })
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
})

test.afterEach(async () => {
  await app.close()
  expect(errors).toEqual([])
})

async function expandBench() {
  for (const name of ['显示/收起左栏', '显示/收起底栏']) await page.getByRole('button', { name, exact: true }).click()
  await expect.poll(async () => (await page.locator('[data-slot="resizable-panel"]#left').boundingBox())?.width).toBe(0)
  await expect
    .poll(async () => (await page.locator('[data-slot="resizable-panel"]#bottom').boundingBox())?.height)
    .toBe(0)
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false')
  await expect
    .poll(async () => {
      const box = await viewport().locator('canvas').boundingBox()
      const frame = await viewport().locator('[data-slot="bench-canvas-frame"]').boundingBox()
      return (
        box &&
        frame &&
        Math.abs(frame.width - box.width) < 1 &&
        Math.abs(frame.height - box.height) < 1 &&
        `${Math.round(box.width)},${Math.round(box.height)}` === (await viewport().getAttribute('data-canvas-size'))
      )
    })
    .toBe(true)
}

async function selectOption(label: string, option: string | RegExp) {
  const trigger = editor().getByRole('combobox', { name: label, exact: true })
  await page.mouse.move(0, 0)
  if (label === '接线起点' || label === '接线终点') {
    await trigger.click()
    const item = page.getByRole('option', { name: option, exact: typeof option === 'string' })
    const ref = await item.getAttribute('data-jack-ref')
    await item.scrollIntoViewIfNeeded()
    await item.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    if (ref) await expect(trigger).toHaveAttribute('data-selected-jack', ref)
    return
  }
  await trigger.press('Enter')
  const item = page.getByRole('option', { name: option, exact: typeof option === 'string' })
  const ref = await item.getAttribute('data-jack-ref')
  await item.focus()
  await expect(item).toBeFocused()
  await item.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  if (ref) await expect(trigger).toHaveAttribute('data-selected-jack', ref)
}

async function addFromList(a: string | RegExp, b: string | RegExp) {
  await selectOption('接线起点', a)
  await selectOption('接线终点', b)
  await editor().getByRole('button', { name: '添加导线', exact: true }).click()
}

test('拖线跨设备、三根叠插、Esc 取消、撤销重做与单线删除', async () => {
  await expandBench()
  // Each end is picked in its own device close-up; the pending wire rides along while the camera refocuses.
  await clickWire(page, 'ins-dc-power.CH1P', 'dc1.KH_U1P')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await clickWire(page, 'ins-dc-power.CH1P', 'ins-dc-voltmeter.POS')
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
  await clickWire(page, 'ins-dc-power.CH1P', 'ins-dc-ammeter.POS')
  await expect(viewport()).toHaveAttribute('data-wire-count', '3')
  const targets = await projectedJacks(page)
  expect(targets.find((target) => target.id === 'ins-dc-power.CH1P')?.stackCount).toBe(3)

  await focusDevice(page, 'dc1')
  const start = await jackPoint(page, 'dc1.KH_U2P')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 45, start.y + 60, { steps: 5 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(viewport()).toHaveAttribute('data-wire-count', '3')
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')

  await page.keyboard.press('Control+z')
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
  await page.keyboard.press('Control+Shift+z')
  await expect(viewport()).toHaveAttribute('data-wire-count', '3')
  await editor().getByRole('button', { name: '选择导线 1', exact: true }).click()
  await page.keyboard.press('Delete')
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
  await page.keyboard.press('Control+z')
  await expect(viewport()).toHaveAttribute('data-wire-count', '3')
  await page.screenshot({ path: test.info().outputPath('wired-bench.png') })
})

test('列表接线、颜色与走线、带电拒绝编辑、清空可撤销', async () => {
  await expandBench()
  await selectOption('新导线颜色', '黄绿双色（PE）')
  await addFromList(/直流稳压电源.*CH1P/, /电路基础.*KH_U1P/)
  await expect(editor()).toHaveAttribute('data-wire-count', '1')
  await expect(editor().locator('li[data-wire-color="yellowGreen"]')).toHaveCount(1)
  await editor().getByRole('tab', { name: '导线属性', exact: true }).click()
  await selectOption('走线垂度', '6 cm')
  await selectOption('选中导线颜色', '红色')
  await editor().getByRole('textbox', { name: '导线标签' }).fill('电源正极')
  await editor().getByRole('textbox', { name: '导线标签' }).press('Enter')
  await editor().getByRole('tab', { name: '接线列表', exact: true }).click()
  await expect(editor().getByRole('button', { name: '选择导线 1' })).toContainText('电源正极')

  await page.getByRole('button', { name: '上电', exact: true }).click()
  await editor().getByRole('button', { name: '删除导线 1', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText('请先断电')
  await expect(editor()).toHaveAttribute('data-wire-count', '1')
  await page.keyboard.press('Control+z')
  await expect(editor()).toHaveAttribute('data-wire-count', '1')
  await page.getByRole('button', { name: '断电', exact: true }).click()
  await editor().getByRole('button', { name: '清空接线', exact: true }).click()
  await page.getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await page.keyboard.press('Control+z')
  await expect(editor()).toHaveAttribute('data-wire-count', '1')
})

test('高、中、低画质真实切换，低画质无阴影并在重载后保留', async () => {
  for (const [name, value, size] of [
    ['低画质', 'low', 1024],
    ['高画质', 'high', 2048],
    ['中画质', 'medium', 1536],
    ['低画质', 'low', 1024],
  ] as const) {
    await viewport().getByRole('button', { name, exact: true }).click()
    await expect(viewport()).toHaveAttribute('data-quality', value)
    await expect(viewport()).toHaveAttribute('data-assets-state', 'ready')
    await expect(viewport()).toHaveAttribute('data-max-texture-size', String(size))
  }
  await expect(viewport()).toHaveAttribute('data-shadows', 'false')
  await page.reload()
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport()).toHaveAttribute('data-quality', 'low')
  await expect(viewport().getByRole('button', { name: '低画质', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('连续 20 步接线均可撤销重做，输入框中的 Ctrl+Z 不修改电路', async () => {
  test.setTimeout(90_000)
  await expandBench()
  await selectOption('接线起点', /直流稳压电源.*CH1P/)
  const module: { name: string; jacks: { id: string; label: string }[] } = JSON.parse(
    readFileSync('content/modules/mod-dc-circuit/module.json', 'utf8'),
  )
  const targets = module.jacks.slice(0, 20)
  for (const jack of targets) {
    await selectOption('接线终点', `${module.name} · ${jack.label} (${jack.id})`)
    await editor().getByRole('button', { name: '添加导线', exact: true }).click()
  }
  await expect(viewport()).toHaveAttribute('data-wire-count', '20')
  const original = await viewport().getAttribute('data-wire-endpoints')
  await viewport().getByRole('button', { name: '操作视角', exact: true }).focus()
  for (let count = 19; count >= 0; count--) {
    await page.keyboard.press('Control+z')
    await expect(viewport()).toHaveAttribute('data-wire-count', String(count))
  }
  for (let count = 1; count <= 20; count++) {
    await page.keyboard.press('Control+Shift+z')
    await expect(viewport()).toHaveAttribute('data-wire-count', String(count))
  }
  expect(await viewport().getAttribute('data-wire-endpoints')).toBe(original)
  await editor().getByRole('button', { name: '选择导线 1', exact: true }).click()
  await editor().getByRole('tab', { name: '导线属性', exact: true }).click()
  const input = editor().getByRole('textbox', { name: '导线标签' })
  await input.fill('测试标签')
  await input.press('Control+z')
  await expect(viewport()).toHaveAttribute('data-wire-count', '20')
  await input.fill('')
  await input.press('Enter')
  await editor().getByRole('tab', { name: '接线列表', exact: true }).click()
  const extra = module.jacks[20]
  if (!extra) throw new Error('Fixture needs a 21st jack for the color-batch path')
  await selectOption('接线终点', `${module.name} · ${extra.label} (${extra.id})`)
  await editor().getByRole('button', { name: '添加导线', exact: true }).click()
  await expect(viewport()).toHaveAttribute('data-wire-count', '21')
  await expect.poll(async () => Number(await viewport().getAttribute('data-draw-calls'))).toBeLessThanOrEqual(100)
  await expect.poll(async () => Number(await viewport().getAttribute('data-triangles'))).toBeLessThanOrEqual(150_000)
  const projected: { id: string; x: number; y: number }[] = JSON.parse(
    (await viewport().getAttribute('data-wire-targets')) ?? '[]',
  )
  const canvas = await viewport().locator('canvas').boundingBox()
  const target = projected[10]
  if (!canvas || !target) throw new Error('Batched wire has no projected target')
  await page.mouse.click(canvas.x + target.x * canvas.width, canvas.y + target.y * canvas.height)
  await page.keyboard.press('Delete')
  await expect(viewport()).toHaveAttribute('data-wire-count', '20')
  await page.keyboard.press('Control+z')
  await expect(viewport()).toHaveAttribute('data-wire-count', '21')
})

test('松手在画布外、重复接线和窗口失焦不留下错误导线或拖拽状态', async () => {
  await expandBench()
  await focusDevice(page, 'dc1')
  await dragWire(page, 'dc1.KH_U1P', 'dc1.KH_U2P')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await dragWire(page, 'dc1.KH_U1P', 'dc1.KH_U2P')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await expect(editor().getByRole('status')).toContainText('已有导线')
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')
  const from = await jackPoint(page, 'dc1.KH_U2N')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(20, 20, { steps: 12 })
  await page.mouse.up()
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 30, from.y + 40, { steps: 4 })
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await page.mouse.up()
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
})

test('长插孔列表连续切换首尾项目后提交所选值并关闭列表', async () => {
  await expandBench()
  const module: { name: string; jacks: { id: string; label: string }[] } = JSON.parse(
    readFileSync('content/modules/mod-dc-circuit/module.json', 'utf8'),
  )
  const targets = [module.jacks.at(-1), module.jacks[0], module.jacks[16], module.jacks[19]]
  for (let cycle = 0; cycle < 8; cycle++)
    for (const jack of targets) {
      if (!jack) throw new Error('Missing long-list test jack')
      for (const label of ['接线起点', '接线终点']) {
        await selectJackFromList(page, label, `dc1.${jack.id}`)
        await expect(editor().getByRole('combobox', { name: label, exact: true })).toContainText(
          `${module.name} · ${jack.label} (${jack.id})`,
        )
      }
    }

  const trigger = editor().getByRole('combobox', { name: '接线终点', exact: true })
  await trigger.click()
  const search = page.getByRole('combobox', { name: '搜索接线终点', exact: true })
  await expect(search).toBeFocused()
  const options = page.locator('[role="option"][data-jack-ref]:not([data-disabled="true"])')
  await page.keyboard.press('Home')
  await expect(options.first()).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('End')
  await expect(options.last()).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('ArrowUp')
  const previous = options.nth((await options.count()) - 2)
  await expect(previous).toHaveAttribute('data-selected', 'true')
  const previousRef = await previous.getAttribute('data-jack-ref')
  if (!previousRef) throw new Error('Keyboard-selected jack needs a stable reference')
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toHaveAttribute('data-selected-jack', previousRef)
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')
})

test('T0.16 相机与拾取：单击设备特写、24 px 吸附、待接线可缩放、左键不旋转、Esc/Home 退出', async () => {
  await expandBench()
  // Module jacks are too dense in the work view, so a click on the panel focuses instead of wiring.
  const overview = (await projectedJacks(page)).find((jack) => jack.id === 'dc1.KH_U1P')
  expect(overview?.pickable).toBe(false)
  const canvas = await viewport().locator('canvas').boundingBox()
  if (!canvas || !overview) throw new Error('Canvas or dc1 jack missing')
  await page.mouse.click(canvas.x + overview.x * canvas.width, canvas.y + overview.y * canvas.height)
  await expect(viewport()).toHaveAttribute('data-camera-preset', 'focus:dc1')
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false')

  // Screen-space snapping: a press 10 px off the jack still starts the wire.
  const jack = await jackPoint(page, 'dc1.KH_U1P')
  await page.mouse.move(jack.x + 10, jack.y)
  await expect(viewport()).toHaveAttribute('data-hover-jack', 'dc1.KH_U1P')
  await page.mouse.click(jack.x + 10, jack.y)
  await expect(viewport()).toHaveAttribute('data-pending-jack', 'dc1.KH_U1P')

  // The pending wire keeps zoom and pan available.
  const before = await viewport().getAttribute('data-camera-position')
  await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5)
  await page.mouse.wheel(0, 300)
  await expect.poll(() => viewport().getAttribute('data-camera-position')).not.toBe(before)
  await expect(viewport()).toHaveAttribute('data-pending-jack', 'dc1.KH_U1P')

  // Left drag on empty space pans; only the right button rotates.
  const azimuthOf = async () => Number(await viewport().getAttribute('data-camera-azimuth'))
  const azimuth = await azimuthOf()
  const empty = { x: canvas.x + canvas.width * 0.08, y: canvas.y + canvas.height * 0.5 }
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down()
  await page.mouse.move(empty.x - 80, empty.y + 20, { steps: 8 })
  await page.mouse.up()
  await expect(viewport()).toHaveAttribute('data-camera-preset', 'custom')
  expect(Math.abs((await azimuthOf()) - azimuth)).toBeLessThan(0.005)
  await expect(viewport()).toHaveAttribute('data-pending-jack', 'dc1.KH_U1P')
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(empty.x - 80, empty.y, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await expect.poll(async () => Math.abs((await azimuthOf()) - azimuth)).toBeGreaterThan(0.05)
  expect(Math.abs(await azimuthOf())).toBeLessThanOrEqual(Math.PI / 4 + 1e-3)

  // Esc backs out one level at a time: the pending wire, then the custom/close-up view.
  await page.keyboard.press('Escape')
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')
  await page.keyboard.press('Escape')
  await expect(viewport()).toHaveAttribute('data-camera-preset', 'work')
  await focusDevice(page, 'ins-dc-power')
  await page.keyboard.press('Home')
  await expect(viewport()).toHaveAttribute('data-camera-preset', 'work')
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')
})

test('T0.16 P1：参考接线虚线、导线右键菜单、仪表特写高亮 2D 面板、特写附近插孔标签', async () => {
  // DG-05 reference: CH1± → KH_U1±, CH2± → KH_U2±; dashed only until the student wires them.
  const guide = viewport().getByRole('button', { name: '参考接线', exact: true })
  await guide.click()
  await expect(guide).toHaveAttribute('aria-pressed', 'true')
  await expect(viewport()).toHaveAttribute(
    'data-guide-links',
    'ins-dc-power.CH1P:dc1.KH_U1P ins-dc-power.CH1N:dc1.KH_U1N ins-dc-power.CH2P:dc1.KH_U2P ins-dc-power.CH2N:dc1.KH_U2N',
  )
  await page.screenshot({ path: test.info().outputPath('guide-cords.png') })
  await addFromList(/直流稳压电源.*CH1P/, /电路基础.*KH_U1P/)
  await expect(viewport()).toHaveAttribute(
    'data-guide-links',
    'ins-dc-power.CH1N:dc1.KH_U1N ins-dc-power.CH2P:dc1.KH_U2P ins-dc-power.CH2N:dc1.KH_U2N',
  )

  // Right click on the cord (no drag) opens its menu; recolouring goes through the normal wire update.
  const [wire] = JSON.parse((await viewport().getAttribute('data-wire-targets')) ?? '[]') as { x: number; y: number }[]
  const canvas = await viewport().locator('canvas').boundingBox()
  if (!wire || !canvas) throw new Error('Wire target missing')
  await page.mouse.click(canvas.x + wire.x * canvas.width, canvas.y + wire.y * canvas.height, { button: 'right' })
  const menu = page.getByRole('menu', { name: '导线 1 菜单' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: '颜色' }).hover()
  await page.getByRole('menuitemradio', { name: '黑色', exact: true }).click()
  await expect(menu).toBeHidden()
  await expect(editor().locator('li[data-wire-color="black"]')).toHaveCount(1)

  // Focusing an instrument outlines its 2D panel in the dock.
  await focusDevice(page, 'ins-dc-voltmeter')
  await expect(page.getByRole('region', { name: '直流数字电压表', exact: true })).toHaveAttribute(
    'data-focused',
    'true',
  )

  // Close-up labels: persistent anti-overlap labels show silkscreen names on the focused device (T1.9B).
  await focusDevice(page, 'ins-dc-power')
  await expect(page.locator('[data-persistent-jack-label]').first()).toBeVisible()
  const labelCount = await page.locator('[data-persistent-jack-label]').count()
  expect(labelCount).toBeGreaterThanOrEqual(4)
  expect(labelCount).toBeLessThanOrEqual(28)
  await page.screenshot({ path: test.info().outputPath('jack-labels.png') })
})
