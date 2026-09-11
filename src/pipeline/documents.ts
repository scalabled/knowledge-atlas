import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { config } from '../lib/env'
import { safeJson, stableId } from '../lib/hash'
import { embeddingBucket, parseEmbedding } from '../lib/semantic'
import { embedDocument, SEMANTIC_DIMS, SEMANTIC_MODEL, vectorToBlob } from './embedder'
import { classifyText, seedTopics } from './classifier'
import { detectDocType, extractText } from './extract-text'
import { applyNeighborTopicFallback, insertPlacementEdges, placeNode, type Placement } from './placement'

export interface DocumentRow {
  id: string
  doc_type: string
  title: string
  source_url: string | null
  local_path: string | null
  mime_type: string | null
  content_text: string
  summary: string | null
  page_count: number | null
  byte_size: number | null
  content_hash: string | null
  status: string
  error_message: string | null
  metadata: string
  curation_status: string
  ingested_at: string
  updated_at: string
}

export interface IngestInput {
  buffer?: Buffer
  filename?: string
  mimeType?: string
  url?: string
}

export interface IngestResult {
  document: DocumentRow
  nodeId: string
  created: boolean
  topics: string[]
  neighbors: Placement[]
  /** for vectorIndex.upsert post-commit; loaded from storage on dedup hits */
  vector: Float32Array | null
}

function getDocument(db: Database.Database, id: string): DocumentRow | undefined {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined
}

function existingResult(db: Database.Database, document: DocumentRow): IngestResult {
  const nodeId = `document:${document.id}`
  const topics = (db.prepare(`
    SELECT t.slug FROM document_topics dt JOIN topics t ON t.id = dt.topic_id WHERE dt.document_id = ?
  `).all(document.id) as Array<{ slug: string }>).map((row) => row.slug)
  const neighbors = (db.prepare(`
    SELECT n.id AS nodeId, n.type, e.weight
    FROM graph_edges e
    JOIN graph_nodes n ON n.id = CASE WHEN e.source_id = @nodeId THEN e.target_id ELSE e.source_id END
    WHERE e.type = 'semantic_similarity' AND (e.source_id = @nodeId OR e.target_id = @nodeId)
    ORDER BY e.weight DESC
  `).all({ nodeId }) as Array<{ nodeId: string; type: string; weight: number }>)
    .map((row) => ({ nodeId: row.nodeId, type: row.type, cos: row.weight / 5 }))
  const stored = db.prepare(`
    SELECT vector FROM embeddings WHERE owner_type = 'graph_node' AND owner_id = ? AND model = ?
  `).get(nodeId, SEMANTIC_MODEL) as { vector: unknown } | undefined
  const parsed = stored ? parseEmbedding(stored.vector) : []
  return { document, nodeId, created: false, topics, neighbors, vector: parsed.length ? Float32Array.from(parsed) : null }
}

