import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import type { NodeLabelDrawingFunction } from 'sigma/rendering'
import { computePowerDiagram, reprojectPoints, solveLabels, unifiedLayout, type Point4D, type UnifiedPoint, type ViewLens } from '../layout/unified-layout'
import { embedText, parseEmbedding } from '../../lib/semantic'

interface GraphNodeDto {
  id: string
  type: string
  label: string
  summary: string | null
  weight: number
  metadata: Record<string, unknown>
}

interface GraphEdgeDto {
  id: string
  source: string
  target: string
  type: string
  weight: number
  metadata: Record<string, unknown>
}

interface GraphResponse {
  nodes: GraphNodeDto[]
  edges: GraphEdgeDto[]
}

interface TopicSeed {
  id: string
  label: string
  color: string
  x: number
  y: number
  weight: number
}

interface NodeAffinity {
  topicId: string
  label: string
  color: string
  x: number
  y: number
  weight: number
}

interface LayoutModel {
  topics: TopicSeed[]
  affinities: Map<string, NodeAffinity>
  regionWeights: Map<string, number>
}

interface TopicRegion {
  id: string
  label: string
  color: string
  path: string
  x: number
  y: number
  weight: number
}

interface GraphLabel { id: string; label: string; x: number; y: number; width: number; color: string; kind: string; selected: boolean }
interface GraphEdgeRoute { id: string; path: string; correlated: boolean; weight: number }

const TYPE_COLORS: Record<string, string> = {
  root: '#f8fafc',
  bookmark: '#38bdf8',
  favorite: '#0ea5e9',
  topic: '#a78bfa',
  author: '#f59e0b',
  domain: '#34d399',
  tag: '#f472b6',
  link: '#22c55e',
  media: '#fb7185',
  youtube: '#ef4444',
  document: '#a78bfa',
  source: '#f8fafc',
  channel: '#fb923c',
  playlist: '#f43f5e',
  collection: '#14b8a6',
}

export type LayoutMode = ViewLens

// Duplicated in ExploreCanvas: value exports here would break both canvases' fast-refresh boundaries.
/** Continuous interactions (slider drag, camera motion) defer the label/territory
 * re-solve until this much idle; between solves labels ride along via CSS transforms. */
const SOLVE_IDLE_MS = 120
/** Survivors of the previous solve outrank same-tier newcomers so labels stop popping.
 * Must exceed intra-tier count/weight spreads and stay below the 1e6+ tier gaps. */
const HYSTERESIS_BONUS = 2e5

/** Focus relevance is a render channel: dot of unit feature-hash vectors, exactly
 * as unified-layout scores it, so restyling needs no relayout. */
function focusScores(vectors: Map<string, number[]>, query: string): Map<string, number> {
  const focus = embedText(query)
  const scores = new Map<string, number>()
  for (const [id, vector] of vectors) {
    let dot = 0
    for (let i = 0; i < vector.length; i++) dot += vector[i] * (focus[i] ?? 0)
    scores.set(id, Number.isFinite(dot) ? clamp(dot, -1, 1) : 0)
  }
  return scores
}

const LAYOUT_CACHE_KEY = 'atlas-layout:v3:graph'

const TOPIC_ANCHORS: Record<string, { x: number; y: number }> = {
  'ai-ml': { x: 0, y: 0 },
  engineering: { x: -11, y: -1 },
  'tools-products': { x: -7, y: 8 },
  'product-design': { x: 4, y: 10 },
  'startups-business': { x: 12, y: 5 },
  'finance-markets': { x: 15, y: -3 },
  'crypto-web3': { x: 11, y: -10 },
  'science-research': { x: -2, y: -13 },
  'security-privacy': { x: -14, y: -9 },
  'health-longevity': { x: -15, y: 5 },
  'productivity-pkm': { x: -4, y: 15 },
  'news-politics': { x: 5, y: -16 },
  'culture-memes': { x: 16, y: 12 },
  'media-creative': { x: 9, y: 16 },
  'learning-reference': { x: -10, y: 12 },
  'people-network': { x: 1, y: 17 },
  unsorted: { x: 18, y: 0 },
}

