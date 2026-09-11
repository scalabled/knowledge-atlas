import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDb } from '../lib/db'
import { closeAssistantDb } from './db'
import { extractEventsFromItem, mergeEvents } from './events'
import { buildAssistantIndex } from './indexer'
import { listIdeas, listThemes, searchMemories, searchTimeline } from './retrieve'
import { openAssistantDb } from './db'
import type { CatalogItem } from './types'

function item(partial: Partial<CatalogItem> & { title: string; body: string }): CatalogItem {
  return {
    sourceType: 'x',
    sourceId: partial.sourceId ?? '1',
    graphNodeId: 'bookmark:1',
    url: 'https://x.com/a/status/1',
    occurredAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    author: 'karpathy',
    authorName: 'Andrej Karpathy',
    topics: ['ai-ml'],
    tags: [],
    ...partial,
  }
}

test('extractEventsFromItem catches model releases and papers', () => {
  const release = extractEventsFromItem(item({
    title: 'Grok-4 released today',
    body: 'xAI released Grok-4 with a new agent memory layer. SOTA on SWE-bench.',
  }), 'x:1')
  assert.equal(release[0]?.kind, 'model_release')
  assert.ok((release[0]?.confidence ?? 0) >= 0.8)

  const paper = extractEventsFromItem(item({
    title: 'New GraphRAG paper',
    body: 'Read https://arxiv.org/abs/2404.16130 on graph retrieval.',
  }), 'x:2')
  assert.equal(paper[0]?.kind, 'paper')
  assert.ok(paper[0]?.entities.some((entity) => entity.includes('2404.16130')))
})

test('mergeEvents dedupes same kind/title/month', () => {
  const a = extractEventsFromItem(item({ title: 'Claude 4 Opus launched', body: 'Anthropic released Claude 4 Opus today' }), 'x:1')
  const b = extractEventsFromItem(item({
    sourceId: '2',
    title: 'Claude 4 Opus launched with tools',
    body: 'Anthropic released Claude 4 Opus for agents',
  }), 'x:2')
  const merged = mergeEvents([...a, ...b])
  assert.ok(merged.length <= 2)
  assert.ok(merged[0].memoryIds.length >= 1)
})

test('indexer reads a catalog read-only and writes an isolated assistant db', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-index-'))
  const catalogPath = path.join(dir, 'bookmarks.db')
  const assistantPath = path.join(dir, 'assistant.db')
  const catalog = new Database(catalogPath)
  initDb(catalog)
  catalog.exec(`
    INSERT INTO authors(id, handle, name) VALUES('a1', 'karpathy', 'Andrej Karpathy');
    INSERT INTO topics(id, slug, name, color) VALUES('t1', 'ai-ml', 'AI & Machine Learning', '#7c3aed');
    INSERT INTO topics(id, slug, name, color) VALUES('t2', 'science-research', 'Science & Research', '#2563eb');
    INSERT INTO bookmarks(id, tweet_id, text, author_id, author_handle, author_name, tweet_created_at, raw_json, source)
    VALUES
      ('b1', '11', 'Grok-4 released with GraphRAG agent memory. Continuing the second brain work.', 'a1', 'karpathy', 'Andrej Karpathy', '2026-03-01T00:00:00Z', '{}', 'bookmark'),
      ('b2', '12', 'Notes on force-directed graph layout and label placement.', 'a1', 'karpathy', 'Andrej Karpathy', '2026-03-02T00:00:00Z', '{}', 'bookmark');
    INSERT INTO bookmark_topics(bookmark_id, topic_id, confidence) VALUES('b1', 't1', 0.9), ('b1', 't2', 0.6), ('b2', 't2', 0.8);
    INSERT INTO youtube_videos(id, video_id, title, description, channel_name, published_at, raw_json)
    VALUES ('y1', 'abc', 'Training a Private LLM on My Second Brain Notes', 'PKM and agents', 'The Augmented', '2025-02-13T00:00:00Z', '{}');
    INSERT INTO youtube_video_topics(video_id, topic_id) VALUES('y1', 't1');
  `)
  catalog.close()

  const result = await buildAssistantIndex({
    catalogPath,
    assistantPath,
    distill: false,
    onProgress: () => {},
  })
  assert.ok(result.memoriesWritten >= 3)
  assert.equal(result.distilled, false)

  const assistant = openAssistantDb(assistantPath)
  const themes = listThemes(assistant)
  assert.ok(themes.some((theme) => theme.slug === 'ai-ml'))
  const hits = await searchMemories(assistant, 'GraphRAG agent memory', { limit: 5 })
  assert.ok(hits.some((hit) => hit.title.toLowerCase().includes('graphrag') || hit.body.toLowerCase().includes('graphrag')))
  const timeline = searchTimeline(assistant, { query: 'Grok' })
  assert.ok(timeline.length >= 1)
  const ideas = listIdeas(assistant)
  assert.ok(Array.isArray(ideas))

  closeAssistantDb(assistantPath)
  fs.rmSync(dir, { recursive: true, force: true })
})
