import { embedText, parseEmbedding } from '../../lib/semantic'

export type UnifiedLevel = 'atlas' | 'topic' | 'category' | 'search' | 'graph'
export type ViewLens = 'unified' | 'territories' | 'depth' | 'time'

export interface UnifiedNodeInput {
  id: string
  label: string
  kind: string
  itemType?: string
  count?: number
  groupId?: string
  createdAt?: string | null
  /** Aggregate recency (epoch ms, e.g. median member created_at) for nodes with no createdAt of their own. */
  recencyMs?: number
  /** Member source mix for aggregate nodes; feeds a continuous w instead of the single-itemType steps. */
  sourceCounts?: Record<string, number>
  color?: string
  meta?: Record<string, unknown>
  fixed?: boolean
}

export interface UnifiedEdgeInput {
  source: string
  target: string
  weight?: number
}

export interface Point4D { x: number; y: number; z: number; w: number }

export interface UnifiedPoint extends Point4D {
  id: string
  label: string
  kind: string
  itemType?: string
  groupKey: string
  color?: string
  r: number
  priority: number
  fixed: boolean
  /** Settled raw-plane coords; x/y = project4D({rawX, rawY, z, w}) at the layout's dimension/lens. */
  rawX: number
  rawY: number
  /** Focus-query similarity in [-1, 1] — a render channel, never a coordinate. */
  relevance: number
  /** Hard pass exhausted its attempt budget; grouping outranks geometric purity. */
  overlapped?: boolean
}

export interface UnifiedGroup {
  id: string
  label: string
  color: string
  count: number
  weight: number
  x: number
  y: number
  memberIds: string[]
}

export interface UnifiedLayoutResult {
  points: UnifiedPoint[]
  groups: UnifiedGroup[]
  dimension: number
  level: UnifiedLevel
  /** Overlapping pairs (pad 0.9) before the hard pass, over total pairs — the hard pass must be cleanup, not the algorithm. */
  preHardPassOverlapRatio: number
}

export interface LayoutOptions {
  level: UnifiedLevel
  lens?: ViewLens
  dimension?: number
  focusQuery?: string
  previous?: Record<string, Point4D>
  groupAnchors?: Record<string, { x: number; y: number }>
}

export interface LabelCandidate {
  id: string
  label: string
  x: number
  y: number
  radius: number
  width: number
  height: number
  priority: number
  force?: boolean
  color?: string
  kind?: string
  count?: number
}

export interface PlacedLabel extends LabelCandidate {
  left: number
  top: number
  hidden?: boolean
}

export interface PowerSeed {
  id: string
  x: number
  y: number
  weight: number
  label: string
  color: string
  count: number
}

