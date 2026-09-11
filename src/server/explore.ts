import type Database from 'better-sqlite3'
import path from 'node:path'
import type { Request, Response } from 'express'
import { parseJson } from '../lib/hash'
import { parseEmbedding } from '../lib/semantic'
import type { SearchResult } from '../lib/types'
import { isGraphableTag } from '../pipeline/graph'
import { conceptEdges, type SecondBrainSearchResult } from './second-brain'

export type SourceFilter = 'all' | 'x' | 'web' | 'youtube'

export interface ExploreChild {
  id: string
  kind: 'topic' | 'tag' | 'author' | 'domain' | 'channel' | 'item'
  itemType?: 'x' | 'favorite' | 'youtube' | 'document'
  label: string
  count?: number
  sourceCounts?: { x: number; web: number; youtube: number }
  color?: string
  groupId?: string
  createdAt?: string | null
  /** Median member created_at (epoch ms) — aggregate children have no createdAt of their own. */
  recencyMs?: number
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
  facet?: string
  key?: string
  query?: string
  center?: ExploreChild | null
  children: ExploreChild[]
  groups?: ExploreChild[]
  edges: ExploreEdge[]
  results: SearchResult[]
  total: number
  /** Second-brain concept constellations (search level). */
  concepts?: ExploreConcept[]
  /** Cross-concept bridge nodes for navigation. */
  bridges?: ExploreBridge[]
  expandedTerms?: string[]
}

interface TopicRow {
  slug: string
  name: string
  color: string
  description: string | null
}

// Generic web/navigation words that are valid tags elsewhere but useless as browse categories
const BROWSE_STOPWORDS = new Set([
  'browser-favorite', 'page', 'pages', 'saved', 'save', 'site', 'sites', 'web', 'website',
  'online', 'home', 'click', 'view', 'watch', 'list', 'lists', 'new', 'top', 'here',
  'content', 'info', 'information', 'article', 'articles', 'folder', 'user', 'users',
])

function isBrowsableTag(tag: string): boolean {
  if (BROWSE_STOPWORDS.has(tag)) return false
  if (tag.startsWith('folder:')) return false
  return isGraphableTag(tag, 'hashtag', 999)
}

/** Merge singular/plural duplicates ("agent"/"agents") keeping the higher-count spelling. */
function mergePlurals(counts: Map<string, number>): Map<string, number> {
  const merged = new Map(counts)
  for (const [tag, count] of counts) {
    const plural = `${tag}s`
    const pluralCount = merged.get(plural)
    if (pluralCount === undefined || !merged.has(tag)) continue
    const keep = pluralCount >= count ? plural : tag
    const drop = keep === plural ? tag : plural
    merged.set(keep, (merged.get(keep) ?? 0) + (merged.get(drop) ?? 0))
    merged.delete(drop)
  }
  return merged
}

function sourceClauseForBookmarks(source: SourceFilter, alias = 'b'): string {
  if (source === 'web') return `AND (${alias}.source = 'import' OR ${alias}.author_handle = 'browser-favorites')`
  if (source === 'x') return `AND ${alias}.source <> 'import' AND ${alias}.author_handle <> 'browser-favorites'`
  return ''
}

function thumbnailPath(localThumbnailPath: unknown, thumbnailUrl: unknown): string | null {
  if (typeof localThumbnailPath === 'string' && localThumbnailPath) return `/thumbnails/${path.basename(localThumbnailPath)}`
  if (typeof thumbnailUrl === 'string' && thumbnailUrl) return thumbnailUrl
  return null
}

/** Build a popup-ready child from a graph_nodes row (metadata already aggregates links/media/topics/tags). */
function childFromGraphNode(row: { id: string; type: string; label: string; summary: string | null; weight: number; metadata: string | null; embedding?: string | null }): ExploreChild {
  const meta = parseJson<Record<string, unknown>>(row.metadata, {})
  const isYouTube = row.type === 'youtube'
  const isFavorite = row.type === 'favorite' || meta.itemKind === 'favorite'
  const isDocument = row.type === 'document'
  const media = Array.isArray(meta.media) ? meta.media as Array<Record<string, unknown>> : []
  const mediaThumb = media.find((item) => typeof item.thumbnailUrl === 'string' && item.thumbnailUrl)
  const thumbnail = isYouTube
    ? thumbnailPath(meta.localThumbnailPath, meta.thumbnailUrl)
    : (mediaThumb ? String(mediaThumb.thumbnailUrl) : null)
  const createdAt = typeof meta.tweetCreatedAt === 'string' ? meta.tweetCreatedAt : (typeof meta.publishedAt === 'string' ? meta.publishedAt : null)
  return {
    id: row.id,
    kind: 'item',
    itemType: isYouTube ? 'youtube' : isDocument ? 'document' : isFavorite ? 'favorite' : 'x',
    label: row.label,
    createdAt,
    meta: {
      summary: row.summary,
      url: meta.url ?? (isDocument ? meta.sourceUrl ?? `/api/documents/${row.id.slice(9)}/file` : null),
      authorName: meta.authorName ?? meta.channelName ?? null,
      authorHandle: meta.authorHandle ?? null,
      domain: Array.isArray(meta.links) && (meta.links as Array<Record<string, unknown>>)[0]?.domain
        ? (meta.links as Array<Record<string, unknown>>)[0].domain
        : null,
      thumbnailUrl: thumbnail,
      durationSeconds: meta.durationSeconds ?? null,
      transcriptStatus: meta.transcriptStatus ?? null,
      topics: Array.isArray(meta.topics) ? meta.topics : [],
      tags: Array.isArray(meta.tags) ? (meta.tags as unknown[]).slice(0, 10) : [],
      links: Array.isArray(meta.links) ? (meta.links as unknown[]).slice(0, 4) : [],
      playlists: Array.isArray(meta.playlists) ? meta.playlists : [],
      embedding: row.embedding ? parseEmbedding(row.embedding) : undefined,
    },
  }
}