function nodeSize(node: GraphNodeDto): number {
  if (node.type === 'root') return 15
  if (node.type === 'bookmark' || node.type === 'favorite') return 5.6
  if (node.type === 'topic') return 8 + Math.min(10, Math.sqrt(node.weight))
  return 4 + Math.min(8, Math.sqrt(node.weight))
}

function graphLabel(node: GraphNodeDto): string {
  if (node.type === 'root') return node.label
  if (node.type === 'tag') return node.weight >= 500 ? node.label : ''
  if (node.type === 'domain') return node.weight >= 10 ? node.label : ''
  if (node.type === 'author') return node.weight >= 85 ? node.label : ''
  if (node.type === 'link') return node.weight >= 4 ? node.label : ''
  return ''
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.quadraticCurveTo(x + width, y, x + width, y + r)
  context.lineTo(x + width, y + height - r)
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  context.lineTo(x + r, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}

const drawReadableNodeLabel: NodeLabelDrawingFunction = (context, data, settings) => {
  if (!data.label) return
  const label = String(data.label)
  const fontSize = Math.max(12, Math.min(16, Number(settings.labelSize ?? 14)))
  const fontFamily = String(settings.labelFont ?? 'Inter, ui-sans-serif, system-ui, sans-serif')
  const fontWeight = data.forceLabel ? 700 : 600
  context.save()
  context.font = `${fontWeight} ${fontSize}px ${fontFamily}`
  const width = Math.ceil(context.measureText(label).width)
  const x = data.x + data.size + 6
  const y = data.y - fontSize / 2 - 5
  const boxWidth = width + 14
  const boxHeight = fontSize + 10

  context.shadowColor = 'rgba(0, 0, 0, 0.55)'
  context.shadowBlur = 10
  roundedRect(context, x, y, boxWidth, boxHeight, 7)
  context.fillStyle = 'rgba(5, 7, 10, 0.86)'
  context.fill()
  context.shadowBlur = 0
  context.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  context.lineWidth = 1
  context.stroke()

  context.fillStyle = '#f8fafc'
  context.textBaseline = 'middle'
  context.fillText(label, x + 7, y + boxHeight / 2)
  context.restore()
}

function topicSlug(id: string): string {
  return id.replace(/^topic:/, '')
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '').trim()
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  }
}

