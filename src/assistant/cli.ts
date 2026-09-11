#!/usr/bin/env tsx
import { config } from '../lib/env'
import { chatAssistant } from './chat'
import { buildAssistantIndex, loadAssistantStatus, refreshAssistantDerived } from './indexer'
import { briefForQuery } from './retrieve'
import type { AssistantMode } from './types'

interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function numFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const raw = flags[key]
  if (typeof raw !== 'string') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0] ?? 'help'

  if (command === 'help' || command === '--help' || command === '-h') {
    print({
      usage: 'tsx src/assistant/cli.ts <command> [flags]',
      isolation: 'Never writes data/bookmarks.db. Safe to run while crawl:x is in progress.',
      commands: {
        index: 'Read catalog read-only → data/assistant.db (--distill, --limit N, --since ISO)',
        derive: 'Rebuild themes/ideas/profile from existing memories (no catalog rescan)',
        distill: 'LLM pass over an existing assistant index (requires XAI_API_KEY)',
        status: 'Print assistant index counts',
        query: 'Retrieve memories/themes/events/ideas for a question (rest of argv)',
        chat: 'One-shot chat turn against the index (--mode discuss|novel|project|timeline, --provider auto|xai|claude|codex|grok|none)',
      },
    })
    return
  }

  if (command === 'status') {
    print({ assistantDb: config.assistantDbPath, catalogDb: config.dbPath, ...loadAssistantStatus() })
    return
  }

  if (command === 'derive') {
    print(refreshAssistantDerived())
    return
  }

  if (command === 'index' || command === 'distill') {
    const result = await buildAssistantIndex({
      distill: command === 'distill' || Boolean(flags.distill),
      limit: numFlag(flags, 'limit'),
      since: typeof flags.since === 'string' ? flags.since : undefined,
    })
    print({ assistantDb: config.assistantDbPath, ...result, status: loadAssistantStatus() })
    return
  }

  if (command === 'query') {
    const query = positional.slice(1).join(' ').trim() || String(flags.q ?? '')
    if (!query) throw new Error('Pass a query: tsx src/assistant/cli.ts query agent memory')
    const mode = (typeof flags.mode === 'string' ? flags.mode : 'discuss') as AssistantMode
    const brief = await briefForQuery(query, ['discuss', 'novel', 'project', 'timeline'].includes(mode) ? mode : 'discuss', 10)
    print({
      query,
      memories: brief.memories.map((m) => ({
        id: m.id, score: Number(m.score.toFixed(3)), why: m.why, title: m.title,
        author: m.author, occurredAt: m.occurredAt, url: m.url,
      })),
      themes: brief.themes.map((t) => ({ label: t.label, itemCount: t.itemCount, velocity: t.velocity })),
      events: brief.events.slice(0, 12).map((e) => ({ occurredAt: e.occurredAt, kind: e.kind, title: e.title })),
      ideas: brief.ideas.map((i) => ({ kind: i.kind, title: i.title, pitch: i.pitch })),
    })
    return
  }

  if (command === 'chat') {
    const message = positional.slice(1).join(' ').trim()
    if (!message) throw new Error('Pass a message: tsx src/assistant/cli.ts chat --mode timeline "what changed in 2025?"')
    const mode = (typeof flags.mode === 'string' ? flags.mode : 'discuss') as AssistantMode
    const result = await chatAssistant({
      message,
      mode: ['discuss', 'novel', 'project', 'timeline'].includes(mode) ? mode : 'discuss',
      conversationId: typeof flags.conversation === 'string' ? flags.conversation : undefined,
      provider: typeof flags.provider === 'string' ? flags.provider : undefined,
    })
    print({
      conversationId: result.conversationId,
      provider: result.provider,
      answer: result.message.content,
      citations: result.citations,
    })
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
})
