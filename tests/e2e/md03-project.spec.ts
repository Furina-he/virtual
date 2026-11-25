import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import { addInstrumentWireFromList, dragInstrumentToSlot, openInstrumentPanel } from './helpers/instruments'

const project = JSON.parse(readFileSync('content/projects/MD-03/project.json', 'utf8')) as {
  title: string
  steps: { id: string }[]
  dataTables: { id: string; title: string; columns: { id: string; measurePoint?: string; computed?: string }[] }[]
}
const workflowTitle = 'MD-03 实际接线、静态点、幅值增益与 Ri/Ro、两种失真记录和重置'
const tableIds = ['static', 'gain', 'ri', 'ro', 'distortion'] as const
type TableId = (typeof tableIds)[number]
type ScopeChannel = {
  id: string
  vpp: number | null
  mean: number | null
  min: number | null
  max: number | null
  frequency: number | null
  period: number | null
}
type ScopeSummary = { state: string; revision: number; channels: ScopeChannel[] }
type RecordedCell = { value: number; source: string; channel: string }
type ProbeBuffer = {
  length: number
  dt: number
  lastTime: number
  copyLatest: (destination: Float32Array) => number
}
type AlteredEvent = { type: 'altered'; simTime: number; changes: { param: string; value: number }[] }
type ObservedClient = {
  stats: { sessions: number; lastSeq: number; points: number; blocks: number }
  buffer: (probeId: string) => ProbeBuffer
  onEvent: (listener: (event: { type: string }) => void) => () => void
}

let app: ElectronApplication | undefined
let page: Page
let errors: string[] = []
let video: ReturnType<Page['video']> = null

const viewport = () => page.getByRole('region', { name: '3D 实训台', exact: true })
const editor = () => page.getByRole('region', { name: '接线编辑', exact: true })
const steps = () => page.getByRole('region', { name: '实训步骤', exact: true })
const data = () => page.getByRole('region', { name: '实训数据记录', exact: true })
const panel = (name: string) => page.getByRole('region', { name, exact: true })
const generator = () => panel('双通道函数信号发生器')
const scope = () => panel('双通道数字示波器')
const cell = (table: TableId, column: string) =>
  data().locator(`input[data-table-id="${table}"][data-row-index="0"][data-column-id="${column}"]`)
const key = (table: TableId, column: string) => `${table}/${column}`
const near = (actual: number | null | undefined, expected: number, absolute = 0) =>
  typeof actual === 'number' &&
  Number.isFinite(actual) &&
  Math.abs(actual - expected) <= Math.abs(expected) * 0.01 + absolute

test.setTimeout(240_000)

test.beforeEach(async () => {
  errors = []
  video = null
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, VIRTUAL_USER_DATA: mkdtempSync(join(tmpdir(), 'virtual-md03-')) },
    ...(test.info().title === workflowTitle
      ? { recordVideo: { dir: resolve('build/t015-md03-recordings'), size: { width: 1366, height: 768 } } }
      : {}),
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  video = page.video()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setMinimumSize(320, 240)
    window?.setContentSize(1366, 768)
    window?.webContents.setZoomFactor(1)
  })
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.location.hash = '/practice/MD-03'
  })
  await expect(
    page.getByRole('banner').getByRole('heading', { name: `MD-03 ${project.title}`, exact: true }),
  ).toBeVisible()
  await expect(viewport()).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
  await expect(viewport()).toHaveAttribute('data-camera-moving', 'false')
  await page.waitForFunction(() => Math.abs(window.innerWidth - 1366) <= 2 && Math.abs(window.innerHeight - 768) <= 2)
  await page.evaluate(() => {
    const client = (window as unknown as { __simClient: ObservedClient }).__simClient
    const events: AlteredEvent[] = []
    const diagnostics: { type: string }[] = []
    Object.assign(window, { __md03AlteredEvents: events, __md03Diagnostics: diagnostics })
    client.onEvent((event) => {
      if (event.type === 'altered') events.push(event as AlteredEvent)
      diagnostics.push(event)
      if (diagnostics.length > 300) diagnostics.shift()
    })
  })
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (video) {
    const path = await video.path()
    expect(statSync(path).size, 'The recording contains real Electron user actions').toBeGreaterThan(0)
    await test.info().attach('MD-03 实际操作录屏', { path, contentType: 'video/webm' })
  }
  expect(errors).toEqual([])
})

