// Opt-in native diagnostic, never an acceptance substitute. Run via the shared exclusive wrapper.
// Node 22 needs NODE_OPTIONS=--experimental-transform-types for the existing TS parameter properties.
// Set it only for this development command, then restore it; never change Electron's production options.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { SimCommandSchema } from '../src/shared/ipc/sim.ts'
import { NgSpice } from '../src/sim/ngspice.ts'
import { SimSession, type SimSliceProfile } from '../src/sim/session.ts'

const args = process.argv.slice(2)
const inputPath = args[0]
if (!inputPath)
  throw new Error(
    'Usage: node tools/run-exclusive.ts script tools/sim-profile.ts <load.json> [--seconds=8] [--threads=1] [--klu] [--noref] [--window] [--output=path]',
  )

const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim()
const lock = resolve(common, 'codex-coordination', 'heavy-test.lock')
if (!existsSync(lock) || JSON.parse(readFileSync(lock, 'utf8')).pid !== process.ppid)
  throw new Error('Native profiling requires node tools/run-exclusive.ts script tools/sim-profile.ts ...')

const value = (key: string) => args.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
const seconds = Number(value('seconds') ?? 8)
const threads = value('threads') === undefined ? null : Number(value('threads'))
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120)
  throw new Error('Diagnostic wall budget must be in (0,120] seconds')
if (threads !== null && (!Number.isInteger(threads) || threads < 1 || threads > 64))
  throw new Error('Invalid native thread count')
const useKlu = args.includes('--klu')
const noref = args.includes('--noref')
const mode = args.includes('--window') ? 'window' : 'realtime'
const parsed = SimCommandSchema.parse(JSON.parse(readFileSync(resolve(inputPath), 'utf8')))
if (parsed.type !== 'load' || parsed.analysis.kind !== 'tran')
  throw new Error('Input must declare the actual transient load and every actual probe')
const command = {
  ...parsed,
  analysis: parsed.analysis,
  requestId: `profile-${randomUUID()}`,
  netlist: useKlu ? parsed.netlist.replace(/^\s*\.end\s*$/im, '.options klu\n.end') : parsed.netlist,
}
if (useKlu && command.netlist === parsed.netlist) throw new Error('KLU diagnostic requires an explicit .end line')

const path = resolve(
  value('output') ??
    `build/sim-profile-${basename(inputPath, '.json')}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`,
)
if (existsSync(path)) throw new Error(`Refusing to overwrite existing evidence: ${path}`)
const dir = resolve('resources/ngspice')
const ng = NgSpice.open(dir)
const profiles: SimSliceProfile[] = []
const resources: { at: number; simTime: number; lines: string[]; commandMs: number }[] = []
const errors: string[] = []
const totals = { blocks: 0, outputPoints: 0, outputBytes: 0, gaps: 0, nonfinite: 0 }
let lastSeq = -1
let lastEnd: number | undefined
let collecting: string[] | undefined
let lastResourceAt = Number.NEGATIVE_INFINITY
const setupLogs: string[] = []

const session = new SimSession(
  dir,
  (event) => {
    if (event.type === 'log') {
      if (collecting) collecting.push(event.line)
      else if (profiles.length === 0 && setupLogs.length < 100) setupLogs.push(event.line)
    }
    if (event.type === 'error') errors.push(`${event.message}: ${event.detail ?? ''}`)
    if (event.type !== 'chunk') return
    if (event.seq !== lastSeq + 1 || (lastEnd !== undefined && Math.abs(event.t0 - lastEnd) > event.dt * 0.001))
      totals.gaps++
    lastSeq = event.seq
    const n = Object.values(event.data)[0]?.length ?? 0
    lastEnd = event.t0 + n * event.dt
    totals.blocks++
    totals.outputPoints += n
    for (const samples of Object.values(event.data)) {
      totals.outputBytes += samples.byteLength
      for (const sample of samples) if (!Number.isFinite(sample)) totals.nonfinite++
    }
  },
  () => errors.push('Native process exited'),
  (profile) => {
    profiles.push(profile)
    const at = performance.now()
    if (at - lastResourceAt < 100) return
    lastResourceAt = at
    collecting = []
    try {
      ng.command(
        'rusage tranpoints accept rejected traniter trantime tranloadtime tranfactortime transolvetime trantrunctime',
      )
      resources.push({ at, simTime: profile.simTo, lines: collecting, commandMs: performance.now() - at })
    } catch (error) {
      errors.push(`rusage unavailable: ${String(error)}`)
    } finally {
      collecting = undefined
    }
  },
)

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
let wallMs = 0
try {
  if (threads !== null) ng.command(`set num_threads=${threads}`)
  if (noref) ng.command('set norefvalue')
  session.handle(command)
  session.handle({ type: 'setPacing', mode })
  const startedAt = performance.now()
  session.handle({ type: 'run' })
  await wait(seconds * 1000)
  wallMs = performance.now() - startedAt
  session.handle({ type: 'pause' })
  const deadline = performance.now() + 30_000
  while (ng.running() && performance.now() < deadline) await wait(5)
  await wait(20)
  if (ng.running()) throw new Error('Native slice failed to finish within the diagnostic tail budget')
} finally {
  session.dispose()
}

const timed = profiles.reduce(
  (sum, profile) => {
    for (const key of Object.keys(profile.ms) as (keyof SimSliceProfile['ms'])[]) sum[key] += profile.ms[key]
    return sum
  },
  Object.fromEntries(Object.keys(profiles[0]?.ms ?? {}).map((key) => [key, 0])) as SimSliceProfile['ms'],
)
const simSeconds = profiles.at(-1)?.simTo ?? 0
const report = {
  claim: 'Opt-in Node phase diagnostic only; not Electron realtime, audio, workflow or target-hardware acceptance.',
  input: resolve(inputPath),
  loadId: command.requestId,
  circuitHash: profiles[0]?.circuitHash ?? null,
  options: { seconds, threads, klu: useKlu, noref, pacing: mode, step: command.analysis.step, probes: command.probes },
  summary: { wallMs, simSeconds, approximateRatioIncludingTail: simSeconds / (wallMs / 1000), totals, phaseMs: timed },
  setupLogs,
  resources,
  profiles,
  errors,
}
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
console.log(`Native phase diagnostic: ${path}`)
console.log(JSON.stringify(report.summary, null, 2))
if (errors.length || totals.gaps || totals.nonfinite || profiles.length === 0) process.exitCode = 1
