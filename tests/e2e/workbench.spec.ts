import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { dragInstrumentToSlot } from './helpers/instruments'

let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-e2e-'))
  app = await electron.launch({ args: ['.'], env: { ...process.env, VIRTUAL_USER_DATA: userData } })
  win = await app.firstWindow()
  await win.getByRole('button', { name: '上电' }).waitFor()
})

test.afterEach(async () => {
  await app.close()
})

// 各主要区域都在视口内且有面积，页面无滚动溢出
async function expectLayoutFits(page: Page, width: number, height: number) {
  const size = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    sw: document.documentElement.scrollWidth,
    sh: document.documentElement.scrollHeight,
  }))
  // 系统缩放（如 125%）下窗口尺寸会有 1~2 像素取整误差
  expect(Math.abs(size.w - width)).toBeLessThanOrEqual(2)
  expect(Math.abs(size.h - height)).toBeLessThanOrEqual(2)
  expect(size.sw).toBeLessThanOrEqual(size.w)
  expect(size.sh).toBeLessThanOrEqual(size.h)
  for (const name of ['上电', '检查接线', '导出报告', '显示/收起右栏']) {
    const box = await page.getByRole('button', { name }).boundingBox()
    expect(box, name).not.toBeNull()
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.w)
  }
  for (const label of ['3D 实训台', '直流数字电压表']) {
    const box = await page.getByRole('region', { name: label }).boundingBox()
    expect(box?.width ?? 0, label).toBeGreaterThan(100)
    expect(box?.height ?? 0, label).toBeGreaterThan(60)
  }
  await expect(page.getByRole('heading', { name: '仪表柜' })).toBeVisible()
  await expect(page.getByText('未上电')).toBeVisible()
}

async function setContentSize(width: number, height: number, zoom = 1) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h, z]) => {
      const bw = BrowserWindow.getAllWindows()[0]
      bw?.setMinimumSize(320, 240)
      bw?.setContentSize(w as number, h as number)
      bw?.webContents.setZoomFactor(z as number)
    },
    [width, height, zoom],
  )
  await win.waitForFunction(
    ([w, h]) => Math.abs(window.innerWidth - (w ?? 0)) <= 2 && Math.abs(window.innerHeight - (h ?? 0)) <= 2,
    [Math.round(width / zoom), Math.round(height / zoom)],
  )
}

test('1366×768 下布局正常', async () => {
  await setContentSize(1366, 768)
  await expectLayoutFits(win, 1366, 768)
})

test('4K（3840×2160 CSS 像素）下布局正常', async () => {
  // 屏幕放不下 4K 窗口时，用 0.5 倍缩放在 1920×1080 窗口里得到 3840×2160 的 CSS 视口
  await setContentSize(1920, 1080, 0.5)
  await expectLayoutFits(win, 3840, 2160)
})

test('收起与展开侧栏', async () => {
  const left = win.locator('[data-slot="resizable-panel"]#left')
  const width = async () => (await left.boundingBox())?.width ?? 0
  expect(await width()).toBeGreaterThan(200)
  await win.getByRole('button', { name: '显示/收起左栏' }).click()
  await expect.poll(width).toBe(0)
  await win.getByRole('button', { name: '显示/收起左栏' }).click()
  await expect.poll(width).toBeGreaterThan(200)
})

test('仪表面板弹出为独立窗口，状态与底栏同步，关闭后回到底栏', async () => {
  const dock = win.getByRole('region', { name: '直流数字毫安表' })
  await dock.getByRole('combobox', { name: '量程' }).click()
  await win.getByRole('option', { name: '20 mA', exact: true }).click()

  const popupPromise = app.waitForEvent('window')
  await dock.getByRole('button', { name: '弹出 直流数字毫安表' }).click()
  const popup = await popupPromise
  await popup.getByRole('heading', { name: '直流数字毫安表' }).waitFor()

  // 弹出窗口带着底栏的当前档位
  await expect(popup.getByRole('combobox', { name: '量程' })).toContainText('20 mA')
  await expect(dock.getByText('已在独立窗口中显示')).toBeVisible()

  // 在弹出窗口里改档位
  await popup.getByRole('combobox', { name: '量程' }).click()
  await popup.getByRole('option', { name: '200 mA', exact: true }).click()

  // 关闭弹出窗口，面板回到底栏并保留新档位
  await popup.close()
  await expect(dock.getByRole('combobox', { name: '量程' })).toContainText('200 mA')
  await expect(dock.getByText('已在独立窗口中显示')).toBeHidden()
})

test('底栏"收回"按钮关闭弹出窗口', async () => {
  await dragInstrumentToSlot(win)
  const dock = win.getByRole('region', { name: '数字万用表' })
  const popupPromise = app.waitForEvent('window')
  await dock.getByRole('button', { name: '弹出 数字万用表' }).click()
  const popup = await popupPromise
  await popup.getByRole('heading', { name: '数字万用表' }).waitFor()
  const closed = popup.waitForEvent('close')
  await dock.getByRole('button', { name: '收回 数字万用表' }).click()
  await closed
  await expect(dock.getByRole('combobox', { name: '档位' })).toContainText('20 V')
})
