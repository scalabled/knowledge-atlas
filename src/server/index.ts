import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import multer from 'multer'
import path from 'node:path'
import { initDb, openDb } from '../lib/db'
import { config, rootDir } from '../lib/env'
import { parseJson, stableId } from '../lib/hash'
import { runCli, withGrokPromptFile } from '../lib/llm-cli'
import { parseEmbedding } from '../lib/semantic'
import type { GraphEdgeDto, GraphNodeDto, SearchResult } from '../lib/types'
import { buildFtsQuery, rebuildFts } from '../pipeline/store'
import { classifyYouTubeAll } from '../pipeline/classifier'
import { ingestDocument, type IngestResult } from '../pipeline/documents'
import { embedQuery, SEMANTIC_DIMS, SEMANTIC_MODEL } from '../pipeline/embedder'
import { rebuildGraph } from '../pipeline/graph'
import { fetchYouTubeTranscripts } from '../pipeline/youtube-transcripts'
import { createExploreHandler, invalidateExploreCaches } from './explore'
import {
  invalidateSecondBrainCaches,
  nodeIdForResult as secondBrainNodeId,
  runSecondBrain,
  type RankedResult,
  type SecondBrainSearchResult,
} from './second-brain'
import { vectorIndex } from './vector-index'
import { mountAssistant } from './assistant'

const app = express()
const db = openDb()
initDb(db)

app.use(cors({ origin: config.webOrigin }))
app.use(express.json({ limit: '2mb' }))
app.use('/thumbnails', express.static(config.youtubeThumbnailDir, { maxAge: '30d' }))

function count(sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count
}

function splitList(value: string | null | undefined): string[] {
  return value ? value.split('|||').map((item) => item.trim()).filter(Boolean) : []
}

function mapXRows(rows: Array<Record<string, unknown>>): SearchResult[] {
  return rows.map((row) => {
    const authorHandle = String(row.authorHandle ?? '')
    const isFavorite = String(row.source ?? '') === 'import' || authorHandle === 'browser-favorites'
    const domains = splitList(String(row.domains ?? ''))
    const linkUrl = row.linkUrl ? String(row.linkUrl) : null
    return {
      id: String(row.id),
      itemType: isFavorite ? 'favorite' as const : 'x' as const,
      tweetId: String(row.tweetId),
      text: String(row.text ?? ''),
      title: isFavorite ? String(row.text ?? '').split('\n')[0] : undefined,
      authorHandle,
      authorName: isFavorite ? (domains[0] || 'Browser Favorite') : String(row.authorName ?? ''),
      tweetCreatedAt: row.tweetCreatedAt ? String(row.tweetCreatedAt) : null,
      topics: splitList(String(row.topics ?? '')),
      tags: splitList(String(row.tags ?? '')),
      domains,
      mediaTypes: splitList(String(row.mediaTypes ?? '')),
      score: Number(row.score ?? 0),
      url: linkUrl || (isFavorite ? undefined : `https://x.com/${authorHandle}/status/${String(row.tweetId)}`),
    }
  })
}

function mapYouTubeRows(rows: Array<Record<string, unknown>>): SearchResult[] {
  return rows.map((row) => ({
    id: String(row.id), itemType: 'youtube', tweetId: String(row.videoId), title: String(row.title ?? ''),
    text: String(row.description || row.title || ''), authorHandle: String(row.channelName ?? ''),
    authorName: String(row.channelName ?? ''), tweetCreatedAt: row.publishedAt ? String(row.publishedAt) : null,
    topics: splitList(String(row.topics ?? '')), tags: splitList(String(row.tags ?? '')), domains: ['youtube.com'],
    mediaTypes: ['video'], score: Number(row.score ?? 0),
    url: `https://www.youtube.com/watch?v=${String(row.videoId)}`,
    thumbnailUrl: row.localThumbnailPath ? `/thumbnails/${path.basename(String(row.localThumbnailPath))}` : (row.thumbnailUrl ? String(row.thumbnailUrl) : null),
    durationSeconds: row.durationSeconds == null ? null : Number(row.durationSeconds),
    transcriptStatus: String(row.transcriptStatus ?? 'pending'), playlists: splitList(String(row.playlists ?? '')),
  }))
}

/** Handles from @user in the query (underscores kept). */
function extractHandles(query: string): string[] {
  const found = query.match(/@([A-Za-z0-9_]{2,40})/g) ?? []
  return [...new Set(found.map((h) => h.slice(1).toLowerCase()))]
}

/** Multi-word phrases in quotes (straight/smart double or single) for tighter FTS matching. */
function extractQuotedPhrases(query: string): string[] {
  const phrases: string[] = []
  const patterns = [
    /["“]([^"”]{3,80})["”]/g,
    /'([^']{3,80})'/g,
    /‘([^’]{3,80})’/g,
  ]
  for (const re of patterns) {
    let match: RegExpExecArray | null
    while ((match = re.exec(query))) {
      const cleaned = match[1].replace(/\s+/g, ' ').trim()
      if (cleaned && !phrases.includes(cleaned)) phrases.push(cleaned)
    }
  }
  return phrases
}

