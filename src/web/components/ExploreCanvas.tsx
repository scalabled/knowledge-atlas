import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { Minus, Plus, Scan } from 'lucide-react'
import type { LayoutMode } from './GraphCanvas'
import { computePowerDiagram, reprojectPoints, solveLabels, stableUnit, unifiedLayout, type Point4D, type UnifiedPoint, type ViewLens } from '../layout/unified-layout'
import { createDustProgram, createOrbProgram, createRenderState, MAX_DUST_HUBS } from '../render/DustProgram'
import { buildAtlasSparks, buildCategorySparks, writeProjRows, atlasClampR, type AtlasDustHub, type DustPayload, type DustSpark } from '../render/dust-field'
import { embedText, parseEmbedding } from '../../lib/semantic'

export type Facet = 'tags' | 'authors' | 'domains' | 'channels'

export interface ExploreChild {
  id: string
  kind: 'topic' | 'tag' | 'author' | 'domain' | 'channel' | 'item'
  itemType?: 'x' | 'favorite' | 'youtube' | 'document'
  label: string
  count?: number
  sourceCounts?: { x: number; web: number; youtube: number }
  recencyMs?: number
  color?: string
  groupId?: string
  createdAt?: string | null
  meta?: Record<string, unknown>
}

export interface ExploreEdge {
  source: string
  target: string
  weight: number
  sharedTags?: string[]
  sharedDomain?: string
}

export interface ExploreConcept {
  id: string
  key: string
  label: string
  count: number
  color: string
  memberIds: string[]
  summary?: string
}

export interface ExploreBridge {
  nodeId: string
  label: string
  bridgeScore: number
  concepts: string[]
}

export interface ExploreResponse {
  level: 'atlas' | 'topic' | 'category' | 'search'
  title: string
  topic?: { slug: string; name: string; color: string; description: string | null } | null
  facet?: Facet
  key?: string
  query?: string
  center?: ExploreChild | null
  children: ExploreChild[]
  groups?: ExploreChild[]
  edges: ExploreEdge[]
  results: unknown[]
  total: number
  concepts?: ExploreConcept[]
  bridges?: ExploreBridge[]
  expandedTerms?: string[]
}

const ITEM_COLORS: Record<string, string> = {
  x: '#38bdf8',
  favorite: '#34d399',
  youtube: '#f87171',
  document: '#a78bfa',
}

const SOURCE_REGION_LABELS: Record<string, string> = {
  x: 'X bookmarks',
  favorite: 'Web favorites',
  youtube: 'YouTube',
}

interface PlacedNode {
  child: ExploreChild
  x: number
  y: number
  r: number
  isCenter?: boolean
  isGroup?: boolean
}

interface Pill {
  id: string
  label: string
  count?: number
  x: number
  y: number
  color: string
  kind: string
  isCenter: boolean
  isGroup: boolean
}

interface RegionSeed {
  id: string
  label: string
  color: string
  x: number
  y: number
  count: number
  showLabel?: boolean
}

interface Region {
  id: string
  label: string
  color: string
  path: string
  x: number
  y: number
  count: number
  showLabel: boolean
}