async function showTab(name: string) {
  const tab = page.getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

async function showWiring() {
  await showTab('接线')
  await expect(editor()).toBeVisible()
}

async function showSteps() {
  await showTab('步骤')
  await expect(steps()).toBeVisible()
}

async function selectOption(container: ReturnType<typeof panel>, label: string, optionName: string) {
  const trigger = container.getByRole('combobox', { name: label, exact: true })
  await page.mouse.move(0, 0)
  const selectedValue = trigger.locator('[data-slot="select-value"]')
  await expect(selectedValue).toBeVisible()
  const selectedName = ((await selectedValue.textContent()) ?? '').trim()
  await trigger.press('Enter')
  // Wait for Radix initial focus before moving to a different option.
  await expect(page.getByRole('option', { name: selectedName, exact: true })).toBeFocused()
  const option = page.getByRole('option', { name: optionName, exact: true })
  await expect(option).toBeVisible()
  await option.focus()
  await expect(option).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger).toContainText(optionName)
  // Closing autofocus must finish before the next selector receives a key.
  await expect(trigger).toBeFocused()
}

async function showTable(table: TableId) {
  await showTab('数据记录')
  await expect(data()).toHaveAttribute('data-task-project', 'MD-03')
  if ((await data().getAttribute('data-task-table')) !== table) {
    const title = project.dataTables.find((entry) => entry.id === table)?.title
    if (!title) throw new Error(`Missing configured table ${table}`)
    await selectOption(data(), '记录数据表', title)
  }
  await expect(data()).toHaveAttribute('data-task-table', table)
}

async function exact(container: ReturnType<typeof panel>, label: string, value: number) {
  const input = container.getByRole('spinbutton', { name: `${label}精确值`, exact: true })
  await input.fill(String(value))
  await input.press('Enter')
  await expect(input).toHaveValue(String(value))
  await expect(container.getByRole('slider', { name: `${label}旋钮`, exact: true })).toHaveAttribute(
    'aria-valuenow',
    String(value),
  )
}

async function setModuleRW(value: number) {
  await showTab('模块控件')
  const controls = panel('模块控件')
  await expect(controls).toHaveAttribute('data-instance-id', 'amp1')
  await exact(controls, '偏置电位器 RW', value)
}

async function setModuleCE(enabled: boolean) {
  await showTab('模块控件')
  await selectOption(panel('模块控件'), '发射极旁路 CE', enabled ? '接入' : '断开')
}

async function configureGenerator(frequency: number, amplitude: number, enabled = true) {
  await openInstrumentPanel(page, '双通道函数信号发生器')
  await generator().getByRole('tab', { name: 'CH1', exact: true }).click()
  await selectOption(generator(), 'CH1 波形', '正弦波')
  await exact(generator(), 'CH1 频率', frequency)
  await exact(generator(), 'CH1 幅值', amplitude)
  await exact(generator(), 'CH1 直流偏置', 0)
  const button = generator().getByRole('button', { name: enabled ? '输出关' : '输出开', exact: true })
  if (await button.count()) await button.click()
  await expect(generator().getByRole('button', { name: enabled ? '输出开' : '输出关', exact: true })).toHaveAttribute(
    'aria-pressed',
    String(enabled),
  )
}

async function configureScope(frequency: number, differential = false, inputPair = false) {
  await openInstrumentPanel(page, '双通道数字示波器')
  await selectOption(scope(), 'CH1 耦合', 'DC 直流耦合')
  await selectOption(scope(), 'CH2 耦合', 'DC 直流耦合')
  await selectOption(scope(), '触发源', 'CH1')
  await selectOption(scope(), '触发方式', '自动')
  await exact(scope(), '触发电平', 0)
  await selectOption(scope(), '时基 s/div', frequency === 5000 ? '20 μs/div' : '200 μs/div')
  await selectOption(scope(), 'CH1 V/div', differential ? '2 V/div' : inputPair ? '20 mV/div' : '5 mV/div')
  await selectOption(
    scope(),
    'CH2 V/div',
    differential ? '1 V/div' : inputPair ? '5 mV/div' : frequency === 5000 ? '1 V/div' : '500 mV/div',
  )
  await exact(scope(), 'CH1 垂直位移', differential ? -3 : 0)
  await exact(scope(), 'CH2 垂直位移', differential ? -2 : 0)
}

async function clientStats() {
  return page.evaluate(() => ({ ...(window as unknown as { __simClient: ObservedClient }).__simClient.stats }))
}

async function turnOff() {
  const button = page.getByRole('button', { name: '断电', exact: true })
  if (await button.count()) await button.click()
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
}

async function turnOn() {
  const before = await clientStats()
  await page.getByRole('button', { name: '上电', exact: true }).click()
  await expect(page.getByRole('button', { name: '断电', exact: true })).toBeVisible()
  await expect.poll(async () => (await clientStats()).sessions).toBeGreaterThan(before.sessions)
}

