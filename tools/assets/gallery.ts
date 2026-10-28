import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { embeddedPanelFont } from './font.ts'
import { workspacePath, workspaceRoot } from './paths.ts'
import type { AssetCatalog } from './types.ts'

const catalog: AssetCatalog = JSON.parse(readFileSync(workspacePath('assets/layouts/catalog.json'), 'utf8'))
const assets = catalog.assets.filter((asset) => asset.kind === 'component')
const models = new Set(assets.map((asset) => asset.model))
const font = embeddedPanelFont(`${JSON.stringify(assets)} Component / tool asset verification`)
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src data:; img-src data:; connect-src 'self'">
<title>Component asset verification</title><style>${font}
*{box-sizing:border-box}body{margin:0;padding:28px;background:hsl(210,8%,95%);color:hsl(210,10%,18%);font:14px 'Asset Panel Font',sans-serif}
h1{margin:0 0 6px;font-size:23px;font-weight:600}p{margin:0 0 20px;color:hsl(210,6%,38%)}
main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
figure{margin:0;border:1px solid hsl(210,7%,81%);background:hsl(210,8%,97%)}
figure img{display:block;width:100%;height:224px;object-fit:contain}figcaption{padding:12px 14px;border-top:1px solid hsl(210,7%,86%)}
strong,code,small{display:block}strong{font-size:16px;font-weight:600}code{margin:4px 0;font-size:12px}small{font-size:12px;color:hsl(210,6%,36%)}
</style><script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
</head><body><h1>Component / tool asset verification</h1><p>Actual GLB files. Visual scale normalized per item; dimensions are estimates, not pinout specifications.</p>
<main></main><script type="module" src="/gallery-browser.ts"></script></body></html>`

const mime: Record<string, string> = { '.js': 'text/javascript', '.glb': 'model/gltf-binary' }
const server = createServer((request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname.slice(1))
    if (request.method !== 'GET') return void response.writeHead(405).end()
    if (!path) return void response.setHeader('Content-Type', 'text/html').end(html)
    if (path === 'catalog.json') {
      return void response.setHeader('Content-Type', 'application/json').end(JSON.stringify(assets))
    }
    if (path === 'gallery-browser.ts') {
      const source = readFileSync(workspacePath('tools/assets/gallery-browser.ts'), 'utf8')
      return void response.setHeader('Content-Type', 'text/javascript').end(stripTypeScriptTypes(source))
    }
    if (!models.has(path) && !(path.startsWith('node_modules/three/') && !path.split('/').includes('..'))) {
      return void response.writeHead(404).end()
    }
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream')
    response.end(readFileSync(workspacePath(path)))
  } catch (error) {
    response.writeHead(400).end(error instanceof Error ? error.message : String(error))
  }
})

await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Gallery server has no port')
const tempRoot = resolve(tmpdir())
const profile = mkdtempSync(join(tempRoot, 'virtual-component-gallery-'))
let app: Awaited<ReturnType<typeof electron.launch>> | undefined
try {
  app = await electron.launch({
    args: [workspacePath('tools/assets/export-host.cjs')],
    cwd: workspaceRoot,
    env: { ...process.env, ASSET_EXPORT_URL: `http://127.0.0.1:${address.port}/`, ASSET_EXPORT_USER_DATA: profile },
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.assetGallery?.done, undefined, { timeout: 60_000 })
  const status = await page.evaluate(() => window.assetGallery)
  if (status.error) throw new Error(status.error)
  if (status.count !== assets.length || !status.count) throw new Error('Incomplete component gallery')
  const output = workspacePath('assets/generated/component-gallery.png')
  mkdirSync(dirname(output), { recursive: true })
  await page.screenshot({ path: output, fullPage: true })
  console.log(`Verified ${status.count} actual GLBs; saved ${output}`)
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  const target = resolve(profile)
  if (dirname(target) !== tempRoot || !basename(target).startsWith('virtual-component-gallery-')) {
    console.error('Refusing to remove a profile outside the gallery temp directory')
    process.exitCode = 1
  } else {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
