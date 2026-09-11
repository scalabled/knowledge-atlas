import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Archive, AtSign, Bot, Brain, Check, ChevronRight, CirclePlay, Compass, ExternalLink, FileText, FolderPlus, GitBranch,
  Globe, Home, Layers3, Library, LoaderCircle, MessageSquareText, Network, Plus, Search, Sparkles,
  Tag, Trash2, UserRound, Video, X,
} from 'lucide-react'
import AssistantApp from './assistant-app'
import GraphCanvas, { type LayoutMode } from './components/GraphCanvas'
import ExploreCanvas, { type ExploreChild, type ExploreResponse, type Facet } from './components/ExploreCanvas'
import IngestPanel from './components/IngestPanel'
import MarkdownView from './components/MarkdownView'
import './styles/app.css'
import './styles/knowledge.css'
import './styles/assistant.css'

interface Stats {
  bookmarks: number; favorites?: number; youtubeVideos: number; youtubePlaylists: number; youtubeTranscripts: number;
  authors: number; media: number; links: number; topics: number; tags: number; graphNodes: number; graphEdges: number;
  correlations?: number; semanticEdges?: number; embeddings?: number; claims?: number; pendingLinks?: number; summarizedLinks?: number; documents?: number
}
interface GraphNodeDto { id: string; type: string; label: string; summary: string | null; weight: number; metadata: Record<string, unknown> }
interface GraphEdgeDto { id: string; source: string; target: string; type: string; weight: number; metadata: Record<string, unknown> }
interface SearchResult {
  id: string; itemType: 'x' | 'youtube' | 'favorite' | 'document'; tweetId: string; text: string; title?: string; authorHandle: string; authorName: string;
  tweetCreatedAt: string | null; topics: string[]; tags: string[]; mediaTypes: string[]; score: number; url?: string;
  thumbnailUrl?: string | null; durationSeconds?: number | null; transcriptStatus?: string; playlists?: string[]; semanticScore?: number
  rankScore?: number; why?: string[]; conceptKeys?: string[]; bridgeScore?: number
  scoreBreakdown?: { lexical: number; semantic: number; recency: number; centrality: number; richness: number; concept: number; diversity: number; composite: number }
}
interface GraphResponse { nodes: GraphNodeDto[]; edges: GraphEdgeDto[]; results: SearchResult[]; grown?: boolean; depth?: number; focus?: string }
interface Collection { id: string; name: string; description: string; color: string; itemCount: number }
type SourceFilter = 'all' | 'x' | 'web' | 'youtube'

type View =
  | { kind: 'atlas' }
  | { kind: 'topic'; slug: string; name: string; facet: Facet }
  | { kind: 'category'; facet: Facet; key: string; label: string; topicSlug?: string | null; topicName?: string | null }
  | { kind: 'search'; query: string }
  | { kind: 'node'; nodeId: string; label: string; depth: number; grow?: boolean }

interface PopupItem {
  nodeId: string
  itemType: 'x' | 'favorite' | 'youtube' | 'document'
  dbId: string
  label: string
  summary?: string | null
  url?: string | null
  authorName?: string | null
  authorHandle?: string | null
  createdAt?: string | null
  thumbnailUrl?: string | null
  durationSeconds?: number | null
  transcriptStatus?: string | null
  topics: string[]
  tags: string[]
  links: Array<{ url?: string; domain?: string; title?: string; summary?: string }>
  playlists: string[]
}

const ATLAS: View = { kind: 'atlas' }
const SECOND_BRAIN_PRESETS = [
  { label: 'Second brain', query: 'second brain zettelkasten personal knowledge' },
  { label: 'Agentic memory', query: 'agentic memory agent memory mem0 hippocampus' },
  { label: 'Knowledge graphs', query: 'knowledge graph GraphRAG graph engineering' },
  { label: 'Graph theory', query: 'graph theory nodes edges centrality network' },
  { label: 'Context systems', query: 'context engineering compounding context agent skills' },
]
const FACETS: Array<{ id: Facet; label: string; icon: React.ReactNode }> = [
  { id: 'tags', label: 'Tags', icon: <Tag size={13} /> },
  { id: 'authors', label: 'Authors', icon: <AtSign size={13} /> },
  { id: 'domains', label: 'Domains', icon: <Globe size={13} /> },
  { id: 'channels', label: 'Channels', icon: <CirclePlay size={13} /> },
]
const LAYOUTS: Array<{ id: LayoutMode; label: string }> = [
  { id: 'unified', label: 'Unified 4D' }, { id: 'territories', label: 'Territories' },
  { id: 'depth', label: 'Recency depth' }, { id: 'time', label: 'Time × source' },
]
type SortMode = 'relevance' | 'newest' | 'connections' | 'alphabetical'

function truncate(value: string, max = 180) { const text = value.replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text }

/** Parse JSON API bodies; surface HTML/proxy failures instead of "Unexpected token '<'". */
async function readApiJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text()
  const type = res.headers.get('content-type') ?? ''
  const looksHtml = /^\s*</.test(text) || type.includes('text/html')
  if (looksHtml) {
    throw new Error(
      res.status === 502 || res.status === 503 || res.status === 504
        ? 'API timed out or is restarting (proxy returned HTML). Wait a few seconds and try again — long Grok answers can take a minute.'
        : `API returned a web page instead of JSON (HTTP ${res.status}). Is the API running on port 4177?`,
    )
  }
  if (!text.trim()) {
    throw new Error(res.ok ? 'API returned an empty response' : `API error ${res.status} with empty body`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON from API (HTTP ${res.status}): ${truncate(text, 160)}`)
  }
}
function formatCount(value?: number) { return Number(value ?? 0).toLocaleString() }
function formatDuration(value?: number | null) { if (!value) return ''; const h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}` }
function formatDate(value?: string | null) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }
function itemKey(item: Pick<SearchResult, 'itemType' | 'id'>) { return `${item.itemType}:${item.id}` }
function stripNodePrefix(nodeId: string) { return nodeId.replace(/^(bookmark|youtube|document):/, '') }

function NodeIcon({ type, size = 14 }: { type: string; size?: number }) {
  if (type === 'youtube' || type === 'playlist' || type === 'channel') return <CirclePlay size={size} />
  if (type === 'document') return <FileText size={size} />
  if (type === 'author') return <UserRound size={size} />
  if (type === 'tag' || type === 'topic') return <Tag size={size} />
  if (type === 'collection') return <Layers3 size={size} />
  if (type === 'favorite' || type === 'web' || type === 'link' || type === 'domain') return <ExternalLink size={size} />
  return <Network size={size} />
}

