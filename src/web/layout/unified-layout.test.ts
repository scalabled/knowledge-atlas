import assert from 'node:assert/strict'
import test from 'node:test'
import { computePowerDiagram, countCircleOverlaps, project4D, reprojectPoints, solveLabels, unifiedLayout } from './unified-layout'
import type { UnifiedEdgeInput, UnifiedNodeInput } from './unified-layout'

const nodes = Array.from({ length: 180 }, (_, index) => ({
  id: `node:${index}`,
  label: `Graph geometry algorithm ${index}`,
  kind: index % 11 === 0 ? 'tag' : 'item',
  itemType: index % 3 === 0 ? 'youtube' : index % 3 === 1 ? 'favorite' : 'x',
  groupId: `group:${index % 9}`,
  count: 1 + (index % 31),
  createdAt: new Date(Date.UTC(2026, 0, 1 + (index % 180))).toISOString(),
  meta: { topics: [`topic ${index % 9}`], tags: ['layout', `dimension ${index % 7}`] },
}))
const edges = nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id, weight: 1 + index % 3 }))

test('unified layout is deterministic and enforces the hard pad it claims', () => {
  const first = unifiedLayout(nodes, edges, { level: 'search', lens: 'unified', dimension: .72, focusQuery: 'rendering mathematical knowledge graphs' })
  const second = unifiedLayout(nodes, edges, { level: 'search', lens: 'unified', dimension: .72, focusQuery: 'rendering mathematical knowledge graphs' })
  assert.deepEqual(first, second)
  const settled = first.points.filter((point) => !point.overlapped)
  assert.equal(countCircleOverlaps(settled, 0.9), 0)
  assert.ok(first.points.length - settled.length <= first.points.length * 0.02, `${first.points.length - settled.length} overlapped flags`)
  assert.equal(first.groups.length, 9)
  assert.ok(first.points.some((point) => Math.abs(point.z) > .1 && Math.abs(point.w) > .1))
  assert.ok(first.points.every((point) => typeof point.relevance === 'number' && point.relevance >= -1 && point.relevance <= 1))
})

test('the hard pass is cleanup, not the layout algorithm', () => {
  const layout = unifiedLayout(nodes, edges, { level: 'search', lens: 'unified', dimension: .72 })
  assert.ok(layout.preHardPassOverlapRatio < 0.02, `pre-hard-pass overlap ratio ${layout.preHardPassOverlapRatio}`)
})

test('4D projection changes continuously with dimension and every lens is distinct', () => {
  const point = { x: 12, y: -4, z: 7, w: 9 }
  assert.notDeepEqual(project4D(point, 0), project4D(point, 1))
  assert.notDeepEqual(project4D(point, .7, 'depth'), project4D(point, .7, 'time'))
  assert.notDeepEqual(project4D(point, .7, 'territories'), project4D(point, .7, 'unified'))
  assert.notDeepEqual(project4D(point, .7, 'territories'), project4D(point, .7, 'depth'))
  assert.notDeepEqual(project4D(point, .7, 'territories'), project4D(point, .7, 'time'))
})

test('reprojectPoints re-runs projection only: order, grouping, and settled view survive', () => {
  const layout = unifiedLayout(nodes, edges, { level: 'search', lens: 'unified', dimension: .72 })
  const snapshot = layout.points.map((point) => ({ id: point.id, x: point.x, y: point.y }))
  const identity = reprojectPoints(layout.points, .72, 'unified')
  assert.deepEqual(identity.map((point) => point.id), layout.points.map((point) => point.id))
  assert.deepEqual(identity.map((point) => point.groupKey), layout.points.map((point) => point.groupKey))
  identity.forEach((point, index) => {
    assert.ok(Math.hypot(point.x - layout.points[index].x, point.y - layout.points[index].y) < 1e-6, `identity drift at ${point.id}`)
  })
  const nudged = reprojectPoints(layout.points, .73, 'unified')
  nudged.forEach((point, index) => {
    assert.ok(Math.hypot(point.x - layout.points[index].x, point.y - layout.points[index].y) < 4, `discontinuous slider step at ${point.id}`)
  })
  assert.deepEqual(reprojectPoints(layout.points, .3, 'depth'), reprojectPoints(layout.points, .3, 'depth'))
  const territories = reprojectPoints(layout.points, .72, 'territories')
  assert.ok(territories.some((point, index) => Math.hypot(point.x - identity[index].x, point.y - identity[index].y) > 0.1), 'territories lens is a no-op on settled points')
  layout.points.forEach((point, index) => {
    assert.equal(point.x, snapshot[index].x, 'reprojectPoints mutated its input')
    assert.equal(point.y, snapshot[index].y, 'reprojectPoints mutated its input')
  })
})