async function addWire(a: string, b: string) {
  await showWiring()
  const before = Number(await editor().getAttribute('data-wire-count'))
  await addInstrumentWireFromList(page, a, b)
  await expect(editor()).toHaveAttribute('data-wire-count', String(before + 1))
}

async function removeWires(selector: string, count: number) {
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
  await showWiring()
  const wires = editor().locator(selector)
  await expect(wires).toHaveCount(count)
  for (let remaining = count - 1; remaining >= 0; remaining--) {
    await wires
      .first()
      .getByRole('button', { name: /^删除导线 \d+$/ })
      .click()
    await expect(wires).toHaveCount(remaining)
  }
}

async function removeVM() {
  await removeWires('li[data-wire-a^="ins-dc-voltmeter."], li[data-wire-b^="ins-dc-voltmeter."]', 2)
}

async function connectVM(positive: string) {
  await addWire('ins-dc-voltmeter.POS', positive)
  await addWire('ins-dc-voltmeter.NEG', 'amp1.AMP_GND1')
}

async function replaceScopeSignals(positive1: string, positive2: string) {
  await removeWires(
    'li[data-wire-a="scope1.CH1"], li[data-wire-b="scope1.CH1"], li[data-wire-a="scope1.CH2"], li[data-wire-b="scope1.CH2"]',
    2,
  )
  await addWire('scope1.CH1', positive1)
  await addWire('scope1.CH2', positive2)
}

async function setLoad(loaded: boolean) {
  await showWiring()
  const selector =
    'li[data-wire-a="amp1.AMP_UO"][data-wire-b="amp1.AMP_RL"], li[data-wire-a="amp1.AMP_RL"][data-wire-b="amp1.AMP_UO"]'
  const wire = editor().locator(selector)
  if (loaded && (await wire.count()) === 0) await addWire('amp1.AMP_UO', 'amp1.AMP_RL')
  if (!loaded && (await wire.count())) await removeWires(selector, 1)
  await expect(wire).toHaveCount(loaded ? 1 : 0)
}

async function summary(): Promise<ScopeSummary | null> {
  const raw = await page.locator('canvas[data-instance-id="scope1"]').getAttribute('data-scope')
  return raw ? (JSON.parse(raw) as ScopeSummary) : null
}

async function scopeTime() {
  return page.evaluate(() => {
    const client = (window as unknown as { __simClient: ObservedClient }).__simClient
    return Math.min(client.buffer('scope:scope1:CH1').lastTime, client.buffer('scope:scope1:CH2').lastTime)
  })
}

async function waitScope(frequency: number, differential = false, afterTime = 0) {
  await openInstrumentPanel(page, '双通道数字示波器')
  try {
    await expect
      .poll(scopeTime, { timeout: 30_000, message: '真实仿真推进到参数/启动后的稳定采样窗口' })
      .toBeGreaterThan(afterTime + 0.65)
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const observed = window as unknown as { __simClient: ObservedClient; __md03Diagnostics: unknown[] }
      const client = observed.__simClient
      return {
        stats: client.stats,
        channels: ['CH1', 'CH2'].map((id) => ({
          id,
          lastTime: client.buffer(`scope:scope1:${id}`).lastTime,
          dt: client.buffer(`scope:scope1:${id}`).dt,
          length: client.buffer(`scope:scope1:${id}`).length,
        })),
        events: observed.__md03Diagnostics,
      }
    })
    console.log(`MD03 stalled sample diagnostics: ${JSON.stringify(diagnostics)}`)
    await test
      .info()
      .attach('md03-simulation-events', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
    throw error
  }
  await expect
    .poll(
      async () => {
        const frame = await summary()
        const a = frame?.channels[0]
        const b = frame?.channels[1]
        return (
          a &&
          b &&
          near(a.frequency, frequency) &&
          typeof a.vpp === 'number' &&
          a.vpp > 0 &&
          typeof b.vpp === 'number' &&
          b.vpp > 0 &&
          (!differential || (typeof a.mean === 'number' && typeof a.min === 'number' && typeof a.max === 'number'))
        )
      },
      { timeout: 15_000 },
    )
    .toBe(true)
  return (await summary()) as ScopeSummary
}

