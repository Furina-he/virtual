import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type Locator, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, openInstrumentPanel } from './helpers/instruments'

// T1.12 ▲ 界面冻结评审与视觉/结构回归基线（PRD 第 10 节：5.2.2(5) 接线、5.2.2(6) 仪表柜、5.2.2(6)1) 示波器、5.2.2(6)2) 函数信号发生器）。

const FROZEN_DOC_DIR = resolve('docs/frozen-ui')
const UPDATE_FROZEN_DOCS = process.env.UPDATE_FROZEN_DOCS === '1'
const VIEWPORT_W = 1366
const VIEWPORT_H = 768

const FROZEN_DOC_FILES = [
  'wiring-workbench.png',
  'instrument-cabinet.png',
  'oscilloscope.png',
  'signal-generator.png',
] as const

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const cabinet = (page: Page) => page.getByRole('region', { name: '仪表柜', exact: true })
const editor = (page: Page) => page.getByRole('region', { name: '接线编辑', exact: true })

async function launchStandardWorkbench() {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-t112-frozen-'))
  const errors: string[] = []
  const app = await electron.launch({
    // 固定 devicePixelRatio=1，确保高分屏开发机与 GitHub Actions Windows CI 像素维度 1:1 一致
    args: ['--force-device-scale-factor=1', '.'],
    env: { ...process.env, VIRTUAL_USER_DATA: userData },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setMinimumSize(320, 240)
      win?.setContentSize(size.w, size.h)
      win?.webContents.setZoomFactor(1)
    },
    { w: VIEWPORT_W, h: VIEWPORT_H },
  )
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.location.hash = '#/practice/MD-03'
  })
  await expect(page.getByRole('banner').getByRole('heading')).toContainText('MD-03', { timeout: 20_000 })
  await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport(page)).toHaveAttribute('data-camera-moving', 'false', { timeout: 15_000 })
  await page.waitForFunction(
    ([w, h]) =>
      window.innerWidth === (w as number) && window.innerHeight === (h as number) && window.devicePixelRatio === 1,
    [VIEWPORT_W, VIEWPORT_H],
  )
  // 关闭首次操作指引卡片，确保每次视觉回归基线完全一致
  const dismissGuide = viewport(page).getByRole('button', { name: '知道了', exact: true })
  if (await dismissGuide.isVisible()) {
    await dismissGuide.click()
    await expect(dismissGuide).toHaveCount(0)
  }
  await page.evaluate(() => document.fonts.ready)
  return { app, page, userData, errors }
}

async function resetScrollTop(container: Locator) {
  await container.evaluate((el) => {
    el.scrollTop = 0
    for (const child of el.querySelectorAll<HTMLElement>(
      '[data-slot="scroll-area-viewport"], [class*="overflow-auto"]',
    )) {
      child.scrollTop = 0
    }
    let parent = el.parentElement
    while (parent) {
      if (parent.matches('[data-slot="scroll-area-viewport"], [class*="overflow-auto"]')) {
        parent.scrollTop = 0
      }
      parent = parent.parentElement
    }
  })
}

async function waitStableUi(page: Page) {
  await expect(viewport(page)).toHaveAttribute('data-camera-moving', 'false', { timeout: 15_000 })
  await expect(page.getByRole('contentinfo')).toContainText('已自动存档', { timeout: 10_000 })
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 })
  await page.mouse.move(0, 0)
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        window.scrollTo(0, 0)
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      }),
  )
}

