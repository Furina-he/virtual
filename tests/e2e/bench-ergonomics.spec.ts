import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { focusDevice, jackPoint, projectedJacks } from './helpers/bench'
import {
  addInstrumentWireFromList,
  enableDualInstrumentDock,
  openInstrumentPanel,
  selectJackFromList,
} from './helpers/instruments'

type ProjectedSlot = { id: string; x: number; y: number; visible: boolean }
type ProjectedControl = { id: string; label: string; x: number; y: number; visible: boolean }
type ProjectedWire = { id: string; x: number; y: number; visible: boolean }
type ProjectedEndpointHandle = {
  wireId: string
  end: 'a' | 'b'
  jack: string
  x: number
  y: number
  visible: boolean
}
type WireEndpoint = { id: string; a: string; b: string; color: string; slack?: number }

let app: ElectronApplication
let page: Page
let errors: string[]

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const cabinet = () => page.getByRole('region', { name: '仪表柜', exact: true })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })
const steps = () => page.getByRole('region', { name: '实训步骤', exact: true })
const panel = (name: string) => page.getByRole('region', { name, exact: true })

async function projectedSlots(): Promise<ProjectedSlot[]> {
  return JSON.parse((await viewport().getAttribute('data-slot-targets')) ?? '[]')
}

async function projectedInstrumentControls(): Promise<ProjectedControl[]> {
  return JSON.parse((await viewport().getAttribute('data-instrument-control-targets')) ?? '[]')
}

async function projectedWires(): Promise<ProjectedWire[]> {
  return JSON.parse((await viewport().getAttribute('data-wire-targets')) ?? '[]')
}

async function projectedEndpointHandles(): Promise<ProjectedEndpointHandle[]> {
  return JSON.parse((await viewport().getAttribute('data-wire-endpoint-handles')) ?? '[]')
}

async function wireEndpoints(): Promise<WireEndpoint[]> {
  return JSON.parse((await viewport().getAttribute('data-wire-endpoints')) ?? '[]')
}

async function expectNoDocumentOverflow(label: string) {
  const size = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  expect(size.scrollWidth, `${label}: horizontal document overflow`).toBeLessThanOrEqual(size.width + 1)
  expect(size.scrollHeight, `${label}: vertical document overflow`).toBeLessThanOrEqual(size.height + 1)
}

async function expectNoDualAxisDockScroll(label: string) {
  const dock = page.locator('[data-instrument-dock]')
  if (!(await dock.isVisible())) return
  const viewports = dock.locator('[data-slot="scroll-area-viewport"]')
  const count = await viewports.count()
  for (let i = 0; i < count; i++) {
    const metrics = await viewports.nth(i).evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }))
    expect(metrics.scrollWidth, `${label}: bottom instrument panel #${i} horizontal overflow`).toBeLessThanOrEqual(
      metrics.clientWidth + 2,
    )
  }
}

