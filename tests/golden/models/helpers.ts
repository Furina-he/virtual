import { resolve, sep } from 'node:path'
import { NgSpice } from '../../../src/sim/ngspice'

export const LIB_DIR = resolve(__dirname, '../../../content/models/spice')

// ngspice 路径统一用正斜杠并加引号，空格/中文路径也能 .include
export function include(file: string): string {
  return `.include "${file.replaceAll(sep, '/')}"`
}

export function lib(name: string): string {
  return include(resolve(LIB_DIR, name))
}

let ng: NgSpice | undefined
export function spice(): NgSpice {
  ng ??= NgSpice.open(resolve(__dirname, '../../../resources/ngspice'))
  return ng
}

export function run(lines: string[]): NgSpice {
  const s = spice()
  s.load(['* golden', ...lines, '.end'].join('\n'))
  s.run()
  return s
}

/** 在 time 向量上线性插值取 v(t) */
export function at(t: Float64Array | number[], v: Float64Array | number[], tq: number): number {
  let i = 1
  while (i < t.length - 1 && (t[i] ?? 0) < tq) i++
  const t0 = t[i - 1] ?? 0
  const t1 = t[i] ?? 0
  const v0 = v[i - 1] ?? 0
  const v1 = v[i] ?? 0
  return t1 === t0 ? v1 : v0 + ((tq - t0) / (t1 - t0)) * (v1 - v0)
}

export function dev(x: number, ref: number): number {
  return Math.abs(x - ref) / Math.abs(ref)
}