export interface PowerCell extends PowerSeed {
  polygon: Array<[number, number]>
  path: string
  centroid: { x: number; y: number }
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

export function stableUnit(seed: string, salt = 0): number {
  let hash = (2166136261 + salt) >>> 0
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967295
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function nodeVector(node: UnifiedNodeInput): number[] {
  const stored = parseEmbedding(node.meta?.embedding)
  if (stored.length >= 8) return stored
  const topics = Array.isArray(node.meta?.topics) ? node.meta?.topics.join(' ') : ''
  const tags = Array.isArray(node.meta?.tags) ? node.meta?.tags.join(' ') : ''
  return embedText(`${node.label} ${topics} ${tags}`)
}

export function timeCoordinate(value: string | number | null | undefined, referenceTime: number): number {
  if (!value) return 0
  const time = typeof value === 'number' ? value : new Date(value).getTime()
  if (!Number.isFinite(time)) return 0
  const year = 365.25 * 24 * 60 * 60 * 1000
  return clamp((time - referenceTime) / (year * 3), -1, 1)
}

const SOURCE_AXIS: Record<string, number> = { favorite: -1, web: -1, x: 0, youtube: 1 }

export function sourceCoordinate(itemType?: string, mix?: Record<string, number>): number {
  if (mix) {
    let total = 0
    let weighted = 0
    for (const key in mix) {
      const count = mix[key]
      if (!Number.isFinite(count) || count <= 0) continue
      total += count
      weighted += (SOURCE_AXIS[key] ?? 0) * count
    }
    if (total > 0) return clamp(weighted / total, -1, 1)
  }
  return SOURCE_AXIS[itemType ?? ''] ?? 0
}

/** Rotate the XW and YZ planes before projecting the 4D point to the stage. */
export function project4D(point: Point4D, dimension: number, lens: ViewLens = 'unified'): { x: number; y: number } {
  const amount = clamp(dimension, 0, 1)
  const theta = amount * Math.PI * 0.36
  const phi = amount * Math.PI * 0.22
  const xw = point.x * Math.cos(theta) - point.w * Math.sin(theta)
  const ww = point.x * Math.sin(theta) + point.w * Math.cos(theta)
  const yz = point.y * Math.cos(phi) - point.z * Math.sin(phi)
  const zz = point.y * Math.sin(phi) + point.z * Math.cos(phi)
  if (lens === 'depth') return { x: xw + zz * 0.36, y: yz - ww * 0.18 }
  if (lens === 'time') return { x: xw + point.z * 0.85, y: yz + point.w * 0.2 }
  if (lens === 'territories') return { x: xw, y: yz }
  return { x: xw + ww * 0.18, y: yz - zz * 0.12 }
}

function groupKey(node: UnifiedNodeInput, level: UnifiedLevel): string {
  if (level === 'atlas') return node.id
  if (node.fixed) return `center:${node.id}`
  if (level === 'topic' && node.kind !== 'item') return node.id
  return node.groupId ?? node.itemType ?? node.kind
}

function nodeRadius(node: UnifiedNodeInput, maxCount: number, level: UnifiedLevel): number {
  if (node.fixed) return level === 'topic' ? 6.8 : 5.5
  if (node.kind === 'item') return level === 'graph' ? 1.45 : 1.7
  const count = Number.isFinite(node.count) ? Math.max(0, node.count as number) : 1
  const normalized = Math.sqrt(count / Math.max(1, maxCount))
  return level === 'atlas' ? 4.8 + normalized * 7.2 : 2.5 + normalized * 4.7
}

interface GroupSpec {
  key: string
  fixed: boolean
  x: number
  y: number
  anchorX: number
  anchorY: number
  /** Members relax inside this radius. */
  clampR: number
  /** Area budget 1.9·sqrt(Σ r_i²); the hard pass may use up to 1.1× of it. */
  budgetR: number
  /** Center-to-center separation radius for group repulsion. */
  sepR: number
}

interface PlaceGroupsOptions {
  focus: number[]
  referenceTime: number
  groupAnchors?: Record<string, { x: number; y: number }>
  previous?: Record<string, Point4D>
}

/** Long-range stage: pairwise disk separation over the ~9-40 group centers. */
function separateGroups(specs: GroupSpec[]): void {
  for (let iteration = 0; iteration < 160; iteration++) {
    let worstOverlap = 0
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        const a = specs[i]
        const b = specs[j]
        if (a.fixed && b.fixed) continue
        let dx = b.x - a.x
        let dy = b.y - a.y
        let dist = Math.hypot(dx, dy)
        const minDist = a.sepR + b.sepR
        if (dist >= minDist) continue
        if (dist < 1e-6) {
          const angle = stableUnit(`${a.key}|${b.key}`, 17) * Math.PI * 2
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          dist = 1
        }
        const push = (minDist - dist) / dist * 0.55
        const aShare = a.fixed ? 0 : b.fixed ? 1 : 0.5
        a.x -= dx * push * aShare
        a.y -= dy * push * aShare
        b.x += dx * push * (1 - aShare)
        b.y += dy * push * (1 - aShare)
        worstOverlap = Math.max(worstOverlap, minDist - dist)
      }
    }
    const anchorPull = iteration < 60 ? 0.04 : 0.008
    for (const spec of specs) {
      if (spec.fixed) continue
      spec.x += (spec.anchorX - spec.x) * anchorPull
      spec.y += (spec.anchorY - spec.y) * anchorPull
    }
    if (worstOverlap < 0.05) break
  }
}