function sourceLabel(item: SearchResult): string {
  if (item.itemType === 'youtube') return 'YouTube'
  if (item.itemType === 'favorite') return 'Favorite'
  if (item.itemType === 'document') return 'Document'
  return 'X'
}

function popupFromResult(item: SearchResult): PopupItem {
  return {
    nodeId: item.itemType === 'youtube' ? `youtube:${item.id}` : item.itemType === 'document' ? `document:${item.id}` : `bookmark:${item.id}`,
    itemType: item.itemType,
    dbId: item.id,
    label: item.title || truncate(item.text, 120),
    summary: item.text,
    url: item.url ?? null,
    authorName: item.authorName,
    authorHandle: item.authorHandle,
    createdAt: item.tweetCreatedAt,
    thumbnailUrl: item.thumbnailUrl ?? null,
    durationSeconds: item.durationSeconds ?? null,
    transcriptStatus: item.transcriptStatus ?? null,
    topics: item.topics ?? [],
    tags: item.tags ?? [],
    links: [],
    playlists: item.playlists ?? [],
  }
}

function popupFromChild(child: ExploreChild): PopupItem {
  const meta = child.meta ?? {}
  return {
    nodeId: child.id,
    itemType: child.itemType ?? 'x',
    dbId: stripNodePrefix(child.id),
    label: child.label,
    summary: typeof meta.summary === 'string' ? meta.summary : null,
    url: typeof meta.url === 'string' ? meta.url : null,
    authorName: typeof meta.authorName === 'string' ? meta.authorName : null,
    authorHandle: typeof meta.authorHandle === 'string' ? meta.authorHandle : null,
    createdAt: child.createdAt ?? null,
    thumbnailUrl: typeof meta.thumbnailUrl === 'string' ? meta.thumbnailUrl : null,
    durationSeconds: typeof meta.durationSeconds === 'number' ? meta.durationSeconds : null,
    transcriptStatus: typeof meta.transcriptStatus === 'string' ? meta.transcriptStatus : null,
    topics: Array.isArray(meta.topics) ? (meta.topics as unknown[]).map(String) : [],
    tags: Array.isArray(meta.tags) ? (meta.tags as unknown[]).map(String) : [],
    links: Array.isArray(meta.links) ? meta.links as PopupItem['links'] : [],
    playlists: Array.isArray(meta.playlists) ? (meta.playlists as unknown[]).map(String) : [],
  }
}

function popupFromGraphNode(node: GraphNodeDto): PopupItem {
  const m = node.metadata
  const isYouTube = node.type === 'youtube'
  const isFavorite = node.type === 'favorite' || m.itemKind === 'favorite'
  const isDocument = node.type === 'document'
  const url = typeof m.url === 'string' ? m.url
    : isDocument ? (typeof m.sourceUrl === 'string' && m.sourceUrl ? m.sourceUrl : `/api/documents/${stripNodePrefix(node.id)}/file`)
      : (m.tweetId && m.authorHandle ? `https://x.com/${m.authorHandle}/status/${m.tweetId}` : null)
  const media = Array.isArray(m.media) ? m.media as Array<Record<string, unknown>> : []
  const mediaThumb = media.find((item) => typeof item.thumbnailUrl === 'string' && item.thumbnailUrl)
  const thumb = typeof m.localThumbnailPath === 'string'
    ? `/thumbnails/${m.localThumbnailPath.split('/').pop()}`
    : typeof m.thumbnailUrl === 'string' ? m.thumbnailUrl : (mediaThumb ? String(mediaThumb.thumbnailUrl) : null)
  return {
    nodeId: node.id,
    itemType: isYouTube ? 'youtube' : isDocument ? 'document' : isFavorite ? 'favorite' : 'x',
    dbId: stripNodePrefix(node.id),
    label: node.label,
    summary: node.summary,
    url,
    authorName: typeof m.authorName === 'string' ? m.authorName : (typeof m.channelName === 'string' ? m.channelName : null),
    authorHandle: typeof m.authorHandle === 'string' ? m.authorHandle : null,
    createdAt: typeof m.tweetCreatedAt === 'string' ? m.tweetCreatedAt : (typeof m.publishedAt === 'string' ? m.publishedAt : null),
    thumbnailUrl: thumb,
    durationSeconds: typeof m.durationSeconds === 'number' ? m.durationSeconds : null,
    transcriptStatus: typeof m.transcriptStatus === 'string' ? m.transcriptStatus : null,
    topics: Array.isArray(m.topics) ? m.topics.map(String) : [],
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    links: Array.isArray(m.links) ? m.links as PopupItem['links'] : [],
    playlists: Array.isArray(m.playlists) ? m.playlists.map(String) : [],
  }
}

function ResultsList({ results, selected, onToggle, onOpen }: { results: SearchResult[]; selected: Set<string>; onToggle: (item: SearchResult) => void; onOpen: (item: SearchResult) => void }) {
  return <div className="results-list">
    {results.map((item) => {
      const checked = selected.has(itemKey(item))
      const rankPct = item.rankScore !== undefined ? Math.round(item.rankScore * 100) : null
      return <article key={itemKey(item)} className={`result-card ${checked ? 'selected' : ''} ${item.bridgeScore ? 'bridge' : ''}`}>
        <button className="select-item" onClick={() => onToggle(item)} aria-label={checked ? 'Deselect item' : 'Select item'}>{checked ? <Check size={13} /> : null}</button>
        {item.itemType === 'youtube' && item.thumbnailUrl ? <button className="result-thumb" onClick={() => onOpen(item)}><img src={item.thumbnailUrl} alt="" /><span>{formatDuration(item.durationSeconds)}</span></button> : null}
        <button className="result-main" onClick={() => onOpen(item)}>
          <div className={`source-kicker ${item.itemType}`}><NodeIcon type={item.itemType} size={12} />{sourceLabel(item)} · {item.authorName}{rankPct !== null ? <em className="rank-pill">{rankPct}</em> : null}</div>
          <div className="result-text">{truncate(item.title || item.text, 145)}</div>
          <div className="result-meta">
            {item.bridgeScore ? <span className="bridge-pill">Bridge</span> : null}
            {item.why?.slice(0, 2).map((reason) => <span key={reason} className="why-pill">{reason}</span>)}
            {item.playlists?.slice(0, 1).map((name) => <span key={name}>{name}</span>)}
            {item.topics.slice(0, 2).map((topic) => <span key={topic}>{topic}</span>)}
            {item.transcriptStatus === 'fetched' ? <span className="transcript-ready">Transcript</span> : null}
          </div>
        </button>
      </article>
    })}
  </div>
}

