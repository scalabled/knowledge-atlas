import type Database from 'better-sqlite3'
import { parseJson } from '../lib/hash'
import { embedQuery, SEMANTIC_DIMS, SEMANTIC_MODEL } from '../pipeline/embedder'
import { buildFtsQuery } from '../pipeline/store'
import { getMeta, openAssistantDb } from './db'
import type {
  AssistantMode,
  Citation,
  IdeaKind,
  IdeaRecord,
  RetrievedMemory,
  SourceType,
  ThemeRecord,
  TimelineEvent,
} from './types'

interface VectorState {
  builtAt: string | null
  ids: string[]
  matrix: Float32Array
  rows: number
}

let vectors: VectorState | null = null

export function invalidateAssistantVectors(): void {
  vectors = null
}

function loadVectors(db: Database.Database): VectorState {
  const builtAt = getMeta(db, 'built_at')
  if (vectors && vectors.builtAt === builtAt) return vectors
  const rows = db.prepare(`
    SELECT memory_id AS id, vector FROM memory_embeddings WHERE model = ?
  `).all(SEMANTIC_MODEL) as Array<{ id: string; vector: Buffer | Uint8Array }>
  const matrix = new Float32Array(rows.length * SEMANTIC_DIMS)
  const ids: string[] = []
  let count = 0
  for (const row of rows) {
    const bytes = row.vector instanceof Uint8Array ? row.vector : new Uint8Array(row.vector)
    if (bytes.byteLength !== SEMANTIC_DIMS * 4) continue
    const aligned = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes)
    matrix.set(new Float32Array(aligned.buffer, aligned.byteOffset, SEMANTIC_DIMS), count * SEMANTIC_DIMS)
    ids.push(row.id)
    count++
  }
  vectors = { builtAt, ids, matrix, rows: count }
  return vectors
}

function cosineHits(q: Float32Array, state: VectorState, limit: number, minCos = 0.28): Array<{ id: string; cos: number }> {
  const hits: Array<{ id: string; cos: number }> = []
  for (let row = 0; row < state.rows; row++) {
    const base = row * SEMANTIC_DIMS
    let dot = 0
    for (let i = 0; i < SEMANTIC_DIMS; i++) dot += state.matrix[base + i] * q[i]
    if (dot >= minCos) hits.push({ id: state.ids[row], cos: dot })
  }
  return hits.sort((a, b) => b.cos - a.cos).slice(0, limit)
}

function mapMemory(row: Record<string, unknown>, score: number, why: string[]): RetrievedMemory {
  return {
    id: String(row.id),
    sourceType: String(row.sourceType) as SourceType,
    sourceId: String(row.sourceId),
    graphNodeId: row.graphNodeId ? String(row.graphNodeId) : null,
    url: row.url ? String(row.url) : null,
    occurredAt: row.occurredAt ? String(row.occurredAt) : null,
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    author: row.author ? String(row.author) : null,
    authorName: row.authorName ? String(row.authorName) : null,
    topics: parseJson<string[]>(String(row.topics ?? '[]'), []),
    tags: parseJson<string[]>(String(row.tags ?? '[]'), []),
    contentHash: String(row.contentHash ?? ''),
    richness: Number(row.richness ?? 0),
    topicPrimary: row.topicPrimary ? String(row.topicPrimary) : null,
    score,
    why,
  }
}

