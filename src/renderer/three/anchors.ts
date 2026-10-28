import { type Object3D, Quaternion, Vector3 } from 'three'

export type AnchorKind = 'JACK' | 'KNOB' | 'SW' | 'SCREEN' | 'LED' | 'LAMP' | 'SLOT'

export interface AssetAnchor {
  name: string
  id: string
  label: string
  kind: AnchorKind
  position: Vector3
  quaternion: Quaternion
}

/** Snapshot model-space transforms before the clone receives its preview placement. */
export function collectAnchors(model: Object3D): AssetAnchor[] {
  const anchors: AssetAnchor[] = []
  model.updateMatrixWorld(true)
  model.traverse((node) => {
    const match = /^(JACK|KNOB|SW|SCREEN|LED|LAMP|SLOT)_(.+)$/.exec(node.name)
    if (!match?.[1] || !match[2]) return
    anchors.push({
      name: node.name,
      id: match[2],
      label: typeof node.userData.label === 'string' ? node.userData.label : match[2],
      kind: match[1] as AnchorKind,
      position: node.getWorldPosition(new Vector3()),
      quaternion: node.getWorldQuaternion(new Quaternion()),
    })
  })
  return anchors
}