function loadItemChildren(db: Database.Database, nodeIds: string[]): ExploreChild[] {
  if (!nodeIds.length) return []
  const placeholders = nodeIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT gn.id, gn.type, gn.label, gn.summary, gn.weight, gn.metadata, e.vector AS embedding
      FROM graph_nodes gn LEFT JOIN embeddings e ON e.owner_type='graph_node' AND e.owner_id=gn.id AND e.model = 'atlas-hash-32-v1'
      WHERE gn.id IN (${placeholders})`)
    .all(...nodeIds) as Array<{ id: string; type: string; label: string; summary: string | null; weight: number; metadata: string | null }>
  const byId = new Map(rows.map((row) => [row.id, childFromGraphNode(row)]))
  return nodeIds.map((id) => byId.get(id)).filter((child): child is ExploreChild => Boolean(child))
}

function correlationEdges(db: Database.Database, nodeIds: string[]): ExploreEdge[] {
  if (nodeIds.length < 2) return []
  const placeholders = nodeIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT source_id AS source, target_id AS target, weight, metadata FROM graph_edges
    WHERE type = 'correlates_with' AND source_id IN (${placeholders}) AND target_id IN (${placeholders})
    ORDER BY weight DESC LIMIT 400
  `).all(...nodeIds, ...nodeIds) as Array<{ source: string; target: string; weight: number; metadata: string | null }>
  return rows.map((row) => {
    const meta = parseJson<Record<string, unknown>>(row.metadata, {})
    return {
      source: row.source,
      target: row.target,
      weight: row.weight,
      sharedTags: Array.isArray(meta.sharedTags) ? (meta.sharedTags as unknown[]).map(String).slice(0, 4) : undefined,
      sharedDomain: typeof meta.sharedDomain === 'string' ? meta.sharedDomain : undefined,
    }
  })
}

function topicRow(db: Database.Database, slug: string): TopicRow | null {
  return (db.prepare('SELECT slug, name, color, description FROM topics WHERE slug = ?').get(slug) as TopicRow | undefined) ?? null
}

function hash32(seed: string): number {
  let hash = 2166136261 >>> 0
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Dust payload: per-topic hash-ordered item samples as flat [ageDays, srcId, weightTier] triplets.
 * Sampling order is a content hash of the item id — never recency, weight, or count rank. */
export interface DustTopic { id: string; n: number; d: number[] }
export interface DustResponse { level: 'dust'; totalItems: number; topics: DustTopic[] }

const DUST_TOTAL = 9000
const DUST_TOPIC_MIN = 60
const DUST_TOPIC_MAX = 1100

interface DustRow { slug: string; id: string; age: number; src: number; w: number }

let atlasDustCache: DustResponse | null = null

function atlasDust(db: Database.Database): DustResponse {
  if (atlasDustCache) return atlasDustCache
  const rows = db.prepare(`
    SELECT t.slug AS slug, b.id AS id,
      CAST(MAX(0, julianday('now') - julianday(COALESCE(b.tweet_created_at, b.imported_at))) AS INTEGER) AS age,
      CASE WHEN b.source = 'import' OR b.author_handle = 'browser-favorites' THEN 1 ELSE 0 END AS src,
      COALESCE(gn.weight, 3) AS w
    FROM bookmark_topics bt
    JOIN topics t ON t.id = bt.topic_id
    JOIN bookmarks b ON b.id = bt.bookmark_id
    LEFT JOIN graph_nodes gn ON gn.id = 'bookmark:' || b.id
  `).all() as DustRow[]
  rows.push(...db.prepare(`
    SELECT t.slug AS slug, y.id AS id,
      CAST(MAX(0, julianday('now') - julianday(COALESCE(y.published_at, y.imported_at))) AS INTEGER) AS age,
      2 AS src,
      COALESCE(gn.weight, 3) AS w
    FROM youtube_video_topics yvt
    JOIN topics t ON t.id = yvt.topic_id
    JOIN youtube_videos y ON y.id = yvt.video_id AND y.curation_status <> 'removed'
    LEFT JOIN graph_nodes gn ON gn.id = 'youtube:' || y.id
  `).all() as DustRow[])

  const weights = rows.map((row) => row.w).sort((a, b) => a - b)
  const q = (fraction: number) => weights[Math.min(weights.length - 1, Math.floor(weights.length * fraction))] ?? 3
  const q1 = q(0.25), q2 = q(0.5), q3 = q(0.75)

  const bySlug = new Map<string, DustRow[]>()
  for (const row of rows) {
    const bucket = bySlug.get(row.slug)
    if (bucket) bucket.push(row)
    else bySlug.set(row.slug, [row])
  }
  const total = rows.length
  const topics: DustTopic[] = []
  for (const [slug, members] of bySlug) {
    members.sort((a, b) => hash32(a.id) - hash32(b.id) || a.id.localeCompare(b.id))
    const cap = Math.max(DUST_TOPIC_MIN, Math.min(DUST_TOPIC_MAX, Math.round(DUST_TOTAL * members.length / Math.max(1, total))))
    const d: number[] = []
    for (const row of members.slice(0, cap)) {
      d.push(row.age, row.src, row.w <= q1 ? 0 : row.w <= q2 ? 1 : row.w <= q3 ? 2 : 3)
    }
    topics.push({ id: `topic:${slug}`, n: members.length, d })
  }
  atlasDustCache = { level: 'dust', totalItems: total, topics }
  return atlasDustCache
}

const categoryDustCache = new Map<string, DustResponse>()

/** Overflow items of a category (everything past the 150 shown) as one dust bucket. */
function categoryDust(db: Database.Database, facet: Facet, key: string, slug: string | null, source: SourceFilter): DustResponse {
  const cacheKey = `${facet}:${key}:${slug ?? ''}:${source}`
  const cached = categoryDustCache.get(cacheKey)
  if (cached) return cached
  const { rest } = categoryItemIds(db, facet, key, slug, source)
  rest.sort((a, b) => hash32(a.nodeId) - hash32(b.nodeId) || a.nodeId.localeCompare(b.nodeId))
  const now = Date.now()
  const d: number[] = []
  for (const row of rest.slice(0, 640)) {
    const time = row.createdAt ? new Date(row.createdAt).getTime() : NaN
    const age = Number.isFinite(time) ? Math.max(0, Math.round((now - time) / 86400000)) : 1095
    d.push(age, row.nodeId.startsWith('youtube:') ? 2 : row.src ?? 0, 1)
  }
  const response: DustResponse = { level: 'dust', totalItems: rest.length, topics: [{ id: 'center', n: rest.length, d }] }
  if (categoryDustCache.size > 60) categoryDustCache.clear()
  categoryDustCache.set(cacheKey, response)
  return response
}

/** Real topic-topic co-occurrence (items carrying both topics) — the only atlas-level relation that exists in data. */
let atlasArcsCache: ExploreEdge[] | null = null

function atlasArcs(db: Database.Database): ExploreEdge[] {
  if (atlasArcsCache) return atlasArcsCache
  const pairs = new Map<string, number>()
  const tally = (rows: Array<{ a: string; b: string; c: number }>) => {
    for (const row of rows) {
      const key = `${row.a}|${row.b}`
      pairs.set(key, (pairs.get(key) ?? 0) + row.c)
    }
  }
  tally(db.prepare(`
    SELECT t1.slug AS a, t2.slug AS b, COUNT(*) AS c
    FROM bookmark_topics x
    JOIN bookmark_topics y ON y.bookmark_id = x.bookmark_id AND y.topic_id > x.topic_id
    JOIN topics t1 ON t1.id = x.topic_id
    JOIN topics t2 ON t2.id = y.topic_id
    GROUP BY x.topic_id, y.topic_id
  `).all() as Array<{ a: string; b: string; c: number }>)
  tally(db.prepare(`
    SELECT t1.slug AS a, t2.slug AS b, COUNT(*) AS c
    FROM youtube_video_topics x
    JOIN youtube_video_topics y ON y.video_id = x.video_id AND y.topic_id > x.topic_id
    JOIN topics t1 ON t1.id = x.topic_id
    JOIN topics t2 ON t2.id = y.topic_id
    GROUP BY x.topic_id, y.topic_id
  `).all() as Array<{ a: string; b: string; c: number }>)
  const ranked = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 35)
  const max = ranked[0]?.[1] ?? 1
  atlasArcsCache = ranked.map(([key, count]) => {
    const [a, b] = key.split('|')
    return { source: `topic:${a}`, target: `topic:${b}`, weight: 0.4 + 2.6 * (count / max) }
  })
  return atlasArcsCache
}

