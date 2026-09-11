import { chromium, type APIRequestContext, type BrowserContext, type Page } from 'playwright'
import type Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config, type BrowserKind } from '../lib/env'
import { safeJson, stableId } from '../lib/hash'
import { browserLabel, browserLaunchOptions, resolveProfileDir } from './browser-profile'

export interface YouTubePlaylistSource {
  playlistId: string
  name: string
  sourceType: 'watch-later' | 'playlist'
}

interface CrawlYouTubeOptions {
  browser?: BrowserKind
  profileDir?: string
  profileName?: string
  cloneProfile?: boolean
  loginTimeoutMs?: number
  headless?: boolean
  maxScrolls?: number
  idleRounds?: number
  delayMs?: number
  enrich?: boolean
  downloadThumbnails?: boolean
  concurrency?: number
  playlists?: YouTubePlaylistSource[]
}

interface PlaylistVideo {
  videoId: string
  title: string
  channelName: string
  channelUrl: string | null
  thumbnailUrl: string | null
  durationSeconds: number | null
  position: number
  raw: Record<string, unknown>
}

interface PlayerDetails {
  videoId: string
  title: string
  description: string
  channelId: string | null
  channelName: string
  durationSeconds: number | null
  viewCount: number | null
  thumbnailUrl: string | null
  keywords: string[]
  publishedAt: string | null
  raw: Record<string, unknown>
}

export interface CrawlYouTubeResult {
  playlists: number
  discovered: number
  uniqueVideos: number
  imported: number
  updated: number
  enriched: number
  thumbnailsSaved: number
  errors: number
}

/** Parse `WL,PLxxxx=Name` (flag or XBG_YOUTUBE_PLAYLISTS). WL is Watch Later; unnamed IDs reuse a known name. */
export function parsePlaylistSpec(spec: string, known: YouTubePlaylistSource[] = []): YouTubePlaylistSource[] {
  return spec.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry, index) => {
    const [rawId, ...rest] = entry.split('=')
    const playlistId = rawId.trim()
    const name = rest.join('=').trim() || known.find((item) => item.playlistId === playlistId)?.name
    return playlistId === 'WL'
      ? { playlistId, name: name || 'Watch Later', sourceType: 'watch-later' as const }
      : { playlistId, name: name || `Playlist ${index + 1}`, sourceType: 'playlist' as const }
  })
}

export const DEFAULT_YOUTUBE_PLAYLISTS: YouTubePlaylistSource[] = parsePlaylistSpec(config.youtubePlaylists)

function parseDuration(value: string): number | null {
  const parts = value.trim().split(':').map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

async function hasYouTubeAuth(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://www.youtube.com')
  return cookies.some((cookie) => ['SAPISID', '__Secure-3PAPISID', 'SID'].includes(cookie.name))
}

function upsertPlaylist(db: Database.Database, source: YouTubePlaylistSource, count: number | null): string {
  const id = stableId('youtube-playlist', source.playlistId)
  db.prepare(`
    INSERT INTO youtube_playlists(id, playlist_id, name, source_type, video_count, last_synced_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(playlist_id) DO UPDATE SET
      name = excluded.name,
      source_type = excluded.source_type,
      video_count = COALESCE(excluded.video_count, youtube_playlists.video_count),
      last_synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, source.playlistId, source.name, source.sourceType, count)
  return id
}

function upsertVideo(db: Database.Database, video: PlaylistVideo): 'imported' | 'updated' | 'duplicate' {
  const id = stableId('youtube-video', video.videoId)
  const existing = db.prepare('SELECT title, channel_name AS channelName, thumbnail_url AS thumbnailUrl FROM youtube_videos WHERE video_id = ?')
    .get(video.videoId) as { title: string; channelName: string; thumbnailUrl: string | null } | undefined
  db.prepare(`
    INSERT INTO youtube_videos(id, video_id, title, channel_name, channel_url, duration_seconds, thumbnail_url, raw_json)
    VALUES (@id, @videoId, @title, @channelName, @channelUrl, @durationSeconds, @thumbnailUrl, @rawJson)
    ON CONFLICT(video_id) DO UPDATE SET
      title = excluded.title,
      channel_name = CASE WHEN excluded.channel_name <> '' THEN excluded.channel_name ELSE youtube_videos.channel_name END,
      channel_url = COALESCE(excluded.channel_url, youtube_videos.channel_url),
      duration_seconds = COALESCE(excluded.duration_seconds, youtube_videos.duration_seconds),
      thumbnail_url = COALESCE(excluded.thumbnail_url, youtube_videos.thumbnail_url),
      raw_json = excluded.raw_json,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id,
    videoId: video.videoId,
    title: video.title,
    channelName: video.channelName,
    channelUrl: video.channelUrl,
    durationSeconds: video.durationSeconds,
    thumbnailUrl: video.thumbnailUrl,
    rawJson: safeJson(video.raw),
  })
  if (!existing) return 'imported'
  return existing.title !== video.title || existing.channelName !== video.channelName || existing.thumbnailUrl !== video.thumbnailUrl
    ? 'updated'
    : 'duplicate'
}

