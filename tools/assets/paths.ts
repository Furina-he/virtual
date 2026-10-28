import { isAbsolute, relative, resolve, sep } from 'node:path'

export const workspaceRoot = resolve(import.meta.dirname, '../..')

export function workspacePath(path: string, root = workspaceRoot): string {
  if (isAbsolute(path) || path.includes('\\')) throw new Error(`Expected a workspace-relative POSIX path: ${path}`)
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes the asset workspace: ${path}`)
  }
  return target
}

export function modelOutputPath(path: string): string {
  if (
    !/^content\/(?:bench\/bench|modules\/[a-z0-9-]+\/module|instruments\/[a-z0-9-]+\/instrument|models\/(?:components|tools)\/[a-z0-9-]+)\.glb$/.test(
      path,
    )
  ) {
    throw new Error(`Not an owned GLB output path: ${path}`)
  }
  return workspacePath(path)
}