function searchX(query: string, limit: number, sourceFilter: 'all' | 'x' | 'web' = 'all'): SearchResult[] {
  const ftsQuery = buildFtsQuery(query)
  const sourceClause = sourceFilter === 'web'
    ? "AND (b.source = 'import' OR b.author_handle = 'browser-favorites')"
    : sourceFilter === 'x'
      ? "AND b.source <> 'import' AND b.author_handle <> 'browser-favorites'"
      : ''
  const notRemoved = `AND NOT EXISTS (SELECT 1 FROM curated_items ci WHERE ci.item_type='x' AND ci.item_id=b.id AND ci.status='removed')`
  const base = `
    SELECT b.id, b.tweet_id AS tweetId, b.text, b.author_handle AS authorHandle, b.author_name AS authorName,
      b.tweet_created_at AS tweetCreatedAt, b.source,
      COALESCE((SELECT group_concat(t.name, '|||') FROM bookmark_topics bt JOIN topics t ON t.id = bt.topic_id WHERE bt.bookmark_id = b.id), '') AS topics,
      COALESCE((SELECT group_concat(tag, '|||') FROM bookmark_tags WHERE bookmark_id = b.id), '') AS tags,
      COALESCE((SELECT group_concat(domain, '|||') FROM (SELECT DISTINCT domain FROM links WHERE bookmark_id = b.id AND domain IS NOT NULL)), '') AS domains,
      COALESCE((SELECT group_concat(type, '|||') FROM (SELECT DISTINCT type FROM media_items WHERE bookmark_id = b.id)), '') AS mediaTypes,
      (SELECT COALESCE(canonical_url, expanded_url, url) FROM links WHERE bookmark_id = b.id ORDER BY created_at LIMIT 1) AS linkUrl
  `
  const byId = new Map<string, SearchResult>()
  const addRows = (rows: Array<Record<string, unknown>>) => {
    for (const result of mapXRows(rows)) {
      if (!byId.has(result.id)) byId.set(result.id, result)
    }
  }

  if (ftsQuery) {
    addRows(db.prepare(`${base}, bm25(bookmark_fts) AS score FROM bookmark_fts JOIN bookmarks b ON b.id = bookmark_fts.bookmark_id
      WHERE bookmark_fts MATCH ? ${sourceClause} ${notRemoved} ORDER BY score LIMIT ?`).all(ftsQuery, limit) as Array<Record<string, unknown>>)
  } else {
    addRows(db.prepare(`${base}, 0 AS score FROM bookmarks b WHERE 1=1 ${notRemoved} ${sourceClause}
      ORDER BY COALESCE(b.tweet_created_at,b.imported_at) DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>)
  }

  // Phrase boost: "Claude of Duty" style queries often fail as bag-of-words OR
  for (const phrase of extractQuotedPhrases(query).slice(0, 3)) {
    const phraseFts = `"${phrase.toLowerCase().replace(/"/g, '""')}"`
    try {
      addRows(db.prepare(`${base}, bm25(bookmark_fts) AS score FROM bookmark_fts JOIN bookmarks b ON b.id = bookmark_fts.bookmark_id
        WHERE bookmark_fts MATCH ? ${sourceClause} ${notRemoved} ORDER BY score LIMIT ?`).all(phraseFts, Math.min(limit, 24)) as Array<Record<string, unknown>>)
    } catch { /* invalid phrase token — ignore */ }
  }

  // Author boost: @mattshumer_ should pull that author's posts, not just token "mattshumer"
  const handles = extractHandles(query)
  if (handles.length && sourceFilter !== 'web') {
    for (const handle of handles.slice(0, 4)) {
      const variants = [handle, handle.endsWith('_') ? handle.slice(0, -1) : `${handle}_`]
      for (const variant of variants) {
        addRows(db.prepare(`${base}, 0 AS score FROM bookmarks b
          WHERE lower(b.author_handle) = lower(?) ${sourceClause} ${notRemoved}
          ORDER BY COALESCE(b.tweet_created_at, b.imported_at) DESC LIMIT ?`).all(variant, Math.min(limit, 40)) as Array<Record<string, unknown>>)
      }
      // Also match handle mentioned in body (retweets / "based on @user")
      addRows(db.prepare(`${base}, 0 AS score FROM bookmarks b
        WHERE (b.text LIKE ? OR b.text LIKE ?) ${sourceClause} ${notRemoved}
        ORDER BY COALESCE(b.tweet_created_at, b.imported_at) DESC LIMIT ?`).all(
        `%@${handle}%`,
        `%@${handle.endsWith('_') ? handle.slice(0, -1) : handle}%`,
        Math.min(limit, 20),
      ) as Array<Record<string, unknown>>)
    }
  }

  return [...byId.values()].slice(0, Math.max(limit, handles.length ? Math.min(limit * 2, 80) : limit))
}

function mapDocumentRows(rows: Array<Record<string, unknown>>): SearchResult[] {
  return rows.map((row) => ({
    id: String(row.id), itemType: 'document' as const, tweetId: String(row.id), title: String(row.title ?? ''),
    text: String(row.contentText || row.summary || row.title || '').slice(0, 2000),
    authorHandle: 'documents', authorName: String(row.docType ?? 'document'),
    tweetCreatedAt: row.ingestedAt ? String(row.ingestedAt) : null,
    topics: splitList(String(row.topics ?? '')), tags: splitList(String(row.tags ?? '')),
    domains: [], mediaTypes: [], score: Number(row.score ?? 0),
    url: row.sourceUrl ? String(row.sourceUrl) : `/api/documents/${String(row.id)}/file`,
  }))
}

function searchDocuments(query: string, limit: number): SearchResult[] {
  const ftsQuery = buildFtsQuery(query)
  const base = `
    SELECT d.id, d.title, d.summary, d.content_text AS contentText, d.doc_type AS docType,
      d.source_url AS sourceUrl, d.ingested_at AS ingestedAt,
      COALESCE((SELECT group_concat(t.name, '|||') FROM document_topics dt JOIN topics t ON t.id=dt.topic_id WHERE dt.document_id=d.id), '') AS topics,
      COALESCE((SELECT group_concat(tag, '|||') FROM document_tags WHERE document_id=d.id), '') AS tags
  `
  const rows = ftsQuery ? db.prepare(`${base}, bm25(document_fts) AS score FROM document_fts JOIN documents d ON d.id=document_fts.document_id
      WHERE document_fts MATCH ? AND d.curation_status <> 'removed' ORDER BY score LIMIT ?`).all(ftsQuery, limit)
    : db.prepare(`${base}, 0 AS score FROM documents d WHERE d.curation_status <> 'removed' ORDER BY d.ingested_at DESC LIMIT ?`).all(limit)
  return mapDocumentRows(rows as Array<Record<string, unknown>>)
}