interface EdgeRoute {
  id: string
  path: string
  weight: number
  correlated: boolean
  /** Real co-occurrence arcs at atlas/topic: endpoint-hued gradient filaments, alpha-capped. */
  filament?: { colorA: string; colorB: string; x1: number; y1: number; x2: number; y2: number }
  /** Closed tapered-ribbon polygon (filled, not stroked): bus width = real count/weight. */
  fill?: boolean
  opacity?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Tapered ribbon along a quadratic arc — Morpho-style bus edge; width carries the data. */
function taperedPath(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, widthAt: (t: number) => number): string {
  const left: string[] = []
  const right: string[] = []
  const samples = 10
  for (let s = 0; s <= samples; s++) {
    const t = s / samples
    const mt = 1 - t
    const px = mt * mt * x1 + 2 * mt * t * cx + t * t * x2
    const py = mt * mt * y1 + 2 * mt * t * cy + t * t * y2
    const dx = 2 * mt * (cx - x1) + 2 * t * (x2 - cx)
    const dy = 2 * mt * (cy - y1) + 2 * t * (y2 - cy)
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const w = widthAt(t) / 2
    left.push(`${(px + nx * w).toFixed(1)},${(py + ny * w).toFixed(1)}`)
    right.push(`${(px - nx * w).toFixed(1)},${(py - ny * w).toFixed(1)}`)
  }
  right.reverse()
  return `M${left.join('L')}L${right.join('L')}Z`
}

/** Median member recency as a lightness shift on aggregate orbitals — fresh tags glow
 * lighter, dormant ones ember down. Hue (the identity channel) never moves. */
function recencyTint(hex: string, recencyMs?: number): string {
  if (!recencyMs || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  const fresh = clamp(1 - (Date.now() - recencyMs) / (3 * 365.25 * 86400000), 0, 1)
  const shift = (fresh - 0.45) * 0.22
  const n = parseInt(hex.slice(1), 16)
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  if (shift >= 0) {
    r = Math.round(r + (255 - r) * shift); g = Math.round(g + (255 - g) * shift); b = Math.round(b + (255 - b) * shift)
  } else {
    r = Math.round(r * (1 + shift)); g = Math.round(g * (1 + shift)); b = Math.round(b * (1 + shift))
  }
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

// Invalidate pre-v3 layout caches (spacing/curve refresh) and legacy keys.
try {
  const stale: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith('atlas-layout:') && !key.startsWith('atlas-layout:v3:')) stale.push(key)
  }
  for (const key of stale) localStorage.removeItem(key)
} catch { /* storage unavailable */ }

function runLayout(mode: LayoutMode, data: ExploreResponse, dimension: number): { placed: PlacedNode[]; points: UnifiedPoint[] } {
  const groupIds = new Set((data.groups ?? []).map((group) => group.id))
  const all = [...(data.center ? [data.center] : []), ...(data.groups ?? []), ...data.children]
  // View identity only — mode/dimension/query must all hit the same stability cache
  const context = `atlas-layout:v3:${data.level}:${data.topic?.slug ?? ''}:${data.facet ?? ''}:${data.key ?? ''}`
  let previous: Record<string, Point4D> | undefined
  try { previous = JSON.parse(localStorage.getItem(context) ?? 'null') ?? undefined } catch { previous = undefined }
  const lens: ViewLens = mode
  const result = unifiedLayout(all.map((child) => ({
    ...child,
    groupId: groupIds.has(child.id) ? child.id : child.groupId,
    fixed: child.id === data.center?.id,
  })), data.edges, { level: data.level, lens, dimension, focusQuery: data.query, previous })
  try {
    localStorage.setItem(context, JSON.stringify(Object.fromEntries(result.points.map((point) => [point.id, { x: point.x, y: point.y, z: point.z, w: point.w }]))))
  } catch { /* private browsing or storage quota: layout still works */ }
  const byId = new Map(all.map((child) => [child.id, child]))
  const placed = result.points.flatMap((point) => {
    const child = byId.get(point.id)
    return child ? [{ child, x: point.x, y: point.y, r: point.r, isCenter: point.fixed, isGroup: groupIds.has(point.id) }] : []
  })
  return { placed, points: result.points }
}

/** Voronoi region seeds for the territory overlay, per level. */
function regionSeeds(data: ExploreResponse, placed: PlacedNode[]): RegionSeed[] {
  if (data.level === 'atlas') {
    return placed.map((node) => ({
      id: node.child.id,
      label: node.child.label,
      color: node.child.color ?? '#a78bfa',
      x: node.x,
      y: node.y,
      count: node.child.count ?? 1,
    }))
  }
  if (data.level === 'topic') {
    return placed.filter((node) => !node.isCenter).map((node) => ({
      id: node.child.id,
      label: node.child.label,
      color: node.child.color ?? data.topic?.color ?? '#a78bfa',
      x: node.x,
      y: node.y,
      count: node.child.count ?? 1,
    }))
  }
  if (data.level === 'category') {
    // One territory per source, seeded at the sector centroid and labelled explicitly
    const groups = new Map<string, { x: number; y: number; count: number }>()
    for (const node of placed) {
      if (node.child.kind !== 'item' || !node.child.itemType) continue
      const entry = groups.get(node.child.itemType) ?? { x: 0, y: 0, count: 0 }
      entry.x += node.x
      entry.y += node.y
      entry.count++
      groups.set(node.child.itemType, entry)
    }
    return [...groups.entries()].map(([type, entry]) => ({
      id: `region:${type}`,
      label: `${SOURCE_REGION_LABELS[type] ?? type} · ${entry.count}`,
      color: ITEM_COLORS[type] ?? '#94a3b8',
      x: entry.x / entry.count,
      y: entry.y / entry.count,
      count: entry.count,
      showLabel: true,
    }))
  }
  return placed.filter((node) => node.isGroup).map((node) => ({
    id: node.child.id,
    label: node.child.label,
    color: node.child.color ?? '#a78bfa',
    x: node.x,
    y: node.y,
    count: node.child.count ?? 1,
  }))
}

function computeRegions(sigma: Sigma, seeds: RegionSeed[]): Region[] {
  if (!seeds.length) return []
  const dimensions = sigma.getDimensions()
  const viewportSeeds = seeds
    .map((seed) => ({ ...seed, ...sigma.graphToViewport({ x: seed.x, y: seed.y }) }))
    .filter((seed) => Number.isFinite(seed.x) && Number.isFinite(seed.y))
  if (!viewportSeeds.length) return []
  return computePowerDiagram(viewportSeeds.map((seed) => ({ ...seed, weight: Math.max(1, seed.count) })), dimensions.width, dimensions.height)
    .filter((cell) => cell.path)
    .map((cell) => ({ id: cell.id, label: cell.label, color: cell.color, count: cell.count,
      showLabel: Boolean(viewportSeeds.find((seed) => seed.id === cell.id)?.showLabel), path: cell.path,
      x: clamp(cell.centroid.x, 70, dimensions.width - 70), y: clamp(cell.centroid.y, 24, dimensions.height - 24) }))
}

function nodeColor(placedNode: PlacedNode, data: ExploreResponse): string {
  const child = placedNode.child
  if (child.kind === 'item') return ITEM_COLORS[child.itemType ?? 'x'] ?? '#94a3b8'
  const base = child.color ?? data.topic?.color ?? '#a78bfa'
  // Atlas hubs keep the pure identity palette; orbitals inside a topic vary by real recency
  if (data.level === 'atlas' || child.kind === 'topic' || placedNode.isCenter) return base
  return recencyTint(base, child.recencyMs)
}

function estimatePillWidth(pill: { label: string; count?: number; isCenter: boolean }): number {
  const chars = Math.min(pill.label.length, pill.isCenter ? 44 : 34)
  return 26 + chars * 6.7 + (pill.count !== undefined ? 34 : 0)
}

// Duplicated in GraphCanvas: value exports there would break both canvases' fast-refresh boundaries.
/** Continuous interactions (slider drag, camera motion) defer the label/territory
 * re-solve until this much idle; between solves pills ride along via CSS transforms. */
const SOLVE_IDLE_MS = 120
/** Survivors of the previous solve outrank same-tier newcomers so pills stop popping.
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

// Mirrors unified-layout's nodeVector so client-side relevance rescoring matches the layout's.
function childVector(child: ExploreChild): number[] {
  const stored = parseEmbedding(child.meta?.embedding)
  if (stored.length >= 8) return stored
  const topics = Array.isArray(child.meta?.topics) ? child.meta?.topics.join(' ') : ''
  const tags = Array.isArray(child.meta?.tags) ? child.meta?.tags.join(' ') : ''
  return embedText(`${child.label} ${topics} ${tags}`)
}

export default function ExploreCanvas({
  data,
  layoutMode = 'unified',
  dimension = 0.68,
  focusQuery = '',
  selectedId,
  onSelect,
  onActivate,
}: {
  data: ExploreResponse
  layoutMode?: LayoutMode
  dimension?: number
  focusQuery?: string
  selectedId: string | null
  onSelect: (child: ExploreChild | null) => void
  onActivate: (child: ExploreChild) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const graphRef = useRef<Graph | null>(null)
  const frameRef = useRef<number | null>(null)
  const schedulePillsRef = useRef<(() => void) | null>(null)
  const pointsRef = useRef<UnifiedPoint[]>([])
  const placedRef = useRef<PlacedNode[]>([])
  const placedByIdRef = useRef<Map<string, PlacedNode>>(new Map())
  const [pills, setPills] = useState<Pill[]>([])
  const [regions, setRegions] = useState<Region[]>([])
  const [edgeRoutes, setEdgeRoutes] = useState<EdgeRoute[]>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const pillElsRef = useRef(new Map<string, HTMLButtonElement>())
  const pillAnchorsRef = useRef(new Map<string, { x: number; y: number }>())
  const lastVisiblePillsRef = useRef(new Set<string>())
  const solveTimerRef = useRef<number | undefined>(undefined)
  const vectorsRef = useRef<Map<string, number[]> | null>(null)
  const relevanceRef = useRef(new Map<string, number>())
  const focusActiveRef = useRef(false)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  const hoveredRef = useRef<string | null>(null)
  hoveredRef.current = hoveredId
  const dimensionRef = useRef(dimension)
  dimensionRef.current = dimension
  const layoutModeRef = useRef(layoutMode)
  layoutModeRef.current = layoutMode
  const renderStateRef = useRef(createRenderState())
  const dustHubIndexRef = useRef(new Map<string, number>())
  const dustFadeRef = useRef<number | null>(null)
  const growRef = useRef<number | null>(null)
  const commitTimerRef = useRef<number | undefined>(undefined)
  const [dustCount, setDustCount] = useState(0)
  const [glEpoch, setGlEpoch] = useState(0)

  const showTerritories = layoutMode === 'unified' || layoutMode === 'territories'

  const childById = useMemo(() => {
    const map = new Map<string, ExploreChild>()
    if (data.center) map.set(data.center.id, data.center)
    for (const group of data.groups ?? []) map.set(group.id, group)
    for (const child of data.children) map.set(child.id, child)
    return map
  }, [data])

  // Continuous-interaction path: pills ride along with their nodes via one transform
  // write each — no solver, no React commit. The full re-solve waits for idle.
  const nudgeOverlays = () => {
    const sigma = sigmaRef.current
    if (sigma) {
      for (const [id, el] of pillElsRef.current) {
        const anchor = pillAnchorsRef.current.get(id)
        const node = placedByIdRef.current.get(id)
        if (!anchor || !node) continue
        const viewport = sigma.graphToViewport({ x: node.x, y: node.y })
        el.style.transform = `translate(-50%, 0) translate(${(viewport.x - anchor.x).toFixed(2)}px, ${(viewport.y - anchor.y).toFixed(2)}px)`
      }
    }
    window.clearTimeout(solveTimerRef.current)
    solveTimerRef.current = window.setTimeout(() => schedulePillsRef.current?.(), SOLVE_IDLE_MS)
  }

  // World build: graphology + Sigma + one full settle. Sigma teardown lives only here.
  // Lens changes reproject through the effect below — they must never land here.
  useEffect(() => {
    if (!containerRef.current) return
    sigmaRef.current?.kill()
    vectorsRef.current = null

    const graph = new Graph({ multi: false, type: 'undirected' })
    const { placed, points } = runLayout(layoutModeRef.current, data, dimensionRef.current)
    pointsRef.current = points
    placedRef.current = placed
    placedByIdRef.current = new Map(placed.map((node) => [node.child.id, node]))
    const pointById = new Map(points.map((point) => [point.id, point]))

    // Same reference the layout used, so dust z-deltas live on the identical time axis
    const dated = [...(data.center ? [data.center] : []), ...(data.groups ?? []), ...data.children]
      .map((child) => child.createdAt ? new Date(child.createdAt).getTime() : child.recencyMs ?? NaN)
      .filter(Number.isFinite)
    const referenceTime = dated.length ? Math.max(...dated) : Date.UTC(2026, 0, 1)

    const state = renderStateRef.current
    writeProjRows(state, dimensionRef.current, layoutModeRef.current)
    state.lensAlpha = layoutModeRef.current === 'territories' ? 0 : 1
    state.globalAlpha = 0
    state.focusHub = -1
    state.queryDim = 1
    state.hubRaw.fill(0)
    dustHubIndexRef.current = new Map()
    const dustHubs = new Map<string, AtlasDustHub>()
    let categoryCenter = { x: 0, y: 0 }
    if (data.level === 'atlas') {
      let slot = 0
      for (const node of placed) {
        if (node.child.kind !== 'topic' || slot >= MAX_DUST_HUBS) continue
        const point = pointById.get(node.child.id)
        if (!point) continue
        state.hubRaw.set([point.rawX, point.rawY, point.z, point.w], slot * 4)
        dustHubIndexRef.current.set(node.child.id, slot)
        dustHubs.set(node.child.id, { point, color: node.child.color ?? '#a78bfa', muted: node.child.meta?.slug === 'unsorted' })
        slot++
      }
    } else if (data.level === 'category' && data.center) {
      // The overflow ring circles the item cloud, not the origin-fixed center node:
      // project4D is linear, so the raw-space mean tracks the on-screen mean exactly
      // under every dimension/lens — the halo never detaches from its cluster.
      const cloud = placed.filter((node) => !node.isCenter)
      const source = cloud.length ? cloud : placed
      let rawX = 0, rawY = 0, z = 0, w = 0, px = 0, py = 0
      for (const node of source) {
        const point = pointById.get(node.child.id)
        rawX += point?.rawX ?? node.x; rawY += point?.rawY ?? node.y
        z += point?.z ?? 0; w += point?.w ?? 0
        px += node.x; py += node.y
      }
      const n = source.length || 1
      state.hubRaw.set([rawX / n, rawY / n, z / n, w / n], 0)
      dustHubIndexRef.current.set(data.center.id, 0)
      categoryCenter = { x: px / n, y: py / n }
    }

    for (const node of placed) {
      if (graph.hasNode(node.child.id)) continue
      const point = pointById.get(node.child.id)
      graph.addNode(node.child.id, {
        x: node.x,
        y: node.y,
        size: node.r * 2.3,
        baseSize: node.r * 2.3,
        color: nodeColor(node, data),
        baseColor: nodeColor(node, data),
        label: null,
        type: 'orb',
        rx: point?.rawX ?? node.x,
        ry: point?.rawY ?? node.y,
        rz: point?.z ?? 0,
        rw: point?.w ?? 0,
        halo: node.child.kind === 'topic' || node.isCenter ? 1 : node.isGroup ? 0.7 : 0,
        isCenter: Boolean(node.isCenter),
        isGroup: Boolean(node.isGroup),
        kind: node.child.kind,
        zIndex: node.isCenter || node.isGroup ? 3 : 2,
      })
    }

    // Faint spokes from the level hub; gold correlations between items. Atlas/topic
    // co-occurrence arcs render only as SVG filaments — never as WebGL edges — and
    // topic membership spokes render as tapered SVG ribbons (width = member count).
    const spokeTargets = data.level === 'search'
      ? data.children.map((child) => ({ from: child.groupId, to: child.id }))
      : data.center && data.level !== 'topic'
        ? data.children.map((child) => ({ from: data.center!.id, to: child.id }))
        : []
    for (const spoke of spokeTargets) {
      if (!spoke.from || !graph.hasNode(spoke.from) || !graph.hasNode(spoke.to)) continue
      graph.addEdge(spoke.from, spoke.to, { size: 0.4, color: 'rgba(71, 85, 105, 0.38)', zIndex: 0 })
    }
    if (data.level === 'category' || data.level === 'search') {
      // Dense correlation webs stay a garnish: alpha eases off as the count grows
      const goldAlpha = clamp(0.55 * Math.sqrt(36 / Math.max(1, data.edges.length)), 0.26, 0.55)
      for (const edge of data.edges) {
        if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target) || graph.hasEdge(edge.source, edge.target)) continue
        graph.addEdge(edge.source, edge.target, {
          size: clamp(edge.weight * 0.5, 0.6, 2.2),
          color: `rgba(251, 191, 36, ${goldAlpha.toFixed(3)})`,
          zIndex: 1,
        })
      }
    }

    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: false,
      renderEdgeLabels: false,
      defaultEdgeColor: 'rgba(71, 85, 105, 0.4)',
      hideEdgesOnMove: true,
      allowInvalidContainer: true,
      zIndex: true,
      minCameraRatio: 0.04,
      maxCameraRatio: 2.2,
      stagePadding: 72,
      nodeProgramClasses: {
        dust: createDustProgram(state),
        orb: createOrbProgram(state),
      },
    })

    // Freeze the stage box: dust and halos need breathing room, a frozen extent means
    // slider ticks can move geometry in-shader without the camera frame drifting, and
    // the in-shader programs replicate sigma's normalization from this exact box.
    const wantsDust = layoutModeRef.current !== 'territories'
      && (data.level === 'atlas' || (data.level === 'category' && data.total > data.children.length))
    let categoryRing: { rIn: number; rOut: number } | null = null
    {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const node of placed) {
        minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x)
        minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y)
      }
      if (!Number.isFinite(minX)) { minX = 0; maxX = 0; minY = 0; maxY = 0 }
      let pad = 0
      if (data.level === 'atlas') {
        for (const node of placed) pad = Math.max(pad, atlasClampR(node.r))
        pad *= 0.8
      } else if (data.level === 'category') {
        pad = 4
        let rMax = 8
        for (const node of placed) rMax = Math.max(rMax, Math.hypot(node.x - categoryCenter.x, node.y - categoryCenter.y) + node.r)
        // A tight halo just past the items — "there is more here", never a void that
        // shrinks the 150 real items into a corner of the stage.
        const rIn = rMax + 2.5
        categoryRing = { rIn, rOut: rIn + clamp(rIn * 0.16, 5, 9) }
        if (wantsDust) {
          minX = Math.min(minX, categoryCenter.x - categoryRing.rOut); maxX = Math.max(maxX, categoryCenter.x + categoryRing.rOut)
          minY = Math.min(minY, categoryCenter.y - categoryRing.rOut); maxY = Math.max(maxY, categoryCenter.y + categoryRing.rOut)
        }
      }
      const box = { x: [minX - pad, maxX + pad] as [number, number], y: [minY - pad, maxY + pad] as [number, number] }
      sigma.setCustomBBox(box)
      // Mirror createNormalizationFunction exactly, guards included
      let ratio = Math.max(box.x[1] - box.x[0], box.y[1] - box.y[0])
      if (ratio === 0 || !Number.isFinite(ratio)) ratio = 1
      state.stage[0] = (box.x[0] + box.x[1]) / 2
      state.stage[1] = (box.y[0] + box.y[1]) / 2
      state.stage[2] = 1 / ratio
    }

    const reduceMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

    // Level entry blooms instead of swapping: orbs grow in from their (final) anchors.
    // One uniform per frame — positions, pills, and hit areas are never animated.
    state.grow = reduceMotion ? 1 : 0
    if (!reduceMotion) {
      const growStart = performance.now()
      const growStep = (ts: number) => {
        const t = Math.min(1, (ts - growStart) / 380)
        state.grow = t * t * (3 - 2 * t)
        sigma.scheduleRender()
        growRef.current = t < 1 ? requestAnimationFrame(growStep) : null
      }
      growRef.current = requestAnimationFrame(growStep)
    }

    // A lost GL context leaves every program dead: allow restore, rebuild the world.
    const glCanvas = sigma.getCanvases().nodes
    const onContextLost = (event: Event) => {
      event.preventDefault()
      setGlEpoch((epoch) => epoch + 1)
    }
    glCanvas?.addEventListener('webglcontextlost', onContextLost)

    // Dust arrives async and fades in; the level renders instantly without it.
    const dustAbort = new AbortController()
    if (wantsDust) {
      const params = data.level === 'atlas'
        ? 'level=dust'
        : `level=dust&facet=${encodeURIComponent(data.facet ?? 'tags')}&key=${encodeURIComponent(data.key ?? '')}${data.topic ? `&topic=${encodeURIComponent(data.topic.slug)}` : ''}`
      fetch(`/api/explore?${params}`, { signal: dustAbort.signal })
        .then((res) => res.json())
        .then((payload: DustPayload) => {
          if (sigmaRef.current !== sigma || !payload?.topics) return
          const sparks: DustSpark[] = data.level === 'atlas'
            ? buildAtlasSparks(payload, dustHubs, dustHubIndexRef.current, referenceTime)
            : categoryRing ? buildCategorySparks(payload, categoryRing.rIn, categoryRing.rOut, referenceTime) : []
          if (!sparks.length) return
          const hubAnchors: Array<{ x: number; y: number }> = []
          for (const [id, slot] of dustHubIndexRef.current) {
            const node = placedByIdRef.current.get(id)
            if (node) hubAnchors[slot] = { x: node.x, y: node.y }
          }
          for (const spark of sparks) {
            const anchor = hubAnchors[spark.hub]
            graph.addNode(spark.id, {
              x: anchor?.x ?? 0,
              y: anchor?.y ?? 0,
              size: spark.size,
              color: spark.color,
              label: null,
              type: 'dust',
              zIndex: 1,
              dustLx: spark.lx,
              dustLy: spark.ly,
              dustZ: spark.z,
              dustW: spark.w,
              dustHub: spark.hub,
              dustMaxR: spark.maxR,
            })
          }
          setDustCount(sparks.length)
          if (reduceMotion) {
            state.globalAlpha = 1
            sigma.refresh({ schedule: true })
            return
          }
          // Fade in first; the degradation probe waits for a clean window after it so
          // level-entry React/solver work never reads as GPU cost. Static after that —
          // no default-on motion. The ladder's floor stays today's flat view.
          const start = performance.now()
          const step = (nowTs: number) => {
            const t = Math.min(1, (nowTs - start) / 340)
            state.globalAlpha = t * t * (3 - 2 * t)
            sigma.scheduleRender()
            if (t < 1) {
              dustFadeRef.current = requestAnimationFrame(step)
              return
            }
            const deltas: number[] = []
            let last = performance.now()
            const probe = (ts: number) => {
              deltas.push(ts - last)
              last = ts
              sigma.scheduleRender()
              if (deltas.length < 14) {
                dustFadeRef.current = requestAnimationFrame(probe)
                return
              }
              dustFadeRef.current = null
              // Hidden-tab rAF suspensions read as huge deltas — they are not GPU cost
              const sorted = deltas.slice(2).filter((ms) => ms < 200).sort((a, b) => a - b)
              if (sorted.length < 6) return
              const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0
              if (p50 > 42) {
                for (const spark of sparks) graph.dropNode(spark.id)
                setDustCount(0)
              } else if (p50 > 24) {
                for (let i = 0; i < sparks.length; i += 2) graph.dropNode(sparks[i].id)
                setDustCount(Math.floor(sparks.length / 2))
              }
            }
            dustFadeRef.current = requestAnimationFrame(probe)
          }
          dustFadeRef.current = requestAnimationFrame(step)
        })
        .catch(() => { /* aborted or offline: atlas simply stays dust-free */ })
    }

    const scheduleOverlays = () => {
      window.clearTimeout(solveTimerRef.current)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setPills(computePills(sigma, graph, placedRef.current))
        setRegions(computeRegions(sigma, regionSeeds(data, placedRef.current)))
        const asFilaments = data.level === 'atlas' || data.level === 'topic'
        const scale = 1 / Math.sqrt(sigma.getCamera().ratio)
        const routes: EdgeRoute[] = data.edges.flatMap((edge, index) => {
          const source = placedByIdRef.current.get(edge.source), target = placedByIdRef.current.get(edge.target)
          if (!source || !target) return []
          const a = sigma.graphToViewport(source), b = sigma.graphToViewport(target)
          const dx = b.x - a.x, dy = b.y - a.y
          const dist = Math.hypot(dx, dy) || 1
          const side = ((index % 2) * 2 - 1)
          const swirl = stableUnit(`${edge.source}|${edge.target}`, 13) - 0.5
          // Group hubs: cross-constellation edges arc through cluster centers (cubic).
          const sourceGroup = source.child.groupId ? placedByIdRef.current.get(source.child.groupId) : null
          const targetGroup = target.child.groupId ? placedByIdRef.current.get(target.child.groupId) : null
          const crossGroup = Boolean(
            source.child.groupId && target.child.groupId && source.child.groupId !== target.child.groupId
            && sourceGroup && targetGroup,
          )
          let path: string
          if (data.level === 'search' || data.level === 'category') {
            if (crossGroup && sourceGroup && targetGroup) {
              const ga = sigma.graphToViewport(sourceGroup)
              const gb = sigma.graphToViewport(targetGroup)
              const c1x = a.x * 0.35 + ga.x * 0.55 + gb.x * 0.1 - dy * side * 0.08
              const c1y = a.y * 0.35 + ga.y * 0.55 + gb.y * 0.1 + dx * side * 0.08
              const c2x = b.x * 0.35 + gb.x * 0.55 + ga.x * 0.1 + dy * side * 0.08
              const c2y = b.y * 0.35 + gb.y * 0.55 + ga.y * 0.1 - dx * side * 0.08
              path = `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
            } else {
              // Stronger quadratic bows so dense item graphs read as woven curves, not a mesh.
              const bend = (0.16 + Math.abs(swirl) * 0.22) * side * Math.min(1, 90 / dist)
              const cx = (a.x + b.x) / 2 - dy * bend
              const cy = (a.y + b.y) / 2 + dx * bend
              path = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
            }
          } else {
            const bend = asFilaments
              ? (((index % 5) - 2) * 0.05 + (dx * dy > 0 ? 0.055 : -0.055))
              : ((index % 7) - 3) * 0.018
            const cx = (a.x + b.x) / 2 - dy * bend
            const cy = (a.y + b.y) / 2 + dx * bend
            path = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
          }
          const useFilament = asFilaments || data.level === 'search' || data.level === 'category'
          const filament = useFilament ? {
            colorA: source.child.color ?? data.topic?.color ?? '#94a3b8',
            colorB: target.child.color ?? data.topic?.color ?? '#94a3b8',
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          } : undefined
          if (data.level === 'atlas') {
            // Co-occurrence spindle: width carries shared-item volume, alpha stays capped
            const bend = (((index % 5) - 2) * 0.05 + (dx * dy > 0 ? 0.055 : -0.055))
            const cx = (a.x + b.x) / 2 - dy * bend
            const cy = (a.y + b.y) / 2 + dx * bend
            const wMid = (1.6 + edge.weight * 1.5) * scale
            const wEnd = 0.7 * scale
            return [{ id: `${edge.source}:${edge.target}`,
              path: taperedPath(a.x, a.y, cx, cy, b.x, b.y, (t) => wEnd + (wMid - wEnd) * Math.sin(Math.PI * t)),
              weight: edge.weight, correlated: false, fill: true,
              opacity: Math.min(0.15, 0.05 + 0.1 * (edge.weight / 3)), filament }]
          }
          const correlated = Boolean(edge.sharedTags?.length || edge.sharedDomain)
          return [{
            id: `${edge.source}:${edge.target}`,
            path,
            weight: edge.weight,
            correlated,
            filament: correlated || data.level === 'search' ? filament : undefined,
          }]
        })
        if (data.level === 'topic' && data.center) {
          const center = placedByIdRef.current.get(data.center.id)
          const c = center ? sigma.graphToViewport(center) : null
          if (center && c) {
            const centerR = center.r * 2.3 * scale
            let maxCount = 1
            for (const node of placedRef.current) if (!node.isCenter) maxCount = Math.max(maxCount, node.child.count ?? 0)
            for (const node of placedRef.current) {
              if (node.isCenter || !graph.hasNode(node.child.id)) continue
              const p = sigma.graphToViewport(node)
              const dx = p.x - c.x, dy = p.y - c.y
              const dist = Math.hypot(dx, dy) || 1
              const ux = dx / dist, uy = dy / dist
              const sx = c.x + ux * centerR * 0.72, sy = c.y + uy * centerR * 0.72
              const ex = p.x - ux * node.r * 2.3 * scale * 0.35, ey = p.y - uy * node.r * 2.3 * scale * 0.35
              const curl = (stableUnit(node.child.id, 23) - 0.5) * 0.14
              const mx = (sx + ex) / 2 - (ey - sy) * curl, my = (sy + ey) / 2 + (ex - sx) * curl
              // Membership bus: width at the hub = this orbital's real member count
              const wHub = clamp(2 + 9.5 * Math.sqrt((node.child.count ?? 1) / maxCount), 2.6, 11.5) * scale
              routes.push({ id: `bus:${node.child.id}`,
                path: taperedPath(sx, sy, mx, my, ex, ey, (t) => wHub + (1.1 * scale - wHub) * t),
                weight: 1, correlated: false, fill: true, opacity: 0.3,
                filament: { colorA: data.topic?.color ?? '#a78bfa', colorB: String(graph.getNodeAttribute(node.child.id, 'baseColor') ?? '#a78bfa'), x1: sx, y1: sy, x2: ex, y2: ey } })
            }
          }
        }
        setEdgeRoutes(routes)
      })
    }

    sigma.on('clickNode', ({ node, event }) => {
      event?.preventSigmaDefault?.()
      const child = childById.get(node)
      if (child) {
        onSelect(child)
        onActivate(child)
      }
    })
    sigma.on('clickStage', () => onSelect(null))
    sigma.on('enterNode', ({ node }) => {
      containerRef.current?.classList.add('is-pointing')
      setHoveredId(node)
    })
    sigma.on('leaveNode', () => {
      containerRef.current?.classList.remove('is-pointing')
      setHoveredId(null)
    })
    sigma.getCamera().on('updated', nudgeOverlays)
    sigma.on('resize', scheduleOverlays)
    schedulePillsRef.current = scheduleOverlays
    window.setTimeout(scheduleOverlays, 0)

    sigmaRef.current = sigma
    graphRef.current = graph

    return () => {
      dustAbort.abort()
      glCanvas?.removeEventListener('webglcontextlost', onContextLost)
      if (dustFadeRef.current !== null) cancelAnimationFrame(dustFadeRef.current)
      dustFadeRef.current = null
      if (growRef.current !== null) cancelAnimationFrame(growRef.current)
      growRef.current = null
      window.clearTimeout(commitTimerRef.current)
      window.clearTimeout(solveTimerRef.current)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      sigma.kill()
      sigmaRef.current = null
      graphRef.current = null
      pointsRef.current = []
      placedRef.current = []
      placedByIdRef.current = new Map()
      pillAnchorsRef.current = new Map()
      lastVisiblePillsRef.current = new Set()
      dustHubIndexRef.current = new Map()
      setPills([])
      setRegions([])
      setEdgeRoutes([])
      setDustCount(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, glEpoch])

  // Dimension/lens: pure reprojection of the cached raw-4D coords — no settle,
  // no Sigma construction, camera untouched, no per-tick solve. At atlas the tick is
  // 8 uniform floats: every vertex re-derives its position in-shader, so dust count
  // never touches the budget. CPU coords catch up once, after the gesture settles
  // (hover rings and camera fit read them; nothing else does between ticks).
  useEffect(() => {
    const graph = graphRef.current
    const sigma = sigmaRef.current
    if (!graph || !sigma || !pointsRef.current.length) return
    const state = renderStateRef.current
    writeProjRows(state, dimension, layoutMode)
    state.lensAlpha = layoutMode === 'territories' ? 0 : 1
    const projected = new Map<string, UnifiedPoint>()
    for (const point of reprojectPoints(pointsRef.current, dimension, layoutMode)) {
      projected.set(point.id, point)
      const node = placedByIdRef.current.get(point.id)
      if (node) { node.x = point.x; node.y = point.y }
    }
    const commit = () => {
      // One batched event: per-node setNodeAttribute pairs cost ~2n graphology events per tick
      graph.updateEachNodeAttributes((id, attrs) => {
        const point = projected.get(id)
        if (point) { attrs.x = point.x; attrs.y = point.y }
        return attrs
      }, { attributes: ['x', 'y'] })
    }
    if (data.level === 'atlas') {
      sigma.scheduleRender()
      window.clearTimeout(commitTimerRef.current)
      commitTimerRef.current = window.setTimeout(commit, 160)
    } else {
      commit()
      sigma.refresh()
    }
    nudgeOverlays()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension, layoutMode])

  // A solve commit repositions pills through left/top; stale nudge transforms must not survive it.
  useLayoutEffect(() => {
    for (const el of pillElsRef.current.values()) el.style.transform = ''
  }, [pills])

  const restyleNodes = () => {
    const graph = graphRef.current
    const sigma = sigmaRef.current
    if (!graph || !sigma) return
    // Selection/hover figure-ground for the nebulae: one uniform, zero per-spark writes
    const state = renderStateRef.current
    const selectedHub = selectedRef.current ? dustHubIndexRef.current.get(selectedRef.current) : undefined
    const hoveredHub = hoveredRef.current ? dustHubIndexRef.current.get(hoveredRef.current) : undefined
    state.focusHub = selectedHub ?? hoveredHub ?? -1
    state.queryDim = focusActiveRef.current ? 0.3 : 1
    graph.forEachNode((node, attrs) => {
      if (attrs.type === 'dust') return
      const active = node === selectedRef.current || node === hoveredRef.current
      const relevance = focusActiveRef.current ? Math.max(0, relevanceRef.current.get(node) ?? 0) : 0
      const dimmed = focusActiveRef.current && !active && relevance < 0.05
      const size = Number(attrs.baseSize) * (1 + relevance * 0.6)
      graph.setNodeAttribute(node, 'color', active ? '#f8fafc' : dimmed ? '#3f3f46' : String(attrs.baseColor))
      graph.setNodeAttribute(node, 'size', active ? size * 1.18 : size)
    })
    sigma.refresh()
  }

  // Selection / hover highlight without relayout
  useEffect(() => {
    restyleNodes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, hoveredId])

  // Focus relevance is a render channel: re-scored in place from cached vectors on
  // question change — never a relayout, never a reprojection.
  useEffect(() => {
    const query = focusQuery.trim()
    focusActiveRef.current = Boolean(query)
    if (!query) {
      relevanceRef.current = new Map()
    } else {
      if (!vectorsRef.current) vectorsRef.current = new Map([...childById].map(([id, child]) => [id, childVector(child)]))
      relevanceRef.current = focusScores(vectorsRef.current, query)
    }
    restyleNodes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childById, layoutMode, focusQuery])

  // Selection changes label priority; hover must not, or the pill re-solve
  // relocates the pill out from under the cursor and oscillates.
  useEffect(() => {
    schedulePillsRef.current?.()
  }, [selectedId])

  const computePills = (sigma: Sigma, graph: Graph, placed: PlacedNode[]): Pill[] => {
    const dimensions = sigma.getDimensions()
    const ratio = sigma.getCamera().ratio
    const focusSelected = selectedRef.current
    const candidates: Array<Pill & { priority: number; width: number }> = []
    const anchors = new Map<string, { x: number; y: number }>()

    for (let index = 0; index < placed.length; index++) {
      const node = placed[index]
      if (!graph.hasNode(node.child.id)) continue
      const viewport = sigma.graphToViewport({ x: node.x, y: node.y })
      if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y)) continue
      if (viewport.x < -80 || viewport.x > dimensions.width + 80 || viewport.y < -50 || viewport.y > dimensions.height + 50) continue
      const screenR = (node.r * 2.3) / Math.sqrt(ratio)
      const isCenter = Boolean(node.isCenter)
      const isGroup = Boolean(node.isGroup)
      const priority = (isCenter ? 1e9
        : node.child.id === focusSelected ? 8e8
          : isGroup ? 5e8 + (node.child.count ?? 0)
            : node.child.kind !== 'item' ? 1e6 + (node.child.count ?? 0)
              : 1000 - Math.min(999, index))
        + (lastVisiblePillsRef.current.has(node.child.id) ? HYSTERESIS_BONUS : 0)
      anchors.set(node.child.id, { x: viewport.x, y: viewport.y })
      candidates.push({
        id: node.child.id,
        label: node.child.label,
        count: node.child.kind === 'item' ? undefined : node.child.count,
        x: viewport.x,
        y: viewport.y + screenR + 6,
        color: String(graph.getNodeAttribute(node.child.id, 'baseColor')),
        kind: node.child.kind,
        isCenter,
        isGroup,
        priority,
        width: 0,
      })
    }

    const solved = solveLabels(candidates.map((candidate) => ({
      ...candidate,
      width: estimatePillWidth(candidate),
      height: 26,
      radius: 0,
      force: candidate.isCenter || data.level === 'atlas' || candidate.id === focusSelected,
    })), dimensions.width, dimensions.height)
    const visible = solved.filter((label) => !label.hidden).slice(0, 100)
    lastVisiblePillsRef.current = new Set(visible.map((label) => label.id))
    pillAnchorsRef.current = new Map(visible.flatMap((label) => {
      const anchor = anchors.get(label.id)
      return anchor ? [[label.id, anchor] as const] : []
    }))
    return visible.map((label) => ({
      id: label.id, label: label.label, count: label.count, x: label.x, y: label.y - 13,
      color: label.color ?? '#94a3b8', kind: label.kind ?? 'item',
      isCenter: Boolean(candidates.find((candidate) => candidate.id === label.id)?.isCenter),
      isGroup: Boolean(candidates.find((candidate) => candidate.id === label.id)?.isGroup),
    }))
  }

  const zoom = (factor: number) => {
    const camera = sigmaRef.current?.getCamera()
    camera?.animate({ ratio: clamp(camera.ratio * factor, 0.04, 2.2) }, { duration: 260 })
  }
  const fit = () => sigmaRef.current?.getCamera().animatedReset({ duration: 320 })

  // Unified lens: cartographic depth — radial falloff fill per territory plus a thin
  // coastline. Territories lens keeps the flat calm fills exactly as before.
  const territoryPaths = useMemo(() => {
    if (layoutMode === 'territories') return regions.map((region) => (
      <path key={region.id} d={region.path} fill={region.color} />
    ))
    return (
      <>
        <defs>
          {regions.map((region) => (
            <radialGradient key={region.id} id={`tg-${region.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} cx="50%" cy="50%" r="68%">
              <stop offset="0%" stopColor={region.color} stopOpacity="0.14" />
              <stop offset="55%" stopColor={region.color} stopOpacity="0.055" />
              <stop offset="100%" stopColor={region.color} stopOpacity="0.02" />
            </radialGradient>
          ))}
        </defs>
        {regions.map((region) => (
          <path key={region.id} d={region.path} fill={`url(#tg-${region.id.replace(/[^a-zA-Z0-9_-]/g, '-')})`}
            stroke={region.color} strokeOpacity="0.16" strokeWidth="1.5" />
        ))}
      </>
    )
  }, [regions, layoutMode])
  const edgePaths = useMemo(() => {
    // Calm-mode contract: territories keeps only the pre-existing plain/gold routes
    const routes = layoutMode === 'territories' ? edgeRoutes.filter((edge) => !edge.fill && !edge.filament) : edgeRoutes
    const filaments = routes.filter((edge) => edge.filament)
    return (
      <>
        {filaments.length ? <defs>
          {filaments.map((edge) => (
            <linearGradient key={edge.id} id={`fg-${edge.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} gradientUnits="userSpaceOnUse"
              x1={edge.filament!.x1} y1={edge.filament!.y1} x2={edge.filament!.x2} y2={edge.filament!.y2}>
              <stop offset="0%" stopColor={edge.filament!.colorA} stopOpacity={edge.fill ? 1 : undefined} />
              {/* Membership buses fade toward the leaf; co-occurrence spindles stay symmetric */}
              <stop offset="100%" stopColor={edge.filament!.colorB} stopOpacity={edge.fill ? (edge.id.startsWith('bus:') ? 0.3 : 1) : undefined} />
            </linearGradient>
          ))}
        </defs> : null}
        {routes.map((edge) => edge.fill ? (
          <path key={edge.id} d={edge.path} className="ribbon"
            style={{ fill: `url(#fg-${edge.id.replace(/[^a-zA-Z0-9_-]/g, '-')})`, stroke: 'none', opacity: edge.opacity }} />
        ) : edge.filament ? (
          <path key={edge.id} d={edge.path} className={`filament ${edge.correlated ? 'correlated' : ''}`}
            style={{
              stroke: `url(#fg-${edge.id.replace(/[^a-zA-Z0-9_-]/g, '-')})`,
              strokeOpacity: edge.correlated
                ? Math.max(0.22, Math.min(0.55, Math.sqrt(48 / Math.max(1, routes.length))))
                : Math.min(0.16, 0.04 + 0.1 * (edge.weight / 3)),
              strokeWidth: Math.max(0.7, Math.min(2.2, 0.65 + edge.weight * 0.45)),
            }} />
        ) : (
          <path key={edge.id} d={edge.path} className={edge.correlated ? 'correlated' : ''}
            style={{
              strokeWidth: Math.max(.6, Math.min(2.4, edge.weight * .5)),
              strokeOpacity: edge.correlated ? Math.max(0.28, Math.min(0.72, Math.sqrt(40 / Math.max(1, routes.length)))) : undefined,
            }} />
        ))}
      </>
    )
  }, [edgeRoutes, layoutMode])

  const levelKey = `${data.level}:${data.topic?.slug ?? ''}:${data.facet ?? ''}:${data.key ?? ''}:${data.query ?? ''}`
  return (
    <div className="graph-frame">
      <svg key={`t:${levelKey}`} className={`topic-territories ${layoutMode === 'territories' ? 'territories-strong' : 'nebula-fills'}`} aria-hidden="true">
        {showTerritories && territoryPaths}
      </svg>
      <svg key={`e:${levelKey}`} className="edge-routes" aria-hidden="true">
        {edgePaths}
      </svg>
      <div ref={containerRef} className="graph-canvas" />
      {showTerritories ? <div className="region-tags" aria-hidden="true">
        {regions.filter((region) => region.showLabel).map((region) => (
          <span key={region.id} style={{ left: `${region.x}px`, top: `${region.y}px`, borderColor: region.color }}>{region.label}</span>
        ))}
      </div> : null}
      <div className="explore-pills" aria-label="Graph labels">
        {pills.map((pill) => (
          <button
            key={pill.id}
            ref={(el) => {
              if (el) pillElsRef.current.set(pill.id, el)
              else pillElsRef.current.delete(pill.id)
            }}
            className={`pill pill-${pill.kind} ${pill.isCenter ? 'pill-center' : ''} ${pill.id === selectedId || pill.id === hoveredId ? 'active' : ''}`}
            style={{ left: `${pill.x}px`, top: `${pill.y}px`, borderColor: pill.color }}
            onClick={(event) => {
              event.stopPropagation()
              const child = childById.get(pill.id)
              if (child) {
                onSelect(child)
                onActivate(child)
              }
            }}
            onMouseEnter={() => setHoveredId(pill.id)}
            onMouseLeave={() => setHoveredId(null)}
            title={pill.label}
          >
            <i style={{ background: pill.color }} />
            <span>{pill.label}</span>
            {pill.count !== undefined ? <b>{pill.count.toLocaleString()}</b> : null}
          </button>
        ))}
      </div>
      <div className="zoom-controls">
        <button onClick={() => zoom(0.6)} title="Zoom in" aria-label="Zoom in"><Plus size={15} /></button>
        <button onClick={() => zoom(1 / 0.6)} title="Zoom out" aria-label="Zoom out"><Minus size={15} /></button>
        <button onClick={fit} title="Fit view" aria-label="Fit view"><Scan size={15} /></button>
      </div>
      <div className="dimension-legend" aria-label="Visible graph dimensions"><span><i className="lexical" />lexical</span><span><i className="time" />time/depth</span><span><i className="source" />source/focus</span></div>
      {dustCount > 0 && layoutMode !== 'territories' ? (
        <div className="dust-legend" aria-label="Dust legend">each spark = one saved item (sampled) · brighter = newer · spiral order = content hash, not meaning</div>
      ) : null}
    </div>
  )
}