function ItemModal({ item, collections, busy, onClose, onExploreGraph, onCurate, onAddCollection, onTranscript, onOpenTag, onOpenTopic }: {
  item: PopupItem
  collections: Collection[]
  busy: string
  onClose: () => void
  onExploreGraph: (item: PopupItem) => void
  onCurate: (item: PopupItem, status: 'archived' | 'removed') => void
  onAddCollection: (item: PopupItem, collectionId: string) => void
  onTranscript: (item: PopupItem) => void
  onOpenTag: (tag: string) => void
  onOpenTopic: (topicName: string) => void
}) {
  const [collectionId, setCollectionId] = useState('')
  const [detail, setDetail] = useState<{ links: PopupItem['links']; mediaThumbs: string[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    const type = item.itemType === 'youtube' ? 'youtube' : item.itemType === 'document' ? 'document' : 'x'
    fetch(`/api/items/${type}/${encodeURIComponent(item.dbId)}`).then((res) => res.ok ? res.json() : null).then((data) => {
      if (cancelled || !data) return
      const links = Array.isArray(data.links)
        ? data.links.map((link: Record<string, unknown>) => ({
          url: String(link.canonical_url ?? link.expanded_url ?? link.url ?? ''),
          domain: link.domain ? String(link.domain) : undefined,
          title: link.title ? String(link.title) : undefined,
          summary: link.summary ? String(link.summary) : (link.description ? String(link.description) : undefined),
        }))
        : []
      const mediaThumbs = Array.isArray(data.media)
        ? data.media.map((media: Record<string, unknown>) => String(media.thumbnail_url ?? media.url ?? '')).filter(Boolean).slice(0, 4)
        : []
      setDetail({ links, mediaThumbs })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [item.nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const links = detail?.links?.length ? detail.links : item.links
  const summary = item.summary && item.summary !== item.label ? item.summary : (links[0]?.summary ?? null)

  return <div className="item-modal-backdrop" onClick={onClose}>
    <section className="item-modal" onClick={(event) => event.stopPropagation()}>
      <header>
        <div className={`source-kicker ${item.itemType}`}>
          <NodeIcon type={item.itemType} size={13} />
          {item.itemType === 'youtube' ? 'YouTube' : item.itemType === 'favorite' ? 'Browser favorite' : item.itemType === 'document' ? 'Document' : 'X bookmark'}
          {item.authorName ? <> · {item.authorName}</> : null}
          {item.createdAt ? <span className="modal-date">{formatDate(item.createdAt)}</span> : null}
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      {item.thumbnailUrl ? <div className="modal-hero"><img src={item.thumbnailUrl} alt="" />{item.durationSeconds ? <span>{formatDuration(item.durationSeconds)}</span> : null}</div> : null}
      <h2>{item.label}</h2>
      {summary ? <p className="summary">{truncate(summary, 900)}</p> : null}
      {detail?.mediaThumbs?.length && !item.thumbnailUrl ? <div className="media-strip">{detail.mediaThumbs.map((src) => <img key={src} src={src} alt="" />)}</div> : null}
      {links.length ? <div className="chip-section"><span className="section-label">Linked pages</span><div className="link-list">
        {links.slice(0, 3).map((link, index) => link.url
          ? <a key={index} href={link.url} target="_blank" rel="noreferrer"><span>{truncate(String(link.title || link.domain || link.url), 60)}</span><ExternalLink size={13} /></a>
          : null)}
      </div></div> : null}
      {item.topics.length ? <div className="chip-section"><span className="section-label">Topics</span><div className="chips">
        {item.topics.map((topic) => <button key={topic} className="chip-button" onClick={() => onOpenTopic(topic)}>{topic}</button>)}
      </div></div> : null}
      {item.tags.length ? <div className="chip-section"><span className="section-label">Tags</span><div className="chips">
        {item.tags.slice(0, 12).map((tag) => <button key={tag} className="chip-button" onClick={() => onOpenTag(tag)}>{tag}</button>)}
      </div></div> : null}
      {item.playlists.length ? <div className="chip-section"><span className="section-label">Saved in</span><div className="chips">{item.playlists.map((name) => <span key={name}>{name}</span>)}</div></div> : null}
      <div className="detail-actions">
        {item.url ? <a href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open original</a> : null}
        <button onClick={() => onExploreGraph(item)}><GitBranch size={14} />Explore in graph</button>
        {item.itemType === 'youtube' && item.transcriptStatus !== 'fetched' ? <button disabled={Boolean(busy)} onClick={() => onTranscript(item)}><MessageSquareText size={14} />Transcript</button> : null}
      </div>
      {item.itemType !== 'document' ? <><div className="organize-box"><span className="section-label">Organize</span><div>
        <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
          <option value="">Choose collection</option>
          {collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
        </select>
        <button disabled={!collectionId || Boolean(busy)} onClick={() => collectionId && onAddCollection(item, collectionId)}><FolderPlus size={14} />Add</button>
      </div></div>
      <div className="curation-row">
        <button disabled={Boolean(busy)} onClick={() => onCurate(item, 'archived')}><Archive size={14} />Archive</button>
        <button disabled={Boolean(busy)} className="danger" onClick={() => onCurate(item, 'removed')}><Trash2 size={14} />Remove</button>
      </div></> : null}
    </section>
  </div>
}

function LevelPanel({ explore, selected, stats, onActivate, onOpenNode, onFocusConcept }: {
  explore: ExploreResponse | null
  selected: ExploreChild | null
  stats: Stats | null
  onActivate: (child: ExploreChild) => void
  onOpenNode?: (nodeId: string) => void
  onFocusConcept?: (label: string) => void
}) {
  if (!explore) {
    return <aside className="detail-panel empty"><Compass size={22} /><strong>Loading atlas</strong></aside>
  }
  if (selected && selected.kind !== 'item') {
    const meta = selected.meta ?? {}
    return <aside className="detail-panel">
      <div className="detail-type"><NodeIcon type={selected.kind} /><span>{meta.concept ? 'concept' : selected.kind}</span></div>
      <h2>{selected.label}</h2>
      {typeof meta.description === 'string' && meta.description ? <p className="summary">{meta.description}</p> : null}
      {typeof meta.summary === 'string' && meta.summary ? <p className="summary">{meta.summary}</p> : null}
      {selected.count !== undefined ? <p className="summary">{formatCount(selected.count)} items inside.</p> : null}
      {selected.sourceCounts ? <div className="chip-section"><span className="section-label">Sources</span><div className="chips">
        <span>X · {formatCount(selected.sourceCounts.x)}</span>
        <span>Web · {formatCount(selected.sourceCounts.web)}</span>
        <span>YouTube · {formatCount(selected.sourceCounts.youtube)}</span>
      </div></div> : null}
      {meta.concept && onFocusConcept ? <div className="detail-actions"><button onClick={() => onFocusConcept(selected.label)}><Search size={14} />Search concept</button></div>
        : <div className="detail-actions"><button onClick={() => onActivate(selected)}><ChevronRight size={14} />Open</button></div>}
    </aside>
  }
  if (selected && selected.kind === 'item') {
    const meta = selected.meta ?? {}
    const why = Array.isArray(meta.why) ? (meta.why as unknown[]).map(String) : []
    const breakdown = meta.scoreBreakdown && typeof meta.scoreBreakdown === 'object' ? meta.scoreBreakdown as Record<string, number> : null
    return <aside className="detail-panel">
      <div className="detail-type"><NodeIcon type={selected.itemType ?? 'x'} /><span>{selected.itemType ?? 'item'}</span></div>
      <h2>{selected.label}</h2>
      {typeof meta.summary === 'string' && meta.summary ? <p className="summary">{truncate(meta.summary, 280)}</p> : null}
      {why.length ? <div className="chip-section"><span className="section-label">Why this node</span><div className="chips">{why.map((reason) => <span key={reason}>{reason}</span>)}</div></div> : null}
      {breakdown ? <div className="score-bars">
        {(['semantic', 'lexical', 'concept', 'centrality', 'recency', 'richness', 'diversity'] as const).map((key) => {
          const value = Number(breakdown[key] ?? 0)
          return <div key={key} className="score-bar"><span>{key}</span><i style={{ width: `${Math.round(value * 100)}%` }} /><b>{Math.round(value * 100)}</b></div>
        })}
      </div> : null}
      <div className="detail-actions"><button onClick={() => onActivate(selected)}><ChevronRight size={14} />Open item</button></div>
    </aside>
  }
  return <aside className="detail-panel">
    <div className="detail-type"><Compass size={14} /><span>{explore.level}</span></div>
    <h2>{explore.title}</h2>
    {explore.topic?.description && explore.level === 'topic' ? <p className="summary">{explore.topic.description}</p> : null}
    {explore.level === 'atlas' ? <>
      <p className="summary">Your second brain: a navigable knowledge graph over X bookmarks, favorites, and YouTube. Drill atlas → concept → items, or search to open a multi-signal constellation.</p>
      <div className="chip-section"><span className="section-label">Library</span><div className="chips">
        <span>X · {formatCount(stats?.bookmarks)}</span>
        <span>Favorites · {formatCount(stats?.favorites)}</span>
        <span>Videos · {formatCount(stats?.youtubeVideos)}</span>
        <span>Correlations · {formatCount(stats?.correlations)}</span>
        <span>Embeddings · {formatCount(stats?.embeddings)}</span>
        <span>Claims · {formatCount(stats?.claims)}</span>
      </div></div>
    </> : null}
    {explore.level === 'topic' ? <p className="summary">Showing the top {explore.children.length} of {formatCount(explore.total)} {explore.facet}. Click one to open its items.</p> : null}
    {explore.level === 'category' ? <p className="summary">Showing {explore.children.length} of {formatCount(explore.total)} items, newest first. Gold links join items that share rare tags or domains. Click any dot or label to open it.</p> : null}
    {explore.level === 'search' ? <>
      <p className="summary">{formatCount(explore.total)} nodes ranked by meaning, structure, recency, and concept affinity — clustered into navigable constellations. Bridges cross concepts.</p>
      {explore.concepts?.length ? <div className="chip-section"><span className="section-label">Concepts</span><div className="chips concept-chips">
        {explore.concepts.map((concept) => (
          <button
            key={concept.id}
            type="button"
            className="concept-chip"
            style={{ borderColor: concept.color }}
            onClick={() => onFocusConcept?.(concept.key.replace(/-/g, ' '))}
            title={`Focus constellation: ${concept.label}`}
          >
            <i style={{ background: concept.color }} />{concept.label}<b>{concept.count}</b>
          </button>
        ))}
      </div></div> : null}
      {explore.bridges?.length ? <div className="chip-section"><span className="section-label">Bridges</span><div className="bridge-list">
        {explore.bridges.slice(0, 6).map((bridge) => (
          <button key={bridge.nodeId} type="button" className="bridge-row" onClick={() => onOpenNode?.(bridge.nodeId)}>
            <GitBranch size={12} /><span>{truncate(bridge.label, 64)}</span>
          </button>
        ))}
      </div></div> : null}
    </> : null}
  </aside>
}

function App({ onOpenAssistant }: { onOpenAssistant: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [trail, setTrail] = useState<View[]>([ATLAS])
  const [explore, setExplore] = useState<ExploreResponse | null>(null)
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [], results: [] })
  const [query, setQuery] = useState(''), [source, setSource] = useState<SourceFilter>('all'), [layout, setLayout] = useState<LayoutMode>('unified')
  const [sortMode, setSortMode] = useState<SortMode>('relevance'), [dimension, setDimension] = useState(0.68)
  const [selectedChild, setSelectedChild] = useState<ExploreChild | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [notice, setNotice] = useState('')
  const [popup, setPopup] = useState<PopupItem | null>(null)
  const [collections, setCollections] = useState<Collection[]>([]), [newCollection, setNewCollection] = useState('')
  type AskProvider = 'claude' | 'codex' | 'grok'
  const ASK_PROVIDER_KEY = 'atlas-ask-provider'
  const readAskProvider = (): AskProvider => {
    try {
      const raw = localStorage.getItem(ASK_PROVIDER_KEY)
      if (raw === 'claude' || raw === 'codex' || raw === 'grok') return raw
    } catch { /* private mode */ }
    return 'grok'
  }
  const [askOpen, setAskOpen] = useState(false), [question, setQuestion] = useState(''), [answer, setAnswer] = useState(''), [askSources, setAskSources] = useState<SearchResult[]>([])
  const [provider, setProvider] = useState<AskProvider>(readAskProvider)
  const [askLoading, setAskLoading] = useState(false)
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [relatedResearch, setRelatedResearch] = useState('')
  // Canvases only ever see the question submitted via ask() — live keystrokes must not reach them
  const [submittedQuestion, setSubmittedQuestion] = useState('')
  // Slider renders live; canvases follow at deferred priority so drags coalesce instead of relaying out per tick
  const deferredDimension = useDeferredValue(dimension)
  const [topicIndex, setTopicIndex] = useState<Map<string, { slug: string; name: string; color: string }>>(new Map())
  const requestRef = useRef(0)

  const view = trail[trail.length - 1]
  const isHierarchy = view.kind !== 'node'
  const selectedNode = useMemo(() => graph.nodes.find((node) => node.id === selectedNodeId) ?? null, [graph.nodes, selectedNodeId])
  const rawResults = isHierarchy ? (explore?.results as SearchResult[] | undefined) ?? [] : graph.results
  const results = useMemo(() => [...rawResults].sort((a, b) => sortMode === 'newest'
    ? String(b.tweetCreatedAt ?? '').localeCompare(String(a.tweetCreatedAt ?? ''))
    : sortMode === 'alphabetical' ? (a.title ?? a.text).localeCompare(b.title ?? b.text)
      : sortMode === 'connections' ? (b.tags.length + b.topics.length) - (a.tags.length + a.topics.length)
        : a.score - b.score), [rawResults, sortMode])

  const refreshMeta = useCallback(() => {
    fetch('/api/stats').then((res) => res.json()).then(setStats).catch(() => {})
    fetch('/api/collections').then((res) => res.json()).then(setCollections).catch(() => {})
  }, [])
  useEffect(refreshMeta, [refreshMeta])
  useEffect(() => {
    fetch('/api/explore?level=atlas').then((res) => res.json()).then((data: ExploreResponse) => {
      const map = new Map<string, { slug: string; name: string; color: string }>()
      for (const child of data.children) {
        const slug = String(child.meta?.slug ?? child.id.replace(/^topic:/, ''))
        map.set(child.label, { slug, name: child.label, color: child.color ?? '#a78bfa' })
      }
      setTopicIndex(map)
    }).catch(() => {})
  }, [])

  // Fetch data for the current view
  useEffect(() => {
    const id = ++requestRef.current
    setLoading(true)
    setSelectedChild(null)
    if (view.kind === 'node') {
      const params = new URLSearchParams({ node: view.nodeId, depth: String(view.depth) })
      if (view.grow) params.set('grow', '1')
      fetch(`/api/graph?${params}`).then((res) => res.json()).then((data: GraphResponse) => {
        if (id !== requestRef.current) return
        setGraph(data); setSelectedNodeId(view.nodeId); setLoading(false)
      }).catch(() => { if (id === requestRef.current) setLoading(false) })
      return
    }
    const params = new URLSearchParams({ level: view.kind, source })
    if (view.kind === 'topic') { params.set('topic', view.slug); params.set('facet', view.facet) }
    if (view.kind === 'category') {
      params.set('facet', view.facet); params.set('key', view.key)
      if (view.topicSlug) params.set('topic', view.topicSlug)
    }
    if (view.kind === 'search') params.set('q', view.query)
    fetch(`/api/explore?${params}`).then((res) => res.json()).then((data: ExploreResponse) => {
      if (id !== requestRef.current) return
      setExplore(data); setLoading(false)
    }).catch(() => { if (id === requestRef.current) setLoading(false) })
  }, [view, source])

  const push = useCallback((next: View) => setTrail((current) => [...current, next]), [])
  const replace = useCallback((next: View) => setTrail((current) => [...current.slice(0, -1), next]), [])
  const jump = useCallback((index: number) => setTrail((current) => current.slice(0, index + 1)), [])

  // Search-as-you-type enters/updates/leaves the search view
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = query.trim()
      setTrail((current) => {
        const top = current[current.length - 1]
        if (trimmed) {
          if (top.kind === 'search') return top.query === trimmed ? current : [...current.slice(0, -1), { kind: 'search', query: trimmed } as View]
          return [...current, { kind: 'search', query: trimmed } as View]
        }
        if (top.kind === 'search') {
          const keep = current.filter((item) => item.kind !== 'search')
          return keep.length ? keep : [ATLAS]
        }
        return current
      })
    }, 280)
    return () => clearTimeout(timer)
  }, [query])

  const openTopicByName = useCallback((name: string) => {
    const topic = topicIndex.get(name)
    if (topic) { setPopup(null); push({ kind: 'topic', slug: topic.slug, name: topic.name, facet: 'tags' }) }
  }, [topicIndex, push])
  const openTag = useCallback((tag: string) => {
    setPopup(null)
    const current = trail[trail.length - 1]
    const topicSlug = current.kind === 'topic' ? current.slug : current.kind === 'category' ? current.topicSlug : null
    const topicName = current.kind === 'topic' ? current.name : current.kind === 'category' ? current.topicName : null
    push({ kind: 'category', facet: 'tags', key: tag, label: tag, topicSlug, topicName })
  }, [trail, push])

  const activateChild = useCallback((child: ExploreChild) => {
    if (child.kind === 'item') { setPopup(popupFromChild(child)); return }
    // Concept constellation hubs re-query rather than jumping into taxonomy topics
    if (child.kind === 'topic' && (child.meta?.concept || String(child.id).startsWith('concept:'))) {
      setQuery(child.label)
      return
    }
    if (child.kind === 'topic') {
      const slug = String(child.meta?.slug ?? child.id.replace(/^topic:/, ''))
      push({ kind: 'topic', slug, name: child.label, facet: 'tags' })
      return
    }
    const facet: Facet = child.kind === 'tag' ? 'tags' : child.kind === 'author' ? 'authors' : child.kind === 'domain' ? 'domains' : 'channels'
    const key = String(child.meta?.key ?? child.label.replace(/^@/, ''))
    const current = trail[trail.length - 1]
    const topicSlug = current.kind === 'topic' ? current.slug : current.kind === 'category' ? current.topicSlug : null
    const topicName = current.kind === 'topic' ? current.name : current.kind === 'category' ? current.topicName : null
    push({ kind: 'category', facet, key, label: child.label, topicSlug, topicName })
  }, [push, trail, setQuery])

  // Free-graph mode: leaf items open the popup, concept nodes re-focus the graph
  const navigateGraph = useCallback((id: string) => {
    const node = graph.nodes.find((item) => item.id === id)
    if (node && ['bookmark', 'favorite', 'youtube', 'document'].includes(node.type)) { setPopup(popupFromGraphNode(node)); return }
    const grow = Boolean(node && ['tag', 'topic', 'domain', 'collection', 'link'].includes(node.type))
    push({ kind: 'node', label: node?.label ?? id, nodeId: id, depth: grow ? 2 : 1, grow })
  }, [graph.nodes, push])
  const growFocus = useCallback((id: string) => {
    const node = graph.nodes.find((item) => item.id === id)
    push({ kind: 'node', label: `Grow · ${node?.label ?? id}`, nodeId: id, depth: 3, grow: true })
  }, [graph.nodes, push])

  const openResult = (item: SearchResult) => setPopup(popupFromResult(item))
  const toggleItem = (item: SearchResult) => setSelectedItems((current) => { const next = new Set(current), key = itemKey(item); next.has(key) ? next.delete(key) : next.add(key); return next })

  const removeItemLocally = useCallback((nodeId: string) => {
    setExplore((current) => current ? {
      ...current,
      children: current.children.filter((child) => child.id !== nodeId),
      results: (current.results as SearchResult[]).filter((result) => (result.itemType === 'youtube' ? `youtube:${result.id}` : `bookmark:${result.id}`) !== nodeId),
      edges: current.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    } : current)
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      results: current.results.filter((result) => (result.itemType === 'youtube' ? `youtube:${result.id}` : `bookmark:${result.id}`) !== nodeId),
    }))
  }, [])

  const transcript = async (ids: string[]) => {
    setBusy('Retrieving transcripts'); setNotice('')
    try {
      const res = await fetch('/api/youtube/transcripts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ videoIds: ids }) })
      const data = await res.json(); if (!res.ok) throw new Error(data.error)
      setNotice(`${data.fetched} transcript${data.fetched === 1 ? '' : 's'} indexed`); refreshMeta()
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setBusy('') }
  }
  const transcriptSelected = () => transcript([...selectedItems].filter((key) => key.startsWith('youtube:')).map((key) => key.slice(8)))

  const curateItem = async (item: PopupItem, status: 'archived' | 'removed') => {
    const itemType = item.itemType === 'youtube' ? 'youtube' : 'x'
    setBusy(status === 'removed' ? 'Removing item' : 'Archiving item')
    try {
      await fetch('/api/curation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemType, id: item.dbId, status }) })
      removeItemLocally(item.nodeId)
      setPopup(null)
      setNotice(status === 'removed' ? 'Removed from active library' : 'Archived')
      refreshMeta()
    } finally { setBusy('') }
  }
  const addItemToCollection = async (item: PopupItem, collectionId: string) => {
    const itemType = item.itemType === 'youtube' ? 'youtube' : 'x'
    setBusy('Organizing item')
    try {
      await fetch(`/api/collections/${collectionId}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ itemType, id: item.dbId }] }) })
      setNotice('Added to collection'); refreshMeta()
    } finally { setBusy('') }
  }
  const createCollection = async () => { const name = newCollection.trim(); if (!name) return; await fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); setNewCollection(''); refreshMeta(); setNotice(`Created ${name}`) }
  const chooseProvider = (next: AskProvider) => {
    setProvider(next)
    try { localStorage.setItem(ASK_PROVIDER_KEY, next) } catch { /* private mode */ }
  }
  const ask = async () => {
    if (!question.trim() || askLoading || relatedLoading) return
    setSubmittedQuestion(question)
    setAskLoading(true)
    setBusy('Thinking with your library')
    setAnswer('')
    setAskSources([])
    setRelatedResearch('')
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, provider, source }),
      })
      const data = await readApiJson<{ answer?: string; error?: string; sources?: SearchResult[] }>(res)
      if (!res.ok) throw new Error(data.error || `Ask failed (HTTP ${res.status})`)
      setAnswer(String(data.answer ?? ''))
      setAskSources(data.sources ?? [])
    } catch (error) {
      setAnswer(error instanceof Error ? error.message : String(error))
    } finally {
      setAskLoading(false)
      setBusy('')
    }
  }

  const findRelated = async () => {
    if (!answer.trim() || askLoading || relatedLoading) return
    setRelatedLoading(true)
    setBusy('Searching X + web with Grok')
    setRelatedResearch('')
    try {
      const res = await fetch('/api/ask/related', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer, question: submittedQuestion || question }),
      })
      const data = await readApiJson<{ related?: string; error?: string }>(res)
      if (!res.ok) throw new Error(data.error || `Related search failed (HTTP ${res.status})`)
      setRelatedResearch(String(data.related ?? ''))
    } catch (error) {
      setRelatedResearch(error instanceof Error ? error.message : String(error))
    } finally {
      setRelatedLoading(false)
      setBusy('')
    }
  }

  const breadcrumbLabel = (item: View): string => {
    if (item.kind === 'atlas') return 'Atlas'
    if (item.kind === 'topic') return item.name
    if (item.kind === 'category') return item.label
    if (item.kind === 'search') return `Search · ${item.query}`
    return item.label
  }

  const statusText = (): string => {
    if (loading) return 'Loading'
    if (view.kind === 'node') return `${formatCount(graph.nodes.length)} nodes · ${formatCount(graph.edges.length)} edges${graph.grown ? ' · grown' : ''}`
    if (!explore) return ''
    if (explore.level === 'atlas') return `${explore.children.length} topics`
    if (explore.level === 'topic') return `Top ${explore.children.length} of ${formatCount(explore.total)} ${explore.facet}`
    if (explore.level === 'category') return `${explore.children.length} of ${formatCount(explore.total)} items`
    if (explore.level === 'search') {
      const concepts = explore.concepts?.length ? ` · ${explore.concepts.length} concepts` : ''
      const bridges = explore.bridges?.length ? ` · ${explore.bridges.length} bridges` : ''
      return `${formatCount(explore.total)} ranked${concepts}${bridges}`
    }
    return `${formatCount(explore.total)} matches`
  }

  const youtubeSelected = [...selectedItems].filter((key) => key.startsWith('youtube:')).length
  return <div className="app-shell">
    <section className="left-rail">
      <div className="brand"><div className="brand-mark"><Sparkles size={19} /></div><div><h1>Knowledge Atlas</h1><span>X + Favorites + YouTube</span></div></div>
      <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your second brain…" />{query ? <button onClick={() => setQuery('')}><X size={14} /></button> : null}</label>
      <div className="brain-presets">{SECOND_BRAIN_PRESETS.map((preset) => (
        <button key={preset.label} type="button" className={query === preset.query ? 'active' : ''} onClick={() => setQuery(preset.query)} title={preset.query}>
          <Sparkles size={11} />{preset.label}
        </button>
      ))}</div>
      <div className="source-tabs">{(['all', 'x', 'web', 'youtube'] as SourceFilter[]).map((item) => <button key={item} className={source === item ? 'active' : ''} onClick={() => setSource(item)}>{item === 'all' ? <Library size={14} /> : item === 'youtube' ? <Video size={14} /> : item === 'web' ? <ExternalLink size={14} /> : <Network size={14} />}{item === 'all' ? 'All' : item === 'x' ? 'X' : item === 'web' ? 'Web' : 'YouTube'}</button>)}</div>
      <div className="stat-grid"><div><strong>{formatCount(stats?.bookmarks)}</strong><span>X posts</span></div><div><strong>{formatCount(stats?.favorites)}</strong><span>Favorites</span></div><div><strong>{formatCount(stats?.youtubeVideos)}</strong><span>Videos</span></div><div><strong>{formatCount(stats?.correlations ?? stats?.graphEdges)}</strong><span>Correlations</span></div></div>
      {selectedItems.size ? <div className="selection-bar"><strong>{selectedItems.size} selected</strong><button disabled={!youtubeSelected || Boolean(busy)} onClick={transcriptSelected}><MessageSquareText size={14} />Transcripts ({youtubeSelected})</button><button onClick={() => setSelectedItems(new Set())}>Clear</button></div> : null}
      <div className="rail-section"><div className="rail-heading"><Network size={14} /><span>{view.kind === 'search' ? 'Search results' : view.kind === 'category' ? 'Items here' : 'Library stream'}</span><b>{results.length}</b></div><ResultsList results={results} selected={selectedItems} onToggle={toggleItem} onOpen={openResult} /></div>
      <div className="collection-create"><input value={newCollection} onChange={(event) => setNewCollection(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && createCollection()} placeholder="New collection" /><button onClick={createCollection} aria-label="Create collection"><Plus size={15} /></button></div>
      <IngestPanel onDone={(message, first) => {
        setNotice(message); refreshMeta()
        if (first) push({ kind: 'node', nodeId: first.nodeId, label: first.title, depth: 2 })
      }} />
    </section>

    <main className="graph-stage">
      <div className="graph-toolbar">
        <span>{loading ? <LoaderCircle className="spin" size={14} /> : <Network size={14} />}{statusText()}</span>
        <button onClick={() => { setQuery(''); setTrail([ATLAS]) }} title="Back to atlas"><Home size={14} /></button>
        {view.kind === 'topic' ? <div className="facet-tabs">{FACETS.map((facet) => <button key={facet.id} className={view.facet === facet.id ? 'active' : ''} onClick={() => replace({ ...view, facet: facet.id })}>{facet.icon}{facet.label}</button>)}</div> : null}
        {view.kind === 'node' && selectedNodeId ? <button onClick={() => growFocus(selectedNodeId)} title="Grow correlated neighborhood"><Sparkles size={14} />Grow</button> : null}
        <label className="sort-select"><span>Sort</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}><option value="relevance">Relevance</option><option value="newest">Newest</option><option value="connections">Connections</option><option value="alphabetical">A–Z</option></select></label>
        <label className="layout-select"><Layers3 size={14} /><select value={layout} onChange={(event) => setLayout(event.target.value as LayoutMode)}>{LAYOUTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="dimension-control" title="Rotate the lexical time/source axes through the visible plane"><span>4D</span><input type="range" min="0" max="1" step="0.01" value={dimension} onChange={(event) => setDimension(Number(event.target.value))} /><b>{Math.round(dimension * 100)}%</b></label>
        <button className="ask-toggle" onClick={onOpenAssistant}><Brain size={15} />Second brain</button>
        <button className="ask-toggle" onClick={() => setAskOpen((value) => !value)}><Bot size={15} />Ask library</button>
      </div>
      <div className="graph-breadcrumbs">
        {trail.slice(-5).map((item, index) => {
          const realIndex = trail.length - Math.min(5, trail.length) + index
          const isLast = realIndex === trail.length - 1
          return <React.Fragment key={`${item.kind}-${realIndex}`}>
            {index > 0 ? <ChevronRight size={13} className="crumb-sep" /> : null}
            <button className={isLast ? 'active' : ''} onClick={() => !isLast && jump(realIndex)}><span>{truncate(breadcrumbLabel(item), 30)}</span></button>
          </React.Fragment>
        })}
      </div>
      {isHierarchy && explore
        ? <ExploreCanvas data={explore} layoutMode={layout} dimension={deferredDimension} focusQuery={view.kind === 'search' ? view.query : submittedQuestion} selectedId={selectedChild?.id ?? null} onSelect={setSelectedChild} onActivate={activateChild} />
        : null}
      {!isHierarchy
        ? <GraphCanvas data={graph} selectedId={selectedNodeId} onSelect={setSelectedNodeId} onNavigate={navigateGraph} layoutMode={layout} dimension={deferredDimension} focusQuery={submittedQuestion || query} />
        : null}
      {isHierarchy && explore && !loading && explore.children.length === 0
        ? <div className="empty-level"><Compass size={20} /><span>Nothing here for this filter. Try another facet or source.</span></div>
        : null}
      {askOpen ? <section className={`ask-panel ${askLoading || relatedLoading ? 'is-loading' : ''}`}>
        <div className="ask-heading">
          <div><Bot size={17} /><strong>Ask your library</strong></div>
          <button onClick={() => setAskOpen(false)} disabled={askLoading || relatedLoading}><X size={15} /></button>
        </div>
        <p>Second-brain retrieval grounds the answer. Default is Grok Build CLI — preference is remembered.</p>
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !askLoading && !relatedLoading) {
              event.preventDefault()
              void ask()
            }
          }}
          placeholder="What patterns connect my saved research on consciousness and geometry?"
          disabled={askLoading || relatedLoading}
        />
        <div className="ask-controls">
          <select
            value={provider}
            onChange={(event) => chooseProvider(event.target.value as AskProvider)}
            disabled={askLoading || relatedLoading}
            aria-label="Answer provider"
          >
            <option value="grok">Grok Build CLI</option>
            <option value="claude">Claude Haiku</option>
            <option value="codex">Codex</option>
          </select>
          <button onClick={ask} disabled={!question.trim() || askLoading || relatedLoading}>
            {askLoading ? <LoaderCircle className="spin" size={14} /> : <MessageSquareText size={14} />}
            {askLoading ? 'Thinking…' : 'Ask'}
          </button>
        </div>
        {askLoading ? (
          <div className="ask-loading" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div>
              <strong>Querying your library…</strong>
              <span>
                {provider === 'grok' ? 'Grok Build CLI' : provider === 'codex' ? 'Codex' : 'Claude Haiku'}
                {' · hybrid retrieval + answer'}
              </span>
            </div>
          </div>
        ) : null}
        {relatedLoading ? (
          <div className="ask-loading related" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div>
              <strong>Finding related X + web…</strong>
              <span>Grok Build CLI · web_search + web_fetch on the answer</span>
            </div>
          </div>
        ) : null}
        {answer && !askLoading ? (
          <div className="answer">
            <MessageSquareText size={15} />
            <MarkdownView content={answer} />
          </div>
        ) : null}
        {(answer || askSources.length > 0) && !askLoading ? (
          <div className="answer-sources">
            <div className="answer-actions">
              <strong>{askSources.length ? `${askSources.length} semantic sources` : 'Answer ready'}</strong>
              <div className="answer-action-buttons">
                {askSources.length ? (
                  <button type="button" onClick={() => { setQuery(question); setAskOpen(false) }}>
                    <Network size={13} />Map answer
                  </button>
                ) : null}
                {answer ? (
                  <button type="button" onClick={() => void findRelated()} disabled={relatedLoading}>
                    {relatedLoading ? <LoaderCircle className="spin" size={13} /> : <Globe size={13} />}
                    {relatedLoading ? 'Searching…' : 'Related X + web'}
                  </button>
                ) : null}
              </div>
            </div>
            {askSources.slice(0, 6).map((item) => (
              <button key={itemKey(item)} type="button" onClick={() => openResult(item)}>
                <span>{sourceLabel(item)}</span>{truncate(item.title ?? item.text, 72)}
              </button>
            ))}
          </div>
        ) : null}
        {relatedResearch && !relatedLoading ? (
          <div className="related-research">
            <div className="related-research-heading">
              <Globe size={14} />
              <strong>Related X + web</strong>
              <span>via Grok</span>
            </div>
            <MarkdownView content={relatedResearch} className="related-md" />
          </div>
        ) : null}
      </section> : null}
      {(busy || notice) ? <div className={`toast ${busy ? 'busy' : ''}`}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{busy || notice}<button onClick={() => setNotice('')}><X size={13} /></button></div> : null}
    </main>

    {isHierarchy
      ? <LevelPanel
        explore={explore}
        selected={selectedChild}
        stats={stats}
        onActivate={activateChild}
        onOpenNode={(nodeId) => {
          const child = explore?.children.find((item) => item.id === nodeId)
          if (child) { setSelectedChild(child); setPopup(popupFromChild(child)); return }
          push({ kind: 'node', nodeId, label: nodeId, depth: 2, grow: true })
        }}
        onFocusConcept={(label) => setQuery(label)}
      />
      : <DetailPanel node={selectedNode} edges={graph.edges} collections={collections} onExplore={navigateGraph} onGrow={growFocus}
        onOpenItem={(node) => setPopup(popupFromGraphNode(node))} />}

    {popup ? <ItemModal
      item={popup}
      collections={collections}
      busy={busy}
      onClose={() => setPopup(null)}
      onExploreGraph={(item) => { setPopup(null); push({ kind: 'node', nodeId: item.nodeId, label: item.label, depth: 2, grow: true }) }}
      onCurate={curateItem}
      onAddCollection={addItemToCollection}
      onTranscript={(item) => transcript([item.dbId])}
      onOpenTag={openTag}
      onOpenTopic={openTopicByName}
    /> : null}
  </div>
}

function DetailPanel({ node, edges, collections, onExplore, onGrow, onOpenItem }: {
  node: GraphNodeDto | null; edges: GraphEdgeDto[]; collections: Collection[]
  onExplore: (id: string) => void; onGrow: (id: string) => void; onOpenItem: (node: GraphNodeDto) => void
}) {
  if (!node) return <aside className="detail-panel empty"><Compass size={22} /><strong>Free graph exploration</strong><span>Select any node to see its context and correlations. Items open in a quick-view popup; concepts re-focus the graph.</span></aside>
  const m = node.metadata
  const isItem = ['bookmark', 'favorite', 'youtube', 'document'].includes(node.type)
  const correlations = edges
    .filter((edge) => edge.type === 'correlates_with' && (edge.source === node.id || edge.target === node.id))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
  return <aside className="detail-panel">
    <div className="detail-type"><NodeIcon type={node.type} /><span>{node.type}</span></div>
    <h2>{node.label}</h2>
    {typeof m.channelName === 'string' ? <div className="detail-byline"><UserRound size={13} />{m.channelName}</div> : null}
    {typeof m.domain === 'string' ? <div className="detail-byline"><ExternalLink size={13} />{String(m.domain)}</div> : null}
    {node.summary ? <p className="summary">{truncate(node.summary, 500)}</p> : null}
    <div className="detail-actions">
      {isItem ? <button onClick={() => onOpenItem(node)}><ExternalLink size={14} />Quick view</button> : null}
      <button onClick={() => onExplore(node.id)}><GitBranch size={14} />Focus</button>
      <button onClick={() => onGrow(node.id)} title="Auto-grow correlated neighbors and focus hubs"><Sparkles size={14} />Grow</button>
    </div>
    {correlations.length ? <div className="chip-section"><span className="section-label">Correlations</span><div className="chips">{correlations.map((edge) => {
      const other = edge.source === node.id ? edge.target : edge.source
      const shared = Array.isArray(edge.metadata.sharedTags) ? edge.metadata.sharedTags.map(String).slice(0, 3).join(', ') : (edge.metadata.sharedDomain ? String(edge.metadata.sharedDomain) : edge.type)
      return <button key={edge.id} className="chip-button" onClick={() => onGrow(other)} title={shared}>{truncate(other.replace(/^[^:]+:/, ''), 28)}</button>
    })}</div></div> : null}
    <span className="section-label">{collections.length} collections available in the quick-view popup.</span>
  </aside>
}

function Root() {
  const [surface, setSurface] = useState<'atlas' | 'assistant'>(() =>
    window.location.hash.replace(/^#\/?/, '').startsWith('assistant') ? 'assistant' : 'atlas',
  )
  useEffect(() => {
    const sync = () => setSurface(window.location.hash.replace(/^#\/?/, '').startsWith('assistant') ? 'assistant' : 'atlas')
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  if (surface === 'assistant') {
    return <AssistantApp onOpenAtlas={() => { window.location.hash = '' }} />
  }
  return <App onOpenAssistant={() => { window.location.hash = 'assistant' }} />
}

const container = document.getElementById('root')! as HTMLElement & { __atlasRoot?: ReturnType<typeof createRoot> }
const root = container.__atlasRoot ?? createRoot(container)
container.__atlasRoot = root
root.render(<React.StrictMode><Root /></React.StrictMode>)
