import type Database from 'better-sqlite3'
import { embedDocument, embedTexts, SEMANTIC_DIMS, SEMANTIC_MODEL, vectorToBlob } from './embedder'
import { embeddingBucket, parseEmbedding } from '../lib/semantic'

const BATCH_SIZE = 32
const LONG_TEXT_CHARS = 1200

interface PendingNode {
  id: string
  type: string
  key: string
  label: string
  summary: string | null
}

export interface BackfillResult {
  model: string
  pending: number
  embedded: number
  chunked: number
  seconds: number
}

function textBuilder(db: Database.Database): (node: PendingNode) => string {
  const bookmark = db.prepare(`
    SELECT
      b.text,
      b.author_handle AS authorHandle,
      b.author_name AS authorName,
      COALESCE((
        SELECT group_concat(t.name, ' ')
        FROM bookmark_topics bt
        JOIN topics t ON t.id = bt.topic_id
        WHERE bt.bookmark_id = b.id
      ), '') AS topics,
      COALESCE((
        SELECT group_concat(tag, ' ')
        FROM bookmark_tags
        WHERE bookmark_id = b.id
      ), '') AS tags,
      COALESCE((
        SELECT group_concat(COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(description, ''), ' ')
        FROM links
        WHERE bookmark_id = b.id
      ), '') AS linkText,
      COALESCE((
        SELECT group_concat(COALESCE(image_summary, '') || ' ' || COALESCE(image_tags, ''), ' ')
        FROM media_items
        WHERE bookmark_id = b.id
      ), '') AS mediaText
    FROM bookmarks b
    WHERE b.id = ?
  `)
  // 32k transcript cap: chars past embedDocument's 32-chunk window never get embedded
  const youtube = db.prepare(`
    SELECT y.title, COALESCE(y.description, '') AS description, COALESCE(y.channel_name, '') AS channel,
      COALESCE(substr(y.transcript, 1, 32000), '') AS transcript
    FROM youtube_videos y
    WHERE y.id = ?
  `)
  const hasDocuments = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents'`).get())
  const document = hasDocuments
    ? db.prepare(`SELECT title, COALESCE(content_text, '') AS contentText FROM documents WHERE id = ?`)
    : null

  return (node) => {
    if (node.type === 'youtube') {
      const row = youtube.get(node.key) as { title: string; description: string; channel: string; transcript: string } | undefined
      if (row) return [row.title, row.description, row.channel, row.transcript].filter(Boolean).join('\n')
    } else if (node.type === 'document') {
      const row = document?.get(node.key) as { title: string; contentText: string } | undefined
      if (row) return [row.title, row.contentText].filter(Boolean).join('\n')
    } else {
      const row = bookmark.get(node.key) as {
        text: string
        authorHandle: string
        authorName: string
        topics: string
        tags: string
        linkText: string
        mediaText: string
      } | undefined
      if (row) return [row.text, `${row.authorName} @${row.authorHandle}`, row.topics, row.tags, row.linkText, row.mediaText].filter(Boolean).join('\n')
    }
    return [node.label, node.summary ?? ''].filter(Boolean).join('\n')
  }
}

