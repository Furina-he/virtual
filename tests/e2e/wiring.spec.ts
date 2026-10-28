import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'

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

async function jackPoint(ref: string) {
  const targets: { id: string; x: number; y: number; visible: boolean }[] = JSON.parse(
    (await viewport().getAttribute('data-jack-targets')) ?? '[]',
  )
  const target = targets.find((item) => item.id === ref)
  const box = await viewport().locator('canvas').boundingBox()
  expect(target?.visible, `${ref} projects in the scene`).toBe(true)
  if (!target || !box) throw new Error(`Cannot project jack ${ref}`)
  return { x: box.x + target.x * box.width, y: box.y + target.y * box.height }
}

async function dragWire(a: string, b: string) {
  const from = await jackPoint(a)
  const to = await jackPoint(b)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}

async function selectOption(label: string, option: string | RegExp) {
  await editor().getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click()
}

async function addFromList(a: string | RegExp, b: string | RegExp) {
  await selectOption('接线起点', a)
  await selectOption('接线终点', b)
  await editor().getByRole('button', { name: '添加导线', exact: true }).click()
}

test('拖线跨设备、三根叠插、Esc 取消、撤销重做与单线删除', async () => {
  await expandBench()
  await dragWire('ins-dc-power.CH1P', 'dc1.KH_U1P')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await dragWire('ins-dc-power.CH1P', 'ins-dc-voltmeter.POS')
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
  await dragWire('ins-dc-power.CH1P', 'ins-dc-ammeter.POS')
  await expect(viewport()).toHaveAttribute('data-wire-count', '3')
  const targets = JSON.parse((await viewport().getAttribute('data-jack-targets')) ?? '[]') as {
    id: string
    stackCount: number
  }[]
  expect(targets.find((target) => target.id === 'ins-dc-power.CH1P')?.stackCount).toBe(3)

  const start = await jackPoint('dc1.KH_U2P')
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
  await dragWire('ins-dc-power.CH1P', 'dc1.KH_U1P')
  await dragWire('ins-dc-power.CH1P', 'dc1.KH_U1P')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await expect(editor().getByRole('status')).toContainText('已有导线')
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')
  const from = await jackPoint('dc1.KH_U2P')
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
