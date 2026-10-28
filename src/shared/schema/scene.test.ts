import { afterEach, describe, expect, it, vi } from 'vitest'
import sceneData from '../../../content/bench/scene.json'
import { BenchScene } from './scene.ts'

const injected = vi.hoisted(() => ({ value: undefined as string | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    readFileSync: (path: Parameters<typeof fs.readFileSync>[0], ...options: unknown[]) => {
      if (String(path).replaceAll('\\', '/').endsWith('content/bench/scene.json') && injected.value !== undefined) {
        return injected.value
      }
      return Reflect.apply(fs.readFileSync, fs, [path, ...options])
    },
  }
})

const lintPath = '../../../tools/content-lint.ts'
const { lintContent } = (await import(lintPath)) as {
  lintContent: (root: string) => { file: string; path: string; message: string }[]
}

afterEach(() => {
  injected.value = undefined
})

function firstPlacement(scene: typeof sceneData) {
  const placement = scene.placements[0]
  if (!placement) throw new Error('Scene fixture must have a placement')
  return placement
}

describe('BenchScene schema', () => {
  it('accepts the current content fixture and optional rotation and slot', () => {
    expect(BenchScene.parse(sceneData)).toEqual(sceneData)
    const changed = structuredClone(sceneData)
    Object.assign(firstPlacement(changed), { rotation: [0, Math.PI / 3, 0], slot: 'SLOT_DESK_4' })
    expect(BenchScene.safeParse(changed).success).toBe(true)
  })

  it('rejects duplicate instance IDs even when their asset IDs differ', () => {
    const changed = structuredClone(sceneData)
    changed.placements.push({ ...firstPlacement(changed), assetId: 'another-asset' })
    const result = BenchScene.safeParse(changed)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path)).toContainEqual(['placements', 8, 'instanceId'])
  })

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite camera, placement and rotation values: %s', (value) => {
    for (const field of ['cameraPosition', 'cameraTarget', 'position', 'rotation'] as const) {
      const changed = structuredClone(sceneData)
      if (field === 'cameraPosition') changed.camera.position[1] = value
      else if (field === 'cameraTarget') changed.camera.target[2] = value
      else if (field === 'position') firstPlacement(changed).position[0] = value
      else Object.assign(firstPlacement(changed), { rotation: [0, value, 0] })
      expect(BenchScene.safeParse(changed).success, field).toBe(false)
    }
  })

  it('rejects empty placements, wrong schema versions, malformed IDs and non-SLOT names', () => {
    expect(BenchScene.safeParse({ ...sceneData, placements: [] }).success).toBe(false)
    expect(BenchScene.safeParse({ ...sceneData, schemaVersion: 2 }).success).toBe(false)
    for (const patch of [
      { instanceId: 'bad.instance' },
      { assetId: 'UPPER_CASE' },
      { slot: 'desk_1' },
      { position: [0, 1] },
      { rotation: [0, 0, 0, 0] },
    ]) {
      const changed = structuredClone(sceneData)
      Object.assign(firstPlacement(changed), patch)
      expect(BenchScene.safeParse(changed).success).toBe(false)
    }
  })
})

describe('content:lint scene integration', () => {
  it('recognizes scene.json and validates the shipped bench scene', () => {
    expect(lintContent('content/bench')).toEqual([])
  })

  it('reports duplicate instance IDs with the scene file and field path', () => {
    const changed = structuredClone(sceneData)
    changed.placements.push({ ...firstPlacement(changed) })
    injected.value = JSON.stringify(changed)
    expect(lintContent('content/bench')).toEqual([
      expect.objectContaining({ file: 'content/bench/scene.json', path: 'placements[8].instanceId' }),
    ])
  })

  it('reports invalid placement coordinates instead of silently accepting the file', () => {
    const changed = structuredClone(sceneData)
    firstPlacement(changed).position[1] = Infinity
    injected.value = JSON.stringify(changed)
    expect(lintContent('content/bench')).toEqual([
      expect.objectContaining({ file: 'content/bench/scene.json', path: 'placements[0].position[1]' }),
    ])
  })
})