async function waveMetrics(mode: 'correlation' | 'vbe' | 'vce') {
  return page.evaluate((kind) => {
    const client = (window as unknown as { __simClient: ObservedClient }).__simClient
    const a = client.buffer('scope:scope1:CH1')
    const b = client.buffer('scope:scope1:CH2')
    const length = Math.min(20_000, a.length, b.length)
    if (length < 512 || a.dt <= 0 || a.dt !== b.dt || Math.abs(a.lastTime - b.lastTime) > 1e-9) return null
    const x = new Float32Array(length)
    const y = new Float32Array(length)
    a.copyLatest(x)
    b.copyLatest(y)
    let mx = 0
    let my = 0
    for (let i = 0; i < length; i++) {
      mx += x[i] as number
      my += y[i] as number
    }
    mx /= length
    my /= length
    let covariance = 0
    let xx = 0
    let yy = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let below = 0
    let collectorMin = Number.POSITIVE_INFINITY
    let collectorMax = Number.NEGATIVE_INFINITY
    for (const value of x) {
      collectorMin = Math.min(collectorMin, value)
      collectorMax = Math.max(collectorMax, value)
    }
    const collectorSpan = collectorMax - collectorMin
    const plateauSlope = collectorSpan * 2 * Math.PI * 1000 * a.dt * 0.02
    let upperPlateau = 0
    for (let i = 0; i < length; i++) {
      const dx = (x[i] as number) - mx
      const dy = (y[i] as number) - my
      covariance += dx * dy
      xx += dx * dx
      yy += dy * dy
      const difference = (x[i] as number) - (y[i] as number)
      min = Math.min(min, difference)
      max = Math.max(max, difference)
      if (difference < (kind === 'vce' ? 0.2 : 0)) below++
      if (
        i > 0 &&
        (x[i] as number) > collectorMax - collectorSpan * 0.1 &&
        Math.abs((x[i] as number) - (x[i - 1] as number)) < plateauSlope
      )
        upperPlateau++
    }
    return {
      correlation: covariance / Math.sqrt(xx * yy),
      min,
      max,
      mean: mx - my,
      fractionBelow: below / length,
      collectorSpan,
      upperPlateauFraction: upperPlateau / length,
      time: a.lastTime,
    }
  }, mode)
}

async function expectStep(id: string, completed: number) {
  await expect(steps()).toHaveAttribute('data-current-step', id)
  await expect(steps()).toHaveAttribute('data-completed-count', String(completed))
}

async function completeStep(id: string, next: string, completed: number) {
  await showSteps()
  await expect(steps()).toHaveAttribute('data-current-step', id)
  await steps().getByRole('button', { name: '完成当前步骤', exact: true }).click()
  await expectStep(next, completed)
}

async function numeric(table: TableId, column: string) {
  const value = await cell(table, column).inputValue()
  expect(value, `${table}/${column} is a recorded/derived number, not a blank treated as zero`).not.toBe('')
  const result = Number(value)
  expect(Number.isFinite(result)).toBe(true)
  return result
}

async function expectRecorded(table: TableId, recorded: ReadonlyMap<string, RecordedCell>) {
  await showTable(table)
  const definition = project.dataTables.find((entry) => entry.id === table)
  if (!definition) throw new Error(`Missing table ${table}`)
  for (const column of definition.columns) {
    const field = cell(table, column.id)
    const expected = recorded.get(key(table, column.id))
    if (expected) {
      await expect.poll(async () => near(await numeric(table, column.id), expected.value, 1e-5)).toBe(true)
      await expect(field).toHaveAttribute('data-captured-from', expected.source)
      await expect(field).toHaveAttribute('data-captured-channel', expected.channel)
      await expect
        .poll(async () => near(Number(await field.getAttribute('data-reference-value-si')), expected.value, 1e-5))
        .toBe(true)
    } else if (!column.computed) {
      await expect(field).toHaveValue('')
      await expect(field).toHaveAttribute('data-captured-from', '')
      await expect(field).toHaveAttribute('data-captured-channel', '')
    }
    if (column.computed) {
      await expect(field).toBeDisabled()
      await expect(field).toHaveAttribute('data-captured-from', '')
    }
  }
}

async function record(
  step: string,
  next: string,
  completed: number,
  table: TableId,
  readings: Record<string, RecordedCell>,
  recorded: Map<string, RecordedCell>,
) {
  await showSteps()
  await expect(steps()).toHaveAttribute('data-current-step', step)
  await page.getByRole('button', { name: '记录读数', exact: true }).click()
  await expectStep(next, completed)
  for (const [column, value] of Object.entries(readings)) recorded.set(key(table, column), value)
  await expectRecorded(table, recorded)
}

function scalar(value: number | null, channel: string): RecordedCell {
  if (value === null || !Number.isFinite(value)) throw new Error('Scope did not produce a real finite scalar')
  return { value, source: 'scope1', channel }
}

