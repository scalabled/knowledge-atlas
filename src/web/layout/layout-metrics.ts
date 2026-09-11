// Pure layout-quality measurements (architecture §4). No imports: these functions
// know nothing about layout internals — data in, numbers out.

export interface MetricPoint2D { x: number; y: number }
export interface MetricPoint4D extends MetricPoint2D { z?: number; w?: number }

export interface CoherencePoint extends MetricPoint2D { id: string; groupKey?: string; r?: number }
export interface CoherenceGroup extends MetricPoint2D { id: string }

export interface GroupCoherenceResult {
  fractionNearestOwnGroup: number
  displacementP50: number
  displacementP99: number
  outsideDiskCount: number
}

export interface StabilityResult { medianDisplacement: number; p99Displacement: number }

function percentile(sortedAscending: number[], q: number): number {
  if (!sortedAscending.length) return 0
  const position = (sortedAscending.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  return sortedAscending[low] + (sortedAscending[high] - sortedAscending[low]) * (position - low)
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  const dimensions = Math.max(a.length, b.length)
  let sum = 0
  for (let i = 0; i < dimensions; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    sum += diff * diff
  }
  return sum
}

/**
 * How well the geometry respects group membership: fraction of nodes whose nearest
 * group center is their own, node→own-center displacement percentiles, and the count
 * of nodes outside 1.15× their group's area-budget disk (radius 1.9·sqrt(Σ r_i²)).
 */
export function groupCoherence(points: CoherencePoint[], groups: CoherenceGroup[]): GroupCoherenceResult {
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const areaByGroup = new Map<string, number>()
  for (const point of points) {
    if (!point.groupKey || !groupById.has(point.groupKey)) continue
    const r = point.r ?? 1
    areaByGroup.set(point.groupKey, (areaByGroup.get(point.groupKey) ?? 0) + r * r)
  }
  const displacements: number[] = []
  let nearestOwn = 0
  let outsideDiskCount = 0
  for (const point of points) {
    const own = point.groupKey ? groupById.get(point.groupKey) : undefined
    if (!own) continue
    const ownDistance = Math.hypot(point.x - own.x, point.y - own.y)
    displacements.push(ownDistance)
    let nearest = true
    for (const group of groups) {
      if (group.id === point.groupKey) continue
      if (Math.hypot(point.x - group.x, point.y - group.y) < ownDistance) { nearest = false; break }
    }
    if (nearest) nearestOwn++
    const diskRadius = 1.9 * Math.sqrt(areaByGroup.get(point.groupKey!) ?? 1)
    if (ownDistance > diskRadius * 1.15) outsideDiskCount++
  }
  displacements.sort((a, b) => a - b)
  return {
    fractionNearestOwnGroup: displacements.length ? nearestOwn / displacements.length : 1,
    displacementP50: percentile(displacements, 0.5),
    displacementP99: percentile(displacements, 0.99),
    outsideDiskCount,
  }
}

/**
 * Grow the input by 5% (cloned nodes under fresh ids), re-run the layout with
 * `previous` supplied, and measure how far the UNCHANGED nodes moved on screen.
 */
export function perturbationStability<N extends { id: string }, E, O extends object>(
  layoutFn: (nodes: N[], edges: E[], opts: O & { previous?: Record<string, { x: number; y: number; z: number; w: number }> }) => { points: Array<MetricPoint4D & { id: string }> },
  nodes: N[],
  edges: E[],
  opts: O,
): StabilityResult {
  const base = layoutFn(nodes, edges, opts)
  const previous: Record<string, { x: number; y: number; z: number; w: number }> = {}
  for (const point of base.points) previous[point.id] = { x: point.x, y: point.y, z: point.z ?? 0, w: point.w ?? 0 }
  const added = nodes.slice(0, Math.max(1, Math.ceil(nodes.length * 0.05))).map((node, index) => ({ ...node, id: `${node.id}::added:${index}` }))
  const grown = layoutFn([...nodes, ...added], edges, { ...opts, previous })
  const grownById = new Map(grown.points.map((point) => [point.id, point]))
  const displacements: number[] = []
  for (const point of base.points) {
    const moved = grownById.get(point.id)
    if (moved) displacements.push(Math.hypot(moved.x - point.x, moved.y - point.y))
  }
  displacements.sort((a, b) => a - b)
  return { medianDisplacement: percentile(displacements, 0.5), p99Displacement: percentile(displacements, 0.99) }
}

/** Max on-screen displacement any node suffers when dimension moves d0 → d1. */
export function interactionContinuity<P>(
  points: P[],
  reprojectFn: (point: P, dimension: number) => MetricPoint2D,
  d0: number,
  d1: number,
): { maxDisplacement: number } {
  let maxDisplacement = 0
  for (const point of points) {
    const before = reprojectFn(point, d0)
    const after = reprojectFn(point, d1)
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(after.x - before.x, after.y - before.y))
  }
  return { maxDisplacement }
}