function searchYouTube(query: string, limit: number): SearchResult[] {
  const ftsQuery = buildFtsQuery(query)
  const base = `
    SELECT y.id, y.video_id AS videoId, y.title, y.description, y.channel_name AS channelName,
      y.published_at AS publishedAt, y.duration_seconds AS durationSeconds, y.thumbnail_url AS thumbnailUrl,
      y.local_thumbnail_path AS localThumbnailPath, y.transcript_status AS transcriptStatus,
      COALESCE((SELECT group_concat(t.name, '|||') FROM youtube_video_topics yt JOIN topics t ON t.id=yt.topic_id WHERE yt.video_id=y.id), '') AS topics,
      COALESCE((SELECT group_concat(tag, '|||') FROM youtube_video_tags WHERE video_id=y.id), '') AS tags,
      COALESCE((SELECT group_concat(p.name, '|||') FROM youtube_playlist_items pi JOIN youtube_playlists p ON p.id=pi.playlist_id WHERE pi.video_id=y.id), '') AS playlists
  `
  const rows = ftsQuery ? db.prepare(`${base}, bm25(youtube_fts) AS score FROM youtube_fts JOIN youtube_videos y ON y.id=youtube_fts.video_id
      WHERE youtube_fts MATCH ? AND y.curation_status <> 'removed' ORDER BY score LIMIT ?`).all(ftsQuery, limit)
    : db.prepare(`${base}, 0 AS score FROM youtube_videos y WHERE y.curation_status <> 'removed' ORDER BY y.imported_at DESC LIMIT ?`).all(limit)
  return mapYouTubeRows(rows as Array<Record<string, unknown>>)
}

async function semanticSearch(query: string, limit: number, source = 'all'): Promise<SearchResult[]> {
  if (!query.trim()) return []
  vectorIndex.ensureLoaded(db)
  const queryVector = await embedQuery(query)
  const allowed = source === 'youtube' ? new Set(['youtube'])
    : source === 'web' ? new Set(['favorite'])
      : source === 'x' ? new Set(['bookmark'])
        : source === 'docs' ? new Set(['document'])
          : new Set(['bookmark', 'favorite', 'youtube', 'document'])
  const ranked = vectorIndex.search(queryVector, { types: allowed, limit: limit * 2, minCos: 0.3 })
  const scores = new Map(ranked.map((row) => [row.nodeId, row.cos]))
  return resultsFromNodeIds(ranked.map((row) => row.nodeId), limit).map((result) => {
    const semanticScore = scores.get(nodeIdForResult(result)) ?? 0
    return { ...result, semanticScore, score: -semanticScore }
  }).sort((a, b) => a.score - b.score)
}

/** Round-robin by per-source rank — concatenation would peg every later source's items to the worst lexical rank. */
function interleaveByRank(lists: SearchResult[][]): SearchResult[] {
  const merged: SearchResult[] = []
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (i < list.length) merged.push(list[i])
  }
  return merged
}

/**
 * Hybrid find + second-brain evaluate/MMR.
 * Collects a wide lexical+semantic pool, then multi-signal ranks and diversifies.
 */
async function searchItems(query: string, limit: number, source = 'all'): Promise<SearchResult[]> {
  const pool = Math.max(limit * 3, 48)
  const lexical = source === 'x' || source === 'web' ? searchX(query, pool, source)
    : source === 'youtube' ? searchYouTube(query, pool)
      : source === 'docs' ? searchDocuments(query, pool)
        : interleaveByRank([
          searchX(query, Math.max(16, Math.ceil(pool * 0.45)), 'all'),
          searchYouTube(query, Math.max(12, Math.ceil(pool * 0.35))),
          searchDocuments(query, Math.max(8, Math.ceil(pool * 0.2))),
        ])
  if (!query.trim()) {
    return lexical
      .sort((a, b) => String(b.tweetCreatedAt ?? '').localeCompare(String(a.tweetCreatedAt ?? '')))
      .slice(0, limit)
  }

  const semantic = await semanticSearch(query, pool, source)
  const merged = new Map<string, SearchResult & { lexicalRank?: number; semanticRank?: number }>()
  lexical.forEach((result, index) => {
    const id = nodeIdForResult(result)
    merged.set(id, {
      ...result,
      lexicalRank: (index + 1) / Math.max(lexical.length, 1),
      score: (index + 1) / Math.max(lexical.length, 1),
    })
  })
  semantic.forEach((result, index) => {
    const id = nodeIdForResult(result)
    const existing = merged.get(id)
    const semanticRank = (index + 1) / Math.max(semantic.length, 1)
    merged.set(id, existing
      ? { ...existing, semanticScore: result.semanticScore, semanticRank }
      : { ...result, semanticRank, lexicalRank: undefined })
  })

  const brain = runSecondBrain(db, query, [...merged.values()], limit)
  return brain.results.map(stripRanked)
}

function stripRanked(result: RankedResult): SearchResult {
  const { nodeId: _nodeId, ...rest } = result
  return rest
}

function nodeIdForResult(result: SearchResult): string {
  return secondBrainNodeId(result)
}

/** Full second-brain payload (concepts, bridges, expanded terms) for explore/search UI. */
async function searchSecondBrain(query: string, limit: number, source = 'all'): Promise<SecondBrainSearchResult> {
  const pool = Math.max(limit * 3, 48)
  const lexical = source === 'x' || source === 'web' ? searchX(query, pool, source)
    : source === 'youtube' ? searchYouTube(query, pool)
      : source === 'docs' ? searchDocuments(query, pool)
        : interleaveByRank([
          searchX(query, Math.max(16, Math.ceil(pool * 0.45)), 'all'),
          searchYouTube(query, Math.max(12, Math.ceil(pool * 0.35))),
          searchDocuments(query, Math.max(8, Math.ceil(pool * 0.2))),
        ])
  if (!query.trim()) {
    const results: RankedResult[] = lexical.slice(0, limit).map((result, index) => ({
      ...result,
      nodeId: nodeIdForResult(result),
      rankScore: 1 - index / Math.max(limit, 1),
      score: index / Math.max(limit, 1),
      scoreBreakdown: {
        lexical: 0, semantic: 0, recency: 1, centrality: 0, richness: 0, concept: 0, diversity: 1,
        composite: 1 - index / Math.max(limit, 1),
      },
      why: ['recent'],
    }))
    return {
      query,
      expandedTerms: [],
      results,
      concepts: [],
      bridges: [],
      total: results.length,
    }
  }
  const semantic = await semanticSearch(query, pool, source)
  const merged = new Map<string, SearchResult & { lexicalRank?: number; semanticRank?: number }>()
  lexical.forEach((result, index) => {
    merged.set(nodeIdForResult(result), {
      ...result,
      lexicalRank: (index + 1) / Math.max(lexical.length, 1),
    })
  })
  semantic.forEach((result, index) => {
    const id = nodeIdForResult(result)
    const existing = merged.get(id)
    const semanticRank = (index + 1) / Math.max(semantic.length, 1)
    merged.set(id, existing
      ? { ...existing, semanticScore: result.semanticScore, semanticRank }
      : { ...result, semanticRank })
  })
  return runSecondBrain(db, query, [...merged.values()], limit)
}

