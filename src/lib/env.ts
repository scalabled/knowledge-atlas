import dotenv from 'dotenv'
import path from 'node:path'

dotenv.config()

export const rootDir = path.resolve(process.cwd())

/** chromium = Playwright's bundled browser with its own login; chrome/edge = clone your signed-in profile. */
export type BrowserKind = 'chromium' | 'chrome' | 'edge'

export function parseBrowser(value: string | undefined, fallback: BrowserKind = 'chromium'): BrowserKind {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'chromium' || normalized === 'chrome' || normalized === 'edge') return normalized
  if (normalized === 'msedge') return 'edge'
  return fallback
}

function resolveLocal(value: string, fallback: string): string {
  const chosen = value.trim() || fallback
  return path.isAbsolute(chosen) ? chosen : path.resolve(rootDir, chosen)
}

export const config = {
  dbPath: resolveLocal(process.env.XBG_DB ?? '', './data/bookmarks.db'),
  assistantDbPath: resolveLocal(process.env.XBG_ASSISTANT_DB ?? '', './data/assistant.db'),
  apiPort: Number(process.env.XBG_API_PORT ?? 4177),
  webOrigin: process.env.XBG_WEB_ORIGIN ?? 'http://127.0.0.1:5173',
  xProfileDir: resolveLocal(process.env.XBG_X_PROFILE ?? '', './profiles/x'),
  youtubeProfileDir: resolveLocal(process.env.XBG_YOUTUBE_PROFILE ?? '', './profiles/youtube'),
  browser: parseBrowser(process.env.XBG_BROWSER),
  browserProfile: process.env.XBG_BROWSER_PROFILE?.trim() || 'Default',
  /** yt-dlp --cookies-from-browser value (e.g. chrome:Default); empty derives it from XBG_BROWSER, `none` disables. */
  cookiesBrowser: process.env.XBG_COOKIES_BROWSER?.trim() || '',
  /** Comma-separated playlist IDs, optionally `ID=Name`. WL is Watch Later. */
  youtubePlaylists: process.env.XBG_YOUTUBE_PLAYLISTS?.trim() || 'WL',
  assistantProvider: process.env.XBG_ASSISTANT_PROVIDER?.trim().toLowerCase() || 'auto',
  youtubeThumbnailDir: resolveLocal(process.env.XBG_YOUTUBE_THUMBNAILS ?? '', './data/youtube-thumbnails'),
  modelsDir: resolveLocal(process.env.XBG_MODELS ?? '', './data/models'),
  documentsDir: resolveLocal(process.env.XBG_DOCUMENTS ?? '', './data/documents'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
  anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5',
  xaiApiKey: process.env.XAI_API_KEY?.trim() || '',
  xaiModel: process.env.XAI_MODEL?.trim() || 'grok-4.6',
  xaiBaseUrl: (process.env.XAI_BASE_URL?.trim() || 'https://api.x.ai/v1').replace(/\/$/, ''),
}
