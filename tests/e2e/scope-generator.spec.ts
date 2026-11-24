import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import {
  addInstrumentWireFromList,
  dragInstrumentToSlot,
  enableDualInstrumentDock,
  openInstrumentPanel,
} from './helpers/instruments'

// T0.12：示波器与函数信号发生器。所有读数来自学员接线后的真实 ngspice 瞬态仿真。
let app: ElectronApplication
let page: Page
let errors: string[]

type Summary = {
  state: string
  revision: number
  channels: {
    id: string
    vpp: number | null
    frequency: number | null
    period: number | null
    top: number | null
    bottom: number | null
    crossing: number | null
  }[]
}

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const panel = (name: string) => page.getByRole('region', { name, exact: true })
const generator = () => panel('双通道函数信号发生器')
const scope = () => panel('双通道数字示波器')

async function screen2d(): Promise<Summary | null> {
  const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
  return raw ? (JSON.parse(raw) as Summary) : null
}

async function screen3d(): Promise<Summary | null> {
  const raw = await viewport().getAttribute('data-instrument-scope-screens')
  const value = raw ? (JSON.parse(raw) as Record<string, Summary>)['scope1.MAIN'] : undefined
  return value ?? null
}

const near = (value: number | null | undefined, expected: number, tolerance = 0.01) =>
  value !== null && value !== undefined && Math.abs(value - expected) <= Math.abs(expected) * tolerance

/** 2D 面板与 3D 屏幕都满足条件（两者读同一采集帧） */
async function expectBoth(channel: number, check: (c: Summary['channels'][number]) => boolean, message: string) {
  for (const read of [screen2d, screen3d])
    await expect
      .poll(
        async () => {
          const summary = await read()
          const c = summary?.channels[channel]
          return c && check(c) ? 'ok' : JSON.stringify(c ?? summary)
        },
        { message: `${message} (${read.name})`, timeout: 15_000 },
      )
      .toBe('ok')
}

async function choose(container: ReturnType<typeof panel>, label: string, option: string) {
  await container.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function exact(container: ReturnType<typeof panel>, label: string, value: string) {
  const input = container.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

// 50 Ω 输出内阻与 1 MΩ 输入电阻分压后的期望峰峰值
const loaded = (vpp: number) => (vpp * 1e6) / (1e6 + 50)

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-scope-')) },
  })
  page = await app.firstWindow()
  errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  // 仪表柜内容由项目配置决定（DG-19 允许信号发生器与示波器）
  await page.evaluate(() => {
    location.hash = '#/practice/DG-19'
  })
  await expect(page.getByRole('button', { name: '拖放 双通道数字示波器', exact: true })).toBeVisible()
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
})

test.afterEach(async () => {
  await app.close()
  expect(errors).toEqual([])
})