function resultsFromNodeIds(nodeIds: Iterable<string>, limit: number): SearchResult[] {
  // Callers pass ranked ids — slice before type-grouping or x rows crowd every later type out of the limit
  const ids = [...nodeIds].slice(0, limit)
  const xIds = ids.filter((id) => id.startsWith('bookmark:')).map((id) => id.slice(9))
  const ytIds = ids.filter((id) => id.startsWith('youtube:')).map((id) => id.slice(8))
  const docIds = ids.filter((id) => id.startsWith('document:')).map((id) => id.slice(9))
  const results: SearchResult[] = []
  if (xIds.length) {
    const placeholders = xIds.map(() => '?').join(',')
    const rows = db.prepare(`SELECT b.id,b.tweet_id AS tweetId,b.text,b.author_handle AS authorHandle,b.author_name AS authorName,b.tweet_created_at AS tweetCreatedAt,b.source,
      COALESCE((SELECT group_concat(domain,'|||') FROM (SELECT DISTINCT domain FROM links WHERE bookmark_id=b.id AND domain IS NOT NULL)),'') AS domains,
      (SELECT COALESCE(canonical_url,expanded_url,url) FROM links WHERE bookmark_id=b.id ORDER BY created_at LIMIT 1) AS linkUrl,
      '' AS topics,'' AS tags,'' AS mediaTypes,0 AS score FROM bookmarks b WHERE b.id IN (${placeholders}) LIMIT ?`).all(...xIds, limit)
    results.push(...mapXRows(rows as Array<Record<string, unknown>>))
  }
  if (ytIds.length) {
    const placeholders = ytIds.map(() => '?').join(',')
    const rows = db.prepare(`SELECT y.id,y.video_id AS videoId,y.title,y.description,y.channel_name AS channelName,y.published_at AS publishedAt,
      y.duration_seconds AS durationSeconds,y.thumbnail_url AS thumbnailUrl,y.local_thumbnail_path AS localThumbnailPath,y.transcript_status AS transcriptStatus,
      '' AS topics,'' AS tags,'' AS playlists,0 AS score FROM youtube_videos y WHERE y.id IN (${placeholders}) LIMIT ?`).all(...ytIds, limit)
    results.push(...mapYouTubeRows(rows as Array<Record<string, unknown>>))
  }
  if (docIds.length) {
    const placeholders = docIds.map(() => '?').join(',')
    const rows = db.prepare(`SELECT d.id,d.title,d.summary,d.content_text AS contentText,d.doc_type AS docType,d.source_url AS sourceUrl,d.ingested_at AS ingestedAt,
      '' AS topics,'' AS tags,0 AS score FROM documents d WHERE d.id IN (${placeholders}) LIMIT ?`).all(...docIds, limit)
    results.push(...mapDocumentRows(rows as Array<Record<string, unknown>>))
  }
  return results.slice(0, limit)
}

function loadNodes(ids: Set<string>): GraphNodeDto[] {
  if (!ids.size) return []
  const placeholders = [...ids].map(() => '?').join(',')
  const rows = db.prepare(`SELECT gn.id,gn.type,gn.label,gn.summary,gn.metadata,gn.weight,e.vector AS embedding
    FROM graph_nodes gn LEFT JOIN embeddings e ON e.owner_type='graph_node' AND e.owner_id=gn.id AND e.model = 'atlas-hash-32-v1'
    WHERE gn.id IN (${placeholders})`).all(...ids) as Array<Record<string, any>>
  return rows.map((row) => ({ id: row.id, type: row.type, label: row.label, summary: row.summary, weight: row.weight,
    metadata: { ...parseJson(row.metadata, {}), ...(row.embedding ? { embedding: parseEmbedding(row.embedding) } : {}) } }))
}

function mapEdges(rows: Array<Record<string, any>>): GraphEdgeDto[] {
  return rows.map((row) => ({ id: row.id, source: row.source_id, target: row.target_id, type: row.type, weight: row.weight, metadata: parseJson(row.metadata, {}) }))
}

