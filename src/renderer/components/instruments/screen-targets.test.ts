import { Group, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { instrumentScreenTargets, screenReadingKey } from './screen-targets'

describe('generated instrument screen anchors', () => {
  it('binds the actual DISPLAY_ child and keeps the model transform intact', () => {
    const root = new Group()
    const anchor = new Group()
    anchor.name = 'SCREEN_MAIN'
    anchor.position.set(0.01, 0.1, 0.04)
    anchor.userData = { width: 0.084, height: 0.024 }
    const mesh = new Mesh(new PlaneGeometry(), new MeshBasicMaterial())
    mesh.name = 'DISPLAY_MAIN'
    anchor.add(mesh)
    root.add(anchor)
    const targets = instrumentScreenTargets(root)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ id: 'MAIN', mesh, width: 0.084, height: 0.024 })
    expect(anchor.position.toArray()).toEqual([0.01, 0.1, 0.04])
    mesh.geometry.dispose()
    mesh.material.dispose()
  })

  it('does not accidentally replace panel textures or bind an empty anchor', () => {
    const root = new Group()
    const empty = new Group()
    empty.name = 'SCREEN_EMPTY'
    const unrelated = new Mesh(new PlaneGeometry(), new MeshBasicMaterial())
    unrelated.name = 'DISPLAY_MAIN'
    root.add(empty, unrelated)
    expect(instrumentScreenTargets(root)).toEqual([])
    unrelated.geometry.dispose()
    unrelated.material.dispose()
  })

  it('maps MAIN and independent supply channels to the shared readout keys', () => {
    expect(screenReadingKey('MAIN')).toBe('main')
    expect(screenReadingKey('CH1')).toBe('CH1')
    expect(screenReadingKey('CH2')).toBe('CH2')
  })
})
