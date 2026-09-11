import type Database from 'better-sqlite3'
import { parseJson, safeJson, stableId } from '../lib/hash'
import { rebuildFts, refreshTagCounts, resetDerivedTables } from './store'
import { refreshKnowledgeLayer } from './knowledge'
import { placeNode, rebuildSemanticEdgesFromStored } from './placement'
import { parseEmbedding } from '../lib/semantic'

interface NodeInput {
  id: string
  type: string
  key: string
  label: string
  summary?: string | null
  metadata?: Record<string, unknown>
  weight?: number
}

interface EdgeInput {
  sourceId: string
  targetId: string
  type: string
  weight?: number
  metadata?: Record<string, unknown>
}

function trimLabel(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact
}

const GRAPH_TAG_STOPWORDS = new Set([
  'author', 'unknown', 'domain', 'media', 'photo', 'photos', 'video', 'videos', 'image', 'images',
  'tweet', 'tweets', 'post', 'posts', 'com', 'www', 'http', 'https', 'tco', 'xcom', 'twitter',
  'first', 'most', 'many', 'much', 'time', 'times', 'every', 'something', 'anything', 'things',
  'thing', 'really', 'very', 'actually', 'because', 'only', 'also', 'still', 'make', 'made',
  'makes', 'making', 'want', 'wants', 'need', 'needs', 'way', 'ways', 'see', 'look', 'looks',
  'going', 'back', 'over', 'under', 'then', 'these', 'those', 'its', 'own', 'don',
  'people', 'person', 'built', 'build', 'building', 'work', 'works', 'working', 'any', 'some',
  'same', 'using', 'used', 'everything', 'everyone', 'know', 'knows', 'run', 'runs', 'running',
  'through', 'years', 'year', 'before', 'after', 'open', 'isn', 'isnt', 'good', 'great', 'best',
  'better', 'right', 'real', 'today', 'tomorrow', 'yesterday', 'day', 'days', 'week', 'weeks',
  'month', 'months', 'long', 'short', 'big', 'small', 'high', 'low', 'lot', 'lots',
  'could', 'would', 'even', 'full', 'last', 'across', 'around', 'being', 'between', 'without',
  'within', 'again', 'another', 'others', 'other', 'while', 'where', 'whether', 'ever', 'never',
  'always', 'maybe', 'probably', 'basically', 'literally', 'simple', 'hard', 'easy', 'free',
  'above', 'below', 'already', 'different', 'each', 'either', 'neither', 'both', 'few', 'less',
  'least', 'enough', 'else', 'etc', 'per', 'plus', 'minus', 'near', 'next', 'previous', 'past',
  'future', 'latest', 'ago', 'hours', 'hour', 'minute', 'minutes', 'second', 'seconds',
  'his', 'her', 'hers', 'him', 'she', 'he', 'we', 'whoever', 'anyone', 'someone', 'somebody',
  'nobody', 'lets', 'let', 'does', 'doesn', 'did', 'didn', 'done', 'doing', 'got', 'gets',
  'getting', 'based', 'called', 'call', 'calls', 'calling', 'come', 'comes', 'coming', 'came',
  'become', 'becomes', 'became', 'entire', 'whole', 'able', 'unable', 'available', 'unavailable',
  'find', 'finds', 'finding', 'found', 'ask', 'asks', 'asked', 'asking', 'answer', 'answers',
  'answered', 'help', 'helps', 'helped', 'start', 'starts', 'started', 'starting', 'end',
  'ends', 'ended', 'ending', 'add', 'adds', 'added', 'adding', 'change', 'changes', 'changed',
  'changing', 'check', 'checks', 'checked', 'checking', 'share', 'shares', 'shared', 'sharing',
  'take', 'takes', 'took', 'taken', 'give', 'gives', 'gave', 'given', 'read', 'reads', 'reading',
  'try', 'tries', 'tried', 'trying', 'understand', 'understands', 'understood', 'love', 'almost',
  'single', 'double', 'two', 'three', 'four', 'five', 'too', 'behind', 'away', 'instead',
  'part', 'parts', 'may', 'might', 'must', 'shall', 'cannot', 'cant', 'won', 'wont',
  'create', 'creates', 'created', 'creating', 'generate', 'generates', 'generated', 'generating',
  'text', 'link', 'links',
  'think', 'thinks', 'thinking', 'thought', 'feel', 'feels', 'feeling', 'felt', 'believe',
  'believes', 'believed', 'introduce', 'introduces', 'introduced', 'introducing', 'live',
  'lives', 'living', 'down', 'idea', 'ideas', 'account', 'accounts', 'demo', 'demos', 'fast',
  'slow', 'approach', 'approaches', 'issue', 'issues', 'problem', 'problems', 'case', 'cases',
  'point', 'points', 'level', 'levels', 'kind', 'kinds', 'sort', 'sorts', 'place', 'places',
  'happen', 'happens', 'happened', 'happening', 'show', 'shows', 'showed', 'shown', 'showing',
  'move', 'moves', 'moved', 'moving', 'put', 'puts', 'putting', 'keep', 'keeps', 'kept',
  'complex', 'fully', 'example', 'examples', 'bookmark', 'bookmarks', 'untitled',
])