function loadMemories(db: Database.Database, ids: string[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  if (!ids.length) return out
  const stmt = db.prepare(`
    SELECT id, source_type AS sourceType, source_id AS sourceId, graph_node_id AS graphNodeId,
      url, occurred_at AS occurredAt, title, body, author, author_name AS authorName,
      topics, tags, content_hash AS contentHash, richness, topic_primary AS topicPrimary
    FROM memories WHERE id = ?
  `)
  for (const id of ids) {
    const row = stmt.get(id) as Record<string, unknown> | undefined
    if (row) out.set(id, row)
  }
  return out
}

export async function searchMemories(
  db: Database.Database,
  query: string,
  opts: { limit?: number; sourceType?: SourceType; since?: string; mode?: AssistantMode } = {},
): Promise<RetrievedMemory[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 16, 40))
  const fts = buildFtsQuery(query)
  const scores = new Map<string, { lexical?: number; semantic?: number; why: string[] }>()

  if (fts) {
    const sql = `
      SELECT memory_id AS id, bm25(memory_fts) AS rank
      FROM memory_fts
      WHERE memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `
    const rows = db.prepare(sql).all(fts, limit * 4) as Array<{ id: string; rank: number }>
    rows.forEach((row, index) => {
      const current = scores.get(row.id) ?? { why: [] }
      current.lexical = 1 - index / Math.max(rows.length, 1)
      current.why.push('keyword')
      scores.set(row.id, current)
    })
  }

  if (query.trim()) {
    try {
      const state = loadVectors(db)
      if (state.rows) {
        const qv = await embedQuery(query)
        const hits = cosineHits(qv, state, limit * 4)
        hits.forEach((hit, index) => {
          const current = scores.get(hit.id) ?? { why: [] }
          current.semantic = hit.cos
          current.why.push('meaning')
          scores.set(hit.id, current)
          void index
        })
      }
    } catch {
      // MiniLM optional — FTS still works
    }
  }

  const ranked = [...scores.entries()]
    .map(([id, parts]) => ({
      id,
      parts,
      composite: (parts.lexical ?? 0) * 0.42 + (parts.semantic ?? 0) * 0.58,
    }))
    .sort((a, b) => b.composite - a.composite)

  const memories = loadMemories(db, ranked.map((row) => row.id))
  const out: RetrievedMemory[] = []
  for (const row of ranked) {
    const record = memories.get(row.id)
    if (!record) continue
    if (opts.sourceType && String(record.sourceType) !== opts.sourceType) continue
    if (opts.since && String(record.occurredAt ?? '') < opts.since) continue
    const why = [...new Set(row.parts.why)]
    if (opts.mode === 'timeline' && record.topicPrimary === 'ai-ml') why.push('ai trail')
    const occurred = record.occurredAt ? String(record.occurredAt) : null
    const ageDays = occurred ? Math.max(0, (Date.now() - new Date(occurred).getTime()) / 86_400_000) : 400
    const recency = Number.isFinite(ageDays) ? 0.15 + 0.85 * Math.exp(-Math.LN2 * ageDays / 400) : 0.2
    const score = Math.min(1, row.composite * 0.88 + recency * 0.12)
    out.push(mapMemory(record, score, why))
    if (out.length >= limit) break
  }

  if (out.length) return out

  const fallbackSql = opts.since
    ? `SELECT id, source_type AS sourceType, source_id AS sourceId, graph_node_id AS graphNodeId,
         url, occurred_at AS occurredAt, title, body, author, author_name AS authorName,
         topics, tags, content_hash AS contentHash, richness, topic_primary AS topicPrimary
       FROM memories WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?`
    : `SELECT id, source_type AS sourceType, source_id AS sourceId, graph_node_id AS graphNodeId,
         url, occurred_at AS occurredAt, title, body, author, author_name AS authorName,
         topics, tags, content_hash AS contentHash, richness, topic_primary AS topicPrimary
       FROM memories ORDER BY occurred_at DESC LIMIT ?`
  const fallback = (opts.since
    ? db.prepare(fallbackSql).all(opts.since, limit)
    : db.prepare(fallbackSql).all(limit)) as Array<Record<string, unknown>>
  return fallback.map((row, index) => mapMemory(row, 1 - index / Math.max(fallback.length, 1), ['recent']))
}

