import { copyFileSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

// T1.11 端到端全流程验收与录屏：DG-12、MD-07、SD-10 三个 M1 代表项目。

const RECORDING_DIR = resolve('build/t111-recordings')

type ScreenReadings = Record<string, { text?: string; status?: string; mode?: string; unit?: string }>

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const editor = (page: Page) => page.getByRole('region', { name: '接线编辑', exact: true })
const stepsPanel = (page: Page) => page.getByRole('region', { name: '实训步骤', exact: true })
const dataPanel = (page: Page) => page.getByRole('region', { name: '实训数据记录', exact: true })
const chartsPanel = (page: Page) => page.getByRole('region', { name: '实训特性曲线', exact: true })
const panel = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const faultPanel = (page: Page) => panel(page, '故障排查')
const moduleControls = (page: Page) => panel(page, '模块控件')

async function launchRecordedProject(projectId: string, headingPrefix: string) {
  mkdirSync(RECORDING_DIR, { recursive: true })
  const errors: string[] = []
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), `virtual-t111-${projectId.toLowerCase()}-`)) },
    recordVideo: { dir: RECORDING_DIR, size: { width: 1366, height: 768 } },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  const video = page.video()
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setMinimumSize(320, 240)
    win?.setContentSize(1366, 768)
    win?.webContents.setZoomFactor(1)
  })
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate((id) => {
    window.location.hash = `#/practice/${id}`
  }, projectId)
  await expect(page.getByRole('banner').getByRole('heading')).toContainText(headingPrefix, { timeout: 20_000 })
  await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport(page)).toHaveAttribute('data-camera-moving', 'false', { timeout: 15_000 })
  return { app, page, video, errors }
}

async function finalizeVideo(
  app: ElectronApplication | undefined,
  video: ReturnType<Page['video']>,
  targetFileName: string,
  attachmentName: string,
) {
  await app?.close()
  if (video) {
    const rawPath = await video.path()
    const finalPath = resolve('build', targetFileName)
    copyFileSync(rawPath, finalPath)
    expect(statSync(finalPath).size, `${targetFileName} contains valid webm frames`).toBeGreaterThan(10_000)
    await test.info().attach(attachmentName, { path: finalPath, contentType: 'video/webm' })
  }
}

async function showTab(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

async function selectOption(page: Page, container: ReturnType<typeof panel>, label: string, optionName: string) {
  const trigger = container.getByRole('combobox', { name: label, exact: true })
  await page.mouse.move(0, 0)
  const selectedValue = trigger.locator('[data-slot="select-value"]')
  await expect(selectedValue).toBeVisible()
  const selectedName = ((await selectedValue.textContent()) ?? '').trim()
  if (selectedName === optionName) return
  await trigger.press('Enter')
  await expect(page.getByRole('option', { name: selectedName, exact: true })).toBeFocused()
  const option = page.getByRole('option', { name: optionName, exact: true })
  await expect(option).toBeVisible()
  await option.focus()
  await expect(option).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toContainText(optionName)
  await expect(trigger).toBeFocused()
}

async function addWire(page: Page, a: string, b: string) {
  await showTab(page, '接线')
  const before = Number(await editor(page).getAttribute('data-wire-count'))
  await addInstrumentWireFromList(page, a, b)
  await expect(editor(page)).toHaveAttribute('data-wire-count', String(before + 1))
}

async function powerOn(page: Page) {
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await expect(page.getByRole('button', { name: '断电', exact: true })).toBeVisible()
}

async function powerOff(page: Page) {
  const btn = page.getByRole('button', { name: '断电', exact: true })
  if (await btn.count()) await btn.click()
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
}

async function readScreenReadings(page: Page): Promise<ScreenReadings> {
  const raw = await viewport(page).getAttribute('data-instrument-screen-readings')
  return raw ? (JSON.parse(raw) as ScreenReadings) : {}
}

async function readNumericScreen(page: Page, key: string): Promise<number | null> {
  const entry = (await readScreenReadings(page))[key]
  if (entry?.status !== 'ok' || !entry.text) return null
  const num = Number(entry.text)
  return Number.isFinite(num) ? num : null
}

async function verifyGuideAndSchematic(page: Page, projectId: string) {
  const guide = page.getByRole('tabpanel', { name: '实训指导', exact: true })
  for (const heading of ['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题']) {
    await expect(guide.getByRole('heading', { name: heading, exact: true })).toHaveCount(1)
  }
  await showTab(page, '原理图')
  const schematic = page.getByRole('img', { name: `${projectId} 原理图`, exact: true })
  await expect(schematic).toBeVisible()
  await expect
    .poll(() =>
      schematic.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0),
    )
    .toBe(true)
}