export function isGraphableTag(raw: string, source = 'semantic-local', count = 1): boolean {
  const tag = raw.trim().toLowerCase()
  if (!tag || tag.length < 3 || tag.length > 48) return false
  if (GRAPH_TAG_STOPWORDS.has(tag)) return false
  if (/^\d+$/.test(tag)) return false
  if (/^(author|domain|media)(:|\s|$)/.test(tag)) return false
  if (/^(photo|video|image|tweet|post)(\s|$)/.test(tag)) return false
  if (tag.includes(':')) return false
  if (tag.split(/\s+/).some((part) => GRAPH_TAG_STOPWORDS.has(part))) return false
  if (source === 'hashtag') return true
  return tag.includes(' ') ? count >= 3 : count >= 10
}

function upsertNodeStmt(db: Database.Database) {
  return db.prepare(`
    INSERT INTO graph_nodes(id, type, key, label, summary, metadata, weight)
    VALUES (@id, @type, @key, @label, @summary, @metadata, @weight)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      summary = excluded.summary,
      metadata = excluded.metadata,
      weight = excluded.weight,
      updated_at = CURRENT_TIMESTAMP
  `)
}

function upsertEdgeStmt(db: Database.Database) {
  return db.prepare(`
    INSERT INTO graph_edges(id, source_id, target_id, type, weight, metadata)
    VALUES (@id, @sourceId, @targetId, @type, @weight, @metadata)
    ON CONFLICT(source_id, target_id, type) DO UPDATE SET
      weight = excluded.weight,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP
  `)
}

function addNode(stmt: Database.Statement, node: NodeInput): void {
  stmt.run({
    id: node.id,
    type: node.type,
    key: node.key,
    label: trimLabel(node.label),
    summary: node.summary ?? null,
    metadata: safeJson(node.metadata ?? {}),
    weight: Math.max(1, Math.round(node.weight ?? 1)),
  })
}

function addEdge(stmt: Database.Statement, edge: EdgeInput): void {
  const id = stableId('edge', `${edge.sourceId}:${edge.type}:${edge.targetId}`)
  stmt.run({
    id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    type: edge.type,
    weight: edge.weight ?? 1,
    metadata: safeJson(edge.metadata ?? {}),
  })
}

