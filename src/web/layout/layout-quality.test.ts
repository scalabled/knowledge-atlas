import assert from 'node:assert/strict'
import test from 'node:test'
import { embedText } from '../../lib/semantic'
import { countNaN, groupCoherence, interactionContinuity, perturbationStability, spearmanDistanceCorrelation, trustworthiness } from './layout-metrics'
import { project4D, reprojectPoints, unifiedLayout } from './unified-layout'
import type { LayoutOptions, UnifiedEdgeInput, UnifiedNodeInput } from './unified-layout'

// Baseline 2026-07-16 (pre-rewrite) vs the rewritten unifiedLayout (same fixture:
// n=800, 12 groups, chained+random edges, level 'category', dimension 0.68, fully
// deterministic). `current` is a bound the code passes today — reality, not aspiration.
// `target` is the architecture §4 goal.
export const THRESHOLDS = {
  fractionNearestOwnGroup: { current: 0.95, target: 0.95 },    // was 0.11625, now 0.97125 — target met
  displacementP50: { current: 18, target: 5 },                 // was 56.52, now 16.08 — floor is disk geometry: 67 members × r1.7 cannot median under ~12
  displacementP99: { current: 30, target: 8 },                 // was 97.49, now 27.93 — bounded by the 1.7·sqrt(Σr²) pack radius
  outsideDiskCount: { current: 0, target: 0 },                 // was 667/800, now 0 — target met
  stabilityMedianDisplacement: { current: 2.5, target: 2 },    // was 16.96, now 2.03 for unchanged nodes after +5% growth with previous supplied
  stabilityP99Displacement: { current: 7, target: 8 },         // was 116.24, now 5.32 — target met
  continuityMaxDisplacement: { current: 1.5, target: 1.5 },    // was 163.63, now 0 — settle is dimension-independent; dimension lives in projection only
  reprojectionMaxDisplacement: { current: 1.5, target: 1.5 },  // was 0.63 at the old compact scale, now 1.16 at full disk-budget extent — target met
  trustworthiness: { current: 0.85, target: 0.8 },             // was 0.5057 (chance), now 0.915 — shared group tokens make hash vectors cluster; real semantics still Phase 3
  spearman: { current: 0.1, target: 0.5 },                     // was 0.0361, now 0.156 — group-level only; the in-disk arrangement stays non-semantic until real embeddings
  nanCount: { current: 0, target: 0 },                         // 0 before and after
}

const WORDS = ['graph', 'atlas', 'memory', 'systems', 'design', 'rust', 'react', 'inference', 'espresso', 'typography', 'compilers', 'finance', 'poetry', 'gardens', 'music', 'climbing']
const NODE_COUNT = 800
const GROUP_COUNT = 12

const nodes: UnifiedNodeInput[] = Array.from({ length: NODE_COUNT }, (_, index) => {
  const group = index % GROUP_COUNT
  return {
    id: `item:${index}`,
    label: `${WORDS[group]} ${WORDS[(index * 7 + 3) % WORDS.length]} note ${index}`,
    kind: 'item',
    itemType: index % 3 === 0 ? 'youtube' : index % 3 === 1 ? 'favorite' : 'x',
    groupId: `group:${group}`,
    count: 1 + (index % 23),
    createdAt: new Date(Date.UTC(2025, 0, 1 + (index % 500))).toISOString(),
    meta: { topics: [`topic ${group}`], tags: [WORDS[group], `tag ${index % 5}`] },
  }
})

let seed = 1234567
const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647 }
const edges: UnifiedEdgeInput[] = nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id, weight: 1 + (index % 3) }))
for (let i = 0; i < 500; i++) {
  const a = Math.floor(random() * NODE_COUNT)
  let b = Math.floor(random() * NODE_COUNT)
  if (b === a) b = (b + 1) % NODE_COUNT
  edges.push({ source: nodes[a].id, target: nodes[b].id, weight: 1 + (i % 4) })
}