test('信号发生器接示波器：四种波形、Vpp/频率 ≤1%、调幅与上下左右移动，2D 与 3D 同步', async () => {
  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  await enableDualInstrumentDock(page)
  await expect(scope().locator('canvas[data-instance-id="scope1"]')).toBeVisible()
  await addInstrumentWireFromList(page, 'generator1.CH1', 'scope1.CH1')
  await addInstrumentWireFromList(page, 'generator1.GND', 'scope1.GND')
  await page.getByRole('button', { name: '上电', exact: true }).click()

  // 信号发生器屏幕显示设定频率，2D 与 3D 一致
  const readout = generator().locator('output[data-instance-id="generator1"]')
  await expect(readout).toHaveAttribute('data-reading', '1.000')
  await expect(readout).toHaveAttribute('data-unit', 'kHz')
  await expect
    .poll(async () => {
      const raw = (await viewport().getAttribute('data-instrument-screen-readings')) ?? '{}'
      return (JSON.parse(raw) as Record<string, { text: string }>)['generator1.MAIN']?.text
    })
    .toBe('1.000')

  for (const wave of ['正弦波', '方波', '三角波', '锯齿波']) {
    if (wave !== '正弦波') await choose(generator(), 'CH1 波形', wave)
    await expectBoth(
      0,
      (c) => near(c.vpp, loaded(2)) && near(c.frequency, 1000) && near(c.period, 1e-3),
      `${wave} 自动测量`,
    )
  }
  await choose(generator(), 'CH1 波形', '正弦波')

  // 改频率：测量随仿真变化，不是固定数据
  await exact(generator(), 'CH1 频率', '2500')
  await expect(readout).toHaveAttribute('data-reading', '2.500')
  await expectBoth(0, (c) => near(c.frequency, 2500) && near(c.period, 4e-4), '频率 2.5 kHz')

  // 调幅：幅值 4 Vpp，0.5 V/div 时 ±4 格；换 1 V/div 后 ±2 格
  await exact(generator(), 'CH1 幅值', '4')
  await expectBoth(0, (c) => near(c.vpp, loaded(4)) && near(c.top, 4, 0.03), '幅值 4 Vpp')
  await choose(scope(), 'CH1 V/div', '1 V/div')
  await expectBoth(0, (c) => near(c.top, 2, 0.03) && near(c.bottom, -2, 0.03), 'V/div 调整')

  // 上下移动：垂直位移 +1 格
  await exact(scope(), 'CH1 垂直位移', '1')
  await expectBoth(0, (c) => near(c.top, 3, 0.03) && near(c.bottom, -1, 0.05), '垂直位移')

  // 左右移动：触发点从中心（5 格）移到 3 格
  await expectBoth(0, (c) => near(c.crossing, 5, 0.02), '触发点居中')
  await exact(scope(), '水平位移', '-2')
  await expectBoth(0, (c) => near(c.crossing, 3, 0.03), '水平位移')

  // 通道切换：屏幕改为显示 CH2 设定
  const channelTab = generator().getByRole('tab', { name: 'CH2', exact: true })
  await channelTab.click()
  await expect(channelTab).toHaveAttribute('aria-selected', 'true')
  const channelEditor = generator().getByRole('tabpanel', { name: 'CH2', exact: true })
  await expect(channelEditor).toBeVisible()
  await expect(channelEditor).toHaveAttribute('id', (await channelTab.getAttribute('aria-controls')) ?? '')
  await expect(readout).toHaveAttribute('data-reading', '1.000')
  await expect.poll(async () => (await readout.textContent()) ?? '').toContain('CH2')

  // 断电后无信号
  await page.getByRole('button', { name: '断电', exact: true }).click()
  await expect(page.locator('canvas[data-instance-id="scope1"]')).toHaveAttribute('data-state', 'off')
})

