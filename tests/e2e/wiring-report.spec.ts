import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'

let app: ElectronApplication
let page: Page
let errors: string[]
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })
const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-wiring-report-')) },
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.evaluate(() => {
    const trace: unknown[] = []
    Object.assign(window, { __wiringReportWheel: trace })
    document.addEventListener(
      'wheel',
      (event) => {
        const target = event.target instanceof Element ? event.target : null
        const record: Record<string, unknown> = {
          x: event.clientX,
          y: event.clientY,
          deltaY: event.deltaY,
          target: target?.closest('[data-slot]')?.getAttribute('data-slot'),
          targetRole: target?.closest('[role]')?.getAttribute('role'),
        }
        requestAnimationFrame(() => {
          const report = document.querySelector('[aria-label="接线诊断报告"]')
          const viewport = report?.querySelector('[data-slot="scroll-area-viewport"]')
          const editor = document.querySelector('[aria-label="接线编辑"]')
          record.prevented = event.defaultPrevented
          record.reportTop = viewport?.scrollTop
          record.editorTop = editor?.scrollTop
          trace.push(record)
        })
      },
      true,
    )
  })
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setMinimumSize(320, 240)
    window?.setContentSize(1366, 768)
    window?.webContents.setZoomFactor(1)
  })
  await page.evaluate(() => {
    location.hash = '/practice/DG-05'
  })
  await expect(page.getByRole('banner').getByRole('heading')).toContainText('DG-05 ')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await page.waitForFunction(() => Math.abs(innerWidth - 1366) <= 2 && Math.abs(innerHeight - 768) <= 2)
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
})

test.afterEach(async () => {
  const info = test.info()
  if (info.status !== info.expectedStatus) {
    try {
      const diagnostic = await page.evaluate(async () => {
        const rect = (element: Element) => {
          const bounds = element.getBoundingClientRect()
          return {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            left: bounds.left,
          }
        }
        const metrics = (element: Element) => {
          const style = getComputedStyle(element)
          return {
            tag: element.tagName,
            id: element.id,
            role: element.getAttribute('role'),
            label: element.getAttribute('aria-label'),
            slot: element.getAttribute('data-slot'),
            rect: rect(element),
            scrollTop: element.scrollTop,
            scrollLeft: element.scrollLeft,
            clientHeight: element.clientHeight,
            clientWidth: element.clientWidth,
            scrollHeight: element.scrollHeight,
            scrollWidth: element.scrollWidth,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            scrollMargin: style.scrollMargin,
            scrollPadding: style.scrollPadding,
          }
        }
        const report = document.querySelector('[aria-label="接线诊断报告"]')
        const viewport = report?.querySelector('[data-slot="scroll-area-viewport"]')
        const ancestors = []
        for (let node = viewport?.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node)
          if (style.overflowX !== 'visible' || style.overflowY !== 'visible') ancestors.push(metrics(node))
        }
        const intersection = report
          ? await new Promise((resolve) => {
              const observer = new IntersectionObserver((entries) => {
                const entry = entries[0]
                resolve(
                  entry
                    ? {
                        ratio: entry.intersectionRatio,
                        target: entry.boundingClientRect.toJSON(),
                        visible: entry.intersectionRect.toJSON(),
                        root: entry.rootBounds?.toJSON(),
                      }
                    : null,
                )
                observer.disconnect()
              })
              observer.observe(report)
              requestAnimationFrame(() => {})
            })
          : null
        const wheel = (window as unknown as { __wiringReportWheel: { x: number; y: number }[] }).__wiringReportWheel
        const last = wheel.at(-1)
        return {
          report: report ? metrics(report) : null,
          viewport: viewport ? metrics(viewport) : null,
          ancestors,
          intersection,
          wheel,
          wheelHitStack: last ? document.elementsFromPoint(last.x, last.y).map(metrics) : [],
        }
      })
      await info.attach('wiring-report-layout-diagnostic', {
        body: JSON.stringify(diagnostic, null, 2),
        contentType: 'application/json',
      })
      writeFileSync(info.outputPath('wiring-report-layout-diagnostic.json'), JSON.stringify(diagnostic, null, 2))
      await page.screenshot({ path: info.outputPath('wiring-report-failure.png') })
    } catch (error) {
      await info.attach('wiring-report-diagnostic-error', { body: String(error), contentType: 'text/plain' })
    }
  }
  await app.close()
  expect(errors).toEqual([])
})

async function mouseSelectJack(label: string, ref: string) {
  const trigger = editor().getByRole('combobox', { name: label, exact: true })
  await trigger.click()
  const option = page.locator(`[role="option"][data-jack-ref="${ref}"]`)
  await option.scrollIntoViewIfNeeded()
  await option.hover()
  await option.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toHaveAttribute('data-selected-jack', ref)
}

