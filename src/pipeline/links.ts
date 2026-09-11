import Anthropic from '@anthropic-ai/sdk'
import { Readability } from '@mozilla/readability'
import type Database from 'better-sqlite3'
import { JSDOM, VirtualConsole } from 'jsdom'
import { config } from '../lib/env'
import { safeJson, slugify } from '../lib/hash'

interface LinkRow {
  id: string
  url: string
  expandedUrl: string | null
  domain: string | null
  title: string | null
  description: string | null
  articleText: string | null
}

function domainFor(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function metaContent(doc: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const node = doc.querySelector(selector)
    const content = node?.getAttribute('content')?.trim()
    if (content) return content
  }
  return null
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractTags(text: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'you', 'are', 'not', 'but', 'have', 'has', 'was', 'were', 'will', 'about', 'into', 'more', 'than', 'their', 'there', 'which'])
  const counts = new Map<string, number>()
  for (const word of text.toLowerCase().split(/[^a-z0-9+#.-]+/i)) {
    const cleaned = slugify(word).replace(/-/g, ' ')
    if (cleaned.length < 3 || stop.has(cleaned) || /^\d+$/.test(cleaned)) continue
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 18)
    .map(([tag]) => tag)
}

function extractiveSummary(title: string | null, text: string): { summary: string; tags: string[] } {
  const sentences = compactText(text)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 40)
    .slice(0, 4)
  const lead = sentences.join(' ').slice(0, 900)
  return {
    summary: compactText([title, lead].filter(Boolean).join(' - ')).slice(0, 1000),
    tags: extractTags(`${title ?? ''} ${text}`),
  }
}