function connectPlaylistItem(db: Database.Database, playlistDbId: string, videoId: string, position: number): void {
  const videoDbId = stableId('youtube-video', videoId)
  db.prepare(`
    INSERT INTO youtube_playlist_items(playlist_id, video_id, position)
    VALUES (?, ?, ?)
    ON CONFLICT(playlist_id, video_id) DO UPDATE SET position = excluded.position, updated_at = CURRENT_TIMESTAMP
  `).run(playlistDbId, videoDbId, position)
}

async function visiblePlaylistVideos(page: Page): Promise<PlaylistVideo[]> {
  return page.locator('ytd-playlist-video-renderer').evaluateAll((rows) => rows.map((row, index) => {
    const title = row.querySelector<HTMLAnchorElement>('#video-title')
    const channel = row.querySelector<HTMLAnchorElement>('ytd-channel-name a')
    const image = row.querySelector<HTMLImageElement>('ytd-thumbnail img')
    const duration = row.querySelector<HTMLElement>('ytd-thumbnail-overlay-time-status-renderer #text')
    const indexText = row.querySelector<HTMLElement>('#index')?.innerText?.trim() ?? ''
    const href = title?.href ?? ''
    const videoId = new URL(href || 'https://www.youtube.com').searchParams.get('v') ?? ''
    const rawPosition = Number(indexText.replace(/[^0-9]/g, ''))
    return {
      videoId,
      title: title?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      channelName: channel?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      channelUrl: channel?.href ?? null,
      thumbnailUrl: image?.currentSrc || image?.src || null,
      durationText: duration?.innerText?.replace(/\s+/g, '').trim() ?? '',
      position: Number.isFinite(rawPosition) && rawPosition > 0 ? rawPosition : index + 1,
    }
  })).then((rows) => rows.filter((row) => row.videoId && row.title).map((row) => ({
    videoId: row.videoId,
    title: row.title,
    channelName: row.channelName,
    channelUrl: row.channelUrl,
    thumbnailUrl: row.thumbnailUrl,
    durationSeconds: parseDuration(row.durationText),
    position: row.position,
    raw: row,
  })))
}

async function collectPlaylist(page: Page, source: YouTubePlaylistSource, options: Required<Pick<CrawlYouTubeOptions, 'maxScrolls' | 'idleRounds' | 'delayMs'>>): Promise<{ videos: PlaylistVideo[]; expected: number | null }> {
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(source.playlistId)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(() => document.querySelectorAll('ytd-playlist-video-renderer #video-title').length > 0, undefined, { timeout: 60_000 })
  await page.waitForTimeout(2500)

  const expected = await page.evaluate(() => {
    const text = document.body.innerText.match(/([\d,]+)\s+videos/i)?.[1]
    return text ? Number(text.replace(/,/g, '')) : null
  })
  const videos = new Map<string, PlaylistVideo>()
  let idle = 0
  let lastHeight = 0

  for (let scroll = 0; scroll < options.maxScrolls; scroll++) {
    for (const video of await visiblePlaylistVideos(page)) videos.set(video.videoId, video)
    if (expected && videos.size >= expected) break

    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
    await page.waitForTimeout(options.delayMs)
    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight)
    idle = currentHeight <= height && currentHeight <= lastHeight ? idle + 1 : 0
    lastHeight = currentHeight
    if (scroll % 10 === 0) console.log(`[youtube] ${source.name}: ${videos.size}${expected ? `/${expected}` : ''}`)
    if (idle >= options.idleRounds) break
  }

  for (const video of await visiblePlaylistVideos(page)) videos.set(video.videoId, video)
  return { videos: [...videos.values()].sort((a, b) => a.position - b.position), expected }
}

