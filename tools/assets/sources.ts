import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { workspacePath } from './paths.ts'
import type { AssetDefinition } from './types.ts'

export type SourceFile = { path: string; url: string; bytes: number; md5: string }
export type AssetSource = {
  id: string
  name: string
  author: string
  url: string
  license: string
  licenseUrl: string
  legalUrl: string
  files: SourceFile[]
}

export function readSources(): AssetSource[] {
  return JSON.parse(readFileSync(workspacePath('assets/sources.json'), 'utf8')).sources
}

export function importedSource(asset: AssetDefinition, sources = readSources()): AssetSource | undefined {
  if (!asset.sourceFile) return undefined
  const source = sources.find((entry) => entry.id === asset.id)
  if (!source?.files.some((file) => file.path === asset.sourceFile)) {
    throw new Error(`${asset.id}: imported geometry must match a verified source and source file`)
  }
  return source
}

export function sourceFileError(file: SourceFile): string | undefined {
  const full = workspacePath(file.path)
  if (!existsSync(full)) return `${file.path}: missing; run pnpm assets:fetch once while online`
  const bytes = readFileSync(full)
  if (bytes.length !== file.bytes || createHash('md5').update(bytes).digest('hex') !== file.md5) {
    return `${file.path}: source checksum differs; refusing to overwrite or package it`
  }
  return undefined
}

export function checkSources(): string[] {
  return readSources().flatMap((source) => source.files.flatMap((file) => sourceFileError(file) ?? []))
}
