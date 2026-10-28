// Deliberately separate from the offline build: never fetch assets at application runtime.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { workspacePath } from './paths.ts'
import { readSources, sourceFileError } from './sources.ts'

for (const source of readSources()) {
  for (const file of source.files) {
    const target = workspacePath(file.path)
    if (existsSync(target)) {
      const error = sourceFileError(file)
      if (error) throw new Error(error)
      console.log(`Verified ${file.path}`)
      continue
    }
    const url = new URL(file.url)
    if (url.protocol !== 'https:' || url.hostname !== 'dl.polyhaven.org') {
      throw new Error(`Unreviewed download host: ${file.url}`)
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
    if (!response.ok) throw new Error(`${response.status}: ${file.url}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== file.bytes || createHash('md5').update(bytes).digest('hex') !== file.md5) {
      throw new Error(`Checksum mismatch: ${file.url}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { flag: 'wx' })
    console.log(`Downloaded and verified ${file.path} (${bytes.length} bytes)`)
  }
}
