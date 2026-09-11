import type Database from 'better-sqlite3'
import { stableHash } from '../lib/hash'
import type { CatalogItem, SourceType } from './types'

function splitList(value: string | null | undefined): string[] {
  if (!value) return []
  return value.split('|||').map((item) => item.trim()).filter(Boolean)
}

function firstLine(text: string, max = 140): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return '(untitled)'
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function firstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)]+/i)
  return match ? match[0].replace(/[.,;]+$/, '') : null
}

interface CatalogRow {
  sourceId: string
  sourceType: SourceType
  text: string
  author: string
  authorName: string
  occurredAt: string | null
  updatedAt: string | null
  tweetId?: string | null
  videoId?: string | null
  sourceUrl?: string | null
  topics: string
  tags: string
  extra: string
}

function mapRow(row: CatalogRow): CatalogItem {
  const topics = splitList(row.topics)
  const tags = splitList(row.tags)
  const extra = (row.extra ?? '').trim()
  const body = extra ? `${row.text}\n\n${extra}`.trim() : row.text
  const sourceType = row.sourceType
  const url = sourceType === 'youtube' && row.videoId
    ? `https://www.youtube.com/watch?v=${row.videoId}`
    : sourceType === 'x' && row.tweetId && row.author
      ? `https://x.com/${row.author}/status/${row.tweetId}`
      : row.sourceUrl || firstUrl(row.text)
  const graphNodeId = sourceType === 'youtube'
    ? `youtube:${row.sourceId}`
    : sourceType === 'document'
      ? `document:${row.sourceId}`
      : `bookmark:${row.sourceId}`
  return {
    sourceType,
    sourceId: row.sourceId,
    graphNodeId,
    url,
    occurredAt: row.occurredAt,
    updatedAt: row.updatedAt,
    title: firstLine(row.text),
    body: body.slice(0, 8000),
    author: row.author,
    authorName: row.authorName,
    topics,
    tags,
  }
}

export function catalogCounts(catalog: Database.Database): { x: number; favorites: number; youtube: number; documents: number } {
  const n = (sql: string) => (catalog.prepare(sql).get() as { n: number }).n
  return {
    x: n("SELECT COUNT(*) AS n FROM bookmarks WHERE source <> 'import' AND author_handle <> 'browser-favorites'"),
    favorites: n("SELECT COUNT(*) AS n FROM bookmarks WHERE source = 'import' OR author_handle = 'browser-favorites'"),
    youtube: n("SELECT COUNT(*) AS n FROM youtube_videos WHERE curation_status <> 'removed'"),
    documents: n("SELECT COUNT(*) AS n FROM documents WHERE curation_status <> 'removed'"),
  }
}

export function* iterateCatalog(catalog: Database.Database, opts: { limit?: number; since?: string } = {}): Generator<CatalogItem> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY
  let yielded = 0
  for (const item of iterateBookmarks(catalog, opts.since, 'x')) {
    yield item
    if (++yielded >= limit) return
  }
  for (const item of iterateBookmarks(catalog, opts.since, 'favorite')) {
    yield item
    if (++yielded >= limit) return
  }
  for (const item of iterateYouTube(catalog, opts.since)) {
    yield item
    if (++yielded >= limit) return
  }
  for (const item of iterateDocuments(catalog, opts.since)) {
    yield item
    if (++yielded >= limit) return
  }
}

function iterateBookmarks(catalog: Database.Database, since: string | undefined, kind: 'x' | 'favorite'): Generator<CatalogItem> {
  const filter = kind === 'favorite'
    ? "(b.source = 'import' OR b.author_handle = 'browser-favorites')"
    : "(b.source <> 'import' AND b.author_handle <> 'browser-favorites')"
  const sinceClause = since ? 'AND COALESCE(b.updated_at, b.imported_at, b.tweet_created_at) >= @since' : ''
  const stmt = catalog.prepare(`
    SELECT
      b.id AS sourceId,
      @kind AS sourceType,
      b.text AS text,
      b.author_handle AS author,
      b.author_name AS authorName,
      b.tweet_created_at AS occurredAt,
      b.updated_at AS updatedAt,
      b.tweet_id AS tweetId,
      NULL AS videoId,
      (
        SELECT COALESCE(l.expanded_url, l.canonical_url, l.url)
        FROM links l WHERE l.bookmark_id = b.id LIMIT 1
      ) AS sourceUrl,
      COALESCE((
        SELECT group_concat(t.slug, '|||')
        FROM bookmark_topics bt JOIN topics t ON t.id = bt.topic_id
        WHERE bt.bookmark_id = b.id
      ), '') AS topics,
      COALESCE((
        SELECT group_concat(tag, '|||') FROM bookmark_tags WHERE bookmark_id = b.id
      ), '') AS tags,
      COALESCE((
        SELECT group_concat(COALESCE(title, '') || ' ' || COALESCE(summary, ''), ' ')
        FROM links WHERE bookmark_id = b.id
      ), '') AS extra
    FROM bookmarks b
    WHERE ${filter}
      AND NOT EXISTS (
        SELECT 1 FROM curated_items ci
        WHERE ci.item_type = 'x' AND ci.item_id = b.id AND ci.status = 'removed'
      )
      ${sinceClause}
  `)
  return mapIterate(stmt.iterate({ kind, since: since ?? null }) as IterableIterator<CatalogRow>)
}