export async function backfillEmbeddings(db: Database.Database, opts: { limit?: number; dtype?: 'fp32' | 'q8' } = {}): Promise<BackfillResult> {
  const dtype = opts.dtype ?? 'fp32'
  const limit = Math.floor(opts.limit ?? 0)
  const pending = db.prepare(`
    SELECT n.id, n.type, n.key, n.label, n.summary
    FROM graph_nodes n
    WHERE n.type IN ('bookmark', 'favorite', 'youtube', 'document')
      AND NOT EXISTS (
        SELECT 1 FROM embeddings e
        WHERE e.owner_type = 'graph_node' AND e.owner_id = n.id AND e.model = ?
      )
    ${limit > 0 ? `LIMIT ${limit}` : ''}
  `).all(SEMANTIC_MODEL) as PendingNode[]

  const started = Date.now()
  const result: BackfillResult = { model: SEMANTIC_MODEL, pending: pending.length, embedded: 0, chunked: 0, seconds: 0 }
  if (!pending.length) return result

  await embedTexts(['warmup'], dtype)
  const buildText = textBuilder(db)
  const upsert = db.prepare(`
    INSERT INTO embeddings(owner_type, owner_id, model, dimensions, vector, bucket)
    VALUES ('graph_node', ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET
      vector=excluded.vector, bucket=excluded.bucket, dimensions=excluded.dimensions, updated_at=CURRENT_TIMESTAMP
  `)
  const writeBatch = db.transaction((nodes: PendingNode[], vectors: Float32Array[]) => {
    for (let i = 0; i < nodes.length; i++) {
      upsert.run(nodes[i].id, SEMANTIC_MODEL, SEMANTIC_DIMS, vectorToBlob(vectors[i]), embeddingBucket(Array.from(vectors[i])))
    }
  })

  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE)
    const texts = batch.map((node) => buildText(node))
    const vectors: Array<Float32Array | null> = texts.map(() => null)
    const shortIndexes: number[] = []
    const shortTexts: string[] = []
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].length > LONG_TEXT_CHARS) continue
      shortIndexes.push(i)
      shortTexts.push(texts[i])
    }
    const shortVectors = await embedTexts(shortTexts, dtype)
    for (let i = 0; i < shortIndexes.length; i++) vectors[shortIndexes[i]] = shortVectors[i]
    for (let i = 0; i < texts.length; i++) {
      if (vectors[i]) continue
      vectors[i] = await embedDocument(texts[i])
      result.chunked++
    }
    writeBatch(batch, vectors as Float32Array[])
    result.embedded += batch.length
    if (result.embedded % 2048 === 0 || result.embedded === pending.length) {
      const rate = result.embedded / Math.max(0.001, (Date.now() - started) / 1000)
      console.log(`[embed] ${result.embedded}/${pending.length} (${rate.toFixed(0)}/s)`)
    }
  }
  result.seconds = Number(((Date.now() - started) / 1000).toFixed(1))
  return result
}

export interface EmbeddingReport {
  rows: number
  sampled: number
  top1: Record<string, number>
  top3: Record<string, number>
}

/** Top-1/top-3 neighbor cosine percentiles over a random sample — threshold tuning input. */
export function embeddingReport(db: Database.Database, sample = 500): EmbeddingReport | null {
  const rows = db.prepare(`SELECT vector FROM embeddings WHERE owner_type = 'graph_node' AND model = ?`)
    .all(SEMANTIC_MODEL) as Array<{ vector: unknown }>
  if (rows.length < 4) return null
  const matrix = new Float32Array(rows.length * SEMANTIC_DIMS)
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseEmbedding(rows[i].vector)
    for (let d = 0; d < SEMANTIC_DIMS && d < parsed.length; d++) matrix[i * SEMANTIC_DIMS + d] = parsed[d]
  }
  const picked = new Set<number>()
  while (picked.size < Math.min(sample, rows.length)) picked.add(Math.floor(Math.random() * rows.length))
  const top1: number[] = []
  const top3: number[] = []
  for (const i of picked) {
    const base = i * SEMANTIC_DIMS
    let first = -1
    let second = -1
    let third = -1
    for (let j = 0; j < rows.length; j++) {
      if (j === i) continue
      const offset = j * SEMANTIC_DIMS
      let dot = 0
      for (let d = 0; d < SEMANTIC_DIMS; d++) dot += matrix[base + d] * matrix[offset + d]
      if (dot <= third) continue
      if (dot > first) {
        third = second
        second = first
        first = dot
      } else if (dot > second) {
        third = second
        second = dot
      } else {
        third = dot
      }
    }
    top1.push(first)
    top3.push(third)
  }
  return { rows: rows.length, sampled: picked.size, top1: percentiles(top1), top3: percentiles(top3) }
}

function percentiles(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => Number(sorted[Math.round((p / 100) * (sorted.length - 1))].toFixed(4))
  return { p10: at(10), p25: at(25), p50: at(50), p75: at(75), p90: at(90) }
}
