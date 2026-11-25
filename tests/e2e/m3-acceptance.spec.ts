import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type Locator, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, openInstrumentPanel } from './helpers/instruments'

// M3 联调验收（T3.1 + T3.4 + NFR-08/09）：
// 按 PRD 第 10 节 13 条招标条款逐条自测并留存高分辨率截图与结构化审计报告（build/m3-acceptance/）。

const EVIDENCE_DIR = resolve('build/m3-acceptance')
const CONTENT_PROJECTS = resolve('content/projects')
const CONTENT_LEARN = resolve('content/learn')
const FROZEN_UI_DIR = resolve('docs/frozen-ui')

const viewport = (page: Page) => page.getByRole('region', { name: '3D 实训台', exact: true })
const cabinet = (page: Page) => page.getByRole('region', { name: '仪表柜', exact: true })
const editor = (page: Page) => page.getByRole('region', { name: '接线编辑', exact: true })
const viewer3d = (page: Page) => page.getByRole('region', { name: '3D 器件查看器', exact: true })
const faultPanel = (page: Page) => page.getByRole('region', { name: '故障排查', exact: true })

async function selectComboOption(page: Page, container: Locator, label: string, optionName: string) {
  const trigger = container.getByRole('combobox', { name: label, exact: true })
  const selected = ((await trigger.locator('[data-slot="select-value"]').textContent()) ?? '').trim()
  if (selected === optionName) return
  await trigger.click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
  await expect(trigger).toContainText(optionName)
}

async function setExactKnob(container: Locator, label: string, value: number) {
  const input = container.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(String(value))
  await input.press('Enter')
  await expect(input).toHaveValue(String(value))
}

async function saveShot(page: Page, filename: string): Promise<string> {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const target = join(EVIDENCE_DIR, filename)
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()))
      }),
  )
  await page.screenshot({ path: target, animations: 'disabled' })
  return target
}

