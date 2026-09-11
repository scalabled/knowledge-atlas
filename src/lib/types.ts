export interface NormalizedAuthor {
  id: string
  handle: string
  name: string
  profileImageUrl?: string | null
  metadata?: Record<string, unknown>
}

export interface NormalizedMedia {
  id: string
  type: 'photo' | 'video' | 'gif'
  url: string
  thumbnailUrl?: string | null
  altText?: string | null
  width?: number | null
  height?: number | null
  durationMs?: number | null
}

export interface NormalizedLink {
  id: string
  url: string
  expandedUrl?: string | null
  displayUrl?: string | null
  domain?: string | null
}

export interface NormalizedBookmark {
  id: string
  tweetId: string
  text: string
  author: NormalizedAuthor
  tweetCreatedAt?: string | null
  rawJson: string
  source: 'bookmark' | 'like' | 'import'
  language?: string | null
  conversationId?: string | null
  inReplyToTweetId?: string | null
  quotedTweetId?: string | null
  retweetedTweetId?: string | null
  hashtags: string[]
  mentions: string[]
  urls: NormalizedLink[]
  media: NormalizedMedia[]
}

export interface ImportStats {
  imported: number
  updated: number
  duplicates: number
  skipped: number
}

export interface GraphNodeDto {
  id: string
  type: string
  label: string
  summary: string | null
  weight: number
  metadata: Record<string, unknown>
}

export interface GraphEdgeDto {
  id: string
  source: string
  target: string
  type: string
  weight: number
  metadata: Record<string, unknown>
}

export interface ScoreBreakdown {
  lexical: number
  semantic: number
  recency: number
  centrality: number
  richness: number
  concept: number
  diversity: number
  composite: number
}

export interface SearchResult {
  id: string
  itemType?: 'x' | 'youtube' | 'favorite' | 'document'
  tweetId: string
  text: string
  authorHandle: string
  authorName: string
  tweetCreatedAt: string | null
  topics: string[]
  tags: string[]
  domains: string[]
  mediaTypes: string[]
  /** Lower is better (UI sort contract). */
  score: number
  /** Higher is better cosine similarity when present. */
  semanticScore?: number
  /** Higher is better composite [0,1] from second-brain ranking. */
  rankScore?: number
  scoreBreakdown?: ScoreBreakdown
  /** Short human reasons for the ranking. */
  why?: string[]
  conceptKeys?: string[]
  bridgeScore?: number
  title?: string
  url?: string
  thumbnailUrl?: string | null
  durationSeconds?: number | null
  transcriptStatus?: string
  playlists?: string[]
}