async function cellNumber(page: Page, tableId: string, row: number, colId: string): Promise<number> {
  const input = dataPanel(page).locator(
    `input[data-table-id="${tableId}"][data-row-index="${row}"][data-column-id="${colId}"]`,
  )
  const raw = await input.inputValue()
  expect(raw, `${tableId}[${row}].${colId} should be populated`).not.toBe('')
  const num = Number(raw)
  expect(Number.isFinite(num)).toBe(true)
  return num
}

test.setTimeout(180_000)

test('T1.11 DG-12 交流电路功率因数提高全流程（五档电容实时切换、数据表与双曲线渲染）', async () => {
  const { app, page, video, errors } = await launchRecordedProject('DG-12', 'DG-12 交流电路功率及功率因数的测量')
  try {
    await verifyGuideAndSchematic(page, 'DG-12')

    // 确认三相调压交流电源已自动置入底栏主电源并默认 220 V
    const acPsu = await openInstrumentPanel(page, '三相调压交流电源')
    await expect(acPsu.getByRole('spinbutton', { name: '相电压调压精确值', exact: true })).toHaveValue('220')

    // 完成 prepare 步骤
    await showTab(page, '步骤')
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'prepare')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'wire')

    // 按参考接线连接三相电源 U/N、电容支路、交流电流表、单相功率表、交流电压表
    const dg12Wires: [string, string][] = [
      ['ins-ac-power.U', 'ac1.AC_L'],
      ['ins-ac-power.N', 'ac1.AC_N'],
      ['ac1.LOAD_IN', 'ac1.CAP_IN'],
      ['ins-ac-ammeter.I', 'ac1.I_LINE_A'],
      ['ins-ac-ammeter.STAR', 'ac1.I_LINE_B'],
      ['ins-power-meter.I', 'ac1.I_TOT_A'],
      ['ins-power-meter.I_STAR', 'ac1.I_TOT_B'],
      ['ins-power-meter.U', 'ac1.LOAD_IN'],
      ['ins-power-meter.U_STAR', 'ac1.AC_N'],
      ['ins-ac-voltmeter.U', 'ac1.LOAD_IN'],
      ['ins-ac-voltmeter.STAR', 'ac1.AC_N'],
    ]
    for (const [a, b] of dg12Wires) await addWire(page, a, b)

    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(editor(page).getByRole('status')).toContainText('电路拓扑连接正确')
    await showTab(page, '步骤')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'c0')

    // 上电，带电实时切换 5 组补偿电容并逐行记录数据
    await powerOn(page)

    const stages: {
      row: number
      stepId: string
      nextStep: string
      cUf: string
      kc1: '断开' | '投入 1 µF'
      kc2: '断开' | '投入 2.2 µF'
      kc3: '断开' | '投入 4.7 µF'
      iMin: number
      iMax: number
      pfMin: number
      pfMax: number
    }[] = [
      {
        row: 0,
        stepId: 'c0',
        nextStep: 'c22',
        cUf: '0',
        kc1: '断开',
        kc2: '断开',
        kc3: '断开',
        iMin: 0.35,
        iMax: 0.385,
        pfMin: 0.48,
        pfMax: 0.52,
      },
      {
        row: 1,
        stepId: 'c22',
        nextStep: 'c32',
        cUf: '2.2',
        kc1: '断开',
        kc2: '投入 2.2 µF',
        kc3: '断开',
        iMin: 0.235,
        iMax: 0.26,
        pfMin: 0.72,
        pfMax: 0.76,
      },
      {
        row: 2,
        stepId: 'c32',
        nextStep: 'c47',
        cUf: '3.2',
        kc1: '投入 1 µF',
        kc2: '投入 2.2 µF',
        kc3: '断开',
        iMin: 0.195,
        iMax: 0.22,
        pfMin: 0.86,
        pfMax: 0.91,
      },
      {
        row: 3,
        stepId: 'c47',
        nextStep: 'c79',
        cUf: '4.7',
        kc1: '断开',
        kc2: '断开',
        kc3: '投入 4.7 µF',
        iMin: 0.175,
        iMax: 0.195,
        pfMin: 0.98,
        pfMax: 1.0,
      },
      {
        row: 4,
        stepId: 'c79',
        nextStep: 'analyse',
        cUf: '7.9',
        kc1: '投入 1 µF',
        kc2: '投入 2.2 µF',
        kc3: '投入 4.7 µF',
        iMin: 0.28,
        iMax: 0.308,
        pfMin: 0.61,
        pfMax: 0.65,
      },
    ]

    for (const s of stages) {
      if (s.row > 0) {
        await showTab(page, '模块控件')
        await selectOption(page, moduleControls(page), '补偿电容 C1（1 µF）', s.kc1)
        await selectOption(page, moduleControls(page), '补偿电容 C2（2.2 µF）', s.kc2)
        await selectOption(page, moduleControls(page), '补偿电容 C3（4.7 µF）', s.kc3)
      }

      // 等待工频 RMS 与功率窗口在切换后收敛至新稳态
      await expect
        .poll(
          async () => {
            const u = await readNumericScreen(page, 'ins-ac-voltmeter.MAIN')
            const i = await readNumericScreen(page, 'ins-ac-ammeter.MAIN')
            const p = await readNumericScreen(page, 'ins-power-meter.MAIN')
            return (
              u !== null &&
              u > 215 &&
              u < 225 &&
              i !== null &&
              i >= s.iMin &&
              i <= s.iMax &&
              p !== null &&
              p > 38 &&
              p < 43
            )
          },
          { timeout: 25_000, message: `DG-12 stage ${s.stepId} steady AC/power reading` },
        )
        .toBe(true)

      await showTab(page, '数据记录')
      await selectOption(page, dataPanel(page), '记录行', `第 ${s.row + 1} 行`)
      const capInput = dataPanel(page).locator(
        `input[data-table-id="compensation"][data-row-index="${s.row}"][data-column-id="c_uf"]`,
      )
      await capInput.fill(s.cUf)
      await capInput.press('Enter')
      await dataPanel(page).getByRole('button', { name: '记录当前行读数', exact: true }).click()

      await showTab(page, '步骤')
      await expect(stepsPanel(page)).toHaveAttribute('data-current-step', s.nextStep, { timeout: 10_000 })

      await showTab(page, '数据记录')
      const uRec = await cellNumber(page, 'compensation', s.row, 'u_load')
      const iRec = await cellNumber(page, 'compensation', s.row, 'i_line')
      const pRec = await cellNumber(page, 'compensation', s.row, 'p_active')
      const qRec = await cellNumber(page, 'compensation', s.row, 'q_reactive')
      const pfRec = await cellNumber(page, 'compensation', s.row, 'pf')
      const sRec = await cellNumber(page, 'compensation', s.row, 's_calc')
      expect(uRec).toBeGreaterThan(216)
      expect(uRec).toBeLessThan(224)
      expect(iRec).toBeGreaterThanOrEqual(s.iMin)
      expect(iRec).toBeLessThanOrEqual(s.iMax)
      expect(pRec).toBeGreaterThan(39)
      expect(pRec).toBeLessThan(42)
      expect(pfRec).toBeGreaterThanOrEqual(s.pfMin)
      expect(pfRec).toBeLessThanOrEqual(s.pfMax)
      expect(sRec).toBeCloseTo(uRec * iRec, 1)
      if (s.row === 0) expect(qRec).toBeGreaterThan(60)
      if (s.row === 4) expect(qRec).toBeLessThan(-42)
    }

    // 验证底栏“曲线”标签页正确渲染 cosφ-C 与 I-C 两条 5 点特性曲线
    await showTab(page, '曲线')
    for (const chartId of ['pf-curve', 'current-curve']) {
      const card = chartsPanel(page).locator(`[data-chart-card="${chartId}"]`)
      await expect(card).toBeVisible()
      await expect(card).toHaveAttribute('data-chart-points', '5')
      await expect(card.locator('[data-slot="chart"] svg.recharts-surface')).toBeVisible()
      await expect(card.locator('.recharts-line-curve')).toHaveCount(1)
    }

    // 断电并完成最终分析步骤
    await powerOff(page)
    await showTab(page, '步骤')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-completed-count', '8')
    expect(errors).toEqual([])
  } finally {
    await finalizeVideo(app, video, 't111-dg12-workflow.webm', 'T1.11 DG-12 全流程录屏')
  }
})

