import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AssembleInput } from '../../../src/domain/circuit/assemble.ts'
import { getInstrumentDefaults } from '../../../src/domain/instruments/index.ts'
import { Instrument, Module, Project } from '../../../src/shared/schema/index.ts'

const root = resolve(import.meta.dirname, '../../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')
const json = (file: string) => JSON.parse(read(file))

export const formalSd22Project = Project.parse(json('content/projects/SD-22/project.json'))
export const formalSd22Placement = formalSd22Project.modules[0] as Project['modules'][number]
const moduleRoot = `content/modules/${formalSd22Placement.moduleId}`
export const formalSd22Module = Module.parse(json(`${moduleRoot}/module.json`))
export const formalSd22Circuit = read(`${moduleRoot}/${formalSd22Module.netlist}`)
export const formalSd22Power = Instrument.parse(json('content/instruments/ins-dc-power/instrument.json'))

// Test-only resolution of the same named bundled library required by the runtime.
const circuit = formalSd22Circuit.replace(/^\s*\.include\s+"([^"]+)"\s*$/gm, (_, file: string) => {
  if (file !== 'timers.lib') throw new Error(`Undeclared model library in the teaching circuit: ${file}`)
  const absolute = resolve(root, 'content/models/spice', file)
  return `.include "${absolute.replaceAll('\\', '/')}"`
})

export type FormalSd22Mode = 'ambulance' | 'fire-prototype'

export function formalSd22Reference(mode: FormalSd22Mode): Project['reference'] {
  if (mode === 'ambulance') return formalSd22Project.reference
  const text = read('content/projects/SD-22/reference-topologies.md')
  const section = text.split('## 消防车原型参考拓扑')[1]
  const source = section?.match(/```json\s*\n([\s\S]*?)\n```/)?.[1]
  if (!source) throw new Error('Missing complete fire-prototype topology in teaching content')
  return Project.shape.reference.parse(JSON.parse(source))
}

export function formalSd22Input(mode: FormalSd22Mode = 'ambulance'): AssembleInput {
  const reference = formalSd22Reference(mode)
  return {
    title: `Formal teaching circuit: ${mode}`,
    modules: [{ instanceId: formalSd22Placement.instanceId, module: formalSd22Module, subckt: circuit }],
    instruments: [
      {
        instanceId: formalSd22Power.id,
        instrument: formalSd22Power,
        settings: { ...getInstrumentDefaults(formalSd22Power), ch1_v: 5, ch2_v: 0 },
      },
    ],
    wires: reference.nets.flatMap((net) => net.slice(1).map((b) => ({ a: net[0] as string, b }))),
    controlValues: {},
    ground: `${formalSd22Power.id}.CH1N`,
    analysis: [],
  }
}

// Remove a jack from its electrical group, rebuilding equivalent star wires rather than
// dropping one arbitrary wire from a chain and accidentally disconnecting unrelated jacks.
export function withoutFormalSd22Jack(input: AssembleInput, jack: string): AssembleInput {
  const adjacent = input.wires.filter((wire) => wire.a === jack || wire.b === jack)
  const peers = adjacent.map((wire) => (wire.a === jack ? wire.b : wire.a))
  const kept = input.wires.filter((wire) => wire.a !== jack && wire.b !== jack)
  return { ...input, wires: [...kept, ...peers.slice(1).map((b) => ({ a: peers[0] as string, b }))] }
}

export function resetFormalSd22(input: AssembleInput, timer: 'T1' | 'T2'): AssembleInput {
  const jack = `${formalSd22Placement.instanceId}.${timer}_RST`
  const disconnected = withoutFormalSd22Jack(input, jack)
  return {
    ...disconnected,
    wires: [...disconnected.wires, { a: jack, b: `${formalSd22Placement.instanceId}.GND1` }],
  }
}
