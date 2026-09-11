import { chromium, type BrowserContext, type Page, type Response } from 'playwright'
import type Database from 'better-sqlite3'
import fs from 'node:fs'
import { config, type BrowserKind } from '../lib/env'
import { safeJson, stableId } from '../lib/hash'
import { browserLaunchOptions, resolveProfileDir } from './browser-profile'
import {
  extractBottomCursor,
  extractTweetsFromTimeline,
  isBookmarkTimelineResponse,
  operationNameFromUrl,
  responseId,
  normalizeTweet,
} from '../lib/x-normalizer'
import { mergeStats, refreshTagCounts, upsertBookmark } from './store'
import type { ImportStats } from '../lib/types'

interface CrawlOptions {
  browser?: BrowserKind
  profileDir?: string
  profileName?: string
  cloneProfile?: boolean
  headless?: boolean
  maxScrolls?: number
  idleRounds?: number
  delayMs?: number
  saveResponses?: boolean
  loginTimeoutMs?: number
  stopAfterExistingPages?: number
}

interface CrawlTotals extends ImportStats {
  pagesSeen: number
  tweetsSeen: number
  uniqueTweetsSeen: number
}

function nowIso(): string {
  return new Date().toISOString()
}

async function hasXAuth(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://x.com')
  return cookies.some((cookie) => cookie.name === 'auth_token' || cookie.name === 'ct0')
}

async function waitForLogin(context: BrowserContext, page: Page, timeoutMs: number): Promise<void> {
  if (await hasXAuth(context)) return

  console.log('[crawl] X login is required. Sign in inside the opened browser window.')
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(3000)
    if (await hasXAuth(context)) {
      console.log('[crawl] X session detected.')
      return
    }
  }

  throw new Error(`Timed out waiting for X login after ${Math.round(timeoutMs / 1000)}s`)
}

function createRun(db: Database.Database, options: Required<CrawlOptions>): string {
  const id = stableId('crawl', `${Date.now()}:${Math.random()}`)
  db.prepare(`
    INSERT INTO crawl_runs(id, source, status, profile_dir, metadata)
    VALUES (?, 'bookmark', 'running', ?, ?)
  `).run(id, options.profileDir, safeJson({
    browser: options.browser,
    profileName: options.profileName,
    headless: options.headless,
    maxScrolls: options.maxScrolls,
    idleRounds: options.idleRounds,
    delayMs: options.delayMs,
    saveResponses: options.saveResponses,
  }))
  return id
}

function updateRun(db: Database.Database, runId: string, totals: CrawlTotals, status = 'running', error: string | null = null): void {
  db.prepare(`
    UPDATE crawl_runs SET
      status = @status,
      pages_seen = @pagesSeen,
      tweets_seen = @tweetsSeen,
      imported_count = @imported,
      updated_count = @updated,
      duplicate_count = @duplicates,
      last_error = @error,
      finished_at = CASE WHEN @status IN ('done', 'error', 'stopped') THEN CURRENT_TIMESTAMP ELSE finished_at END
    WHERE id = @runId
  `).run({
    runId,
    status,
    pagesSeen: totals.pagesSeen,
    tweetsSeen: totals.tweetsSeen,
    imported: totals.imported,
    updated: totals.updated,
    duplicates: totals.duplicates,
    error,
  })
}