function chooseThumbnail(thumbnails: Array<{ url?: string; width?: number }> | undefined): string | null {
  return [...(thumbnails ?? [])].sort((a, b) => Number(b.width ?? 0) - Number(a.width ?? 0))[0]?.url ?? null
}

async function fetchPlayerDetails(request: APIRequestContext, apiKey: string, clientVersion: string, videoId: string): Promise<PlayerDetails | null> {
  const response = await request.post(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
    data: {
      videoId,
      context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
      contentCheckOk: true,
      racyCheckOk: true,
    },
    timeout: 30_000,
  })
  if (!response.ok()) return null
  const json = await response.json() as Record<string, any>
  const details = json.videoDetails
  if (!details?.videoId) return null
  const micro = json.microformat?.playerMicroformatRenderer ?? {}
  return {
    videoId: String(details.videoId),
    title: String(details.title ?? ''),
    description: String(details.shortDescription ?? ''),
    channelId: details.channelId ? String(details.channelId) : null,
    channelName: String(details.author ?? ''),
    durationSeconds: details.lengthSeconds ? Number(details.lengthSeconds) : null,
    viewCount: details.viewCount ? Number(details.viewCount) : null,
    thumbnailUrl: chooseThumbnail(details.thumbnail?.thumbnails),
    keywords: Array.isArray(details.keywords) ? details.keywords.map(String) : [],
    publishedAt: micro.publishDate ? String(micro.publishDate) : null,
    raw: { videoDetails: details, microformat: micro },
  }
}

function savePlayerDetails(db: Database.Database, details: PlayerDetails): void {
  db.prepare(`
    UPDATE youtube_videos SET
      title = CASE WHEN @title <> '' THEN @title ELSE title END,
      description = @description,
      channel_id = @channelId,
      channel_name = CASE WHEN @channelName <> '' THEN @channelName ELSE channel_name END,
      channel_url = CASE WHEN @channelId IS NOT NULL THEN 'https://www.youtube.com/channel/' || @channelId ELSE channel_url END,
      duration_seconds = COALESCE(@durationSeconds, duration_seconds),
      published_at = COALESCE(@publishedAt, published_at),
      view_count = COALESCE(@viewCount, view_count),
      thumbnail_url = COALESCE(@thumbnailUrl, thumbnail_url),
      keywords = @keywords,
      raw_json = @rawJson,
      updated_at = CURRENT_TIMESTAMP
    WHERE video_id = @videoId
  `).run({
    ...details,
    keywords: safeJson(details.keywords),
    rawJson: safeJson(details.raw),
  })
}

async function saveThumbnail(videoId: string, url: string): Promise<string | null> {
  const response = await fetch(url)
  if (!response.ok) return null
  const contentType = response.headers.get('content-type') ?? ''
  const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
  const relative = path.join('data', 'youtube-thumbnails', `${videoId}.${extension}`)
  const absolute = path.resolve(process.cwd(), relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, Buffer.from(await response.arrayBuffer()))
  return relative
}

