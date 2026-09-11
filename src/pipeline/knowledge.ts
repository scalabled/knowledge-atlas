import type Database from 'better-sqlite3'
import { embeddingBucket, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedText, cosineSimilarity } from '../lib/semantic'
import { parseJson, safeJson, stableId } from '../lib/hash'

interface KnowledgeStats {
  entities: number
  episodes: number
  claims: number
  embeddings: number
  semanticEdges: number
}

const ENTITY_TYPES = new Set(['topic', 'tag', 'author', 'domain', 'channel', 'collection', 'playlist', 'source'])
const CONTENT_TYPES = new Set(['bookmark', 'favorite', 'youtube', 'document'])
const EMBED_TYPES = new Set([...ENTITY_TYPES, ...CONTENT_TYPES])

/**
 * Materializes the semantic layer from the authoritative catalog graph. The
 * operation is atomic and deterministic.
 */
export function refreshKnowledgeLayer(db: Database.Database): KnowledgeStats {
  const stats: KnowledgeStats = { entities: 0, episodes: 0, claims: 0, embeddings: 0, semanticEdges: 0 }

  db.transaction(() => {
    db.exec(`
      DELETE FROM claim_evidence;
      DELETE FROM knowledge_claims;
      DELETE FROM entity_aliases;
      DELETE FROM entities;
      DELETE FROM knowledge_episodes;
      DELETE FROM embeddings WHERE model = '${EMBEDDING_MODEL}';
      DELETE FROM graph_edges WHERE type = 'semantic_similarity';
    `)

    const nodes = db.prepare('SELECT id,type,key,label,summary,metadata,weight FROM graph_nodes')
      .all() as Array<{ id: string; type: string; key: string; label: string; summary: string | null; metadata: string | null; weight: number }>
    const nodeById = new Map(nodes.map((node) => [node.id, node]))

    const insertEntity = db.prepare(`
      INSERT OR IGNORE INTO entities(id,entity_type,canonical_name,description,metadata)
      VALUES(?,?,?,?,?)
    `)
    const findEntity = db.prepare(`SELECT id FROM entities WHERE entity_type=? AND canonical_name=?`)
    const insertAlias = db.prepare(`INSERT OR IGNORE INTO entity_aliases(entity_id,alias,source,confidence) VALUES(?,?,?,?)`)
    const insertEmbedding = db.prepare(`
      INSERT INTO embeddings(owner_type,owner_id,model,dimensions,vector,bucket)
      VALUES('graph_node',?,?,?,?,?)
    `)

    const contentVectors = new Map<string, number[]>()
    const buckets = new Map<string, string[]>()
    for (const node of nodes) {
      if (ENTITY_TYPES.has(node.type)) {
        insertEntity.run(node.id, node.type, node.label, node.summary, node.metadata ?? '{}')
        const entityId = String((findEntity.get(node.type, node.label) as { id?: string } | undefined)?.id ?? node.id)
        insertAlias.run(entityId, node.label, 'graph-label', 1)
        if (node.key && node.key.toLowerCase() !== node.label.toLowerCase()) insertAlias.run(entityId, node.key, 'graph-key', 0.96)
        if (entityId === node.id) stats.entities++
      }

      if (!EMBED_TYPES.has(node.type)) continue
      const meta = parseJson<Record<string, unknown>>(node.metadata, {})
      const vector = embedText(`${node.label}\n${node.summary ?? ''}\n${safeJson(meta)}`)
      const bucket = embeddingBucket(vector)
      insertEmbedding.run(node.id, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, JSON.stringify(vector), bucket)
      stats.embeddings++
      if (CONTENT_TYPES.has(node.type)) {
        contentVectors.set(node.id, vector)
        const list = buckets.get(bucket) ?? []
        if (list.length < 96) list.push(node.id)
        buckets.set(bucket, list)
      }
    }

    const insertEpisode = db.prepare(`
      INSERT INTO knowledge_episodes(id,source_type,source_id,occurred_at,content,metadata)
      VALUES(?,?,?,?,?,?)
    `)
    for (const row of db.prepare(`SELECT id,text,tweet_created_at AS occurredAt,author_handle AS authorHandle,source FROM bookmarks`).all() as Array<Record<string, unknown>>) {
      insertEpisode.run(stableId('episode', `bookmark:${row.id}`), 'bookmark', row.id, row.occurredAt ?? null, String(row.text ?? ''), safeJson({ authorHandle: row.authorHandle, source: row.source }))
      stats.episodes++
    }
    for (const row of db.prepare(`SELECT id,title,description,published_at AS occurredAt,channel_name AS channelName FROM youtube_videos WHERE curation_status <> 'removed'`).all() as Array<Record<string, unknown>>) {
      insertEpisode.run(stableId('episode', `youtube:${row.id}`), 'youtube', row.id, row.occurredAt ?? null, `${row.title}\n${row.description ?? ''}`, safeJson({ channelName: row.channelName }))
      stats.episodes++
    }
    for (const row of db.prepare(`SELECT id,title,content_text AS contentText,doc_type AS docType,source_url AS sourceUrl FROM documents WHERE curation_status <> 'removed'`).all() as Array<Record<string, unknown>>) {
      insertEpisode.run(stableId('episode', `document:${row.id}`), 'document', row.id, null, `${row.title}\n${String(row.contentText ?? '').slice(0, 4000)}`, safeJson({ docType: row.docType, sourceUrl: row.sourceUrl }))
      stats.episodes++
    }

    const insertSemanticEdge = db.prepare(`
      INSERT OR IGNORE INTO graph_edges(id,source_id,target_id,type,weight,metadata)
      VALUES(?,?,?,'semantic_similarity',?,?)
    `)
    const seenPairs = new Set<string>()
    for (const ids of buckets.values()) {
      for (let i = 0; i < ids.length; i++) {
        const ranked: Array<{ id: string; score: number }> = []
        const a = ids[i]
        const av = contentVectors.get(a)!
        for (let j = 0; j < ids.length; j++) {
          if (i === j) continue
          const b = ids[j]
          const score = cosineSimilarity(av, contentVectors.get(b)!)
          if (score >= 0.62) ranked.push({ id: b, score })
        }
        ranked.sort((a, b) => b.score - a.score)
        for (const match of ranked.slice(0, 3)) {
          const [source, target] = a < match.id ? [a, match.id] : [match.id, a]
          const pair = `${source}::${target}`
          if (seenPairs.has(pair)) continue
          seenPairs.add(pair)
          insertSemanticEdge.run(stableId('edge', `${source}:semantic_similarity:${target}`), source, target, Number((match.score * 5).toFixed(3)), safeJson({ cosine: match.score, model: EMBEDDING_MODEL }))
          stats.semanticEdges++
        }
      }
    }

    const claimEdges = db.prepare(`
      SELECT source_id AS sourceId,target_id AS targetId,type,weight,metadata
      FROM graph_edges
      WHERE type IN ('has_topic','authored_by','published_by','links_domain','organized_in','saved_in','correlates_with','semantic_similarity')
    `).all() as Array<{ sourceId: string; targetId: string; type: string; weight: number; metadata: string | null }>
    const insertClaim = db.prepare(`
      INSERT INTO knowledge_claims(id,subject_type,subject_id,predicate,object_type,object_id,confidence,status,metadata)
      VALUES(?,?,?,?,?,?,?,'derived',?)
    `)
    const insertEvidence = db.prepare(`
      INSERT INTO claim_evidence(claim_id,source_type,source_id,excerpt,weight)
      VALUES(?,?,?,?,?)
    `)
    for (const edge of claimEdges) {
      const source = nodeById.get(edge.sourceId)
      const target = nodeById.get(edge.targetId)
      if (!source || !target) continue
      const claimId = stableId('claim', `${edge.sourceId}:${edge.type}:${edge.targetId}`)
      const confidence = edge.type === 'semantic_similarity'
        ? Math.min(0.99, Math.max(0, edge.weight / 5))
        : Math.min(0.99, Math.max(0.35, edge.weight > 1 ? 0.82 : edge.weight))
      insertClaim.run(claimId, source.type, source.id, edge.type, target.type, target.id, confidence, edge.metadata ?? '{}')
      const evidenceNode = CONTENT_TYPES.has(source.type) ? source : CONTENT_TYPES.has(target.type) ? target : null
      if (evidenceNode) insertEvidence.run(claimId, evidenceNode.type, evidenceNode.id, (evidenceNode.summary ?? evidenceNode.label).slice(0, 700), 1)
      stats.claims++
    }
  })()

  return stats
}