export function rebuildGraph(db: Database.Database): { nodes: number; edges: number } {
  refreshTagCounts(db)

  const nodeStmt = upsertNodeStmt(db)
  const edgeStmt = upsertEdgeStmt(db)
  let nodeCount = 0
  let edgeCount = 0

  const tx = db.transaction(() => {
    resetDerivedTables(db)
    addNode(nodeStmt, {
      id: 'root:bookmarks',
      type: 'root',
      key: 'bookmarks',
      label: 'Knowledge Atlas',
      summary: 'Unified local knowledge graph for X bookmarks, browser favorites, and saved YouTube videos',
      weight: 10,
    })
    nodeCount++
    for (const source of [
      { id: 'source:x', key: 'x', label: 'X Bookmarks', color: '#38bdf8', weight: 10 },
      { id: 'source:web', key: 'web', label: 'Browser Favorites', color: '#0ea5e9', weight: 9 },
      { id: 'source:youtube', key: 'youtube', label: 'YouTube Library', color: '#ef4444', weight: 8 },
    ]) {
      addNode(nodeStmt, { ...source, type: 'source', metadata: { color: source.color }, weight: source.weight })
      addEdge(edgeStmt, { sourceId: 'root:bookmarks', targetId: source.id, type: 'contains_source', weight: 10 })
      nodeCount++
      edgeCount++
    }

    const topics = db.prepare(`
      SELECT t.id, t.slug, t.name, t.description, t.color, COUNT(bt.bookmark_id) AS count
      FROM topics t
      LEFT JOIN bookmark_topics bt ON bt.topic_id = t.id
      GROUP BY t.id
    `).all() as Array<{ id: string; slug: string; name: string; description: string | null; color: string; count: number }>

    for (const topic of topics) {
      const id = `topic:${topic.slug}`
      addNode(nodeStmt, {
        id,
        type: 'topic',
        key: topic.slug,
        label: topic.name,
        summary: topic.description,
        metadata: { color: topic.color, count: topic.count },
        weight: topic.count,
      })
      addEdge(edgeStmt, { sourceId: 'root:bookmarks', targetId: id, type: 'contains_topic', weight: Math.max(1, topic.count) })
      nodeCount++
      edgeCount++
    }

    const authors = db.prepare(`
      SELECT author_handle AS handle, author_name AS name, COUNT(*) AS count
      FROM bookmarks b
      WHERE b.source <> 'import'
        AND b.author_handle <> 'browser-favorites'
        AND NOT EXISTS (SELECT 1 FROM curated_items ci WHERE ci.item_type = 'x' AND ci.item_id = b.id AND ci.status IN ('removed', 'archived'))
      GROUP BY author_handle
      ORDER BY count DESC
    `).all() as Array<{ handle: string; name: string; count: number }>

    for (const author of authors) {
      addNode(nodeStmt, {
        id: `author:${author.handle.toLowerCase()}`,
        type: 'author',
        key: author.handle.toLowerCase(),
        label: `@${author.handle}`,
        summary: author.name,
        metadata: { name: author.name, count: author.count },
        weight: author.count,
      })
      nodeCount++
    }

    const domains = db.prepare(`
      SELECT domain, COUNT(DISTINCT bookmark_id) AS count
      FROM links
      WHERE domain IS NOT NULL
      GROUP BY domain
      ORDER BY count DESC
    `).all() as Array<{ domain: string; count: number }>

    for (const domain of domains) {
      addNode(nodeStmt, {
        id: `domain:${domain.domain}`,
        type: 'domain',
        key: domain.domain,
        label: domain.domain,
        metadata: { count: domain.count },
        weight: domain.count,
      })
      nodeCount++
    }

    const tags = (db.prepare(`
      SELECT
        t.tag,
        t.kind,
        COUNT(DISTINCT bt.bookmark_id) AS count,
        MAX(CASE WHEN bt.source = 'hashtag' THEN 1 ELSE 0 END) AS hasHashtag,
        MAX(CASE WHEN bt.source = 'semantic-local' THEN 1 ELSE 0 END) AS hasSemantic
      FROM tags t
      JOIN bookmark_tags bt ON bt.tag = t.tag
      WHERE bt.source IN ('semantic-local', 'hashtag')
      GROUP BY t.tag, t.kind
      ORDER BY count DESC
    `).all() as Array<{ tag: string; kind: string; count: number; hasHashtag: number; hasSemantic: number }>)
      .filter((tag) => isGraphableTag(tag.tag, tag.hasHashtag ? 'hashtag' : 'semantic-local', tag.count))
    const graphableTags = new Set(tags.map((tag) => tag.tag))

    for (const tag of tags) {
      addNode(nodeStmt, {
        id: `tag:${tag.tag}`,
        type: 'tag',
        key: tag.tag,
        label: tag.tag,
        metadata: { kind: tag.kind, count: tag.count },
        weight: tag.count,
      })
      nodeCount++
    }

    const bookmarks = db.prepare(`
      SELECT id, tweet_id AS tweetId, text, author_handle AS authorHandle, author_name AS authorName,
             tweet_created_at AS tweetCreatedAt, source
      FROM bookmarks b
      WHERE NOT EXISTS (SELECT 1 FROM curated_items ci WHERE ci.item_type = 'x' AND ci.item_id = b.id AND ci.status IN ('removed', 'archived'))
    `).all() as Array<{
      id: string
      tweetId: string
      text: string
      authorHandle: string
      authorName: string
      tweetCreatedAt: string | null
      source: string
    }>

    const topicStmt = db.prepare(`
      SELECT t.slug, t.name, t.color, bt.confidence
      FROM bookmark_topics bt
      JOIN topics t ON t.id = bt.topic_id
      WHERE bt.bookmark_id = ?
    `)
    const tagStmt = db.prepare(`
      SELECT tag, source, weight
      FROM bookmark_tags
      WHERE bookmark_id = ?
        AND source IN ('semantic-local', 'hashtag')
      ORDER BY weight DESC
      LIMIT 40
    `)
    const linkStmt = db.prepare(`
      SELECT id, url, expanded_url AS expandedUrl, canonical_url AS canonicalUrl, domain, title, description, summary, tags, status
      FROM links
      WHERE bookmark_id = ?
    `)
    const mediaStmt = db.prepare(`
      SELECT id, type, url, thumbnail_url AS thumbnailUrl, image_summary AS imageSummary, image_tags AS imageTags
      FROM media_items
      WHERE bookmark_id = ?
    `)

    for (const bookmark of bookmarks) {
      const bookmarkNodeId = `bookmark:${bookmark.id}`
      const topicsForBookmark = topicStmt.all(bookmark.id) as Array<{ slug: string; name: string; color: string; confidence: number }>
      const tagsForBookmark = (tagStmt.all(bookmark.id) as Array<{ tag: string; source: string; weight: number }>)
        .filter((tag) => graphableTags.has(tag.tag))
        .slice(0, 18)
      const linksForBookmark = linkStmt.all(bookmark.id) as Array<{
        id: string
        url: string
        expandedUrl: string | null
        canonicalUrl: string | null
        domain: string | null
        title: string | null
        description: string | null
        summary: string | null
        tags: string | null
        status: string
      }>
      const mediaForBookmark = mediaStmt.all(bookmark.id) as Array<{
        id: string
        type: string
        url: string
        thumbnailUrl: string | null
        imageSummary: string | null
        imageTags: string | null
      }>

      const isFavorite = bookmark.source === 'import' || bookmark.authorHandle === 'browser-favorites'
      const primaryLink = linksForBookmark[0]
      const favoriteTitle = isFavorite
        ? (primaryLink?.title || bookmark.text.split('\n')[0] || primaryLink?.url || bookmark.tweetId)
        : null

      addNode(nodeStmt, {
        id: bookmarkNodeId,
        type: isFavorite ? 'favorite' : 'bookmark',
        key: bookmark.id,
        label: trimLabel(favoriteTitle || bookmark.text, 90) || `Tweet ${bookmark.tweetId}`,
        summary: isFavorite
          ? (primaryLink?.summary ?? primaryLink?.description ?? bookmark.text)
          : bookmark.text,
        metadata: {
          tweetId: bookmark.tweetId,
          authorHandle: bookmark.authorHandle,
          authorName: bookmark.authorName,
          tweetCreatedAt: bookmark.tweetCreatedAt,
          source: bookmark.source,
          itemKind: isFavorite ? 'favorite' : 'x',
          url: primaryLink
            ? (primaryLink.canonicalUrl ?? primaryLink.expandedUrl ?? primaryLink.url)
            : (isFavorite ? null : `https://x.com/${bookmark.authorHandle}/status/${bookmark.tweetId}`),
          topics: topicsForBookmark.map((topic) => topic.name),
          tags: tagsForBookmark.map((tag) => tag.tag),
          media: mediaForBookmark.map((media) => ({ type: media.type, thumbnailUrl: media.thumbnailUrl, url: media.url })),
          links: linksForBookmark.map((link) => ({
            url: link.canonicalUrl ?? link.expandedUrl ?? link.url,
            domain: link.domain,
            title: link.title,
            summary: link.summary,
          })),
        },
        weight: 1 + topicsForBookmark.length + linksForBookmark.length + mediaForBookmark.length,
      })
      nodeCount++

      addEdge(edgeStmt, {
        sourceId: bookmarkNodeId,
        targetId: isFavorite ? 'source:web' : 'source:x',
        type: 'from_source',
        weight: 1,
      })
      edgeCount++

      if (!isFavorite) {
        const authorNodeId = `author:${bookmark.authorHandle.toLowerCase()}`
        addEdge(edgeStmt, { sourceId: bookmarkNodeId, targetId: authorNodeId, type: 'authored_by', weight: 1 })
        edgeCount++
      }

      for (const topic of topicsForBookmark) {
        addEdge(edgeStmt, {
          sourceId: bookmarkNodeId,
          targetId: `topic:${topic.slug}`,
          type: 'has_topic',
          weight: topic.confidence,
          metadata: { confidence: topic.confidence, color: topic.color },
        })
        edgeCount++
      }

      for (const tag of tagsForBookmark) {
        addEdge(edgeStmt, {
          sourceId: bookmarkNodeId,
          targetId: `tag:${tag.tag}`,
          type: 'has_tag',
          weight: tag.weight,
          metadata: { source: tag.source },
        })
        edgeCount++
      }

      for (const link of linksForBookmark) {
        const linkNodeId = `link:${link.id}`
        const linkTags = parseJson<string[]>(link.tags, [])
        addNode(nodeStmt, {
          id: linkNodeId,
          type: 'link',
          key: link.id,
          label: trimLabel(link.title || link.domain || link.expandedUrl || link.url, 90),
          summary: link.summary ?? link.description,
          metadata: {
            url: link.canonicalUrl ?? link.expandedUrl ?? link.url,
            domain: link.domain,
            status: link.status,
            tags: linkTags,
          },
          weight: link.summary ? 3 : 1,
        })
        nodeCount++
        addEdge(edgeStmt, { sourceId: bookmarkNodeId, targetId: linkNodeId, type: 'references_link', weight: 1 })
        edgeCount++
        if (link.domain) {
          addEdge(edgeStmt, { sourceId: bookmarkNodeId, targetId: `domain:${link.domain}`, type: 'links_domain', weight: 1 })
          addEdge(edgeStmt, { sourceId: linkNodeId, targetId: `domain:${link.domain}`, type: 'hosted_on', weight: 1 })
          edgeCount += 2
        }
      }

      for (const media of mediaForBookmark) {
        const mediaNodeId = `media:${media.id}`
        addNode(nodeStmt, {
          id: mediaNodeId,
          type: 'media',
          key: media.id,
          label: `${media.type} media`,
          summary: media.imageSummary,
          metadata: {
            type: media.type,
            url: media.url,
            thumbnailUrl: media.thumbnailUrl,
            imageTags: parseJson<Record<string, unknown>>(media.imageTags, {}),
          },
          weight: 1,
        })
        addEdge(edgeStmt, { sourceId: bookmarkNodeId, targetId: mediaNodeId, type: 'has_media', weight: 1 })
        nodeCount++
        edgeCount++
      }
    }

    const youtubeChannels = db.prepare(`
      SELECT COALESCE(NULLIF(channel_id, ''), lower(channel_name)) AS key, NULLIF(channel_id, '') AS channelId, channel_name AS channelName, COUNT(*) AS count
      FROM youtube_videos WHERE curation_status NOT IN ('removed', 'archived') AND channel_name <> ''
      GROUP BY COALESCE(NULLIF(channel_id, ''), lower(channel_name)), NULLIF(channel_id, ''), channel_name
    `).all() as Array<{ key: string; channelId: string | null; channelName: string; count: number }>
    for (const channel of youtubeChannels) {
      addNode(nodeStmt, {
        id: `channel:${channel.key}`,
        type: 'channel',
        key: channel.key,
        label: channel.channelName,
        metadata: { channelId: channel.channelId, count: channel.count },
        weight: channel.count,
      })
      nodeCount++
    }

    const youtubePlaylists = db.prepare(`
      SELECT id, playlist_id AS playlistId, name, source_type AS sourceType, video_count AS videoCount
      FROM youtube_playlists
    `).all() as Array<{ id: string; playlistId: string; name: string; sourceType: string; videoCount: number | null }>
    for (const playlist of youtubePlaylists) {
      addNode(nodeStmt, {
        id: `playlist:${playlist.id}`,
        type: 'playlist',
        key: playlist.id,
        label: playlist.name,
        summary: `YouTube ${playlist.sourceType.replace('-', ' ')} playlist`,
        metadata: { playlistId: playlist.playlistId, sourceType: playlist.sourceType, videoCount: playlist.videoCount },
        weight: playlist.videoCount ?? 1,
      })
      addEdge(edgeStmt, { sourceId: 'source:youtube', targetId: `playlist:${playlist.id}`, type: 'contains_playlist', weight: playlist.videoCount ?? 1 })
      nodeCount++
      edgeCount++
    }

    const youtubeTagRows = db.prepare(`
      SELECT tag, COUNT(DISTINCT video_id) AS count FROM youtube_video_tags
      GROUP BY tag ORDER BY count DESC
    `).all() as Array<{ tag: string; count: number }>
    const youtubeGraphTags = new Set(youtubeTagRows.filter((row) => isGraphableTag(row.tag, 'semantic-local', row.count)).map((row) => row.tag))
    for (const tag of youtubeTagRows.filter((row) => youtubeGraphTags.has(row.tag))) {
      const id = `tag:${tag.tag}`
      if (!graphableTags.has(tag.tag)) {
        addNode(nodeStmt, { id, type: 'tag', key: tag.tag, label: tag.tag, metadata: { kind: 'semantic', count: tag.count }, weight: tag.count })
        nodeCount++
      }
    }

    const youtubeVideos = db.prepare(`
      SELECT id, video_id AS videoId, title, description, channel_id AS channelId, channel_name AS channelName,
        channel_url AS channelUrl, duration_seconds AS durationSeconds, published_at AS publishedAt,
        view_count AS viewCount, thumbnail_url AS thumbnailUrl, local_thumbnail_path AS localThumbnailPath,
        transcript_status AS transcriptStatus, curation_status AS curationStatus
      FROM youtube_videos WHERE curation_status NOT IN ('removed', 'archived')
    `).all() as Array<Record<string, any>>
    const youtubeTopicsStmt = db.prepare(`
      SELECT t.slug, t.name, t.color, yt.confidence FROM youtube_video_topics yt
      JOIN topics t ON t.id = yt.topic_id WHERE yt.video_id = ?
    `)
    const youtubeTagsStmt = db.prepare(`
      SELECT tag, source, weight FROM youtube_video_tags WHERE video_id = ? ORDER BY weight DESC LIMIT 40
    `)
    const youtubePlaylistStmt = db.prepare(`
      SELECT p.id, p.playlist_id AS playlistId, p.name, pi.position FROM youtube_playlist_items pi
      JOIN youtube_playlists p ON p.id = pi.playlist_id WHERE pi.video_id = ?
    `)

    for (const video of youtubeVideos) {
      const nodeId = `youtube:${video.id}`
      const topicsForVideo = youtubeTopicsStmt.all(video.id) as Array<{ slug: string; name: string; color: string; confidence: number }>
      const tagsForVideo = (youtubeTagsStmt.all(video.id) as Array<{ tag: string; source: string; weight: number }>).filter((tag) => youtubeGraphTags.has(tag.tag)).slice(0, 18)
      const playlistsForVideo = youtubePlaylistStmt.all(video.id) as Array<{ id: string; playlistId: string; name: string; position: number | null }>
      addNode(nodeStmt, {
        id: nodeId,
        type: 'youtube',
        key: video.id,
        label: video.title,
        summary: video.description,
        metadata: {
          videoId: video.videoId,
          url: `https://www.youtube.com/watch?v=${video.videoId}`,
          channelId: video.channelId,
          channelName: video.channelName,
          channelUrl: video.channelUrl,
          durationSeconds: video.durationSeconds,
          publishedAt: video.publishedAt,
          viewCount: video.viewCount,
          thumbnailUrl: video.thumbnailUrl,
          localThumbnailPath: video.localThumbnailPath,
          transcriptStatus: video.transcriptStatus,
          curationStatus: video.curationStatus,
          topics: topicsForVideo.map((topic) => topic.name),
          tags: tagsForVideo.map((tag) => tag.tag),
          playlists: playlistsForVideo.map((playlist) => playlist.name),
        },
        weight: 2 + topicsForVideo.length + playlistsForVideo.length + (video.transcriptStatus === 'fetched' ? 2 : 0),
      })
      addEdge(edgeStmt, { sourceId: nodeId, targetId: 'source:youtube', type: 'from_source', weight: 1 })
      nodeCount++
      edgeCount++
      if (video.channelName) {
        const channelKey = video.channelId || String(video.channelName).toLowerCase()
        const channelNodeId = `channel:${channelKey}`
        if (!db.prepare('SELECT 1 FROM graph_nodes WHERE id = ?').get(channelNodeId)) {
          addNode(nodeStmt, { id: channelNodeId, type: 'channel', key: channelKey, label: video.channelName, metadata: { channelId: video.channelId }, weight: 1 })
          nodeCount++
        }
        addEdge(edgeStmt, { sourceId: nodeId, targetId: channelNodeId, type: 'published_by', weight: 1 })
        edgeCount++
      }
      for (const topic of topicsForVideo) {
        addEdge(edgeStmt, { sourceId: nodeId, targetId: `topic:${topic.slug}`, type: 'has_topic', weight: topic.confidence, metadata: { color: topic.color } })
        edgeCount++
      }
      for (const tag of tagsForVideo) {
        addEdge(edgeStmt, { sourceId: nodeId, targetId: `tag:${tag.tag}`, type: 'has_tag', weight: tag.weight, metadata: { source: tag.source } })
        edgeCount++
      }
      for (const playlist of playlistsForVideo) {
        addEdge(edgeStmt, { sourceId: nodeId, targetId: `playlist:${playlist.id}`, type: 'saved_in', weight: 1, metadata: { position: playlist.position } })
        edgeCount++
      }
    }

    const documents = db.prepare(`
      SELECT id, title, summary, metadata FROM documents WHERE curation_status <> 'removed'
    `).all() as Array<{ id: string; title: string; summary: string | null; metadata: string | null }>
    if (documents.length) {
      addNode(nodeStmt, { id: 'source:documents', type: 'source', key: 'documents', label: 'Documents', summary: 'Ingested files and notes', metadata: { color: '#a78bfa' }, weight: 7 })
      addEdge(edgeStmt, { sourceId: 'root:bookmarks', targetId: 'source:documents', type: 'contains_source', weight: 10 })
      nodeCount++
      edgeCount++
      const documentTopicsStmt = db.prepare(`
        SELECT t.slug, dt.confidence FROM document_topics dt
        JOIN topics t ON t.id = dt.topic_id WHERE dt.document_id = ?
      `)
      const documentTagsStmt = db.prepare(`
        SELECT tag, source, weight FROM document_tags WHERE document_id = ? ORDER BY weight DESC LIMIT 40
      `)
      const tagNodeStmt = db.prepare('SELECT 1 FROM graph_nodes WHERE id = ?')
      for (const document of documents) {
        const nodeId = `document:${document.id}`
        addNode(nodeStmt, {
          id: nodeId,
          type: 'document',
          key: document.id,
          label: document.title,
          summary: document.summary,
          metadata: parseJson<Record<string, unknown>>(document.metadata, {}),
          weight: 3,
        })
        addEdge(edgeStmt, { sourceId: nodeId, targetId: 'source:documents', type: 'from_source', weight: 1 })
        nodeCount++
        edgeCount++
        for (const topic of documentTopicsStmt.all(document.id) as Array<{ slug: string; confidence: number }>) {
          addEdge(edgeStmt, { sourceId: nodeId, targetId: `topic:${topic.slug}`, type: 'has_topic', weight: topic.confidence, metadata: { confidence: topic.confidence } })
          edgeCount++
        }
        for (const tag of documentTagsStmt.all(document.id) as Array<{ tag: string; source: string; weight: number }>) {
          if (!tagNodeStmt.get(`tag:${tag.tag}`)) continue
          addEdge(edgeStmt, { sourceId: nodeId, targetId: `tag:${tag.tag}`, type: 'has_tag', weight: tag.weight, metadata: { source: tag.source } })
          edgeCount++
        }
      }
    }

    const collections = db.prepare('SELECT id, name, description, color FROM collections').all() as Array<{ id: string; name: string; description: string | null; color: string }>
    for (const collection of collections) {
      const collectionId = `collection:${collection.id}`
      addNode(nodeStmt, { id: collectionId, type: 'collection', key: collection.id, label: collection.name, summary: collection.description, metadata: { color: collection.color }, weight: 3 })
      addEdge(edgeStmt, { sourceId: 'root:bookmarks', targetId: collectionId, type: 'contains_collection', weight: 2 })
      nodeCount++
      edgeCount++
      const items = db.prepare('SELECT item_type AS itemType, item_id AS itemId, note FROM collection_items WHERE collection_id = ?').all(collection.id) as Array<{ itemType: string; itemId: string; note: string | null }>
      for (const item of items) {
        const targetId = item.itemType === 'youtube' ? `youtube:${item.itemId}` : `bookmark:${item.itemId}`
        addEdge(edgeStmt, { sourceId: targetId, targetId: collectionId, type: 'organized_in', metadata: { note: item.note } })
        edgeCount++
      }
    }

    // Correlation edges: content items that share specific tags co-occur in the graph
    edgeCount += addCorrelationEdges(db, edgeStmt)
    rebuildFts(db)
  })

  tx()
  refreshKnowledgeLayer(db)
  rebuildSemanticEdgesFromStored(db)
  // Bucketed rebuild misses cross-bucket placement edges; re-place each document from its stored vector
  for (const row of db.prepare(`
    SELECT e.owner_id AS nodeId, e.vector FROM embeddings e
    JOIN graph_nodes n ON n.id = e.owner_id
    WHERE n.type = 'document' AND e.owner_type = 'graph_node' AND e.model = 'minilm-l6-v2'
  `).all() as Array<{ nodeId: string; vector: unknown }>) {
    placeNode(db, row.nodeId, Float32Array.from(parseEmbedding(row.vector)))
  }
  return {
    nodes: (db.prepare('SELECT COUNT(*) AS count FROM graph_nodes').get() as { count: number }).count,
    edges: (db.prepare('SELECT COUNT(*) AS count FROM graph_edges').get() as { count: number }).count,
  }
}

