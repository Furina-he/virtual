import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const root = realpathSync(resolve(import.meta.dirname, '..'))
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }).trim()
if (realpathSync(git('rev-parse', '--show-toplevel')) !== root || git('branch', '--show-current') !== 'codex/sd22')
  throw new Error('Run the SD-22 evidence index only in its independent codex/sd22 worktree')

function local(path: string): string {
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Evidence path escapes worktree')
  if (existsSync(target)) {
    const actual = relative(root, realpathSync(target))
    if (!actual || actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual))
      throw new Error('Evidence symlink escapes worktree')
  }
  return target
}

const sourceCommits =
  '65f9575 2344cef e54b210 bdda377 701033f d1d7282 5315097 c1f3528 4089286 753b6c3 604e6b9 a9fb952 bc5bb81 afa5a97'.split(
    ' ',
  )
const history = git('log', '--format=%H%x09%s', '--max-count=200')
  .split('\n')
  .map((line) => ({ hash: line.slice(0, 40), subject: line.slice(41) }))
const imports = sourceCommits.map((source) => {
  const sourceCommit = git('rev-parse', `${source}^{commit}`)
  const subject = git('show', '-s', '--format=%s', sourceCommit)
  const imported = history.find((entry) => entry.subject === subject)
  return {
    sourceCommit,
    importedCommit: imported?.hash ?? null,
    subject,
    mapping: 'Subject match, not an ancestry assertion',
  }
})
const localPublicFixes = ['a47d96d', ...process.argv.slice(2)].map((ref) => {
  if (!/^[a-f0-9]{7,40}$/i.test(ref)) throw new Error('Additional public fix arguments must be commit hashes')
  return { hash: git('rev-parse', `${ref}^{commit}`), subject: git('show', '-s', '--format=%s', ref) }
})

function classification(name: string) {
  const baseline =
    /^(sd22-realtime-baseline\/|t015-sd22-module-asset|t015-sd22-content-wiring\.(?:png|webm)$|sd22-(unit-golden-(?:full|final)\.log$|e2e-full\.log$|e2e-final-targeted\.log$|project-prototype-review|step-review))/.test(
      name,
    )
  const stage = baseline ? 'baseline' : /(?:-first(?:\.|-)|-red\.)/.test(name) ? 'first-failure' : 'current'
  const kind = /^initial-readings-/.test(name)
    ? 'unit/native-boundary'
    : /recorded-audio|native-codec|audio-lifecycle/.test(name)
      ? 'audio'
      : /realtime|performance/.test(name)
        ? 'performance'
        : /buffered-|golden/.test(name)
          ? 'golden'
          : /workflow|e2e/.test(name)
            ? 'e2e'
            : /long-window|unit|related-tests/.test(name)
              ? 'unit'
              : 'static'
  return {
    stage,
    kind,
    role: kind === 'performance' ? 'diagnostic' : 'attempt',
    successfulWorkflow: false,
    complete: false,
  }
}

function meaning(name: string): string {
  if (/^initial-readings-/.test(name))
    return 'Public first-native-sample boundary proof; genuine zero readings and trim remain valid'
  if (/recorded-audio/.test(name))
    return 'Chromium decode of actual encoded app recording; distinguish this from sample/scheduling observations'
  if (/^t015-sd22-content-wiring.*\.webm$/.test(name))
    return 'Historical unpowered content/wiring video; no audio or full workflow'
  if (/realtime.*\.webm$/.test(name))
    return 'Actual app frame/audio performance capture; realtime failure is not workflow success'
  if (/workflow/.test(name)) return 'Attempted guided production workflow; completeness is not asserted by this index'
  if (/audio-lifecycle/.test(name))
    return 'Production sound disposal/reset/switch observations; not complete two-mode acceptance'
  if (/native-codec/.test(name)) return 'Native captured-media decode evidence; inspect its explicit result separately'
  if (/long-window/.test(name))
    return 'Pure unit startup/ripple/finite-window evidence; not ngspice realtime performance'
  if (/buffered-|prototype-review|step-review/.test(name))
    return 'Independent real circuit/model analysis; offline proof is not realtime acceptance'
  if (/asset|schematic/.test(name))
    return 'Local artwork, geometry or provenance verification; not electrical operation'
  if (/realtime/.test(name))
    return 'Production same-stream clock/CPU/audio diagnostic; original performance thresholds remain'
  return 'Validation artifact; retain first failures and consult the file rather than inferring completion'
}