/**
 * Venna & Kaski trustworthiness: T(k) = 1 - 2/(nk(2n-3k-1)) · Σ_i Σ_{j∈U_i} (r(i,j) - k),
 * where U_i = points in i's 2D k-neighborhood but not its high-dim k-neighborhood and
 * r(i,j) is j's high-dim rank from i. 1 = every screen neighbor is a true neighbor.
 */
export function trustworthiness(vectors: number[][], points: MetricPoint2D[], k: number): number {
  const n = vectors.length
  if (n !== points.length) throw new Error(`trustworthiness: ${n} vectors vs ${points.length} points`)
  if (n < 3 || k < 1) return 1
  const normalizer = n * k * (2 * n - 3 * k - 1)
  if (normalizer <= 0) throw new Error(`trustworthiness: k=${k} too large for n=${n}`)
  const indices = Array.from({ length: n }, (_, i) => i)
  const highDistance = new Float64Array(n)
  const lowDistance = new Float64Array(n)
  const highRank = new Int32Array(n)
  let penalty = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j === i) { highDistance[j] = Infinity; lowDistance[j] = Infinity; continue }
      highDistance[j] = squaredDistance(vectors[i], vectors[j])
      const dx = points[i].x - points[j].x
      const dy = points[i].y - points[j].y
      lowDistance[j] = dx * dx + dy * dy
    }
    const byHigh = indices.slice().sort((a, b) => highDistance[a] - highDistance[b] || a - b)
    for (let rank = 0; rank < n; rank++) highRank[byHigh[rank]] = rank + 1
    const highNeighbors = new Set(byHigh.slice(0, k))
    const byLow = indices.slice().sort((a, b) => lowDistance[a] - lowDistance[b] || a - b)
    for (let index = 0; index < k; index++) {
      const j = byLow[index]
      if (!highNeighbors.has(j)) penalty += highRank[j] - k
    }
  }
  return 1 - (2 / normalizer) * penalty
}

function rankWithTies(values: number[]): number[] {
  const order = values.map((_, index) => index).sort((a, b) => values[a] - values[b] || a - b)
  const ranks = new Array<number>(values.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && values[order[j + 1]] === values[order[i]]) j++
    const shared = (i + j + 2) / 2
    for (let t = i; t <= j; t++) ranks[order[t]] = shared
    i = j + 1
  }
  return ranks
}

/**
 * Spearman rank correlation between high-dim pair distance and screen pair distance
 * over `samplePairs` deterministically sampled pairs. 1 = screen order mirrors semantic order.
 */
export function spearmanDistanceCorrelation(vectors: number[][], points: MetricPoint2D[], samplePairs: number): number {
  const n = Math.min(vectors.length, points.length)
  if (n < 2 || samplePairs < 2) return 0
  let state = 48271
  const random = () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
  const highDistances: number[] = []
  const lowDistances: number[] = []
  for (let sample = 0; sample < samplePairs; sample++) {
    const i = Math.floor(random() * n)
    let j = Math.floor(random() * n)
    if (j === i) j = (j + 1) % n
    highDistances.push(squaredDistance(vectors[i], vectors[j]))
    const dx = points[i].x - points[j].x
    const dy = points[i].y - points[j].y
    lowDistances.push(dx * dx + dy * dy)
  }
  const ranksHigh = rankWithTies(highDistances)
  const ranksLow = rankWithTies(lowDistances)
  const count = ranksHigh.length
  const meanHigh = ranksHigh.reduce((sum, value) => sum + value, 0) / count
  const meanLow = ranksLow.reduce((sum, value) => sum + value, 0) / count
  let covariance = 0
  let varianceHigh = 0
  let varianceLow = 0
  for (let index = 0; index < count; index++) {
    const dHigh = ranksHigh[index] - meanHigh
    const dLow = ranksLow[index] - meanLow
    covariance += dHigh * dLow
    varianceHigh += dHigh * dHigh
    varianceLow += dLow * dLow
  }
  return varianceHigh > 0 && varianceLow > 0 ? covariance / Math.sqrt(varianceHigh * varianceLow) : 0
}

/** Count of points carrying any non-finite coordinate. */
export function countNaN(points: MetricPoint4D[]): number {
  let count = 0
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      (point.z !== undefined && !Number.isFinite(point.z)) ||
      (point.w !== undefined && !Number.isFinite(point.w))) count++
  }
  return count
}