function placeGroups(nodes: UnifiedNodeInput[], level: UnifiedLevel, opts: PlaceGroupsOptions): { points: UnifiedPoint[]; groups: UnifiedGroup[]; specs: GroupSpec[]; slots: number[] } {
  const counts = nodes.map((node) => Number.isFinite(node.count) ? node.count as number : 1)
  const maxCount = Math.max(1, ...counts)
  const buckets = new Map<string, UnifiedNodeInput[]>()
  for (const node of nodes) {
    const key = groupKey(node, level)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(node)
    else buckets.set(key, [node])
  }
  const entries = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  // Keep atlas/topic/graph semantics; search + category need more air so constellations read as islands.
  const spaceBoost = level === 'search' ? 1.42 : level === 'category' ? 1.22 : 1
  const sepPad = level === 'atlas' ? 6 : level === 'search' ? 9.5 : level === 'category' ? 5.5 : level === 'graph' ? 3.2 : 2.5
  const ringBoost = level === 'search' ? 1.48 : level === 'category' ? 1.18 : level === 'graph' ? 1.08 : 1
  const specs: GroupSpec[] = []
  for (const [key, members] of entries) {
    members.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.id.localeCompare(b.id))
    let sumR2 = 0
    let maxR = 0
    for (const node of members) {
      const r = nodeRadius(node, maxCount, level)
      sumR2 += r * r
      maxR = Math.max(maxR, r)
    }
    const budgetR = 1.9 * Math.sqrt(sumR2) * spaceBoost
    const clampR = Math.min(Math.max(1.7 * Math.sqrt(sumR2) * spaceBoost, maxR + 1.2 * spaceBoost), budgetR * 1.12)
    specs.push({
      key,
      fixed: members.some((node) => node.fixed),
      x: 0, y: 0, anchorX: 0, anchorY: 0,
      clampR,
      budgetR,
      sepR: clampR + sepPad,
    })
  }

  const ringR = Math.max(10, Math.sqrt(specs.reduce((sum, spec) => sum + spec.sepR * spec.sepR, 0))) * ringBoost
  const movableCount = specs.filter((spec) => !spec.fixed).length
  entries.forEach(([key, members], index) => {
    const spec = specs[index]
    if (spec.fixed) return
    const given = opts.groupAnchors?.[key]
    if (given && Number.isFinite(given.x) && Number.isFinite(given.y)) {
      spec.anchorX = given.x
      spec.anchorY = given.y
    } else {
      let prevX = 0
      let prevY = 0
      let prevCount = 0
      if (opts.previous) {
        for (const node of members) {
          const old = opts.previous[node.id]
          if (old && Number.isFinite(old.x) && Number.isFinite(old.y)) {
            prevX += old.x
            prevY += old.y
            prevCount++
          }
        }
      }
      if (prevCount) {
        // Preserve remembered bearings but ease groups slightly outward for search constellations.
        const scale = level === 'search' ? 1.12 : level === 'category' ? 1.06 : 1
        spec.anchorX = (prevX / prevCount) * scale
        spec.anchorY = (prevY / prevCount) * scale
      } else if (movableCount > 1) {
        // Spread anchors on a slightly irregular ring so clusters don't form a perfect wheel.
        const angle = (index / movableCount) * Math.PI * 2 + stableUnit(key) * 0.35
        const radius = ringR * (0.82 + 0.34 * stableUnit(key, 7))
        spec.anchorX = Math.cos(angle) * radius
        spec.anchorY = Math.sin(angle) * radius
      }
    }
    spec.x = spec.anchorX
    spec.y = spec.anchorY
  })
  separateGroups(specs)

  const points: UnifiedPoint[] = []
  const groups: UnifiedGroup[] = []
  const slots: number[] = []
  entries.forEach(([key, members], index) => {
    const spec = specs[index]
    const weight = members.reduce((sum, node) => sum + (Number.isFinite(node.count) ? node.count as number : 1), 0)
    const groupColor = members.find((node) => node.color)?.color ?? '#64748b'
    groups.push({ id: key, label: key.replace(/^(center:|group:|region:)/, ''), color: groupColor, count: members.length, weight, x: spec.x, y: spec.y, memberIds: members.map((node) => node.id) })
    const spin = stableUnit(key, 3) * Math.PI * 2
    const groupHasPrevious = Boolean(opts.previous) && members.some((node) => {
      const old = opts.previous?.[node.id]
      return Boolean(old) && Number.isFinite(old!.x) && Number.isFinite(old!.y)
    })
    members.forEach((node, memberIndex) => {
      const r = nodeRadius(node, maxCount, level)
      const zc = node.fixed ? 0 : timeCoordinate(node.createdAt ?? node.recencyMs, opts.referenceTime) * 11
      const wc = node.fixed ? 0 : sourceCoordinate(node.itemType, node.sourceCounts) * 11
      // Collision-free home slot; z/w never displace geometry — they only enter the projection.
      const fraction = members.length === 1 ? 0 : Math.sqrt((memberIndex + 0.5) / members.length)
      const slotRadius = fraction * Math.max(0, spec.clampR - r - 0.3)
      const slotAngle = memberIndex * GOLDEN_ANGLE + spin
      const slotX = node.fixed ? 0 : spec.x + Math.cos(slotAngle) * slotRadius
      const slotY = node.fixed ? 0 : spec.y + Math.sin(slotAngle) * slotRadius
      let x = slotX
      let y = slotY
      if (!node.fixed) {
        const prev = opts.previous?.[node.id]
        if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) {
          x = prev.x
          y = prev.y
        } else if (groupHasPrevious) {
          // New node joining a remembered group: enter at the rim so the settled interior stays put.
          const angle = stableUnit(node.id, 11) * Math.PI * 2
          const radius = spec.clampR * (0.78 + 0.2 * stableUnit(node.id, 19))
          x = spec.x + Math.cos(angle) * radius
          y = spec.y + Math.sin(angle) * radius
        }
        const dx = x - spec.x
        const dy = y - spec.y
        const dist = Math.hypot(dx, dy)
        if (dist > spec.clampR) {
          x = spec.x + dx / dist * spec.clampR
          y = spec.y + dy / dist * spec.clampR
        }
      }
      slots.push(x, y)
      let relevance = 0
      if (opts.focus.length) {
        const vector = nodeVector(node)
        const dot = vector.reduce((sum, value, i) => sum + value * (opts.focus[i] ?? 0), 0)
        relevance = Number.isFinite(dot) ? clamp(dot, -1, 1) : 0
      }
      points.push({
        id: node.id,
        label: node.label,
        kind: node.kind,
        itemType: node.itemType,
        groupKey: key,
        color: node.color,
        x, y,
        z: zc,
        w: wc,
        rawX: x,
        rawY: y,
        relevance,
        r,
        priority: node.fixed ? 1e9 : node.kind === 'item' ? 1000 - memberIndex : 1e6 + (node.count ?? 0),
        fixed: Boolean(node.fixed),
      })
    })
  })
  return { points, groups, specs, slots }
}

