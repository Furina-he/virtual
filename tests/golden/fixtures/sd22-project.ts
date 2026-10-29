import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AssembleInput } from '../../../src/domain/circuit/assemble.ts'
import { expandLocalLibraries } from '../../../src/domain/circuit/libraries.ts'
import { getInstrumentDefaults } from '../../../src/domain/instruments/index.ts'
import { Instrument, Module, Project } from '../../../src/shared/schema/index.ts'

const root = resolve(import.meta.dirname, '../../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')
const json = (file: string) => JSON.parse(read(file))

export const formalSd22Project = Project.parse(json('content/projects/SD-22/project.json'))
export const formalSd22Placement = formalSd22Project.modules.find(
  (placement) => placement.moduleId === 'mod-555-app',
) as Project['modules'][number]
if (!formalSd22Placement) throw new Error('Missing original 36-jack timer board in SD-22')
const moduleRoot = `content/modules/${formalSd22Placement.moduleId}`
export const formalSd22Module = Module.parse(json(`${moduleRoot}/module.json`))
export const formalSd22Circuit = read(`${moduleRoot}/${formalSd22Module.netlist}`)
export const formalSd22Power = Instrument.parse(json('content/instruments/ins-dc-power/instrument.json'))
export const formalSd22Scope = Instrument.parse(json('content/instruments/ins-oscilloscope/instrument.json'))
export const formalSd22FollowerPlacement = formalSd22Project.modules.find(
  (placement) => placement.moduleId === 'mod-voltage-follower',
) as Project['modules'][number]
if (!formalSd22FollowerPlacement) throw new Error('Missing approved independent follower adapter in SD-22')
const followerRoot = `content/modules/${formalSd22FollowerPlacement.moduleId}`
export const formalSd22Follower = Module.parse(json(`${followerRoot}/module.json`))
export const formalSd22FollowerCircuit = read(`${followerRoot}/${formalSd22Follower.netlist}`)

// The same pure named-library resolver is used by the production content loader.
const libraries = {
  'timers.lib': read('content/models/spice/timers.lib'),
  'opamp.lib': read('content/models/spice/opamp.lib'),
}
const circuit = expandLocalLibraries(formalSd22Circuit, libraries)
const followerCircuit = expandLocalLibraries(formalSd22FollowerCircuit, libraries)

export type FormalSd22Mode = 'ambulance' | 'fire-buffered' | 'fire-prototype'

export function formalSd22Reference(mode: FormalSd22Mode): Project['reference'] {
  if (mode === 'ambulance') return formalSd22Project.reference
  if (mode === 'fire-buffered') {
    const step = formalSd22Project.steps.find((entry) => entry.id === 'wire-fire-buffered')
    if (!step?.referenceNets) throw new Error('Missing complete approved fire-buffered step topology')
    return { nets: step.referenceNets, measurePoints: formalSd22Project.reference.measurePoints }
  }
  const text = read('content/projects/SD-22/reference-topologies.md')
  const section = text.split('## 消防车原型参考拓扑')[1]
  const source = section?.match(/```json\s*\n([\s\S]*?)\n```/)?.[1]
  if (!source) throw new Error('Missing complete fire-prototype topology in teaching content')
  return Project.shape.reference.parse(JSON.parse(source))
}

function inputFor(mode: FormalSd22Mode, includeFollower: boolean): AssembleInput {
  const reference = formalSd22Reference(mode)
  return {
    title: `Formal teaching circuit: ${mode}`,
    modules: [
      { instanceId: formalSd22Placement.instanceId, module: formalSd22Module, subckt: circuit },
      ...(includeFollower
        ? [{ instanceId: formalSd22FollowerPlacement.instanceId, module: formalSd22Follower, subckt: followerCircuit }]
        : []),
    ],
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

// Keep the original standalone-board regressions on their historical circuit.
export function formalSd22Input(mode: 'ambulance' | 'fire-prototype' = 'ambulance'): AssembleInput {
  return inputFor(mode, false)
}

export function formalFullInput(mode: FormalSd22Mode = 'ambulance'): AssembleInput {
  return inputFor(mode, true)
}

export function formalScopeLoadedInput(mode: 'ambulance' | 'fire-buffered'): AssembleInput {
  const input = formalFullInput(mode)
  return {
    ...input,
    instruments: [
      ...input.instruments,
      {
        instanceId: 'scope1',
        instrument: formalSd22Scope,
        settings: { ...getInstrumentDefaults(formalSd22Scope), tdiv: 0.5, out_on: 0 },
      },
    ],
    wires: [
      ...input.wires,
      { a: 'scope1.CH1', b: `${formalSd22Placement.instanceId}.T1_OUT` },
      { a: 'scope1.CH2', b: `${formalSd22Placement.instanceId}.T1_TH` },
      { a: 'scope1.GND', b: `${formalSd22Placement.instanceId}.GND1` },
    ],
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