async function addWire(a: string, b: string) {
  const before = Number(await editor().getAttribute('data-wire-count'))
  await mouseSelectJack('接线起点', a)
  await mouseSelectJack('接线终点', b)
  const add = editor().getByRole('button', { name: '添加导线', exact: true })
  await add.scrollIntoViewIfNeeded()
  await expect(add).toBeInViewport({ ratio: 1 })
  await expect(add).toBeEnabled()
  await add.click()
  await expect(editor()).toHaveAttribute('data-wire-count', String(before + 1))
}

async function makeCompactRightPanel() {
  const right = page.locator('[data-slot="resizable-panel"]#right')
  const handle = page.locator('[data-slot="resizable-handle"]:has(+ [data-slot="resizable-panel"]#right)')
  const box = await handle.boundingBox()
  if (!box) throw new Error('Right-panel resize handle is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(1366 - 224, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await right.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(220)
  await expect.poll(async () => (await right.boundingBox())?.width ?? 0).toBeLessThanOrEqual(240)

  const properties = page.locator('[data-slot="resizable-panel"]#properties')
  const vertical = right.locator('[data-slot="resizable-handle"]:has(+ [data-slot="resizable-panel"]#properties)')
  const from = await vertical.boundingBox()
  const target = await properties.boundingBox()
  if (!from || !target) throw new Error('Properties-panel resize handle is not visible')
  const x = from.x + from.width / 2
  await page.mouse.move(x, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, target.y + target.height - 244, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await properties.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(240)
  await expect.poll(async () => (await properties.boundingBox())?.height ?? 0).toBeLessThanOrEqual(252)
}

// The incorrect leads are entered through the UI while powered off, not injected into circuit state.
const incorrectEndpoints = ['KH_U1P', 'KH_U2P', 'KH_B', 'KH_D', 'KH_C', 'KH_A', 'TH_USP', 'TH_ISP', 'TH_IA', 'TH_USN']

for (const compact of [false, true]) {
  test(`长接线报告完整可滚动，${compact ? '最小窄右栏' : '1366×768 默认右栏'}仍可鼠标选择并添加导线`, async () => {
    if (compact) await makeCompactRightPanel()
    for (const endpoint of incorrectEndpoints) await addWire('dc1.KH_U1N', `dc1.${endpoint}`)
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    const diagnostic = editor().getByRole('status')
    await expect(diagnostic).toContainText('多了连线')
    const text = (await diagnostic.textContent()) ?? ''
    expect(text.length).toBeGreaterThan(500)
    expect((text.match(/多了连线/g) ?? []).length).toBeGreaterThanOrEqual(8)
    await expect(editor()).toHaveAttribute('data-wire-count', String(incorrectEndpoints.length))

    const report = editor().getByRole('region', { name: '接线诊断报告', exact: true })
    const scroll = report.locator('[data-slot="scroll-area-viewport"]')
    await report.scrollIntoViewIfNeeded()
    await expect(report).toBeInViewport({ ratio: 1 })
    await expect
      .poll(() =>
        scroll.evaluate((element) => element.scrollHeight > element.clientHeight * 2 && element.clientHeight <= 80),
      )
      .toBe(true)
    await scroll.hover()
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop > 0)).toBe(true)
    await expect
      .poll(() =>
        scroll.evaluate((element) => {
          const status = element.querySelector('[role="status"]')
          const node = status?.firstChild
          if (!node?.textContent?.length) return false
          const range = document.createRange()
          range.setStart(node, node.textContent.length - 1)
          range.setEnd(node, node.textContent.length)
          const last = range.getBoundingClientRect()
          const bounds = element.getBoundingClientRect()
          return last.top >= bounds.top && last.bottom <= bounds.bottom
        }),
      )
      .toBe(true)
    await expect(diagnostic).toHaveText(text)
    await page.screenshot({ path: test.info().outputPath('wiring-report-scrolled.png') })

    // Selecting endpoints must not dismiss the report or require a color-change workaround.
    await mouseSelectJack('接线起点', 'ins-dc-power.CH1P')
    await expect(diagnostic).toHaveText(text)
    await mouseSelectJack('接线终点', 'dc1.KH_U1P')
    await expect(diagnostic).toHaveText(text)
    const add = editor().getByRole('button', { name: '添加导线', exact: true })
    await add.scrollIntoViewIfNeeded()
    await expect(add).toBeInViewport({ ratio: 1 })
    await expect(add).toBeEnabled()
    await page.screenshot({ path: test.info().outputPath('wiring-report-add-wire.png') })
    await add.click()
    await expect(editor()).toHaveAttribute('data-wire-count', String(incorrectEndpoints.length + 1))
    await expect(editor().locator('li[data-wire-a="ins-dc-power.CH1P"][data-wire-b="dc1.KH_U1P"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()

    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(editor().getByRole('status')).toContainText('多了连线')
    await expect(editor().getByRole('region', { name: '接线诊断报告', exact: true })).toBeVisible()
    const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
    expect(size.scrollWidth).toBeLessThanOrEqual(size.width)
  })
}