class SpatialHash<T extends { x: number; y: number }> {
  private cells = new Map<string, T[]>()
  private scratch: T[] = []
  constructor(private size: number) {}
  private key(x: number, y: number) { return `${Math.floor(x / this.size)}:${Math.floor(y / this.size)}` }
  clear() { this.cells.clear() }
  add(item: T) {
    const key = this.key(item.x, item.y)
    const cell = this.cells.get(key)
    if (cell) cell.push(item)
    else this.cells.set(key, [item])
  }
  /** Returns a reused buffer — consume before the next near() call. */
  near(x: number, y: number): T[] {
    const cx = Math.floor(x / this.size)
    const cy = Math.floor(y / this.size)
    const result = this.scratch
    result.length = 0
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cell = this.cells.get(`${cx + dx}:${cy + dy}`)
      if (cell) for (let i = 0; i < cell.length; i++) result.push(cell[i])
    }
    return result
  }
}

const HARD_PAD = 0.9

function settle(points: UnifiedPoint[], edges: UnifiedEdgeInput[], specs: GroupSpec[], slots: number[], previous?: Record<string, Point4D>): number {
  const byId = new Map(points.map((point) => [point.id, point]))
  const specByKey = new Map(specs.map((spec) => [spec.key, spec]))
  let maxR = 1
  for (const point of points) maxR = Math.max(maxR, point.r)
  const hash = new SpatialHash<UnifiedPoint>(Math.max(8, maxR * 2 + 2.5))
  const iterations = 44
  for (let iteration = 0; iteration < iterations; iteration++) {
    const cooling = 1 - iteration / (iterations + 8)
    hash.clear()
    for (const point of points) hash.add(point)
    // Sequential pairwise projection: each overlap is resolved in place, so packing
    // tightens instead of inflating the disk into the clamp like additive forces do.
    for (const point of points) {
      const neighbors = hash.near(point.x, point.y)
      for (let i = 0; i < neighbors.length; i++) {
        const other = neighbors[i]
        if (other.id <= point.id) continue
        if (point.fixed && other.fixed) continue
        let dx = other.x - point.x
        let dy = other.y - point.y
        let dist = Math.sqrt(dx * dx + dy * dy)
        // Extra breathing room between items keeps labels and curved edges readable.
        const sameGroup = point.groupKey === other.groupKey
        const min = point.r + other.r + (sameGroup ? 1.35 : 1.55)
        if (dist >= min) continue
        if (dist < 1e-4) {
          const angle = stableUnit(point.id, 71) * Math.PI * 2
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          dist = 1
        }
        const push = (min - dist) / dist * 0.72
        const share = point.fixed ? 0 : other.fixed ? 1 : 0.5
        point.x -= dx * push * share
        point.y -= dy * push * share
        other.x += dx * push * (1 - share)
        other.y += dy * push * (1 - share)
      }
    }
    for (let index = 0; index < points.length; index++) {
      const point = points[index]
      if (point.fixed) continue
      const prev = previous?.[point.id]
      if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) {
        point.x += (prev.x - point.x) * 0.4 * cooling
        point.y += (prev.y - point.y) * 0.4 * cooling
      } else {
        point.x += (slots[index * 2] - point.x) * 0.08 * cooling
        point.y += (slots[index * 2 + 1] - point.y) * 0.08 * cooling
      }
    }
    for (const edge of edges) {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      if (!source || !target) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const sameGroup = source.groupKey === target.groupKey
      // Slightly longer preferred length → looser clusters, softer hairballs.
      const desired = source.r + target.r + (sameGroup ? 6.2 : 11)
      const weight = Number.isFinite(edge.weight) ? clamp(edge.weight as number, 0.2, 4) : 1
      // Cross-group edges are a whisper: pulling harder than this piles nodes onto the disk rim,
      // and the displacement cap must stay well under the slot spring or it wins by attrition.
      const affinity = sameGroup ? 1 : 0.045
      let pull = (dist - desired) * 0.00135 * weight * affinity * cooling
      const maxPull = 0.11 / dist
      if (pull > maxPull) pull = maxPull
      else if (pull < -maxPull) pull = -maxPull
      if (!source.fixed) { source.x += dx * pull; source.y += dy * pull }
      if (!target.fixed) { target.x -= dx * pull; target.y -= dy * pull }
    }
    for (const point of points) {
      if (point.fixed) continue
      const spec = specByKey.get(point.groupKey)
      if (!spec) continue
      const prev = previous?.[point.id]
      const limit = prev ? spec.clampR * 1.08 : spec.clampR
      const dx = point.x - spec.x
      const dy = point.y - spec.y
      const dist = Math.hypot(dx, dy)
      if (dist > limit) {
        point.x = spec.x + dx / dist * limit
        point.y = spec.y + dy / dist * limit
      }
    }
  }
  for (const point of points) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) continue
    const spec = specByKey.get(point.groupKey)
    const angle = stableUnit(point.id, 53) * Math.PI * 2
    const radius = (spec?.clampR ?? 6) * stableUnit(point.id, 59)
    point.x = (spec?.x ?? 0) + Math.cos(angle) * radius
    point.y = (spec?.y ?? 0) + Math.sin(angle) * radius
  }

  hash.clear()
  for (const point of points) hash.add(point)
  let overlapPairs = 0
  for (const point of points) {
    const neighbors = hash.near(point.x, point.y)
    for (let i = 0; i < neighbors.length; i++) {
      const other = neighbors[i]
      if (other.id <= point.id) continue
      const dx = point.x - other.x
      const dy = point.y - other.y
      const min = point.r + other.r + HARD_PAD
      if (dx * dx + dy * dy < min * min - 1e-6) overlapPairs++
    }
  }
  const totalPairs = points.length * (points.length - 1) / 2

  // Bounded cleanup only: on exhaustion the point keeps its in-disk position and
  // is flagged overlapped — grouping outranks geometric purity.
  const ordered = [...points].sort((a, b) => Number(b.fixed) - Number(a.fixed) || b.priority - a.priority || a.id.localeCompare(b.id))
  hash.clear()
  for (const point of ordered) {
    if (!point.fixed) {
      const spec = specByKey.get(point.groupKey)
      const anchorX = point.x
      const anchorY = point.y
      const escape = Math.max(3 * point.r, 6)
      let placed = false
      for (let attempt = 0; attempt < 64; attempt++) {
        if (attempt) {
          const radius = escape * Math.sqrt(attempt / 63)
          const angle = attempt * GOLDEN_ANGLE + stableUnit(point.id, 101) * Math.PI * 2
          point.x = anchorX + Math.cos(angle) * radius
          point.y = anchorY + Math.sin(angle) * radius
          if (spec) {
            const dx = point.x - spec.x
            const dy = point.y - spec.y
            const dist = Math.hypot(dx, dy)
            const limit = spec.budgetR * 1.1
            if (dist > limit) {
              point.x = spec.x + dx / dist * limit
              point.y = spec.y + dy / dist * limit
            }
          }
        }
        const neighbors = hash.near(point.x, point.y)
        let overlaps = false
        for (let i = 0; i < neighbors.length && !overlaps; i++) {
          const other = neighbors[i]
          const dx = point.x - other.x
          const dy = point.y - other.y
          const min = point.r + other.r + HARD_PAD
          if (dx * dx + dy * dy < min * min - 1e-7) overlaps = true
        }
        if (!overlaps) {
          placed = true
          break
        }
      }
      if (!placed) {
        point.x = anchorX
        point.y = anchorY
        point.overlapped = true
      }
    }
    hash.add(point)
  }
  return totalPairs ? overlapPairs / totalPairs : 0
}