/** Least-squares 2D affine fit from -> to; returns the max per-point residual. Any z=w=0 layout reprojects exactly affinely. */
function affineResidual(from: Array<{ x: number; y: number }>, to: Array<{ x: number; y: number }>): number {
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0
  for (const p of from) { sxx += p.x * p.x; sxy += p.x * p.y; sx += p.x; syy += p.y * p.y; sy += p.y }
  const n = from.length
  const det = sxx * (syy * n - sy * sy) - sxy * (sxy * n - sy * sx) + sx * (sxy * sy - syy * sx)
  assert.ok(Math.abs(det) > 1e-9, 'degenerate point cloud')
  const solve = (b0: number, b1: number, b2: number): [number, number, number] => [
    (b0 * (syy * n - sy * sy) - sxy * (b1 * n - sy * b2) + sx * (b1 * sy - syy * b2)) / det,
    (sxx * (b1 * n - sy * b2) - b0 * (sxy * n - sx * sy) + sx * (sxy * b2 - b1 * sx)) / det,
    (sxx * (syy * b2 - b1 * sy) - sxy * (sxy * b2 - b1 * sx) + b0 * (sxy * sy - syy * sx)) / det,
  ]
  let bu0 = 0, bu1 = 0, bu2 = 0, bv0 = 0, bv1 = 0, bv2 = 0
  from.forEach((p, i) => {
    bu0 += p.x * to[i].x; bu1 += p.y * to[i].x; bu2 += to[i].x
    bv0 += p.x * to[i].y; bv1 += p.y * to[i].y; bv2 += to[i].y
  })
  const u = solve(bu0, bu1, bu2)
  const v = solve(bv0, bv1, bv2)
  let worst = 0
  from.forEach((p, i) => {
    worst = Math.max(worst, Math.hypot(u[0] * p.x + u[1] * p.y + u[2] - to[i].x, v[0] * p.x + v[1] * p.y + v[2] - to[i].y))
  })
  return worst
}

test('atlas aggregates with sourceCounts + recencyMs make the slider a rotation, not a scale', () => {
  const topics: UnifiedNodeInput[] = Array.from({ length: 17 }, (_, index) => ({
    id: `topic:t${index}`,
    label: `Topic ${index}`,
    kind: 'topic',
    count: 40 + ((index * 97) % 300),
    recencyMs: Date.UTC(2023, 0, 1) + index * 41 * 24 * 60 * 60 * 1000,
    sourceCounts: { x: (index * 13) % 50, web: (index * 29) % 40, youtube: (index * 7) % 30 },
  }))
  const layout = unifiedLayout(topics, [], { level: 'atlas', lens: 'unified', dimension: 0.62 })
  assert.ok(layout.points.some((point) => Math.abs(point.z) > 1), 'recencyMs never reached z')
  assert.ok(layout.points.some((point) => Math.abs(point.w) > 1), 'sourceCounts never reached w')
  const low = reprojectPoints(layout.points, 0.2, 'unified')
  const high = reprojectPoints(layout.points, 0.9, 'unified')
  const displacement = Math.max(...low.map((point, index) => Math.hypot(high[index].x - point.x, high[index].y - point.y)))
  assert.ok(displacement > 1, `max displacement ${displacement}`)
  const ratios: number[] = []
  for (let i = 0; i < low.length; i++) for (let j = i + 1; j < low.length; j++) {
    const dLow = Math.hypot(low[i].x - low[j].x, low[i].y - low[j].y)
    if (dLow > 1e-6) ratios.push(Math.hypot(high[i].x - high[j].x, high[i].y - high[j].y) / dLow)
  }
  const spread = Math.max(...ratios) / Math.min(...ratios)
  assert.ok(spread > 1.02, `pairwise distances collapse to a uniform scale (spread ${spread})`)
  const residual = affineResidual(low, high)
  assert.ok(residual > 1, `slider step is affine-explainable (residual ${residual}) — z/w carry no independent signal`)
})

