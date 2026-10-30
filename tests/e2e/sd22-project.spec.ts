import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { Module } from '../../src/shared/schema/module'
import { Project } from '../../src/shared/schema/project'
import { mouseJack, sd22Wire } from './helpers/sd22'

const project = Project.parse(JSON.parse(readFileSync('content/projects/SD-22/project.json', 'utf8')))
const module = Module.parse(JSON.parse(readFileSync('content/modules/mod-555-app/module.json', 'utf8')))
const recordingTitle = 'SD-22 原板断电参考接线检查、手填保护与确认重置（非声音验收）'
const recordingPath = resolve('build/t015-sd22-content-wiring-v2.webm')

let app: ElectronApplication | undefined
let page: Page
let errors: string[] = []
let recording: ReturnType<Page['video']> = null

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })
const steps = () => page.getByRole('region', { name: '实训步骤', exact: true })
const data = () => page.getByRole('region', { name: '实训数据记录', exact: true })

test.setTimeout(180_000)

test.beforeEach(async () => {
  errors = []
  recording = null
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-sd22-project-')) },
    ...(test.info().title === recordingTitle
      ? { recordVideo: { dir: resolve('build/t015-sd22-recordings'), size: { width: 1366, height: 768 } } }
      : {}),
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  recording = page.video()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setMinimumSize(320, 240)
    window?.setContentSize(1366, 768)
    window?.webContents.setZoomFactor(1)
  })
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.location.hash = '/practice/SD-22'
  })
  await expect(page.getByRole('banner').getByRole('heading')).toHaveText(`${project.id} ${project.title}`)
  await page.waitForLoadState('networkidle')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport()).toHaveAttribute('data-ready-after-frame', 'true')
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false')
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (recording) {
    await recording.saveAs(recordingPath)
    expect(statSync(recordingPath).size).toBeGreaterThan(0)
    await test.info().attach('SD-22 内容与断电接线录屏，非声音全流程验收', {
      path: recordingPath,
      contentType: 'video/webm',
    })
  }
  expect(errors).toEqual([])
})

async function showSteps() {
  await page.getByRole('tab', { name: '步骤', exact: true }).click()
  await expect(steps()).toBeVisible()
}

async function showData() {
  await page.getByRole('tab', { name: '数据记录', exact: true }).click()
  await expect(data()).toHaveAttribute('data-task-project', project.id)
}

