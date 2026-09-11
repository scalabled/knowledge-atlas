import type Database from 'better-sqlite3'
import { safeJson, stableId } from '../lib/hash'
import type { ImportStats, NormalizedBookmark } from '../lib/types'

const EMPTY_STATS: ImportStats = { imported: 0, updated: 0, duplicates: 0, skipped: 0 }

function normalizeTag(value: string): string {
  return value.trim().toLowerCase().replace(/^#/, '').slice(0, 80)
}

function addTag(db: Database.Database, bookmarkId: string, tag: string, source: string, weight = 1): void {
  const normalized = normalizeTag(tag)
  if (!normalized || normalized.length < 2) return

  db.prepare(`
    INSERT INTO tags(tag, kind, count)
    VALUES (?, ?, 0)
    ON CONFLICT(tag) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(normalized, source)

  db.prepare(`
    INSERT INTO bookmark_tags(bookmark_id, tag, source, weight)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bookmark_id, tag, source) DO UPDATE SET
      weight = excluded.weight
  `).run(bookmarkId, normalized, source, weight)
}

export function upsertBookmark(db: Database.Database, bookmark: NormalizedBookmark): ImportStats {
  const stats = { ...EMPTY_STATS }
  if (!bookmark.tweetId || !bookmark.text.trim()) {
    stats.skipped = 1
    return stats
  }

  const existing = db.prepare(`
    SELECT id, text, raw_json AS rawJson FROM bookmarks WHERE tweet_id = ?
  `).get(bookmark.tweetId) as { id: string; text: string; rawJson: string } | undefined

  db.prepare(`
    INSERT INTO authors(id, handle, name, profile_image_url, metadata)
    VALUES (@id, @handle, @name, @profileImageUrl, @metadata)
    ON CONFLICT(handle) DO UPDATE SET
      name = excluded.name,
      profile_image_url = COALESCE(excluded.profile_image_url, authors.profile_image_url),
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id: bookmark.author.id,
    handle: bookmark.author.handle,
    name: bookmark.author.name,
    profileImageUrl: bookmark.author.profileImageUrl ?? null,
    metadata: bookmark.author.metadata ? safeJson(bookmark.author.metadata) : null,
  })

  db.prepare(`
    INSERT INTO bookmarks(
      id, tweet_id, text, author_id, author_handle, author_name, tweet_created_at,
      raw_json, source, language, conversation_id, in_reply_to_tweet_id,
      quoted_tweet_id, retweeted_tweet_id
    )
    VALUES (
      @id, @tweetId, @text, @authorId, @authorHandle, @authorName, @tweetCreatedAt,
      @rawJson, @source, @language, @conversationId, @inReplyToTweetId,
      @quotedTweetId, @retweetedTweetId
    )
    ON CONFLICT(tweet_id) DO UPDATE SET
      text = excluded.text,
      author_id = excluded.author_id,
      author_handle = excluded.author_handle,
      author_name = excluded.author_name,
      tweet_created_at = COALESCE(excluded.tweet_created_at, bookmarks.tweet_created_at),
      raw_json = excluded.raw_json,
      source = excluded.source,
      language = COALESCE(excluded.language, bookmarks.language),
      conversation_id = COALESCE(excluded.conversation_id, bookmarks.conversation_id),
      in_reply_to_tweet_id = COALESCE(excluded.in_reply_to_tweet_id, bookmarks.in_reply_to_tweet_id),
      quoted_tweet_id = COALESCE(excluded.quoted_tweet_id, bookmarks.quoted_tweet_id),
      retweeted_tweet_id = COALESCE(excluded.retweeted_tweet_id, bookmarks.retweeted_tweet_id),
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id: bookmark.id,
    tweetId: bookmark.tweetId,
    text: bookmark.text,
    authorId: bookmark.author.id,
    authorHandle: bookmark.author.handle,
    authorName: bookmark.author.name,
    tweetCreatedAt: bookmark.tweetCreatedAt ?? null,
    rawJson: bookmark.rawJson,
    source: bookmark.source,
    language: bookmark.language ?? null,
    conversationId: bookmark.conversationId ?? null,
    inReplyToTweetId: bookmark.inReplyToTweetId ?? null,
    quotedTweetId: bookmark.quotedTweetId ?? null,
    retweetedTweetId: bookmark.retweetedTweetId ?? null,
  })

  if (!existing) {
    stats.imported = 1
  } else if (existing.text !== bookmark.text || existing.rawJson !== bookmark.rawJson) {
    stats.updated = 1
  } else {
    stats.duplicates = 1
  }

  for (const media of bookmark.media) {
    db.prepare(`
      INSERT INTO media_items(
        id, bookmark_id, type, url, thumbnail_url, alt_text, width, height, duration_ms
      )
      VALUES (@id, @bookmarkId, @type, @url, @thumbnailUrl, @altText, @width, @height, @durationMs)
      ON CONFLICT(bookmark_id, url) DO UPDATE SET
        type = excluded.type,
        thumbnail_url = COALESCE(excluded.thumbnail_url, media_items.thumbnail_url),
        alt_text = COALESCE(excluded.alt_text, media_items.alt_text),
        width = COALESCE(excluded.width, media_items.width),
        height = COALESCE(excluded.height, media_items.height),
        duration_ms = COALESCE(excluded.duration_ms, media_items.duration_ms),
        updated_at = CURRENT_TIMESTAMP
    `).run({
      id: media.id,
      bookmarkId: bookmark.id,
      type: media.type,
      url: media.url,
      thumbnailUrl: media.thumbnailUrl ?? null,
      altText: media.altText ?? null,
      width: media.width ?? null,
      height: media.height ?? null,
      durationMs: media.durationMs ?? null,
    })
    addTag(db, bookmark.id, `media:${media.type}`, 'media', 0.6)
  }

  for (const link of bookmark.urls) {
    const domain = link.domain ?? null
    const status = domain && /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(domain) ? 'skipped' : 'pending'
    db.prepare(`
      INSERT INTO links(id, bookmark_id, url, expanded_url, domain, status)
      VALUES (@id, @bookmarkId, @url, @expandedUrl, @domain, @status)
      ON CONFLICT(bookmark_id, url) DO UPDATE SET
        expanded_url = COALESCE(excluded.expanded_url, links.expanded_url),
        domain = COALESCE(excluded.domain, links.domain),
        status = CASE WHEN links.status = 'error' THEN 'pending' ELSE links.status END,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      id: link.id,
      bookmarkId: bookmark.id,
      url: link.url,
      expandedUrl: link.expandedUrl ?? link.url,
      domain,
      status,
    })
    if (domain) addTag(db, bookmark.id, `domain:${domain}`, 'domain', 0.8)
  }

  for (const hashtag of bookmark.hashtags) addTag(db, bookmark.id, hashtag, 'hashtag', 1.2)
  for (const mention of bookmark.mentions) addTag(db, bookmark.id, `@${mention}`, 'mention', 0.8)
  addTag(db, bookmark.id, `author:${bookmark.author.handle.toLowerCase()}`, 'author', 0.7)

  return stats
}