async function prepareSources() {
  await dragInstrumentToSlot(page, 'SLOT_DESK_1', '双通道函数信号发生器')
  await dragInstrumentToSlot(page, 'SLOT_SCOPE', '双通道数字示波器')
  await exact(await openInstrumentPanel(page, '直流稳压电源'), 'CH1 电压', 12)
  await configureGenerator(1000, 0.1, false)
  await generator().getByRole('tab', { name: 'CH2', exact: true }).click()
  const ch2 = generator().getByRole('button', { name: '输出开', exact: true })
  if (await ch2.count()) await ch2.click()
  await generator().getByRole('tab', { name: 'CH1', exact: true }).click()
  await openInstrumentPanel(page, '双通道数字示波器')
  const output = scope().getByRole('button', { name: '输出开', exact: true })
  if (await output.count()) await output.click()
  await setModuleRW(22000)
  await setModuleCE(true)
  await showWiring()
}

async function wireSources() {
  for (const [a, b] of [
    ['ins-dc-power.CH1P', 'amp1.AMP_VCC'],
    ['ins-dc-power.CH1N', 'amp1.AMP_GND1'],
    ['generator1.CH1', 'amp1.AMP_US'],
    ['generator1.GND', 'amp1.AMP_GND2'],
    ['scope1.GND', 'amp1.AMP_GND2'],
  ] as const)
    await addWire(a, b)
}

