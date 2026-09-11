import { stableId } from '../lib/hash'
import type { CatalogItem, EventKind, TimelineEvent } from './types'

const MODEL_PATTERNS: Array<{ re: RegExp; entity: (m: RegExpMatchArray) => string; kind: EventKind }> = [
  { re: /\b(gpt-?\s?\d(?:\.\d)?[a-z0-9-]*)\b/i, entity: (m) => normalizeModel(m[1]), kind: 'model_release' },
  { re: /\b(claude(?:\s+\d(?:\.\d)?)?(?:\s+(?:opus|sonnet|haiku|code))?)\b/i, entity: (m) => titleCase(m[1]), kind: 'model_release' },
  { re: /\b(grok(?:[-\s]?\d(?:\.\d)?)?(?:\s*(?:bot|code|imagine|4\.6|4\.5))?)\b/i, entity: (m) => titleCase(m[1]), kind: 'model_release' },
  { re: /\b(gemini(?:\s+\d(?:\.\d)?)?(?:\s+(?:flash|pro|ultra))?)\b/i, entity: (m) => titleCase(m[1]), kind: 'model_release' },
  { re: /\b(llama[-\s]?\d(?:\.\d)?(?:\s+\d+b)?)\b/i, entity: (m) => titleCase(m[1]), kind: 'model_release' },
  { re: /\b(deepseek(?:-[a-z0-9]+)?)\b/i, entity: (m) => titleCase(m[1]), kind: 'model_release' },
  { re: /\b(o[1-9](?:-mini|-preview|-pro)?)\b/i, entity: (m) => m[1].toLowerCase(), kind: 'model_release' },
  { re: /\b(mistral(?:\s+(?:large|small|nemo))?|qwen(?:\d(?:\.\d)?)?|gemma(?:\s?\d)?)\b/i, entity: (m) => titleCase(m[1]), kind: 'model_release' },
]

const PRODUCT_RE = /\b(cursor|windsurf|devin|codex|claude code|grok bot|mcp|mem0|obsidian|dify|langgraph|langchain|autogen|crewai|openclaw|clawdbot)\b/i
const PAPER_RE = /arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i
const RELEASE_RE = /\b(releas(?:e|ed|ing)|launch(?:ed|ing)?|announc(?:e|ed|ing)|introduc(?:e|ed|ing)|unveil(?:ed|ing)?|drops|dropped|sota|state[- ]of[- ]the[- ]art|frontier|weights|open[- ]weight)\b/i
const BENCH_RE = /\b(mmlu|swe-bench|humaneval|gpqa|livecodebench|arena|lmsys|benchmark)\b/i
const TECHNIQUE_RE = /\b(graphrag|rag|rlhf|dpo|moe|mixture of experts|speculative decoding|chain of thought|tool use|mcp|agent memory|memory layer)\b/i

function titleCase(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeModel(value: string): string {
  return value.replace(/\s+/g, '').replace(/gpt/i, 'GPT')
}

function haystack(item: Pick<CatalogItem, 'title' | 'body' | 'tags'>): string {
  return `${item.title}\n${item.body}\n${item.tags.join(' ')}`
}

export function extractEventsFromItem(item: CatalogItem, memoryId: string): TimelineEvent[] {
  const text = haystack(item)
  const events: TimelineEvent[] = []
  const entities = new Set<string>()
  let kind: EventKind | null = null
  let confidence = 0
  let title = item.title

  const paper = text.match(PAPER_RE)
  if (paper) {
    kind = 'paper'
    confidence = 0.82
    entities.add(`arxiv:${paper[1]}`)
    title = `arXiv ${paper[1]} — ${item.title}`
  }

  for (const pattern of MODEL_PATTERNS) {
    const match = text.match(pattern.re)
    if (!match) continue
    const entity = pattern.entity(match)
    entities.add(entity)
    if (!kind || kind === 'technique' || kind === 'industry') {
      kind = pattern.kind
      title = RELEASE_RE.test(text) ? `${entity} — ${item.title}` : item.title
    }
    confidence = Math.max(confidence, RELEASE_RE.test(text) ? 0.84 : 0.58)
  }

  if (BENCH_RE.test(text) && (kind === 'model_release' || RELEASE_RE.test(text))) {
    if (!kind) kind = 'benchmark'
    confidence = Math.max(confidence, 0.7)
  }

  if (!kind && PRODUCT_RE.test(text) && RELEASE_RE.test(text)) {
    kind = 'product'
    confidence = 0.62
    const product = text.match(PRODUCT_RE)
    if (product) entities.add(product[1])
  }

  if (!kind && TECHNIQUE_RE.test(text) && (RELEASE_RE.test(text) || /new|novel|paper|method/i.test(text))) {
    kind = 'technique'
    confidence = 0.55
  }

  if (!kind && RELEASE_RE.test(text) && /\b(openai|anthropic|google|xai|x ai|meta|mistral|deepseek)\b/i.test(text)) {
    kind = 'industry'
    confidence = 0.5
  }

  if (!kind || confidence < 0.5) return events

  const summary = item.body.replace(/\s+/g, ' ').trim().slice(0, 420)
  const occurredAt = item.occurredAt
  const id = stableId('event', `${kind}:${normalizeTitle(title)}:${(occurredAt ?? '').slice(0, 10)}`)
  events.push({
    id,
    occurredAt,
    title: title.slice(0, 180),
    kind,
    summary,
    entities: [...entities].slice(0, 8),
    memoryIds: [memoryId],
    confidence,
    source: 'heuristic',
  })
  return events
}

export function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)
}

export function mergeEvents(events: TimelineEvent[]): TimelineEvent[] {
  const buckets = new Map<string, TimelineEvent>()
  for (const event of events) {
    const key = `${event.kind}:${normalizeTitle(event.title).slice(0, 48)}:${(event.occurredAt ?? '').slice(0, 7)}`
    const existing = buckets.get(key)
    if (!existing) {
      buckets.set(key, { ...event, memoryIds: [...event.memoryIds], entities: [...event.entities] })
      continue
    }
    existing.memoryIds = [...new Set([...existing.memoryIds, ...event.memoryIds])]
    existing.entities = [...new Set([...existing.entities, ...event.entities])]
    existing.confidence = Math.max(existing.confidence, event.confidence)
    if ((event.summary?.length ?? 0) > (existing.summary?.length ?? 0)) existing.summary = event.summary
  }
  return [...buckets.values()].sort((a, b) => String(b.occurredAt ?? '').localeCompare(String(a.occurredAt ?? '')))
}
