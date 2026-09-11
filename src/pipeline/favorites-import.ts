import type Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { stableId } from '../lib/hash'
import type { ImportStats, NormalizedBookmark, NormalizedLink } from '../lib/types'
import { mergeStats, refreshTagCounts, upsertBookmark } from './store'

export interface FavoriteEntry {
  url: string
  title: string
  folderPath: string[]
  addDate: string | null
  icon: string | null
}

function domainFor(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function isImportableUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const parsed = new URL(url)
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) return false
    return true
  } catch {
    return false
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
}

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
    ?? attrs.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'))
  return match ? decodeHtmlEntities(match[1]) : null
}

/** Parse Netscape Bookmark HTML exports (Chrome/Edge/Firefox favorites). */
export function parseNetscapeFavorites(html: string): FavoriteEntry[] {
  const entries: FavoriteEntry[] = []
  const folderStack: string[] = []
  const tokenRe = /<(H3|A|\/DL)\b([^>]*)>(?:([^<]*)<\/\1>)?/gi
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(html)) !== null) {
    const tag = match[1].toUpperCase()
    const attrs = match[2] ?? ''
    const text = decodeHtmlEntities((match[3] ?? '').trim())

    if (tag === 'H3') {
      if (text) folderStack.push(text)
      continue
    }

    if (tag === '/DL') {
      if (folderStack.length) folderStack.pop()
      continue
    }

    if (tag === 'A') {
      const href = attr(attrs, 'HREF')
      if (!href || !isImportableUrl(href)) continue
      entries.push({
        url: href,
        title: text || href,
        folderPath: [...folderStack],
        addDate: attr(attrs, 'ADD_DATE'),
        icon: attr(attrs, 'ICON'),
      })
    }
  }

  return entries
}

function tweetCreatedAtFromUnix(addDate: string | null): string | null {
  if (!addDate) return null
  const seconds = Number(addDate)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

function favoriteToBookmark(entry: FavoriteEntry): NormalizedBookmark {
  const domain = domainFor(entry.url)
  const folderLabel = entry.folderPath.filter(Boolean).join(' / ') || 'Favorites'
  const text = [entry.title, folderLabel !== 'Favorites' ? `Folder: ${folderLabel}` : null, entry.url]
    .filter(Boolean)
    .join('\n')
  const tweetId = `fav-${stableId('url', entry.url).replace(/^url:/, '')}`
  const link: NormalizedLink = {
    id: stableId('link', `${tweetId}:${entry.url}`),
    url: entry.url,
    expandedUrl: entry.url,
    domain,
  }

  return {
    id: stableId('bookmark', tweetId),
    tweetId,
    text,
    author: {
      id: stableId('author', 'browser-favorites'),
      handle: 'browser-favorites',
      name: 'Browser Favorites',
    },
    tweetCreatedAt: tweetCreatedAtFromUnix(entry.addDate),
    rawJson: JSON.stringify({
      source: 'favorites',
      title: entry.title,
      url: entry.url,
      folderPath: entry.folderPath,
      addDate: entry.addDate,
      hasIcon: Boolean(entry.icon),
    }),
    source: 'import',
    hashtags: [],
    mentions: [],
    urls: [link],
    media: [],
  }
}

export function importFavoritesHtml(db: Database.Database, sourcePath: string): ImportStats & {
  source: string
  parsed: number
  uniqueUrls: number
  folders: number
} {
  const resolved = path.resolve(sourcePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`Favorites HTML not found: ${resolved}`)
  }

  const html = fs.readFileSync(resolved, 'utf8')
  const entries = parseNetscapeFavorites(html)
  const byUrl = new Map<string, FavoriteEntry>()
  for (const entry of entries) {
    const key = entry.url.trim()
    const existing = byUrl.get(key)
    if (!existing || entry.folderPath.length > existing.folderPath.length) {
      byUrl.set(key, entry)
    }
  }

  let stats: ImportStats = { imported: 0, updated: 0, duplicates: 0, skipped: 0 }
  const folders = new Set<string>()
  const collectionCache = new Map<string, string>()

  const ensureCollection = db.prepare(`
    INSERT INTO collections(id, name, description, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `)
  const addToCollection = db.prepare(`
    INSERT OR IGNORE INTO collection_items(collection_id, item_type, item_id, note)
    VALUES (?, 'x', ?, ?)
  `)
  const addFolderTag = db.prepare(`
    INSERT INTO tags(tag, kind, count)
    VALUES (?, 'folder', 0)
    ON CONFLICT(tag) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `)
  const addBookmarkTag = db.prepare(`
    INSERT INTO bookmark_tags(bookmark_id, tag, source, weight)
    VALUES (?, ?, 'folder', ?)
    ON CONFLICT(bookmark_id, tag, source) DO UPDATE SET weight = excluded.weight
  `)

  const tx = db.transaction(() => {
    for (const entry of byUrl.values()) {
      const normalized = favoriteToBookmark(entry)
      stats = mergeStats(stats, upsertBookmark(db, normalized))

      // Folder path → tags + leaf collection for navigation
      for (let i = 0; i < entry.folderPath.length; i++) {
        const segment = entry.folderPath[i].trim()
        if (!segment || /^(favorites bar|bookmarks bar|bookmarks|other bookmarks)$/i.test(segment)) continue
        const folderTag = `folder:${segment.toLowerCase().slice(0, 60)}`
        folders.add(segment)
        addFolderTag.run(folderTag)
        addBookmarkTag.run(normalized.id, folderTag, 1.1)

        // Leaf folder becomes a collection for browsing
        if (i === entry.folderPath.length - 1) {
          let collectionId = collectionCache.get(segment)
          if (!collectionId) {
            collectionId = stableId('collection', `favorites:${segment.toLowerCase()}`)
            ensureCollection.run(
              collectionId,
              segment.slice(0, 80),
              `Imported from browser favorites folder: ${entry.folderPath.join(' / ')}`,
              '#0ea5e9',
            )
            collectionCache.set(segment, collectionId)
          }
          addToCollection.run(collectionId, normalized.id, entry.title.slice(0, 200))
        }
      }

      // Always tag as browser favorite for filtering
      addFolderTag.run('browser-favorite')
      addBookmarkTag.run(normalized.id, 'browser-favorite', 0.9)
    }
    refreshTagCounts(db)
  })

  tx()

  return {
    source: resolved,
    parsed: entries.length,
    uniqueUrls: byUrl.size,
    folders: folders.size,
    ...stats,
  }
}