test('示波器内置信号源输出四种波形；单次触发捕获后冻结', async () => {
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  await addInstrumentWireFromList(page, 'scope1.OUT', 'scope1.CH2')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await choose(scope(), '触发源', 'CH2')

  for (const wave of ['正弦波', '方波', '三角波', '锯齿波']) {
    if (wave !== '正弦波') await choose(scope(), '内置信号源 波形', wave)
    await expectBoth(1, (c) => near(c.vpp, loaded(2)) && near(c.frequency, 1000), `内置 ${wave}`)
  }

  await scope().getByRole('button', { name: '单次', exact: true }).click()
  const canvas = page.locator('canvas[data-instance-id="scope1"]')
  await expect(canvas).toHaveAttribute('data-state', 'stopped')
  const frozen = (await screen2d())?.revision
  await page.waitForTimeout(500)
  expect((await screen2d())?.revision).toBe(frozen)
  // 回到自动触发恢复采集；停止键冻结，运行键恢复
  await choose(scope(), '触发方式', '自动')
  await expect(canvas).not.toHaveAttribute('data-state', 'stopped')
  await expectBoth(1, (c) => near(c.frequency, 1000), '恢复采集')
  await scope().getByRole('button', { name: '停止', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-state', 'stopped')
  await scope().getByRole('button', { name: '运行', exact: true }).click()
  await expect(canvas).not.toHaveAttribute('data-state', 'stopped')
})

test('信号经挂箱电阻网络分压：示波器两路读数与电路理论一致', async () => {
  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  await enableDualInstrumentDock(page)
  await addInstrumentWireFromList(page, 'generator1.CH1', 'dc1.TH_USP')
  await addInstrumentWireFromList(page, 'generator1.GND', 'dc1.TH_USN')
  await addInstrumentWireFromList(page, 'scope1.CH1', 'dc1.TH_USP')
  await addInstrumentWireFromList(page, 'scope1.CH2', 'dc1.TH_A')
  await addInstrumentWireFromList(page, 'scope1.GND', 'dc1.TH_B')
  await page.getByRole('button', { name: '上电', exact: true }).click()

  // R6 = 330 Ω，R7 = 510 Ω，R8 + R9 = 520 Ω，信号源内阻 50 Ω，示波器输入 1 MΩ
  const parallel = (a: number, b: number) => (a * b) / (a + b)
  const node = parallel(510, 520 + 1e6)
  const input = parallel(330 + node, 1e6)
  const uIn = (2 * input) / (input + 50)
  const uA = ((uIn * node) / (330 + node)) * (1e6 / (1e6 + 520))
  await expectBoth(0, (c) => near(c.vpp, uIn) && near(c.frequency, 1000), 'Us+ 端')
  await expectBoth(1, (c) => near(c.vpp, uA) && near(c.frequency, 1000), 'A 点')

  // AC 耦合：加 1 V 直流偏置后，DC 耦合轨迹整体上移，AC 耦合居中
  await exact(generator(), 'CH1 直流偏置', '1')
  await expectBoth(0, (c) => near(c.top, (uIn / 2 + uIn / 2) / 0.5, 0.03), 'DC 耦合含偏置')
  await choose(scope(), 'CH1 耦合', 'AC 交流耦合')
  await expectBoth(0, (c) => near(c.top, uIn / 2 / 0.5, 0.03) && near(c.bottom, -uIn / 2 / 0.5, 0.03), 'AC 耦合')
  await choose(scope(), 'CH1 耦合', 'GND 接地')
  await expectBoth(0, (c) => c.top === 0 && c.bottom === 0 && c.vpp === null, 'GND 耦合')
})

test('示波器显示断线与缺少 GND 的提示，弹出窗口保持提示并在补线后清除', async () => {
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  const disconnected = '请将被测信号接入 CH1 或 CH2，并把 GND 接到被测电路的参考端。'
  await expect(scope().getByRole('status')).toHaveText(disconnected)

  await page.getByRole('button', { name: '断电', exact: true }).click()
  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await openInstrumentPanel(page, '双通道数字示波器')
  await addInstrumentWireFromList(page, 'generator1.CH1', 'scope1.CH1')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  const groundNotice = 'CH1 的 GND 未接线，读数以示波器自身地为参考。'
  await expect(scope().getByRole('status')).toContainText(groundNotice)
  await expect(scope().getByRole('status')).toBeInViewport()
  await scope().getByRole('status').scrollIntoViewIfNeeded()
  await scope().screenshot({ path: test.info().outputPath('scope-missing-ground.png') })

  const popupPromise = app.waitForEvent('window')
  await scope().getByRole('button', { name: '弹出 双通道数字示波器', exact: true }).click()
  const popup = await popupPromise
  popup.on('pageerror', (error) => errors.push(error.message))
  await expect(popup.getByRole('heading', { name: '双通道数字示波器', exact: true })).toBeVisible()
  await expect(popup.getByRole('status')).toContainText(groundNotice)
  await expect(popup.getByRole('status')).toBeInViewport()
  await popup.screenshot({ path: test.info().outputPath('scope-popout-missing-ground.png') })

  await page.getByRole('button', { name: '断电', exact: true }).click()
  await addInstrumentWireFromList(page, 'generator1.GND', 'scope1.GND')
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await expect(popup.locator('canvas[data-instance-id="scope1"]')).toHaveAttribute('data-state', 'triggered')
  await expect(popup.getByRole('status')).not.toContainText(groundNotice)
  await popup.close()
  await expectBoth(0, (c) => near(c.vpp, loaded(2)) && near(c.frequency, 1000), '补齐 GND 后正常测量')
  await expect(scope().getByRole('status')).not.toContainText(groundNotice)
})