test.beforeEach(async () => {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-bench-ergonomics-')) },
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

test('T1.9B B1/B2 空间减法、阶段预设、动态有效构图、免切镜跨设备接线、连续引出与常驻标注', async () => {
  // 1. 视口空间减法：无第二行设备快速聚焦条，无底行文字条，保留单行工具栏 + 右上角极简电源徽标 + 左下角可自消失引导条
  await expect(viewport().getByRole('toolbar', { name: '设备快速聚焦', exact: true })).toHaveCount(0)
  const powerBadge = viewport().locator('[data-viewport-power-badge]')
  await expect(powerBadge).toBeVisible()
  await expect(powerBadge).toHaveText('电源关')
  await powerBadge.click()
  await expect(powerBadge).toHaveText('电源开')
  await powerBadge.click()
  await expect(powerBadge).toHaveText('电源关')

  const onboarding = viewport().getByRole('complementary', { name: '操作提示', exact: true })
  await expect(onboarding).toBeVisible()

  // 2. 默认操作视角按活跃设备动态构图（data-camera-view-mode="active"），密集挂箱插孔仍不可直接拾取（单击进特写）
  await expect(viewport()).toHaveAttribute('data-camera-preset', 'work')
  await expect(viewport()).toHaveAttribute('data-camera-view-mode', 'active')
  const dcOverview = (await projectedJacks(page)).find((jack) => jack.id === 'comp1.RA_1')
  expect(dcOverview?.pickable).toBe(false)

  // 拖拽台式表时相机自动切换至 drag-slots 显露全部 5 个桌面安装位，松手回到 active
  const dragBtn = cabinet().getByRole('button', { name: '拖放 数字万用表', exact: true })
  const dragBox = await dragBtn.boundingBox()
  if (!dragBox) throw new Error('Missing drag button for 数字万用表')
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(dragBox.x - 16, dragBox.y, { steps: 4 })
  await expect(viewport()).toHaveAttribute('data-camera-view-mode', 'drag-slots')
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false')
  const dragSlots = await projectedSlots()
  for (const requiredSlot of ['SLOT_DESK_1', 'SLOT_DESK_2', 'SLOT_SCOPE']) {
    expect(dragSlots.find((slot) => slot.id === requiredSlot)?.visible, `${requiredSlot} visible while dragging`).toBe(
      true,
    )
  }
  await page.mouse.up()
  await expect(viewport()).toHaveAttribute('data-camera-view-mode', 'active')

  // 3. 阶段化布局预设与仪表柜单行折叠
  await page.locator('[data-stage-preset="wiring"]').click()
  await expect
    .poll(async () => (await page.locator('[data-slot="resizable-panel"]#bottom').boundingBox())?.height ?? -1)
    .toBe(0)
  await expect(cabinet()).toHaveAttribute('data-cabinet-collapsed', 'true')

  await page.locator('[data-stage-preset="debug"]').click()
  await expect
    .poll(async () => (await page.locator('[data-slot="resizable-panel"]#right').boundingBox())?.width ?? -1)
    .toBe(0)
  await expect
    .poll(async () => (await page.locator('[data-slot="resizable-panel"]#bottom').boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(240)

  // 恢复右栏并展开仪表柜
  await page.getByRole('button', { name: '显示/收起右栏', exact: true }).click()
  await cabinet().getByRole('button', { name: '展开仪表柜', exact: true }).click()
  await expect(cabinet()).toHaveAttribute('data-cabinet-collapsed', 'false')

  // 4. 默认开启自动极性色；特写常驻防重叠插孔标注 + “插孔标注”一键显隐
  await expect(editor()).toHaveAttribute('data-auto-wire-color', 'on')
  await focusDevice(page, 'ins-dc-power')
  await expect(page.locator('[data-persistent-jack-label]').first()).toBeVisible()
  await expect
    .poll(() => page.locator('[data-persistent-jack-label]').count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(4)
  const labelToggle = viewport().getByRole('button', { name: '插孔标注', exact: true })
  await labelToggle.click()
  await expect(labelToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-persistent-jack-label]')).toHaveCount(0)
  await labelToggle.click()
  await expect(labelToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-persistent-jack-label]').first()).toBeVisible()

  // 5. 免切镜跨设备接线浮层（QuickTargetWiringDock）+ 悬停 3D 预览导线吸附 + 连续从此孔引出 + 自动极性色
  const startJack = await jackPoint(page, 'ins-dc-power.CH1P')
  await page.mouse.click(startJack.x, startJack.y)
  // 首次点击 3D 插孔自动消除左下角引导条
  await expect(onboarding).toHaveCount(0)
  await expect(viewport()).toHaveAttribute('data-pending-jack', 'ins-dc-power.CH1P')
  await expect(viewport()).toHaveAttribute('data-wire-xray', 'on')
  await expect(viewport().locator('[data-pending-wire-banner]')).toContainText('起点：')

  const quickDock = viewport().locator('[data-quick-target-dock]')
  await expect(quickDock).toBeVisible()
  await quickDock.locator('[data-continuous-wiring-switch]').click()

  const quickSearch = quickDock.locator('[data-quick-target-search]')
  await quickSearch.fill('直流数字电压表')
  const dcvPosBtn = quickDock.locator('[data-quick-target-jack="ins-dc-voltmeter.POS"]')
  await expect(dcvPosBtn).toBeVisible()
  await dcvPosBtn.hover()
  await expect(viewport()).toHaveAttribute('data-draft-target', 'ins-dc-voltmeter.POS')
  await dcvPosBtn.click()
  // 跨设备连线成功且无需切离 ins-dc-power 特写，同时因连续引出保持 pendingJack
  await expect(viewport()).toHaveAttribute('data-camera-preset', 'focus:ins-dc-power')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await expect(viewport()).toHaveAttribute('data-pending-jack', 'ins-dc-power.CH1P')

  await quickSearch.fill('RA_1')
  await quickDock.locator('[data-quick-target-jack="comp1.RA_1"]').click()
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
  await expect(viewport()).toHaveAttribute('data-pending-jack', 'ins-dc-power.CH1P')
  await page.keyboard.press('Escape')
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')

  // 自动极性色默认生效：CH1P 走红线，CH1N/NEG 走黑线
  await addInstrumentWireFromList(page, 'ins-dc-power.CH1N', 'ins-dc-voltmeter.NEG')
  await expect(viewport()).toHaveAttribute('data-wire-count', '3')
  const wires = await wireEndpoints()
  expect(wires[0]?.color).toBe('red')
  expect(wires[2]?.color).toBe('black')

  // 6. 底栏统一活跃仪表切换栏 + "+ 其他固定表" 折叠下拉 + [单表|双表] + 站内放大 Dialog + 跨 Tab 读数跳回 + 带电 Toast 断电
  const readingsBar = page.locator('[data-live-readings-bar]')
  await expect(readingsBar.locator('[data-live-reading-chip="ins-dc-power"]')).toBeVisible()
  await expect(readingsBar.locator('[data-live-reading-chip="ins-dc-voltmeter"]')).toBeVisible()

  const otherFixed = page.locator('[data-other-fixed-trigger]')
  await expect(otherFixed).toBeVisible()
  await otherFixed.click()
  await page.getByRole('menuitem', { name: '直流数字毫安表', exact: true }).click()
  await expect(panel('直流数字毫安表')).toBeVisible()

  // 双表对比与单表切回
  await enableDualInstrumentDock(page)
  await expect(page.locator('[data-instrument-dock]')).toHaveAttribute('data-dock-layout', 'dual')
  await page.locator('[data-dock-mode="single"]').click()
  await expect(page.locator('[data-instrument-dock]')).toHaveAttribute('data-dock-layout', 'single')

  // 站内放大 Dialog
  const dcPanel = await openInstrumentPanel(page, '直流稳压电源')
  await dcPanel.locator('[data-expand-panel="ins-dc-power"]').click()
  const enlarged = page.locator('[data-enlarged-instrument-dialog="ins-dc-power"]')
  await expect(enlarged).toBeVisible()
  await expect(enlarged.getByRole('button', { name: '弹出独立窗口', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(enlarged).toBeHidden()

  // 2D 电源预设调至 12 V 并上电，切到数据记录 Tab 核对常驻读数胶囊并一键跳回
  await dcPanel
    .getByRole('group', { name: 'CH1 电压常用预设', exact: true })
    .getByRole('button', { name: '12 V', exact: true })
    .click()
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await page.getByRole('tab', { name: '数据记录', exact: true }).click()
  const dcvChip = readingsBar.locator('[data-live-reading-chip="ins-dc-voltmeter"]')
  await expect(dcvChip).toContainText(/12\.0\d*\s*V/, { timeout: 10_000 })
  await dcvChip.click()
  await expect(page.getByRole('tab', { name: '仪表', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(panel('直流数字电压表')).toBeVisible()

  // 带电删除触发 Sonner Toast（含“立即断电”按钮）
  await editor().getByRole('button', { name: '删除导线 1', exact: true }).click()
  const toastAction = page.getByRole('button', { name: '立即断电', exact: true })
  await expect(toastAction).toBeVisible()
  await toastAction.click()
  await expect(page.getByRole('button', { name: '上电', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await editor().getByRole('button', { name: '删除导线 1', exact: true }).click()
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
})

test('T1.9B B3/B4 可视化拔插改接、3D 旋钮零滚轮冲突与气泡调参、原理图直连、可搜索选孔与定位闭环', async () => {
  // 1. 可视化拔插改接：选中导线出现两端手柄与中点微工具条，单步撤销恢复
  await addInstrumentWireFromList(page, 'ins-dc-power.CH1P', 'ins-dc-voltmeter.POS')
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await editor().getByRole('button', { name: '选择导线 1', exact: true }).click()

  const [wireTarget] = await projectedWires()
  expect(wireTarget?.id).toBeTruthy()
  const microToolbar = viewport().locator(`[data-wire-micro-toolbar="${wireTarget?.id}"]`)
  await expect(microToolbar).toBeVisible()
  const handles = await projectedEndpointHandles()
  expect(handles).toHaveLength(2)

  // 通过中点微工具条“改接终点” + 快捷落点改接到 ins-dc-ammeter.POS，再 Ctrl+Z 单步撤销
  await microToolbar.getByRole('button', { name: '改接终点', exact: true }).click()
  await expect(viewport()).toHaveAttribute('data-pending-rewire', /:b$/)
  await viewport().locator('[data-quick-target-jack="ins-dc-ammeter.POS"]').click()
  await expect(viewport()).toHaveAttribute('data-pending-rewire', '')
  expect((await wireEndpoints())[0]?.b).toBe('ins-dc-ammeter.POS')

  await viewport().getByRole('button', { name: '操作视角', exact: true }).focus()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await wireEndpoints())[0]?.b).toBe('ins-dc-voltmeter.POS')

  // 直接左键点击 3D 选中导线终点球形手柄进入改接，再通过微工具条“换色”
  await editor().getByRole('button', { name: '选择导线 1', exact: true }).click()
  const bHandle = (await projectedEndpointHandles()).find((h) => h.end === 'b')
  const canvasBox = await viewport().locator('canvas').boundingBox()
  if (!bHandle || !canvasBox) throw new Error('Missing projected endpoint B handle')
  await page.mouse.click(canvasBox.x + bHandle.x * canvasBox.width, canvasBox.y + bHandle.y * canvasBox.height)
  await expect(viewport()).toHaveAttribute('data-pending-rewire', /:b$/)
  await viewport().locator('[data-quick-target-jack="ins-dc-voltmeter.NEG"]').click()
  await expect.poll(async () => (await wireEndpoints())[0]?.b).toBe('ins-dc-voltmeter.NEG')
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await wireEndpoints())[0]?.b).toBe('ins-dc-voltmeter.POS')

  await editor().getByRole('button', { name: '选择导线 1', exact: true }).click()
  await microToolbar.getByRole('button', { name: '更换导线颜色', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '绿色', exact: true }).click()
  await expect(editor().locator('li[data-wire-color="green"]')).toHaveCount(1)

  // 2. 3D 旋钮零滚轮冲突：悬停旋钮滚轮只缩放镜头不改数值；单击旋钮弹出就地微调浮窗并同步 2D 面板
  await focusDevice(page, 'ins-dc-power')
  const dcPanel = await openInstrumentPanel(page, '直流稳压电源')
  const ch1Input = dcPanel.getByRole('spinbutton', { name: 'CH1 电压精确值', exact: true })
  await expect(ch1Input).toHaveValue('6')

  await expect
    .poll(async () => (await projectedInstrumentControls()).find((item) => item.id === 'ins-dc-power.CH1_V')?.visible)
    .toBe(true)
  const readKnobScreen = async () => {
    const knob = (await projectedInstrumentControls()).find((item) => item.id === 'ins-dc-power.CH1_V')
    const box = await viewport().locator('canvas').boundingBox()
    if (!knob || !box) throw new Error('Missing 3D knob target for ins-dc-power.CH1_V')
    return { x: box.x + knob.x * box.width, y: box.y + knob.y * box.height }
  }
  const knobPos = await readKnobScreen()
  const camBefore = await viewport().getAttribute('data-camera-position')
  await page.mouse.move(knobPos.x, knobPos.y)
  await expect(page.locator('[data-instrument-control-tip="ins-dc-power.CH1_V"]')).toBeVisible()
  await page.mouse.wheel(0, -180)
  await expect.poll(() => viewport().getAttribute('data-camera-position')).not.toBe(camBefore)
  // 滚轮缩放相机后电压保持 6 V 不被误调
  await expect(ch1Input).toHaveValue('6')

  // 重新居中特写并单击旋钮弹出微调浮窗
  await focusDevice(page, 'ins-dc-power')
  const knobClickPos = await readKnobScreen()
  await page.mouse.click(knobClickPos.x, knobClickPos.y)
  const popover = page.locator('[data-knob-popover="ins-dc-power.CH1_V"]')
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: '增大 CH1 电压', exact: true }).click()
  await expect(ch1Input).toHaveValue('6.1')
  // 浮窗内滚轮微调
  const popBox = await popover.boundingBox()
  if (!popBox) throw new Error('Popover missing bounding box')
  await page.mouse.move(popBox.x + popBox.width / 2, popBox.y + popBox.height / 2)
  await page.mouse.wheel(0, -120)
  await expect(ch1Input).toHaveValue('6.2')
  await popover.getByRole('button', { name: '12 V', exact: true }).click()
  await expect(ch1Input).toHaveValue('12')
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()

  // 3. 切至 DG-05 验证 B3 原理图两点直连（侧栏 + 放大 Dialog）、可搜索选孔与 B4 定位闭环
  await page.evaluate(() => {
    location.hash = '#/practice/DG-05'
  })
  await expect(page.getByRole('banner').getByRole('heading')).toContainText('DG-05 ')
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

  // B4 引导模式步骤定位（绝不自动接线），切换自主模式彻底隐藏
  await page.getByRole('tab', { name: '步骤', exact: true }).click()
  await steps().getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expect(steps()).toHaveAttribute('data-current-step', 'wire')
  const stepLocate = steps().locator('[data-step-locate-list]')
  await expect(stepLocate).toBeVisible()
  await stepLocate.locator('[data-step-locate-btn]').first().click()
  await expect(viewport()).toHaveAttribute('data-pulsing-jack', /.+/)
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')

  await page.getByRole('button', { name: '切换引导或自主模式', exact: true }).click()
  await expect(steps().locator('[data-step-locate-list]')).toHaveCount(0)
  await page.getByRole('button', { name: '切换引导或自主模式', exact: true }).click()

  // B3 原理图两点直连（侧栏视图 + 放大 Dialog 视图均支持）
  await page.getByRole('tab', { name: '原理图', exact: true }).click()
  const schematicRegion = page.getByRole('region', { name: '交互式原理图', exact: true })
  const u1pNode = schematicRegion.locator('[data-linked-jack="dc1.KH_U1P"]').first()
  const u2pNode = schematicRegion.locator('[data-linked-jack="dc1.KH_U2P"]').first()
  await u1pNode.click()
  await expect(u1pNode).toHaveAttribute('data-schematic-pending', 'true')
  await expect(viewport()).toHaveAttribute('data-pending-jack', 'dc1.KH_U1P')
  await u2pNode.click()
  await expect(viewport()).toHaveAttribute('data-wire-count', '1')
  await expect(viewport()).toHaveAttribute('data-pending-jack', '')

  await page.getByRole('button', { name: '放大原理图', exact: true }).click()
  const schematicDialog = page.getByRole('dialog')
  await expect(schematicDialog).toBeVisible()
  await schematicDialog.locator('[data-linked-jack="dc1.KH_U1N"]').first().click()
  await schematicDialog.locator('[data-linked-jack="dc1.KH_U2N"]').first().click()
  await page.keyboard.press('Escape')
  await expect(schematicDialog).toBeHidden()
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')

  // 4. 右侧可模糊搜索选孔（Command Combobox）
  await selectJackFromList(page, '接线起点', 'dc1.KH_A')
  await expect(editor().getByRole('combobox', { name: '接线起点', exact: true })).toHaveAttribute(
    'data-selected-jack',
    'dc1.KH_A',
  )

  // 5. B4 结构化可定位接线诊断：点击检查接线，核对结构化列表、悬停高亮单对与点击[定位]
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  const diagList = editor().locator('[data-diagnostic-list]')
  await expect(diagList).toBeVisible()
  const firstIssue = diagList.locator('[data-diagnostic-issue]').first()
  await expect(firstIssue).toBeVisible()
  await firstIssue.hover()
  await expect(viewport()).toHaveAttribute('data-diagnostic-guide-link', /.+:.+/)
  await firstIssue.locator('[data-locate-issue="0"]').click()
  await expect(viewport()).toHaveAttribute('data-pulsing-jack', /.+/)
  // 点击定位绝不替学员自动接线
  await expect(viewport()).toHaveAttribute('data-wire-count', '2')
})

test('T1.9B B1/B4 1366×768 常规/双预设与 1.25× 演示模式、宽屏仪器面板与文案净化截图验收', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setMinimumSize(320, 240)
    win?.setContentSize(1366, 768)
    win?.webContents.setZoomFactor(1)
  })
  await page.evaluate(() => {
    location.hash = '#/practice/DG-19'
  })
  await expect(cabinet().getByRole('button', { name: '放置 双通道数字示波器', exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await page.waitForFunction(() => Math.abs(window.innerWidth - 1366) <= 2 && Math.abs(window.innerHeight - 768) <= 2)

  // 1. 仪表柜一键上台：已放置列表仅展示中文槽位名，不向用户裸露 SLOT_* 英文标识
  await cabinet().getByRole('button', { name: '放置 双通道函数信号发生器', exact: true }).click()
  await expect(cabinet()).toHaveAttribute('data-placed-count', '1')
  const genPlaced = cabinet().locator('[data-placed-instrument="generator1"]')
  await expect(genPlaced).toContainText('台面左位')
  await expect(genPlaced).not.toContainText('SLOT_')
  await expect(genPlaced).toHaveAttribute('data-slot-id', 'SLOT_DESK_1')

  await cabinet().getByRole('button', { name: '放置 双通道数字示波器', exact: true }).click()
  await expect(cabinet()).toHaveAttribute('data-placed-count', '2')
  const scopePlaced = cabinet().locator('[data-placed-instrument="scope1"]')
  await expect(scopePlaced).toContainText('示波器位')
  await expect(scopePlaced).not.toContainText('SLOT_')
  await expect(scopePlaced).toHaveAttribute('data-slot-id', 'SLOT_SCOPE')
  await expect(viewport()).toHaveAttribute('data-wire-count', '0')

  // 2. 示波器宽屏主视图：左屏右控、无双轴滚动、无页面溢出
  const scopePanel = await openInstrumentPanel(page, '双通道数字示波器')
  const screenPaneBox = await scopePanel.locator('[data-scope-screen-pane]').boundingBox()
  const ch1SectionBox = await scopePanel.getByRole('region', { name: 'CH1 垂直', exact: true }).boundingBox()
  expect(screenPaneBox && ch1SectionBox && screenPaneBox.x + screenPaneBox.width <= ch1SectionBox.x + 2).toBe(true)

  // 3. 接线实测 1 kHz / 4 Vpp 正弦波与自动设置
  const genPanel = await openInstrumentPanel(page, '双通道函数信号发生器')
  await genPanel
    .getByRole('group', { name: 'CH1 常用频率预设', exact: true })
    .getByRole('button', { name: '1 kHz', exact: true })
    .click()
  const ampInput = genPanel.getByRole('spinbutton', { name: 'CH1 幅值精确值', exact: true })
  await ampInput.fill('4')
  await ampInput.press('Enter')

  await openInstrumentPanel(page, '双通道数字示波器')
  await scopePanel.getByRole('combobox', { name: 'CH1 V/div', exact: true }).click()
  await page.getByRole('option', { name: '5 V/div', exact: true }).click()
  await scopePanel.getByRole('combobox', { name: '时基 s/div', exact: true }).click()
  await page.getByRole('option', { name: '10 ms/div', exact: true }).click()

  await addInstrumentWireFromList(page, 'generator1.CH1', 'scope1.CH1')
  await addInstrumentWireFromList(page, 'generator1.GND', 'scope1.GND')
  await page.getByRole('button', { name: '上电', exact: true }).click()

  await expect
    .poll(
      async () => {
        const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
        if (!raw) return false
        const parsed = JSON.parse(raw) as { channels?: Array<{ vpp: number | null }> }
        return (parsed.channels?.[0]?.vpp ?? 0) > 3.5
      },
      { timeout: 15_000 },
    )
    .toBe(true)

  await scopePanel.getByRole('button', { name: '自动设置', exact: true }).click()
  await expect(scopePanel.getByRole('combobox', { name: 'CH1 V/div', exact: true })).toContainText('1 V/div')
  await expect(scopePanel.getByRole('combobox', { name: '时基 s/div', exact: true })).toContainText('200 μs/div')

  // 4. 1366×768 常规单主表态截图验收
  await expectNoDocumentOverflow('1366x768-default')
  await expectNoDualAxisDockScroll('1366x768-default')
  await page.screenshot({ path: resolve('build/t19b-1366x768-default.png') })

  // 5. 1366×768 接线专注态截图验收
  await page.locator('[data-stage-preset="wiring"]').click()
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false')
  await expectNoDocumentOverflow('1366x768-wiring')
  await page.screenshot({ path: resolve('build/t19b-1366x768-wiring.png') })

  // 6. 1366×768 调测专注 + 双表对比态截图验收
  await page.locator('[data-stage-preset="debug"]').click()
  await enableDualInstrumentDock(page)
  await expectNoDocumentOverflow('1366x768-debug-dual')
  await expectNoDualAxisDockScroll('1366x768-debug-dual')
  await page.screenshot({ path: resolve('build/t19b-1366x768-debug-dual.png') })

  // 7. 1366×768 + 1.25× 演示模式截图验收（顶栏最右图标、左栏步骤页签与底栏主表零截断、无溢出）
  await page.locator('[data-dock-mode="single"]').click()
  await page.getByRole('button', { name: '切换演示模式', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-presentation-mode', 'on')
  // 演示模式默认收起右栏与底栏聚焦大屏，手动展开底栏核验 1.25× 下主表也无截断或双轴滚动
  await page.getByRole('button', { name: '显示/收起底栏', exact: true }).click()
  await expect
    .poll(async () => (await page.locator('[data-slot="resizable-panel"]#bottom').boundingBox())?.height ?? 0)
    .toBeGreaterThan(150)
  await expectNoDocumentOverflow('1366x768-125x')
  await expectNoDualAxisDockScroll('1366x768-125x')
  const rightToggleBox = await page.getByRole('button', { name: '显示/收起右栏', exact: true }).boundingBox()
  expect(rightToggleBox && rightToggleBox.x + rightToggleBox.width <= 1366).toBe(true)
  const stepsTabBox = await page.getByRole('tab', { name: '步骤', exact: true }).boundingBox()
  const leftPanelBox = await page.locator('[data-slot="resizable-panel"]#left').boundingBox()
  expect(
    stepsTabBox && leftPanelBox && stepsTabBox.x + stepsTabBox.width <= leftPanelBox.x + leftPanelBox.width + 1,
  ).toBe(true)
  await page.screenshot({ path: resolve('build/t19b-1366x768-125x.png') })

  await page.getByRole('button', { name: '切换演示模式', exact: true }).click()
  await page.getByRole('button', { name: '断电', exact: true }).click()
})