async function graphForSearch(query: string, limit: number, source: string) {
  const results = await searchItems(query, Math.min(limit, 140), source)
  const seedIds = results.map(nodeIdForResult)
  if (!seedIds.length) return { nodes: [], edges: [], results }
  const placeholders = seedIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id,source_id,target_id,type,weight,metadata FROM graph_edges
    WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders}) ORDER BY weight DESC LIMIT 1800`).all(...seedIds, ...seedIds) as Array<Record<string, any>>
  const ids = new Set(seedIds)
  for (const row of rows) { ids.add(row.source_id); ids.add(row.target_id) }
  return { nodes: loadNodes(ids), edges: mapEdges(rows), results }
}

function graphForNode(nodeId: string, depth: number, options: { grow?: boolean; focusTypes?: string[] } = {}) {
  const maxNodes = options.grow ? 1800 : 1200
  const maxDepth = Math.max(1, Math.min(depth, options.grow ? 4 : 3))
  const visited = new Set([nodeId])
  const frontier = new Set([nodeId])
  const edgeMap = new Map<string, Record<string, any>>()
  const focusBoost = new Set(['correlates_with', 'has_tag', 'has_topic', 'references_link', 'links_domain', 'hosted_on', 'organized_in', 'saved_in', 'published_by', 'authored_by'])

  for (let d = 0; d < maxDepth; d++) {
    const ids = [...frontier]; frontier.clear()
    if (!ids.length) break
    const placeholders = ids.map(() => '?').join(',')
    // Prefer correlation + concept edges so exploration surfaces related knowledge first
    const rows = db.prepare(`
      SELECT id, source_id, target_id, type, weight, metadata
      FROM graph_edges
      WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
      ORDER BY
        CASE type
          WHEN 'correlates_with' THEN 0
          WHEN 'has_tag' THEN 1
          WHEN 'has_topic' THEN 1
          WHEN 'references_link' THEN 2
          WHEN 'organized_in' THEN 2
          ELSE 3
        END ASC,
        weight DESC
      LIMIT ?
    `).all(...ids, ...ids, options.grow ? 1600 : 1200) as Array<Record<string, any>>

    for (const row of rows) {
      edgeMap.set(row.id, row)
      for (const id of [row.source_id, row.target_id]) {
        if (visited.has(id) || visited.size >= maxNodes) continue
        // On deeper hops, keep growing through high-signal relationship types
        if (d > 0 && options.grow && !focusBoost.has(row.type) && !id.startsWith('tag:') && !id.startsWith('topic:') && !id.startsWith('domain:') && !id.startsWith('collection:')) {
          continue
        }
        visited.add(id)
        frontier.add(id)
      }
    }
  }

  // Auto-expand key focus hubs around the selected node (top tags/topics/domains)
  if (options.grow || depth >= 2) {
    const conceptIds = [...visited].filter((id) => id.startsWith('tag:') || id.startsWith('topic:') || id.startsWith('domain:') || id.startsWith('collection:')).slice(0, 40)
    if (conceptIds.length) {
      const placeholders = conceptIds.map(() => '?').join(',')
      const hubRows = db.prepare(`
        SELECT id, source_id, target_id, type, weight, metadata FROM graph_edges
        WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
          AND (source_id LIKE 'bookmark:%' OR target_id LIKE 'bookmark:%' OR source_id LIKE 'youtube:%' OR target_id LIKE 'youtube:%' OR type = 'correlates_with')
        ORDER BY weight DESC LIMIT 500
      `).all(...conceptIds, ...conceptIds) as Array<Record<string, any>>
      for (const row of hubRows) {
        edgeMap.set(row.id, row)
        for (const id of [row.source_id, row.target_id]) {
          if (!visited.has(id) && visited.size < maxNodes) visited.add(id)
        }
      }
    }
  }

  return {
    nodes: loadNodes(visited),
    edges: mapEdges([...edgeMap.values()]),
    results: resultsFromNodeIds(visited, 120),
    focus: nodeId,
    depth: maxDepth,
    grown: Boolean(options.grow),
  }
}

function overviewGraph() {
  const ids = new Set<string>(['root:bookmarks', 'source:x', 'source:web', 'source:youtube'])
  for (const [type, limit] of [['topic', 30], ['tag', 100], ['domain', 40], ['author', 30], ['channel', 30], ['playlist', 12], ['collection', 40], ['favorite', 40]] as Array<[string, number]>) {
    for (const row of db.prepare('SELECT id FROM graph_nodes WHERE type=? ORDER BY weight DESC LIMIT ?').all(type, limit) as Array<{ id: string }>) ids.add(row.id)
  }
  const concepts = [...ids]
  const placeholders = concepts.map(() => '?').join(',')
  if (placeholders) {
    const rows = db.prepare(`SELECT DISTINCT CASE WHEN source_id LIKE 'bookmark:%' OR source_id LIKE 'youtube:%' THEN source_id ELSE target_id END AS id
      FROM graph_edges WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
      AND (source_id LIKE 'bookmark:%' OR target_id LIKE 'bookmark:%' OR source_id LIKE 'youtube:%' OR target_id LIKE 'youtube:%') LIMIT 220`).all(...concepts, ...concepts) as Array<{ id: string }>
    for (const row of rows) if (row.id) ids.add(row.id)
  }
  const all = [...ids], ph = all.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id,source_id,target_id,type,weight,metadata FROM graph_edges
    WHERE source_id='root:bookmarks' OR (source_id IN (${ph}) AND target_id IN (${ph})) ORDER BY weight DESC LIMIT 2200`).all(...all, ...all) as Array<Record<string, any>>
  for (const row of rows) { ids.add(row.source_id); ids.add(row.target_id) }
  return { nodes: loadNodes(ids), edges: mapEdges(rows), results: resultsFromNodeIds(ids, 100) }
}

/** Grok Build CLI headless Q&A — prompt via file so long library context stays off argv. */
async function runGrokAsk(prompt: string, timeoutMs = 180_000): Promise<string> {
  // Hard rules first: models sometimes invent "prompt was truncated" and try to load tools.
  const body = `SYSTEM RULES (mandatory):
1. The library context in this message is COMPLETE. It is not truncated, partial, or missing a continuation.
2. Do NOT say the prompt was truncated. Do NOT offer to "load the full message", re-read files, or continue context.
3. Do NOT use tools, search the web, or read files — tools are disabled and there is nothing else to load.
4. Answer ONLY from the LIBRARY CONTEXT section below. Cite items as [1], [2], …
5. If nothing matches the question, say so clearly and list the closest items with why they fall short.
6. Prefer Markdown (short headings, bullets, bold). Be concise.

${prompt}

<<<END OF COMPLETE LIBRARY CONTEXT — answer now>>>`
  return withGrokPromptFile(body, [
    '--output-format', 'plain',
    '--no-plan',
    '--disable-web-search',
    '--max-turns', '12',
    // Empty allowlist: no tools available, so the model must answer from context.
    '--tools', '',
  ], timeoutMs)
}