function mixColor(a: string, b: string, amountB = 0.5): string {
  const first = hexToRgb(a)
  const second = hexToRgb(b)
  if (!first || !second) return a
  const amountA = 1 - amountB
  const r = Math.round(first.r * amountA + second.r * amountB)
  const g = Math.round(first.g * amountA + second.g * amountB)
  const bValue = Math.round(first.b * amountA + second.b * amountB)
  return `#${[r, g, bValue].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function fallbackTopicAnchor(index: number, total: number): { x: number; y: number } {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2
  return { x: Math.cos(angle) * 16, y: Math.sin(angle) * 16 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// Keyed by view identity only — never by dimension/mode/query, or `previous` is always
// absent during the exact interactions that need continuity.
function readPreviousPositions(): Record<string, Point4D> | undefined {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_CACHE_KEY) ?? 'null') ?? undefined
  } catch {
    return undefined
  }
}

function writePreviousPositions(points: UnifiedPoint[]): void {
  const payload: Record<string, Point4D> = {}
  for (const point of points) payload[point.id] = { x: point.x, y: point.y, z: point.z, w: point.w }
  try {
    localStorage.setItem(LAYOUT_CACHE_KEY, JSON.stringify(payload))
  } catch {
    // Quota or private mode — stability is best-effort, never fatal.
  }
}

// Mirrors unified-layout's nodeVector so client-side relevance rescoring matches the layout's.
function graphNodeVector(node: GraphNodeDto): number[] {
  const stored = parseEmbedding(node.metadata.embedding)
  if (stored.length >= 8) return stored
  const topics = Array.isArray(node.metadata.topics) ? node.metadata.topics.join(' ') : ''
  const tags = Array.isArray(node.metadata.tags) ? node.metadata.tags.join(' ') : ''
  return embedText(`${node.label} ${topics} ${tags}`)
}

function buildTopicLayout(data: GraphResponse): LayoutModel {
  const nodeById = new Map(data.nodes.map((node) => [node.id, node]))
  const topicNodes = data.nodes.filter((node) => node.type === 'topic')
  const topics = topicNodes.map((node, index): TopicSeed => {
    const anchor = TOPIC_ANCHORS[topicSlug(node.id)] ?? fallbackTopicAnchor(index, topicNodes.length)
    return {
      id: node.id,
      label: node.label,
      color: typeof node.metadata.color === 'string' ? node.metadata.color : TYPE_COLORS.topic,
      x: anchor.x,
      y: anchor.y,
      weight: node.weight,
    }
  })
  const topicById = new Map(topics.map((topic) => [topic.id, topic]))
  const raw = new Map<string, Map<string, number>>()

  const add = (nodeId: string, topicId: string, weight: number) => {
    if (!nodeById.has(nodeId) || !topicById.has(topicId)) return
    const entry = raw.get(nodeId) ?? new Map<string, number>()
    entry.set(topicId, (entry.get(topicId) ?? 0) + weight)
    raw.set(nodeId, entry)
  }

  for (const topic of topics) add(topic.id, topic.id, 40)

  for (const edge of data.edges) {
    if (topicById.has(edge.source)) add(edge.target, edge.source, Math.max(1, edge.weight) * 6)
    if (topicById.has(edge.target)) add(edge.source, edge.target, Math.max(1, edge.weight) * 6)
  }

  for (let pass = 0; pass < 2; pass++) {
    const additions: Array<{ nodeId: string; topicId: string; weight: number }> = []
    for (const edge of data.edges) {
      const sourceAffinity = raw.get(edge.source)
      const targetAffinity = raw.get(edge.target)
      if (sourceAffinity && !topicById.has(edge.target)) {
        for (const [topicId, weight] of sourceAffinity) additions.push({ nodeId: edge.target, topicId, weight: weight * 0.26 })
      }
      if (targetAffinity && !topicById.has(edge.source)) {
        for (const [topicId, weight] of targetAffinity) additions.push({ nodeId: edge.source, topicId, weight: weight * 0.26 })
      }
    }
    for (const addition of additions) add(addition.nodeId, addition.topicId, addition.weight)
  }

  const affinities = new Map<string, NodeAffinity>()
  const regionWeights = new Map<string, number>()

  for (const [nodeId, weights] of raw) {
    let total = 0
    let x = 0
    let y = 0
    let topTopic: TopicSeed | null = null
    let topWeight = -Infinity

    for (const [topicId, weight] of weights) {
      const topic = topicById.get(topicId)
      if (!topic) continue
      total += weight
      x += topic.x * weight
      y += topic.y * weight
      if (weight > topWeight) {
        topWeight = weight
        topTopic = topic
      }
    }

    if (!topTopic || total <= 0) continue
    affinities.set(nodeId, {
      topicId: topTopic.id,
      label: topTopic.label,
      color: topTopic.color,
      x: x / total,
      y: y / total,
      weight: total,
    })

    if (nodeById.get(nodeId)?.type !== 'topic') {
      regionWeights.set(topTopic.id, (regionWeights.get(topTopic.id) ?? 0) + 1)
    }
  }

  return { topics, affinities, regionWeights }
}


function lightenNodeColor(node: GraphNodeDto, affinity: NodeAffinity | undefined): string {
  const typeColor = TYPE_COLORS[node.type] ?? '#94a3b8'
  if (node.type === 'topic') return typeof node.metadata.color === 'string' ? node.metadata.color : typeColor
  if (!affinity) return typeColor
  if (node.type === 'bookmark' || node.type === 'favorite') return mixColor(affinity.color, typeColor, 0.5)
  if (node.type === 'tag') return mixColor(affinity.color, typeColor, 0.36)
  return mixColor(affinity.color, typeColor, 0.58)
}

function computeRegions(sigma: Sigma, graph: Graph): TopicRegion[] {
  const dimensions = sigma.getDimensions()
  const topics: Array<{ id: string; label: string; color: string; weight: number; x: number; y: number }> = []

  graph.forEachNode((node, attrs) => {
    if (attrs.nodeKind !== 'topic') return
    const weight = Number(attrs.regionWeight ?? attrs.weight ?? 0)
    if (weight <= 0) return
    const viewport = sigma.graphToViewport({ x: Number(attrs.x ?? 0), y: Number(attrs.y ?? 0) })
    if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y)) return
    topics.push({
      id: node,
      label: String(attrs.fullLabel ?? attrs.label ?? node),
      color: String(attrs.baseColor ?? attrs.color ?? TYPE_COLORS.topic),
      weight,
      x: viewport.x,
      y: viewport.y,
    })
  })

  if (topics.length === 0) return []

  return computePowerDiagram(topics.map((topic) => ({ ...topic, count: Math.max(1, Math.round(topic.weight)) })), dimensions.width, dimensions.height)
    .filter((cell) => cell.path)
    .map((cell) => ({ id: cell.id, label: cell.label, color: cell.color, weight: cell.weight, path: cell.path,
      x: clamp(cell.centroid.x, 110, dimensions.width - 110), y: clamp(cell.centroid.y, 90, dimensions.height - 90) }))
}

function selectVisibleRegions(regions: TopicRegion[], selectedId: string | null): TopicRegion[] {
  const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = []
  const selected: TopicRegion[] = []
  const sorted = [...regions]
    .filter((region) => region.weight >= 2)
    .sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : b.weight - a.weight))

  for (const region of sorted) {
    const width = Math.min(220, Math.max(124, 44 + region.label.length * 7.4))
    const height = 38
    const box = {
      left: region.x - width / 2 - 8,
      right: region.x + width / 2 + 8,
      top: region.y - height / 2 - 8,
      bottom: region.y + height / 2 + 8,
    }
    const overlaps = boxes.some((item) => !(box.right < item.left || box.left > item.right || box.bottom < item.top || box.top > item.bottom))
    if (overlaps && region.id !== selectedId) continue
    boxes.push(box)
    selected.push(region)
    if (selected.length >= 14) break
  }

  return selected
}

function computeGraphLabels(sigma: Sigma, graph: Graph, selectedId: string | null, lastVisible: Set<string>, anchorsOut: Map<string, { x: number; y: number }>): GraphLabel[] {
  const dimensions = sigma.getDimensions()
  const candidates: Array<Parameters<typeof solveLabels>[0][number]> = []
  const anchors = new Map<string, { x: number; y: number }>()
  graph.forEachNode((id, attrs) => {
    const kind = String(attrs.nodeKind ?? '')
    const label = String(attrs.fullLabel ?? attrs.label ?? '')
    const weight = Number(attrs.weight ?? 0)
    const selected = id === selectedId
    const eligible = selected || kind === 'root' || kind === 'topic' || (kind !== 'bookmark' && kind !== 'favorite' && kind !== 'youtube' && weight >= 4)
    if (!eligible || !label) return
    const viewport = sigma.graphToViewport({ x: Number(attrs.x ?? 0), y: Number(attrs.y ?? 0) })
    if (viewport.x < -100 || viewport.x > dimensions.width + 100 || viewport.y < -60 || viewport.y > dimensions.height + 60) return
    anchors.set(id, { x: viewport.x, y: viewport.y })
    candidates.push({ id, label, x: viewport.x, y: viewport.y, radius: Number(attrs.size ?? 4) + 4,
      width: Math.min(230, 24 + Math.min(30, label.length) * 7), height: 27,
      priority: (selected ? 1e9 : kind === 'root' ? 9e8 : kind === 'topic' ? 8e8 + weight : 1e6 + weight) + (lastVisible.has(id) ? HYSTERESIS_BONUS : 0),
      force: selected || kind === 'root', color: String(attrs.baseColor ?? attrs.color ?? '#94a3b8'), kind })
  })
  const visible = solveLabels(candidates, dimensions.width, dimensions.height).filter((label) => !label.hidden).slice(0, 70)
  anchorsOut.clear()
  for (const label of visible) {
    const anchor = anchors.get(label.id)
    if (anchor) anchorsOut.set(label.id, anchor)
  }
  return visible.map((label) => ({
    id: label.id, label: label.label, x: label.x, y: label.y, width: label.width, color: label.color ?? '#94a3b8', kind: label.kind ?? 'node', selected: label.id === selectedId,
  }))
}

function computeBundledEdges(sigma: Sigma, graph: Graph): GraphEdgeRoute[] {
  const routes: GraphEdgeRoute[] = []
  let index = 0
  graph.forEachEdge((id, attrs, source, target, sourceAttrs, targetAttrs) => {
    const a = sigma.graphToViewport({ x: Number(sourceAttrs.x ?? 0), y: Number(sourceAttrs.y ?? 0) })
    const b = sigma.graphToViewport({ x: Number(targetAttrs.x ?? 0), y: Number(targetAttrs.y ?? 0) })
    const sourceGroup = String(sourceAttrs.topicGroup ?? '')
    const targetGroup = String(targetAttrs.topicGroup ?? '')
    const groupPoint = (groupId: string) => groupId && graph.hasNode(groupId)
      ? sigma.graphToViewport({ x: Number(graph.getNodeAttribute(groupId, 'x') ?? 0), y: Number(graph.getNodeAttribute(groupId, 'y') ?? 0) }) : null
    const ga = groupPoint(sourceGroup), gb = groupPoint(targetGroup)
    const dx = b.x - a.x, dy = b.y - a.y
    const dist = Math.hypot(dx, dy) || 1
    const side = ((index++ % 2) * 2 - 1)
    let path: string
    if (ga && gb && sourceGroup !== targetGroup) {
      // Cubic through territory hubs with a gentle perpendicular bow so parallel edges fan.
      const bow = Math.min(28, dist * 0.12) * side
      const c1x = a.x * 0.3 + ga.x * 0.55 + gb.x * 0.15 - dy / dist * bow * 0.4
      const c1y = a.y * 0.3 + ga.y * 0.55 + gb.y * 0.15 + dx / dist * bow * 0.4
      const c2x = b.x * 0.3 + gb.x * 0.55 + ga.x * 0.15 + dy / dist * bow * 0.4
      const c2y = b.y * 0.3 + gb.y * 0.55 + ga.y * 0.15 - dx / dist * bow * 0.4
      path = `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
    } else {
      const hub = ga ?? gb
      const bend = (hub ? 0.12 : 0.2) * side * Math.min(1, 80 / dist)
      const mx = hub ? hub.x * 0.55 + (a.x + b.x) * 0.225 : (a.x + b.x) / 2
      const my = hub ? hub.y * 0.55 + (a.y + b.y) * 0.225 : (a.y + b.y) / 2
      const cx = mx - dy * bend
      const cy = my + dx * bend
      path = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
    }
    routes.push({ id, path, correlated: String(attrs.edgeKind) === 'correlates_with' || String(attrs.edgeKind) === 'semantic_similarity', weight: Number(attrs.size ?? 1) })
  })
  return routes
}

