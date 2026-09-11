import { randomUUID } from 'node:crypto'
import { SEMANTIC_MODEL } from '../pipeline/embedder'
import { config } from '../lib/env'
import { safeJson, stableId } from '../lib/hash'
import { catalogCounts, contentHash, iterateCatalog, memoryIdFor, richness } from './catalog'
import { assistantStats, closeAssistantDb, getMeta, openAssistantDb, openCatalogReadonly, setMeta } from './db'
import { extractEventsFromItem, mergeEvents } from './events'
import { distillAssistant } from './distill'
import { invalidateAssistantVectors } from './retrieve'
import type { CatalogItem, IndexOptions, IndexResult, IdeaRecord, TimelineEvent } from './types'

const BRIDGE_PAIRS: Array<[string, string]> = [
  ['ai-ml', 'science-research'],
  ['ai-ml', 'productivity-pkm'],
  ['ai-ml', 'health-longevity'],
  ['engineering', 'science-research'],
  ['engineering', 'productivity-pkm'],
  ['ai-ml', 'media-creative'],
  ['product-design', 'ai-ml'],
  ['tools-products', 'ai-ml'],
]

export async function buildAssistantIndex(options: IndexOptions = {}): Promise<IndexResult> {
  const catalogPath = options.catalogPath ?? config.dbPath
  const assistantPath = options.assistantPath ?? config.assistantDbPath
  const log = options.onProgress ?? ((message: string) => process.stderr.write(`${message}\n`))

  log(`[assistant] opening catalog read-only: ${catalogPath}`)
  const catalog = openCatalogReadonly(catalogPath)
  const assistant = openAssistantDb(assistantPath)
  const runId = `run:${randomUUID()}`
  assistant.prepare(`
    INSERT INTO index_runs(id, started_at, status) VALUES(?, CURRENT_TIMESTAMP, 'running')
  `).run(runId)

  let memoriesWritten = 0
  let memoriesSkipped = 0
  let embeddingsCopied = 0
  let eventsWritten = 0
  let ideasWritten = 0
  let themesWritten = 0
  let distilled = false

  try {
    const counts = catalogCounts(catalog)
    log(`[assistant] catalog snapshot x=${counts.x} favorites=${counts.favorites} youtube=${counts.youtube} documents=${counts.documents}`)
    setMeta(assistant, 'catalog_counts', safeJson(counts))

    const heuristicEvents: TimelineEvent[] = []
    const upsert = assistant.prepare(`
      INSERT INTO memories(
        id, source_type, source_id, graph_node_id, url, occurred_at, catalog_updated_at,
        title, body, author, author_name, topics, tags, content_hash, richness, topic_primary, kind, updated_at
      ) VALUES (
        @id, @sourceType, @sourceId, @graphNodeId, @url, @occurredAt, @updatedAt,
        @title, @body, @author, @authorName, @topics, @tags, @contentHash, @richness, @topicPrimary, 'item', CURRENT_TIMESTAMP
      )
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        graph_node_id = excluded.graph_node_id,
        url = excluded.url,
        occurred_at = excluded.occurred_at,
        catalog_updated_at = excluded.catalog_updated_at,
        title = excluded.title,
        body = excluded.body,
        author = excluded.author,
        author_name = excluded.author_name,
        topics = excluded.topics,
        tags = excluded.tags,
        content_hash = excluded.content_hash,
        richness = excluded.richness,
        topic_primary = excluded.topic_primary,
        updated_at = CURRENT_TIMESTAMP
    `)
    const existingHash = assistant.prepare('SELECT content_hash AS contentHash FROM memories WHERE id = ?')
    const deleteFts = assistant.prepare('DELETE FROM memory_fts WHERE memory_id = ?')
    const insertFts = assistant.prepare(`
      INSERT INTO memory_fts(memory_id, title, body, author, topics, tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    const writeItem = assistant.transaction((item: CatalogItem) => {
      const id = memoryIdFor(item)
      const hash = contentHash(item)
      const prev = existingHash.get(id) as { contentHash: string } | undefined
      if (prev?.contentHash === hash) {
        memoriesSkipped++
        return id
      }
      const topicPrimary = item.topics.find((topic) => topic !== 'unsorted') ?? item.topics[0] ?? 'unsorted'
      upsert.run({
        id,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        graphNodeId: item.graphNodeId,
        url: item.url,
        occurredAt: item.occurredAt,
        updatedAt: item.updatedAt,
        title: item.title,
        body: item.body,
        author: item.author,
        authorName: item.authorName,
        topics: safeJson(item.topics),
        tags: safeJson(item.tags.slice(0, 24)),
        contentHash: hash,
        richness: richness(item),
        topicPrimary,
      })
      deleteFts.run(id)
      insertFts.run(id, item.title, item.body.slice(0, 4000), item.author, item.topics.join(' '), item.tags.slice(0, 24).join(' '))
      memoriesWritten++
      return id
    })

    let scanned = 0
    for (const item of iterateCatalog(catalog, { limit: options.limit, since: options.since })) {
      const id = writeItem(item) as string
      heuristicEvents.push(...extractEventsFromItem(item, id))
      scanned++
      if (scanned % 2000 === 0) log(`[assistant] scanned ${scanned} catalog items (wrote ${memoriesWritten}, skipped ${memoriesSkipped})`)
    }
    log(`[assistant] memories written=${memoriesWritten} skipped=${memoriesSkipped} scanned=${scanned}`)
    promotePrimaryTopics(assistant)

    embeddingsCopied = copyEmbeddings(catalog, assistant)
    log(`[assistant] copied ${embeddingsCopied} MiniLM embeddings`)

    const merged = mergeEvents(heuristicEvents)
    eventsWritten = replaceHeuristicEvents(assistant, merged)
    log(`[assistant] heuristic events ${eventsWritten}`)

    themesWritten = rebuildThemes(assistant)
    log(`[assistant] themes ${themesWritten}`)

    ideasWritten = rebuildBridgeIdeas(catalog, assistant)
    log(`[assistant] bridge/collection ideas ${ideasWritten}`)

    writeDeterministicProfile(assistant, catalog, counts)
    setMeta(assistant, 'built_at', new Date().toISOString())
    setMeta(assistant, 'catalog_path', catalogPath)
    invalidateAssistantVectors()

    if (options.distill) {
      if (!config.xaiApiKey) {
        log('[assistant] distill skipped: XAI_API_KEY is not set')
      } else {
        log('[assistant] distilling profile, timeline, and ideas with the xAI API')
        const extra = await distillAssistant(assistant, { onProgress: log })
        eventsWritten += extra.eventsWritten
        ideasWritten += extra.ideasWritten
        distilled = true
      }
    }

    assistant.prepare(`
      UPDATE index_runs SET
        status = 'done', finished_at = CURRENT_TIMESTAMP,
        memories_written = ?, memories_skipped = ?, events_written = ?, ideas_written = ?,
        embeddings_copied = ?, metadata = ?
      WHERE id = ?
    `).run(
      memoriesWritten,
      memoriesSkipped,
      eventsWritten,
      ideasWritten,
      embeddingsCopied,
      safeJson({ scanned, themesWritten, distilled, catalog: counts }),
      runId,
    )

    return {
      runId,
      memoriesWritten,
      memoriesSkipped,
      eventsWritten,
      ideasWritten,
      embeddingsCopied,
      themesWritten,
      distilled,
    }
  } catch (error) {
    assistant.prepare(`
      UPDATE index_runs SET status = 'error', finished_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?
    `).run(error instanceof Error ? error.message : String(error), runId)
    throw error
  } finally {
    catalog.close()
    if (assistantPath !== config.assistantDbPath) closeAssistantDb(assistantPath)
  }
}

function promotePrimaryTopics(assistant: import('better-sqlite3').Database): void {
  assistant.exec(`
    UPDATE memories SET topic_primary = COALESCE(
      (SELECT value FROM json_each(memories.topics) WHERE value <> 'unsorted' LIMIT 1),
      topic_primary
    )
  `)
}

function copyEmbeddings(catalog: import('better-sqlite3').Database, assistant: import('better-sqlite3').Database): number {
  const insert = assistant.prepare(`
    INSERT INTO memory_embeddings(memory_id, model, dimensions, vector)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(memory_id, model) DO UPDATE SET dimensions = excluded.dimensions, vector = excluded.vector
  `)
  const lookup = catalog.prepare(`
    SELECT vector, dimensions FROM embeddings
    WHERE owner_type = 'graph_node' AND owner_id = ? AND model = ?
  `)
  const memories = assistant.prepare('SELECT id, graph_node_id AS graphNodeId FROM memories').all() as Array<{ id: string; graphNodeId: string | null }>
  let copied = 0
  const tx = assistant.transaction(() => {
    for (const memory of memories) {
      if (!memory.graphNodeId) continue
      const row = lookup.get(memory.graphNodeId, SEMANTIC_MODEL) as { vector: Buffer; dimensions: number } | undefined
      if (!row?.vector) continue
      insert.run(memory.id, SEMANTIC_MODEL, row.dimensions, row.vector)
      copied++
    }
  })
  tx()
  return copied
}

function replaceHeuristicEvents(assistant: import('better-sqlite3').Database, events: TimelineEvent[]): number {
  assistant.prepare("DELETE FROM events WHERE source = 'heuristic'").run()
  const insert = assistant.prepare(`
    INSERT OR REPLACE INTO events(id, occurred_at, title, kind, summary, entities, memory_ids, confidence, source)
    VALUES (@id, @occurredAt, @title, @kind, @summary, @entities, @memoryIds, @confidence, 'heuristic')
  `)
  const tx = assistant.transaction(() => {
    for (const event of events) {
      insert.run({
        id: event.id,
        occurredAt: event.occurredAt,
        title: event.title,
        kind: event.kind,
        summary: event.summary,
        entities: safeJson(event.entities),
        memoryIds: safeJson(event.memoryIds),
        confidence: event.confidence,
      })
    }
  })
  tx()
  return events.length
}

function rebuildThemes(assistant: import('better-sqlite3').Database): number {
  assistant.exec('DELETE FROM themes')
  const now = Date.now()
  const recentStart = new Date(now - 90 * 86_400_000).toISOString()
  const previousStart = new Date(now - 180 * 86_400_000).toISOString()

  const rows = assistant.prepare(`
    SELECT
      COALESCE(topic_primary, 'unsorted') AS slug,
      COUNT(*) AS itemCount,
      MIN(occurred_at) AS firstSeen,
      MAX(occurred_at) AS lastSeen,
      SUM(CASE WHEN occurred_at >= @recentStart THEN 1 ELSE 0 END) AS recentCount,
      SUM(CASE WHEN occurred_at >= @previousStart AND occurred_at < @recentStart THEN 1 ELSE 0 END) AS previousCount
    FROM memories
    GROUP BY COALESCE(topic_primary, 'unsorted')
  `).all({ recentStart, previousStart }) as Array<{
    slug: string
    itemCount: number
    firstSeen: string | null
    lastSeen: string | null
    recentCount: number
    previousCount: number
  }>

  const monthlyRows = assistant.prepare(`
    SELECT COALESCE(topic_primary, 'unsorted') AS slug, substr(occurred_at, 1, 7) AS month, COUNT(*) AS n
    FROM memories
    WHERE occurred_at IS NOT NULL AND length(occurred_at) >= 7
    GROUP BY slug, month
  `).all() as Array<{ slug: string; month: string; n: number }>
  const monthly = new Map<string, Record<string, number>>()
  for (const row of monthlyRows) {
    const bucket = monthly.get(row.slug) ?? {}
    bucket[row.month] = row.n
    monthly.set(row.slug, bucket)
  }

  const authorRows = assistant.prepare(`
    SELECT COALESCE(topic_primary, 'unsorted') AS slug, author, COUNT(*) AS n
    FROM memories
    WHERE author IS NOT NULL AND author <> '' AND author <> 'browser-favorites'
    GROUP BY slug, author
    ORDER BY n DESC
  `).all() as Array<{ slug: string; author: string; n: number }>
  const authors = new Map<string, Array<{ author: string; count: number }>>()
  for (const row of authorRows) {
    const list = authors.get(row.slug) ?? []
    if (list.length < 8) list.push({ author: row.author, count: row.n })
    authors.set(row.slug, list)
  }

  const insert = assistant.prepare(`
    INSERT INTO themes(id, slug, label, description, first_seen, last_seen, item_count, recent_count, previous_count, velocity, monthly, top_authors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of rows) {
    const velocity = row.previousCount === 0
      ? (row.recentCount > 0 ? 1 : 0)
      : (row.recentCount - row.previousCount) / row.previousCount
    insert.run(
      stableId('theme', row.slug),
      row.slug,
      labelForTopic(row.slug),
      `${row.itemCount} saved items. Last 90d ${row.recentCount} vs previous 90d ${row.previousCount}.`,
      row.firstSeen,
      row.lastSeen,
      row.itemCount,
      row.recentCount,
      row.previousCount,
      Number(velocity.toFixed(3)),
      safeJson(monthly.get(row.slug) ?? {}),
      safeJson(authors.get(row.slug) ?? []),
    )
  }
  return rows.length
}

function rebuildBridgeIdeas(catalog: import('better-sqlite3').Database, assistant: import('better-sqlite3').Database): number {
  assistant.prepare("DELETE FROM ideas WHERE source IN ('bridge', 'collection')").run()
  const ideas: IdeaRecord[] = []

  const pairStmt = assistant.prepare(`
    SELECT COUNT(*) AS n,
      group_concat(id, '|||') AS ids
    FROM memories
    WHERE topics LIKE @a AND topics LIKE @b
  `)
  for (const [left, right] of BRIDGE_PAIRS) {
    const row = pairStmt.get({ a: `%"${left}"%`, b: `%"${right}"%` }) as { n: number; ids: string | null }
    if (!row?.n || row.n < 8) continue
    ideas.push({
      id: stableId('idea', `bridge:${left}:${right}`),
      kind: 'novel',
      title: `Cross ${labelForTopic(left)} with ${labelForTopic(right)}`,
      pitch: `You repeatedly saved items that sit in both ${labelForTopic(left)} and ${labelForTopic(right)} (${row.n} memories). A novel idea in that overlap is more aligned with your actual trail than a generic AI project.`,
      evidence: (row.ids ?? '').split('|||').filter(Boolean).slice(0, 8),
      novelty: Math.min(0.9, 0.45 + Math.log1p(row.n) / 8),
      status: 'seed',
      source: 'bridge',
    })
  }

  for (const collection of collectionSizes(catalog)) {
    ideas.push({
      id: stableId('idea', `collection:${collection.name}`),
      kind: 'project',
      title: `Continue “${collection.name}”`,
      pitch: `This collection already has ${collection.n} saved items${collection.description ? ` — ${collection.description}` : ''}. Treat it as an open project and push the next concrete slice rather than starting from zero.`,
      evidence: [`collection:${collection.name}`],
      novelty: 0.4,
      status: 'seed',
      source: 'collection',
    })
  }

  const insert = assistant.prepare(`
    INSERT OR REPLACE INTO ideas(id, kind, title, pitch, evidence, novelty, status, source, updated_at)
    VALUES (@id, @kind, @title, @pitch, @evidence, @novelty, @status, @source, CURRENT_TIMESTAMP)
  `)
  const tx = assistant.transaction(() => {
    for (const idea of ideas) {
      insert.run({
        id: idea.id,
        kind: idea.kind,
        title: idea.title,
        pitch: idea.pitch,
        evidence: safeJson(idea.evidence),
        novelty: idea.novelty,
        status: idea.status,
        source: idea.source,
      })
    }
  })
  tx()
  return ideas.length
}

/** Named collections with at least `min` items, largest first. Empty when the catalog has no collections. */
function collectionSizes(catalog: import('better-sqlite3').Database, min = 4): Array<{ name: string; description: string; n: number }> {
  try {
    const rows = catalog.prepare(`
      SELECT c.name, COALESCE(c.description, '') AS description, COUNT(ci.item_id) AS n
      FROM collections c
      LEFT JOIN collection_items ci ON ci.collection_id = c.id
      GROUP BY c.id
      HAVING n >= ?
      ORDER BY n DESC
    `).all(min) as Array<{ name: string; description: string; n: number }>
    return rows.filter((row) => !/^(new folder|untitled|folder)$/i.test(row.name.trim()))
  } catch {
    return []
  }
}

function youtubeQueue(catalog: import('better-sqlite3').Database): { videos: number; transcribed: number } | null {
  try {
    return catalog.prepare(`
      SELECT COUNT(*) AS videos, COALESCE(SUM(transcript_status = 'fetched'), 0) AS transcribed
      FROM youtube_videos WHERE curation_status <> 'removed'
    `).get() as { videos: number; transcribed: number }
  } catch {
    return null
  }
}

/** Open loops read off this library's own shape: dominant and accelerating themes, big collections, the video queue. */
function deriveOpenLoops(
  catalog: import('better-sqlite3').Database,
  allThemes: Array<{ slug: string; label: string; itemCount: number; recentCount: number; velocity: number }>,
): string[] {
  const loops: string[] = []
  const themes = allThemes.filter((theme) => theme.slug !== 'unsorted')
  const [lead, ...rest] = themes
  if (lead) {
    const pillars = rest.slice(0, 2).map((theme) => theme.label)
    loops.push(`${lead.label} is the largest theme (${lead.itemCount.toLocaleString('en-US')} items)${pillars.length ? `; ${pillars.join(' and ')} are the supporting pillars` : ''}.`)
  }
  const accelerating = themes.filter((theme) => theme.recentCount >= 10 && theme.velocity >= 0.25)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 2)
  for (const theme of accelerating) {
    loops.push(`${theme.label} is accelerating: ${theme.recentCount} saves in the last 90 days (+${Math.round(theme.velocity * 100)}% over the prior 90).`)
  }
  for (const collection of collectionSizes(catalog).slice(0, 3)) {
    loops.push(`The “${collection.name}” collection (${collection.n} items) looks like an open project.`)
  }
  const queue = youtubeQueue(catalog)
  if (queue && queue.videos >= 50) {
    loops.push(`${queue.videos.toLocaleString('en-US')} saved YouTube videos form a long-form learning queue; ${queue.transcribed.toLocaleString('en-US')} have transcripts.`)
  }
  return loops
}

function writeDeterministicProfile(
  assistant: import('better-sqlite3').Database,
  catalog: import('better-sqlite3').Database,
  counts: { x: number; favorites: number; youtube: number; documents: number },
): void {
  const themes = assistant.prepare(`
    SELECT slug, label, item_count AS itemCount, recent_count AS recentCount, velocity
    FROM themes ORDER BY item_count DESC
  `).all() as Array<{ slug: string; label: string; itemCount: number; recentCount: number; velocity: number }>
  const authors = assistant.prepare(`
    SELECT author, COUNT(*) AS n FROM memories
    WHERE source_type = 'x' AND author IS NOT NULL AND author <> ''
    GROUP BY author ORDER BY n DESC LIMIT 16
  `).all() as Array<{ author: string; n: number }>
  const years = assistant.prepare(`
    SELECT substr(occurred_at, 1, 4) AS year, COUNT(*) AS n
    FROM memories WHERE occurred_at IS NOT NULL AND length(occurred_at) >= 4
    GROUP BY year ORDER BY year
  `).all() as Array<{ year: string; n: number }>
  const range = assistant.prepare(`
    SELECT MIN(occurred_at) AS firstSeen, MAX(occurred_at) AS lastSeen FROM memories
  `).get() as { firstSeen: string | null; lastSeen: string | null }

  const trajectory = {
    counts,
    range,
    years,
    themes: themes.slice(0, 10),
    authors,
    gravity: themes.filter((t) => t.slug !== 'unsorted').slice(0, 5).map((t) => t.label),
  }
  setMeta(assistant, 'trajectory', safeJson(trajectory))
  assistant.prepare(`
    INSERT INTO profile(key, content, updated_at) VALUES('trajectory', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP
  `).run(safeJson(trajectory))

  const openLoops = deriveOpenLoops(catalog, themes)
  assistant.prepare(`
    INSERT INTO profile(key, content, updated_at) VALUES('open_loops', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP
  `).run(openLoops.join('\n'))
}

function labelForTopic(slug: string): string {
  const labels: Record<string, string> = {
    'ai-ml': 'AI & Machine Learning',
    engineering: 'Software Engineering',
    'science-research': 'Science & Research',
    'learning-reference': 'Learning & Reference',
    'tools-products': 'Tools & Products',
    'people-network': 'People & Network',
    'productivity-pkm': 'Productivity & PKM',
    'product-design': 'Product & Design',
    'media-creative': 'Media & Creative',
    'startups-business': 'Startups & Business',
    'health-longevity': 'Health & Longevity',
    'news-politics': 'News & Politics',
    'finance-markets': 'Finance & Markets',
    'crypto-web3': 'Crypto & Web3',
    'security-privacy': 'Security & Privacy',
    'culture-memes': 'Culture & Memes',
    unsorted: 'Unsorted',
  }
  return labels[slug] ?? slug
}

/** Repair derived layers on an existing assistant DB without rescanning the catalog. */
export function refreshAssistantDerived(options: { catalogPath?: string; assistantPath?: string } = {}): { themesWritten: number; ideasWritten: number } {
  const catalog = openCatalogReadonly(options.catalogPath ?? config.dbPath)
  const assistant = openAssistantDb(options.assistantPath ?? config.assistantDbPath)
  try {
    promotePrimaryTopics(assistant)
    const themesWritten = rebuildThemes(assistant)
    const ideasWritten = rebuildBridgeIdeas(catalog, assistant)
    writeDeterministicProfile(assistant, catalog, catalogCounts(catalog))
    setMeta(assistant, 'built_at', new Date().toISOString())
    invalidateAssistantVectors()
    return { themesWritten, ideasWritten }
  } finally {
    catalog.close()
  }
}

export function loadAssistantStatus(assistantPath = config.assistantDbPath): ReturnType<typeof assistantStats> & { catalog?: ReturnType<typeof catalogCounts> } {
  const assistant = openAssistantDb(assistantPath)
  const stats = assistantStats(assistant)
  const raw = getMeta(assistant, 'catalog_counts')
  return {
    ...stats,
    catalog: raw ? JSON.parse(raw) as ReturnType<typeof catalogCounts> : undefined,
  }
}