function result(name: string, path: string): string {
  if (!name.endsWith('.log')) return 'not-inferred'
  const text = readFileSync(path, 'utf8')
  if (/\b[1-9]\d* failed\b|AssertionError|ELIFECYCLE.*(?:exit|failed)|RED_EXIT=1|GREEN_EXIT=1/.test(text))
    return 'failed'
  if (/\b[1-9]\d* passed\b|\b0 issues\b|GREEN_EXIT=0/.test(text)) return 'passed'
  return 'not-inferred'
}

const build = local('build')
const initialReadings = /^initial-readings-(?:20261030-(?:red|green)\.log|[05]V-[A-Za-z0-9-]+\.json)$/
const names = readdirSync(build, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      (/^(sd22-|t015-sd22-).+\.(log|json|png|webm)$/.test(entry.name) || initialReadings.test(entry.name)),
  )
  .map((entry) => entry.name)
  .sort()
const baselineDir = 'sd22-realtime-baseline'
if (existsSync(local(join('build', baselineDir)))) {
  const allowed =
    /^(?:sd22-(?:ambulance|fire-buffered)-realtime[^/]*\.(?:log|json|png|webm)|sd22-formal-realtime-first\.log)$/
  names.push(
    ...readdirSync(local(join('build', baselineDir)), { withFileTypes: true })
      .filter((entry) => entry.isFile() && allowed.test(entry.name))
      .map((entry) => `${baselineDir}/${entry.name}`),
  )
}
const artifacts = names.map((name) => {
  const path = local(join('build', name))
  return {
    path,
    bytes: statSync(path).size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    meaning: meaning(name),
    classification: classification(name),
    result: result(name, path),
    capture: name.endsWith('.webm')
      ? /realtime/.test(name)
        ? 'own-app-frame-and-audio'
        : /^t015-sd22-content-wiring/.test(name)
          ? 'historical-video-without-audio'
          : 'attempt-not-audited'
      : 'not-media',
  }
})
const expectedAudio = ['sd22-ambulance-realtime-recorded-audio.json', 'sd22-fire-buffered-realtime-recorded-audio.json']
const pendingArtifacts = expectedAudio
  .filter((name) => !names.includes(name))
  .map((name) => ({ path: local(join('build', name)), status: 'pending' }))
const output = local('build/sd22-handoff')
mkdirSync(output, { recursive: true })
writeFileSync(
  join(output, 'evidence-index.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      workspace: root,
      git: { head: git('rev-parse', 'HEAD'), branch: 'codex/sd22', imports, localPublicFixes },
      successfulWorkflow: false,
      limitations: [
        'This index hashes attempts and failures; no complete successful SD-22 workflow is asserted.',
        'Historical PCM A underruns and list-selection focus failures remain open observations; later passes do not overwrite them.',
        'Offline golden/model evidence does not satisfy realtime audio/performance or target-machine acceptance.',
        'Source SHA and cherry-pick SHA are distinct; subject matching does not claim source ancestry or patch equivalence.',
        'Only task-prefixed files, initial-readings and the shallow sd22-realtime-baseline directory are indexed; no profiles or file contents are embedded.',
      ],
      artifacts,
      pendingArtifacts,
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  join(output, 'hashes.sha256'),
  `${artifacts.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
)
console.log(`Indexed ${artifacts.length} task artifacts in ${output}; successfulWorkflow=false`)
