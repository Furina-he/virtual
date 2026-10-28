import { mkdtempSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

type SubmittedFrame = { deltaMs: number; draws: number; triangles: number; camera: string }
declare global {
  interface Window {
    __scenePerformance: {
      active: boolean
      context: WebGLRenderingContext | WebGL2RenderingContext | null
      draws: number
      triangles: number
      startedAt: number
      frames: SubmittedFrame[]
    }
  }
}

test('current-machine 1080p active-render measurements, not baseline-hardware certification', async () => {
  const testInfo = test.info()
  test.setTimeout(90_000)
  const profile = mkdtempSync(join(tmpdir(), 'virtual-scene-performance-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, VIRTUAL_USER_DATA: profile } })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const gpu = await app.evaluate(async ({ app, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1920, 1080)
      return { features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }
    })
    await page.addInitScript(() => {
      const probe = {
        active: false,
        context: null as WebGLRenderingContext | WebGL2RenderingContext | null,
        draws: 0,
        triangles: 0,
        startedAt: 0,
        frames: [] as SubmittedFrame[],
      }
      window.__scenePerformance = probe
      for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
          const original = Object.getOwnPropertyDescriptor(prototype, name)?.value
          if (typeof original !== 'function') continue
          Object.defineProperty(prototype, name, {
            configurable: true,
            writable: true,
            value: function (this: WebGLRenderingContext, ...args: number[]) {
              if (probe.active && probe.context === this) {
                const count = args[name.startsWith('drawArrays') ? 2 : 1] ?? 0
                const instances = name.endsWith('Instanced') ? (args.at(-1) ?? 1) : 1
                probe.draws++
                probe.triangles +=
                  (args[0] === this.TRIANGLES
                    ? count / 3
                    : args[0] === this.TRIANGLE_STRIP || args[0] === this.TRIANGLE_FAN
                      ? Math.max(0, count - 2)
                      : 0) * instances
              }
              return Reflect.apply(original, this, args)
            },
          })
        }
      }
      let previous = performance.now()
      const sample = (now: number) => {
        if (probe.active && probe.draws > 0) {
          const region = document.querySelector<HTMLElement>('[aria-label="3D 实训台"]')
          probe.frames.push({
            deltaMs: now - previous,
            draws: probe.draws,
            triangles: probe.triangles,
            camera: region?.dataset.cameraPosition ?? '',
          })
          probe.draws = 0
          probe.triangles = 0
          previous = now
        } else if (!probe.active) previous = now
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await page.reload()
    await page.waitForFunction(() => innerWidth === 1920 && innerHeight === 1080)
    const region = page.getByRole('region', { name: '3D 实训台' })
    await expect(region).toHaveAttribute('data-assets-state', 'ready', { timeout: 30_000 })
    const reloadStartupMs = Number(await region.getAttribute('data-startup-ms'))
    for (const name of ['显示/收起左栏', '显示/收起右栏', '显示/收起底栏']) {
      await page.getByRole('button', { name, exact: true }).click()
    }
    for (const id of ['left', 'right']) {
      await expect
        .poll(async () => (await page.locator(`[data-slot="resizable-panel"]#${id}`).boundingBox())?.width)
        .toBe(0)
    }
    await expect
      .poll(async () => (await page.locator('[data-slot="resizable-panel"]#bottom').boundingBox())?.height)
      .toBe(0)
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    const results = []
    for (const [quality, label] of [
      ['high', '高画质'],
      ['medium', '中画质'],
      ['low', '低画质'],
    ] as const) {
      await region.getByRole('button', { name: label, exact: true }).click()
      await expect(region).toHaveAttribute('data-quality', quality)
      await expect(region).toHaveAttribute('data-assets-state', 'ready', { timeout: 15_000 })
      await region.getByRole('button', { name: '操作视角', exact: true }).click()
      await expect(region).toHaveAttribute('data-camera-moving', 'false')
      await expect
        .poll(async () => {
          const frame = await region.locator('[data-slot="bench-canvas-frame"]').boundingBox()
          const canvas = await region.locator('canvas').boundingBox()
          return (
            !!frame &&
            !!canvas &&
            Math.abs(frame.width - canvas.width) < 1 &&
            Math.abs(frame.height - canvas.height) < 1
          )
        })
        .toBe(true)
      await page.waitForTimeout(350)
      const canvas = region.locator('canvas')
      const bounds = await canvas.boundingBox()
      if (!bounds) throw new Error('Missing benchmark canvas')
      await page.mouse.move(bounds.x + bounds.width * 0.08, bounds.y + bounds.height * 0.12)
      await page.mouse.down()
      const display = await canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement
        const gl = canvas.getContext('webgl2')
        if (!gl) throw new Error('WebGL2 is unavailable')
        const debug = gl.getExtension('WEBGL_debug_renderer_info')
        const probe = window.__scenePerformance
        Object.assign(probe, {
          context: gl,
          active: true,
          draws: 0,
          triangles: 0,
          frames: [],
          startedAt: performance.now(),
        })
        return {
          cssWidth: canvas.clientWidth,
          cssHeight: canvas.clientHeight,
          pixelWidth: canvas.width,
          pixelHeight: canvas.height,
          devicePixelRatio,
          actualDpr: canvas.width / canvas.clientWidth,
          renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
          vendor: gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
          version: gl.getParameter(gl.VERSION),
          contextAttributes: gl.getContextAttributes(),
        }
      })
      const started = Date.now()
      while (Date.now() - started < 12_000) {
        const phase = (Date.now() - started) / 600
        await page.mouse.move(
          bounds.x + bounds.width * 0.08 + Math.sin(phase) * 65,
          bounds.y + bounds.height * 0.12 + Math.sin(phase * 0.6) * 24,
        )
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      const measured = await page.evaluate(() => {
        const probe = window.__scenePerformance
        probe.active = false
        return { elapsedMs: performance.now() - probe.startedAt, frames: probe.frames }
      })
      const deltas = measured.frames.map((frame) => frame.deltaMs).sort((a, b) => a - b)
      const averageFps = (measured.frames.length * 1000) / measured.elapsedMs
      const result = {
        quality,
        display,
        startupMs: Number(await region.getAttribute('data-startup-ms')),
        durationMs: measured.elapsedMs,
        renderedFrames: measured.frames.length,
        distinctCameraPositions: new Set(measured.frames.map((frame) => frame.camera)).size,
        averageFps,
        p95FrameMs: deltas[Math.ceil(deltas.length * 0.95) - 1] ?? 0,
        maxSubmittedDraws: Math.max(...measured.frames.map((frame) => frame.draws)),
        maxSubmittedTriangles: Math.max(...measured.frames.map((frame) => frame.triangles)),
        currentMachine30Fps: averageFps >= 30,
      }
      results.push(result)
      await expect(region).toHaveAttribute('data-wire-count', '0')
      await expect(region).toHaveAttribute('data-pending-jack', '')
    }
    const report = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      baselineCertified: false,
      method:
        '12 s continuous mouse camera orbit per tier; rAF samples count only frames with actual WebGL draw submissions; warmed contact shadows excluded; all submitted passes counted; FPS is rendered frames / wall time, not idle rAF rate.',
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      os: { platform: platform(), release: release(), arch: arch() },
      gpu,
      contentCss: [1920, 1080],
      reloadStartupMs,
      results,
    }
    writeFileSync(testInfo.outputPath('scene-performance.json'), `${JSON.stringify(report, null, 2)}\n`)
    await testInfo.attach('scene-performance', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    })
    for (const result of results) {
      expect(result.renderedFrames, result.quality).toBeGreaterThan(30)
      expect(result.distinctCameraPositions, result.quality).toBeGreaterThan(10)
      expect(Number.isFinite(result.averageFps) && result.p95FrameMs > 0, result.quality).toBe(true)
      expect(result.maxSubmittedDraws, result.quality).toBeLessThanOrEqual(100)
      expect(result.maxSubmittedTriangles, result.quality).toBeLessThanOrEqual(150_000)
    }
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
