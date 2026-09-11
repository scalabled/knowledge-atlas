import { project4D, stableUnit, timeCoordinate, type UnifiedPoint, type ViewLens } from '../layout/unified-layout'
import type { ExploreRenderState } from './DustProgram'

/** Server dust payload: hash-ordered per-hub item samples, flat [ageDays, srcId, weightTier] triplets. */
export interface DustTopicPayload { id: string; n: number; d: number[] }
export interface DustPayload { level: 'dust'; totalItems: number; topics: DustTopicPayload[] }

export interface DustSpark {
  id: string
  lx: number
  ly: number
  z: number
  w: number
  hub: number
  maxR: number
  size: number
  color: string
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const DAY_MS = 86400000
/** Z axis span used by the layout (timeCoordinate * 11). */
const AXIS_SCALE = 11
const SRC_W = [0, -1, 1]
const TIER_SIZE = [1.9, 2.4, 3.0, 3.8]

/** Fill the projection rows so shaders reproduce project4D exactly: the map is linear
 * and zero-preserving, so its basis images are the full description. */
export function writeProjRows(state: ExploreRenderState, dimension: number, lens: ViewLens): void {
  const e1 = project4D({ x: 1, y: 0, z: 0, w: 0 }, dimension, lens)
  const e2 = project4D({ x: 0, y: 1, z: 0, w: 0 }, dimension, lens)
  const e3 = project4D({ x: 0, y: 0, z: 1, w: 0 }, dimension, lens)
  const e4 = project4D({ x: 0, y: 0, z: 0, w: 1 }, dimension, lens)
  state.projX[0] = e1.x; state.projX[1] = e2.x; state.projX[2] = e3.x; state.projX[3] = e4.x
  state.projY[0] = e1.y; state.projY[1] = e2.y; state.projY[2] = e3.y; state.projY[3] = e4.y
}

/** The disk a single-member atlas group may occupy (placeGroups' clampR for one node of radius r). */
export function atlasClampR(r: number): number {
  return Math.min(Math.max(1.7 * r, r + 1.2), 1.9 * r * 1.1)
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const n = parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6
  return [h, s, l]
}

// sigma's parseColor understands only hex/named/rgb(); hsl strings read as black
function hslCss(h: number, s: number, l: number, a: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const r = Math.round(channel(h + 1 / 3) * 255)
  const g = Math.round(channel(h) * 255)
  const b = Math.round(channel(h - 1 / 3) * 255)
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

/** Spark color law — every channel legend-true: hue = topic, lightness = item recency,
 * alpha = engagement tier + recency. Unsorted stays gray fog, never full brightness. */
function sparkColor(baseHex: string, ageDays: number, tier: number, muted: boolean): string {
  const fresh = Math.max(0, Math.min(1, 1 - ageDays / 1095))
  const [h, s0] = rgbToHsl(...hexToRgb(baseHex))
  if (muted) return hslCss(h, 0.07, 0.34 + 0.2 * fresh, Math.min(0.42, 0.22 + 0.04 * tier + 0.12 * fresh))
  const s = Math.min(0.96, s0 * 0.55 + 0.38 + 0.18 * fresh)
  const l = 0.5 + 0.28 * fresh
  const a = Math.min(0.92, 0.52 + 0.08 * tier + 0.26 * fresh)
  return hslCss(h, s, l, a)
}

export interface AtlasDustHub {
  point: UnifiedPoint
  color: string
  muted: boolean
}

/** Vogel-spiral nebula per topic, in hub-relative raw-4D coordinates. Order along the
 * spiral is the server's content-hash order — texture, never rank. The zw deltas are the
 * item's real time/source coordinates relative to its hub, scaled so any projection of
 * the 4D slider keeps every spark inside 0.94x the topic's own disk. */
export function buildAtlasSparks(payload: DustPayload, hubs: Map<string, AtlasDustHub>, hubIndex: Map<string, number>, referenceTime: number): DustSpark[] {
  const sparks: DustSpark[] = []
  const now = Date.now()
  for (const topic of payload.topics) {
    const hub = hubs.get(topic.id)
    const index = hubIndex.get(topic.id)
    if (!hub || index === undefined) continue
    const clampR = atlasClampR(hub.point.r)
    const maxR = 0.94 * clampR
    const spiralR = 0.86 * clampR
    const zwScale = (0.3 * clampR) / (AXIS_SCALE * 2)
    const spin = stableUnit(topic.id, 3) * Math.PI * 2
    const count = Math.floor(topic.d.length / 3)
    for (let i = 0; i < count; i++) {
      const age = topic.d[i * 3]
      const src = topic.d[i * 3 + 1]
      const tier = topic.d[i * 3 + 2]
      const u = stableUnit(`${topic.id}:${i}`, 7)
      // Annulus outside the orb core (nothing burns under the hub), densest at the
      // inner rim and thinning outward — nebula falloff instead of a uniform ring
      const rInner = 0.3 * clampR
      const radius = (rInner + Math.pow((i + 0.5) / count, 0.6) * (spiralR - rInner)) * (0.9 + 0.2 * u)
      const angle = i * GOLDEN_ANGLE + spin + (u - 0.5) * 0.3
      const zItem = timeCoordinate(now - age * DAY_MS, referenceTime) * AXIS_SCALE
      const wItem = (SRC_W[src] ?? 0) * AXIS_SCALE
      sparks.push({
        id: `dust:${topic.id}:${i}`,
        lx: Math.cos(angle) * radius,
        ly: Math.sin(angle) * radius,
        z: (zItem - hub.point.z) * zwScale,
        w: (wItem - hub.point.w) * zwScale,
        hub: index,
        maxR,
        size: (TIER_SIZE[tier] ?? TIER_SIZE[1]) * (0.85 + 0.4 * stableUnit(`${topic.id}:${i}`, 13)),
        color: sparkColor(hub.color, age, tier, hub.muted),
      })
    }
  }
  return sparks
}

const CATEGORY_SRC_COLOR = ['#38bdf8', '#34d399', '#f87171']

/** Overflow ring at category level: everything past the 150 shown items, rendered as an
 * outer annulus of faint source-colored sparks so the level stops hiding its true size. */
export function buildCategorySparks(payload: DustPayload, rIn: number, rOut: number, referenceTime: number): DustSpark[] {
  const bucket = payload.topics[0]
  if (!bucket) return []
  const sparks: DustSpark[] = []
  const now = Date.now()
  const count = Math.floor(bucket.d.length / 3)
  const zwScale = (0.25 * (rOut - rIn)) / (AXIS_SCALE * 2)
  for (let i = 0; i < count; i++) {
    const age = bucket.d[i * 3]
    const src = bucket.d[i * 3 + 1]
    const u = stableUnit(`overflow:${i}`, 5)
    const t = (i + 0.5) / count
    const radius = Math.sqrt(rIn * rIn + (rOut * rOut - rIn * rIn) * t) * (0.97 + 0.06 * u)
    const angle = i * GOLDEN_ANGLE + u * Math.PI * 2
    const zItem = timeCoordinate(now - age * DAY_MS, referenceTime) * AXIS_SCALE
    sparks.push({
      id: `dust:overflow:${i}`,
      lx: Math.cos(angle) * radius,
      ly: Math.sin(angle) * radius,
      z: zItem * zwScale,
      w: (SRC_W[src] ?? 0) * AXIS_SCALE * zwScale,
      hub: 0,
      maxR: rOut * 1.04,
      size: 2.3,
      color: sparkColor(CATEGORY_SRC_COLOR[src] ?? '#94a3b8', age, 1, false),
    })
  }
  return sparks
}
