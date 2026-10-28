export type Vector2Tuple = [number, number]
export type Vector3Tuple = [number, number, number]

export type AssetKind = 'bench' | 'module' | 'instrument' | 'component'
export type BodyStyle = 'bench' | 'module' | 'meter' | 'supply' | 'handheld' | 'scope' | 'generator' | 'component'
export type ComponentStyle =
  | 'resistor'
  | 'diode'
  | 'ceramic-capacitor'
  | 'electrolytic-capacitor'
  | 'led'
  | 'transistor-to92'
  | 'potentiometer'
  | 'toggle-switch'
  | 'dip8'
  | 'banana-jack'

export type JackColor = 'red' | 'black' | 'yellow' | 'green' | 'blue' | 'metal'

export interface JackDefinition {
  id: string
  label: string
  x: number
  y: number
  color: JackColor
  kind?: 'banana4' | 'bnc' | 'pin'
  silkLabel?: string
  labelX?: number
  labelY?: number
}

export interface ControlDefinition {
  id: string
  label: string
  kind: 'knob' | 'switch'
  x: number
  y: number
  radiusMm?: number
  param?: string
  shape?: 'toggle' | 'push'
  labelX?: number
  labelY?: number
}

export interface ScreenDefinition {
  id: string
  x: number
  y: number
  width: number
  height: number
  style?: 'blank' | 'grid'
}

export interface LedDefinition {
  id: string
  label: string
  x: number
  y: number
  color: JackColor
}

export interface SlotDefinition {
  id: string
  position: Vector3Tuple
  kind: 'fixed' | 'module' | 'desktop'
  dimensionsMm?: Vector3Tuple
}

export interface PanelText {
  text: string
  x: number
  y: number
  size: number
  align?: 'start' | 'middle' | 'end'
  weight?: number
}

export interface PanelDefinition {
  title: string
  subtitle?: string
  footer?: string
  titleSize?: number
  texts?: PanelText[]
  frames?: { x: number; y: number; width: number; height: number; label?: string }[]
  lines?: { points: Vector2Tuple[]; width?: number }[]
  symbols?: {
    kind: 'resistor' | 'diode'
    x: number
    y: number
    length: number
    angle?: number
    label: string
    labelX?: number
    labelY?: number
  }[]
}

export interface AssetDefinition {
  id: string
  name: string
  kind: AssetKind
  model: string
  sourceFile?: string
  triangleBudget?: number
  bodyStyle: BodyStyle
  componentStyle?: ComponentStyle
  dimensionsMm: Vector3Tuple
  estimatedDimensions: boolean
  dimensionNote?: string
  mounting?: 'fixed' | 'desktop'
  textureSize?: Vector2Tuple
  jacks: JackDefinition[]
  controls: ControlDefinition[]
  screens: ScreenDefinition[]
  leds?: LedDefinition[]
  slots?: SlotDefinition[]
  panel?: PanelDefinition
}

export interface AssetPlacement {
  assetId: string
  slot?: string
  position: Vector3Tuple
  rotation?: Vector3Tuple
}

export interface AssetCatalog {
  schemaVersion: 1
  assets: AssetDefinition[]
  preview: {
    camera: { position: Vector3Tuple; target: Vector3Tuple }
    placements: AssetPlacement[]
  }
}
