import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const stepsPanel = (page: Page) => page.getByRole('region', { name: '实训步骤', exact: true })
const dataPanel = (page: Page) => page.getByRole('region', { name: '实训数据记录', exact: true })
const chartsPanel = (page: Page) => page.getByRole('region', { name: '实训特性曲线', exact: true })

async function fillCell(page: Page, row: number, col: string, value: string) {
  const input = dataPanel(page).locator(
    `input[data-table-id="fault_points"][data-row-index="${row}"][data-column-id="${col}"]`,
  )
  await input.fill(value)
  await input.press('Enter')
}

test('T1.6 TSK-04/05/06 曲线 shadcn chart 渲染与离线 PDF 报告导出（含数据表、曲线、示波器截图与思考题答案）', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-charts-report-'))
  const pdfPath = join(userData, 'md07-report.pdf')
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: userData },
  })
  const errors: string[] = []
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await page.evaluate(() => {
      location.hash = '#/practice/MD-07'
    })
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('MD-07 三极管放大电路故障排除')
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    // 1. 拖入示波器并接线，上电截取真实波形截图入报告
    await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
    const ch1Input = (await openInstrumentPanel(page, '直流稳压电源')).getByRole('spinbutton', {
      name: 'CH1 电压精确值',
      exact: true,
    })
    await ch1Input.fill('12')
    await ch1Input.press('Enter')
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1P', 'amp1.AMP_VCC')
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1N', 'amp1.AMP_GND1')
    await addInstrumentWireFromList(page, 'scope1.CH1', 'amp1.AMP_UC')
    await addInstrumentWireFromList(page, 'scope1.GND', 'amp1.AMP_GND2')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.POS', 'amp1.AMP_UC')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.NEG', 'amp1.AMP_GND1')

    await page.getByRole('button', { name: '上电', exact: true }).click()
    await expect
      .poll(
        async () => {
          const raw = await viewport(page).getAttribute('data-instrument-screen-readings')
          if (!raw) return false
          const parsed = JSON.parse(raw) as Record<string, { text?: string }>
          const uc = Number(parsed['ins-dc-voltmeter.MAIN']?.text)
          return Number.isFinite(uc) && uc > 5.5 && uc < 6.2
        },
        { timeout: 15_000 },
      )
      .toBe(true)

    const scopePanel = await openInstrumentPanel(page, '双通道数字示波器')
    await scopePanel.getByRole('button', { name: '截图入报告', exact: true }).click()
    await expect(scopePanel.locator('[data-scope-screenshot-count="1"]')).toBeVisible()

    // 2. 在数据表记录 3 组静态节点数据（含一次真实快捷记录与两组对照工况），生成曲线
    await page.getByRole('tab', { name: '数据记录', exact: true }).click()
    await dataPanel(page).getByRole('button', { name: '记录当前行读数', exact: true }).click()
    await fillCell(page, 0, 'ub', '3.29')
    await fillCell(page, 0, 'ue', '2.60')
    await fillCell(page, 1, 'ub', '0.02')
    await fillCell(page, 1, 'uc', '11.98')
    await fillCell(page, 1, 'ue', '0.00')
    await fillCell(page, 2, 'ub', '4.20')
    await fillCell(page, 2, 'uc', '3.56')
    await fillCell(page, 2, 'ue', '3.51')

    // 3. 填写思考题作答
    await page.getByRole('tab', { name: '步骤', exact: true }).click()
    const q1 = stepsPanel(page).getByRole('textbox', { name: '思考题 1 作答', exact: true })
    await q1.fill('通过比较 UB 和 UE 可快速区分 RB1 开路（UB≈0）与 RC 短路（UB 正常）。')

    // 4. 切到底栏“曲线”标签页，验证 shadcn Chart / Recharts 正确渲染 3 个点与折线路径
    await page.getByRole('tab', { name: '曲线', exact: true }).click()
    const card = chartsPanel(page).locator('[data-chart-card="node-voltages"]')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-chart-points', '3')
    await expect(card.locator('[data-slot="chart"] svg.recharts-surface')).toBeVisible()
    await expect(card.locator('.recharts-line-curve')).toHaveCount(3)

    // 5. 模拟保存对话框目标路径并点击顶栏“导出报告”，验证主进程 printToPDF 产出有效非空 PDF
    await app.evaluate(({ dialog }, targetPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath })
    }, pdfPath)

    await page.getByRole('button', { name: '导出报告', exact: true }).click()
    await expect
      .poll(
        () => {
          try {
            return statSync(pdfPath).size
          } catch {
            return 0
          }
        },
        { timeout: 25_000 },
      )
      .toBeGreaterThan(10_000)

    const bytes = readFileSync(pdfPath)
    // 验证标准 PDF 头、多页或有效对象流，以及嵌入示波器截图 PNG 的 Image XObject
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    const latin1 = bytes.toString('latin1')
    expect(latin1).toContain('/Subtype /Image')
    expect(latin1).toContain('%%EOF')

    // 验证断网守卫未产生外网请求拦截日志
    const blockedLog = join(userData, 'logs', 'network-blocked.log')
    let blockedContent = ''
    try {
      blockedContent = readFileSync(blockedLog, 'utf8').trim()
    } catch {
      blockedContent = ''
    }
    expect(blockedContent).toBe('')

    await page.getByRole('button', { name: '断电', exact: true }).click()
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