export default function GraphCanvas({
  data,
  selectedId,
  onSelect,
  onNavigate,
  layoutMode,
  dimension = 0.68,
  focusQuery = '',
}: {
  data: GraphResponse
  selectedId: string | null
  onSelect: (id: string | null) => void
  onNavigate: (id: string) => void
  layoutMode: LayoutMode
  dimension?: number
  focusQuery?: string
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const graphRef = useRef<Graph | null>(null)
  const regionFrameRef = useRef<number | null>(null)
  const pointsRef = useRef<UnifiedPoint[]>([])
  const scheduleOverlaysRef = useRef<(() => void) | null>(null)
  const labelElsRef = useRef(new Map<string, HTMLButtonElement>())
  const labelAnchorsRef = useRef(new Map<string, { x: number; y: number }>())
  const lastVisibleLabelsRef = useRef(new Set<string>())
  const solveTimerRef = useRef<number | undefined>(undefined)
  const vectorsRef = useRef<Map<string, number[]> | null>(null)
  const relevanceRef = useRef(new Map<string, number>())
  const focusActiveRef = useRef(false)
  const [regions, setRegions] = useState<TopicRegion[]>([])
  const [labels, setLabels] = useState<GraphLabel[]>([])
  const [edgeRoutes, setEdgeRoutes] = useState<GraphEdgeRoute[]>([])

  // Latest-value refs: the build effect must not re-run for these, and sigma handlers
  // are registered once against callbacks whose identity changes every render.
  const selectedIdRef = useRef(selectedId)
  const onSelectRef = useRef(onSelect)
  const onNavigateRef = useRef(onNavigate)
  const viewRef = useRef({ dimension, lens: layoutMode, focusQuery })
  selectedIdRef.current = selectedId
  onSelectRef.current = onSelect
  onNavigateRef.current = onNavigate
  viewRef.current = { dimension, lens: layoutMode, focusQuery }

  // Continuous-interaction path: labels ride along with their nodes via one transform
  // write each — no solver, no React commit. The full re-solve waits for idle.
  const nudgeOverlays = () => {
    const sigma = sigmaRef.current
    const graph = graphRef.current
    if (sigma && graph) {
      for (const [id, el] of labelElsRef.current) {
        const anchor = labelAnchorsRef.current.get(id)
        if (!anchor || !graph.hasNode(id)) continue
        const viewport = sigma.graphToViewport({ x: Number(graph.getNodeAttribute(id, 'x') ?? 0), y: Number(graph.getNodeAttribute(id, 'y') ?? 0) })
        el.style.transform = `translate(-50%, -50%) translate(${(viewport.x - anchor.x).toFixed(2)}px, ${(viewport.y - anchor.y).toFixed(2)}px)`
      }
    }
    window.clearTimeout(solveTimerRef.current)
    solveTimerRef.current = window.setTimeout(() => scheduleOverlaysRef.current?.(), SOLVE_IDLE_MS)
  }

  useEffect(() => {
    if (!containerRef.current) return

    sigmaRef.current?.kill()
    vectorsRef.current = null
    const graph = new Graph({ multi: false, type: 'undirected' })
    const layout = buildTopicLayout(data)
    const { dimension: viewDimension, lens, focusQuery: viewFocus } = viewRef.current
    const previous = readPreviousPositions()
    // Hand-placed per-topic geography: the topic's bearing is the user's spatial memory.
    const groupAnchors = Object.fromEntries(layout.topics.map((topic) => [topic.id, { x: topic.x, y: topic.y }]))
    const positions = unifiedLayout(data.nodes.map((node) => ({
      id: node.id, label: node.label, kind: node.type, count: node.weight,
      itemType: node.type === 'bookmark' ? 'x' : node.type === 'favorite' || node.type === 'youtube' ? node.type : undefined,
      groupId: layout.affinities.get(node.id)?.topicId ?? node.type,
      color: typeof node.metadata.color === 'string' ? node.metadata.color : TYPE_COLORS[node.type],
      meta: node.metadata, fixed: node.type === 'root',
    })), data.edges, { level: 'graph', lens, dimension: viewDimension, focusQuery: viewFocus, previous, groupAnchors })
    pointsRef.current = positions.points
    writePreviousPositions(positions.points)
    const positionById = new Map(positions.points.map((point) => [point.id, point]))

    data.nodes.forEach((node) => {
      const position = positionById.get(node.id) ?? { x: 0, y: 0 }
      const affinity = layout.affinities.get(node.id)
      const color = lightenNodeColor(node, affinity)
      const size = nodeSize(node)
      const regionWeight = layout.regionWeights.get(node.id) ?? node.weight

      graph.addNode(node.id, {
        label: graphLabel(node),
        fullLabel: node.label,
        graphLabel: graphLabel(node),
        x: position.x,
        y: position.y,
        size,
        baseSize: size,
        color,
        baseColor: color,
        weight: node.weight,
        regionWeight,
        nodeKind: node.type,
        topicAffinity: affinity?.label ?? null,
        topicGroup: affinity?.topicId ?? null,
        forceLabel: node.type === 'root',
        zIndex: node.type === 'topic' ? 4 : (node.type === 'bookmark' || node.type === 'favorite') ? 3 : 2,
      })
    })

    data.edges.forEach((edge) => {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) return
      if (graph.hasEdge(edge.id)) return
      const color = typeof edge.metadata.color === 'string'
        ? edge.metadata.color
        : edge.type === 'correlates_with'
          ? 'rgba(251,191,36,.14)'
          : 'rgba(100,116,139,.035)'
      graph.addEdgeWithKey(edge.id, edge.source, edge.target, {
        size: Math.max(0.35, Math.min(2.8, edge.type === 'correlates_with' ? edge.weight * 0.9 : edge.weight)),
        color,
        baseColor: color,
        edgeKind: edge.type,
      })
    })

    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: false,
      renderEdgeLabels: false,
      labelDensity: 0.08,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 15,
      labelColor: { color: '#f8fafc' },
      defaultDrawNodeLabel: drawReadableNodeLabel,
      defaultEdgeColor: '#475569',
      hideEdgesOnMove: true,
      hideLabelsOnMove: false,
      allowInvalidContainer: true,
      zIndex: true,
    })

    const scheduleRegions = () => {
      window.clearTimeout(solveTimerRef.current)
      if (regionFrameRef.current !== null) cancelAnimationFrame(regionFrameRef.current)
      regionFrameRef.current = requestAnimationFrame(() => {
        regionFrameRef.current = null
        setRegions(computeRegions(sigma, graph))
        const solved = computeGraphLabels(sigma, graph, selectedIdRef.current, lastVisibleLabelsRef.current, labelAnchorsRef.current)
        lastVisibleLabelsRef.current = new Set(solved.map((label) => label.id))
        setLabels(solved)
        setEdgeRoutes(computeBundledEdges(sigma, graph))
      })
    }

    sigma.on('clickNode', ({ node, event }) => {
      event?.preventSigmaDefault?.()
      onSelectRef.current(node)
      onNavigateRef.current(node)
    })
    sigma.on('clickStage', () => onSelectRef.current(null))
    sigma.on('enterNode', ({ node }) => {
      containerRef.current?.classList.add('is-pointing')
      graph.setNodeAttribute(node, 'highlighted', true)
      sigma.refresh({ partialGraph: { nodes: [node] } })
    })
    sigma.on('leaveNode', ({ node }) => {
      containerRef.current?.classList.remove('is-pointing')
      graph.removeNodeAttribute(node, 'highlighted')
      sigma.refresh({ partialGraph: { nodes: [node] } })
    })
    sigma.getCamera().on('updated', nudgeOverlays)
    sigma.on('resize', scheduleRegions)
    scheduleOverlaysRef.current = scheduleRegions
    window.setTimeout(scheduleRegions, 0)

    sigmaRef.current = sigma
    graphRef.current = graph

    return () => {
      window.clearTimeout(solveTimerRef.current)
      if (regionFrameRef.current !== null) cancelAnimationFrame(regionFrameRef.current)
      sigma.kill()
      sigmaRef.current = null
      graphRef.current = null
      scheduleOverlaysRef.current = null
      labelAnchorsRef.current = new Map()
      lastVisibleLabelsRef.current = new Set()
      setRegions([])
      setLabels([])
      setEdgeRoutes([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Dimension/lens are a pure re-projection of the cached raw 4D coords: no settle,
  // no Sigma construction, no camera reset, no per-tick solve.
  useEffect(() => {
    const graph = graphRef.current
    const sigma = sigmaRef.current
    if (!graph || !sigma || pointsRef.current.length === 0) return

    const projected = new Map(reprojectPoints(pointsRef.current, dimension, layoutMode).map((point) => [point.id, point]))
    // One batched event: per-node setNodeAttribute pairs cost ~2n graphology events per tick
    graph.updateEachNodeAttributes((id, attrs) => {
      const point = projected.get(id)
      if (point) { attrs.x = point.x; attrs.y = point.y }
      return attrs
    }, { attributes: ['x', 'y'] })
    sigma.refresh()
    nudgeOverlays()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension, layoutMode])

  // A solve commit repositions labels through left/top; stale nudge transforms must not survive it.
  useLayoutEffect(() => {
    for (const el of labelElsRef.current.values()) el.style.transform = ''
  }, [labels])

  const applyHighlights = () => {
    const graph = graphRef.current
    const sigma = sigmaRef.current
    if (!graph || !sigma) return

    const selected = selectedIdRef.current
    const neighbors = selected && graph.hasNode(selected) ? new Set(graph.neighbors(selected)) : new Set<string>()
    graph.forEachNode((node, attrs) => {
      const baseColor = String(attrs.baseColor ?? attrs.color ?? '#94a3b8')
      const baseSize = Number(attrs.baseSize ?? attrs.size ?? 6)
      const defaultLabel = String(attrs.graphLabel ?? '')
      const fullLabel = String(attrs.fullLabel ?? defaultLabel)
      const isSelected = node === selected
      const isNeighbor = selected ? neighbors.has(node) : false
      const relevance = focusActiveRef.current ? Math.max(0, relevanceRef.current.get(node) ?? 0) : 0
      const size = baseSize * (1 + relevance * 0.6)
      const shouldDim = Boolean(selected && !isSelected && !isNeighbor) || (focusActiveRef.current && !isSelected && relevance < 0.05)

      graph.setNodeAttribute(node, 'label', isSelected || (isNeighbor && baseSize >= 8) ? fullLabel : defaultLabel)
      graph.setNodeAttribute(node, 'color', shouldDim ? '#3f3f46' : isSelected ? '#f8fafc' : baseColor)
      graph.setNodeAttribute(node, 'size', isSelected ? Math.max(size, 14) : isNeighbor ? Math.max(size, size * 1.12) : size)
      graph.setNodeAttribute(node, 'forceLabel', isSelected || (isNeighbor && baseSize >= 8) || attrs.nodeKind === 'root')
    })

    graph.forEachEdge((edge, attrs) => {
      const [source, target] = graph.extremities(edge)
      const related = !selected || source === selected || target === selected || neighbors.has(source) || neighbors.has(target)
      graph.setEdgeAttribute(edge, 'color', related ? String(attrs.baseColor ?? attrs.color ?? '#64748b') : '#27272a')
      graph.setEdgeAttribute(edge, 'size', related ? Number(attrs.size ?? 1) : 0.25)
    })

    sigma.refresh()
  }

  useEffect(() => {
    applyHighlights()
    scheduleOverlaysRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // Focus relevance is a render channel: re-scored in place from cached vectors on
  // question change — never a relayout, never a reprojection. focusQuery arrives per
  // keystroke here (live search box), so the restyle waits for a typing pause.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = focusQuery.trim()
      focusActiveRef.current = Boolean(query)
      if (!query) {
        relevanceRef.current = new Map()
      } else {
        if (!vectorsRef.current) vectorsRef.current = new Map(data.nodes.map((node) => [node.id, graphNodeVector(node)]))
        relevanceRef.current = focusScores(vectorsRef.current, query)
      }
      applyHighlights()
      scheduleOverlaysRef.current?.()
    }, 160)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, focusQuery])

  const territoryPaths = useMemo(() => regions.map((region) => (
    <path key={region.id} d={region.path} fill={region.color} />
  )), [regions])
  const edgePaths = useMemo(() => edgeRoutes.map((edge) => (
    <path key={edge.id} d={edge.path} className={edge.correlated ? 'correlated' : ''} style={{ strokeWidth: Math.max(.35, Math.min(1.8, edge.weight * .55)) }} />
  )), [edgeRoutes])
  const labelButtons = useMemo(() => labels.map((label) => <button key={label.id} className={`${label.selected ? 'active' : ''} kind-${label.kind}`}
    ref={(el) => {
      if (el) labelElsRef.current.set(label.id, el)
      else labelElsRef.current.delete(label.id)
    }}
    style={{ left: `${label.x}px`, top: `${label.y}px`, width: `${label.width}px`, borderColor: label.color }} onClick={() => onNavigateRef.current(label.id)} title={label.label}>
    <i style={{ background: label.color }} /><span>{label.label}</span>
  </button>), [labels])

  return (
    <div className="graph-frame">
      <svg className="topic-territories" aria-hidden="true">
        {(layoutMode === 'territories' || layoutMode === 'unified') && territoryPaths}
      </svg>
      <svg className="edge-routes graph-bundles" aria-hidden="true">
        {edgePaths}
      </svg>
      <div ref={containerRef} className="graph-canvas" />
      <div className="graph-label-pills" aria-label="Graph labels">
        {labelButtons}
      </div>
      <div className="region-labels" aria-label="Topic territories">
        {(layoutMode === 'territories' || layoutMode === 'unified') && selectVisibleRegions(regions, selectedId)
          .map((region) => (
            <button
              key={region.id}
              className={region.id === selectedId ? 'active' : ''}
              style={{ left: `${region.x}px`, top: `${region.y}px`, borderColor: region.color }}
              onClick={(event) => {
                event.stopPropagation()
                onNavigate(region.id)
              }}
              title={`Explore ${region.label} (${Math.round(region.weight).toLocaleString()} nearby nodes)`}
            >
              <span>{region.label}</span>
            </button>
          ))}
      </div>
    </div>
  )
}
