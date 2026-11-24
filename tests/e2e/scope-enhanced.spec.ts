import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, enableDualInstrumentDock } from './helpers/instruments'

type EnhancedSummary = {
  state: string
  revision: number
  displayMode: 'yt' | 'xy'
  xy: {
    count: number
    xVpp: number
    yVpp: number
    correlation: number
    areaRatio: number
  } | null
  cursors: {
    mode: 'time' | 'voltage'
    sourceChannelId: string
    deltaT: number | null
    frequency: number | null
    v1: number | null
    v2: number | null
    deltaV: number | null
  } | null
  channels: {
    id: string
    vpp: number | null
    frequency: number | null
  }[]
}

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const panel = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const generator = (page: Page) => panel(page, '双通道函数信号发生器')
const scope = (page: Page) => panel(page, '双通道数字示波器')

async function readScope2d(page: Page): Promise<EnhancedSummary | null> {
  const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
  return raw ? (JSON.parse(raw) as EnhancedSummary) : null
}

async function choose(page: Page, container: ReturnType<typeof panel>, label: string, option: string) {
  await container.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function exact(container: ReturnType<typeof panel>, label: string, value: string) {
  const input = container.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

const loaded = (vpp: number) => (vpp * 1e6) / (1e6 + 50)
const near = (value: number | null | undefined, expected: number, tolerance = 0.02) =>
  value !== null && value !== undefined && Math.abs(value - expected) <= Math.max(1e-6, Math.abs(expected) * tolerance)

test('T1.3 INS-11 示波器 X-Y 模式、双光标测量、冻结后改源保持画面与截图入报告', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-scope-enhanced-')) },
  })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await page.evaluate(() => {
      location.hash = '#/practice/DG-19'
    })
    await expect(page.getByRole('button', { name: '拖放 双通道数字示波器', exact: true })).toBeVisible()
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
    await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
    await enableDualInstrumentDock(page)
    await addInstrumentWireFromList(page, 'generator1.CH1', 'scope1.CH1')
    await addInstrumentWireFromList(page, 'generator1.CH2', 'scope1.CH2')
    await addInstrumentWireFromList(page, 'generator1.GND', 'scope1.GND')
    await page.getByRole('button', { name: '上电', exact: true }).click()

    // 等待双通道 1 kHz / 2 Vpp 正弦波稳定采集
    await expect
      .poll(
        async () => {
          const s = await readScope2d(page)
          return near(s?.channels[0]?.vpp, loaded(2)) && near(s?.channels[1]?.vpp, loaded(2))
        },
        { timeout: 15_000 },
      )
      .toBe(true)

    // 1. 切换 X-Y 模式：CH1(X) 与 CH2(Y) 同频同相正弦合成对角李萨如直线（ρ ≈ 1）
    await scope(page).getByRole('button', { name: 'X-Y 模式', exact: true }).click()
    await expect(page.locator('canvas[data-instance-id="scope1"]')).toHaveAttribute('data-display-mode', 'xy')
    await expect
      .poll(async () => {
        const s = await readScope2d(page)
        return (
          s?.displayMode === 'xy' &&
          near(s.xy?.xVpp, loaded(2)) &&
          near(s.xy?.yVpp, loaded(2)) &&
          (s.xy?.correlation ?? 0) > 0.98
        )
      })
      .toBe(true)
    await expect(scope(page).locator('[data-scope-xy-readout]')).toContainText('X-Y 模式 (CH1→X, CH2→Y)')

    // 2. 开启双光标测量：时间光标 Δt 与电压光标 ΔV
    await choose(page, scope(page), '光标模式', '时间光标 Δt')
    await exact(scope(page), '光标 A', '-2.5')
    await exact(scope(page), '光标 B', '2.5')
    await expect
      .poll(async () => {
        const s = await readScope2d(page)
        return near(s?.cursors?.deltaT, 1e-3, 0.01) && near(s?.cursors?.frequency, 1000, 0.01)
      })
      .toBe(true)
    await expect(scope(page).locator('[data-scope-cursor-readout]')).toContainText('Δt 1 ms')

    await choose(page, scope(page), '光标模式', '电压光标 ΔV')
    await exact(scope(page), '光标 A', '-2')
    await exact(scope(page), '光标 B', '2')
    await expect
      .poll(async () => {
        const s = await readScope2d(page)
        // 默认 0.5 V/div，[-2, +2] div -> ΔV = 2.0 V
        return near(s?.cursors?.deltaV, 2, 0.01)
      })
      .toBe(true)
    await expect(scope(page).locator('[data-scope-cursor-readout]')).toContainText('ΔV 2 V')

    // 3. 波形冻结后修改信号发生器幅值与频率，画面与读数保持冻结帧不变
    await scope(page).getByRole('button', { name: '冻结波形', exact: true }).click()
    await expect(page.locator('canvas[data-instance-id="scope1"]')).toHaveAttribute('data-state', 'stopped')
    await exact(generator(page), 'CH1 幅值', '6')
    await exact(generator(page), 'CH1 频率', '2500')
    await page.waitForTimeout(400)
    const frozenSummary = await readScope2d(page)
    expect(frozenSummary?.state).toBe('stopped')
    expect(near(frozenSummary?.channels[0]?.vpp, loaded(2))).toBe(true)
    expect(near(frozenSummary?.channels[0]?.frequency, 1000)).toBe(true)

    // 4. 截图入报告：保存当前波形并切换到数据记录页核对报告附图
    await scope(page).getByRole('button', { name: '截图入报告', exact: true }).click()
    await expect(scope(page).locator('[data-scope-screenshot-count="1"]')).toBeVisible()

    // 解除冻结后，示波器立即更新为改源后的 6 Vpp / 2.5 kHz 波形
    await scope(page).getByRole('button', { name: '解除冻结', exact: true }).click()
    await expect
      .poll(
        async () => {
          const s = await readScope2d(page)
          return near(s?.channels[0]?.vpp, loaded(6)) && near(s?.channels[0]?.frequency, 2500)
        },
        { timeout: 15_000 },
      )
      .toBe(true)

    // 打开“数据记录”标签页，验证报告波形截图可见且包含有效 PNG DataURL 与摘要
    await page.getByRole('tab', { name: '数据记录', exact: true }).click()
    const reportSection = page.getByRole('region', { name: '报告波形截图', exact: true })
    await expect(reportSection).toBeVisible()
    const figure = reportSection.locator('figure[data-screenshot-mode="xy"]')
    await expect(figure).toBeVisible()
    const imgSrc = await figure.locator('img').getAttribute('src')
    expect(imgSrc?.startsWith('data:image/png;base64,')).toBe(true)
    await expect(figure).toContainText('ΔV 2 V')

    await page.getByRole('button', { name: '断电', exact: true }).click()
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