/** Compact, bounded context so the model never hits mid-context cutoff hallucinations. */
function buildAskLibraryPrompt(question: string, hits: SearchResult[], concepts: { label: string; count: number }[], bridges: { label: string }[]): string {
  const MAX_ITEMS = 16
  const MAX_CHARS = 700
  const selected = hits.slice(0, MAX_ITEMS)
  const context = selected.map((hit, index) => {
    const kind = hit.itemType === 'youtube' ? 'YouTube' : hit.itemType === 'document' ? 'Document' : hit.itemType === 'favorite' ? 'Web' : 'X'
    const title = (hit.title || hit.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const body = (hit.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS)
    const author = hit.authorHandle ? `@${hit.authorHandle}` : hit.authorName
    const why = hit.why?.length ? ` | why: ${hit.why.slice(0, 3).join(', ')}` : ''
    return `[${index + 1}] (${kind}) ${author} — ${title}${why}\n${body}${body.length >= MAX_CHARS ? '…' : ''}\nURL: ${hit.url ?? ''}`
  }).join('\n\n')
  const conceptLine = concepts.length
    ? `Concept clusters in retrieval: ${concepts.map((c) => `${c.label} (${c.count})`).join('; ')}`
    : ''
  const bridgeLine = bridges.length
    ? `Bridge items: ${bridges.slice(0, 5).map((b) => b.label.slice(0, 60)).join(' | ')}`
    : ''
  return `You are answering from a personal second-brain knowledge graph (local bookmarks / favorites / YouTube).

QUESTION:
${question}

${conceptLine}
${bridgeLine}

LIBRARY CONTEXT (${selected.length} items — complete set, not a sample that continues later):
${context || '(no items retrieved)'}

INSTRUCTIONS:
- Prefer items that match named people (@handles), exact phrases in the question, and concrete claims.
- Cite supporting item numbers like [1].
- If the exact post is not present, say "not in this library" and show closest neighbors — do not invent bookmarks.`
}

/**
 * Follow-up research with Grok: allow web_search + web_fetch (incl. X/Twitter hits via web).
 * Input is the already-rendered library answer; output is Markdown with links.
 */
async function runGrokRelatedResearch(input: {
  question: string
  answer: string
}, timeoutMs = 240_000): Promise<string> {
  const body = `You are expanding a personal knowledge-library answer with live research.

Use tools freely:
1. web_search — find related web articles, papers, docs, and X/Twitter posts (include queries like site:x.com or site:twitter.com, plus open web queries).
2. web_fetch — open the most promising URLs for a sentence of detail when needed.

Do NOT edit files or run shell commands. Stay focused on related posts and web results.

Original question:
${input.question || '(none)'}

Library answer to expand from (use this as the seed for search queries — extract key entities, claims, and themes):
${input.answer.slice(0, 12000)}

Write a Markdown report with these sections:

## Related X posts
- Bullet list of recent/high-signal posts (author, short paraphrase, link if available)
- Prefer x.com / twitter.com URLs

## Web results
- Bullet list of articles, docs, papers, or products with title, one-line why it matters, and URL

## Connections
- 3–6 bullets tying these finds back to themes in the library answer

Keep it dense and useful. Prefer real URLs from tool results over invented ones.`

  return withGrokPromptFile(body, [
    '--output-format', 'plain',
    '--no-plan',
    '--max-turns', '24',
    '--tools', 'web_search,web_fetch',
    // Non-interactive tool approval for headless research
    '--always-approve',
  ], timeoutMs)
}

app.get('/api/stats', (_req, res) => res.json({
  bookmarks: count("SELECT COUNT(*) AS count FROM bookmarks WHERE source <> 'import' AND author_handle <> 'browser-favorites'"),
  favorites: count("SELECT COUNT(*) AS count FROM bookmarks WHERE source = 'import' OR author_handle = 'browser-favorites'"),
  youtubeVideos: count("SELECT COUNT(*) AS count FROM youtube_videos WHERE curation_status<>'removed'"),
  youtubePlaylists: count('SELECT COUNT(*) AS count FROM youtube_playlists'), youtubeTranscripts: count("SELECT COUNT(*) AS count FROM youtube_videos WHERE transcript_status='fetched'"),
  authors: count('SELECT COUNT(*) AS count FROM authors'), media: count('SELECT COUNT(*) AS count FROM media_items'), links: count('SELECT COUNT(*) AS count FROM links'),
  fetchedLinks: count("SELECT COUNT(*) AS count FROM links WHERE status IN ('fetched','summarized')"), summarizedLinks: count("SELECT COUNT(*) AS count FROM links WHERE status='summarized'"),
  pendingLinks: count("SELECT COUNT(*) AS count FROM links WHERE status IN ('pending','error')"),
  topics: count('SELECT COUNT(*) AS count FROM topics'), tags: count('SELECT COUNT(*) AS count FROM tags'), graphNodes: count('SELECT COUNT(*) AS count FROM graph_nodes'), graphEdges: count('SELECT COUNT(*) AS count FROM graph_edges'),
  correlations: count("SELECT COUNT(*) AS count FROM graph_edges WHERE type = 'correlates_with'"),
  semanticEdges: count("SELECT COUNT(*) AS count FROM graph_edges WHERE type = 'semantic_similarity'"),
  embeddings: count("SELECT COUNT(*) AS count FROM embeddings"),
  claims: count("SELECT COUNT(*) AS count FROM knowledge_claims"),
  documents: count("SELECT COUNT(*) AS count FROM documents WHERE curation_status<>'removed'"),
}))

let embedWarm = false

app.get('/api/embed/status', (_req, res) => res.json({
  model: SEMANTIC_MODEL,
  dims: SEMANTIC_DIMS,
  rows: {
    minilm: count("SELECT COUNT(*) AS count FROM embeddings WHERE model = 'minilm-l6-v2'"),
    hash: count("SELECT COUNT(*) AS count FROM embeddings WHERE model = 'atlas-hash-32-v1'"),
  },
  indexLoaded: vectorIndex.isLoaded(),
  warm: embedWarm,
}))

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? ''), source = String(req.query.source ?? 'all')
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 80), 240))
  if (String(req.query.mode ?? '') === 'second-brain' || String(req.query.brain ?? '') === '1') {
    const brain = await searchSecondBrain(q, limit, source)
    return res.json({ source, mode: 'second-brain', ...brain })
  }
  res.json({ query: q, source, results: await searchItems(q, limit, source) })
})

app.get('/api/explore', createExploreHandler(db, {
  searchItems,
  searchSecondBrain: async (query, limit, source) => searchSecondBrain(query, limit, source ?? 'all'),
}))

app.get('/api/graph', async (req, res) => {
  const q = String(req.query.q ?? '').trim(), node = String(req.query.node ?? '').trim(), source = String(req.query.source ?? 'all')
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 100), 180))
  const depth = Math.max(1, Math.min(Number(req.query.depth ?? 1), 4))
  const grow = String(req.query.grow ?? '') === '1' || String(req.query.grow ?? '') === 'true'
  res.json(node ? graphForNode(node, depth, { grow }) : (q || source !== 'all') ? await graphForSearch(q, limit, source) : overviewGraph())
})

/** Expand around a focused node — used by the UI to auto-grow the visible information space. */
app.get('/api/graph/expand', (req, res) => {
  const node = String(req.query.node ?? '').trim()
  if (!node) return res.status(400).json({ error: 'node is required' })
  const depth = Math.max(1, Math.min(Number(req.query.depth ?? 2), 4))
  res.json(graphForNode(node, depth, { grow: true }))
})