test('SD-22 36 个真实 GLB 插孔、六项指导书、原创原理图和双模式数据模板挂载', async () => {
  expect(module.jacks).toHaveLength(36)
  // Inspect the actual scene's projected anchors, not a static catalog-only preview.
  const projected = JSON.parse((await viewport().getAttribute('data-jack-targets')) ?? '[]') as { ref: string }[]
  const mounted = projected.filter((jack) => jack.ref.startsWith('timer1.')).map((jack) => jack.ref)
  expect(mounted.sort()).toEqual(module.jacks.map((jack) => `timer1.${jack.id}`).sort())
  expect(
    projected
      .filter((jack) => jack.ref.startsWith('follower1.'))
      .map((jack) => jack.ref)
      .sort(),
  ).toEqual(['VCC', 'GND', 'IN', 'OUT'].map((id) => `follower1.${id}`).sort())
  expect(projected.some((jack) => jack.ref.startsWith('dc1.'))).toBe(false)
  await expect(viewport()).toHaveAttribute('data-placed-instruments', '[]')

  const guide = page.getByRole('tabpanel', { name: '实训指导', exact: true })
  for (const section of ['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题']) {
    await expect(guide.getByRole('heading', { name: section, exact: true })).toHaveCount(1)
  }
  await expect(guide).toContainText('5 V')
  await expect(guide).toContainText('0.99 Hz')
  await expect(guide).toContainText('消防车')
  await expect(guide).toContainText('缓冲')
  await expect(guide).toContainText('TLV9001')
  await expect(guide).toContainText('未完成')

  await page.getByRole('tab', { name: '原理图', exact: true }).click()
  const image = page.getByRole('img', { name: 'SD-22 原理图', exact: true })
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate(
        (element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true)
  await page.getByRole('button', { name: '放大原理图', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('img', { name: 'SD-22 放大原理图', exact: true })).toBeVisible()
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await expect
    .poll(() => page.locator('[data-slot="dialog-overlay"]').evaluate((element) => getComputedStyle(element).opacity))
    .toBe('1')
  await page.screenshot({ path: resolve('build/t015-sd22-schematic.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await showData()
  const tableSelector = data().getByRole('combobox', { name: '记录数据表', exact: true })
  for (const table of project.dataTables) {
    await tableSelector.press('Enter')
    const option = page.getByRole('option', { name: table.title, exact: true })
    await option.focus()
    await option.press('Enter')
    await expect(data()).toHaveAttribute('data-task-table', table.id)
    await expect(data().locator(`input[data-table-id="${table.id}"]`)).toHaveCount(table.rows * table.columns.length)
  }
  const size = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width)
  expect(size.scrollHeight).toBeLessThanOrEqual(size.height)
})

test(recordingTitle, async () => {
  expect(recording).not.toBeNull()
  await showSteps()
  await steps().getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expect(steps()).toHaveAttribute('data-current-step', 'wire-ambulance')
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).not.toContainText('电路拓扑连接正确。')
  await page.screenshot({ path: resolve('build/t015-sd22-unwired-report.png') })
  // The bounded public report must leave ordinary mouse endpoint selection usable.
  await page.getByRole('button', { name: '检查接线', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(editor().getByRole('status')).toHaveCount(1)
  let count = 0
  for (const [first, ...rest] of project.reference.nets) {
    if (!first) throw new Error('Reference net is empty')
    for (const jack of rest) {
      await sd22Wire(page, first, jack)
      count++
      await expect(editor()).toHaveAttribute('data-wire-count', String(count))
    }
  }
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText('电路拓扑连接正确。')
  await steps().getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expect(steps()).toHaveAttribute('data-current-step', 'supply')
  await expect(steps()).toHaveAttribute('data-completed-count', '2')

  // This is deliberately a manual-entry guard, not a simulated measurement or a completed alarm.
  await showData()
  const supply = data().locator('input[data-table-id="supply"][data-column-id="u-vcc"]')
  await supply.fill('5')
  await supply.press('Enter')
  await expect(supply).toHaveValue('5')
  await expect(supply).toHaveAttribute('data-captured-from', '')
  await steps().getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expect(steps()).toHaveAttribute('data-current-step', 'supply')
  await expect(steps().locator('[data-task-notice]')).toContainText('请检查当前接线')
  await expect(steps().locator('[data-task-notice]')).toContainText('测量 supply')
  await page.getByRole('button', { name: '记录读数', exact: true }).click()
  await expect(supply).toHaveAttribute('data-captured-from', '')
  await expect(steps()).toHaveAttribute('data-completed-count', '2')
  await page.screenshot({ path: resolve('build/t015-sd22-content-wiring.png') })

  await mouseJack(page, '接线起点', 'timer1.T1_OUT')
  await supply.fill('4.8')
  await page.getByRole('button', { name: '重置', exact: true }).click()
  const reset = page.getByRole('dialog', { name: '重置当前实训？', exact: true })
  await reset.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(reset).toBeHidden()
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expect(editor()).toHaveAttribute('data-undo-count', '0')
  await expect(editor()).toHaveAttribute('data-redo-count', '0')
  // Reset also restores the initial guide/instrument tabs; reopen the real panels.
  await showSteps()
  await expect(steps()).toHaveAttribute('data-current-step', 'prepare')
  await expect(steps()).toHaveAttribute('data-completed-count', '0')
  await showData()
  await expect(supply).toHaveValue('')
  await expect(editor().getByRole('combobox', { name: '接线起点', exact: true })).toHaveAttribute(
    'data-selected-jack',
    '',
  )
  await page.getByRole('button', { name: '重置', exact: true }).focus()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Shift+z')
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expect(steps()).toHaveAttribute('data-completed-count', '0')
  await expect(supply).toHaveValue('')
})