async function prepareAndWire() {
  await prepareSources()
  await completeStep('prepare', 'wire', 1)
  await wireSources()
  await page.getByRole('button', { name: '检查接线', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText('电路拓扑连接正确')
  await completeStep('wire', 'static-vcc', 2)
}

async function staticPoints(recorded: Map<string, RecordedCell>) {
  const vmPanel = await openInstrumentPanel(page, '直流数字电压表')
  await selectOption(vmPanel, '量程', '20 V')
  await selectOption(vmPanel, '输入内阻', '10 MΩ')
  for (const [index, id, jack, display, next, completed] of [
    [0, 'vcc', 'AMP_VCC', '12.00', 'static-b', 3],
    [1, 'ub', 'AMP_UB', '3.29', 'static-c', 4],
    [2, 'uc', 'AMP_UC', '5.87', 'static-e', 5],
    [3, 'ue', 'AMP_UE', '2.60', 'gain', 6],
  ] as const) {
    await turnOff()
    if (index) await removeVM()
    await connectVM(`amp1.${jack}`)
    await turnOn()
    const activeVm = await openInstrumentPanel(page, '直流数字电压表')
    const output = activeVm.locator('output[data-instance-id="ins-dc-voltmeter"]')
    await expect(output).toHaveAttribute('data-status', 'ok')
    await expect(output).toHaveAttribute('data-unit', 'V')
    await expect(output).toHaveAttribute('data-reading', display)
    await record(
      index ? `static-${id === 'ub' ? 'b' : id === 'uc' ? 'c' : 'e'}` : 'static-vcc',
      next,
      completed,
      'static',
      {
        [id]: { value: Number(display), source: 'ins-dc-voltmeter', channel: '' },
      },
      recorded,
    )
  }
  await turnOff()
  await removeVM()
}

async function connectScopeGain() {
  await addWire('scope1.CH1', 'amp1.AMP_UI')
  await addWire('scope1.CH2', 'amp1.AMP_UO')
  await setLoad(true)
  await configureGenerator(1000, 0.1)
  await configureScope(1000)
}

test(workflowTitle, async () => {
  expect(video).not.toBeNull()
  const documentSize = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.width)
  expect(documentSize.scrollHeight).toBeLessThanOrEqual(documentSize.height)
  const guide = page.getByRole('tabpanel', { name: '实训指导', exact: true })
  for (const title of ['实训目的', '实训原理', '器材清单', '实训步骤', '注意事项', '思考题'])
    await expect(guide.getByRole('heading', { name: title, exact: true })).toHaveCount(1)
  await expect(guide).toContainText('NPN_3DG6_EST')
  await expect(guide).toContainText('不是把 S9013 改名')
  await expect(guide).toContainText('mod-analog-base')
  await expect(guide).toContainText('交流毫伏表')
  await showTab('原理图')
  const image = page.getByRole('img', { name: 'MD-03 原理图', exact: true })
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate(
        (element) => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true)
  await showSteps()
  await expectStep('prepare', 0)
  const recorded = new Map<string, RecordedCell>()
  for (const table of tableIds) await expectRecorded(table, recorded)
  await prepareAndWire()
  await staticPoints(recorded)
  await showTable('static')
  expect(await numeric('static', 'uce')).toBeCloseTo(5.87 - 2.6, 6)
  expect(await numeric('static', 'ic_est')).toBeCloseTo((12 - 5.87) / 2400, 9)

  await connectScopeGain()
  await turnOn()
  const gain = await waitScope(1000)
  expect(near(gain.channels[0]?.vpp, 0.010868311, 1e-5)).toBe(true)
  expect(near(gain.channels[1]?.vpp, 1.197098866, 1e-3)).toBe(true)
  await expect.poll(async () => (await waveMetrics('correlation'))?.correlation ?? 1).toBeLessThan(-0.9)
  await record(
    'gain',
    'ri',
    7,
    'gain',
    {
      frequency: scalar(gain.channels[0]?.frequency ?? null, 'CH1'),
      ui_vpp: scalar(gain.channels[0]?.vpp ?? null, 'CH1'),
      uo_vpp: scalar(gain.channels[1]?.vpp ?? null, 'CH2'),
    },
    recorded,
  )
  const measuredGain = await numeric('gain', 'au')
  expect(measuredGain).toBeCloseTo((await numeric('gain', 'uo_vpp')) / (await numeric('gain', 'ui_vpp')), 6)
  expect(near(measuredGain, 110.145801, 0.1)).toBe(true)
  expect(measuredGain).toBeGreaterThan(0)

  await turnOff()
  await replaceScopeSignals('amp1.AMP_US', 'amp1.AMP_UI')
  await configureGenerator(5000, 0.1)
  await configureScope(5000, false, true)
  await turnOn()
  const ri = await waitScope(5000)
  expect(near(ri.channels[0]?.vpp, 0.099122381, 1e-5)).toBe(true)
  expect(near(ri.channels[1]?.vpp, 0.010245882, 1e-5)).toBe(true)
  await record(
    'ri',
    'ro-open',
    8,
    'ri',
    {
      frequency: scalar(ri.channels[1]?.frequency ?? null, 'CH2'),
      us_vpp: scalar(ri.channels[0]?.vpp ?? null, 'CH1'),
      ui_vpp: scalar(ri.channels[1]?.vpp ?? null, 'CH2'),
    },
    recorded,
  )
  const apparentRi = await numeric('ri', 'ri_est')
  expect(apparentRi).toBeCloseTo(
    (5100 * (await numeric('ri', 'ui_vpp'))) / ((await numeric('ri', 'us_vpp')) - (await numeric('ri', 'ui_vpp'))),
    6,
  )
  expect(near(apparentRi, 587.939435, 1)).toBe(true)

  await turnOff()
  await replaceScopeSignals('amp1.AMP_UI', 'amp1.AMP_UO')
  await setLoad(false)
  await configureScope(5000)
  await turnOn()
  const open = await waitScope(5000)
  expect(near(open.channels[1]?.vpp, 2.394318226, 1e-3)).toBe(true)
  await record(
    'ro-open',
    'ro-load',
    9,
    'ro',
    {
      frequency_open: scalar(open.channels[0]?.frequency ?? null, 'CH1'),
      ui_open_vpp: scalar(open.channels[0]?.vpp ?? null, 'CH1'),
      uo_open_vpp: scalar(open.channels[1]?.vpp ?? null, 'CH2'),
    },
    recorded,
  )
  await expect(cell('ro', 'uo_load_vpp')).toHaveValue('')
  await expect(cell('ro', 'ro_est')).toHaveValue('')
  const savedOpen = await numeric('ro', 'uo_open_vpp')
  await turnOff()
  await setLoad(true)
  await turnOn()
  const loaded = await waitScope(5000)
  await record(
    'ro-load',
    'cutoff',
    10,
    'ro',
    {
      frequency_load: scalar(loaded.channels[0]?.frequency ?? null, 'CH1'),
      ui_load_vpp: scalar(loaded.channels[0]?.vpp ?? null, 'CH1'),
      uo_load_vpp: scalar(loaded.channels[1]?.vpp ?? null, 'CH2'),
    },
    recorded,
  )
  expect(await numeric('ro', 'uo_open_vpp')).toBe(savedOpen)
  const apparentRo = await numeric('ro', 'ro_est')
  const openGain = (await numeric('ro', 'uo_open_vpp')) / (await numeric('ro', 'ui_open_vpp'))
  const loadedGain = (await numeric('ro', 'uo_load_vpp')) / (await numeric('ro', 'ui_load_vpp'))
  const normalizedRo = 2400 * (openGain / loadedGain - 1)
  expect(apparentRo).toBeCloseTo(normalizedRo, 6)
  expect(apparentRo).toBeGreaterThan(2250)
  expect(apparentRo).toBeLessThan(2550)

  await turnOff()
  await replaceScopeSignals('amp1.AMP_UC', 'amp1.AMP_UE')
  await configureGenerator(1000, 2)
  await configureScope(1000, true)
  await setModuleRW(100000)
  await turnOn()
  const cutoff = await waitScope(1000, true)
  const cutoffDifference = await waveMetrics('vce')
  expect(cutoffDifference).not.toBeNull()
  expect(cutoffDifference?.min ?? 0).toBeGreaterThan(0.3)
  // C2 still drives RL while Q is cut off; the loaded collector plateau need not reach VCC.
  expect(cutoffDifference?.collectorSpan ?? 0).toBeGreaterThan(4)
  expect(cutoffDifference?.upperPlateauFraction ?? 0).toBeGreaterThan(0.05)
  await record(
    'cutoff',
    'saturation',
    11,
    'distortion',
    {
      frequency_cutoff: scalar(cutoff.channels[0]?.frequency ?? null, 'CH1'),
      uc_cutoff_vpp: scalar(cutoff.channels[0]?.vpp ?? null, 'CH1'),
      vce_cutoff_min: scalar(cutoffDifference?.min ?? null, 'CH1-CH2'),
      vce_cutoff_max: scalar(cutoffDifference?.max ?? null, 'CH1-CH2'),
      vce_cutoff_mean: scalar(cutoffDifference?.mean ?? null, 'CH1-CH2'),
    },
    recorded,
  )
  const savedCutoff = await numeric('distortion', 'vce_cutoff_mean')
  await expect(cell('distortion', 'vce_saturation_mean')).toHaveValue('')
  await turnOff()
  await configureGenerator(1000, 1)
  await setModuleRW(18000)
  await turnOn()
  const saturation = await waitScope(1000, true)
  const saturationDifference = await waveMetrics('vce')
  expect(saturationDifference).not.toBeNull()
  expect(saturationDifference?.min ?? 1).toBeLessThan(0.2)
  expect(saturationDifference?.min ?? -1).toBeGreaterThanOrEqual(0)
  await record(
    'saturation',
    'analyse',
    12,
    'distortion',
    {
      frequency_saturation: scalar(saturation.channels[0]?.frequency ?? null, 'CH1'),
      uc_saturation_vpp: scalar(saturation.channels[0]?.vpp ?? null, 'CH1'),
      vce_saturation_min: scalar(saturationDifference?.min ?? null, 'CH1-CH2'),
      vce_saturation_max: scalar(saturationDifference?.max ?? null, 'CH1-CH2'),
      vce_saturation_mean: scalar(saturationDifference?.mean ?? null, 'CH1-CH2'),
    },
    recorded,
  )
  expect(await numeric('distortion', 'vce_cutoff_mean')).toBe(savedCutoff)
  expect(await numeric('distortion', 'vce_saturation_mean')).toBeLessThan(savedCutoff)
  await turnOff()
  await completeStep('analyse', '', 13)
  for (const table of tableIds) await expectRecorded(table, recorded)
  await page.screenshot({ path: test.info().outputPath('md03-complete.png') })
  await page.getByRole('button', { name: '重置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '重置当前实训？', exact: true })
  await dialog.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(dialog).toBeHidden()
  await showWiring()
  await expect(editor()).toHaveAttribute('data-wire-count', '0')
  await expect(editor()).toHaveAttribute('data-undo-count', '0')
  await expect(editor()).toHaveAttribute('data-redo-count', '0')
  await showSteps()
  await expectStep('prepare', 0)
  for (const table of tableIds) {
    await showTable(table)
    for (const column of project.dataTables.find((entry) => entry.id === table)?.columns ?? []) {
      await expect(cell(table, column.id)).toHaveValue('')
      await expect(cell(table, column.id)).toHaveAttribute('data-captured-from', '')
    }
  }
  await expect(page.getByRole('button', { name: '上电', exact: true })).toBeVisible()
})

test('MD-03 已声明控件连续改参，并通过实际 B/E、C/E 探测证明截止与饱和', async () => {
  await prepareSources()
  await wireSources()
  await connectScopeGain()
  await turnOn()
  const initial = await waitScope(1000)
  const gainOn = (initial.channels[1]?.vpp ?? 0) / (initial.channels[0]?.vpp ?? 1)
  const before = await clientStats()
  const timeBefore = await scopeTime()
  await setModuleCE(false)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __md03AlteredEvents: AlteredEvent[] }).__md03AlteredEvents.some((event) =>
          event.changes.some((change) => change.param === 'p_amp1_kce' && change.value === 0),
        ),
      ),
    )
    .toBe(true)
  const afterCE = await waitScope(1000, false, timeBefore)
  const gainOff = (afterCE.channels[1]?.vpp ?? 0) / (afterCE.channels[0]?.vpp ?? 1)
  expect(gainOn / gainOff).toBeGreaterThan(50)
  expect((await clientStats()).sessions).toBe(before.sessions)
  expect((await clientStats()).lastSeq).toBeGreaterThan(before.lastSeq)
  const rwTime = await scopeTime()
  await setModuleRW(40000)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __md03AlteredEvents: AlteredEvent[] }).__md03AlteredEvents.some((event) =>
          event.changes.some((change) => change.param === 'p_amp1_rw' && change.value === 40000),
        ),
      ),
    )
    .toBe(true)
  await waitScope(1000, false, rwTime)
  expect((await clientStats()).sessions).toBe(before.sessions)

  await turnOff()
  await setModuleCE(true)
  await setModuleRW(100000)
  await configureGenerator(1000, 2)
  await replaceScopeSignals('amp1.AMP_UB', 'amp1.AMP_UE')
  await configureScope(1000)
  await selectOption(scope(), 'CH1 V/div', '2 V/div')
  await selectOption(scope(), 'CH2 V/div', '1 V/div')
  await exact(scope(), 'CH1 垂直位移', -2)
  await exact(scope(), 'CH2 垂直位移', -2)
  await turnOn()
  await waitScope(1000)
  await expect.poll(async () => (await waveMetrics('vbe'))?.min ?? 1).toBeLessThan(-0.2)
  const cutoff = await waveMetrics('vbe')
  expect(cutoff?.max ?? 0).toBeGreaterThan(0.6)
  expect(cutoff?.fractionBelow ?? 0).toBeGreaterThan(0.05)
  await page.screenshot({ path: test.info().outputPath('md03-real-vbe-cutoff.png') })

  await turnOff()
  await configureGenerator(1000, 1)
  await setModuleRW(18000)
  await replaceScopeSignals('amp1.AMP_UC', 'amp1.AMP_UE')
  await configureScope(1000, true)
  await turnOn()
  await waitScope(1000, true)
  await expect.poll(async () => (await waveMetrics('vce'))?.min ?? 1).toBeLessThan(0.2)
  const saturation = await waveMetrics('vce')
  expect(saturation?.min ?? -1).toBeGreaterThanOrEqual(0)
  expect(saturation?.fractionBelow ?? 0).toBeGreaterThan(0.1)
  await page.screenshot({ path: test.info().outputPath('md03-real-vce-saturation.png') })
})