/** Tag-tag co-occurrence inside one topic, among the tags actually shown. */
const topicEdgeCache = new Map<string, ExploreEdge[]>()

function topicTagEdges(db: Database.Database, slug: string, source: SourceFilter, tags: string[]): ExploreEdge[] {
  if (tags.length < 2) return []
  const cacheKey = `${slug}:${source}`
  const cached = topicEdgeCache.get(cacheKey)
  if (cached) return cached
  const spellings = new Map<string, string>()
  for (const tag of tags) {
    spellings.set(tag, tag)
    const twin = tag.endsWith('s') ? tag.slice(0, -1) : `${tag}s`
    if (!spellings.has(twin)) spellings.set(twin, tag)
  }
  const pairs = [...spellings.entries()]
  const parts: string[] = []
  const args: unknown[] = pairs.flat()
  if (source !== 'youtube') {
    parts.push(`
      SELECT DISTINCT spell.merged AS tag, bt.bookmark_id AS item
      FROM bookmark_topics btop
      JOIN topics t ON t.id = btop.topic_id AND t.slug = ?
      JOIN bookmark_tags bt ON bt.bookmark_id = btop.bookmark_id AND bt.source IN ('semantic-local', 'hashtag', 'folder')
      JOIN spell ON spell.raw = bt.tag`)
    args.push(slug)
  }
  if (source === 'all' || source === 'youtube') {
    parts.push(`
      SELECT DISTINCT spell.merged, 'yt:' || yt.video_id
      FROM youtube_video_topics yvt
      JOIN topics t ON t.id = yvt.topic_id AND t.slug = ?
      JOIN youtube_video_tags yt ON yt.video_id = yvt.video_id
      JOIN spell ON spell.raw = yt.tag`)
    args.push(slug)
  }
  const rows = db.prepare(`
    WITH spell(raw, merged) AS (VALUES ${pairs.map(() => '(?, ?)').join(',')}),
    tagged AS (${parts.join(' UNION ALL ')})
    SELECT a.tag AS ta, b.tag AS tb, COUNT(*) AS c
    FROM tagged a JOIN tagged b ON b.item = a.item AND b.tag > a.tag
    GROUP BY a.tag, b.tag HAVING c >= 3 ORDER BY c DESC LIMIT 40
  `).all(...args) as Array<{ ta: string; tb: string; c: number }>
  const max = rows[0]?.c ?? 1
  const edges = rows.map((row) => ({ source: `tag:${row.ta}`, target: `tag:${row.tb}`, weight: 0.4 + 2.6 * (row.c / max) }))
  if (topicEdgeCache.size > 60) topicEdgeCache.clear()
  topicEdgeCache.set(cacheKey, edges)
  return edges
}

/** Drop every explore-level derived cache — call after any write to the tables they aggregate. */
export function invalidateExploreCaches(): void {
  atlasDustCache = null
  categoryDustCache.clear()
  atlasArcsCache = null
  topicEdgeCache.clear()
}

/** Live shared-tag pairs among the items on screen — the stored correlates_with
 * edges cover too few pairs for any 150-item slice to light up. */