export async function crawlYouTube(db: Database.Database, options: CrawlYouTubeOptions = {}): Promise<CrawlYouTubeResult> {
  const browser = options.browser ?? config.browser
  const profileName = options.profileName ?? config.browserProfile
  const profileDir = resolveProfileDir({
    browser,
    profileDir: options.profileDir,
    profileName,
    clone: options.cloneProfile ?? true,
    cloneLabel: `${browser}-youtube`,
    chromiumDir: config.youtubeProfileDir,
  })

  const resolved = {
    maxScrolls: options.maxScrolls ?? 1200,
    idleRounds: options.idleRounds ?? 12,
    delayMs: options.delayMs ?? 1000,
    enrich: options.enrich ?? true,
    downloadThumbnails: options.downloadThumbnails ?? true,
    concurrency: Math.max(1, Math.min(options.concurrency ?? 8, 16)),
    playlists: options.playlists ?? DEFAULT_YOUTUBE_PLAYLISTS,
  }
  const result: CrawlYouTubeResult = { playlists: 0, discovered: 0, uniqueVideos: 0, imported: 0, updated: 0, enriched: 0, thumbnailsSaved: 0, errors: 0 }
  const context = await chromium.launchPersistentContext(profileDir, {
    ...browserLaunchOptions(browser, profileName),
    headless: options.headless ?? false,
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
  })
  const page = context.pages()[0] ?? await context.newPage()

  try {
    await page.goto('https://www.youtube.com/playlist?list=WL', { waitUntil: 'domcontentloaded', timeout: 90_000 })
    if (!(await hasYouTubeAuth(context))) {
      if (options.headless) throw new Error(`YouTube login was not found in the ${browserLabel(browser)} profile. Run once without --headless and sign in.`)
      console.log('[youtube] YouTube login is required. Sign in inside the opened browser window.')
      const timeoutMs = options.loginTimeoutMs ?? 10 * 60_000
      const started = Date.now()
      while (!(await hasYouTubeAuth(context))) {
        if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for YouTube login after ${Math.round(timeoutMs / 1000)}s`)
        await page.waitForTimeout(3000)
      }
      await page.goto('https://www.youtube.com/playlist?list=WL', { waitUntil: 'domcontentloaded', timeout: 90_000 })
    }

    const unique = new Set<string>()
    for (const source of resolved.playlists) {
      const collected = await collectPlaylist(page, source, resolved)
      const playlistDbId = upsertPlaylist(db, source, collected.expected ?? collected.videos.length)
      db.transaction(() => {
        for (const video of collected.videos) {
          const state = upsertVideo(db, video)
          if (state === 'imported') result.imported++
          else if (state === 'updated') result.updated++
          connectPlaylistItem(db, playlistDbId, video.videoId, video.position)
          unique.add(video.videoId)
        }
      })()
      result.playlists++
      result.discovered += collected.videos.length
      console.log(`[youtube] ${source.name}: stored ${collected.videos.length}`)
    }
    result.uniqueVideos = unique.size

    const pendingEnrichment = (db.prepare("SELECT COUNT(*) AS count FROM youtube_videos WHERE curation_status <> 'removed' AND COALESCE(description, '') = ''").get() as { count: number }).count
    if (resolved.enrich && (unique.size || pendingEnrichment)) {
      const ytcfg = await page.evaluate(() => {
        const cfg = (window as any).ytcfg?.data_ ?? {}
        return { apiKey: String(cfg.INNERTUBE_API_KEY ?? ''), clientVersion: String(cfg.INNERTUBE_CLIENT_VERSION ?? '') }
      })
      if (!ytcfg.apiKey || !ytcfg.clientVersion) throw new Error('Could not read YouTube player configuration')

      const ids = (db.prepare(`SELECT video_id AS videoId FROM youtube_videos WHERE curation_status <> 'removed' AND COALESCE(description, '') = '' ORDER BY imported_at`).all() as Array<{ videoId: string }>).map((row) => row.videoId)
      let cursor = 0
      const worker = async () => {
        for (;;) {
          const videoId = ids[cursor++]
          if (!videoId) return
          try {
            await new Promise((resolve) => setTimeout(resolve, 180 + Math.round(Math.random() * 220)))
            const details = await fetchPlayerDetails(context.request, ytcfg.apiKey, ytcfg.clientVersion, videoId)
            if (!details) { result.errors++; continue }
            savePlayerDetails(db, details)
            result.enriched++
            if (resolved.downloadThumbnails && details.thumbnailUrl) {
              const localPath = await saveThumbnail(videoId, details.thumbnailUrl)
              if (localPath) {
                db.prepare('UPDATE youtube_videos SET local_thumbnail_path = ?, updated_at = CURRENT_TIMESTAMP WHERE video_id = ?').run(localPath, videoId)
                result.thumbnailsSaved++
              }
            }
            if (result.enriched % 100 === 0) console.log(`[youtube] enriched ${result.enriched}/${ids.length}`)
          } catch (error) {
            result.errors++
            console.warn(`[youtube] ${videoId}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(resolved.concurrency, ids.length) }, () => worker()))
    }
  } finally {
    await context.close()
  }
  return result
}
