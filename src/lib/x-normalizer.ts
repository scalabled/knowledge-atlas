import { stableHash, stableId } from './hash'
import type { NormalizedBookmark, NormalizedLink, NormalizedMedia } from './types'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getRecord(obj: unknown, key: string): JsonRecord | null {
  if (!isRecord(obj)) return null
  const value = obj[key]
  return isRecord(value) ? value : null
}

function getArray(obj: unknown, key: string): unknown[] {
  if (!isRecord(obj)) return []
  const value = obj[key]
  return Array.isArray(value) ? value : []
}

function getString(obj: unknown, key: string): string | null {
  if (!isRecord(obj)) return null
  const value = obj[key]
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number') return String(value)
  return null
}

function nested(obj: unknown, path: string[]): unknown {
  let cur = obj
  for (const key of path) {
    if (!isRecord(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

function nestedRecord(obj: unknown, path: string[]): JsonRecord | null {
  const value = nested(obj, path)
  return isRecord(value) ? value : null
}

function nestedString(obj: unknown, path: string[]): string | null {
  const value = nested(obj, path)
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number') return String(value)
  return null
}

function parseTwitterDate(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function domainFor(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function unwrapTweetResult(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null

  const type = getString(value, '__typename')
  if (type === 'TweetWithVisibilityResults') {
    return unwrapTweetResult(value.tweet)
  }

  if (isRecord(value.result)) return unwrapTweetResult(value.result)
  if (isRecord(value.tweet) && !getString(value, 'rest_id')) return unwrapTweetResult(value.tweet)

  const tweetId = getString(value, 'rest_id') ?? getString(value, 'id_str') ?? getString(value, 'id')
  if (!tweetId) return null
  return value
}

function collectEntriesFromInstructions(data: unknown): JsonRecord[] {
  const paths = [
    ['data', 'bookmark_timeline_v2', 'timeline', 'instructions'],
    ['data', 'bookmark_timeline', 'timeline', 'instructions'],
    ['data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions'],
    ['data', 'liked_tweets_timeline', 'timeline', 'instructions'],
  ]

  const entries: JsonRecord[] = []
  for (const path of paths) {
    const instructions = nested(data, path)
    if (!Array.isArray(instructions)) continue

    for (const instruction of instructions) {
      if (!isRecord(instruction)) continue
      for (const entry of getArray(instruction, 'entries')) {
        if (isRecord(entry)) entries.push(entry)
      }
      const entry = getRecord(instruction, 'entry')
      if (entry) entries.push(entry)
    }
  }

  return entries
}

function collectTweetResultsFromEntry(entry: JsonRecord, out: JsonRecord[]): void {
  const content = getRecord(entry, 'content')
  const entryId = getString(entry, 'entryId') ?? ''

  const itemContent = getRecord(content, 'itemContent')
  const tweetResult = nestedRecord(itemContent, ['tweet_results', 'result'])
  const tweet = unwrapTweetResult(tweetResult)
  if (tweet) {
    out.push(tweet)
    return
  }

  for (const item of getArray(content, 'items')) {
    const itemRecord = isRecord(item) ? item : null
    const nestedItemContent =
      nestedRecord(itemRecord, ['item', 'itemContent']) ??
      nestedRecord(itemRecord, ['itemContent'])
    const nestedTweet = unwrapTweetResult(nestedRecord(nestedItemContent, ['tweet_results', 'result']))
    if (nestedTweet) out.push(nestedTweet)
  }

  if (entryId.startsWith('tweet-')) {
    const fallback = unwrapTweetResult(nestedRecord(entry, ['content', 'itemContent', 'tweet_results', 'result']))
    if (fallback) out.push(fallback)
  }
}

function collectTweetResultsFallback(value: unknown, out: JsonRecord[], seen: Set<string>): void {
  if (!isRecord(value) && !Array.isArray(value)) return

  if (Array.isArray(value)) {
    for (const item of value) collectTweetResultsFallback(item, out, seen)
    return
  }

  const result = nestedRecord(value, ['tweet_results', 'result'])
  const tweet = unwrapTweetResult(result)
  if (tweet) {
    const id = getString(tweet, 'rest_id') ?? getString(tweet, 'id_str') ?? getString(tweet, 'id')
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(tweet)
    }
  }

  for (const child of Object.values(value)) {
    collectTweetResultsFallback(child, out, seen)
  }
}

export function extractTweetsFromTimeline(data: unknown): JsonRecord[] {
  const entries = collectEntriesFromInstructions(data)
  const tweets: JsonRecord[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const before = tweets.length
    collectTweetResultsFromEntry(entry, tweets)
    for (const tweet of tweets.slice(before)) {
      const id = getString(tweet, 'rest_id') ?? getString(tweet, 'id_str') ?? getString(tweet, 'id')
      if (!id || seen.has(id)) {
        tweets.pop()
      } else {
        seen.add(id)
      }
    }
  }

  if (tweets.length > 0) return tweets

  const fallback: JsonRecord[] = []
  collectTweetResultsFallback(data, fallback, seen)
  return fallback
}

export function extractBottomCursor(data: unknown): string | null {
  const entries = collectEntriesFromInstructions(data)
  for (const entry of entries) {
    const content = getRecord(entry, 'content')
    if (!content) continue
    if (
      getString(content, 'entryType') === 'TimelineTimelineCursor' &&
      getString(content, 'cursorType') === 'Bottom'
    ) {
      return getString(content, 'value')
    }
  }
  return null
}

function bestVideoUrl(media: JsonRecord): string | null {
  const variants = nested(media, ['video_info', 'variants'])
  if (!Array.isArray(variants)) return null

  const mp4 = variants
    .filter(isRecord)
    .filter((v) => getString(v, 'content_type') === 'video/mp4' && getString(v, 'url'))
    .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))

  return getString(mp4[0], 'url')
}

function extractMedia(tweetId: string, tweet: JsonRecord): NormalizedMedia[] {
  const legacy = getRecord(tweet, 'legacy') ?? tweet
  const entities = getRecord(legacy, 'extended_entities') ?? getRecord(legacy, 'entities')
  const media = getArray(entities, 'media').filter(isRecord)

  return media
    .map((item): NormalizedMedia | null => {
      const originalInfo = getRecord(item, 'original_info')
      const rawType = getString(item, 'type')
      const thumbnail = getString(item, 'media_url_https') ?? getString(item, 'media_url')
      const type: NormalizedMedia['type'] =
        rawType === 'video' ? 'video' : rawType === 'animated_gif' ? 'gif' : 'photo'

      const url = type === 'photo' ? thumbnail : bestVideoUrl(item) ?? thumbnail
      if (!url) return null

      return {
        id: stableId('media', `${tweetId}:${url}`),
        type,
        url,
        thumbnailUrl: thumbnail,
        altText: getString(item, 'ext_alt_text'),
        width: typeof originalInfo?.width === 'number' ? originalInfo.width : null,
        height: typeof originalInfo?.height === 'number' ? originalInfo.height : null,
      }
    })
    .filter((item): item is NormalizedMedia => item !== null)
}

function extractUrls(tweetId: string, tweet: JsonRecord): NormalizedLink[] {
  const legacy = getRecord(tweet, 'legacy') ?? tweet
  const urls = getArray(getRecord(legacy, 'entities'), 'urls').filter(isRecord)
  return urls
    .map((item): NormalizedLink | null => {
      const url = getString(item, 'expanded_url') ?? getString(item, 'url')
      if (!url) return null
      const expandedUrl = getString(item, 'expanded_url') ?? url
      return {
        id: stableId('link', `${tweetId}:${expandedUrl}`),
        url,
        expandedUrl,
        displayUrl: getString(item, 'display_url'),
        domain: domainFor(expandedUrl),
      }
    })
    .filter((item): item is NormalizedLink => item !== null)
}

function extractHashtags(tweet: JsonRecord): string[] {
  const legacy = getRecord(tweet, 'legacy') ?? tweet
  const hashtags = getArray(getRecord(legacy, 'entities'), 'hashtags').filter(isRecord)
  return [...new Set(
    hashtags
      .map((item) => (getString(item, 'text') ?? getString(item, 'tag') ?? '').toLowerCase())
      .filter(Boolean),
  )]
}

function extractMentions(tweet: JsonRecord): string[] {
  const legacy = getRecord(tweet, 'legacy') ?? tweet
  const mentions = getArray(getRecord(legacy, 'entities'), 'user_mentions').filter(isRecord)
  return [...new Set(
    mentions
      .map((item) => (getString(item, 'screen_name') ?? getString(item, 'username') ?? '').toLowerCase())
      .filter(Boolean),
  )]
}

function extractAuthor(tweet: JsonRecord) {
  const user =
    nestedRecord(tweet, ['core', 'user_results', 'result']) ??
    nestedRecord(tweet, ['user_results', 'result']) ??
    getRecord(tweet, 'user') ??
    {}
  const core = getRecord(user, 'core')
  const avatar = getRecord(user, 'avatar')
  const legacy = getRecord(user, 'legacy') ?? user

  const handle = (
    getString(core, 'screen_name') ??
    getString(legacy, 'screen_name') ??
    getString(legacy, 'username') ??
    'unknown'
  ).replace(/^@/, '')
  const name = getString(core, 'name') ?? getString(legacy, 'name') ?? handle ?? 'Unknown'
  const profileImageUrl =
    getString(avatar, 'image_url') ??
    getString(legacy, 'profile_image_url_https') ??
    getString(legacy, 'profile_image_url')

  return {
    id: stableId('author', handle.toLowerCase()),
    handle,
    name,
    profileImageUrl,
    metadata: {
      followers: legacy.followers_count ?? null,
      verified: legacy.verified ?? legacy.is_blue_verified ?? null,
    },
  }
}

export function normalizeTweet(rawTweet: unknown, source: NormalizedBookmark['source'] = 'bookmark'): NormalizedBookmark | null {
  const tweet = unwrapTweetResult(rawTweet)
  if (!tweet) return null

  const legacy = getRecord(tweet, 'legacy') ?? tweet
  const tweetId = getString(tweet, 'rest_id') ?? getString(legacy, 'id_str') ?? getString(tweet, 'id')
  if (!tweetId) return null

  const noteText = nestedString(tweet, ['note_tweet', 'note_tweet_results', 'result', 'text'])
  const text = noteText ?? getString(legacy, 'full_text') ?? getString(legacy, 'text') ?? ''
  const author = extractAuthor(tweet)
  const urls = extractUrls(tweetId, tweet)
  const media = extractMedia(tweetId, tweet)

  return {
    id: stableId('bookmark', tweetId),
    tweetId,
    text,
    author,
    tweetCreatedAt: parseTwitterDate(getString(legacy, 'created_at')),
    rawJson: JSON.stringify(rawTweet),
    source,
    language: getString(legacy, 'lang'),
    conversationId: getString(legacy, 'conversation_id_str') ?? getString(tweet, 'conversation_id_str'),
    inReplyToTweetId: getString(legacy, 'in_reply_to_status_id_str'),
    quotedTweetId: getString(legacy, 'quoted_status_id_str') ?? getString(tweet, 'quoted_status_id_str'),
    retweetedTweetId: nestedString(legacy, ['retweeted_status_result', 'result', 'rest_id']),
    hashtags: extractHashtags(tweet),
    mentions: extractMentions(tweet),
    urls,
    media,
  }
}

export function operationNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? null
  } catch {
    const match = url.match(/\/graphql\/[^/]+\/([^?]+)/)
    return match?.[1] ?? null
  }
}

export function isBookmarkTimelineResponse(url: string, data: unknown): boolean {
  if (/\/i\/api\/graphql\/.+\/Bookmarks\b/.test(url) || /\/graphql\/.+\/Bookmarks\b/.test(url)) return true
  return extractTweetsFromTimeline(data).length > 0 && JSON.stringify(data).includes('bookmark_timeline')
}

export function syntheticTweetFromSiftlyRow(row: {
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: string | null
  rawJson: string
  source?: string
}): NormalizedBookmark | null {
  try {
    const parsed = JSON.parse(row.rawJson) as unknown
    const normalized = normalizeTweet(parsed, row.source === 'like' ? 'like' : 'bookmark')
    if (normalized) {
      return {
        ...normalized,
        text: normalized.text || row.text,
        author: normalized.author.handle === 'unknown'
          ? {
              id: stableId('author', row.authorHandle.toLowerCase()),
              handle: row.authorHandle,
              name: row.authorName,
            }
          : normalized.author,
        tweetCreatedAt: normalized.tweetCreatedAt ?? row.tweetCreatedAt,
      }
    }
  } catch {
    // Fall through to minimal row conversion.
  }

  const authorHandle = row.authorHandle || 'unknown'
  return {
    id: stableId('bookmark', row.tweetId),
    tweetId: row.tweetId,
    text: row.text,
    author: {
      id: stableId('author', authorHandle.toLowerCase()),
      handle: authorHandle,
      name: row.authorName || authorHandle,
    },
    tweetCreatedAt: row.tweetCreatedAt,
    rawJson: row.rawJson,
    source: row.source === 'like' ? 'like' : 'bookmark',
    hashtags: [...row.text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()),
    mentions: [...row.text.matchAll(/@([a-zA-Z0-9_]+)/g)].map((m) => m[1].toLowerCase()),
    urls: [...row.text.matchAll(/https?:\/\/\S+/g)].map((m) => {
      const url = m[0]
      return {
        id: stableId('link', `${row.tweetId}:${url}`),
        url,
        expandedUrl: url,
        domain: domainFor(url),
      }
    }),
    media: [],
  }
}

export function responseId(url: string, body: string): string {
  return stableId('response', `${url}:${stableHash(body)}`)
}