function sharedTagEdges(db: Database.Database, nodeIds: string[], excludeKey: string | null): ExploreEdge[] {
  if (nodeIds.length < 2) return []
  const bookmarkIds = nodeIds.filter((id) => id.startsWith('bookmark:')).map((id) => id.replace(/^bookmark:/, ''))
  const videoIds = nodeIds.filter((id) => id.startsWith('youtube:')).map((id) => id.replace(/^youtube:/, ''))
  const rows: Array<{ nid: string; tag: string }> = []
  if (bookmarkIds.length) {
    const marks = bookmarkIds.map(() => '?').join(',')
    rows.push(...db.prepare(`
      SELECT 'bookmark:' || bt.bookmark_id AS nid, bt.tag AS tag FROM bookmark_tags bt
      WHERE bt.bookmark_id IN (${marks}) AND bt.source IN ('semantic-local', 'hashtag', 'folder')
    `).all(...bookmarkIds) as Array<{ nid: string; tag: string }>)
  }
  if (videoIds.length) {
    const marks = videoIds.map(() => '?').join(',')
    rows.push(...db.prepare(`
      SELECT 'youtube:' || yt.video_id AS nid, yt.tag AS tag FROM youtube_video_tags yt
      WHERE yt.video_id IN (${marks})
    `).all(...videoIds) as Array<{ nid: string; tag: string }>)
  }
  const twin = excludeKey ? (excludeKey.endsWith('s') ? excludeKey.slice(0, -1) : `${excludeKey}s`) : null
  const byTag = new Map<string, string[]>()
  for (const row of rows) {
    if (row.tag === excludeKey || row.tag === twin || BROWSE_STOPWORDS.has(row.tag)) continue
    const bucket = byTag.get(row.tag)
    if (bucket) bucket.push(row.nid)
    else byTag.set(row.tag, [row.nid])
  }
  const pairCounts = new Map<string, { c: number; tags: string[] }>()
  const ceiling = Math.max(6, Math.floor(nodeIds.length * 0.35))
  for (const [tag, members] of byTag) {
    if (members.length < 2 || members.length > ceiling) continue
    members.sort()
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = `${members[i]}\u0001${members[j]}`
        const entry = pairCounts.get(key)
        if (entry) { entry.c++; if (entry.tags.length < 4) entry.tags.push(tag) }
        else pairCounts.set(key, { c: 1, tags: [tag] })
      }
    }
  }
  return [...pairCounts.entries()]
    .filter(([, entry]) => entry.c >= 2)
    .sort((a, b) => b[1].c - a[1].c)
    .slice(0, 140)
    .map(([key, entry]) => {
      const [source, target] = key.split('\u0001')
      return { source, target, weight: Math.min(4, entry.c), sharedTags: entry.tags }
    })
}

async function atlasLevel(
  db: Database.Database,
  source: SourceFilter,
  searchItems: (query: string, limit: number, source?: string) => Promise<SearchResult[]>,
): Promise<ExploreResponse> {
  const rows = db.prepare(`
    SELECT t.slug, t.name, t.color, t.description,
      COALESCE(SUM(CASE WHEN b.source = 'import' OR b.author_handle = 'browser-favorites' THEN 1 ELSE 0 END), 0) AS webCount,
      COALESCE(SUM(CASE WHEN b.id IS NOT NULL AND b.source <> 'import' AND b.author_handle <> 'browser-favorites' THEN 1 ELSE 0 END), 0) AS xCount
    FROM topics t
    LEFT JOIN bookmark_topics bt ON bt.topic_id = t.id
    LEFT JOIN bookmarks b ON b.id = bt.bookmark_id
    GROUP BY t.id
  `).all() as Array<TopicRow & { webCount: number; xCount: number }>
  const youtubeCounts = new Map(
    (db.prepare(`
      SELECT t.slug, COUNT(*) AS c FROM youtube_video_topics yt
      JOIN topics t ON t.id = yt.topic_id
      JOIN youtube_videos y ON y.id = yt.video_id AND y.curation_status <> 'removed'
      GROUP BY t.slug
    `).all() as Array<{ slug: string; c: number }>).map((row) => [row.slug, row.c]),
  )
  // Median, not mean: import batches land thousands of members on one day and would drag a mean.
  const recencyBySlug = new Map(
    (db.prepare(`
      WITH times AS (
        SELECT bt.topic_id AS topicId, unixepoch(COALESCE(b.tweet_created_at, b.imported_at)) AS ts
        FROM bookmark_topics bt JOIN bookmarks b ON b.id = bt.bookmark_id
        UNION ALL
        SELECT yvt.topic_id, unixepoch(COALESCE(y.published_at, y.imported_at))
        FROM youtube_video_topics yvt JOIN youtube_videos y ON y.id = yvt.video_id AND y.curation_status <> 'removed'
      ),
      ranked AS (
        SELECT topicId, ts, ROW_NUMBER() OVER (PARTITION BY topicId ORDER BY ts) AS rn, COUNT(*) OVER (PARTITION BY topicId) AS n
        FROM times WHERE ts IS NOT NULL
      )
      SELECT t.slug, ts FROM ranked JOIN topics t ON t.id = ranked.topicId WHERE rn = (n + 1) / 2
    `).all() as Array<{ slug: string; ts: number }>).map((row) => [row.slug, row.ts * 1000]),
  )

  const children: ExploreChild[] = rows.map((row) => {
    const youtube = youtubeCounts.get(row.slug) ?? 0
    return {
      id: `topic:${row.slug}`,
      kind: 'topic' as const,
      label: row.name,
      color: row.color,
      count: row.xCount + row.webCount + youtube,
      sourceCounts: { x: row.xCount, web: row.webCount, youtube },
      recencyMs: recencyBySlug.get(row.slug),
      meta: { slug: row.slug, description: row.description },
    }
  }).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))

  return {
    level: 'atlas',
    title: 'Knowledge Atlas',
    center: null,
    children,
    edges: atlasArcs(db),
    results: await searchItems('', 80, source),
    total: children.length,
  }
}

const FACETS = ['tags', 'authors', 'domains', 'channels'] as const
export type Facet = (typeof FACETS)[number]

function normalizeFacet(value: string): Facet {
  return (FACETS as readonly string[]).includes(value) ? value as Facet : 'tags'
}

function topicTagCounts(db: Database.Database, slug: string, source: SourceFilter): Map<string, number> {
  const counts = new Map<string, number>()
  if (source !== 'youtube') {
    const rows = db.prepare(`
      SELECT bt.tag, COUNT(DISTINCT bt.bookmark_id) AS c
      FROM bookmark_topics btop
      JOIN topics t ON t.id = btop.topic_id AND t.slug = ?
      JOIN bookmarks b ON b.id = btop.bookmark_id ${sourceClauseForBookmarks(source)}
      JOIN bookmark_tags bt ON bt.bookmark_id = btop.bookmark_id
      WHERE bt.source IN ('semantic-local', 'hashtag', 'folder')
      GROUP BY bt.tag
    `).all(slug) as Array<{ tag: string; c: number }>
    for (const row of rows) counts.set(row.tag, (counts.get(row.tag) ?? 0) + row.c)
  }
  if (source === 'all' || source === 'youtube') {
    const rows = db.prepare(`
      SELECT yt.tag, COUNT(DISTINCT yt.video_id) AS c
      FROM youtube_video_topics yvt
      JOIN topics t ON t.id = yvt.topic_id AND t.slug = ?
      JOIN youtube_video_tags yt ON yt.video_id = yvt.video_id
      GROUP BY yt.tag
    `).all(slug) as Array<{ tag: string; c: number }>
    for (const row of rows) counts.set(row.tag, (counts.get(row.tag) ?? 0) + row.c)
  }
  return counts
}

