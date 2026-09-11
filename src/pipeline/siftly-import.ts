import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type { ImportStats, NormalizedMedia } from '../lib/types'
import { stableId } from '../lib/hash'
import { syntheticTweetFromSiftlyRow } from '../lib/x-normalizer'
import { mergeStats, refreshTagCounts, upsertBookmark } from './store'

interface SiftlyBookmarkRow {
  id: string
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: string | null
  rawJson: string
  source: string | null
}

interface SiftlyMediaRow {
  type: string
  url: string
  thumbnailUrl: string | null
}

export function importSiftlyDatabase(targetDb: Database.Database, sourcePath: string): ImportStats {
  const resolved = path.resolve(sourcePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`Siftly database not found: ${resolved}`)
  }

  const source = new Database(resolved, { readonly: true, fileMustExist: true })
  let stats: ImportStats = { imported: 0, updated: 0, duplicates: 0, skipped: 0 }

  const rows = source.prepare(`
    SELECT id, tweetId, text, authorHandle, authorName, tweetCreatedAt, rawJson, source
    FROM Bookmark
    ORDER BY COALESCE(tweetCreatedAt, importedAt) DESC
  `).all() as SiftlyBookmarkRow[]

  const mediaStmt = source.prepare(`
    SELECT type, url, thumbnailUrl
    FROM MediaItem
    WHERE bookmarkId = ?
  `)

  const tx = targetDb.transaction(() => {
    for (const row of rows) {
      const normalized = syntheticTweetFromSiftlyRow({ ...row, source: row.source ?? undefined })
      if (!normalized) {
        stats = mergeStats(stats, { imported: 0, updated: 0, duplicates: 0, skipped: 1 })
        continue
      }

      if (normalized.media.length === 0) {
        const mediaRows = mediaStmt.all(row.id) as SiftlyMediaRow[]
        normalized.media = mediaRows
          .filter((m) => m.url)
          .map((m): NormalizedMedia => ({
            id: stableId('media', `${row.tweetId}:${m.url}`),
            type: m.type === 'video' ? 'video' : m.type === 'gif' ? 'gif' : 'photo',
            url: m.url,
            thumbnailUrl: m.thumbnailUrl,
          }))
      }

      stats = mergeStats(stats, upsertBookmark(targetDb, normalized))
    }
    refreshTagCounts(targetDb)
  })

  tx()
  source.close()
  return stats
}