function iterateYouTube(catalog: Database.Database, since: string | undefined): Generator<CatalogItem> {
  const sinceClause = since ? 'AND COALESCE(y.updated_at, y.imported_at, y.published_at) >= @since' : ''
  const stmt = catalog.prepare(`
    SELECT
      y.id AS sourceId,
      'youtube' AS sourceType,
      y.title || CASE WHEN y.description IS NOT NULL AND y.description <> '' THEN char(10) || y.description ELSE '' END AS text,
      y.channel_name AS author,
      y.channel_name AS authorName,
      y.published_at AS occurredAt,
      y.updated_at AS updatedAt,
      NULL AS tweetId,
      y.video_id AS videoId,
      NULL AS sourceUrl,
      COALESCE((
        SELECT group_concat(t.slug, '|||')
        FROM youtube_video_topics yt JOIN topics t ON t.id = yt.topic_id
        WHERE yt.video_id = y.id
      ), '') AS topics,
      COALESCE((
        SELECT group_concat(tag, '|||') FROM youtube_video_tags WHERE video_id = y.id
      ), '') AS tags,
      COALESCE((
        SELECT group_concat(p.name, ' ')
        FROM youtube_playlist_items pi JOIN youtube_playlists p ON p.id = pi.playlist_id
        WHERE pi.video_id = y.id
      ), '') AS extra
    FROM youtube_videos y
    WHERE y.curation_status <> 'removed'
      ${sinceClause}
  `)
  return mapIterate(stmt.iterate({ since: since ?? null }) as IterableIterator<CatalogRow>)
}

function iterateDocuments(catalog: Database.Database, since: string | undefined): Generator<CatalogItem> {
  const sinceClause = since ? 'AND COALESCE(d.updated_at, d.ingested_at) >= @since' : ''
  const stmt = catalog.prepare(`
    SELECT
      d.id AS sourceId,
      'document' AS sourceType,
      d.title || char(10) || substr(COALESCE(d.content_text, d.summary, ''), 1, 6000) AS text,
      COALESCE(d.doc_type, 'document') AS author,
      COALESCE(d.doc_type, 'document') AS authorName,
      d.ingested_at AS occurredAt,
      d.updated_at AS updatedAt,
      NULL AS tweetId,
      NULL AS videoId,
      d.source_url AS sourceUrl,
      COALESCE((
        SELECT group_concat(t.slug, '|||')
        FROM document_topics dt JOIN topics t ON t.id = dt.topic_id
        WHERE dt.document_id = d.id
      ), '') AS topics,
      COALESCE((
        SELECT group_concat(tag, '|||') FROM document_tags WHERE document_id = d.id
      ), '') AS tags,
      COALESCE(d.summary, '') AS extra
    FROM documents d
    WHERE d.curation_status <> 'removed'
      ${sinceClause}
  `)
  return mapIterate(stmt.iterate({ since: since ?? null }) as IterableIterator<CatalogRow>)
}

function* mapIterate(rows: IterableIterator<CatalogRow>): Generator<CatalogItem> {
  for (const row of rows) yield mapRow(row)
}

export function contentHash(item: CatalogItem): string {
  return stableHash([
    item.sourceType,
    item.sourceId,
    item.title,
    item.body,
    item.topics.join(','),
    item.tags.join(','),
    item.url ?? '',
  ].join('\n'))
}

export function richness(item: CatalogItem): number {
  const body = Math.min(1, item.body.length / 900)
  const topics = Math.min(1, item.topics.length / 4)
  const tags = Math.min(1, item.tags.length / 12)
  const url = item.url ? 0.12 : 0
  return Math.max(0, Math.min(1, body * 0.5 + topics * 0.22 + tags * 0.16 + url))
}

export function memoryIdFor(item: Pick<CatalogItem, 'sourceType' | 'sourceId'>): string {
  return `${item.sourceType}:${item.sourceId}`
}