const layoutOpts: LayoutOptions = { level: 'category', lens: 'unified', dimension: 0.68 }
const layout = unifiedLayout(nodes, edges, layoutOpts)

test('group coherence: geometry vs group membership', () => {
  const coherence = groupCoherence(layout.points, layout.groups)
  assert.ok(coherence.fractionNearestOwnGroup >= THRESHOLDS.fractionNearestOwnGroup.current, `fractionNearestOwnGroup ${coherence.fractionNearestOwnGroup}`)
  assert.ok(coherence.displacementP50 <= THRESHOLDS.displacementP50.current, `displacementP50 ${coherence.displacementP50}`)
  assert.ok(coherence.displacementP99 <= THRESHOLDS.displacementP99.current, `displacementP99 ${coherence.displacementP99}`)
  assert.ok(coherence.outsideDiskCount <= THRESHOLDS.outsideDiskCount.current, `outsideDiskCount ${coherence.outsideDiskCount}`)
})

test('perturbation stability: +5% nodes with previous supplied', () => {
  const stability = perturbationStability(unifiedLayout, nodes, edges, layoutOpts)
  assert.ok(stability.medianDisplacement <= THRESHOLDS.stabilityMedianDisplacement.current, `median ${stability.medianDisplacement}`)
  assert.ok(stability.p99Displacement <= THRESHOLDS.stabilityP99Displacement.current, `p99 ${stability.p99Displacement}`)
})

test('interaction continuity: dimension 0.68 -> 0.69', () => {
  const relayout = unifiedLayout(nodes, edges, { ...layoutOpts, dimension: 0.69 })
  const at68 = new Map(layout.points.map((point) => [point.id, point]))
  const at69 = new Map(relayout.points.map((point) => [point.id, point]))
  const appPath = interactionContinuity(layout.points, (point, dimension) => (dimension < 0.685 ? at68 : at69).get(point.id)!, 0.68, 0.69)
  assert.ok(appPath.maxDisplacement <= THRESHOLDS.continuityMaxDisplacement.current, `full re-layout max ${appPath.maxDisplacement}`)
  const reprojection = interactionContinuity(layout.points, (point, dimension) => project4D({ x: point.rawX, y: point.rawY, z: point.z, w: point.w }, dimension, 'unified'), 0.68, 0.69)
  assert.ok(reprojection.maxDisplacement <= THRESHOLDS.reprojectionMaxDisplacement.current, `reprojection max ${reprojection.maxDisplacement}`)
  const viaExport = interactionContinuity(reprojectPoints(layout.points, 0.68, 'unified'), (point, dimension) => reprojectPoints([point], dimension, 'unified')[0], 0.68, 0.69)
  assert.ok(viaExport.maxDisplacement <= THRESHOLDS.reprojectionMaxDisplacement.current, `reprojectPoints max ${viaExport.maxDisplacement}`)
})

test('semantic trustworthiness and distance correlation', () => {
  const pointById = new Map(layout.points.map((point) => [point.id, point]))
  const vectors = nodes.map((node) => {
    const topics = Array.isArray(node.meta?.topics) ? node.meta.topics.join(' ') : ''
    const tags = Array.isArray(node.meta?.tags) ? node.meta.tags.join(' ') : ''
    return embedText(`${node.label} ${topics} ${tags}`)
  })
  const screen = nodes.map((node) => { const point = pointById.get(node.id)!; return { x: point.x, y: point.y } })
  const trust = trustworthiness(vectors, screen, 10)
  assert.ok(trust >= THRESHOLDS.trustworthiness.current && trust <= 1, `trustworthiness ${trust}`)
  const spearman = spearmanDistanceCorrelation(vectors, screen, 2000)
  assert.ok(spearman >= THRESHOLDS.spearman.current && spearman <= 1, `spearman ${spearman}`)
})

test('no NaN outputs on the dense fixture', () => {
  assert.ok(countNaN(layout.points) <= THRESHOLDS.nanCount.current)
})
