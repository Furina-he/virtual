import { Mesh, type Object3D } from 'three'

export type InstrumentScreenTarget = { id: string; mesh: Mesh; width: number; height: number; grid?: Object3D }

/** Match only the generated SCREEN_/DISPLAY_ contract, not arbitrary meshes in the GLB. */
export function instrumentScreenTargets(model: Object3D): InstrumentScreenTarget[] {
  const screens: InstrumentScreenTarget[] = []
  model.traverse((node) => {
    if (!node.name.startsWith('SCREEN_')) return
    const id = node.name.slice('SCREEN_'.length)
    const mesh = node.getObjectByName(`DISPLAY_${id}`)
    if (!(mesh instanceof Mesh)) return
    screens.push({
      id,
      mesh,
      width: typeof node.userData.width === 'number' ? node.userData.width : 1,
      height: typeof node.userData.height === 'number' ? node.userData.height : 0.3,
      grid: node.getObjectByName(`UNPOWERED_GRID_${id}`),
    })
  })
  return screens
}

export function screenReadingKey(anchorId: string): string {
  return anchorId === 'MAIN' ? 'main' : anchorId
}