app.get('/api/items/:type/:id', (req, res) => {
  if (req.params.type === 'document') {
    const row = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id) as Record<string, unknown> | undefined
    if (!row) return res.status(404).json({ error: 'Document not found' })
    const nodeId = `document:${row.id}`
    const topics = db.prepare(`SELECT t.*,dt.confidence,dt.rationale FROM document_topics dt JOIN topics t ON t.id=dt.topic_id WHERE dt.document_id=?`).all(row.id)
    const tags = db.prepare('SELECT * FROM document_tags WHERE document_id=? ORDER BY weight DESC').all(row.id)
    const neighbors = db.prepare(`SELECT n.id AS nodeId,n.type,n.label,e.weight FROM graph_edges e
      JOIN graph_nodes n ON n.id = CASE WHEN e.source_id=@nodeId THEN e.target_id ELSE e.source_id END
      WHERE e.type='semantic_similarity' AND (e.source_id=@nodeId OR e.target_id=@nodeId) ORDER BY e.weight DESC LIMIT 24`).all({ nodeId })
    return res.json({ ...row, topics, tags, neighbors })
  }
  if (req.params.type === 'youtube') {
    const row = db.prepare(`SELECT * FROM youtube_videos WHERE id=? OR video_id=?`).get(req.params.id, req.params.id) as Record<string, unknown> | undefined
    if (!row) return res.status(404).json({ error: 'Video not found' })
    const playlists = db.prepare(`SELECT p.*,pi.position FROM youtube_playlist_items pi JOIN youtube_playlists p ON p.id=pi.playlist_id WHERE pi.video_id=?`).all(row.id)
    const topics = db.prepare(`SELECT t.*,yt.confidence,yt.rationale FROM youtube_video_topics yt JOIN topics t ON t.id=yt.topic_id WHERE yt.video_id=?`).all(row.id)
    const tags = db.prepare('SELECT * FROM youtube_video_tags WHERE video_id=? ORDER BY weight DESC').all(row.id)
    return res.json({ ...row, playlists, topics, tags })
  }
  const row = db.prepare(`SELECT id,tweet_id AS tweetId,text,author_handle AS authorHandle,author_name AS authorName,tweet_created_at AS tweetCreatedAt FROM bookmarks WHERE id=? OR tweet_id=?`).get(req.params.id, req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Bookmark not found' })
  res.json({ ...row, links: db.prepare('SELECT * FROM links WHERE bookmark_id=?').all(row.id), media: db.prepare('SELECT * FROM media_items WHERE bookmark_id=?').all(row.id) })
})

app.post('/api/youtube/transcripts', async (req, res) => {
  const videoIds = Array.isArray(req.body?.videoIds) ? req.body.videoIds.map(String).slice(0, 100) : []
  if (!videoIds.length) return res.status(400).json({ error: 'Select at least one YouTube video' })
  try {
    const result = await fetchYouTubeTranscripts(db, videoIds, typeof req.body.language === 'string' ? req.body.language : undefined)
    classifyYouTubeAll(db); rebuildGraph(db); vectorIndex.invalidate(); invalidateDerivedCaches()
    res.json(result)
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }) }
})

/** Explore dust/arc/edge caches aggregate tables every ingest and rebuild mutates. */
function invalidateDerivedCaches() {
  invalidateExploreCaches()
}

interface IngestedSummary { id: string; nodeId: string; title: string; docType: string; topics: string[]; neighbors: IngestResult['neighbors']; created: boolean }

function summarizeIngest(result: IngestResult): IngestedSummary {
  if (result.vector) vectorIndex.upsert(result.nodeId, 'document', result.vector)
  return {
    id: result.document.id, nodeId: result.nodeId, title: result.document.title,
    docType: result.document.doc_type, topics: result.topics, neighbors: result.neighbors, created: result.created,
  }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { files: 25, fileSize: 50 * 1024 * 1024 } })