function topicRecentItems(db: Database.Database, slug: string, source: SourceFilter, limit = 60): SearchResult[] {
  const rows: IdRow[] = []
  if (source !== 'youtube') {
    rows.push(...db.prepare(`
      SELECT 'bookmark:' || b.id AS nodeId, COALESCE(b.tweet_created_at, b.imported_at) AS createdAt
      FROM bookmarks b
      WHERE EXISTS (SELECT 1 FROM bookmark_topics btop JOIN topics t ON t.id = btop.topic_id WHERE btop.bookmark_id = b.id AND t.slug = ?)
        AND NOT EXISTS (SELECT 1 FROM curated_items ci WHERE ci.item_type = 'x' AND ci.item_id = b.id AND ci.status IN ('removed', 'archived'))
        ${sourceClauseForBookmarks(source)}
      ORDER BY createdAt DESC LIMIT ?
    `).all(slug, limit) as IdRow[])
  }
  if (source === 'all' || source === 'youtube') {
    rows.push(...db.prepare(`
      SELECT 'youtube:' || y.id AS nodeId, COALESCE(y.published_at, y.imported_at) AS createdAt
      FROM youtube_videos y
      WHERE y.curation_status NOT IN ('removed', 'archived')
        AND EXISTS (SELECT 1 FROM youtube_video_topics yvt JOIN topics t ON t.id = yvt.topic_id WHERE yvt.video_id = y.id AND t.slug = ?)
      ORDER BY createdAt DESC LIMIT ?
    `).all(slug, limit) as IdRow[])
  }
  rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return loadItemChildren(db, rows.slice(0, limit).map((row) => row.nodeId)).map(resultFromChild)
}

interface FacetSignal { sourceCounts: { x: number; web: number; youtube: number }; recencyMs?: number }

/** Per-child source mix + median member recency so aggregate pills carry real z/w axis data. One query per facet, never per child. */
function facetSignals(db: Database.Database, facet: Facet, slug: string, source: SourceFilter, keys: string[]): Map<string, FacetSignal> {
  if (!keys.length) return new Map()
  const marks = keys.map(() => '?').join(',')
  let timesSql = ''
  let args: unknown[] = []
  if (facet === 'tags') {
    // Children are plural-merged, so map both spellings back onto the merged key
    const spellings = new Map<string, string>()
    for (const key of keys) {
      spellings.set(key, key)
      const twin = key.endsWith('s') ? key.slice(0, -1) : `${key}s`
      if (!spellings.has(twin)) spellings.set(twin, key)
    }
    const pairs = [...spellings.entries()]
    args = pairs.flat()
    const parts: string[] = []
    if (source !== 'youtube') {
      parts.push(`
        SELECT spell.merged AS key,
          CASE WHEN b.source = 'import' OR b.author_handle = 'browser-favorites' THEN 'web' ELSE 'x' END AS src,
          unixepoch(COALESCE(b.tweet_created_at, b.imported_at)) AS ts
        FROM bookmark_topics btop
        JOIN topics t ON t.id = btop.topic_id AND t.slug = ?
        JOIN bookmark_tags bt ON bt.bookmark_id = btop.bookmark_id AND bt.source IN ('semantic-local', 'hashtag', 'folder')
        JOIN spell ON spell.raw = bt.tag
        JOIN bookmarks b ON b.id = btop.bookmark_id ${sourceClauseForBookmarks(source)}
        GROUP BY spell.merged, btop.bookmark_id`)
      args.push(slug)
    }
    if (source === 'all' || source === 'youtube') {
      parts.push(`
        SELECT spell.merged, 'youtube', unixepoch(COALESCE(y.published_at, y.imported_at))
        FROM youtube_video_topics yvt
        JOIN topics t ON t.id = yvt.topic_id AND t.slug = ?
        JOIN youtube_video_tags yt ON yt.video_id = yvt.video_id
        JOIN spell ON spell.raw = yt.tag
        JOIN youtube_videos y ON y.id = yvt.video_id AND y.curation_status <> 'removed'
        GROUP BY spell.merged, yvt.video_id`)
      args.push(slug)
    }
    timesSql = `WITH spell(raw, merged) AS (VALUES ${pairs.map(() => '(?, ?)').join(',')}), times AS (${parts.join(' UNION ALL ')})`
  } else if (facet === 'authors') {
    timesSql = `WITH times AS (
      SELECT b.author_handle AS key, 'x' AS src, unixepoch(COALESCE(b.tweet_created_at, b.imported_at)) AS ts
      FROM bookmark_topics btop
      JOIN topics t ON t.id = btop.topic_id AND t.slug = ?
      JOIN bookmarks b ON b.id = btop.bookmark_id
      WHERE b.source <> 'import' AND b.author_handle <> 'browser-favorites' AND b.author_handle IN (${marks}))`
    args = [slug, ...keys]
  } else if (facet === 'domains') {
    timesSql = `WITH times AS (
      SELECT l.domain AS key,
        CASE WHEN b.source = 'import' OR b.author_handle = 'browser-favorites' THEN 'web' ELSE 'x' END AS src,
        unixepoch(COALESCE(b.tweet_created_at, b.imported_at)) AS ts
      FROM bookmark_topics btop
      JOIN topics t ON t.id = btop.topic_id AND t.slug = ?
      JOIN bookmarks b ON b.id = btop.bookmark_id ${sourceClauseForBookmarks(source === 'youtube' ? 'all' : source)}
      JOIN links l ON l.bookmark_id = btop.bookmark_id AND l.domain IN (${marks})
      GROUP BY l.domain, b.id)`
    args = [slug, ...keys]
  } else {
    timesSql = `WITH times AS (
      SELECT COALESCE(NULLIF(y.channel_id, ''), lower(y.channel_name)) AS key, 'youtube' AS src, unixepoch(COALESCE(y.published_at, y.imported_at)) AS ts
      FROM youtube_video_topics yvt
      JOIN topics t ON t.id = yvt.topic_id AND t.slug = ?
      JOIN youtube_videos y ON y.id = yvt.video_id AND y.curation_status <> 'removed'
      WHERE COALESCE(NULLIF(y.channel_id, ''), lower(y.channel_name)) IN (${marks}))`
    args = [slug, ...keys]
  }
  const rows = db.prepare(`${timesSql},
    med AS (
      SELECT key, ts, ROW_NUMBER() OVER (PARTITION BY key ORDER BY ts) AS rn, COUNT(*) OVER (PARTITION BY key) AS n
      FROM times WHERE ts IS NOT NULL
    ),
    counts AS (
      SELECT key, SUM(src = 'x') AS x, SUM(src = 'web') AS web, SUM(src = 'youtube') AS youtube
      FROM times GROUP BY key
    )
    SELECT c.key, c.x, c.web, c.youtube, med.ts
    FROM counts c LEFT JOIN med ON med.key = c.key AND med.rn = (med.n + 1) / 2
  `).all(...args) as Array<{ key: string; x: number; web: number; youtube: number; ts: number | null }>
  return new Map(rows.map((row) => [row.key, {
    sourceCounts: { x: row.x, web: row.web, youtube: row.youtube },
    recencyMs: row.ts == null ? undefined : row.ts * 1000,
  }]))
}

