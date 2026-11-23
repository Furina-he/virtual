import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList } from './helpers/instruments'

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const panel = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const faultPanel = (page: Page) => panel(page, '故障排查')

async function choose(page: Page, container: ReturnType<typeof panel>, label: string, option: string) {
  await container.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

async function setExact(page: Page, panelName: string, label: string, value: string) {
  const input = panel(page, panelName).getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(value)
  await input.press('Enter')
}

async function readDcVoltmeter(page: Page): Promise<number | null> {
  const raw = await viewport(page).getAttribute('data-instrument-screen-readings')
  if (!raw) return null
  const values = JSON.parse(raw) as Record<string, { text?: string; status?: string }>
  const entry = values['ins-dc-voltmeter.MAIN']
  if (entry?.status !== 'ok' || !entry.text) return null
  const num = Number(entry.text)
  return Number.isFinite(num) ? num : null
}

test.setTimeout(90_000)

test('T1.4 FLT-01~05 MD-07 抽题、测量定位、误判计数、修复→上电验证闭环及 5 个故障完整走通', async () => {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-fault-flow-')) },
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

    // 1. 接线：直流电源 CH1 设为 12 V 供电给 amp1，固定直流电压表（20 V 档）监测集电极电位 UC
    await setExact(page, '直流稳压电源', 'CH1 电压', '12')
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1P', 'amp1.AMP_VCC')
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1N', 'amp1.AMP_GND1')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.POS', 'amp1.AMP_UC')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.NEG', 'amp1.AMP_GND1')

    // 切换到右侧“排故”面板
    await page.getByRole('tab', { name: '排故', exact: true }).click()
    await expect(faultPanel(page)).toBeVisible()
    await expect(faultPanel(page).locator('[data-fault-progress]')).toHaveText('已排故 0/6')

    // === 故障 1（完整演示六步 + 误判 + 安全拦截 + 未验证不可结项）：f-rb1-open ===
    await faultPanel(page).getByRole('button', { name: '开始排故', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'observe')
    await expect(faultPanel(page)).toHaveAttribute('data-injected-fault', 'f-rb1-open')

    // 上电：RB1 开路导致三极管截止，UC ≈ 12.00 V
    await page.getByRole('button', { name: '上电', exact: true }).click()
    await expect
      .poll(async () => {
        const v = await readDcVoltmeter(page)
        return v !== null && v > 11.8
      })
      .toBe(true)

    await faultPanel(page).getByRole('button', { name: '确认异常现象', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'measure')

    // 未测量时提交被拒绝
    await faultPanel(page).getByRole('button', { name: '提交故障判定', exact: true }).click()
    await expect(faultPanel(page).locator('[data-fault-notice]')).toContainText('至少 1 次')

    // 记录排故测量
    await faultPanel(page).getByRole('button', { name: '记录排故测量（当前仪表读数）', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-measurement-count', '1')

    // 故意提交错误判定（amp1.RC 短路）-> 误判次数 +1，且保持注入状态
    await choose(page, faultPanel(page), '疑似故障元件', 'amp1.RC')
    await choose(page, faultPanel(page), '疑似故障类型', '短路')
    await faultPanel(page).getByRole('button', { name: '提交故障判定', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-wrong-attempts', '1')
    await expect(faultPanel(page).locator('[data-fault-verdict="wrong"]')).toContainText('第 1 次误判')
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'measure')

    // 提交正确判定（amp1.RB1 开路）-> 进入 repair
    await choose(page, faultPanel(page), '疑似故障元件', 'amp1.RB1')
    await choose(page, faultPanel(page), '疑似故障类型', '开路（断线/虚焊）')
    await faultPanel(page).getByRole('button', { name: '提交故障判定', exact: true }).click()
    await expect(faultPanel(page).locator('[data-fault-verdict="correct"]')).toContainText('系统判定正确')
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'repair')

    // 带电点击修复被安全拦截
    await faultPanel(page).getByRole('button', { name: '更换元件/修复', exact: true }).click()
    await expect(faultPanel(page).locator('[data-fault-notice]')).toContainText('请先断电')
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'repair')

    // 断电后修复 -> 撤除注入，进入 verify（尚未结项）
    await page.getByRole('button', { name: '断电', exact: true }).click()
    await faultPanel(page).getByRole('button', { name: '更换元件/修复', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'verify')
    await expect(faultPanel(page)).toHaveAttribute('data-injected-fault', '')
    await expect(faultPanel(page).locator('[data-fault-progress]')).toHaveText('已排故 0/6')

    // 未上电验证被拒绝
    await faultPanel(page).getByRole('button', { name: '上电验证并结项', exact: true }).click()
    await expect(faultPanel(page).locator('[data-fault-notice]')).toContainText('请先上电')
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'verify')

    // 重新上电，真实 ngspice 读数恢复至正常静态工作点 UC ≈ 5.87 V，验证通过并结项
    await page.getByRole('button', { name: '上电', exact: true }).click()
    await expect
      .poll(async () => {
        const v = await readDcVoltmeter(page)
        return v !== null && v >= 5.5 && v <= 6.2
      })
      .toBe(true)
    await faultPanel(page).getByRole('button', { name: '上电验证并结项', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'completed')
    await expect(faultPanel(page)).toHaveAttribute('data-resolved-count', '1')
    await expect(faultPanel(page).locator('[data-fault-completed="true"]')).toBeVisible()
    await expect(faultPanel(page).locator('[data-fault-history]')).toContainText('测 2 次 / 误判 1 次')
    await page.getByRole('button', { name: '断电', exact: true }).click()

    // === 连续走通其余 4 个覆盖四类故障的 MD-07 故障点（共 5 个故障完整走通）===
    const nextCases: {
      optionLabel: string
      faultId: string
      target: string
      kindLabel: string
      checkFaultyUc: (v: number) => boolean
    }[] = [
      {
        optionLabel: '故障 #2（f-rb2-open）',
        faultId: 'f-rb2-open',
        target: 'amp1.RB2',
        kindLabel: '开路（断线/虚焊）',
        checkFaultyUc: (v) => v > 3.2 && v < 4.0,
      },
      {
        optionLabel: '故障 #3（f-rc-short）',
        faultId: 'f-rc-short',
        target: 'amp1.RC',
        kindLabel: '短路',
        checkFaultyUc: (v) => v > 11.8,
      },
      {
        optionLabel: '故障 #4（f-re-drift）',
        faultId: 'f-re-drift',
        target: 'amp1.RE',
        kindLabel: '参数漂移',
        checkFaultyUc: (v) => v > 10.9 && v < 11.6,
      },
      {
        optionLabel: '故障 #5（f-vt1-dead）',
        faultId: 'f-vt1-dead',
        target: 'amp1.QVT1',
        kindLabel: '元件损坏',
        checkFaultyUc: (v) => v > 3.2 && v < 3.9,
      },
    ]

    for (let i = 0; i < nextCases.length; i++) {
      const c = nextCases[i]
      if (!c) continue
      await choose(page, faultPanel(page), '预设故障题目', c.optionLabel)
      await faultPanel(page).getByRole('button', { name: '注入所选故障', exact: true }).click()
      await expect(faultPanel(page)).toHaveAttribute('data-injected-fault', c.faultId)

      await page.getByRole('button', { name: '上电', exact: true }).click()
      await expect
        .poll(async () => {
          const v = await readDcVoltmeter(page)
          return v !== null && c.checkFaultyUc(v)
        })
        .toBe(true)

      await faultPanel(page).getByRole('button', { name: '记录排故测量', exact: true }).click()
      await choose(page, faultPanel(page), '疑似故障元件', c.target)
      await choose(page, faultPanel(page), '疑似故障类型', c.kindLabel)
      await faultPanel(page).getByRole('button', { name: '提交故障判定', exact: true }).click()
      await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'repair')

      await page.getByRole('button', { name: '断电', exact: true }).click()
      await faultPanel(page).getByRole('button', { name: '更换元件/修复', exact: true }).click()
      await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'verify')

      await page.getByRole('button', { name: '上电', exact: true }).click()
      await expect
        .poll(async () => {
          const v = await readDcVoltmeter(page)
          return v !== null && v >= 5.5 && v <= 6.2
        })
        .toBe(true)
      await faultPanel(page).getByRole('button', { name: '上电验证并结项', exact: true }).click()
      await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'completed')
      await expect(faultPanel(page)).toHaveAttribute('data-resolved-count', String(i + 2))
      await page.getByRole('button', { name: '断电', exact: true }).click()
    }

    // 验证随机抽取模式自动抽取未排故的剩余故障 f-c2-open
    await choose(page, faultPanel(page), '抽题方式', '随机抽取')
    await faultPanel(page).getByRole('button', { name: '随机抽取下一题', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-injected-fault', 'f-c2-open')
    await expect(faultPanel(page).locator('[data-fault-progress]')).toHaveText('已排故 5/6')

    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
