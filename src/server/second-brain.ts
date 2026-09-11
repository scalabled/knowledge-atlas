/**
 * Second-brain find → evaluate → render algorithm.
 *
 * Design is grounded in this library's own corpus (GraphRAG, agentic memory,
 * zettelkasten, Karpathy-style knowledge bases, graph engineering):
 *
 *  Lifecycle (evaluation lens): Collect → Organize → Evolve → Use → Govern
 *  Structure: graphs remember relations that flat vectors forget
 *  Retrieval: hybrid lexical + semantic + graph neighborhood
 *  Memory: prediction/connection, not pure nearest-neighbor recall
 *  Navigation: hubs, bridges, and concept constellations — not a ranked list
 *
 * Contract for `score`: lower is better (matches existing UI sort).
 * `rankScore` / `scoreBreakdown.composite` are higher-is-better in [0, 1].
 */
import type Database from 'better-sqlite3'
import type { SearchResult } from '../lib/types'

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

export interface RankedResult extends SearchResult {
  rankScore: number
  scoreBreakdown: ScoreBreakdown
  why: string[]
  nodeId: string
  bridgeScore?: number
  conceptKeys?: string[]
}

export interface ConceptCluster {
  id: string
  key: string
  label: string
  count: number
  color: string
  memberIds: string[]
  summary?: string
}

export interface BridgeNode {
  nodeId: string
  label: string
  bridgeScore: number
  concepts: string[]
}

export interface SecondBrainSearchResult {
  query: string
  expandedTerms: string[]
  results: RankedResult[]
  concepts: ConceptCluster[]
  bridges: BridgeNode[]
  total: number
}

export interface SecondBrainWeights {
  lexical: number
  semantic: number
  recency: number
  centrality: number
  richness: number
  concept: number
}

/** Weights tuned for second-brain navigation: meaning + structure over pure recency. */
export const DEFAULT_WEIGHTS: SecondBrainWeights = {
  lexical: 0.22,
  semantic: 0.28,
  recency: 0.12,
  centrality: 0.14,
  richness: 0.10,
  concept: 0.14,
}

/**
 * Concept ontology distilled from high-signal library posts on second brains,
 * agentic memory, GraphRAG, and knowledge graphs. Used for query expansion
 * and concept-affinity scoring — not as hard filters.
 */
export const CONCEPT_ONTOLOGY: Record<string, { label: string; terms: string[]; color: string }> = {
  'second-brain': {
    label: 'Second brain / PKM',
    color: '#9333ea',
    terms: [
      'second brain', 'zettelkasten', 'personal knowledge', 'pkm', 'obsidian',
      'knowledge base', 'exocortex', 'note taking', 'evergreen notes', 'digital garden',
      'roam', 'logseq', 'notion', 'memex',
    ],
  },
  'agentic-memory': {
    label: 'Agentic memory',
    color: '#7c3aed',
    terms: [
      'agent memory', 'agentic memory', 'memory system', 'mem0', 'working memory',
      'long-term memory', 'episodic memory', 'digital hippocampus', 'context engineering',
      'memory layer', 'checkpoint', 'memory ops', 'predictive memory',
    ],
  },
  'knowledge-graph': {
    label: 'Knowledge graphs',
    color: '#2563eb',
    terms: [
      'knowledge graph', 'graph rag', 'graphrag', 'property graph', 'entity resolution',
      'graph engineering', 'graph database', 'neo4j', 'code graph', 'semantic graph',
    ],
  },
  'graph-theory': {
    label: 'Graph theory',
    color: '#0891b2',
    terms: [
      'graph theory', 'nodes and edges', 'centrality', 'betweenness', 'shortest path',
      'network science', 'topology', 'hyperbolic', 'adjacency', 'spectral graph',
    ],
  },
  rag: {
    label: 'RAG / retrieval',
    color: '#0d9488',
    terms: [
      'rag', 'retrieval', 'hybrid search', 'embedding', 'vector database', 'chunking',
      'rerank', 'bm25', 'semantic search', 'context window',
    ],
  },
  agents: {
    label: 'Agents & multi-agent',
    color: '#db2777',
    terms: [
      'agent', 'agents', 'agentic', 'multi agent', 'subagents', 'swarm', 'tool use',
      'agent loop', 'orchestration', 'clawdbot', 'openclaw', 'claude code',
    ],
  },
  'context-systems': {
    label: 'Context systems',
    color: '#ea580c',
    terms: [
      'context engineering', 'compounding context', 'prompt', 'system prompt',
      'skills', 'memory file', 'claude.md', 'agents.md', 'workflow',
    ],
  },
}

