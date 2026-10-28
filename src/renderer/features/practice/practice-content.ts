import { Instrument, Module, Project } from '../../../shared/schema/index'

const instruments = import.meta.glob('../../../../content/instruments/*/instrument.json', {
  eager: true,
  import: 'default',
})
const modules = import.meta.glob('../../../../content/modules/*/module.json', {
  eager: true,
  import: 'default',
})
const netlists = import.meta.glob<string>('../../../../content/modules/*/*.cir', {
  eager: true,
  query: '?raw',
  import: 'default',
})
const projects = import.meta.glob('../../../../content/projects/*/project.json', {
  eager: true,
  import: 'default',
})
const guides = import.meta.glob<string>('../../../../content/projects/*/guide.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

export const instrumentCatalog = Object.values(instruments).map((data) => Instrument.parse(data))
export const moduleCatalog = Object.values(modules).map((data) => Module.parse(data))
export const projectCatalog = Object.values(projects).map((data) => Project.parse(data))

export function moduleNetlist(module: Module): string {
  const text = netlists[`../../../../content/modules/${module.id}/${module.netlist}`]
  if (!text) throw new Error(`Missing local module netlist: ${module.id}/${module.netlist}`)
  return text
}

export function projectGuide(project: Project): string {
  return guides[`../../../../content/projects/${project.id}/guide.md`] ?? ''
}

export function findProject(id?: string): Project | undefined {
  return id ? projectCatalog.find((project) => project.id === id) : projectCatalog[0]
}