async function expectNoOverflow(page: Page, label: string) {
  const size = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  expect(size.scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(size.width + 1)
  expect(size.scrollHeight, `${label}: vertical overflow`).toBeLessThanOrEqual(size.height + 1)
  const dock = page.locator('[data-instrument-dock]')
  if (await dock.isVisible()) {
    const viewports = dock.locator('[data-slot="scroll-area-viewport"]')
    const count = await viewports.count()
    for (let i = 0; i < count; i++) {
      const m = await viewports.nth(i).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      expect(m.scrollWidth, `${label}: dock viewport #${i} horizontal overflow`).toBeLessThanOrEqual(m.clientWidth + 2)
    }
  }
}

async function expectOfflineClean(userData: string) {
  const blockedLog = join(userData, 'logs', 'network-blocked.log')
  let blocked = ''
  try {
    blocked = readFileSync(blockedLog, 'utf8').trim()
  } catch {
    blocked = ''
  }
  expect(blocked, 'offline guard must report zero external network requests').toBe('')
}

async function selectComboOption(page: Page, container: Locator, label: string, optionName: string) {
  const trigger = container.getByRole('combobox', { name: label, exact: true })
  await page.mouse.move(0, 0)
  const selected = ((await trigger.locator('[data-slot="select-value"]').textContent()) ?? '').trim()
  if (selected === optionName) return
  await trigger.press('Enter')
  await expect(page.getByRole('option', { name: selected, exact: true })).toBeFocused()
  const option = page.getByRole('option', { name: optionName, exact: true })
  await expect(option).toBeVisible()
  await option.focus()
  await expect(option).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toContainText(optionName)
}

async function setExactKnob(container: Locator, label: string, value: number) {
  const input = container.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(String(value))
  await input.press('Enter')
  await expect(input).toHaveValue(String(value))
}

async function maybeWriteDocScreenshot(page: Page, fileName: (typeof FROZEN_DOC_FILES)[number]) {
  if (!UPDATE_FROZEN_DOCS) return
  mkdirSync(FROZEN_DOC_DIR, { recursive: true })
  await page.screenshot({ path: join(FROZEN_DOC_DIR, fileName), animations: 'disabled' })
}

test.setTimeout(180_000)

test('T1.12 ▲ 四个核心界面（接线、仪表柜、示波器、函数信号发生器）定稿截图与视觉/结构冻结基线', async () => {
  const { app, page, userData, errors } = await launchStandardWorkbench()
  try {
    // 验证离线字体与主题配色基线（浅色课堂投影默认态 + 本地字族，无外网拦截）
    const designTokens = await page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body)
      return {
        fontFamily: bodyStyle.fontFamily,
        colorScheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      }
    })
    expect(designTokens.fontFamily).toContain('Noto Sans SC')
    expect(designTokens.colorScheme).toBe('light')

    // =========================================================================
    // ▲ 界面 1：5.2.2(5) 电路自主搭建 — 接线界面
    // =========================================================================
    const dcPsu = await openInstrumentPanel(page, '直流稳压电源')
    await setExactKnob(dcPsu, 'CH1 电压', 12)

    await cabinet(page).getByRole('button', { name: '放置 双通道函数信号发生器', exact: true }).click()
    await cabinet(page).getByRole('button', { name: '放置 双通道数字示波器', exact: true }).click()
    await expect(cabinet(page)).toHaveAttribute('data-placed-count', '2')
    // 选表不会自动接线（INS-01）
    await expect(editor(page)).toHaveAttribute('data-wire-count', '0')

    // 先关闭信号发生器与示波器内置源输出，保证后续静态工作点测定精准 5.87 V 且保持 1× 实时步长
    const initialGen = await openInstrumentPanel(page, '双通道函数信号发生器')
    await initialGen.getByRole('tab', { name: 'CH1', exact: true }).click()
    const initCh1On = initialGen.getByRole('button', { name: '输出开', exact: true })
    if (await initCh1On.count()) await initCh1On.click()
    await initialGen.getByRole('tab', { name: 'CH2', exact: true }).click()
    const initCh2On = initialGen.getByRole('button', { name: '输出开', exact: true })
    if (await initCh2On.count()) await initCh2On.click()
    await initialGen.getByRole('tab', { name: 'CH1', exact: true }).click()

    const initialScope = await openInstrumentPanel(page, '双通道数字示波器')
    const initScopeOut = initialScope.getByRole('button', { name: '输出开', exact: true })
    if (await initScopeOut.count()) await initScopeOut.click()

    const baseWires: [string, string][] = [
      ['ins-dc-power.CH1P', 'amp1.AMP_VCC'],
      ['ins-dc-power.CH1N', 'amp1.AMP_GND1'],
      ['generator1.CH1', 'amp1.AMP_US'],
      ['generator1.GND', 'amp1.AMP_GND2'],
      ['scope1.GND', 'amp1.AMP_GND2'],
      ['ins-dc-voltmeter.POS', 'amp1.AMP_UC'],
      ['ins-dc-voltmeter.NEG', 'amp1.AMP_GND1'],
    ]
    for (const [a, b] of baseWires) {
      await addInstrumentWireFromList(page, a, b)
    }
    await expect(editor(page)).toHaveAttribute('data-wire-count', String(baseWires.length))

    // 取消末尾导线选中态，避免悬浮操作条遮挡 3D 挂箱画面
    await page.keyboard.press('Escape')

    // 切至“接线专注”布局预设（最大化 3D 台面与右侧接线编辑区）并检查接线
    await page.locator('[data-stage-preset="wiring"]').click()
    await expect(cabinet(page)).toHaveAttribute('data-cabinet-collapsed', 'true')
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(editor(page).getByRole('status')).toContainText('电路拓扑连接正确')

    // 结构冻结断言：单行 3D 工具栏、自动极性色默认开、撤销/重做、搜索选孔与导线列表齐全
    await expect(viewport(page).getByRole('toolbar', { name: '设备快速聚焦', exact: true })).toHaveCount(0)
    await expect(viewport(page).locator('[data-viewport-power-badge]')).toBeVisible()
    await expect(editor(page)).toHaveAttribute('data-auto-wire-color', 'on')
    await expect(editor(page).getByRole('combobox', { name: '接线起点', exact: true })).toBeVisible()
    await expect(editor(page).getByRole('combobox', { name: '接线终点', exact: true })).toBeVisible()
    await expect(editor(page).getByRole('button', { name: '撤销接线', exact: true })).toBeEnabled()
    await expect(editor(page).getByRole('button', { name: '添加导线', exact: true })).toBeVisible()
    await expectNoOverflow(page, 'frozen-01-wiring')

    await resetScrollTop(editor(page))
    await waitStableUi(page)
    await maybeWriteDocScreenshot(page, 'wiring-workbench.png')
    await expect(page).toHaveScreenshot('frozen-01-wiring-layout.png', {
      mask: [viewport(page).locator('canvas'), page.locator('[data-simulation-slow-notice]')],
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })
    await expect(editor(page)).toHaveScreenshot('frozen-01-wiring-panel.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })

    // =========================================================================
    // ▲ 界面 2：5.2.2(6) 虚拟仪表测定 — 仪表柜与自主选表测定界面
    // =========================================================================
    await page.getByRole('button', { name: '显示/收起底栏', exact: true }).click()
    await cabinet(page).getByRole('button', { name: '展开仪表柜', exact: true }).click()
    await expect(cabinet(page)).toHaveAttribute('data-cabinet-collapsed', 'false')

    await cabinet(page).getByRole('button', { name: '放置 数字万用表', exact: true }).click()
    await expect(cabinet(page)).toHaveAttribute('data-placed-count', '3')

    // 将右侧仪表柜与属性区之间的分栏条向下拖开，使全部 3 台可选仪表与“台面仪表 · 3”中文槽位同屏清晰可见
    const cabinetBox = await page.locator('[data-slot="resizable-panel"]#cabinet').boundingBox()
    if (cabinetBox) {
      const handleY = cabinetBox.y + cabinetBox.height + 2
      const handleX = cabinetBox.x + cabinetBox.width / 2
      await page.mouse.move(handleX, handleY)
      await page.mouse.down()
      await page.mouse.move(handleX, handleY + 190, { steps: 10 })
      await page.mouse.up()
    }

    // 结构冻结断言：仪表柜展示全部 3 台允许台式仪表与中文槽位名，严禁向学生裸露 SLOT_*
    for (const insName of ['数字万用表', '双通道函数信号发生器', '双通道数字示波器']) {
      await expect(cabinet(page).getByRole('button', { name: `拖放 ${insName}`, exact: true })).toBeVisible()
      await expect(cabinet(page).getByRole('button', { name: `放置 ${insName}`, exact: true })).toBeVisible()
    }
    await expect(cabinet(page)).toContainText('台面左位')
    await expect(cabinet(page)).toContainText('台面中位')
    await expect(cabinet(page)).toContainText('示波器位')
    await expect(cabinet(page)).not.toContainText('SLOT_')

    // 上电，在底栏激活直流数字电压表展示真实静态工作点 UC = 5.87 V 与统一实时读数切换条
    await page.getByRole('button', { name: '上电', exact: true }).click()
    const dcvPanel = await openInstrumentPanel(page, '直流数字电压表')
    const dcvOut = dcvPanel.locator('output[data-instance-id="ins-dc-voltmeter"]')
    await expect(dcvOut).toHaveAttribute('data-status', 'ok', { timeout: 15_000 })
    await expect(dcvOut).toHaveAttribute('data-reading', '5.87', { timeout: 15_000 })
    await expect(page.locator('[data-live-readings-bar]')).toContainText('5.87')
    await expectNoOverflow(page, 'frozen-02-cabinet')

    await resetScrollTop(cabinet(page))
    await resetScrollTop(dcvPanel)
    await waitStableUi(page)
    await maybeWriteDocScreenshot(page, 'instrument-cabinet.png')
    await expect(page).toHaveScreenshot('frozen-02-cabinet-layout.png', {
      mask: [viewport(page).locator('canvas'), page.locator('[data-simulation-slow-notice]')],
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })
    await expect(cabinet(page)).toHaveScreenshot('frozen-02-cabinet-panel.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })

    // =========================================================================
    // ▲ 界面 3 & 4 准备：将双通道函数信号发生器直连双通道数字示波器，产生相锁 1 kHz 双路真实波形
    // =========================================================================
    await page.getByRole('button', { name: '断电', exact: true }).click()
    await editor(page).getByRole('button', { name: '清空接线', exact: true }).click()
    await page.getByRole('button', { name: '确认清空', exact: true }).click()
    await expect(editor(page)).toHaveAttribute('data-wire-count', '0')

    await addInstrumentWireFromList(page, 'generator1.CH1', 'scope1.CH1')
    await addInstrumentWireFromList(page, 'generator1.CH2', 'scope1.CH2')
    await addInstrumentWireFromList(page, 'generator1.GND', 'scope1.GND')
    await expect(editor(page)).toHaveAttribute('data-wire-count', '3')
    await page.keyboard.press('Escape')

    // 切至“调测专注”布局预设（收起右栏、底栏扩高至 ~46%），充分展示示波器与信号发生器主面板
    await page.locator('[data-stage-preset="debug"]').click()

    // =========================================================================
    // ▲ 界面 4 配置：5.2.2(6)2) 函数信号发生器（CH1 正弦 1 kHz 4 Vpp + CH2 方波 1 kHz 2 Vpp）
    // =========================================================================
    const genPanel = await openInstrumentPanel(page, '双通道函数信号发生器')
    await genPanel.getByRole('tab', { name: 'CH2', exact: true }).click()
    await selectComboOption(page, genPanel, 'CH2 波形', '方波')
    await setExactKnob(genPanel, 'CH2 频率', 1000)
    await setExactKnob(genPanel, 'CH2 幅值', 2)
    await setExactKnob(genPanel, 'CH2 直流偏置', 0)
    const ch2OffBtn = genPanel.getByRole('button', { name: '输出关', exact: true })
    if (await ch2OffBtn.count()) await ch2OffBtn.click()
    await expect(genPanel.getByRole('button', { name: '输出开', exact: true })).toHaveAttribute('aria-pressed', 'true')

    await genPanel.getByRole('tab', { name: 'CH1', exact: true }).click()
    const ch1WaveTrigger = genPanel.getByRole('combobox', { name: 'CH1 波形', exact: true })
    await ch1WaveTrigger.click()
    for (const wave of ['正弦波', '方波', '三角波', '锯齿波']) {
      await expect(page.getByRole('option', { name: wave, exact: true })).toBeVisible()
    }
    await page.getByRole('option', { name: '正弦波', exact: true }).click()
    await genPanel
      .getByRole('group', { name: 'CH1 常用频率预设', exact: true })
      .getByRole('button', { name: '1 kHz', exact: true })
      .click()
    await setExactKnob(genPanel, 'CH1 幅值', 4)
    await setExactKnob(genPanel, 'CH1 直流偏置', 0)
    const ch1OffBtn = genPanel.getByRole('button', { name: '输出关', exact: true })
    if (await ch1OffBtn.count()) await ch1OffBtn.click()
    await expect(genPanel.getByRole('button', { name: '输出开', exact: true })).toHaveAttribute('aria-pressed', 'true')

    await resetScrollTop(genPanel)
    await expect(genPanel.locator('[data-wide-panel-layout="funcGen"]')).toBeVisible()
    const genScreenBox = await genPanel.locator('[data-panel-screen-pane]').boundingBox()
    const genTabsBox = await genPanel.getByRole('tablist', { name: '通道切换', exact: true }).boundingBox()
    expect(genScreenBox && genTabsBox && genScreenBox.x + genScreenBox.width <= genTabsBox.x + 2).toBe(true)

    // =========================================================================
    // ▲ 界面 3：5.2.2(6)1) 双通道数字示波器（配置双路波形、位移、触发并上电冻结定帧）
    // =========================================================================
    const scopePanel = await openInstrumentPanel(page, '双通道数字示波器')
    await selectComboOption(page, scopePanel, 'CH1 V/div', '1 V/div')
    await selectComboOption(page, scopePanel, 'CH2 V/div', '1 V/div')
    await setExactKnob(scopePanel, 'CH1 垂直位移', 1.5)
    await setExactKnob(scopePanel, 'CH2 垂直位移', -1.5)
    await selectComboOption(page, scopePanel, 'CH1 耦合', 'DC 直流耦合')
    await selectComboOption(page, scopePanel, 'CH2 耦合', 'DC 直流耦合')
    await selectComboOption(page, scopePanel, '时基 s/div', '200 μs/div')
    await setExactKnob(scopePanel, '水平位移', 0)
    await selectComboOption(page, scopePanel, '触发源', 'CH1')
    await selectComboOption(page, scopePanel, '触发方式', '常规')
    await selectComboOption(page, scopePanel, '触发边沿', '上升沿')
    await setExactKnob(scopePanel, '触发电平', 0)

    // 核对示波器内置信号源具备四种标准波形（INS-10：正弦/方波/三角/锯齿）
    const outWaveTrigger = scopePanel.getByRole('combobox', { name: '内置信号源 波形', exact: true })
    await outWaveTrigger.scrollIntoViewIfNeeded()
    await outWaveTrigger.click()
    for (const wave of ['正弦波', '方波', '三角波', '锯齿波']) {
      await expect(page.getByRole('option', { name: wave, exact: true })).toBeVisible()
    }
    await page.getByRole('option', { name: '正弦波', exact: true }).click()

    // 回到面板顶部，确保完整 CRT 波形屏与 CH1/CH2 垂直控制区位于可视首屏
    await resetScrollTop(scopePanel)
    const scopeScreenBox = await scopePanel.locator('[data-scope-screen-pane]').boundingBox()
    const scopeCh1Box = await scopePanel.getByRole('region', { name: 'CH1 垂直', exact: true }).boundingBox()
    expect(scopeScreenBox && scopeCh1Box && scopeScreenBox.x + scopeScreenBox.width <= scopeCh1Box.x + 2).toBe(true)

    // 上电等待真实 ngspice 双路稳定触发后冻结波形，保证视觉回归像素确定性
    await page.getByRole('button', { name: '上电', exact: true }).click()
    await expect
      .poll(
        async () => {
          const raw = await scopePanel.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
          if (!raw) return false
          const parsed = JSON.parse(raw) as {
            state: string
            channels: { id: string; vpp: number | null; frequency: number | null }[]
          }
          const c1 = parsed.channels.find((c) => c.id === 'CH1')
          const c2 = parsed.channels.find((c) => c.id === 'CH2')
          return (
            parsed.state === 'triggered' &&
            typeof c1?.vpp === 'number' &&
            Math.abs(c1.vpp - 4) < 0.15 &&
            typeof c1.frequency === 'number' &&
            Math.abs(c1.frequency - 1000) < 20 &&
            typeof c2?.vpp === 'number' &&
            Math.abs(c2.vpp - 2) < 0.15 &&
            typeof c2.frequency === 'number' &&
            Math.abs(c2.frequency - 1000) < 20
          )
        },
        { timeout: 20_000, message: 'Scope triggers stable 1 kHz CH1 4 Vpp sine and CH2 2 Vpp square' },
      )
      .toBe(true)

    await scopePanel.getByRole('button', { name: '冻结波形', exact: true }).click()
    await expect(scopePanel.getByRole('button', { name: '解除冻结', exact: true })).toBeVisible()
    await expectNoOverflow(page, 'frozen-03-oscilloscope')

    await resetScrollTop(scopePanel)
    await waitStableUi(page)
    await maybeWriteDocScreenshot(page, 'oscilloscope.png')
    await expect(scopePanel).toHaveScreenshot('frozen-03-oscilloscope-dock.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })

    // 冻结站内大尺寸示波器弹窗视觉基线（单屏完整呈现左屏波形与右控全部参数）
    await scopePanel.locator('[data-expand-panel="scope1"]').click()
    const enlargedScope = page.locator('[data-enlarged-instrument-dialog="scope1"]')
    await expect(enlargedScope).toBeVisible()
    await resetScrollTop(enlargedScope)
    await page.mouse.move(0, 0)
    await expect(enlargedScope).toHaveScreenshot('frozen-03-oscilloscope-dialog.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })
    await page.keyboard.press('Escape')
    await expect(enlargedScope).toBeHidden()

    // =========================================================================
    // ▲ 界面 4 定稿：5.2.2(6)2) 双通道函数信号发生器
    // =========================================================================
    const activeGenPanel = await openInstrumentPanel(page, '双通道函数信号发生器')
    await expect(activeGenPanel.locator('output[data-instance-id="generator1"]').first()).toHaveAttribute(
      'data-status',
      'ok',
      { timeout: 10_000 },
    )
    await expectNoOverflow(page, 'frozen-04-signal-generator')

    await resetScrollTop(activeGenPanel)
    await waitStableUi(page)
    await maybeWriteDocScreenshot(page, 'signal-generator.png')
    await expect(activeGenPanel).toHaveScreenshot('frozen-04-generator-dock.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    })

    // 核对 4 份正式 ▲ 定稿截图均已落盘且非空
    for (const file of FROZEN_DOC_FILES) {
      const fullPath = join(FROZEN_DOC_DIR, file)
      expect(existsSync(fullPath), `Frozen UI doc screenshot must exist: docs/frozen-ui/${file}`).toBe(true)
      expect(statSync(fullPath).size, `Frozen UI doc screenshot must be non-empty: ${file}`).toBeGreaterThan(20_000)
    }

    await page.getByRole('button', { name: '断电', exact: true }).click()
    await expectOfflineClean(userData)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