app.post('/api/ingest', upload.array('files', 25), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? []
  if (!files.length) return res.status(400).json({ error: 'Attach at least one file in the files field' })
  const ingested: IngestedSummary[] = []
  const errors: Array<{ filename: string; error: string }> = []
  for (const file of files) {
    try {
      ingested.push(summarizeIngest(await ingestDocument(db, { buffer: file.buffer, filename: file.originalname, mimeType: file.mimetype })))
    } catch (error) {
      errors.push({ filename: file.originalname, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (ingested.length) invalidateDerivedCaches()
  res.json({ ingested, errors })
})

app.post('/api/ingest/url', async (req, res) => {
  const url = String(req.body?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Provide an http(s) URL' })
  try {
    const summary = summarizeIngest(await ingestDocument(db, { url }))
    invalidateDerivedCaches()
    res.json({ ingested: [summary], errors: [] })
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }) }
})

app.get('/api/documents/:id/file', (req, res) => {
  const row = db.prepare('SELECT local_path AS localPath FROM documents WHERE id=?').get(req.params.id) as { localPath: string | null } | undefined
  if (!row?.localPath || !fs.existsSync(row.localPath)) return res.status(404).json({ error: 'No stored file for this document' })
  res.sendFile(path.resolve(rootDir, row.localPath))
})

/** Ensure a collection has a graph node without rebuilding the whole graph. */
function upsertCollectionNode(id: string, name: string, description: string, color: string) {
  db.prepare(`INSERT INTO graph_nodes(id,type,key,label,summary,metadata,weight) VALUES(?,?,?,?,?,?,3)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label,summary=excluded.summary,metadata=excluded.metadata,updated_at=CURRENT_TIMESTAMP`)
    .run(`collection:${id}`, 'collection', id, name, description || null, JSON.stringify({ color }))
  db.prepare(`INSERT INTO graph_edges(id,source_id,target_id,type,weight,metadata) VALUES(?,?,?,?,2,'{}')
    ON CONFLICT(source_id,target_id,type) DO UPDATE SET updated_at=CURRENT_TIMESTAMP`)
    .run(stableId('edge', `root:bookmarks:contains_collection:collection:${id}`), 'root:bookmarks', `collection:${id}`, 'contains_collection')
}

app.get('/api/collections', (_req, res) => res.json(db.prepare(`SELECT c.*,COUNT(ci.item_id) AS itemCount FROM collections c LEFT JOIN collection_items ci ON ci.collection_id=c.id GROUP BY c.id ORDER BY c.name`).all()))
app.post('/api/collections', (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Collection name is required' })
  const id = stableId('collection', name.toLowerCase())
  const description = String(req.body?.description ?? ''), color = String(req.body?.color ?? '#14b8a6')
  db.prepare(`INSERT INTO collections(id,name,description,color) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET description=excluded.description,color=excluded.color,updated_at=CURRENT_TIMESTAMP`)
    .run(id, name, description, color)
  upsertCollectionNode(id, name, description, color)
  res.json({ id, name })
})
app.post('/api/collections/:id/items', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : []
  const collection = db.prepare('SELECT id,name,description,color FROM collections WHERE id=?').get(req.params.id) as { id: string; name: string; description: string | null; color: string } | undefined
  if (!collection) return res.status(404).json({ error: 'Collection not found' })
  const insert = db.prepare(`INSERT OR REPLACE INTO collection_items(collection_id,item_type,item_id,note) VALUES(?,?,?,?)`)
  const addEdge = db.prepare(`INSERT INTO graph_edges(id,source_id,target_id,type,weight,metadata) VALUES(?,?,?,'organized_in',1,?)
    ON CONFLICT(source_id,target_id,type) DO UPDATE SET metadata=excluded.metadata,updated_at=CURRENT_TIMESTAMP`)
  const nodeExists = db.prepare('SELECT 1 FROM graph_nodes WHERE id=?')
  db.transaction(() => {
    upsertCollectionNode(collection.id, collection.name, collection.description ?? '', collection.color)
    for (const item of items) {
      const itemId = String(item.id), itemType = String(item.itemType)
      insert.run(req.params.id, itemType, itemId, item.note ? String(item.note) : null)
      const nodeId = itemType === 'youtube' ? `youtube:${itemId}` : `bookmark:${itemId}`
      if (nodeExists.get(nodeId)) {
        addEdge.run(stableId('edge', `${nodeId}:organized_in:collection:${collection.id}`), nodeId, `collection:${collection.id}`, JSON.stringify({ note: item.note ?? null }))
      }
    }
  })()
  res.json({ added: items.length })
})

app.post('/api/curation', (req, res) => {
  const itemType = String(req.body?.itemType ?? ''), id = String(req.body?.id ?? ''), status = String(req.body?.status ?? 'active')
  if (!['x', 'youtube'].includes(itemType) || !id || !['active', 'archived', 'removed'].includes(status)) return res.status(400).json({ error: 'Invalid curation update' })
  db.prepare(`INSERT INTO curated_items(item_type,item_id,status,note) VALUES(?,?,?,?) ON CONFLICT(item_type,item_id) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=CURRENT_TIMESTAMP`)
    .run(itemType, id, status, req.body?.note ? String(req.body.note) : null)
  if (itemType === 'youtube') db.prepare('UPDATE youtube_videos SET curation_status=?,curation_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, req.body?.note ?? null, id)
  // Targeted graph update instead of a full rebuild: hide the node now; pipeline rebuilds stay authoritative
  const nodeId = itemType === 'youtube' ? `youtube:${id}` : `bookmark:${id}`
  if (status === 'active') {
    // Restoring visibility requires the pipeline rebuild; report that honestly
    return res.json({ ok: true, itemType, id, status, note: 'Run graph:build to restore this item to the graph' })
  }
  db.prepare('DELETE FROM graph_nodes WHERE id=?').run(nodeId)
  invalidateExploreCaches()
  invalidateSecondBrainCaches()
  res.json({ ok: true, itemType, id, status })
})

app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim(), provider = String(req.body?.provider ?? 'claude')
  if (!question) return res.status(400).json({ error: 'Question is required' })
  // Wider pool when handles are present so author posts survive MMR
  const handleBoost = extractHandles(question).length > 0
  const retrieveLimit = handleBoost ? 36 : 24
  const brain = await searchSecondBrain(question, retrieveLimit, String(req.body?.source ?? 'all'))
  // Present a compact, complete pack to the model (avoids "truncated mid-context" confabulation)
  const hits = brain.results.slice(0, 16)
  const prompt = buildAskLibraryPrompt(
    question,
    hits,
    brain.concepts.map((c) => ({ label: c.label, count: c.count })),
    brain.bridges.map((b) => ({ label: b.label })),
  )
  try {
    const normalized = provider === 'grok' || provider === 'grok-build' ? 'grok'
      : provider === 'codex' ? 'codex'
        : 'claude'
    const answer = normalized === 'grok'
      ? await runGrokAsk(prompt)
      : normalized === 'codex'
        ? await runCli('codex', [
          'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-C', rootDir, '-',
        ], `${prompt}\n\n<<<END OF COMPLETE LIBRARY CONTEXT — answer now>>>`)
        : await runCli('claude', [
          '-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'text',
        ], `${prompt}\n\n<<<END OF COMPLETE LIBRARY CONTEXT — answer now>>>`)
    res.json({ answer, provider: normalized, sources: hits, concepts: brain.concepts, bridges: brain.bridges })
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }) }
})

/** Expand an existing library answer with live X + web research via Grok Build tools. */
mountAssistant(app)

app.post('/api/ask/related', async (req, res) => {
  const answer = String(req.body?.answer ?? '').trim()
  const question = String(req.body?.question ?? '').trim()
  if (!answer) return res.status(400).json({ error: 'answer is required (use the rendered library response)' })
  try {
    const related = await runGrokRelatedResearch({ question, answer })
    res.json({ related, provider: 'grok' })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

const dist = path.resolve(rootDir, 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  // Never SPA-fallback API/thumbnail routes — a HTML index here shows up as
  // `Unexpected token '<'` when the client calls response.json().
  app.get(/^(?!\/api(?:\/|$)|\/thumbnails(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'))
  })
}

// Last-resort JSON errors for /api/* so proxies never get an empty/HTML body on failures
app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api]', err)
  if (res.headersSent) return
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

app.listen(config.apiPort, '127.0.0.1', () => console.log(`[api] http://127.0.0.1:${config.apiPort}`))
void embedQuery('warmup').then(() => { embedWarm = true }, (error) => console.error('[embed] warmup failed:', error))
