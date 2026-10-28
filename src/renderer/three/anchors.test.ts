import { Group, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { collectAnchors } from './anchors'

describe('preview asset anchors', () => {
  it('recognizes every semantic prefix but not display geometry', () => {
    const model = new Group()
    for (const prefix of ['JACK', 'KNOB', 'SW', 'SCREEN', 'LED', 'LAMP', 'SLOT', 'DISPLAY']) {
      const node = new Group()
      node.name = `${prefix}_A`
      model.add(node)
    }
    expect(collectAnchors(model).map((anchor) => anchor.kind)).toEqual([
      'JACK',
      'KNOB',
      'SW',
      'SCREEN',
      'LED',
      'LAMP',
      'SLOT',
    ])
  })

  it('preserves nested position and local +Z orientation without moving the model', () => {
    const model = new Group()
    const panel = new Group()
    panel.position.set(0.4, 0.8, 0.2)
    panel.rotation.y = Math.PI / 2
    const jack = new Group()
    jack.name = 'JACK_POS'
    jack.userData.label = 'Positive'
    jack.position.set(0, 0.1, 0.02)
    panel.add(jack)
    model.add(panel)

    const [anchor] = collectAnchors(model)
    expect(anchor?.label).toBe('Positive')
    expect(anchor?.position.x).toBeCloseTo(0.42)
    expect(anchor?.position.y).toBeCloseTo(0.9)
    expect(anchor?.position.z).toBeCloseTo(0.2)
    expect(anchor && new Vector3(0, 0, 1).applyQuaternion(anchor.quaternion).x).toBeCloseTo(1)
    expect(jack.parent).toBe(panel)
    expect(jack.position.toArray()).toEqual([0, 0.1, 0.02])
  })
})