const RECENCY_HALF_LIFE_DAYS = 180

let degreeCache: Map<string, number> | null = null
let degreeCacheAt = 0
const DEGREE_TTL_MS = 5 * 60_000

export function invalidateSecondBrainCaches(): void {
  degreeCache = null
  degreeCacheAt = 0
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_@.#:+/-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

/** Expand a user query with ontology terms for soft affinity (not hard FTS rewrite). */
export function expandQueryConcepts(query: string): {
  expandedTerms: string[]
  activeConcepts: string[]
  queryTokens: string[]
} {
  const raw = query.toLowerCase().trim()
  const queryTokens = tokenize(raw)
  const active = new Set<string>()
  const terms = new Set<string>(queryTokens)

  for (const [key, concept] of Object.entries(CONCEPT_ONTOLOGY)) {
    const hit = concept.terms.some((term) => raw.includes(term) || queryTokens.some((t) => term.includes(t) && t.length >= 4))
    if (!hit) continue
    active.add(key)
    for (const term of concept.terms) {
      for (const part of tokenize(term)) terms.add(part)
    }
  }

  // Implicit second-brain mode when the query is short and memory/graph flavored
  if (!active.size) {
    const memoryish = /memory|graph|brain|knowledge|pkm|agent|rag|zettel|obsidian/i.test(raw)
    if (memoryish) {
      for (const key of ['second-brain', 'agentic-memory', 'knowledge-graph'] as const) {
        active.add(key)
        for (const term of CONCEPT_ONTOLOGY[key].terms.slice(0, 6)) {
          for (const part of tokenize(term)) terms.add(part)
        }
      }
    }
  }

  return {
    expandedTerms: [...terms].slice(0, 48),
    activeConcepts: [...active],
    queryTokens,
  }
}

export function nodeIdForResult(result: Pick<SearchResult, 'id' | 'itemType'>): string {
  if (result.itemType === 'youtube') return `youtube:${result.id}`
  if (result.itemType === 'document') return `document:${result.id}`
  return `bookmark:${result.id}`
}

function recencyScore(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0.25
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0.25
  const ageDays = Math.max(0, (now - t) / 86_400_000)
  // Exponential decay with half-life; floor so old classics still surface when otherwise strong
  return clamp01(0.12 + 0.88 * Math.exp(-Math.LN2 * ageDays / RECENCY_HALF_LIFE_DAYS))
}

function richnessScore(result: SearchResult): number {
  const topics = result.topics?.length ?? 0
  const tags = result.tags?.length ?? 0
  const domains = result.domains?.length ?? 0
  const media = result.mediaTypes?.length ?? 0
  const transcript = result.transcriptStatus === 'fetched' ? 1 : 0
  const hasUrl = result.url ? 1 : 0
  const textLen = (result.text ?? '').length
  const body = clamp01(textLen / 900)
  return clamp01(
    topics * 0.12
    + Math.min(tags, 12) * 0.04
    + domains * 0.08
    + media * 0.06
    + transcript * 0.15
    + hasUrl * 0.08
    + body * 0.25,
  )
}

function conceptAffinity(
  result: SearchResult,
  expandedTerms: Set<string>,
  activeConcepts: string[],
): { score: number; keys: string[] } {
  const hay = `${result.title ?? ''} ${result.text ?? ''} ${(result.tags ?? []).join(' ')} ${(result.topics ?? []).join(' ')}`.toLowerCase()
  const tokens = new Set(tokenize(hay))
  let hits = 0
  for (const term of expandedTerms) {
    if (term.length < 3) continue
    if (tokens.has(term) || hay.includes(term)) hits++
  }
  const termScore = clamp01(hits / Math.max(6, Math.min(expandedTerms.size, 20)))

  const keys: string[] = []
  for (const key of activeConcepts.length ? activeConcepts : Object.keys(CONCEPT_ONTOLOGY)) {
    const concept = CONCEPT_ONTOLOGY[key]
    if (!concept) continue
    const match = concept.terms.some((term) => hay.includes(term))
    if (match) keys.push(key)
  }
  // Also detect ontology matches even when the query didn't activate them
  if (!activeConcepts.length) {
    for (const [key, concept] of Object.entries(CONCEPT_ONTOLOGY)) {
      if (keys.includes(key)) continue
      if (concept.terms.some((term) => hay.includes(term))) keys.push(key)
    }
  }

  const conceptBonus = clamp01(keys.length / 3)
  return { score: clamp01(termScore * 0.65 + conceptBonus * 0.35), keys: keys.slice(0, 4) }
}

function loadCentrality(db: Database.Database, nodeIds: string[]): Map<string, number> {
  const now = Date.now()
  if (!degreeCache || now - degreeCacheAt > DEGREE_TTL_MS) {
    degreeCache = new Map()
    const rows = db.prepare(`
      SELECT id, deg FROM (
        SELECT source_id AS id, COUNT(*) AS deg FROM graph_edges
        WHERE type IN ('correlates_with', 'semantic_similarity')
        GROUP BY source_id
        UNION ALL
        SELECT target_id AS id, COUNT(*) AS deg FROM graph_edges
        WHERE type IN ('correlates_with', 'semantic_similarity')
        GROUP BY target_id
      )
    `).all() as Array<{ id: string; deg: number }>
    for (const row of rows) {
      degreeCache.set(row.id, (degreeCache.get(row.id) ?? 0) + row.deg)
    }
    degreeCacheAt = now
  }
  const out = new Map<string, number>()
  let max = 1
  for (const id of nodeIds) {
    const d = degreeCache.get(id) ?? 0
    out.set(id, d)
    if (d > max) max = d
  }
  // Normalize later per-candidate against local max among candidates
  out.set('__max__', max)
  return out
}

function normalizeRanks(values: number[], invert = false): number[] {
  if (!values.length) return []
  const order = values.map((value, index) => ({ value, index }))
    .sort((a, b) => invert ? a.value - b.value : b.value - a.value)
  const ranks = new Array(values.length).fill(0.5)
  order.forEach((item, rank) => {
    ranks[item.index] = 1 - rank / Math.max(1, order.length - 1 || 1)
  })
  return ranks
}

function buildWhy(parts: ScoreBreakdown, concepts: string[], centrality: number): string[] {
  const why: string[] = []
  const ranked = [
    ['semantic', parts.semantic, 'meaning match'],
    ['lexical', parts.lexical, 'keyword match'],
    ['concept', parts.concept, 'concept affinity'],
    ['centrality', parts.centrality, 'graph hub'],
    ['recency', parts.recency, 'recent'],
    ['richness', parts.richness, 'rich content'],
  ] as const
  for (const [, score, label] of [...ranked].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    if (score >= 0.45) why.push(label)
  }
  if (concepts.length) why.push(concepts.slice(0, 2).map((k) => CONCEPT_ONTOLOGY[k]?.label ?? k).join(' · '))
  if (centrality >= 8 && !why.includes('graph hub')) why.push('well connected')
  return why.slice(0, 4)
}

/**
 * Evaluate a hybrid candidate set with multi-signal scoring.
 * `lexicalRank` / `semanticRank` are 0..1 where lower is better rank position.
 */
export function evaluateCandidates(
  db: Database.Database,
  query: string,
  candidates: Array<SearchResult & { lexicalRank?: number; semanticRank?: number }>,
  weights: SecondBrainWeights = DEFAULT_WEIGHTS,
): RankedResult[] {
  if (!candidates.length) return []
  const { expandedTerms, activeConcepts } = expandQueryConcepts(query)
  const termSet = new Set(expandedTerms)
  const nodeIds = candidates.map(nodeIdForResult)
  const degrees = loadCentrality(db, nodeIds)
  const localMaxDeg = Math.max(1, ...nodeIds.map((id) => degrees.get(id) ?? 0))

  const lexicalSignals = candidates.map((c) => {
    if (c.lexicalRank !== undefined) return 1 - clamp01(c.lexicalRank)
    // Fallback: invert raw bm25-ish score if present as negative/raw
    return c.score < 0 ? clamp01(-c.score) : clamp01(1 / (1 + Math.max(0, c.score)))
  })
  const semanticSignals = candidates.map((c) => {
    if (c.semanticScore !== undefined) return clamp01(c.semanticScore)
    if (c.semanticRank !== undefined) return 1 - clamp01(c.semanticRank)
    return 0
  })
  // Re-normalize ranks so missing channels don't dominate
  const lexN = normalizeRanks(lexicalSignals)
  const semN = normalizeRanks(semanticSignals)

  const scored: RankedResult[] = candidates.map((candidate, index) => {
    const nodeId = nodeIds[index]
    const deg = degrees.get(nodeId) ?? 0
    const centrality = clamp01(Math.log1p(deg) / Math.log1p(localMaxDeg))
    const recency = recencyScore(candidate.tweetCreatedAt)
    const richness = richnessScore(candidate)
    const { score: concept, keys } = conceptAffinity(candidate, termSet, activeConcepts)

    const breakdown: ScoreBreakdown = {
      lexical: lexN[index] ?? lexicalSignals[index],
      semantic: semN[index] ?? semanticSignals[index],
      recency,
      centrality,
      richness,
      concept,
      diversity: 1,
      composite: 0,
    }
    breakdown.composite = clamp01(
      weights.lexical * breakdown.lexical
      + weights.semantic * breakdown.semantic
      + weights.recency * breakdown.recency
      + weights.centrality * breakdown.centrality
      + weights.richness * breakdown.richness
      + weights.concept * breakdown.concept,
    )

    return {
      ...candidate,
      nodeId,
      rankScore: breakdown.composite,
      scoreBreakdown: breakdown,
      // lower is better for existing UI
      score: 1 - breakdown.composite,
      conceptKeys: keys,
      why: buildWhy(breakdown, keys, deg),
    }
  })

  scored.sort((a, b) => b.rankScore - a.rankScore)
  return scored
}

/**
 * Maximal Marginal Relevance — keep top relevance while spreading concept coverage.
 * Lambda → 1 prefers pure relevance; → 0 prefers diversity.
 */
export function mmrSelect(ranked: RankedResult[], limit: number, lambda = 0.72): RankedResult[] {
  if (ranked.length <= limit) return ranked.map((item, index) => ({
    ...item,
    scoreBreakdown: { ...item.scoreBreakdown, diversity: 1 },
    score: 1 - item.rankScore,
  }))

  const selected: RankedResult[] = []
  const remaining = [...ranked]

  while (selected.length < limit && remaining.length) {
    let bestIndex = 0
    let bestValue = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      let redundancy = 0
      if (selected.length) {
        for (const picked of selected) {
          redundancy = Math.max(redundancy, overlap(candidate, picked))
        }
      }
      const diversity = 1 - redundancy
      const value = lambda * candidate.rankScore + (1 - lambda) * diversity
      if (value > bestValue) {
        bestValue = value
        bestIndex = i
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1)
    const diversity = selected.length
      ? 1 - Math.max(...selected.map((picked) => overlap(chosen, picked)))
      : 1
    const composite = clamp01(lambda * chosen.rankScore + (1 - lambda) * diversity)
    selected.push({
      ...chosen,
      rankScore: composite,
      scoreBreakdown: { ...chosen.scoreBreakdown, diversity, composite },
      score: 1 - composite,
    })
  }
  return selected
}

function overlap(a: RankedResult, b: RankedResult): number {
  const aTags = new Set([...(a.tags ?? []), ...(a.topics ?? []), ...(a.conceptKeys ?? [])].map((t) => t.toLowerCase()))
  const bTags = [...(b.tags ?? []), ...(b.topics ?? []), ...(b.conceptKeys ?? [])].map((t) => t.toLowerCase())
  if (!aTags.size || !bTags.length) {
    // Author echo counts as mild redundancy
    if (a.authorHandle && a.authorHandle === b.authorHandle) return 0.35
    return 0
  }
  let shared = 0
  for (const tag of bTags) if (aTags.has(tag)) shared++
  const jaccard = shared / (aTags.size + bTags.length - shared)
  const sameAuthor = a.authorHandle && a.authorHandle === b.authorHandle ? 0.2 : 0
  return clamp01(jaccard + sameAuthor)
}

/** Cluster selected results into navigable concept constellations. */
export function clusterConcepts(results: RankedResult[]): ConceptCluster[] {
  const buckets = new Map<string, RankedResult[]>()
  for (const result of results) {
    const keys = result.conceptKeys?.length ? result.conceptKeys : ['unsorted']
    // Primary concept only for layout groups (multi-label lives on the node)
    const primary = keys[0]
    const list = buckets.get(primary) ?? []
    list.push(result)
    buckets.set(primary, list)
  }

  const clusters: ConceptCluster[] = []
  for (const [key, members] of buckets) {
    const ontology = CONCEPT_ONTOLOGY[key]
    const topicFallback = members[0]?.topics?.[0]
    clusters.push({
      id: `concept:${key}`,
      key,
      label: ontology?.label ?? (key === 'unsorted' ? (topicFallback ?? 'Related') : key),
      color: ontology?.color ?? '#64748b',
      count: members.length,
      memberIds: members.map((m) => m.nodeId),
      summary: members[0]?.why?.slice(0, 2).join(' · '),
    })
  }
  return clusters.sort((a, b) => b.count - a.count)
}

/**
 * Bridges connect 2+ concept clusters — highest leverage navigation nodes
 * (graph theory: betweenness via multi-membership).
 */
export function findBridges(results: RankedResult[]): BridgeNode[] {
  const bridges: BridgeNode[] = []
  for (const result of results) {
    const concepts = result.conceptKeys ?? []
    if (concepts.length < 2) continue
    const bridgeScore = concepts.length * 0.35 + result.rankScore * 0.65
    bridges.push({
      nodeId: result.nodeId,
      label: result.title || result.text.slice(0, 80),
      bridgeScore,
      concepts,
    })
  }
  return bridges.sort((a, b) => b.bridgeScore - a.bridgeScore).slice(0, 12)
}

/** Pairwise semantic-ish edges from shared concepts/tags among the visible set. */
export function conceptEdges(results: RankedResult[]): Array<{ source: string; target: string; weight: number; sharedTags?: string[] }> {
  const edges: Array<{ source: string; target: string; weight: number; sharedTags?: string[] }> = []
  const byId = results.map((r) => ({
    id: r.nodeId,
    tags: new Set([...(r.tags ?? []).slice(0, 16), ...(r.conceptKeys ?? []), ...(r.topics ?? [])].map((t) => t.toLowerCase())),
  }))
  for (let i = 0; i < byId.length; i++) {
    for (let j = i + 1; j < byId.length; j++) {
      const shared: string[] = []
      for (const tag of byId[i].tags) {
        if (byId[j].tags.has(tag)) shared.push(tag)
      }
      if (shared.length < 2) continue
      edges.push({
        source: byId[i].id,
        target: byId[j].id,
        weight: Math.min(4, shared.length),
        sharedTags: shared.slice(0, 4),
      })
    }
  }
  return edges.sort((a, b) => b.weight - a.weight).slice(0, 140)
}

export function assignConceptGroups(results: RankedResult[], concepts: ConceptCluster[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const concept of concepts) {
    for (const id of concept.memberIds) map.set(id, concept.id)
  }
  // Fallback: keep topic-style group if somehow missing
  for (const result of results) {
    if (!map.has(result.nodeId)) map.set(result.nodeId, 'concept:unsorted')
  }
  return map
}

/**
 * Full second-brain pipeline over hybrid candidates:
 * evaluate → MMR diversify → cluster → bridges.
 */
export function runSecondBrain(
  db: Database.Database,
  query: string,
  candidates: Array<SearchResult & { lexicalRank?: number; semanticRank?: number }>,
  limit: number,
  weights: SecondBrainWeights = DEFAULT_WEIGHTS,
): SecondBrainSearchResult {
  const { expandedTerms } = expandQueryConcepts(query)
  const evaluated = evaluateCandidates(db, query, candidates, weights)
  const selected = mmrSelect(evaluated, limit)
  const concepts = clusterConcepts(selected)
  const bridges = findBridges(selected)
  // Annotate bridge scores on results
  const bridgeById = new Map(bridges.map((b) => [b.nodeId, b.bridgeScore]))
  const results = selected.map((result) => ({
    ...result,
    bridgeScore: bridgeById.get(result.nodeId),
  }))

  return {
    query,
    expandedTerms,
    results,
    concepts,
    bridges,
    total: results.length,
  }
}
