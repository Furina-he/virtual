// T0.4 验收：连续运行无丢块、渲染主线程无长任务；sim 进程被杀后 2 s 内恢复并提示。
// 依赖主布局挂载 useSimRestartNotice（它会创建 sim-client 并挂到 window.__simClient）。
// 运行时长由 SIM_SOAK_SEC 控制，默认 20 s；验收跑 600 s。
// T0.6：sim 进程内存须有上界（向量定期截断，技术设计 §5.4），记录首末内存。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from '@playwright/test'
import type { SimCommand } from '../../src/shared/ipc/sim'

const SOAK_SEC = Number(process.env.SIM_SOAK_SEC ?? 20)
const STEP = 20e-6

const LOAD: SimCommand = {
  type: 'load',
  netlist: ['sine 1k', 'V1 in 0 SIN(0 1 1k)', 'R1 in out 1k', 'R2 out 0 1k', '.end'].join('\n'),
  probes: [{ id: 'out', kind: 'v', node: 'out' }],
  analysis: { kind: 'tran', step: STEP, continuous: true },
}

interface Stats {
  blocks: number
  lostBlocks: number
  lastSeq: number
  points: number
  sessions: number
  restarts: number
}

declare global {
  interface Window {
    __simClient?: { stats: Stats; send: (c: SimCommand) => Promise<void> }
    __longTasks?: number[]
  }
}

let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-e2e-'))
  app = await electron.launch({ args: ['.'], env: { ...process.env, VIRTUAL_USER_DATA: userData } })
  win = await app.firstWindow()
  await win.waitForFunction(() => window.__simClient !== undefined)
  // Measure running simulation after the same first-render readiness gate used by the power button.
  await expect(win.getByRole('region', { name: '3D 实训台' })).toHaveAttribute('data-assets-state', 'ready', {
    timeout: 30_000,
  })
  await expect(win.getByRole('button', { name: '上电', exact: true })).toBeEnabled()
})

test.afterEach(async () => {
  await app.close()
})

const stats = () => win.evaluate(() => ({ ...(window.__simClient as { stats: Stats }).stats }))

async function start(): Promise<void> {
  await win.evaluate(async (load) => {
    const c = window.__simClient
    await c?.send(load)
    await c?.send({ type: 'run' })
  }, LOAD)
  await expect.poll(async () => (await stats()).blocks, { timeout: 5000 }).toBeGreaterThan(0)
}

test(`1 kHz 正弦连续运行 ${SOAK_SEC} s：块序号连续、无丢块，主线程长任务 <50 ms`, async () => {
  test.setTimeout((SOAK_SEC + 60) * 1000)
  await win.evaluate(() => {
    window.__longTasks = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks?.push(e.duration)
    }).observe({ type: 'longtask', buffered: false })
  })
  await start()
  const begin = await stats()
  const t0 = Date.now()
  let maxSimMb = 0
  const memSamples: number[] = []
  // 每 10 s 记录一次 sim 进程内存
  while (Date.now() - t0 < SOAK_SEC * 1000) {
    await win.waitForTimeout(Math.min(10_000, SOAK_SEC * 1000 - (Date.now() - t0)))
    const mb = await app.evaluate(({ app }) => {
      const m = app.getAppMetrics().find((p) => p.type === 'Utility' && p.name === 'virtual-sim')
      return (m?.memory.workingSetSize ?? 0) / 1024
    })
    maxSimMb = Math.max(maxSimMb, mb)
    memSamples.push(mb)
  }
  const wall = (Date.now() - t0) / 1000
  const end = await stats()
  const longTasks = await win.evaluate(() => window.__longTasks ?? [])
  const simSec = (end.points - begin.points) * STEP
  const maxLong = Math.max(0, ...longTasks)
  console.log(
    `墙钟 ${wall.toFixed(1)} s，仿真 ${simSec.toFixed(1)} s，块 ${end.blocks}（seq 0..${end.lastSeq}），丢块 ${end.lostBlocks}，` +
      `长任务 ${longTasks.length} 个、最长 ${maxLong.toFixed(0)} ms，sim 进程内存峰值 ${maxSimMb.toFixed(0)} MB，` +
      `逐 10 s 采样 [${memSamples.map((m) => m.toFixed(0)).join(' ')}] MB`,
  )
  expect(end.lostBlocks).toBe(0)
  expect(end.lastSeq + 1).toBe(end.blocks)
  expect(end.sessions).toBe(1)
  // 实时推进：仿真时间跟上墙钟
  expect(simSec).toBeGreaterThan(wall * 0.9)
  expect(maxLong).toBeLessThan(50)
  // 未截断时约 1.7 MB/s（10 分钟约 1 GB）；截断后首末差应远小于此
  const first = memSamples[0] ?? 0
  expect(maxSimMb - first).toBeLessThan(Math.max(30, SOAK_SEC * 0.15))
})

test('杀掉 sim 进程后 2 s 内恢复并提示"仿真已重启"', async () => {
  await start()
  const pid = await app.evaluate(() => (globalThis as { __virtualSim?: { pid?: number } }).__virtualSim?.pid)
  expect(pid).toBeGreaterThan(0)
  const before = await stats()
  const t0 = Date.now()
  process.kill(pid as number)
  // 新会话（重新下发网表）开始出块
  await expect
    .poll(
      async () => {
        const s = await stats()
        return s.sessions > before.sessions && s.blocks > 0
      },
      { timeout: 2000, intervals: [50] },
    )
    .toBe(true)
  const recovered = Date.now() - t0
  await expect(win.getByText('仿真已重启')).toBeVisible({ timeout: Math.max(200, 2000 - recovered) })
  const newPid = await app.evaluate(() => (globalThis as { __virtualSim?: { pid?: number } }).__virtualSim?.pid)
  console.log(`重启恢复用时 ${recovered} ms，pid ${pid} → ${newPid}`)
  expect(newPid).not.toBe(pid)
  expect((await stats()).restarts).toBe(1)
})
