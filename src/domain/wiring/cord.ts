export type Point3 = [number, number, number]

/** Samples in meters; sag is the midpoint drop below the endpoint chord, not excess cable length. */
export function cordPoints(a: Point3, b: Point3, sag: number, segments = 32): Point3[] {
  if (![...a, ...b, sag].every(Number.isFinite)) throw new RangeError('Cord coordinates and sag must be finite')
  if (!Number.isInteger(segments) || segments < 2 || segments > 512) {
    throw new RangeError('Cord segments must be an integer from 2 to 512')
  }
  const dx = b[0] - a[0]
  const rise = b[1] - a[1]
  const dz = b[2] - a[2]
  const span = Math.hypot(dx, dz)
  const chord = Math.hypot(span, rise)
  if (!Number.isFinite(chord)) throw new RangeError('Cord endpoint separation exceeds numeric range')
  const drop = Math.min(0.4, Math.max(0.02, sag))
  const points: Point3[] = [[...a]]

  // A vertical catenary is singular. Use a deterministic side loop instead of NaN or a zero-length tube.
  if (span < 1e-6) {
    const direction = rise < 0 ? -1 : 1
    for (let i = 1; i < segments; i++) {
      const t = i / segments
      points.push([
        a[0] + dx * t + direction * drop * Math.sin(2 * Math.PI * t),
        a[1] + rise * t - drop * Math.sin(Math.PI * t) ** 2,
        a[2] + dz * t,
      ])
    }
  } else {
    // q = span / (2 * catenaryScale). Eliminating the horizontal offset gives this monotone sag equation.
    const midpointDrop = (q: number) => Math.hypot(span * (Math.sinh(q) / q), rise) * (Math.tanh(q / 2) / 2)
    let low = 0
    let high = (4 * drop) / chord
    for (let i = 0; i < 64 && midpointDrop(high) < drop; i++) high *= 2
    for (let i = 0; i < 72; i++) {
      const q = (low + high) / 2
      if (midpointDrop(q) < drop) low = q
      else high = q
    }
    const q = (low + high) / 2
    const sinhHalf = Math.sinh(q / 2)
    const sinhFull = Math.sinh(q)
    for (let i = 1; i < segments; i++) {
      const t = i / segments
      const u = 2 * t - 1
      const symmetric = (Math.sinh(q * t) / sinhHalf) * (Math.sinh(q * (1 - t)) / sinhHalf)
      // The sinh term is essential for unequal heights: adding a straight-line slope is not a catenary.
      const asymmetric = Math.sinh(q * u) / sinhFull - u
      points.push([a[0] + dx * t, a[1] + rise * t - drop * symmetric + (rise / 2) * asymmetric, a[2] + dz * t])
    }
  }
  points.push([...b])
  return points
}
