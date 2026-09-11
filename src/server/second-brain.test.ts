import test from 'node:test'
import assert from 'node:assert/strict'
import {
  expandQueryConcepts,
  evaluateCandidates,
  mmrSelect,
  clusterConcepts,
  findBridges,
  conceptEdges,
  type RankedResult,
} from './second-brain'
import type { SearchResult } from '../lib/types'

function fakeDb() {
  return {
    prepare() {
      return {
        all: () => [] as Array<{ id: string; deg: number }>,
      }
    },
  } as unknown as import('better-sqlite3').Database
}

function item(partial: Partial<SearchResult> & { id: string; text: string }): SearchResult {
  return {
    tweetId: partial.id,
    authorHandle: partial.authorHandle ?? 'author',
    authorName: partial.authorName ?? 'Author',
    tweetCreatedAt: partial.tweetCreatedAt ?? '2026-06-01T00:00:00Z',
    topics: partial.topics ?? ['AI & Machine Learning'],
    tags: partial.tags ?? [],
    domains: partial.domains ?? [],
    mediaTypes: partial.mediaTypes ?? [],
    score: partial.score ?? 0,
    itemType: partial.itemType ?? 'x',
    ...partial,
  }
}

test('expandQueryConcepts activates second-brain ontology', () => {
  const expanded = expandQueryConcepts('agentic memory and knowledge graphs')
  assert.ok(expanded.activeConcepts.includes('agentic-memory') || expanded.activeConcepts.includes('knowledge-graph'))
  assert.ok(expanded.expandedTerms.length > 5)
})

test('evaluateCandidates ranks semantic+concept heavy items higher', () => {
  const candidates = [
    item({
      id: 'weak',
      text: 'random startup fundraising tip',
      lexicalRank: 0.1,
      semanticScore: 0.2,
      tags: ['startups'],
    } as SearchResult & { lexicalRank: number }),
    item({
      id: 'strong',
      text: 'Agentic memory systems and GraphRAG for a second brain knowledge graph',
      lexicalRank: 0.4,
      semanticScore: 0.92,
      tags: ['memory', 'graph', 'rag', 'agents'],
      topics: ['AI & Machine Learning', 'Productivity & PKM'],
    } as SearchResult & { lexicalRank: number }),
  ].map((row, index) => ({
    ...row,
    lexicalRank: index === 0 ? 0.1 : 0.4,
    semanticRank: index === 0 ? 0.9 : 0.05,
    semanticScore: index === 0 ? 0.2 : 0.92,
  }))

  const ranked = evaluateCandidates(fakeDb(), 'agentic memory knowledge graph', candidates)
  assert.equal(ranked[0].id, 'strong')
  assert.ok((ranked[0].rankScore ?? 0) > (ranked[1].rankScore ?? 0))
  assert.ok((ranked[0].conceptKeys?.length ?? 0) >= 1)
  assert.ok((ranked[0].why?.length ?? 0) >= 1)
})

test('mmrSelect diversifies same-author duplicates', () => {
  const base: RankedResult[] = Array.from({ length: 6 }, (_, i) => ({
    ...item({
      id: `n${i}`,
      text: i < 4 ? 'second brain zettelkasten notes' : `unique topic ${i} retrieval graph`,
      authorHandle: i < 4 ? 'same-author' : `other${i}`,
      tags: i < 4 ? ['pkm', 'notes'] : [`tag${i}`, 'graph'],
      conceptKeys: i < 4 ? ['second-brain'] : ['knowledge-graph'],
    }),
    nodeId: `bookmark:n${i}`,
    rankScore: 1 - i * 0.05,
    score: i * 0.05,
    scoreBreakdown: {
      lexical: 0.8, semantic: 0.8, recency: 0.5, centrality: 0.2, richness: 0.4, concept: 0.7, diversity: 1, composite: 1 - i * 0.05,
    },
    why: ['meaning match'],
    conceptKeys: i < 4 ? ['second-brain'] : ['knowledge-graph'],
  }))

  const selected = mmrSelect(base, 3, 0.55)
  assert.equal(selected.length, 3)
  const authors = new Set(selected.map((row) => row.authorHandle))
  assert.ok(authors.size >= 2, 'MMR should not pick only one author when alternatives exist')
})

test('clusterConcepts and bridges surface multi-membership hubs', () => {
  const results: RankedResult[] = [
    {
      ...item({ id: 'a', text: 'second brain', tags: ['pkm'] }),
      nodeId: 'bookmark:a', rankScore: 0.9, score: 0.1,
      scoreBreakdown: { lexical: 1, semantic: 1, recency: 1, centrality: 0, richness: 0, concept: 1, diversity: 1, composite: 0.9 },
      why: [], conceptKeys: ['second-brain'],
    },
    {
      ...item({ id: 'b', text: 'agent memory', tags: ['memory'] }),
      nodeId: 'bookmark:b', rankScore: 0.88, score: 0.12,
      scoreBreakdown: { lexical: 1, semantic: 1, recency: 1, centrality: 0, richness: 0, concept: 1, diversity: 1, composite: 0.88 },
      why: [], conceptKeys: ['agentic-memory'],
    },
    {
      ...item({ id: 'c', text: 'bridge node', tags: ['pkm', 'memory'] }),
      nodeId: 'bookmark:c', rankScore: 0.85, score: 0.15,
      scoreBreakdown: { lexical: 1, semantic: 1, recency: 1, centrality: 0, richness: 0, concept: 1, diversity: 1, composite: 0.85 },
      why: [], conceptKeys: ['second-brain', 'agentic-memory'],
    },
  ]
  const clusters = clusterConcepts(results)
  assert.ok(clusters.length >= 2)
  const bridges = findBridges(results)
  assert.equal(bridges[0].nodeId, 'bookmark:c')
  const edges = conceptEdges(results)
  assert.ok(edges.some((edge) => edge.source === 'bookmark:a' || edge.target === 'bookmark:a'))
})