test('dense pathological edge sets produce zero non-finite coordinates', () => {
  const dense: UnifiedNodeInput[] = Array.from({ length: 2000 }, (_, index) => ({
    id: `dense:${index}`,
    label: `Dense ${index}`,
    kind: 'item',
    itemType: index % 4 === 0 ? 'youtube' : index % 4 === 1 ? 'favorite' : 'x',
    groupId: `group:${index % 16}`,
    count: index % 5 === 0 ? Number.NaN : 1 + (index % 13),
    createdAt: index % 7 === 0 ? 'not-a-date' : new Date(Date.UTC(2024, 0, 1 + (index % 900))).toISOString(),
  }))
  const denseEdges: UnifiedEdgeInput[] = dense.slice(1).map((node, index) => ({ source: dense[index].id, target: node.id, weight: index % 9 === 0 ? Number.POSITIVE_INFINITY : index % 11 === 0 ? Number.NaN : 40 }))
  for (let i = 0; i < 3000; i++) denseEdges.push({ source: `dense:${(i * 37) % 2000}`, target: `dense:${(i * 611 + 13) % 2000}`, weight: -5 + (i % 12) })
  const layout = unifiedLayout(dense, denseEdges, { level: 'graph', lens: 'depth', dimension: 1 })
  for (const point of layout.points) {
    for (const value of [point.x, point.y, point.z, point.w, point.rawX, point.rawY]) {
      assert.ok(Number.isFinite(value), `non-finite coordinate on ${point.id}`)
    }
  }
  for (const dimension of [0, 0.5, 1]) {
    for (const point of reprojectPoints(layout.points, dimension, 'time')) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `non-finite reprojection on ${point.id}`)
    }
  }
})

test('label solver returns every candidate: visible ones disjoint, failures flagged hidden', () => {
  const candidates = Array.from({ length: 80 }, (_, index) => ({
    id: String(index), label: `Label ${index}`, x: 380 + index % 4, y: 240 + index % 3,
    radius: 8, width: 80, height: 24, priority: 100 - index, force: index < 4,
  }))
  const labels = solveLabels(candidates, 760, 480)
  assert.equal(labels.length, candidates.length)
  const visible = labels.filter((label) => !label.hidden)
  assert.ok(visible.length >= 4)
  const firstHidden = labels.findIndex((label) => label.hidden)
  if (firstHidden !== -1) assert.ok(labels.slice(firstHidden).every((label) => label.hidden), 'visible labels must precede hidden ones')
  for (const label of visible) {
    assert.ok(label.left >= 0 && label.top >= 0 && label.left + label.width <= 760 && label.top + label.height <= 480)
  }
  for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
    const a = visible[i], b = visible[j]
    assert.ok(a.left + a.width + 2 <= b.left || b.left + b.width + 2 <= a.left || a.top + a.height + 2 <= b.top || b.top + b.height + 2 <= a.top)
  }
})

test('power cells are clipped, non-empty, and their centroids stay on stage', () => {
  const cells = computePowerDiagram(Array.from({ length: 12 }, (_, index) => ({
    id: String(index), label: `Region ${index}`, color: '#a78bfa', count: index + 1, weight: index + 1,
    x: 70 + (index % 4) * 180, y: 70 + Math.floor(index / 4) * 160,
  })), 760, 480)
  assert.equal(cells.length, 12)
  cells.forEach((cell) => {
    assert.ok(cell.polygon.length >= 3)
    cell.polygon.forEach(([x, y]) => assert.ok(x >= -.001 && x <= 760.001 && y >= -.001 && y <= 480.001))
    assert.ok(cell.centroid.x >= 0 && cell.centroid.x <= 760 && cell.centroid.y >= 0 && cell.centroid.y <= 480)
  })
})