test('MD-03 GND耦合、未接参考地和断电旧波形不能冒充有效示波器记录', async () => {
  const recorded = new Map<string, RecordedCell>()
  await prepareAndWire()
  await staticPoints(recorded)
  await connectScopeGain()
  await turnOn()
  await waitScope(1000)
  await selectOption(scope(), 'CH2 耦合', 'GND 接地')
  await page.getByRole('button', { name: '记录读数', exact: true }).click()
  await showSteps()
  await expectStep('gain', 6)
  await showTable('gain')
  await expect(cell('gain', 'uo_vpp')).toHaveValue('')
  await expect(cell('gain', 'au')).toHaveValue('')
  const inputBefore = await numeric('gain', 'ui_vpp')
  await turnOff()
  await removeWires('li[data-wire-a="scope1.GND"], li[data-wire-b="scope1.GND"]', 1)
  await openInstrumentPanel(page, '双通道数字示波器')
  await selectOption(scope(), 'CH2 耦合', 'DC 直流耦合')
  await turnOn()
  await expect.poll(scopeTime, { timeout: 15_000 }).toBeGreaterThan(0.25)
  await page.getByRole('button', { name: '记录读数', exact: true }).click()
  await showSteps()
  await expectStep('gain', 6)
  await showTable('gain')
  expect(await numeric('gain', 'ui_vpp')).toBe(inputBefore)
  await expect(cell('gain', 'uo_vpp')).toHaveValue('')
  await turnOff()
  await addWire('scope1.GND', 'amp1.AMP_GND2')
  await turnOn()
  const valid = await waitScope(1000)
  await record(
    'gain',
    'ri',
    7,
    'gain',
    {
      frequency: scalar(valid.channels[0]?.frequency ?? null, 'CH1'),
      ui_vpp: scalar(valid.channels[0]?.vpp ?? null, 'CH1'),
      uo_vpp: scalar(valid.channels[1]?.vpp ?? null, 'CH2'),
    },
    recorded,
  )
  await turnOff()
  await page.getByRole('button', { name: '记录读数', exact: true }).click()
  await showSteps()
  await expectStep('ri', 7)
  await showTable('ri')
  for (const column of ['frequency', 'us_vpp', 'ui_vpp', 'ri_est']) await expect(cell('ri', column)).toHaveValue('')
  await page.screenshot({ path: test.info().outputPath('md03-waveform-recording-guards.png') })
})