function topicLevel(db: Database.Database, slug: string, facet: Facet, source: SourceFilter): ExploreResponse | null {
  const topic = topicRow(db, slug)
  if (!topic) return null

  let children: ExploreChild[] = []
  let total = 0

  if (facet === 'tags') {
    const filtered = new Map([...topicTagCounts(db, slug, source)].filter(([tag]) => isBrowsableTag(tag)))
    const merged = [...mergePlurals(filtered)].sort((a, b) => b[1] - a[1])
    total = merged.length
    children = merged.slice(0, 36).map(([tag, count]) => ({
      id: `tag:${tag}`,
      kind: 'tag' as const,
      label: tag,
      count,
      color: topic.color,
      meta: { key: tag },
    }))
  } else if (facet === 'authors') {
    const rows = db.prepare(`
      SELECT b.author_handle AS handle, b.author_name AS name, COUNT(*) AS c
      FROM bookmark_topics btop
      JOIN topics t ON t.id = btop.topic_id AND t.slug = ?
      JOIN bookmarks b ON b.id = btop.bookmark_id
      WHERE b.source <> 'import' AND b.author_handle <> 'browser-favorites'
      GROUP BY b.author_handle ORDER BY c DESC LIMIT 36
    `).all(slug) as Array<{ handle: string; name: string; c: number }>
    total = rows.length
    children = rows.map((row) => ({
      id: `author:${row.handle.toLowerCase()}`,
      kind: 'author' as const,
      label: `@${row.handle}`,
      count: row.c,
      color: topic.color,
      meta: { key: row.handle, name: row.name },
    }))
  } else if (facet === 'domains') {
    const rows = db.prepare(`
      SELECT l.domain, COUNT(DISTINCT l.bookmark_id) AS c
      FROM bookmark_topics btop
      JOIN topics t ON t.id = btop.topic_id AND t.slug = ?
      JOIN bookmarks b ON b.id = btop.bookmark_id ${sourceClauseForBookmarks(source === 'youtube' ? 'all' : source)}
      JOIN links l ON l.bookmark_id = btop.bookmark_id
      WHERE l.domain IS NOT NULL AND l.domain NOT IN ('x.com', 'twitter.com', 't.co')
      GROUP BY l.domain ORDER BY c DESC LIMIT 36
    `).all(slug) as Array<{ domain: string; c: number }>
    total = rows.length
    children = rows.map((row) => ({
      id: `domain:${row.domain}`,
      kind: 'domain' as const,
      label: row.domain,
      count: row.c,
      color: topic.color,
      meta: { key: row.domain },
    }))
  } else {
    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(y.channel_id, ''), lower(y.channel_name)) AS key, y.channel_name AS name, COUNT(*) AS c
      FROM youtube_video_topics yvt
      JOIN topics t ON t.id = yvt.topic_id AND t.slug = ?
      JOIN youtube_videos y ON y.id = yvt.video_id AND y.curation_status <> 'removed' AND y.channel_name <> ''
      GROUP BY key ORDER BY c DESC LIMIT 36
    `).all(slug) as Array<{ key: string; name: string; c: number }>
    total = rows.length
    children = rows.map((row) => ({
      id: `channel:${row.key}`,
      kind: 'channel' as const,
      label: row.name,
      count: row.c,
      color: topic.color,
      meta: { key: row.key },
    }))
  }

  const signals = facetSignals(db, facet, slug, source, children.map((child) => String(child.meta?.key ?? child.label)))
  for (const child of children) {
    const signal = signals.get(String(child.meta?.key ?? child.label))
    if (!signal) continue
    child.sourceCounts = signal.sourceCounts
    if (signal.recencyMs !== undefined) child.recencyMs = signal.recencyMs
  }

  return {
    level: 'topic',
    title: topic.name,
    topic,
    facet,
    center: {
      id: `topic:${slug}`,
      kind: 'topic',
      label: topic.name,
      color: topic.color,
      meta: { description: topic.description },
    },
    children,
    edges: facet === 'tags' ? topicTagEdges(db, slug, source, children.map((child) => String(child.meta?.key ?? child.label))) : [],
    results: topicRecentItems(db, slug, source),
    total,
  }
}

const CATEGORY_ITEM_LIMIT = 150

interface IdRow { nodeId: string; createdAt: string | null; src?: number }

function categoryItemIds(db: Database.Database, facet: Facet, key: string, slug: string | null, source: SourceFilter): { ids: IdRow[]; total: number; rest: IdRow[] } {
  const rows: IdRow[] = []
  let total = 0
  const topicExists = slug
    ? `AND EXISTS (SELECT 1 FROM bookmark_topics btop JOIN topics t ON t.id = btop.topic_id WHERE btop.bookmark_id = b.id AND t.slug = $slug)`
    : ''
  const ytTopicExists = slug
    ? `AND EXISTS (SELECT 1 FROM youtube_video_topics yvt JOIN topics t ON t.id = yvt.topic_id WHERE yvt.video_id = y.id AND t.slug = $slug)`
    : ''
  const notRemoved = `AND NOT EXISTS (SELECT 1 FROM curated_items ci WHERE ci.item_type = 'x' AND ci.item_id = b.id AND ci.status IN ('removed', 'archived'))`

  const includeBookmarks = source !== 'youtube' && facet !== 'channels'
  const includeYouTube = (source === 'all' || source === 'youtube') && (facet === 'tags' || facet === 'channels')

  if (includeBookmarks) {
    // Plural-merged tags: match the tag and its singular/plural twin
    const tagKeys = facet === 'tags' ? [key, key.endsWith('s') ? key.slice(0, -1) : `${key}s`] : []
    const joins = facet === 'tags'
      ? `JOIN bookmark_tags bt ON bt.bookmark_id = b.id AND bt.tag IN (${tagKeys.map(() => '?').join(',')})`
      : facet === 'domains'
        ? `JOIN links l ON l.bookmark_id = b.id AND l.domain = ?`
        : ''
    const authorClause = facet === 'authors' ? 'AND b.author_handle = ? COLLATE NOCASE' : ''
    const positional = facet === 'authors' ? [key] : facet === 'domains' ? [key] : tagKeys
    const args: unknown[] = slug ? [...positional, { slug }] : [...positional]
    const sql = `
      SELECT DISTINCT 'bookmark:' || b.id AS nodeId, COALESCE(b.tweet_created_at, b.imported_at) AS createdAt,
        CASE WHEN b.source = 'import' OR b.author_handle = 'browser-favorites' THEN 1 ELSE 0 END AS src
      FROM bookmarks b ${joins}
      WHERE 1 = 1 ${authorClause} ${sourceClauseForBookmarks(source)} ${topicExists} ${notRemoved}
    `
    const all = db.prepare(`${sql} ORDER BY createdAt DESC`).all(...args) as IdRow[]
    total += all.length
    rows.push(...all)
  }

  if (includeYouTube) {
    const joins = facet === 'tags'
      ? `JOIN youtube_video_tags yt ON yt.video_id = y.id AND yt.tag IN (?, ?)`
      : ''
    const channelClause = facet === 'channels'
      ? `AND COALESCE(NULLIF(y.channel_id, ''), lower(y.channel_name)) = ?`
      : ''
    const positional = facet === 'tags' ? [key, key.endsWith('s') ? key.slice(0, -1) : `${key}s`] : [key]
    const args: unknown[] = slug ? [...positional, { slug }] : [...positional]
    const sql = `
      SELECT DISTINCT 'youtube:' || y.id AS nodeId, COALESCE(y.published_at, y.imported_at) AS createdAt, 2 AS src
      FROM youtube_videos y ${joins}
      WHERE y.curation_status NOT IN ('removed', 'archived') ${channelClause} ${ytTopicExists}
    `
    const all = db.prepare(`${sql} ORDER BY createdAt DESC`).all(...args) as IdRow[]
    total += all.length
    rows.push(...all)
  }

  rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return { ids: rows.slice(0, CATEGORY_ITEM_LIMIT), total, rest: rows.slice(CATEGORY_ITEM_LIMIT) }
}

function resultFromChild(child: ExploreChild): SearchResult {
  const meta = child.meta ?? {}
  const rawId = child.id.replace(/^(bookmark|youtube):/, '')
  return {
    id: rawId,
    itemType: child.itemType === 'youtube' ? 'youtube' : child.itemType === 'favorite' ? 'favorite' : 'x',
    tweetId: rawId,
    text: String(meta.summary ?? child.label),
    title: child.label,
    authorHandle: String(meta.authorHandle ?? ''),
    authorName: String(meta.authorName ?? meta.domain ?? ''),
    tweetCreatedAt: child.createdAt ?? null,
    topics: Array.isArray(meta.topics) ? (meta.topics as unknown[]).map(String).slice(0, 3) : [],
    tags: [],
    domains: meta.domain ? [String(meta.domain)] : [],
    mediaTypes: [],
    score: 0,
    url: meta.url ? String(meta.url) : undefined,
    thumbnailUrl: meta.thumbnailUrl ? String(meta.thumbnailUrl) : null,
    durationSeconds: typeof meta.durationSeconds === 'number' ? meta.durationSeconds : null,
    transcriptStatus: meta.transcriptStatus ? String(meta.transcriptStatus) : undefined,
    playlists: Array.isArray(meta.playlists) ? (meta.playlists as unknown[]).map(String) : [],
  }
}

function categoryLevel(db: Database.Database, facet: Facet, key: string, slug: string | null, source: SourceFilter): ExploreResponse {
  const topic = slug ? topicRow(db, slug) : null
  const { ids, total } = categoryItemIds(db, facet, key, slug, source)
  const children = loadItemChildren(db, ids.map((row) => row.nodeId))
  const label = facet === 'authors' ? `@${key}` : key
  const centerId = facet === 'tags' ? `tag:${key}` : facet === 'authors' ? `author:${key.toLowerCase()}` : facet === 'domains' ? `domain:${key}` : `channel:${key}`
  return {
    level: 'category',
    title: label,
    topic,
    facet,
    key,
    center: {
      id: centerId,
      kind: facet === 'tags' ? 'tag' : facet === 'authors' ? 'author' : facet === 'domains' ? 'domain' : 'channel',
      label,
      color: topic?.color ?? '#14b8a6',
      count: total,
    },
    children,
    edges: mergeEdges(
      correlationEdges(db, children.map((child) => child.id)),
      sharedTagEdges(db, children.map((child) => child.id), facet === 'tags' ? key : null),
    ),
    results: children.map(resultFromChild),
    total,
  }
}

/** Stored correlations win over live shared-tag pairs for the same item pair. */
function mergeEdges(primary: ExploreEdge[], backfill: ExploreEdge[]): ExploreEdge[] {
  const seen = new Set(primary.map((edge) => edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`))
  const merged = [...primary]
  for (const edge of backfill) {
    const key = edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(edge)
  }
  return merged.slice(0, 150)
}