export function mergeStats(a: ImportStats, b: ImportStats): ImportStats {
  return {
    imported: a.imported + b.imported,
    updated: a.updated + b.updated,
    duplicates: a.duplicates + b.duplicates,
    skipped: a.skipped + b.skipped,
  }
}

export function refreshTagCounts(db: Database.Database): void {
  db.exec(`
    UPDATE tags SET count = (
      SELECT COUNT(DISTINCT bookmark_id)
      FROM bookmark_tags
      WHERE bookmark_tags.tag = tags.tag
    );
    DELETE FROM tags WHERE count = 0;
  `)
}

/** Common English / query glue that floods OR-queries and tanks FTS ranking. */
const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'not', 'near', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'by', 'as', 'at', 'is', 'are', 'was', 'were', 'be', 'been', 'been', 'this', 'that', 'these',
  'those', 'it', 'its', 'my', 'me', 'we', 'you', 'your', 'all', 'any', 'some', 'into', 'about',
  'find', 'show', 'list', 'get', 'based', 'basedon', 'using', 'use', 'used', 'make', 'made',
  'posts', 'post', 'tweet', 'tweets', 'please', 'what', 'which', 'who', 'how', 'when', 'where',
  'there', 'here', 'than', 'then', 'also', 'just', 'like', 'via', 'from',
])

/**
 * Build a safe FTS5 MATCH expression.
 * Bare punctuation like @ # : * " breaks FTS5 syntax (e.g. "@user" → syntax error near "@").
 * Strip handle/hashtag markers, drop operators/stopwords, and quote each token as a phrase.
 */