/** Invert the (linear in x,y) projection so cached raw coords reproduce the settled view. */
function solveRawPlane(points: UnifiedPoint[], dimension: number, lens: ViewLens): void {
  const px = project4D({ x: 1, y: 0, z: 0, w: 0 }, dimension, lens)
  const py = project4D({ x: 0, y: 1, z: 0, w: 0 }, dimension, lens)
  const det = px.x * py.y - py.x * px.y
  if (Math.abs(det) < 1e-9) {
    for (const point of points) {
      point.rawX = point.x
      point.rawY = point.y
    }
    return
  }
  for (const point of points) {
    const base = project4D({ x: 0, y: 0, z: point.z, w: point.w }, dimension, lens)
    const bx = point.x - base.x
    const by = point.y - base.y
    point.rawX = (bx * py.y - py.x * by) / det
    point.rawY = (px.x * by - bx * px.y) / det
  }
}

/** Pure O(n) re-projection of cached raw 4D coords — the dimension/lens hot path. No settle. */
export function reprojectPoints(points: UnifiedPoint[], dimension: number, lens: ViewLens): UnifiedPoint[] {
  return points.map((point) => {
    const projected = project4D({ x: point.rawX, y: point.rawY, z: point.z, w: point.w }, dimension, lens)
    return { ...point, x: projected.x, y: projected.y }
  })
}

