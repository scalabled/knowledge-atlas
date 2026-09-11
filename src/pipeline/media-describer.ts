import Anthropic from '@anthropic-ai/sdk'
import type Database from 'better-sqlite3'
import { config } from '../lib/env'
import { safeJson } from '../lib/hash'

interface MediaRow {
  id: string
  type: string
  url: string
  thumbnailUrl: string | null
  altText: string | null
  bookmarkText: string
  authorHandle: string
}

interface VisionDescription {
  summary: string
  tags: string[]
}

interface DescribeMediaOptions {
  limit?: number
  concurrency?: number
  includeAltText?: boolean
}

interface DescribeMediaResult {
  described: number
  altTextFallbacks: number
  skipped: number
  errors: number
  missingApiKey: boolean
}

const TAG_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'you', 'are', 'was', 'were',
  'have', 'has', 'had', 'but', 'not', 'what', 'when', 'where', 'why', 'how', 'about', 'into',
  'more', 'than', 'they', 'them', 'their', 'there', 'here', 'been', 'would', 'should', 'could',
  'image', 'photo', 'video', 'picture', 'screenshot', 'showing', 'shows', 'shown', 'tweet',
  'post', 'person', 'people', 'thing', 'things', 'text', 'link', 'links', 'xcom', 'twitter',
])

function cleanSummary(value: string, max = 360): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function tagsFromText(value: string): string[] {
  const counts = new Map<string, number>()
  for (const token of value.toLowerCase().split(/[^a-z0-9+#.@-]+/i)) {
    const tag = token.replace(/^[@#]/, '').trim()
    if (tag.length < 3 || tag.length > 32 || TAG_STOPWORDS.has(tag) || /^\d+$/.test(tag)) continue
    counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([tag]) => tag)
}

function chooseMediaUrl(row: MediaRow): string {
  if (row.type === 'photo') return row.url
  return row.thumbnailUrl || row.url
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
type ImageMediaType = typeof IMAGE_TYPES[number]

function isImageType(value: string): value is ImageMediaType {
  return (IMAGE_TYPES as readonly string[]).includes(value)
}

async function downloadImage(url: string): Promise<{ mediaType: ImageMediaType; data: string } | null> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'x-bookmark-graph/0.1 media-describer',
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5',
    },
  })
  if (!response.ok) return null

  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!isImageType(mediaType)) return null

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > 5_000_000) return null
  return { mediaType, data: bytes.toString('base64') }
}

function parseDescription(text: string): VisionDescription {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { summary?: unknown; tags?: unknown }
      const summary = typeof parsed.summary === 'string' ? cleanSummary(parsed.summary) : ''
      const tags = Array.isArray(parsed.tags)
        ? parsed.tags.map((tag) => String(tag).toLowerCase().trim()).filter(Boolean).slice(0, 12)
        : tagsFromText(summary)
      if (summary) return { summary, tags }
    } catch {
      // Fall through to plain-text parsing.
    }
  }
  const summary = cleanSummary(text)
  return { summary, tags: tagsFromText(summary) }
}

async function describeWithAnthropic(row: MediaRow): Promise<VisionDescription | null> {
  const image = await downloadImage(chooseMediaUrl(row))
  if (!image) return null

  const prompt = [
    'Describe this X bookmark media for a local search graph.',
    'Return strict JSON with keys "summary" and "tags".',
    'Use concrete visual nouns, entities, domains, tools, places, and topics.',
    'Avoid filler tags such as image, photo, screenshot, text, tweet, post, thing, or people.',
    `Media type: ${row.type}. Author: @${row.authorHandle}.`,
    `Bookmark context: ${row.bookmarkText.slice(0, 900)}`,
  ].join('\n')

  const client = new Anthropic({ apiKey: config.anthropicApiKey })
  const response = await client.messages.create({
    model: config.anthropicModel,
    // Thinking counts toward max_tokens on current models; low effort suits short descriptions.
    max_tokens: 16000,
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  })

  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n').trim()
  return text ? parseDescription(text) : null
}

function pendingRows(db: Database.Database, limit: number): MediaRow[] {
  return db.prepare(`
    SELECT
      m.id,
      m.type,
      m.url,
      m.thumbnail_url AS thumbnailUrl,
      m.alt_text AS altText,
      b.text AS bookmarkText,
      b.author_handle AS authorHandle
    FROM media_items m
    JOIN bookmarks b ON b.id = m.bookmark_id
    WHERE COALESCE(m.image_summary, '') = ''
      AND m.status NOT IN ('described', 'skipped')
    ORDER BY
      CASE WHEN COALESCE(m.alt_text, '') <> '' THEN 0 ELSE 1 END,
      m.created_at ASC
    LIMIT ?
  `).all(limit) as MediaRow[]
}

function saveDescription(db: Database.Database, id: string, description: VisionDescription, status = 'described'): void {
  db.prepare(`
    UPDATE media_items
    SET image_summary = @summary,
        image_tags = @tags,
        status = @status,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id,
    summary: description.summary,
    tags: safeJson(description.tags),
    status,
  })
}

function markStatus(db: Database.Database, id: string, status: string): void {
  db.prepare(`
    UPDATE media_items
    SET status = @status,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id, status })
}

export async function describeMedia(db: Database.Database, options: DescribeMediaOptions = {}): Promise<DescribeMediaResult> {
  const limit = Math.max(1, options.limit ?? 25)
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 6))
  const rows = pendingRows(db, limit)
  const result: DescribeMediaResult = {
    described: 0,
    altTextFallbacks: 0,
    skipped: 0,
    errors: 0,
    missingApiKey: !config.anthropicApiKey,
  }

  const remaining: MediaRow[] = []
  if (options.includeAltText !== false) {
    for (const row of rows) {
      const altText = cleanSummary(row.altText ?? '')
      if (!altText) {
        remaining.push(row)
        continue
      }
      saveDescription(db, row.id, { summary: altText, tags: tagsFromText(altText) }, 'described')
      result.altTextFallbacks++
    }
  } else {
    remaining.push(...rows)
  }

  if (!config.anthropicApiKey) {
    result.skipped += remaining.length
    return result
  }

  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const row = remaining[cursor++]
      if (!row) return
      try {
        const description = await describeWithAnthropic(row)
        if (!description) {
          markStatus(db, row.id, 'skipped')
          result.skipped++
          continue
        }
        saveDescription(db, row.id, description)
        result.described++
      } catch {
        markStatus(db, row.id, 'error')
        result.errors++
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, remaining.length) }, () => worker()))
  return result
}
