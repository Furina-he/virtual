import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('启动后显示 shadcn Button、使用本地字体，且无外网请求', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'virtual-e2e-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, VIRTUAL_USER_DATA: userData } })
  const win = await app.firstWindow()

  const button = win.getByRole('button', { name: '上电' })
  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute('data-slot', 'button')

  const fontFamily = await win.evaluate(() => getComputedStyle(document.body).fontFamily)
  expect(fontFamily).toContain('Noto Sans SC Variable')
  const loaded = await win.evaluate(async () => {
    // 中文字体按字符分片加载，先请求再检查
    await document.fonts.load('14px "Noto Sans SC Variable"', '基尔霍夫')
    return document.fonts.check('14px "Noto Sans SC Variable"', '基尔霍夫')
  })
  expect(loaded).toBe(true)

  // 正常启动不应产生任何外网请求
  const log = join(userData, 'logs', 'network-blocked.log')
  expect(existsSync(log)).toBe(false)

  // 渲染进程的外网请求先被 CSP 拦下；这里从主进程发请求，验证 webRequest 拦截与日志
  await app.evaluate(({ net }) => net.fetch('https://example.com/').catch(() => undefined))
  await app.close()

  expect(existsSync(log)).toBe(true)
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('https://example.com/')
})
