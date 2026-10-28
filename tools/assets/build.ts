import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { embeddedPanelFont } from './font.ts'
import { writeAssetManifest } from './lint.ts'
import { panelSvg } from './panels.ts'
import { modelOutputPath, workspacePath, workspaceRoot } from './paths.ts'
import { writeLicenses } from './provenance.ts'
import { checkSources, importedSource } from './sources.ts'
import type { AssetDefinition } from './types.ts'

const missing = checkSources()
if (missing.length) throw new Error(missing.join('\n'))
const catalog: { assets: AssetDefinition[] } = JSON.parse(
  readFileSync(workspacePath('assets/layouts/catalog.json'), 'utf8'),
)
const outputs = new Set<string>()
for (const asset of catalog.assets) {
  importedSource(asset)
  modelOutputPath(asset.model)
  if (outputs.has(asset.model)) throw new Error(`Duplicate asset output: ${asset.model}`)
  outputs.add(asset.model)
  if (asset.kind !== 'component' && !asset.sourceFile) {
    const base = asset.model.slice(0, asset.model.lastIndexOf('/'))
    if (outputs.has(`${base}/panel.svg`)) throw new Error(`Duplicate panel output: ${base}`)
    outputs.add(`${base}/panel.svg`)
    outputs.add(`${base}/panel.webp`)
  }
}

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/javascript',
  '.json': 'application/json',
  '.gltf': 'model/gltf+json',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}
const prefixes = ['tools/assets/', 'assets/layouts/', 'assets/vendor/', 'node_modules/three/']
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/panel-font.css') {
      const asset = catalog.assets.find((entry) => entry.id === url.searchParams.get('asset'))
      if (!asset) throw new Error('Unknown panel font request')
      response.setHeader('Content-Type', 'text/css')
      response.end(embeddedPanelFont(panelSvg(asset)))
      return
    }
    if (request.method === 'POST' && url.pathname === '/output') {
      const path = url.searchParams.get('path') ?? ''
      if (!outputs.has(path)) throw new Error(`Not a declared asset output: ${path}`)
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 32 * 1024 * 1024) throw new Error('Asset exceeds 32 MiB')
        chunks.push(chunk)
      }
      const target = workspacePath(path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.concat(chunks))
      response.end('ok')
      return
    }
    const path = decodeURIComponent(url.pathname.slice(1))
    if (request.method !== 'GET' || !prefixes.some((prefix) => path.startsWith(prefix))) {
      response.writeHead(404).end('Not found')
      return
    }
    const full = workspacePath(path)
    const body = extname(full) === '.ts' ? stripTypeScriptTypes(readFileSync(full, 'utf8')) : readFileSync(full)
    response.setHeader('Content-Type', mime[extname(full)] ?? 'application/octet-stream')
    response.end(body)
  } catch (error) {
    response.writeHead(400).end(error instanceof Error ? error.message : String(error))
  }
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Exporter server has no port')
const tempRoot = resolve(tmpdir())
const profile = mkdtempSync(join(tempRoot, 'virtual-asset-export-'))
let app: Awaited<ReturnType<typeof electron.launch>> | undefined
try {
  // A hidden Chromium canvas supplies SVG/WebP and FileReader without adding image/CAD dependencies.
  app = await electron.launch({
    args: [workspacePath('tools/assets/export-host.cjs')],
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ASSET_EXPORT_URL: `http://127.0.0.1:${address.port}/tools/assets/export.html`,
      ASSET_EXPORT_USER_DATA: profile,
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  await page.waitForFunction(() => window.assetExport?.done, undefined, { timeout: 120_000 })
  const result = await page.evaluate(() => window.assetExport)
  if (result.error) throw new Error(result.error)
  writeLicenses(catalog.assets)
  const report = writeAssetManifest()
  if (report.issues.length) throw new Error(report.issues.join('\n'))
  console.log(
    `Built ${result.results.length} GLBs offline; ${report.preview.triangles} preview triangles / ${report.preview.drawCalls} mesh draws`,
  )
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  const target = resolve(profile)
  if (dirname(target) !== tempRoot || !basename(target).startsWith('virtual-asset-export-')) {
    console.error('Refusing to remove an exporter profile outside its temporary directory')
    process.exitCode = 1
  } else {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