export async function ingestDocument(db: Database.Database, input: IngestInput): Promise<IngestResult> {
  const canonicalUrl = input.url?.trim() || null
  if (!input.buffer && !canonicalUrl) throw new Error('ingestDocument needs a file buffer or a url')
  const contentHash = crypto.createHash('sha1').update(input.buffer ?? canonicalUrl!).digest('hex')
  const docId = `doc:${contentHash.slice(0, 16)}`
  const nodeId = `document:${docId}`

  const already = db.prepare('SELECT * FROM documents WHERE content_hash = ? OR id = ?')
    .get(contentHash, docId) as DocumentRow | undefined
  if (already) return existingResult(db, already)

  const docType = detectDocType(input)
  let localPath: string | null = null
  if (input.buffer) {
    const dir = path.join(config.documentsDir, docId)
    fs.mkdirSync(dir, { recursive: true })
    const safeName = (path.basename(input.filename ?? '').replace(/[^\w.() -]+/g, '_') || 'document.txt').slice(0, 150)
    localPath = path.join(dir, safeName)
    fs.writeFileSync(localPath, input.buffer)
  }

  const extracted = await extractText(input)
  const stripped = extracted.text
  const contentText = docType === 'markdown' && input.buffer
    ? input.buffer.toString('utf8').replace(/^\uFEFF/, '')
    : stripped
  const compactTitle = extracted.title.replace(/\s+/g, ' ').trim() || 'Untitled document'

  seedTopics(db)
  const classified = classifyText({ text: `${compactTitle}\n${stripped.slice(0, 80_000)}` })
  const vector = await embedDocument(`${compactTitle}\n\n${stripped}`)
  const neighbors = placeNode(db, nodeId, vector)

  const summary = stripped.replace(/\s+/g, ' ').trim().slice(0, 280) || null
  let domain: string | null = null
  if (canonicalUrl) try { domain = new URL(canonicalUrl).hostname } catch { /* keep null */ }
  const metadata = {
    docType,
    sourceUrl: canonicalUrl,
    domain,
    byteSize: input.buffer?.byteLength ?? null,
    pageCount: extracted.pageCount ?? null,
    ...extracted.meta,
  }

  const topicRows = db.prepare('SELECT id, slug, name FROM topics').all() as Array<{ id: string; slug: string; name: string }>
  const topicBySlug = new Map(topicRows.map((row) => [row.slug, row]))
  const nodeExists = db.prepare('SELECT 1 FROM graph_nodes WHERE id = ?')
  const upsertNode = db.prepare(`
    INSERT INTO graph_nodes(id, type, key, label, summary, metadata, weight)
    VALUES (@id, @type, @key, @label, @summary, @metadata, @weight)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label, summary = excluded.summary, metadata = excluded.metadata,
      weight = excluded.weight, updated_at = CURRENT_TIMESTAMP
  `)
  const upsertEdge = db.prepare(`
    INSERT INTO graph_edges(id, source_id, target_id, type, weight, metadata)
    VALUES (@id, @sourceId, @targetId, @type, @weight, @metadata)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      weight = excluded.weight, metadata = excluded.metadata, updated_at = CURRENT_TIMESTAMP
  `)
  const addEdge = (sourceId: string, targetId: string, type: string, weight: number, meta: Record<string, unknown> = {}) =>
    upsertEdge.run({ id: stableId('edge', `${sourceId}:${type}:${targetId}`), sourceId, targetId, type, weight, metadata: safeJson(meta) })
  const insertTopic = db.prepare(`
    INSERT INTO document_topics(document_id, topic_id, confidence, rationale, source)
    VALUES (?, ?, ?, ?, 'local-rules')
    ON CONFLICT(document_id, topic_id) DO UPDATE SET
      confidence = excluded.confidence, rationale = excluded.rationale, updated_at = CURRENT_TIMESTAMP
  `)
  const insertTag = db.prepare(`
    INSERT INTO tags(tag, kind, count) VALUES (?, 'semantic', 0)
    ON CONFLICT(tag) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `)
  const insertDocumentTag = db.prepare(`
    INSERT INTO document_tags(document_id, tag, source, weight)
    VALUES (?, ?, 'semantic-local', ?)
    ON CONFLICT(document_id, tag, source) DO UPDATE SET weight = excluded.weight
  `)

  const label = compactTitle.length > 120 ? `${compactTitle.slice(0, 119)}…` : compactTitle
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO documents(id, doc_type, title, source_url, local_path, mime_type, content_text, summary,
        page_count, byte_size, content_hash, metadata)
      VALUES (@id, @docType, @title, @sourceUrl, @localPath, @mimeType, @contentText, @summary,
        @pageCount, @byteSize, @contentHash, @metadata)
    `).run({
      id: docId,
      docType,
      title: compactTitle,
      sourceUrl: canonicalUrl,
      localPath,
      mimeType: input.mimeType ?? null,
      contentText,
      summary,
      pageCount: extracted.pageCount ?? null,
      byteSize: input.buffer?.byteLength ?? null,
      contentHash,
      metadata: safeJson(metadata),
    })
    for (const assignment of classified.topics) {
      const topic = topicBySlug.get(assignment.slug)
      if (topic) insertTopic.run(docId, topic.id, assignment.confidence, assignment.rationale)
    }
    classified.tags.forEach((tag, index) => {
      insertTag.run(tag)
      insertDocumentTag.run(docId, tag, Math.max(0.2, 1 - index * 0.025))
    })

    upsertNode.run({
      id: 'source:documents',
      type: 'source',
      key: 'documents',
      label: 'Documents',
      summary: 'Ingested files and notes',
      metadata: safeJson({ color: '#a78bfa' }),
      weight: 7,
    })
    if (nodeExists.get('root:bookmarks')) addEdge('root:bookmarks', 'source:documents', 'contains_source', 10)
    upsertNode.run({ id: nodeId, type: 'document', key: docId, label, summary, metadata: safeJson(metadata), weight: 3 })
    addEdge(nodeId, 'source:documents', 'from_source', 1)
    for (const assignment of classified.topics) {
      if (topicBySlug.has(assignment.slug) && nodeExists.get(`topic:${assignment.slug}`)) {
        addEdge(nodeId, `topic:${assignment.slug}`, 'has_topic', assignment.confidence, { confidence: assignment.confidence })
      }
    }
    classified.tags.forEach((tag, index) => {
      if (nodeExists.get(`tag:${tag}`)) addEdge(nodeId, `tag:${tag}`, 'has_tag', Math.max(0.2, 1 - index * 0.025), { source: 'semantic-local' })
    })
    insertPlacementEdges(db, nodeId, neighbors)
    const fallbackSlug = applyNeighborTopicFallback(db, nodeId, neighbors)

    const slugs = [...new Set([...classified.topics.map((assignment) => assignment.slug), ...(fallbackSlug ? [fallbackSlug] : [])])]
    db.prepare('INSERT INTO document_fts(document_id, title, content, topics, tags) VALUES (?, ?, ?, ?, ?)').run(
      docId,
      compactTitle,
      stripped,
      slugs.map((slug) => topicBySlug.get(slug)?.name ?? slug).join(' '),
      classified.tags.join(' '),
    )

    db.prepare(`
      INSERT INTO embeddings(owner_type, owner_id, model, dimensions, vector, bucket)
      VALUES ('graph_node', ?, ?, ?, ?, ?)
      ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET
        vector=excluded.vector, bucket=excluded.bucket, dimensions=excluded.dimensions, updated_at=CURRENT_TIMESTAMP
    `).run(nodeId, SEMANTIC_MODEL, SEMANTIC_DIMS, vectorToBlob(vector), embeddingBucket(Array.from(vector)))

    db.prepare(`
      INSERT OR REPLACE INTO knowledge_episodes(id, source_type, source_id, occurred_at, content, metadata)
      VALUES (?, 'document', ?, NULL, ?, ?)
    `).run(
      stableId('episode', `document:${docId}`),
      docId,
      `${compactTitle}\n${stripped.slice(0, 4000)}`,
      safeJson({ docType, sourceUrl: canonicalUrl }),
    )

    return slugs
  })

  let topics: string[]
  try {
    topics = tx()
  } catch (error) {
    // concurrent duplicate: content_hash UNIQUE (or the derived PK) lost the race
    if (String((error as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
      const raced = db.prepare('SELECT * FROM documents WHERE content_hash = ? OR id = ?')
        .get(contentHash, docId) as DocumentRow | undefined
      if (raced) return existingResult(db, raced)
    }
    throw error
  }

  return { document: getDocument(db, docId)!, nodeId, created: true, topics, neighbors, vector }
}