/** Connect content nodes that share high-signal tags so the explorer can surface correlations. */
function addCorrelationEdges(db: Database.Database, edgeStmt: Database.Statement): number {
  // Tags that appear on enough items to be meaningful but not so common they create a clique
  const tags = db.prepare(`
    SELECT tag, COUNT(DISTINCT bookmark_id) AS count
    FROM bookmark_tags
    WHERE source IN ('semantic-local', 'hashtag', 'folder')
      AND tag NOT LIKE 'author:%'
      AND tag NOT LIKE 'domain:%'
      AND tag NOT LIKE 'media:%'
      AND tag NOT LIKE 'folder:%'
    GROUP BY tag
    HAVING count BETWEEN 3 AND 80
    ORDER BY count ASC
    LIMIT 400
  `).all() as Array<{ tag: string; count: number }>

  const itemForTag = db.prepare(`
    SELECT DISTINCT
      CASE
        WHEN b.source = 'import' OR b.author_handle = 'browser-favorites' THEN 'bookmark:' || bt.bookmark_id
        ELSE 'bookmark:' || bt.bookmark_id
      END AS nodeId
    FROM bookmark_tags bt
    JOIN bookmarks b ON b.id = bt.bookmark_id
    WHERE bt.tag = ?
      AND NOT EXISTS (SELECT 1 FROM curated_items ci WHERE ci.item_type = 'x' AND ci.item_id = b.id AND ci.status = 'removed')
    LIMIT 24
  `)

  const ytItemForTag = db.prepare(`
    SELECT 'youtube:' || video_id AS nodeId
    FROM youtube_video_tags
    WHERE tag = ?
    LIMIT 24
  `)

  const nodeExists = db.prepare('SELECT 1 FROM graph_nodes WHERE id = ?')
  const pairCounts = new Map<string, { a: string; b: string; shared: string[]; weight: number }>()

  for (const tag of tags) {
    const xItems = (itemForTag.all(tag.tag) as Array<{ nodeId: string }>).map((row) => row.nodeId)
    const ytItems = (ytItemForTag.all(tag.tag) as Array<{ nodeId: string }>).map((row) => row.nodeId)
    const items = [...new Set([...xItems, ...ytItems])].filter((id) => nodeExists.get(id))
    if (items.length < 2) continue

    // Prefer rarer tags (stronger signal)
    const rarityBoost = Math.max(0.4, Math.min(2.5, 12 / Math.max(2, tag.count)))
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i] < items[j] ? items[i] : items[j]
        const b = items[i] < items[j] ? items[j] : items[i]
        const key = `${a}::${b}`
        const existing = pairCounts.get(key)
        if (existing) {
          existing.weight += rarityBoost
          if (existing.shared.length < 8) existing.shared.push(tag.tag)
        } else {
          pairCounts.set(key, { a, b, shared: [tag.tag], weight: rarityBoost })
        }
      }
    }
  }

  // Keep the strongest correlations only to avoid edge explosion
  const ranked = [...pairCounts.values()]
    .filter((pair) => pair.shared.length >= 2 || pair.weight >= 1.8)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12000)

  const perNode = new Map<string, number>()
  let added = 0
  for (const pair of ranked) {
    const aCount = perNode.get(pair.a) ?? 0
    const bCount = perNode.get(pair.b) ?? 0
    if (aCount >= 18 || bCount >= 18) continue
    addEdge(edgeStmt, {
      sourceId: pair.a,
      targetId: pair.b,
      type: 'correlates_with',
      weight: Math.min(8, Number(pair.weight.toFixed(2))),
      metadata: { sharedTags: pair.shared, reason: 'shared_tags' },
    })
    perNode.set(pair.a, aCount + 1)
    perNode.set(pair.b, bCount + 1)
    added++
  }

  // Domain correlations for mid-size domains only (avoid github.com-scale cliques)
  const domains = db.prepare(`
    SELECT domain, COUNT(DISTINCT bookmark_id) AS count
    FROM links
    WHERE domain IS NOT NULL
      AND domain NOT IN ('x.com', 'twitter.com', 't.co', 'youtube.com', 'youtu.be', 'github.com')
    GROUP BY domain
    HAVING count BETWEEN 3 AND 40
    ORDER BY count ASC
    LIMIT 200
  `).all() as Array<{ domain: string; count: number }>

  const bookmarksOnDomain = db.prepare(`
    SELECT DISTINCT bookmark_id AS id FROM links WHERE domain = ? LIMIT 20
  `)

  for (const domain of domains) {
    const ids = (bookmarksOnDomain.all(domain.domain) as Array<{ id: string }>).map((row) => row.id)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = `bookmark:${ids[i]}`
        const b = `bookmark:${ids[j]}`
        if (!nodeExists.get(a) || !nodeExists.get(b)) continue
        const aCount = perNode.get(a) ?? 0
        const bCount = perNode.get(b) ?? 0
        if (aCount >= 22 || bCount >= 22) continue
        addEdge(edgeStmt, {
          sourceId: a,
          targetId: b,
          type: 'correlates_with',
          weight: Math.min(3.5, 0.9 + 8 / Math.max(3, domain.count)),
          metadata: { sharedDomain: domain.domain, reason: 'shared_domain' },
        })
        perNode.set(a, aCount + 1)
        perNode.set(b, bCount + 1)
        added++
      }
    }
  }

  return added
}