async function searchLevel(
  db: Database.Database,
  query: string,
  source: SourceFilter,
  deps: {
    searchItems: (query: string, limit: number, source?: string) => Promise<SearchResult[]>
    searchSecondBrain?: (query: string, limit: number, source?: string) => Promise<SecondBrainSearchResult>
  },
): Promise<ExploreResponse> {
  const brain = deps.searchSecondBrain
    ? await deps.searchSecondBrain(query, CATEGORY_ITEM_LIMIT, source)
    : null
  const results: SearchResult[] = brain?.results ?? await deps.searchItems(query, CATEGORY_ITEM_LIMIT, source)
  const nodeIds = results.map((result) => (
    result.itemType === 'youtube' ? `youtube:${result.id}`
      : result.itemType === 'document' ? `document:${result.id}`
        : `bookmark:${result.id}`
  ))
  const children = loadItemChildren(db, nodeIds)
  const childById = new Map(children.map((child) => [child.id, child]))

  // Prefer second-brain concept constellations when they yield 2+ real clusters
  const conceptGroups = brain?.concepts.filter((c) => c.key !== 'unsorted' || (brain.concepts.length === 1)) ?? []
  const useConcepts = conceptGroups.length >= 2
    || (conceptGroups.length === 1 && conceptGroups[0].key !== 'unsorted' && (brain?.concepts.length ?? 0) >= 1)

  const groups = new Map<string, ExploreChild>()
  const resultByNode = new Map(results.map((result, index) => [nodeIds[index], result]))

  if (useConcepts && brain) {
    for (const concept of brain.concepts) {
      groups.set(concept.id, {
        id: concept.id,
        kind: 'topic',
        label: concept.label,
        color: concept.color,
        count: concept.count,
        meta: { slug: concept.key, concept: true, summary: concept.summary, memberIds: concept.memberIds },
      })
    }
    for (let index = 0; index < results.length; index++) {
      const child = childById.get(nodeIds[index])
      if (!child) continue
      const result = results[index]
      const primary = result.conceptKeys?.[0]
      const groupId = primary ? `concept:${primary}` : (brain.concepts.find((c) => c.memberIds.includes(nodeIds[index]))?.id ?? 'concept:unsorted')
      child.groupId = groups.has(groupId) ? groupId : (brain.concepts[0]?.id ?? groupId)
      if (!groups.has(child.groupId)) {
        groups.set(child.groupId, {
          id: child.groupId,
          kind: 'topic',
          label: 'Related',
          color: '#64748b',
          count: 0,
          meta: { slug: 'unsorted', concept: true },
        })
      }
      const group = groups.get(child.groupId)!
      group.count = (group.count ?? 0) + 1
      // Annotate children with ranking transparency for the canvas/popup
      child.meta = {
        ...child.meta,
        why: result.why,
        rankScore: result.rankScore,
        scoreBreakdown: result.scoreBreakdown,
        conceptKeys: result.conceptKeys,
        bridgeScore: result.bridgeScore,
      }
    }
  } else {
    const topics = db.prepare('SELECT slug, name, color FROM topics').all() as Array<{ slug: string; name: string; color: string }>
    const topicByName = new Map(topics.map((topic) => [topic.name, topic]))
    for (let index = 0; index < results.length; index++) {
      const child = childById.get(nodeIds[index])
      if (!child) continue
      const meta = child.meta ?? {}
      const topicNames = Array.isArray(meta.topics) ? (meta.topics as unknown[]).map(String) : []
      const primary = topicNames.map((name) => topicByName.get(name)).find(Boolean) ?? null
      const groupId = primary ? `topic:${primary.slug}` : 'topic:unsorted'
      child.groupId = groupId
      if (!groups.has(groupId)) {
        const info = primary ?? topicByName.get('Unsorted') ?? { slug: 'unsorted', name: 'Unsorted', color: '#71717a' }
        groups.set(groupId, { id: groupId, kind: 'topic', label: info.name, color: info.color, count: 0, meta: { slug: info.slug } })
      }
      const group = groups.get(groupId)!
      group.count = (group.count ?? 0) + 1
      const result = resultByNode.get(child.id)
      if (result) {
        child.meta = {
          ...child.meta,
          why: result.why,
          rankScore: result.rankScore,
          scoreBreakdown: result.scoreBreakdown,
          conceptKeys: result.conceptKeys,
          bridgeScore: result.bridgeScore,
        }
      }
    }
  }

  const orderedChildren = nodeIds.map((id) => childById.get(id)).filter((child): child is ExploreChild => Boolean(child))
  const liveConcept = brain ? conceptEdges(brain.results).map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
    sharedTags: edge.sharedTags,
  })) : []

  return {
    level: 'search',
    title: `Second brain · ${query}`,
    query,
    center: null,
    children: orderedChildren,
    groups: [...groups.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    edges: mergeEdges(
      mergeEdges(
        correlationEdges(db, orderedChildren.map((child) => child.id)),
        sharedTagEdges(db, orderedChildren.map((child) => child.id), null),
      ),
      liveConcept,
    ),
    results,
    total: results.length,
    concepts: brain?.concepts,
    bridges: brain?.bridges,
    expandedTerms: brain?.expandedTerms,
  }
}