export function unifiedLayout(nodes: UnifiedNodeInput[], edges: UnifiedEdgeInput[], options: LayoutOptions): UnifiedLayoutResult {
  const dimension = clamp(options.dimension ?? 0.62, 0, 1)
  const lens = options.lens ?? 'unified'
  const focus = options.focusQuery ? embedText(options.focusQuery) : []
  const dated = nodes.map((node) => node.createdAt ? new Date(node.createdAt).getTime() : node.recencyMs ?? NaN).filter(Number.isFinite)
  const referenceTime = dated.length ? Math.max(...dated) : Date.UTC(2026, 0, 1)
  const { points, groups, specs, slots } = placeGroups(nodes, options.level, {
    focus, referenceTime,
    groupAnchors: options.groupAnchors,
    previous: options.previous,
  })
  const preHardPassOverlapRatio = settle(points, edges, specs, slots, options.previous)
  solveRawPlane(points, dimension, lens)
  return { points, groups, dimension, level: options.level, preHardPassOverlapRatio }
}

function boxOverlaps(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }, pad = 2): boolean {
  return !(a.right + pad <= b.left || a.left >= b.right + pad || a.bottom + pad <= b.top || a.top >= b.bottom + pad)
}

/** Deterministic camera-space label placement; visible labels are disjoint, failures come back hidden. */
export function solveLabels(candidates: LabelCandidate[], width: number, height: number): PlacedLabel[] {
  const placed: PlacedLabel[] = []
  const failed: PlacedLabel[] = []
  const boxes: Array<{ left: number; top: number; right: number; bottom: number }> = []
  const ordered = [...candidates].sort((a, b) => Number(Boolean(b.force)) - Number(Boolean(a.force)) || b.priority - a.priority || a.id.localeCompare(b.id))
  const anchors = [
    [0, 1], [1, 0], [-1, 0], [0, -1], [0.75, 0.75], [-0.75, 0.75], [0.75, -0.75], [-0.75, -0.75],
  ]
  for (const candidate of ordered) {
    let best: PlacedLabel | null = null
    const rings = candidate.force ? 12 : 5
    for (let ring = 0; ring < rings && !best; ring++) {
      const distance = candidate.radius + 5 + ring * 9
      for (const [ax, ay] of anchors) {
        const cx = clamp(candidate.x + ax * (distance + candidate.width * (Math.abs(ax) > 0.8 ? 0.5 : 0)), candidate.width / 2 + 5, width - candidate.width / 2 - 5)
        const cy = clamp(candidate.y + ay * (distance + candidate.height * (Math.abs(ay) > 0.8 ? 0.5 : 0)), candidate.height / 2 + 5, height - candidate.height / 2 - 5)
        const box = { left: cx - candidate.width / 2, right: cx + candidate.width / 2, top: cy - candidate.height / 2, bottom: cy + candidate.height / 2 }
        if (boxes.some((other) => boxOverlaps(box, other, 3))) continue
        best = { ...candidate, x: cx, y: cy, left: box.left, top: box.top }
        boxes.push(box)
        break
      }
    }
    if (best) placed.push(best)
    else failed.push({ ...candidate, left: candidate.x - candidate.width / 2, top: candidate.y - candidate.height / 2, hidden: true })
  }
  return placed.concat(failed)
}

