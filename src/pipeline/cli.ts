#!/usr/bin/env tsx
import fs from 'node:fs'
import path from 'node:path'
import { closeDb, initDb, openDb } from '../lib/db'
import { config, parseBrowser } from '../lib/env'
import { rebuildGraph } from './graph'
import { backfillEmbeddings, embeddingReport } from './embed-backfill'
import { rebuildSemanticEdgesFromStored } from './placement'
import { importSiftlyDatabase } from './siftly-import'
import { importFavoritesHtml } from './favorites-import'
import { classifyAll, classifyYouTubeAll } from './classifier'
import { fetchPendingLinks, reopenSeededPendingLinks, seedLinkMetadataFromBookmarks, summarizeLinks } from './links'
import { describeMedia } from './media-describer'
import { crawlXBookmarks } from './x-crawler'
import { rebuildFts } from './store'
import { crawlYouTube, DEFAULT_YOUTUBE_PLAYLISTS, parsePlaylistSpec } from './youtube-crawler'
import { fetchYouTubeTranscripts } from './youtube-transcripts'

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

function numFlag(flags: Record<string, string | boolean>, key: string, fallback: number): number {
  const raw = flags[key]
  if (typeof raw !== 'string') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function strFlag(flags: Record<string, string | boolean>, key: string, fallback: string): string {
  const raw = flags[key]
  return typeof raw === 'string' && raw.trim() ? raw : fallback
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Shared crawler browser flags. --edge-profile / --no-clone-edge-profile are kept for older commands. */
function browserFlags(flags: Record<string, string | boolean>) {
  return {
    browser: parseBrowser(typeof flags.browser === 'string' ? flags.browser : undefined, config.browser),
    profileDir: typeof flags.profile === 'string' ? flags.profile : undefined,
    profileName: strFlag(flags, 'browser-profile', strFlag(flags, 'edge-profile', config.browserProfile)),
    cloneProfile: flags['no-clone-profile'] !== true && flags['no-clone-edge-profile'] !== true,
  }
}

function defaultSiftlyPath(): string {
  return path.resolve(process.cwd(), '../Siftly/prisma/dev.db')
}

function stats(db = openDb()) {
  const get = (sql: string) => (db.prepare(sql).get() as { count: number }).count
  return {
    dbPath: config.dbPath,
    bookmarks: get("SELECT COUNT(*) AS count FROM bookmarks WHERE source <> 'import' AND author_handle <> 'browser-favorites'"),
    favorites: get("SELECT COUNT(*) AS count FROM bookmarks WHERE source = 'import' OR author_handle = 'browser-favorites'"),
    authors: get('SELECT COUNT(*) AS count FROM authors'),
    media: get('SELECT COUNT(*) AS count FROM media_items'),
    mediaDescribed: get("SELECT COUNT(*) AS count FROM media_items WHERE image_summary IS NOT NULL AND image_summary <> ''"),
    links: get('SELECT COUNT(*) AS count FROM links'),
    pendingLinks: get("SELECT COUNT(*) AS count FROM links WHERE status = 'pending'"),
    fetchedLinks: get("SELECT COUNT(*) AS count FROM links WHERE status IN ('fetched', 'summarized')"),
    summarizedLinks: get("SELECT COUNT(*) AS count FROM links WHERE status = 'summarized'"),
    linksWithArticle: get("SELECT COUNT(*) AS count FROM links WHERE article_text IS NOT NULL AND length(article_text) > 100"),
    topics: get('SELECT COUNT(*) AS count FROM topics'),
    tags: get('SELECT COUNT(*) AS count FROM tags'),
    graphNodes: get('SELECT COUNT(*) AS count FROM graph_nodes'),
    graphEdges: get('SELECT COUNT(*) AS count FROM graph_edges'),
    correlations: get("SELECT COUNT(*) AS count FROM graph_edges WHERE type = 'correlates_with'"),
    youtubeVideos: get('SELECT COUNT(*) AS count FROM youtube_videos'),
    youtubePlaylists: get('SELECT COUNT(*) AS count FROM youtube_playlists'),
    youtubeTranscripts: get("SELECT COUNT(*) AS count FROM youtube_videos WHERE transcript_status = 'fetched'"),
    documents: get("SELECT COUNT(*) AS count FROM documents WHERE curation_status <> 'removed'"),
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0] ?? 'help'
  const db = openDb()
  initDb(db)

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      print({
        usage: 'tsx src/pipeline/cli.ts <command> [flags]',
        commands: {
          init: 'Initialize the database',
          'import-siftly': 'Import ../Siftly/prisma/dev.db or --source <path>',
          'import-favorites': 'Import a Netscape bookmarks HTML export from Chrome/Edge/Firefox/Safari (--source path, default ./favorites.html)',
          'crawl-x': 'Collect bookmarks from X with Playwright (--browser chromium|chrome|edge, --browser-profile NAME)',
          'crawl-youtube': 'Collect YouTube playlists (--playlists WL,PLxxxx=Name or XBG_YOUTUBE_PLAYLISTS; default Watch Later)',
          'youtube-transcripts': 'Fetch transcripts for --ids <comma-separated YouTube IDs>',
          links: 'Fetch and summarize linked articles',
          'media-describe': 'Describe media with alt text and optional Anthropic vision',
          classify: 'Assign local topics and semantic tags',
          'build-graph': 'Rebuild graph nodes, edges, and FTS',
          embed: 'Backfill MiniLM embeddings for content nodes (--limit N, --dtype q8|fp32, --refresh-edges, --report)',
          enrich: 'Fetch/summarize links, describe media, classify, rebuild graph',
          catalog: 'Run import-siftly, links, classify, and build-graph',
          stats: 'Print database counts',
        },
      })
      return
    }

    if (command === 'init') {
      print({ ok: true, dbPath: config.dbPath })
      return
    }

    if (command === 'import-siftly') {
      const source = strFlag(flags, 'source', defaultSiftlyPath())
      const result = importSiftlyDatabase(db, source)
      rebuildFts(db)
      print({ source, ...result, stats: stats(db) })
      return
    }

    if (command === 'import-favorites') {
      const source = strFlag(flags, 'source', path.resolve(process.cwd(), 'favorites.html'))
      const result = importFavoritesHtml(db, source)
      rebuildFts(db)
      print({ ...result, stats: stats(db) })
      return
    }

    if (command === 'crawl-x') {
      const result = await crawlXBookmarks(db, {
        ...browserFlags(flags),
        headless: Boolean(flags.headless) && !flags.headed,
        maxScrolls: numFlag(flags, 'max-scrolls', 10000),
        idleRounds: numFlag(flags, 'idle-rounds', 60),
        delayMs: numFlag(flags, 'delay-ms', 1400),
        loginTimeoutMs: numFlag(flags, 'login-timeout-ms', 10 * 60_000),
        stopAfterExistingPages: numFlag(flags, 'stop-after-existing-pages', 0),
        saveResponses: Boolean(flags['save-responses']),
      })
      const classified = classifyAll(db)
      const graph = rebuildGraph(db)
      print({ crawl: result, classified, graph, stats: stats(db) })
      return
    }

    if (command === 'crawl-youtube') {
      const playlists = flags['skip-playlists'] === true ? []
        : typeof flags.playlists === 'string' ? parsePlaylistSpec(flags.playlists, DEFAULT_YOUTUBE_PLAYLISTS)
          : DEFAULT_YOUTUBE_PLAYLISTS
      const crawl = await crawlYouTube(db, {
        ...browserFlags(flags),
        loginTimeoutMs: numFlag(flags, 'login-timeout-ms', 10 * 60_000),
        headless: Boolean(flags.headless) && !flags.headed,
        maxScrolls: numFlag(flags, 'max-scrolls', 1200),
        idleRounds: numFlag(flags, 'idle-rounds', 12),
        delayMs: numFlag(flags, 'delay-ms', 1000),
        enrich: flags['no-enrich'] !== true,
        downloadThumbnails: flags['no-thumbnails'] !== true,
        concurrency: numFlag(flags, 'concurrency', 8),
        playlists,
      })
      const classified = classifyYouTubeAll(db)
      const graph = rebuildGraph(db)
      print({ crawl, classified, graph, stats: stats(db) })
      return
    }

    if (command === 'youtube-transcripts') {
      const ids = strFlag(flags, 'ids', '').split(',').map((item) => item.trim()).filter(Boolean)
      if (!ids.length) throw new Error('Pass --ids with one or more comma-separated YouTube video IDs')
      const transcripts = await fetchYouTubeTranscripts(db, ids, typeof flags.language === 'string' ? flags.language : undefined)
      const classified = classifyYouTubeAll(db)
      const graph = rebuildGraph(db)
      print({ transcripts, classified, graph, stats: stats(db) })
      return
    }

    if (command === 'links') {
      const limit = numFlag(flags, 'limit', 100)
      const concurrency = numFlag(flags, 'concurrency', 5)
      const reopened = flags.reopen ? reopenSeededPendingLinks(db) : { reopened: 0 }
      const seeded = seedLinkMetadataFromBookmarks(db)
      const fetched = await fetchPendingLinks(db, limit, concurrency)
      const summarized = await summarizeLinks(db, Math.min(limit, 50))
      const seededAfter = seedLinkMetadataFromBookmarks(db)
      rebuildFts(db)
      print({ reopened, seeded, fetched, summarized, seededAfter, stats: stats(db) })
      return
    }

    if (command === 'media-describe') {
      const limit = numFlag(flags, 'limit', 25)
      const concurrency = numFlag(flags, 'concurrency', 2)
      const result = await describeMedia(db, {
        limit,
        concurrency,
        includeAltText: flags['no-alt-text'] !== true,
      })
      rebuildFts(db)
      print({ ...result, stats: stats(db) })
      return
    }

    if (command === 'classify') {
      const limit = numFlag(flags, 'limit', 0)
      const result = classifyAll(db, limit)
      const youtube = classifyYouTubeAll(db, limit)
      rebuildFts(db)
      print({ ...result, youtube, stats: stats(db) })
      return
    }

    if (command === 'build-graph') {
      const result = rebuildGraph(db)
      print({ ...result, stats: stats(db) })
      return
    }

    if (command === 'embed') {
      const limit = numFlag(flags, 'limit', 0)
      const dtype: 'fp32' | 'q8' = strFlag(flags, 'dtype', 'fp32') === 'q8' ? 'q8' : 'fp32'
      const result = await backfillEmbeddings(db, { limit, dtype })
      const edges = flags['refresh-edges'] ? rebuildSemanticEdgesFromStored(db) : undefined
      const report = flags.report ? embeddingReport(db) ?? undefined : undefined
      print({ ...result, edges, report })
      return
    }

    if (command === 'enrich') {
      const linkLimit = numFlag(flags, 'link-limit', 500)
      const mediaLimit = numFlag(flags, 'media-limit', 50)
      const concurrency = numFlag(flags, 'concurrency', 5)
      const seeded = seedLinkMetadataFromBookmarks(db)
      const fetched = await fetchPendingLinks(db, linkLimit, concurrency)
      const summarized = await summarizeLinks(db, Math.min(linkLimit, 120))
      const seededAfter = seedLinkMetadataFromBookmarks(db)
      const media = await describeMedia(db, {
        limit: mediaLimit,
        concurrency: Math.min(2, concurrency),
        includeAltText: flags['no-alt-text'] !== true,
      })
      const classified = classifyAll(db)
      const youtube = classifyYouTubeAll(db)
      const graph = rebuildGraph(db)
      print({ seeded, fetched, summarized, seededAfter, media, classified, youtube, graph, stats: stats(db) })
      return
    }

    if (command === 'catalog') {
      const source = strFlag(flags, 'source', defaultSiftlyPath())
      let imported = null
      if (fs.existsSync(source)) {
        imported = importSiftlyDatabase(db, source)
      }
      const favoritesPath = typeof flags.favorites === 'string' ? flags.favorites : ''
      let favorites = null
      if (favoritesPath && fs.existsSync(favoritesPath)) {
        favorites = importFavoritesHtml(db, favoritesPath)
      }
      const linkLimit = numFlag(flags, 'link-limit', 200)
      const fetched = await fetchPendingLinks(db, linkLimit, numFlag(flags, 'concurrency', 5))
      const summarized = await summarizeLinks(db, Math.min(linkLimit, 80))
      const classified = classifyAll(db)
      const graph = rebuildGraph(db)
      print({ imported, favorites, fetched, summarized, classified, graph, stats: stats(db) })
      return
    }

    if (command === 'stats') {
      print(stats(db))
      return
    }

    throw new Error(`Unknown command: ${command}`)
  } finally {
    closeDb()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