export function createExploreHandler(
  db: Database.Database,
  deps: {
    searchItems: (query: string, limit: number, source?: string) => Promise<SearchResult[]>
    searchSecondBrain?: (query: string, limit: number, source?: string) => Promise<SecondBrainSearchResult>
  },
) {
  return async (req: Request, res: Response) => {
    const level = String(req.query.level ?? 'atlas')
    const source = (['all', 'x', 'web', 'youtube'].includes(String(req.query.source)) ? String(req.query.source) : 'all') as SourceFilter
    const slug = String(req.query.topic ?? '').trim() || null
    const facet = normalizeFacet(String(req.query.facet ?? 'tags'))
    const key = String(req.query.key ?? '').trim()
    const query = String(req.query.q ?? '').trim()

    try {
      if (level === 'dust') return res.json(key ? categoryDust(db, facet, key, slug, source) : atlasDust(db))
      if (level === 'search' && query) return res.json(await searchLevel(db, query, source, deps))
      if (level === 'category' && key) return res.json(categoryLevel(db, facet, key, slug, source))
      if (level === 'topic' && slug) {
        const response = topicLevel(db, slug, facet, source)
        if (!response) return res.status(404).json({ error: `Unknown topic: ${slug}` })
        return res.json(response)
      }
      return res.json(await atlasLevel(db, source, deps.searchItems))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