function clipPolygon(polygon: Array<[number, number]>, a: number, b: number, c: number): Array<[number, number]> {
  const output: Array<[number, number]> = []
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i]
    const previous = polygon[(i + polygon.length - 1) % polygon.length]
    const currentInside = a * current[0] + b * current[1] <= c + 1e-7
    const previousInside = a * previous[0] + b * previous[1] <= c + 1e-7
    if (currentInside !== previousInside) {
      const dx = current[0] - previous[0]
      const dy = current[1] - previous[1]
      const denominator = a * dx + b * dy
      if (Math.abs(denominator) > 1e-9) {
        const t = (c - a * previous[0] - b * previous[1]) / denominator
        output.push([previous[0] + dx * t, previous[1] + dy * t])
      }
    }
    if (currentInside) output.push(current)
  }
  return output
}

function polygonCentroid(points: Array<[number, number]>): { x: number; y: number } {
  if (points.length < 3) return { x: points[0]?.[0] ?? 0, y: points[0]?.[1] ?? 0 }
  let area = 0
  let x = 0
  let y = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    const cross = p[0] * q[1] - q[0] * p[1]
    area += cross
    x += (p[0] + q[0]) * cross
    y += (p[1] + q[1]) * cross
  }
  return Math.abs(area) < 1e-8 ? { x: points[0][0], y: points[0][1] } : { x: x / (3 * area), y: y / (3 * area) }
}

/** Exact convex Laguerre/power cells clipped to the stage rectangle. */
export function computePowerDiagram(seeds: PowerSeed[], width: number, height: number): PowerCell[] {
  if (!seeds.length) return []
  const maxWeight = Math.max(1, ...seeds.map((seed) => seed.weight))
  const scaled = seeds.map((seed) => ({ ...seed, power: Math.sqrt(seed.weight / maxWeight) * Math.min(width, height) * 0.2 }))
  return scaled.map((seed, index) => {
    let polygon: Array<[number, number]> = [[0, 0], [width, 0], [width, height], [0, height]]
    for (let j = 0; j < scaled.length && polygon.length; j++) {
      if (j === index) continue
      const other = scaled[j]
      const a = 2 * (other.x - seed.x)
      const b = 2 * (other.y - seed.y)
      const c = other.x * other.x + other.y * other.y - seed.x * seed.x - seed.y * seed.y + seed.power * seed.power - other.power * other.power
      polygon = clipPolygon(polygon, a, b, c)
    }
    const path = polygon.length ? `M${polygon.map((point) => `${point[0].toFixed(2)},${point[1].toFixed(2)}`).join('L')}Z` : ''
    return { ...seed, polygon, path, centroid: polygonCentroid(polygon) }
  })
}

export function countCircleOverlaps(points: Array<{ x: number; y: number; r: number }>, pad = 0): number {
  let overlaps = 0
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const dx = points[i].x - points[j].x
    const dy = points[i].y - points[j].y
    const min = points[i].r + points[j].r + pad
    if (dx * dx + dy * dy < min * min - 1e-6) overlaps++
  }
  return overlaps
}