export async function crawlXBookmarks(db: Database.Database, options: CrawlOptions = {}): Promise<CrawlTotals> {
  const resolved: Required<CrawlOptions> = {
    browser: options.browser ?? config.browser,
    profileDir: options.profileDir ?? config.xProfileDir,
    profileName: options.profileName ?? config.browserProfile,
    cloneProfile: options.cloneProfile ?? true,
    headless: options.headless ?? false,
    maxScrolls: options.maxScrolls ?? 10000,
    idleRounds: options.idleRounds ?? 60,
    delayMs: options.delayMs ?? 1400,
    saveResponses: options.saveResponses ?? false,
    loginTimeoutMs: options.loginTimeoutMs ?? 10 * 60_000,
    stopAfterExistingPages: options.stopAfterExistingPages ?? 0,
  }

  resolved.profileDir = resolveProfileDir({
    browser: resolved.browser,
    profileDir: options.profileDir,
    profileName: resolved.profileName,
    clone: resolved.cloneProfile,
    cloneLabel: resolved.browser,
    chromiumDir: config.xProfileDir,
  })

  fs.mkdirSync(resolved.profileDir, { recursive: true })
  const runId = createRun(db, resolved)
  const totals: CrawlTotals = {
    imported: 0,
    updated: 0,
    duplicates: 0,
    skipped: 0,
    pagesSeen: 0,
    tweetsSeen: 0,
    uniqueTweetsSeen: 0,
  }
  const seenTweetIds = new Set<string>()
  const pendingResponses = new Set<Promise<void>>()
  let consecutiveExistingPages = 0
  let reachedExistingBoundary = false

  const context = await chromium.launchPersistentContext(resolved.profileDir, {
    ...browserLaunchOptions(resolved.browser, resolved.profileName),
    headless: resolved.headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  })

  const page = context.pages()[0] ?? await context.newPage()

  async function handleResponse(response: Response): Promise<void> {
    const url = response.url()
    if (!/\/i\/api\/graphql\/|\/graphql\//.test(url)) return

    let data: unknown
    try {
      data = await response.json()
    } catch {
      return
    }

    if (!isBookmarkTimelineResponse(url, data)) return

    const tweets = extractTweetsFromTimeline(data)
    if (tweets.length === 0) return

    const body = resolved.saveResponses ? JSON.stringify(data) : '{}'
    const cursor = extractBottomCursor(data)
    const op = operationNameFromUrl(url)

    const stats = db.transaction(() => {
      if (resolved.saveResponses) {
        db.prepare(`
          INSERT OR IGNORE INTO raw_responses(id, crawl_run_id, url, operation_name, tweets_found, cursor, json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(responseId(url, body), runId, url, op, tweets.length, cursor, body)
      }

      let batchStats: ImportStats = { imported: 0, updated: 0, duplicates: 0, skipped: 0 }
      for (const rawTweet of tweets) {
        const normalized = normalizeTweet(rawTweet, 'bookmark')
        if (!normalized) {
          batchStats.skipped++
          continue
        }
        seenTweetIds.add(normalized.tweetId)
        batchStats = mergeStats(batchStats, upsertBookmark(db, normalized))
      }
      refreshTagCounts(db)
      return batchStats
    })()

    totals.pagesSeen++
    totals.tweetsSeen += tweets.length
    totals.uniqueTweetsSeen = seenTweetIds.size
    totals.imported += stats.imported
    totals.updated += stats.updated
    totals.duplicates += stats.duplicates
    totals.skipped += stats.skipped
    if (stats.imported === 0 && stats.updated + stats.duplicates > 0) consecutiveExistingPages++
    else if (stats.imported > 0) consecutiveExistingPages = 0
    reachedExistingBoundary = resolved.stopAfterExistingPages > 0 && consecutiveExistingPages >= resolved.stopAfterExistingPages
    updateRun(db, runId, totals)

    console.log(`[crawl] ${nowIso()} page=${totals.pagesSeen} tweets=${totals.uniqueTweetsSeen} imported=${totals.imported} updated=${totals.updated} dup=${totals.duplicates}`)
  }

  page.on('response', (response) => {
    let task: Promise<void>
    task = handleResponse(response)
      .catch((err) => {
        console.warn(`[crawl] response parse failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => pendingResponses.delete(task))
    pendingResponses.add(task)
  })

  try {
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitForLogin(context, page, resolved.loginTimeoutMs)
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(5000)

    let idle = 0
    let lastPagesSeen = totals.pagesSeen
    let lastUniqueSeen = totals.uniqueTweetsSeen
    let lastHeight = 0

    for (let i = 0; i < resolved.maxScrolls; i++) {
      if (reachedExistingBoundary) {
        console.log(`[crawl] reached ${consecutiveExistingPages} consecutive existing-only pages; incremental sync is complete.`)
        break
      }
      await page.evaluate(() => {
        window.scrollBy({ top: Math.max(window.innerHeight * 2.5, 1600), behavior: 'instant' })
      })
      await page.waitForTimeout(resolved.delayMs + Math.round(Math.random() * 450))

      const metrics = await page.evaluate(() => ({
        y: window.scrollY,
        height: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        articles: document.querySelectorAll('article').length,
      }))

      const newNetworkData = totals.pagesSeen > lastPagesSeen || totals.uniqueTweetsSeen > lastUniqueSeen
      const heightChanged = Math.abs(metrics.height - lastHeight) > 20
      const nearBottom = metrics.y + metrics.innerHeight >= metrics.height - 80

      if (newNetworkData || heightChanged || !nearBottom) {
        idle = 0
      } else {
        idle++
      }

      lastPagesSeen = totals.pagesSeen
      lastUniqueSeen = totals.uniqueTweetsSeen
      lastHeight = metrics.height

      if (i > 5 && idle >= resolved.idleRounds) {
        console.log(`[crawl] stopping after ${idle} idle rounds; likely reached the end of bookmarks.`)
        break
      }
    }

    await Promise.allSettled([...pendingResponses])
    updateRun(db, runId, totals, 'done')
    return totals
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateRun(db, runId, totals, 'error', message)
    throw err
  } finally {
    await context.close()
  }
}
