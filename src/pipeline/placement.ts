import type Database from 'better-sqlite3'
import { parseEmbedding } from '../lib/semantic'
import { safeJson, stableId } from '../lib/hash'

// literal, not embedder's SEMANTIC_MODEL — importing embedder would load onnxruntime here
const MODEL = 'minilm-l6-v2'
const MAX_BUCKET = 96
const EDGE_MIN_COS = 0.55
const TOP_K = 3
const PLACE_K = 6
const PLACE_MIN_COS = 0.4
const PLACE_TYPES = ['bookmark', 'favorite', 'youtube', 'document']

export interface Placement { nodeId: string; cos: number; type: string }

export interface PlacementCandidate { nodeId: string; type: string; cos: number }

function toVector(value: unknown): Float32Array {
  if (value instanceof Uint8Array) {
    const bytes = value.byteOffset % 4 === 0 ? value : value.slice()
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  }
  return Float32Array.from(parseEmbedding(value))
}

/** Direct scan of stored MiniLM vectors — CLI-safe; the server passes vectorIndex results instead. */
export function scanCandidates(db: Database.Database, vector: Float32Array, types: string[]): PlacementCandidate[] {
  const rows = db.prepare(`
    SELECT e.owner_id AS nodeId, n.type, e.vector
    FROM embeddings e
    JOIN graph_nodes n ON n.id = e.owner_id
    WHERE e.owner_type = 'graph_node' AND e.model = ? AND n.type IN (${types.map(() => '?').join(',')})
  `).all(MODEL, ...types) as Array<{ nodeId: string; type: string; vector: unknown }>
  const candidates: PlacementCandidate[] = []
  for (const row of rows) {
    const stored = toVector(row.vector)
    const length = Math.min(vector.length, stored.length)
    let dot = 0
    for (let i = 0; i < length; i++) dot += vector[i] * stored[i]
    candidates.push({ nodeId: row.nodeId, type: row.type, cos: dot })
  }
  return candidates
}

/** semantic_similarity upserts — exact id scheme/weight/metadata of the offline builder. */
export function insertPlacementEdges(db: Database.Database, ownerId: string, placements: Placement[]): void {
  const stmt = db.prepare(`
    INSERT INTO graph_edges(id, source_id, target_id, type, weight, metadata)
    VALUES(?, ?, ?, 'semantic_similarity', ?, ?)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      weight = excluded.weight, metadata = excluded.metadata, updated_at = CURRENT_TIMESTAMP
  `)
  for (const placement of placements) {
    const [source, target] = ownerId < placement.nodeId ? [ownerId, placement.nodeId] : [placement.nodeId, ownerId]
    stmt.run(
      stableId('edge', `${source}:semantic_similarity:${target}`),
      source,
      target,
      Number((placement.cos * 5).toFixed(3)),
      safeJson({ cosine: placement.cos, model: MODEL, placedBy: 'ingest' }),
    )
  }
}

/** Rescue keyword-classifier misses: a document stuck on unsorted adopts a topic ≥3 of its
 *  neighbors share. Requires the documents row + graph node to already exist. */
export function applyNeighborTopicFallback(db: Database.Database, nodeId: string, placements: Placement[]): string | null {
  if (!nodeId.startsWith('document:') || placements.length < 3) return null
  const documentId = nodeId.slice('document:'.length)
  const assigned = db.prepare(`
    SELECT t.slug FROM document_topics dt JOIN topics t ON t.id = dt.topic_id WHERE dt.document_id = ?
  `).all(documentId) as Array<{ slug: string }>
  if (assigned.some((row) => row.slug !== 'unsorted')) return null
  const shared = db.prepare(`
    SELECT target_id AS topicNodeId, COUNT(DISTINCT source_id) AS neighbors
    FROM graph_edges
    WHERE type = 'has_topic' AND target_id <> 'topic:unsorted'
      AND source_id IN (${placements.map(() => '?').join(',')})
    GROUP BY target_id
    ORDER BY neighbors DESC, target_id
    LIMIT 1
  `).get(...placements.map((placement) => placement.nodeId)) as { topicNodeId: string; neighbors: number } | undefined
  if (!shared || shared.neighbors < 3) return null
  const slug = shared.topicNodeId.slice('topic:'.length)
  const topic = db.prepare('SELECT id FROM topics WHERE slug = ?').get(slug) as { id: string } | undefined
  if (!topic) return null
  db.prepare(`
    INSERT INTO document_topics(document_id, topic_id, confidence, rationale, source)
    VALUES(?, ?, 0.5, ?, 'semantic-neighbors')
    ON CONFLICT(document_id, topic_id) DO UPDATE SET
      confidence = excluded.confidence, rationale = excluded.rationale, updated_at = CURRENT_TIMESTAMP
  `).run(documentId, topic.id, `Shared by ${shared.neighbors} of ${placements.length} nearest neighbors.`)
  db.prepare(`
    INSERT INTO graph_edges(id, source_id, target_id, type, weight, metadata)
    VALUES(?, ?, ?, 'has_topic', 0.5, ?)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      weight = excluded.weight, metadata = excluded.metadata, updated_at = CURRENT_TIMESTAMP
  `).run(
    stableId('edge', `${nodeId}:has_topic:${shared.topicNodeId}`),
    nodeId,
    shared.topicNodeId,
    safeJson({ confidence: 0.5, source: 'semantic-neighbors' }),
  )
  return slug
}