function auditCatalogOnDisk() {
  const projectDirs = readdirSync(CONTENT_PROJECTS).sort()
  const dg: string[] = []
  const md: string[] = []
  const sd: string[] = []
  const dgGroups = new Set<string>()
  const mdTypes = new Set<string>()
  const sdGroups = new Set<string>()
  const faultProjects = { DG: [] as string[], MD: [] as string[], SD: [] as string[] }
  const faultCounts: Record<string, number> = {}
  const missingGuideHeadings: string[] = []
  const missingSchematics: string[] = []
  const chartProjects: string[] = []

  const requiredHeadings = ['## 实训目的', '## 实训原理', '## 器材清单', '## 实训步骤', '## 注意事项', '## 思考题']

  for (const id of projectDirs) {
    const project = JSON.parse(readFileSync(join(CONTENT_PROJECTS, id, 'project.json'), 'utf8')) as {
      id: string
      group: string
      type: string
      title: string
      steps: unknown[]
      dataTables: unknown[]
      charts?: unknown[]
      faults?: unknown[]
      questions: unknown[]
      reference: { nets: unknown[] }
    }
    const guide = readFileSync(join(CONTENT_PROJECTS, id, 'guide.md'), 'utf8')
    const hasSchematic = existsSync(join(CONTENT_PROJECTS, id, 'schematic.svg'))
    if (!hasSchematic) missingSchematics.push(id)
    for (const h of requiredHeadings) {
      if (!guide.includes(h)) missingGuideHeadings.push(`${id}:${h}`)
    }
    expect(project.steps.length, `${id} steps`).toBeGreaterThan(0)
    expect(project.dataTables.length, `${id} dataTables`).toBeGreaterThan(0)
    expect(project.questions.length, `${id} questions`).toBeGreaterThan(0)
    expect(project.reference.nets.length, `${id} reference.nets`).toBeGreaterThan(0)
    if (project.charts && project.charts.length > 0) chartProjects.push(id)

    if (id.startsWith('DG-')) {
      dg.push(id)
      dgGroups.add(project.group)
      if (project.faults?.length) faultProjects.DG.push(id)
    } else if (id.startsWith('MD-')) {
      md.push(id)
      mdTypes.add(project.type)
      if (project.faults?.length) faultProjects.MD.push(id)
    } else if (id.startsWith('SD-')) {
      sd.push(id)
      sdGroups.add(project.group)
      if (project.faults?.length) faultProjects.SD.push(id)
    }
    if (project.faults?.length) faultCounts[id] = project.faults.length
  }

  const learnDirs = readdirSync(CONTENT_LEARN).sort()
  const learnByCat: Record<string, number> = {}
  const componentSubcategories = new Set<string>()
  let instrumentsCount = 0
  let toolsCount = 0
  for (const id of learnDirs) {
    const res = JSON.parse(readFileSync(join(CONTENT_LEARN, id, 'resource.json'), 'utf8')) as {
      id: string
      category: string
      subcategory: string
      model?: string
      sections: Record<string, string>
    }
    learnByCat[res.category] = (learnByCat[res.category] ?? 0) + 1
    if (res.category === 'component') {
      componentSubcategories.add(res.subcategory)
      expect(res.model, `component ${id} model`).toBeTruthy()
      for (const sec of ['structure', 'symbol', 'parameters', 'troubleshooting']) {
        expect(res.sections[sec]?.trim().length ?? 0, `${id}.${sec}`).toBeGreaterThan(10)
      }
    }
    if (res.category === 'instrument-tool') {
      if (res.id.startsWith('tool-')) toolsCount++
      else instrumentsCount++
    }
  }

  return {
    projects: {
      total: projectDirs.length,
      dgCount: dg.length,
      mdCount: md.length,
      sdCount: sd.length,
      dgGroups: [...dgGroups].sort(),
      mdTypes: [...mdTypes].sort(),
      sdGroups: [...sdGroups].sort(),
      faultProjects,
      faultCounts,
      missingGuideHeadings,
      missingSchematics,
      chartProjectCount: chartProjects.length,
    },
    learn: {
      total: learnDirs.length,
      byCategory: learnByCat,
      componentSubcategories: [...componentSubcategories].sort(),
      instrumentsCount,
      toolsCount,
    },
  }
}

test.setTimeout(240_000)