async function fetchOne(row: LinkRow): Promise<{
  status: 'fetched' | 'skipped' | 'error'
  url: string
  canonicalUrl: string | null
  domain: string | null
  title: string | null
  description: string | null
  siteName: string | null
  contentType: string | null
  articleText: string | null
  errorMessage: string | null
}> {
  const url = row.expandedUrl ?? row.url
  if (!/^https?:\/\//i.test(url)) {
    return {
      status: 'skipped',
      url,
      canonicalUrl: null,
      domain: row.domain,
      title: null,
      description: null,
      siteName: null,
      contentType: null,
      articleText: null,
      errorMessage: 'Non-HTTP URL',
    }
  }

  const domain = domainFor(url)
  if (domain && /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(domain)) {
    return {
      status: 'skipped',
      url,
      canonicalUrl: url,
      domain,
      title: null,
      description: null,
      siteName: null,
      contentType: null,
      articleText: null,
      errorMessage: 'Internal X/Twitter URL',
    }
  }

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(12000),
    })

    const contentType = res.headers.get('content-type') ?? ''
    const finalUrl = res.url || url
    const finalDomain = domainFor(finalUrl)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    if (!contentType.toLowerCase().includes('html')) {
      return {
        status: 'fetched',
        url,
        canonicalUrl: finalUrl,
        domain: finalDomain,
        title: null,
        description: null,
        siteName: null,
        contentType,
        articleText: null,
        errorMessage: null,
      }
    }

    const html = await res.text()
    try {
      const virtualConsole = new VirtualConsole()
      virtualConsole.on('jsdomError', () => {})
      const dom = new JSDOM(html, {
        url: finalUrl,
        virtualConsole,
        // Avoid executing remote scripts/styles that blow up on CSS custom properties
        runScripts: undefined,
        resources: undefined,
      })
      const doc = dom.window.document
      const readable = new Readability(doc).parse()

      const title =
        readable?.title?.trim() ||
        metaContent(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
        doc.title?.trim() ||
        null
      const description =
        readable?.excerpt?.trim() ||
        metaContent(doc, ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]'])
      const siteName = metaContent(doc, ['meta[property="og:site_name"]'])
      const canonicalUrl =
        doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
        metaContent(doc, ['meta[property="og:url"]']) ||
        finalUrl
      const articleText = compactText(readable?.textContent ?? doc.body?.textContent ?? '').slice(0, 60000)

      dom.window.close()

      return {
        status: 'fetched',
        url,
        canonicalUrl,
        domain: domainFor(canonicalUrl) ?? finalDomain,
        title,
        description,
        siteName,
        contentType,
        articleText,
        errorMessage: null,
      }
    } catch (parseErr) {
      // Fall back to lightweight regex extraction when JSDOM/Readability choke
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      const ogTitle = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
        ?? html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i)
      const ogDesc = html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
        ?? html.match(/name=["']description["'][^>]*content=["']([^"']+)["']/i)
      return {
        status: 'fetched',
        url,
        canonicalUrl: finalUrl,
        domain: finalDomain,
        title: compactText(ogTitle?.[1] || titleMatch?.[1] || '') || null,
        description: compactText(ogDesc?.[1] || '') || null,
        siteName: null,
        contentType,
        articleText: compactText(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).slice(0, 20000) || null,
        errorMessage: parseErr instanceof Error ? `parse-fallback: ${parseErr.message.slice(0, 200)}` : null,
      }
    }
  } catch (err) {
    return {
      status: 'error',
      url,
      canonicalUrl: null,
      domain,
      title: null,
      description: null,
      siteName: null,
      contentType: null,
      articleText: null,
      errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    }
  }
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]
      await worker(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Fill titles/summaries from the parent bookmark when page fetch is unavailable.
 * - pending/fetched: only backfill missing title (keep status so real fetch/summary can run)
 * - error/skipped: finalize a bookmark-title summary so the graph still has context
 */
export function seedLinkMetadataFromBookmarks(db: Database.Database): { seeded: number; finalized: number } {
  const rows = db.prepare(`
    SELECT l.id, l.url, l.domain, l.title, l.summary, l.status, l.article_text AS articleText,
           b.text AS bookmarkText
    FROM links l
    JOIN bookmarks b ON b.id = l.bookmark_id
    WHERE (l.title IS NULL OR l.summary IS NULL OR l.status IN ('error', 'skipped'))
  `).all() as Array<{
    id: string
    url: string
    domain: string | null
    title: string | null
    summary: string | null
    status: string
    articleText: string | null
    bookmarkText: string
  }>

  const updateTitleOnly = db.prepare(`
    UPDATE links SET
      title = COALESCE(title, @title),
      description = COALESCE(description, @description),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `)

  const finalize = db.prepare(`
    UPDATE links SET
      title = COALESCE(title, @title),
      description = COALESCE(description, @description),
      summary = COALESCE(summary, @summary),
      tags = COALESCE(tags, @tags),
      status = 'summarized',
      summarized_at = COALESCE(summarized_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `)

  let seeded = 0
  let finalized = 0
  const tx = db.transaction(() => {
    for (const row of rows) {
      const titleLine = compactText(row.bookmarkText.split('\n')[0] || '')
      const title = row.title || (titleLine && titleLine !== row.url ? titleLine : row.domain) || row.url
      const description = row.domain ? `Saved page on ${row.domain}` : null

      // Still waiting on a real page fetch — only fill the display title
      if (row.status === 'pending' || (row.status === 'fetched' && !row.summary)) {
        if (!row.title) {
          updateTitleOnly.run({ id: row.id, title, description })
          seeded++
        }
        continue
      }

      // Failed/skipped fetches: finalize with bookmark metadata so correlations still work
      if (row.status === 'error' || row.status === 'skipped' || (!row.summary && !row.articleText)) {
        const local = extractiveSummary(title, `${description ?? ''}\n${row.bookmarkText}\n${row.url}`)
        finalize.run({
          id: row.id,
          title,
          description,
          summary: row.summary || local.summary,
          tags: safeJson(local.tags),
        })
        finalized++
      }
    }
  })
  tx()
  return { seeded, finalized }
}

/** Re-open seeded-only summaries so page fetch can still enrich article text. */
export function reopenSeededPendingLinks(db: Database.Database): { reopened: number } {
  const result = db.prepare(`
    UPDATE links
    SET status = 'pending',
        summary = NULL,
        tags = NULL,
        summarized_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'summarized'
      AND article_text IS NULL
      AND fetched_at IS NULL
      AND (summary LIKE '%Folder:%' OR description LIKE 'Saved page on %')
  `).run()
  return { reopened: result.changes }
}

export async function fetchPendingLinks(db: Database.Database, limit = 100, concurrency = 5): Promise<{ fetched: number; skipped: number; errors: number }> {
  // Bulk-skip internal X/Twitter links so they don't waste the fetch quota
  db.prepare(`
    UPDATE links
    SET status = 'skipped',
        error_message = 'Internal X/Twitter URL',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
      AND (
        domain IN ('x.com', 'twitter.com', 't.co', 'mobile.twitter.com')
        OR url LIKE 'https://x.com/%'
        OR url LIKE 'https://twitter.com/%'
        OR url LIKE 'https://t.co/%'
      )
  `).run()

  // Prefer never-tried pending rows; avoid endlessly re-hammering permanent errors
  const rows = db.prepare(`
    SELECT id, url, expanded_url AS expandedUrl, domain, title, description, article_text AS articleText
    FROM links
    WHERE (
      status = 'pending'
      OR (status = 'error' AND fetched_at IS NULL)
      OR (status = 'error' AND error_message LIKE 'HTTP 429%')
      OR (status = 'error' AND error_message LIKE '%timeout%')
    )
    AND COALESCE(domain, '') NOT IN ('x.com', 'twitter.com', 't.co', 'mobile.twitter.com')
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, updated_at ASC
    LIMIT ?
  `).all(limit) as LinkRow[]

  let fetched = 0
  let skipped = 0
  let errors = 0
  const update = db.prepare(`
    UPDATE links SET
      canonical_url = COALESCE(@canonicalUrl, canonical_url),
      domain = COALESCE(@domain, domain),
      title = COALESCE(@title, title),
      description = COALESCE(@description, description),
      site_name = COALESCE(@siteName, site_name),
      content_type = COALESCE(@contentType, content_type),
      article_text = COALESCE(@articleText, article_text),
      status = @status,
      error_message = @errorMessage,
      fetched_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `)

  // Resolve bookmark titles for error fallbacks
  const bookmarkTitle = db.prepare(`
    SELECT b.text AS text FROM links l JOIN bookmarks b ON b.id = l.bookmark_id WHERE l.id = ?
  `)

  await runPool(rows, concurrency, async (row) => {
    const result = await fetchOne(row)
    if (result.status === 'error' || result.status === 'skipped') {
      const parent = bookmarkTitle.get(row.id) as { text: string } | undefined
      if (parent?.text && !result.title) {
        const titleLine = compactText(parent.text.split('\n')[0] || '')
        if (titleLine && titleLine !== row.url) result.title = titleLine
      }
    }
    update.run({ id: row.id, ...result })
    if (result.status === 'fetched') fetched++
    else if (result.status === 'skipped') skipped++
    else errors++
  })

  return { fetched, skipped, errors }
}

async function aiSummaries(rows: LinkRow[]): Promise<Array<{ id: string; summary: string; tags: string[] }>> {
  if (!config.anthropicApiKey) return []

  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  const payload = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    text: (row.articleText ?? '').slice(0, 5000),
  }))

  const prompt = `Summarize linked articles for a personal X bookmark graph. Return only valid JSON.

For each item:
- summary: 2-4 compact sentences focused on why the link is useful
- tags: 12-20 specific searchable tags, including proper nouns and technical terms

Items:
${JSON.stringify(payload, null, 2)}

Return:
[{"id":"...","summary":"...","tags":["..."]}]`

  const message = await client.messages.create({
    model: config.anthropicModel,
    // Thinking counts toward max_tokens on current models; low effort suits summarization.
    max_tokens: 16000,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content.find((part) => part.type === 'text')?.text ?? ''
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []

  const parsed = JSON.parse(match[0]) as Array<Record<string, unknown>>
  return parsed
    .map((item) => ({
      id: String(item.id ?? ''),
      summary: String(item.summary ?? ''),
      tags: Array.isArray(item.tags) ? item.tags.map(String).filter(Boolean) : [],
    }))
    .filter((item) => item.id && item.summary)
}

export async function summarizeLinks(db: Database.Database, limit = 40): Promise<{ summarized: number; fallback: number }> {
  const rows = db.prepare(`
    SELECT id, url, expanded_url AS expandedUrl, domain, title, description, article_text AS articleText
    FROM links
    WHERE status = 'fetched'
      AND summary IS NULL
      AND (
        article_text IS NOT NULL OR title IS NOT NULL OR description IS NOT NULL
      )
    ORDER BY fetched_at ASC
    LIMIT ?
  `).all(limit) as LinkRow[]

  if (rows.length === 0) return { summarized: 0, fallback: 0 }

  const update = db.prepare(`
    UPDATE links SET
      summary = @summary,
      tags = @tags,
      status = 'summarized',
      summarized_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `)

  let summarized = 0
  let fallback = 0
  const aiById = new Map<string, { summary: string; tags: string[] }>()

  if (config.anthropicApiKey) {
    const batchSize = 5
    for (let i = 0; i < rows.length; i += batchSize) {
      try {
        const result = await aiSummaries(rows.slice(i, i + batchSize))
        for (const item of result) aiById.set(item.id, item)
      } catch (err) {
        console.warn(`[links] AI summary batch failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  for (const row of rows) {
    const ai = aiById.get(row.id)
    if (ai) {
      update.run({ id: row.id, summary: ai.summary, tags: safeJson(ai.tags) })
      summarized++
      continue
    }

    const local = extractiveSummary(row.title, `${row.description ?? ''}\n${row.articleText ?? ''}`)
    update.run({ id: row.id, summary: local.summary, tags: safeJson(local.tags) })
    fallback++
  }

  return { summarized, fallback }
}
