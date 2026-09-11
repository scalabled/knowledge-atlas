import type Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { YoutubeTranscript } from 'youtube-transcript'
import { config } from '../lib/env'
import { safeJson } from '../lib/hash'

export interface TranscriptResult { requested: number; fetched: number; unavailable: number; errors: number }

interface VideoRow { id: string; videoId: string }

function run(command: string, args: string[], timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out`)) }, timeoutMs)
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => { clearTimeout(timer); code === 0 || code === 1 ? resolve() : reject(new Error(stderr.trim() || `${command} exited ${code}`)) })
  })
}

function json3Text(file: string): string {
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> }
  return (json.events ?? []).flatMap((event) => event.segs ?? []).map((segment) => segment.utf8 ?? '')
    .join(' ').replace(/\s+/g, ' ').trim()
}

function saveTranscript(db: Database.Database, row: VideoRow, transcript: string, language: string): void {
  db.prepare(`UPDATE youtube_videos SET transcript=?,transcript_language=?,transcript_status='fetched',
    transcript_fetched_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(transcript, language, row.id)
}

function enrichFromInfo(db: Database.Database, row: VideoRow, file: string): void {
  if (!fs.existsSync(file)) return
  const info = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
  db.prepare(`UPDATE youtube_videos SET
    title=COALESCE(NULLIF(@title,''),title), description=COALESCE(NULLIF(@description,''),description),
    channel_id=COALESCE(@channelId,channel_id), channel_name=COALESCE(NULLIF(@channelName,''),channel_name),
    duration_seconds=COALESCE(@duration,duration_seconds), published_at=COALESCE(@publishedAt,published_at),
    view_count=COALESCE(@viewCount,view_count), thumbnail_url=COALESCE(@thumbnail,thumbnail_url),
    keywords=CASE WHEN @keywords<>'[]' THEN @keywords ELSE keywords END, updated_at=CURRENT_TIMESTAMP WHERE id=@id`)
    .run({ id: row.id, title: String(info.title ?? ''), description: String(info.description ?? ''), channelId: info.channel_id ? String(info.channel_id) : null,
      channelName: String(info.channel ?? info.uploader ?? ''), duration: info.duration == null ? null : Number(info.duration),
      publishedAt: info.upload_date ? `${String(info.upload_date).slice(0,4)}-${String(info.upload_date).slice(4,6)}-${String(info.upload_date).slice(6,8)}` : null,
      viewCount: info.view_count == null ? null : Number(info.view_count), thumbnail: info.thumbnail ? String(info.thumbnail) : null,
      keywords: safeJson(Array.isArray(info.tags) ? info.tags.map(String) : []),
    })
}

/** yt-dlp cookie source: XBG_COOKIES_BROWSER if set (`none` disables), else the crawl browser's signed-in profile. */
function cookiesFromBrowser(): string | null {
  if (config.cookiesBrowser) return config.cookiesBrowser.toLowerCase() === 'none' ? null : config.cookiesBrowser
  return config.browser === 'chromium' ? null : `${config.browser}:${config.browserProfile}`
}

async function fetchWithYtDlp(db: Database.Database, rows: VideoRow[], language: string): Promise<Set<string>> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xbg-transcripts-'))
  const fetched = new Set<string>()
  try {
    const cookies = cookiesFromBrowser()
    const args = ['-m', 'yt_dlp', ...(cookies ? ['--cookies-from-browser', cookies] : []), '--skip-download', '--ignore-no-formats-error',
      '--write-auto-subs', '--write-subs', '--write-info-json', '--sub-langs', language, '--sub-format', 'json3', '--no-playlist', '--no-progress',
      '--output', path.join(directory, '%(id)s.%(ext)s'), ...rows.map((row) => `https://www.youtube.com/watch?v=${row.videoId}`)]
    await run('python3', args)
    for (const row of rows) {
      enrichFromInfo(db, row, path.join(directory, `${row.videoId}.info.json`))
      const candidates = fs.readdirSync(directory).filter((name) => name.startsWith(`${row.videoId}.`) && name.endsWith('.json3'))
      const file = candidates.find((name) => name.includes(`.${language}.`)) ?? candidates[0]
      if (!file) continue
      const transcript = json3Text(path.join(directory, file))
      if (!transcript) continue
      saveTranscript(db, row, transcript, language)
      fetched.add(row.id)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  return fetched
}

export async function fetchYouTubeTranscripts(db: Database.Database, videoIds: string[], language = 'en'): Promise<TranscriptResult> {
  const ids = [...new Set(videoIds.map((id) => id.trim()).filter(Boolean))]
  const rows = ids.map((videoId) => db.prepare('SELECT id,video_id AS videoId FROM youtube_videos WHERE video_id=? OR id=?').get(videoId, videoId) as VideoRow | undefined).filter((row): row is VideoRow => Boolean(row))
  const result: TranscriptResult = { requested: ids.length, fetched: 0, unavailable: 0, errors: ids.length - rows.length }
  let fetched = new Set<string>()
  try { fetched = await fetchWithYtDlp(db, rows, language) } catch { /* The package fallback below handles individual failures. */ }

  result.fetched = fetched.size
  for (const row of rows) {
    if (fetched.has(row.id)) continue
    try {
      const parts = await YoutubeTranscript.fetchTranscript(row.videoId, { lang: language })
      const transcript = parts.map((part) => part.text).join(' ').replace(/\s+/g, ' ').trim()
      if (!transcript) throw new Error('No transcript')
      saveTranscript(db, row, transcript, language)
      result.fetched++
    } catch {
      db.prepare("UPDATE youtube_videos SET transcript_status='unavailable',transcript_fetched_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id)
      result.unavailable++
    }
  }
  return result
}