function ftsTermsForQuery(input: string): string {
  const terms = input
    .toLowerCase()
    // Split on anything that isn't a simple token char; @handles → handle, #tags → tags
    .split(/[^a-z0-9_]+/i)
    .map((term) => term.replace(/^[@#]+/, '').replace(/["*()^:]+/g, '').trim())
    .filter((term) => term.length >= 2 && !FTS_STOPWORDS.has(term))
    .slice(0, 12)
  if (!terms.length) return ''
  // Quoted phrases are treated as bare tokens; double any internal quotes
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

export function buildFtsQuery(input: string): string {
  return ftsTermsForQuery(input)
}

export function rebuildFts(db: Database.Database): void {
  db.exec('DELETE FROM bookmark_fts; DELETE FROM link_fts; DELETE FROM youtube_fts; DELETE FROM document_fts;')

  const bookmarks = db.prepare(`
    SELECT
      b.id,
      b.tweet_id AS tweetId,
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
    WHERE NOT EXISTS (SELECT 1 FROM curated_items ci WHERE ci.item_type = 'x' AND ci.item_id = b.id AND ci.status = 'removed')
  `).all() as Array<{
    id: string
    tweetId: string
    text: string
    authorHandle: string
    authorName: string
    topics: string
    tags: string
    linkText: string
    mediaText: string
  }>

  const insertBookmark = db.prepare(`
    INSERT INTO bookmark_fts(bookmark_id, tweet_id, text, author, topics, tags, link_text, media_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of bookmarks) {
    insertBookmark.run(
      row.id,
      row.tweetId,
      row.text,
      `${row.authorName} @${row.authorHandle}`,
      row.topics,
      row.tags,
      row.linkText,
      row.mediaText,
    )
  }

  const links = db.prepare(`
    SELECT id, bookmark_id AS bookmarkId, title, description, summary, article_text AS articleText, tags
    FROM links
    WHERE status IN ('fetched', 'summarized') OR title IS NOT NULL OR summary IS NOT NULL
  `).all() as Array<{
    id: string
    bookmarkId: string
    title: string | null
    description: string | null
    summary: string | null
    articleText: string | null
    tags: string | null
  }>

  const insertLink = db.prepare(`
    INSERT INTO link_fts(link_id, bookmark_id, title, description, summary, article_text, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of links) {
    insertLink.run(
      row.id,
      row.bookmarkId,
      row.title ?? '',
      row.description ?? '',
      row.summary ?? '',
      row.articleText ?? '',
      row.tags ?? '',
    )
  }

  const videos = db.prepare(`
    SELECT y.id, y.title, y.description, y.channel_name AS channel, COALESCE(y.transcript, '') AS transcript,
      COALESCE((SELECT group_concat(t.name, ' ') FROM youtube_video_topics yt JOIN topics t ON t.id = yt.topic_id WHERE yt.video_id = y.id), '') AS topics,
      COALESCE((SELECT group_concat(tag, ' ') FROM youtube_video_tags WHERE video_id = y.id), '') AS tags,
      COALESCE((SELECT group_concat(p.name, ' ') FROM youtube_playlist_items pi JOIN youtube_playlists p ON p.id = pi.playlist_id WHERE pi.video_id = y.id), '') AS playlists
    FROM youtube_videos y
    WHERE y.curation_status <> 'removed'
  `).all() as Array<{ id: string; title: string; description: string; channel: string; transcript: string; topics: string; tags: string; playlists: string }>
  const insertVideo = db.prepare(`
    INSERT INTO youtube_fts(video_id, title, description, channel, transcript, topics, tags, playlists)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of videos) insertVideo.run(row.id, row.title, row.description, row.channel, row.transcript, row.topics, row.tags, row.playlists)

  const documents = db.prepare(`
    SELECT d.id, d.title, d.content_text AS content,
      COALESCE((SELECT group_concat(t.name, ' ') FROM document_topics dt JOIN topics t ON t.id = dt.topic_id WHERE dt.document_id = d.id), '') AS topics,
      COALESCE((SELECT group_concat(tag, ' ') FROM document_tags WHERE document_id = d.id), '') AS tags
    FROM documents d
    WHERE d.curation_status <> 'removed'
  `).all() as Array<{ id: string; title: string; content: string; topics: string; tags: string }>
  const insertDocument = db.prepare(`
    INSERT INTO document_fts(document_id, title, content, topics, tags)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const row of documents) insertDocument.run(row.id, row.title, row.content, row.topics, row.tags)
}

export function resetDerivedTables(db: Database.Database): void {
  db.exec(`
    DELETE FROM graph_edges;
    DELETE FROM graph_nodes;
    DELETE FROM bookmark_fts;
    DELETE FROM link_fts;
    DELETE FROM youtube_fts;
    DELETE FROM document_fts;
  `)
}