/** k-NN over stored MiniLM vectors; pure math + SQL, no model load. When the owner node
 *  already exists its edges (+ topic fallback) are written here; pre-insert callers get the
 *  placements back and write the edges inside their own transaction. */
export function placeNode(db: Database.Database, ownerId: string, vector: Float32Array, opts: {
  k?: number
  minCos?: number
  types?: string[]
  candidates?: PlacementCandidate[]
} = {}): Placement[] {
  const k = opts.k ?? PLACE_K
  const minCos = opts.minCos ?? PLACE_MIN_COS
  const types = opts.types ?? PLACE_TYPES
  const allowed = new Set(types)
  const candidates = opts.candidates ?? scanCandidates(db, vector, types)
  const placements = candidates
    .filter((candidate) => candidate.nodeId !== ownerId && allowed.has(candidate.type) && candidate.cos >= minCos)
    .sort((a, b) => b.cos - a.cos)
    .slice(0, k)
    .map((candidate) => ({ nodeId: candidate.nodeId, cos: candidate.cos, type: candidate.type }))
  if (db.prepare('SELECT 1 FROM graph_nodes WHERE id = ?').get(ownerId)) {
    insertPlacementEdges(db, ownerId, placements)
    applyNeighborTopicFallback(db, ownerId, placements)
  }
  return placements
}

/** Growth primitive (Phase 4): centroid of the seeds → ranked k-NN frontier, seeds excluded. */
export function growRegion(db: Database.Database, seedNodeIds: string[], opts: { k?: number; minCos?: number } = {}): Placement[] {
  if (!seedNodeIds.length) return []
  const rows = db.prepare(`
    SELECT vector FROM embeddings
    WHERE owner_type = 'graph_node' AND model = ? AND owner_id IN (${seedNodeIds.map(() => '?').join(',')})
  `).all(MODEL, ...seedNodeIds) as Array<{ vector: unknown }>
  if (!rows.length) return []
  const first = toVector(rows[0].vector)
  const centroid = new Float32Array(first.length)
  for (const row of rows) {
    const vector = toVector(row.vector)
    for (let i = 0; i < centroid.length && i < vector.length; i++) centroid[i] += vector[i]
  }
  let sum = 0
  for (let i = 0; i < centroid.length; i++) sum += centroid[i] * centroid[i]
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0
  for (let i = 0; i < centroid.length; i++) centroid[i] *= scale
  const seeds = new Set(seedNodeIds)
  return scanCandidates(db, centroid, PLACE_TYPES)
    .filter((candidate) => !seeds.has(candidate.nodeId) && candidate.cos >= (opts.minCos ?? PLACE_MIN_COS))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, opts.k ?? 2 * PLACE_K)
}

/** Full refresh of semantic_similarity edges from STORED MiniLM vectors. Replaces the
 *  hash-quality edges refreshKnowledgeLayer just built; call it after that at rebuild tail. */
export function rebuildSemanticEdgesFromStored(db: Database.Database): { edges: number } {
  const rows = db.prepare(`
    SELECT e.owner_id AS id, COALESCE(e.bucket, '') AS bucket, e.vector
    FROM embeddings e
    JOIN graph_nodes n ON n.id = e.owner_id
    WHERE e.owner_type = 'graph_node' AND e.model = ?
  `).all(MODEL) as Array<{ id: string; bucket: string; vector: unknown }>

  const vectors = new Map<string, Float32Array>()
  const buckets = new Map<string, string[]>()
  for (const row of rows) {
    const parsed = parseEmbedding(row.vector)
    if (!parsed.length) continue
    vectors.set(row.id, Float32Array.from(parsed))
    const list = buckets.get(row.bucket) ?? []
    if (list.length < MAX_BUCKET) list.push(row.id)
    buckets.set(row.bucket, list)
  }

  const insertEdge = db.prepare(`
    INSERT INTO graph_edges(id, source_id, target_id, type, weight, metadata)
    VALUES(?, ?, ?, 'semantic_similarity', ?, ?)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET weight=excluded.weight, metadata=excluded.metadata
  `)

  let edges = 0
  db.transaction(() => {
    db.prepare(`DELETE FROM graph_edges WHERE type = 'semantic_similarity'`).run()
    const seenPairs = new Set<string>()
    for (const ids of buckets.values()) {
      for (let i = 0; i < ids.length; i++) {
        const av = vectors.get(ids[i])!
        const ranked: Array<{ id: string; cos: number }> = []
        for (let j = 0; j < ids.length; j++) {
          if (i === j) continue
          const bv = vectors.get(ids[j])!
          const length = Math.min(av.length, bv.length)
          let dot = 0
          for (let d = 0; d < length; d++) dot += av[d] * bv[d]
          if (dot >= EDGE_MIN_COS) ranked.push({ id: ids[j], cos: dot })
        }
        ranked.sort((a, b) => b.cos - a.cos)
        for (const match of ranked.slice(0, TOP_K)) {
          const [source, target] = ids[i] < match.id ? [ids[i], match.id] : [match.id, ids[i]]
          const pair = `${source}::${target}`
          if (seenPairs.has(pair)) continue
          seenPairs.add(pair)
          insertEdge.run(
            stableId('edge', `${source}:semantic_similarity:${target}`),
            source,
            target,
            Number((match.cos * 5).toFixed(3)),
            safeJson({ cosine: match.cos, model: MODEL }),
          )
          edges++
        }
      }
    }
  })()
  return { edges }
}