test('T1.11 MD-07 三极管放大电路故障排除全流程（接线、排故六步闭环与恢复验证）', async () => {
  const { app, page, video, errors } = await launchRecordedProject('MD-07', 'MD-07 三极管放大电路故障排除')
  try {
    await verifyGuideAndSchematic(page, 'MD-07')

    // 1. 设电源 12 V 并连接放大电路与直流电压表（监测 UC）
    const dcPsu = await openInstrumentPanel(page, '直流稳压电源')
    const ch1Input = dcPsu.getByRole('spinbutton', { name: 'CH1 电压精确值', exact: true })
    await ch1Input.fill('12')
    await ch1Input.press('Enter')

    await addWire(page, 'ins-dc-power.CH1P', 'amp1.AMP_VCC')
    await addWire(page, 'ins-dc-power.CH1N', 'amp1.AMP_GND1')
    await addWire(page, 'ins-dc-voltmeter.POS', 'amp1.AMP_UC')
    await addWire(page, 'ins-dc-voltmeter.NEG', 'amp1.AMP_GND1')

    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(editor(page).getByRole('status')).toContainText('电路拓扑连接正确')
    await showTab(page, '步骤')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'draw-fault')

    // 2. 进入排故面板完成两道代表性故障（f-rb1-open 开路 + f-vt1-dead 元件损坏）
    await showTab(page, '排故')
    await expect(faultPanel(page)).toBeVisible()
    await expect(faultPanel(page).locator('[data-fault-progress]')).toHaveText('已排故 0/6')

    // 故障 1：f-rb1-open（三极管截止 UC≈12 V）
    await faultPanel(page).getByRole('button', { name: '开始排故', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-injected-fault', 'f-rb1-open')

    await showTab(page, '步骤')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'measure-locate')

    await powerOn(page)
    await expect
      .poll(async () => {
        const uc = await readNumericScreen(page, 'ins-dc-voltmeter.MAIN')
        return uc !== null && uc > 11.8
      })
      .toBe(true)

    // 在排故面板完成观察→测量→判定→断电修复→上电验证结项
    await faultPanel(page).getByRole('button', { name: '确认异常现象', exact: true }).click()
    await faultPanel(page).getByRole('button', { name: '记录排故测量（当前仪表读数）', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-measurement-count', '1')

    // 同时将故障态 UC 记入数据表并推进 measure-locate 步骤
    await showTab(page, '数据记录')
    await dataPanel(page).getByRole('button', { name: '记录当前行读数', exact: true }).click()
    expect(await cellNumber(page, 'fault_points', 0, 'uc')).toBeGreaterThan(11.8)
    await showTab(page, '步骤')
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'repair-verify')

    await selectOption(page, faultPanel(page), '疑似故障元件', 'amp1.RB1')
    await selectOption(page, faultPanel(page), '疑似故障类型', '开路（断线/虚焊）')
    await faultPanel(page).getByRole('button', { name: '提交故障判定', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'repair')

    await powerOff(page)
    await faultPanel(page).getByRole('button', { name: '更换元件/修复', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'verify')

    await powerOn(page)
    await expect
      .poll(async () => {
        const uc = await readNumericScreen(page, 'ins-dc-voltmeter.MAIN')
        return uc !== null && uc >= 5.5 && uc <= 6.2
      })
      .toBe(true)
    await faultPanel(page).getByRole('button', { name: '上电验证并结项', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-resolved-count', '1')

    // 记录修复后正常 UC（第 2 行）并完成 repair-verify 步骤
    await showTab(page, '数据记录')
    await selectOption(page, dataPanel(page), '记录行', '第 2 行')
    await dataPanel(page).getByRole('button', { name: '记录当前行读数', exact: true }).click()
    const restoredUc = await cellNumber(page, 'fault_points', 1, 'uc')
    expect(restoredUc).toBeGreaterThan(5.5)
    expect(restoredUc).toBeLessThan(6.2)
    await showTab(page, '步骤')
    await expect(stepsPanel(page)).toHaveAttribute('data-completed-count', '4')

    // 故障 2：f-vt1-dead（三极管 C-E 击穿 UC≈3.53 V）
    await powerOff(page)
    await selectOption(page, faultPanel(page), '预设故障题目', '故障 #5（f-vt1-dead）')
    await faultPanel(page).getByRole('button', { name: '注入所选故障', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-injected-fault', 'f-vt1-dead')

    await powerOn(page)
    await expect
      .poll(async () => {
        const uc = await readNumericScreen(page, 'ins-dc-voltmeter.MAIN')
        return uc !== null && uc > 3.2 && uc < 3.9
      })
      .toBe(true)
    await faultPanel(page).getByRole('button', { name: '记录排故测量', exact: true }).click()
    await selectOption(page, faultPanel(page), '疑似故障元件', 'amp1.QVT1')
    await selectOption(page, faultPanel(page), '疑似故障类型', '元件损坏')
    await faultPanel(page).getByRole('button', { name: '提交故障判定', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'repair')

    await powerOff(page)
    await faultPanel(page).getByRole('button', { name: '更换元件/修复', exact: true }).click()
    await powerOn(page)
    await expect
      .poll(async () => {
        const uc = await readNumericScreen(page, 'ins-dc-voltmeter.MAIN')
        return uc !== null && uc >= 5.5 && uc <= 6.2
      })
      .toBe(true)
    await faultPanel(page).getByRole('button', { name: '上电验证并结项', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-resolved-count', '2')

    await powerOff(page)
    expect(errors).toEqual([])
  } finally {
    await finalizeVideo(app, video, 't111-md07-workflow.webm', 'T1.11 MD-07 全流程录屏')
  }
})

test('T1.11 SD-10 二位十进制计数/译码/驱动/显示全流程（00→10+实时级联计数、清零与示波器十分频测量）', async () => {
  const { app, page, video, errors } = await launchRecordedProject('SD-10', 'SD-10 二位十进制计数/译码/驱动/显示电路')
  try {
    await verifyGuideAndSchematic(page, 'SD-10')

    // 1. 完成 prepare 步骤并按 8421 BCD 级联连接全部 18 条导线（含 +5V 电压监测）
    await showTab(page, '步骤')
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'prepare')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'wire')

    const sd10Wires: [string, string][] = [
      ['ins-dc-power.V5P', 'dig1.VCC'],
      ['ins-dc-power.V5N', 'dig1.GND'],
      ['dig1.CLK_OUT', 'dig1.U1_CP0'],
      ['dig1.U1_Q0', 'dig1.U1_CP1'],
      ['dig1.U1_Q0', 'dig1.D1_A'],
      ['dig1.U1_Q1', 'dig1.D1_B'],
      ['dig1.U1_Q2', 'dig1.D1_C'],
      ['dig1.U1_Q3', 'dig1.U2_CP0'],
      ['dig1.U1_Q3', 'dig1.D1_D'],
      ['dig1.U2_Q0', 'dig1.U2_CP1'],
      ['dig1.U2_Q0', 'dig1.D2_A'],
      ['dig1.U2_Q1', 'dig1.D2_B'],
      ['dig1.U2_Q2', 'dig1.D2_C'],
      ['dig1.U2_Q3', 'dig1.D2_D'],
      ['dig1.RST_OUT', 'dig1.U1_R0'],
      ['dig1.RST_OUT', 'dig1.U2_R0'],
      ['ins-dc-voltmeter.POS', 'dig1.VCC'],
      ['ins-dc-voltmeter.NEG', 'dig1.GND'],
    ]
    for (const [a, b] of sd10Wires) await addWire(page, a, b)

    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(editor(page).getByRole('status')).toContainText('电路拓扑连接正确')
    await showTab(page, '步骤')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'supply')

    // 2. 上电确认 VCC ≈ 5.0 V 并记录 vcc
    await powerOn(page)
    await expect
      .poll(async () => {
        const v = await readNumericScreen(page, 'ins-dc-voltmeter.MAIN')
        return v !== null && v > 4.8 && v < 5.2
      })
      .toBe(true)
    await page.getByRole('button', { name: '记录读数', exact: true }).click()
    await showTab(page, '步骤')
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'count-cascade')

    // 3. 切至 10 Hz 实时观察 2D/3D 数码管连续递增跨十位进位（00 → ... → 09 → 10+）
    await showTab(page, '模块控件')
    await selectOption(page, moduleControls(page), '连续脉冲频率', '10 Hz')
    const segGroup = moduleControls(page).locator('[data-module-segment7-group="dig1"]')
    await expect(segGroup).toBeVisible()

    await expect
      .poll(
        async () => {
          const val = (await segGroup.getAttribute('data-segment7-value')) ?? ''
          const screens = await readScreenReadings(page)
          const tens = screens['dig1.DISP_TENS']?.text ?? ''
          const ones = screens['dig1.DISP_ONES']?.text ?? ''
          return /^\d\d$/.test(val) && Number(val) >= 10 && `${tens}${ones}` === val
        },
        { timeout: 20_000, message: 'SD-10 two-digit segment7 display cascades across 09 -> 10' },
      )
      .toBe(true)

    // 4. 运行中拨动清零开关 R0 -> 清零 (1) 验证立即归零 00，再拨回计数 (0) 恢复递增
    await selectOption(page, moduleControls(page), '清零开关 R0', '清零 (1)')
    await expect(segGroup).toHaveAttribute('data-segment7-value', '00', { timeout: 10_000 })
    await expect
      .poll(async () => {
        const s = await readScreenReadings(page)
        return `${s['dig1.DISP_TENS']?.text ?? ''}${s['dig1.DISP_ONES']?.text ?? ''}`
      })
      .toBe('00')

    await selectOption(page, moduleControls(page), '清零开关 R0', '计数 (0)')
    await expect
      .poll(
        async () => {
          const val = (await segGroup.getAttribute('data-segment7-value')) ?? ''
          return /^\d\d$/.test(val) && Number(val) >= 2
        },
        { timeout: 10_000, message: 'SD-10 resumes counting after releasing R0' },
      )
      .toBe(true)

    await showTab(page, '步骤')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-current-step', 'verify-divide')

    // 5. 断电拖入双通道数字示波器测 U1_CP0 (10 Hz) 与 U1_Q3 (1 Hz)，验证十分频比 ≈ 10
    await powerOff(page)
    await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
    await addWire(page, 'scope1.CH1', 'dig1.U1_CP0')
    await addWire(page, 'scope1.CH2', 'dig1.U1_Q3')
    await addWire(page, 'scope1.GND', 'dig1.GND')

    const scopePanel = await openInstrumentPanel(page, '双通道数字示波器')
    // 关闭示波器内置 1 kHz 信号源以保持 500 µs 高效数字仿真步长
    const outOnBtn = scopePanel.getByRole('button', { name: '输出开', exact: true })
    if (await outOnBtn.count()) await outOnBtn.click()
    await selectOption(page, scopePanel, '时基 s/div', '500 ms/div')
    await selectOption(page, scopePanel, 'CH1 V/div', '2 V/div')
    await selectOption(page, scopePanel, 'CH2 V/div', '2 V/div')

    await powerOn(page)
    // 等待至少 3.1 s 实时推进以捕获 ≥2 个 U1_Q3（1 Hz）完整周期，使 f_clk 与 f_carry 均就绪
    await expect
      .poll(
        async () => {
          const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
          if (!raw) return false
          const parsed = JSON.parse(raw) as {
            channels: { id: string; frequency: number | null; completeCycles?: number }[]
          }
          const ch1 = parsed.channels.find((c) => c.id === 'CH1')
          const ch2 = parsed.channels.find((c) => c.id === 'CH2')
          return (
            typeof ch1?.frequency === 'number' &&
            ch1.frequency >= 9.5 &&
            ch1.frequency <= 10.5 &&
            typeof ch2?.frequency === 'number' &&
            ch2.frequency >= 0.95 &&
            ch2.frequency <= 1.05
          )
        },
        { timeout: 25_000, message: 'SD-10 scope captures 10 Hz clock and 1 Hz carry' },
      )
      .toBe(true)

    // 留出余量确保至少 3 个上升沿（2 个完整周期）进入环形缓冲后记录读数
    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: '记录读数', exact: true }).click()
          return (await stepsPanel(page).getAttribute('data-current-step')) === 'reset-analyse'
        },
        { timeout: 15_000, intervals: [500, 1000, 1000] },
      )
      .toBe(true)

    await showTab(page, '数据记录')
    const vcc = await cellNumber(page, 'counter_check', 0, 'vcc')
    const fClk = await cellNumber(page, 'counter_check', 0, 'f_clk')
    const fCarry = await cellNumber(page, 'counter_check', 0, 'f_carry')
    const divRatio = await cellNumber(page, 'counter_check', 0, 'div_ratio')
    expect(vcc).toBeGreaterThan(4.8)
    expect(vcc).toBeLessThan(5.2)
    expect(fClk).toBeGreaterThanOrEqual(9.5)
    expect(fClk).toBeLessThanOrEqual(10.5)
    expect(fCarry).toBeGreaterThanOrEqual(0.95)
    expect(fCarry).toBeLessThanOrEqual(1.05)
    expect(divRatio).toBeGreaterThanOrEqual(9.5)
    expect(divRatio).toBeLessThanOrEqual(10.5)

    // 6. 断电并完成最终步骤
    await powerOff(page)
    await showTab(page, '步骤')
    await stepsPanel(page).getByRole('button', { name: '完成当前步骤', exact: true }).click()
    await expect(stepsPanel(page)).toHaveAttribute('data-completed-count', '6')
    expect(errors).toEqual([])
  } finally {
    await finalizeVideo(app, video, 't111-sd10-workflow.webm', 'T1.11 SD-10 全流程录屏')
  }
})
