import { LearnResource } from '../../../shared/schema/learn'

const resourceFiles = import.meta.glob('../../../../content/learn/*/resource.json', {
  eager: true,
  import: 'default',
})

const glbUrls = import.meta.glob<string>('../../../../content/**/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
})

export const learnCatalog: LearnResource[] = Object.values(resourceFiles)
  .map((data) => LearnResource.parse(data))
  .sort((a, b) => a.id.localeCompare(b.id))

export function findLearnResource(id?: string): LearnResource | undefined {
  return id ? learnCatalog.find((item) => item.id === id) : learnCatalog[0]
}

export function resolveLearnModelUrl(modelPath?: string): string | undefined {
  if (!modelPath) return undefined
  const key = `../../../../content/${modelPath.replace(/^\/+/, '')}`
  return glbUrls[key]
}
