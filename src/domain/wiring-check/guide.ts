import { UnionFind } from '../circuit/union-find.ts'

// 引导模式的参考接线（PRD WIR-08）：只给出还缺的连接，已经连通的不再提示

/**
 * Jack pairs still needed so every reference net is connected by student wires.
 * Each net's already-connected groups are chained in net order, so a net of N groups yields N−1 links.
 */
export function missingReferenceLinks(
  nets: readonly (readonly string[])[],
  wires: readonly { a: string; b: string }[],
): [string, string][] {
  const uf = new UnionFind<string>()
  for (const wire of wires) uf.union(wire.a, wire.b)
  const links: [string, string][] = []
  for (const net of nets) {
    const seen = new Set<string>()
    let previous: string | undefined
    for (const jack of net) {
      const root = uf.find(jack)
      if (seen.has(root)) continue
      seen.add(root)
      if (previous) links.push([previous, jack])
      previous = jack
    }
  }
  return links
}
