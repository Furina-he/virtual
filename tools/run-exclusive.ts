import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const task = process.argv[2]
const args = process.argv.slice(3)
const node = process.execPath
const scripts: Record<string, string[][]> = {
  test: [['node_modules/vitest/vitest.mjs', 'run', ...args]],
  'test:golden': [['node_modules/vitest/vitest.mjs', 'run', ...(args.length ? args : ['tests/golden'])]],
  'build:app': [['node_modules/electron-vite/bin/electron-vite.js', 'build', ...args]],
  e2e: [
    ['node_modules/electron-vite/bin/electron-vite.js', 'build'],
    ['node_modules/@playwright/test/cli.js', 'test', ...args],
  ],
  'e2e:only': [['node_modules/@playwright/test/cli.js', 'test', ...args]],
  'assets:build': [['tools/assets/build.ts', ...args]],
  script: args.length ? [[args[0] as string, ...args.slice(1)]] : [],
}
if (!task || !scripts[task]) {
  console.error(`Usage: node tools/run-exclusive.ts ${Object.keys(scripts).join('|')} [arguments]`)
  process.exit(2)
}

const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
  windowsHide: true,
})
if (git.status !== 0) throw new Error('Cannot locate the shared Git directory for test coordination')
const path = resolve(git.stdout.trim(), 'codex-coordination', 'heavy-test.lock')
mkdirSync(resolve(path, '..'), { recursive: true })

// Other worktrees may still use an older direct CLI without reserving the shared lock.
if (process.platform === 'win32' && !existsSync(path)) {
  const probe = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -match '[/\\\\]vitest[/\\\\]vitest\\.mjs|[/\\\\]electron-vite[/\\\\]bin[/\\\\]electron-vite\\.js|[/\\\\]@playwright[/\\\\]test[/\\\\]cli\\.js|tools[/\\\\]assets[/\\\\]build\\.ts') } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  if (probe.status !== 0) throw new Error('Cannot verify other worktrees are idle before heavy validation')
  if (probe.stdout.trim()) {
    console.error(
      `A direct heavy validation process is still active. Wait for it to finish before reserving the slot.\n${probe.stdout.trim()}`,
    )
    process.exit(75)
  }
}
const token = randomUUID()
const owner = { token, pid: process.pid, task, args, worktree: process.cwd(), startedAt: new Date().toISOString() }
try {
  writeFileSync(path, JSON.stringify(owner, null, 2), { flag: 'wx' })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  console.error(
    `Heavy validation is already reserved. Do not run overlapping audio/performance tests.\n${readFileSync(path, 'utf8')}`,
  )
  process.exit(75)
}

function release() {
  if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path)
}
process.once('exit', release)
console.log(`Reserved shared validation slot: ${task} (${process.cwd()})`)

let code = 0
try {
  for (const [script, ...parameters] of scripts[task] ?? []) {
    code = await new Promise<number>((done, reject) => {
      const child = spawn(node, [resolve(script as string), ...parameters], {
        cwd: process.cwd(),
        stdio: 'inherit',
        windowsHide: true,
      })
      child.once('error', reject)
      child.once('exit', (status) => done(status ?? 1))
    })
    if (code) break
  }
} finally {
  release()
}
process.exitCode = code