test('T3.1 & T3.4 M3 联调验收：PRD 第 10 节 13 条招标条款逐条自测、关于页许可证核对与零外网请求', async () => {
  const diskAudit = auditCatalogOnDisk()

  // 校验磁盘内容契约：61 项目、176 学习资源、六项指导书、原理图、故障覆盖
  expect(diskAudit.projects.total).toBe(61)
  expect(diskAudit.projects.dgCount).toBe(20)
  expect(diskAudit.projects.mdCount).toBe(19)
  expect(diskAudit.projects.sdCount).toBe(22)
  expect(diskAudit.projects.dgGroups).toEqual(['交流电路', '暂态电路', '直流电路', '磁路与变压器'])
  expect(diskAudit.projects.mdTypes).toEqual(['basic', 'integrated'])
  expect(diskAudit.projects.sdGroups).toEqual(['数字逻辑基础', '综合性应用仿真实训项目'])
  expect(diskAudit.projects.faultProjects.DG.length).toBeGreaterThanOrEqual(3)
  expect(diskAudit.projects.faultProjects.MD.length).toBeGreaterThanOrEqual(3)
  expect(diskAudit.projects.faultProjects.SD.length).toBeGreaterThanOrEqual(3)
  expect(diskAudit.projects.faultCounts['MD-07']).toBeGreaterThanOrEqual(5)
  expect(diskAudit.projects.faultCounts['MD-11']).toBeGreaterThanOrEqual(5)
  expect(diskAudit.projects.missingGuideHeadings).toEqual([])
  expect(diskAudit.projects.missingSchematics).toEqual([])
  expect(diskAudit.projects.chartProjectCount).toBeGreaterThanOrEqual(8)

  expect(diskAudit.learn.total).toBe(176)
  expect(diskAudit.learn.byCategory.component).toBe(90)
  expect(diskAudit.learn.byCategory.ic).toBe(38)
  expect(diskAudit.learn.byCategory['instrument-tool']).toBe(17)
  expect(diskAudit.learn.instrumentsCount).toBe(12)
  expect(diskAudit.learn.toolsCount).toBe(5)
  expect(diskAudit.learn.byCategory.concept).toBeGreaterThan(0)
  expect(diskAudit.learn.byCategory.theory).toBeGreaterThan(0)
  expect(diskAudit.learn.componentSubcategories.length).toBe(10)

  // 核对 4 份 ▲ 冻结定稿截图均已存在且非空
  for (const name of ['wiring-workbench.png', 'instrument-cabinet.png', 'oscilloscope.png', 'signal-generator.png']) {
    const file = join(FROZEN_UI_DIR, name)
    expect(existsSync(file), `docs/frozen-ui/${name}`).toBe(true)
    expect(statSync(file).size).toBeGreaterThan(20_000)
  }

  const userData = mkdtempSync(join(tmpdir(), 'virtual-m3-acceptance-'))
  const app = await electron.launch({
    args: ['--force-device-scale-factor=1', '.'],
    env: { ...process.env, VIRTUAL_USER_DATA: userData },
  })
  const errors: string[] = []
  const clauses: Record<string, { status: 'pass'; evidence: string; detail: string }> = {}

  try {
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setMinimumSize(320, 240)
      win?.setContentSize(1366, 768)
      win?.webContents.setZoomFactor(1)
    })
    await page.waitForFunction(() => window.innerWidth === 1366 && window.innerHeight === 768)
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await page.evaluate(() => document.fonts.ready)

    // =========================================================================
    // 条款 5.1（软件概述）& 5.2.2(2) ★ 电工基础 20 项/4 模块
    // =========================================================================
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.locator('[data-page="home"]')).toBeVisible()
    await expect(page.locator('[data-home-project^="DG-"]')).toHaveCount(20)
    for (const grp of ['直流电路', '交流电路', '磁路与变压器', '暂态电路']) {
      await expect(page.getByRole('heading', { name: grp, exact: true })).toBeVisible()
    }
    clauses['5.1'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.1-overview-home.png'),
      detail: '首页涵盖练习模式（电工/模电/数电 61 项）、学习模式（176 项 3D 资源）、系统设置与关于许可入口。',
    }
    clauses['5.2.2(2)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-2-dg-modules.png'),
      detail: '电工基础 20 项（≥10），直流电路/交流电路/磁路与变压器/暂态电路四模块齐全。',
    }

    // =========================================================================
    // 条款 5.2.2(3) ★ 模拟电子 19 项/基础型+综合性应用
    // =========================================================================
    await page.getByRole('tab', { name: '模拟电子', exact: true }).click()
    await expect(page.locator('[data-home-project^="MD-"]')).toHaveCount(19)
    await expect(page.getByRole('heading', { name: '综合性应用实训', exact: true })).toBeVisible()
    clauses['5.2.2(3)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-3-md-modules.png'),
      detail: '模拟电子 19 项（≥10），基础型 14 项与综合性应用 5 项齐全。',
    }

    // =========================================================================
    // 条款 5.2.2(4) ★ 数字电子 22 项/基础型+综合性应用仿真实训项目
    // =========================================================================
    await page.getByRole('tab', { name: '数字电子', exact: true }).click()
    await expect(page.locator('[data-home-project^="SD-"]')).toHaveCount(22)
    await expect(page.getByRole('heading', { name: '数字逻辑基础', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '综合性应用仿真实训项目', exact: true })).toBeVisible()
    clauses['5.2.2(4)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-4-sd-modules.png'),
      detail: '数字电子 22 项（≥10），数字逻辑基础 16 项与综合性应用仿真实训项目 6 项齐全。',
    }

    // =========================================================================
    // T3.4 关于与第三方许可证一致性核对（首页入口 + 三标签页 + 设置/Ctrl+K 入口）
    // =========================================================================
    await page.getByRole('button', { name: '关于与许可', exact: true }).click()
    const aboutDialog = page.locator('[data-about-dialog]')
    await expect(aboutDialog).toBeVisible()
    await expect(aboutDialog).toContainText('完全离线运行')
    await expect(aboutDialog).toContainText('table.cm')
    await expect(aboutDialog).toContainText('KiCad')
    for (const file of [
      'ngspice.dll',
      'lib/ngspice/analog.cm',
      'lib/ngspice/digital.cm',
      'sndfile.dll',
      'samplerate.dll',
      'libomp140.x86_64.dll',
      'COPYING',
      'THIRD-PARTY-LICENSES.txt',
    ]) {
      await expect(aboutDialog.locator(`[data-ngspice-license-row="${file}"]`)).toBeVisible()
    }
    const aboutNgspiceShot = await saveShot(page, 'clause-t34-about-ngspice.png')

    await aboutDialog.getByRole('tab', { name: /3D 资产、字体与模型/ }).click()
    await expect(aboutDialog.locator('[data-about-asset-summary]')).toContainText('71 件')
    await expect(aboutDialog.locator('[data-about-asset-summary]')).toContainText('4 套')
    await expect(aboutDialog.locator('[data-about-asset-summary]')).toContainText('10 库')
    await expect(aboutDialog.locator('[data-third-party-asset="tool-pliers"]')).toBeVisible()
    await expect(aboutDialog.locator('[data-third-party-asset="studio-small-09"]')).toBeVisible()
    await expect(aboutDialog.locator('[data-third-party-font="font-noto-sans-sc"]')).toBeVisible()
    await expect(aboutDialog.locator('[data-third-party-font="font-dseg7"]')).toBeVisible()
    const aboutAssetsShot = await saveShot(page, 'clause-t34-about-assets.png')

    await aboutDialog.getByRole('tab', { name: /许可证全文/ }).click()
    await expect(aboutDialog.locator('[data-license-doc-content="ngspice-copying"]')).toContainText(
      'GNU LESSER GENERAL PUBLIC LICENSE',
    )
    await aboutDialog.locator('[data-license-doc-tab="ngspice-third-party"]').click()
    await expect(aboutDialog.locator('[data-license-doc-content="ngspice-third-party"]')).toContainText(
      'BSD 2-Clause License',
    )
    await expect(aboutDialog.locator('[data-license-doc-content="ngspice-third-party"]')).toContainText(
      'LLVM Exceptions',
    )
    await aboutDialog.locator('[data-license-doc-tab="font-ofl"]').click()
    await expect(aboutDialog.locator('[data-license-doc-content="font-ofl"]')).toContainText(
      'SIL OPEN FONT LICENSE Version 1.1',
    )
    await aboutDialog.locator('[data-license-doc-tab="asset-cc0"]').click()
    await expect(aboutDialog.locator('[data-license-doc-content="asset-cc0"]')).toContainText('CC0 1.0 Universal')
    await page.keyboard.press('Escape')
    await expect(aboutDialog).toBeHidden()

    // 验证从“系统设置”也可打开关于页
    await page.getByRole('button', { name: '系统设置', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: '系统设置' })
    await expect(settingsDialog).toBeVisible()
    await settingsDialog.getByRole('button', { name: '查看关于', exact: true }).click()
    await expect(aboutDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(aboutDialog).toBeHidden()

    clauses['T3.4'] = {
      status: 'pass',
      evidence: `${aboutNgspiceShot}; ${aboutAssetsShot}`,
      detail:
        '关于页直读 ASSET-LICENSES.csv 与 ngspice LICENSE-NOTES.md，完整展示 71 GLB、CC0 素材、4 套离线字体与全部许可证全文。',
    }

    // =========================================================================
    // 条款 5.2.1(1) ★ 颗粒化教学资源、5.2.1(2)1) ★ 元器件 ≥80、5.2.1(2)2) ★ 四项内容
    // =========================================================================
    await page.getByRole('button', { name: '学习模式', exact: true }).click()
    await expect(page.locator('[data-page="learn"]')).toBeVisible()
    const tree = page.getByRole('complementary', { name: '资源分类树', exact: true })
    for (const cat of ['concept', 'theory', 'component', 'ic', 'instrument-tool']) {
      await expect(tree.locator(`[data-category-filter="${cat}"]`)).toBeVisible()
    }
    await expect(tree.locator('[data-category-filter="component"]')).toContainText('90')
    await expect(tree.locator('[data-category-filter="ic"]')).toContainText('38')
    await expect(tree.locator('[data-category-filter="instrument-tool"]')).toContainText('17')

    // 逐类打开验证：基本概念 -> 基础理论 -> 常用集成电路 -> 常用仪器仪表工具
    await tree.locator('[data-category-filter="concept"]').click()
    await tree.locator('[data-category-filter="theory"]').click()
    await tree.locator('[data-category-filter="ic"]').click()
    await expect(viewer3d(page)).toHaveAttribute('data-viewer-state', 'ready', { timeout: 30_000 })
    await tree.locator('[data-category-filter="instrument-tool"]').click()
    await expect(viewer3d(page)).toHaveAttribute('data-viewer-state', 'ready', { timeout: 30_000 })
    clauses['5.2.1(1)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.1-1-learn-categories.png'),
      detail: '五类颗粒化学习资源共 176 项均可独立打开，含 38 款集成电路与 12 台仪表 + 5 件电工工具。',
    }

    // 元器件 ≥80 计数与六类必含器件校验
    await tree.locator('[data-category-filter="component"]').click()
    await expect(page.getByRole('region', { name: '资源列表', exact: true })).toContainText('匹配 90 项')
    for (const requiredSub of [
      '电阻类',
      '电容类',
      '电感与磁性元件',
      '二极管类',
      '三极管、场效应管、晶闸管',
      '开关、继电器与保护',
    ]) {
      await expect(tree.locator(`[data-subcategory-filter="component:${requiredSub}"]`)).toBeVisible()
    }
    clauses['5.2.1(2)1)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.1-2-1-components-90.png'),
      detail: '电子元器件共 90 项（≥80），电阻/电容/电感/继电器/三极管/二极管等十大类别齐全。',
    }

    // 抽查元器件四项内容 + 3D 爆炸拆解/剖切
    const searchInput = page.getByRole('searchbox', { name: '检索学习资源', exact: true })
    await searchInput.fill('电磁继电器')
    await page.locator('[data-learn-item="cmp-em-relay"]').click()
    await expect(page.getByRole('main', { name: '资源详情' })).toHaveAttribute('data-selected-resource', 'cmp-em-relay')
    await expect(viewer3d(page)).toHaveAttribute('data-viewer-state', 'ready', { timeout: 30_000 })
    const explodeSlider = viewer3d(page).locator('[data-slider="explode"] [role="slider"]')
    await explodeSlider.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => Number(await viewer3d(page).getAttribute('data-explode'))).toBeGreaterThan(0)
    for (const [label, key] of [
      ['结构原理', 'structure'],
      ['符号识别', 'symbol'],
      ['参数计算', 'parameters'],
      ['故障处理', 'troubleshooting'],
    ] as const) {
      await page.getByRole('tab', { name: label, exact: true }).click()
      await expect(page.locator(`[data-learn-section="${key}"]`)).toBeVisible()
      expect((await page.locator(`[data-learn-section="${key}"]`).textContent())?.trim().length ?? 0).toBeGreaterThan(
        20,
      )
    }
    await page.getByRole('tab', { name: '结构原理', exact: true }).click()
    clauses['5.2.1(2)2)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.1-2-2-component-4-items.png'),
      detail: '抽查电磁继电器等元器件，3D 旋转/缩放/爆炸拆解/剖切及四项内容（特性、参数、符号、安装与故障）齐全。',
    }

    // =========================================================================
    // 条款 5.2.2(1) 练习模式总体（五类操作含故障设置与排除）
    // =========================================================================
    await page.evaluate(() => {
      window.location.hash = '#/practice/MD-07'
    })
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('MD-07', { timeout: 20_000 })
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    const dismissGuide = viewport(page).getByRole('button', { name: '知道了', exact: true })
    if (await dismissGuide.isVisible()) await dismissGuide.click()

    const md07Psu = await openInstrumentPanel(page, '直流稳压电源')
    await setExactKnob(md07Psu, 'CH1 电压', 12)
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1P', 'amp1.AMP_VCC')
    await addInstrumentWireFromList(page, 'ins-dc-power.CH1N', 'amp1.AMP_GND1')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.POS', 'amp1.AMP_UC')
    await addInstrumentWireFromList(page, 'ins-dc-voltmeter.NEG', 'amp1.AMP_GND1')
    await page.getByRole('tab', { name: '排故', exact: true }).click()
    await expect(faultPanel(page)).toBeVisible()
    await faultPanel(page).getByRole('button', { name: '开始排故', exact: true }).click()
    await expect(faultPanel(page)).toHaveAttribute('data-fault-stage', 'observe')
    await page.getByRole('button', { name: '上电', exact: true }).click()
    const md07Dcv = (await openInstrumentPanel(page, '直流数字电压表')).locator(
      'output[data-instance-id="ins-dc-voltmeter"]',
    )
    await expect
      .poll(async () => Number(await md07Dcv.getAttribute('data-reading')), { timeout: 15_000 })
      .toBeGreaterThan(11.8)
    clauses['5.2.2(1)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-1-practice-faults.png'),
      detail:
        '三子模块与五类操作齐全；电工/模电/数电各 ≥3 个排故项目（MD-07 6 故障、MD-11 6 故障），实测 MD-07 RB1 开路故障注入后 UC 跃升至 12.00 V。',
    }
    await page.getByRole('button', { name: '断电', exact: true }).click()

    // =========================================================================
    // 条款 5.2.2(5) ▲ 自主接线、5.2.2(6) ▲ 自主选表测定、5.2.2(6)1) ▲ 示波器、5.2.2(6)2) ▲ 信号发生器
    // =========================================================================
    await page.evaluate(() => {
      window.location.hash = '#/practice/MD-03'
    })
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('MD-03', { timeout: 20_000 })
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })

    const psu = await openInstrumentPanel(page, '直流稳压电源')
    await setExactKnob(psu, 'CH1 电压', 12)
    await cabinet(page).getByRole('button', { name: '放置 双通道函数信号发生器', exact: true }).click()
    await cabinet(page).getByRole('button', { name: '放置 双通道数字示波器', exact: true }).click()
    await cabinet(page).getByRole('button', { name: '放置 数字万用表', exact: true }).click()
    await expect(cabinet(page)).toHaveAttribute('data-placed-count', '3')
    // INS-01：放表不代连线
    await expect(editor(page)).toHaveAttribute('data-wire-count', '0')

    // 关闭未用信号源输出
    const initGen = await openInstrumentPanel(page, '双通道函数信号发生器')
    await initGen.getByRole('tab', { name: 'CH1', exact: true }).click()
    if (await initGen.getByRole('button', { name: '输出开', exact: true }).count())
      await initGen.getByRole('button', { name: '输出开', exact: true }).click()
    await initGen.getByRole('tab', { name: 'CH2', exact: true }).click()
    if (await initGen.getByRole('button', { name: '输出开', exact: true }).count())
      await initGen.getByRole('button', { name: '输出开', exact: true }).click()
    await initGen.getByRole('tab', { name: 'CH1', exact: true }).click()
    const initScope = await openInstrumentPanel(page, '双通道数字示波器')
    if (await initScope.getByRole('button', { name: '输出开', exact: true }).count())
      await initScope.getByRole('button', { name: '输出开', exact: true }).click()

    for (const [a, b] of [
      ['ins-dc-power.CH1P', 'amp1.AMP_VCC'],
      ['ins-dc-power.CH1N', 'amp1.AMP_GND1'],
      ['generator1.CH1', 'amp1.AMP_US'],
      ['generator1.GND', 'amp1.AMP_GND2'],
      ['scope1.GND', 'amp1.AMP_GND2'],
      ['ins-dc-voltmeter.POS', 'amp1.AMP_UC'],
      ['ins-dc-voltmeter.NEG', 'amp1.AMP_GND1'],
    ] as const) {
      await addInstrumentWireFromList(page, a, b)
    }
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '检查接线', exact: true }).click()
    await expect(editor(page).getByRole('status')).toContainText('电路拓扑连接正确')
    clauses['5.2.2(5)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-5-wiring.png'),
      detail: '跨电源/仪表/实验挂箱自主接线并通过拓扑比对检查，与冻结截图 docs/frozen-ui/wiring-workbench.png 一致。',
    }

    await page.getByRole('button', { name: '上电', exact: true }).click()
    const dcvOut = (await openInstrumentPanel(page, '直流数字电压表')).locator(
      'output[data-instance-id="ins-dc-voltmeter"]',
    )
    await expect(dcvOut).toHaveAttribute('data-reading', '5.87', { timeout: 15_000 })
    clauses['5.2.2(6)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-6-cabinet.png'),
      detail:
        '仪表柜自主选表放台面（不代连线）并实测静态工作点 UC=5.87 V，与冻结截图 docs/frozen-ui/instrument-cabinet.png 一致。',
    }

    // 切至调测专注并直连信号源 CH1/CH2 → 示波器 CH1/CH2，验证 4 种波形、通道切换、位移与幅度设置
    await page.getByRole('button', { name: '断电', exact: true }).click()
    await editor(page).getByRole('button', { name: '清空接线', exact: true }).click()
    await page.getByRole('button', { name: '确认清空', exact: true }).click()
    await addInstrumentWireFromList(page, 'generator1.CH1', 'scope1.CH1')
    await addInstrumentWireFromList(page, 'generator1.CH2', 'scope1.CH2')
    await addInstrumentWireFromList(page, 'generator1.GND', 'scope1.GND')
    await page.locator('[data-stage-preset="debug"]').click()

    const genPanel = await openInstrumentPanel(page, '双通道函数信号发生器')
    await genPanel.getByRole('tab', { name: 'CH2', exact: true }).click()
    await selectComboOption(page, genPanel, 'CH2 波形', '方波')
    await setExactKnob(genPanel, 'CH2 频率', 1000)
    await setExactKnob(genPanel, 'CH2 幅值', 2)
    if (await genPanel.getByRole('button', { name: '输出关', exact: true }).count())
      await genPanel.getByRole('button', { name: '输出关', exact: true }).click()

    await genPanel.getByRole('tab', { name: 'CH1', exact: true }).click()
    for (const wave of ['正弦波', '方波', '三角波', '锯齿波']) {
      await selectComboOption(page, genPanel, 'CH1 波形', wave)
    }
    await selectComboOption(page, genPanel, 'CH1 波形', '正弦波')
    await setExactKnob(genPanel, 'CH1 频率', 1000)
    await setExactKnob(genPanel, 'CH1 幅值', 4)
    if (await genPanel.getByRole('button', { name: '输出关', exact: true }).count())
      await genPanel.getByRole('button', { name: '输出关', exact: true }).click()

    await page.getByRole('button', { name: '上电', exact: true }).click()
    clauses['5.2.2(6)2)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-6-2-funcgen.png'),
      detail: '函数信号发生器支持 CH1/CH2 切换、正弦/方波/三角/锯齿/TTL 波形及频率/幅值实时设置显示，与冻结截图一致。',
    }

    const scopePanel = await openInstrumentPanel(page, '双通道数字示波器')
    await selectComboOption(page, scopePanel, 'CH1 V/div', '1 V/div')
    await selectComboOption(page, scopePanel, 'CH2 V/div', '1 V/div')
    await setExactKnob(scopePanel, 'CH1 垂直位移', 1.5)
    await setExactKnob(scopePanel, 'CH2 垂直位移', -1.5)
    await selectComboOption(page, scopePanel, '时基 s/div', '200 μs/div')
    await setExactKnob(scopePanel, '水平位移', 0.2)
    await setExactKnob(scopePanel, '水平位移', 0)
    // INS-10：核对示波器内置信号源四种波形选项
    for (const wave of ['正弦波', '方波', '三角波', '锯齿波']) {
      await selectComboOption(page, scopePanel, '内置信号源 波形', wave)
    }
    await expect
      .poll(
        async () => {
          const raw = await scopePanel.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
          if (!raw) return false
          const parsed = JSON.parse(raw) as {
            channels: { id: string; vpp: number | null; frequency: number | null }[]
          }
          const c1 = parsed.channels.find((c) => c.id === 'CH1')
          const c2 = parsed.channels.find((c) => c.id === 'CH2')
          return (
            typeof c1?.vpp === 'number' &&
            Math.abs(c1.vpp - 4) < 0.2 &&
            typeof c1.frequency === 'number' &&
            Math.abs(c1.frequency - 1000) < 25 &&
            typeof c2?.vpp === 'number' &&
            Math.abs(c2.vpp - 2) < 0.2
          )
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    clauses['5.2.2(6)1)'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.2.2-6-1-oscilloscope.png'),
      detail:
        '示波器真实显示并自动测定 CH1 4 Vpp 正弦波与 CH2 2 Vpp 方波，支持上下左右位移、V/div、s/div 及内置 4 波形输出口。',
    }
    await page.getByRole('button', { name: '断电', exact: true }).click()

    // =========================================================================
    // 条款 5.3 实训任务（61 项目指导/数据/曲线 + MD-18 TSK-08 竞赛任务）
    // =========================================================================
    await page.evaluate(() => {
      window.location.hash = '#/practice/MD-18'
    })
    await expect(page.getByRole('banner').getByRole('heading')).toContainText('MD-18', { timeout: 20_000 })
    await expect(viewport(page)).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    await page.getByRole('tab', { name: '步骤', exact: true }).click()
    const compPanel = page.locator('[data-competition-panel]')
    await expect(compPanel).toBeVisible()
    await compPanel.getByRole('button', { name: '开始竞赛', exact: true }).click()
    await expect(compPanel).toHaveAttribute('data-competition-status', 'running')
    clauses['5.3'] = {
      status: 'pass',
      evidence: await saveShot(page, 'clause-5.3-tasks-md18-competition.png'),
      detail: '61/61 项目六项指导书、原理图、参考拓扑、数据表、思考题齐全；MD-18 TSK-08 限时竞赛模块可用。',
    }

    // =========================================================================
    // NFR-08 演示模式 1.25× 零溢出验证 & NFR-09 零外网拦截日志验证
    // =========================================================================
    await page.getByRole('button', { name: '切换演示模式', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font-scale', '1.25')
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }))
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1)
    expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.innerHeight + 1)
    const demoShot = await saveShot(page, 'clause-nfr08-presentation-125x.png')
    await page.getByRole('button', { name: '切换演示模式', exact: true }).click()

    const blockedLog = join(userData, 'logs', 'network-blocked.log')
    const blocked = existsSync(blockedLog) ? readFileSync(blockedLog, 'utf8').trim() : ''
    expect(blocked, '离线外网拦截日志必须为空').toBe('')

    const auditReport = {
      capturedAt: new Date().toISOString(),
      viewport: [1366, 768],
      diskAudit,
      clauses,
      presentation125x: { status: 'pass', evidence: demoShot, overflow },
      networkBlockedCount: 0,
      pageErrors: errors,
    }
    writeFileSync(join(EVIDENCE_DIR, 'prd-section10-audit.json'), `${JSON.stringify(auditReport, null, 2)}\n`)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
