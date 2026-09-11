export type SourceType = 'x' | 'favorite' | 'youtube' | 'document'
export type AssistantMode = 'discuss' | 'novel' | 'project' | 'timeline'
export type EventKind = 'model_release' | 'paper' | 'product' | 'benchmark' | 'technique' | 'industry'
export type IdeaKind = 'novel' | 'project'

export interface CatalogItem {
  sourceType: SourceType
  sourceId: string
  graphNodeId: string
  url: string | null
  occurredAt: string | null
  updatedAt: string | null
  title: string
  body: string
  author: string
  authorName: string
  topics: string[]
  tags: string[]
}

export interface MemoryRecord {
  id: string
  sourceType: SourceType
  sourceId: string
  graphNodeId: string | null
  url: string | null
  occurredAt: string | null
  title: string
  body: string
  author: string | null
  authorName: string | null
  topics: string[]
  tags: string[]
  contentHash: string
  richness: number
  topicPrimary: string | null
}

export interface RetrievedMemory extends MemoryRecord {
  score: number
  why: string[]
}

export interface TimelineEvent {
  id: string
  occurredAt: string | null
  title: string
  kind: EventKind
  summary: string
  entities: string[]
  memoryIds: string[]
  confidence: number
  source: 'heuristic' | 'llm'
}

export interface IdeaRecord {
  id: string
  kind: IdeaKind
  title: string
  pitch: string
  evidence: string[]
  novelty: number
  status: string
  source: 'bridge' | 'collection' | 'llm'
}

export interface ThemeRecord {
  id: string
  slug: string
  label: string
  description: string
  firstSeen: string | null
  lastSeen: string | null
  itemCount: number
  recentCount: number
  previousCount: number
  velocity: number
  monthly: Record<string, number>
  topAuthors: Array<{ author: string; count: number }>
}

export interface Citation {
  id: string
  title: string
  url: string | null
  sourceType: SourceType
  occurredAt: string | null
  author: string | null
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citations: Citation[]
  createdAt: string
}

export interface IndexStats {
  memories: number
  embeddings: number
  events: number
  ideas: number
  themes: number
  conversations: number
  lastRun: {
    id: string
    status: string
    startedAt: string
    finishedAt: string | null
    memoriesWritten: number
    memoriesSkipped: number
    eventsWritten: number
    ideasWritten: number
    embeddingsCopied: number
  } | null
  catalog?: {
    x: number
    favorites: number
    youtube: number
    documents: number
  }
}

export interface IndexOptions {
  catalogPath?: string
  assistantPath?: string
  limit?: number
  since?: string
  distill?: boolean
  onProgress?: (message: string) => void
}

export interface IndexResult {
  runId: string
  memoriesWritten: number
  memoriesSkipped: number
  eventsWritten: number
  ideasWritten: number
  embeddingsCopied: number
  themesWritten: number
  distilled: boolean
}