export function searchTimeline(
  db: Database.Database,
  opts: { query?: string; since?: string; until?: string; kind?: string; limit?: number } = {},
): TimelineEvent[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 80))
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.since) { clauses.push('occurred_at >= ?'); params.push(opts.since) }
  if (opts.until) { clauses.push('occurred_at <= ?'); params.push(opts.until) }
  if (opts.kind) { clauses.push('kind = ?'); params.push(opts.kind) }
  if (opts.query) {
    clauses.push('(title LIKE ? OR summary LIKE ? OR entities LIKE ?)')
    const like = `%${opts.query.replace(/[%_]/g, '')}%`
    params.push(like, like, like)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(limit)
  const rows = db.prepare(`
    SELECT id, occurred_at AS occurredAt, title, kind, summary, entities, memory_ids AS memoryIds, confidence, source
    FROM events ${where}
    ORDER BY occurred_at DESC, confidence DESC
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    occurredAt: row.occurredAt ? String(row.occurredAt) : null,
    title: String(row.title),
    kind: row.kind as TimelineEvent['kind'],
    summary: String(row.summary ?? ''),
    entities: parseJson<string[]>(String(row.entities ?? '[]'), []),
    memoryIds: parseJson<string[]>(String(row.memoryIds ?? '[]'), []),
    confidence: Number(row.confidence ?? 0),
    source: row.source === 'llm' ? 'llm' : 'heuristic',
  }))
}

export function listThemes(db: Database.Database): ThemeRecord[] {
  const rows = db.prepare(`
    SELECT id, slug, label, description, first_seen AS firstSeen, last_seen AS lastSeen,
      item_count AS itemCount, recent_count AS recentCount, previous_count AS previousCount,
      velocity, monthly, top_authors AS topAuthors
    FROM themes ORDER BY item_count DESC
  `).all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    label: String(row.label),
    description: String(row.description ?? ''),
    firstSeen: row.firstSeen ? String(row.firstSeen) : null,
    lastSeen: row.lastSeen ? String(row.lastSeen) : null,
    itemCount: Number(row.itemCount),
    recentCount: Number(row.recentCount),
    previousCount: Number(row.previousCount),
    velocity: Number(row.velocity),
    monthly: parseJson<Record<string, number>>(String(row.monthly ?? '{}'), {}),
    topAuthors: parseJson<Array<{ author: string; count: number }>>(String(row.topAuthors ?? '[]'), []),
  }))
}

export function listIdeas(db: Database.Database, kind?: IdeaKind): IdeaRecord[] {
  const rows = (kind
    ? db.prepare('SELECT * FROM ideas WHERE kind = ? ORDER BY novelty DESC, updated_at DESC').all(kind)
    : db.prepare('SELECT * FROM ideas ORDER BY novelty DESC, updated_at DESC').all()) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    kind: row.kind as IdeaKind,
    title: String(row.title),
    pitch: String(row.pitch),
    evidence: parseJson<string[]>(String(row.evidence ?? '[]'), []),
    novelty: Number(row.novelty ?? 0),
    status: String(row.status ?? 'seed'),
    source: row.source as IdeaRecord['source'],
  }))
}

export function getProfile(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT key, content FROM profile').all() as Array<{ key: string; content: string }>
  return Object.fromEntries(rows.map((row) => [row.key, row.content]))
}

export function citationsFromMemories(memories: RetrievedMemory[]): Citation[] {
  return memories.map((memory) => ({
    id: memory.id,
    title: memory.title,
    url: memory.url,
    sourceType: memory.sourceType,
    occurredAt: memory.occurredAt,
    author: memory.author,
  }))
}

export function packMemories(memories: RetrievedMemory[], max = 12, chars = 520): string {
  return memories.slice(0, max).map((memory, index) => {
    const kind = memory.sourceType === 'youtube' ? 'YouTube' : memory.sourceType === 'favorite' ? 'Web' : memory.sourceType === 'document' ? 'Doc' : 'X'
    const when = memory.occurredAt ? memory.occurredAt.slice(0, 10) : ''
    const body = memory.body.replace(/\s+/g, ' ').trim().slice(0, chars)
    return `[${index + 1}] (${kind}${when ? ` · ${when}` : ''}) ${memory.author ? `@${memory.author} — ` : ''}${memory.title}\n${body}${body.length >= chars ? '…' : ''}\nURL: ${memory.url ?? ''}`
  }).join('\n\n')
}

export async function briefForQuery(query: string, mode: AssistantMode, limit = 12) {
  const db = openAssistantDb()
  const memories = await searchMemories(db, query, { limit, mode })
  const themes = listThemes(db).slice(0, 8)
  const events = searchTimeline(db, {
    query: mode === 'timeline' ? query : undefined,
    since: mode === 'timeline' ? '2023-01-01' : undefined,
    limit: mode === 'timeline' ? 24 : 8,
  })
  const ideas = listIdeas(db, mode === 'novel' ? 'novel' : mode === 'project' ? 'project' : undefined).slice(0, 8)
  const profile = getProfile(db)
  return { memories, themes, events, ideas, profile, citations: citationsFromMemories(memories) }
}
