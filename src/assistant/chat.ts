import { randomUUID } from 'node:crypto'
import { config } from '../lib/env'
import { parseJson, safeJson } from '../lib/hash'
import { cliAvailable, runCliPrompt, type CliProvider } from '../lib/llm-cli'
import { openAssistantDb } from './db'
import { briefForQuery, citationsFromMemories, getProfile, listIdeas, listThemes, packMemories, searchMemories, searchTimeline } from './retrieve'
import type { AssistantMode, ChatMessage, Citation } from './types'
import { hasXaiKey, xaiRespond, type XaiMessage, type XaiTool } from './xai'

export type ChatProvider = 'xai' | CliProvider

const PROVIDER_ORDER: ChatProvider[] = ['xai', 'claude', 'codex', 'grok']
const PROVIDER_HINT = 'Set `XAI_API_KEY`, or install the `claude`, `codex`, or `grok` CLI, for live chat.'

type Brief = Awaited<ReturnType<typeof briefForQuery>>

const TOOLS: XaiTool[] = [
  {
    type: 'function',
    name: 'search_library',
    description: 'Search the personal library index (X bookmarks, YouTube, browser favorites, documents).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        source_type: { type: 'string', enum: ['x', 'favorite', 'youtube', 'document'] },
        since: { type: 'string', description: 'ISO date lower bound' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_timeline',
    description: 'Return the SOTA / AI advancement timeline extracted from saved content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        kind: { type: 'string', enum: ['model_release', 'paper', 'product', 'benchmark', 'technique', 'industry'] },
      },
    },
  },
  {
    type: 'function',
    name: 'get_themes',
    description: 'Return interest themes, volume, and velocity from the library.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'get_ideas',
    description: 'Return novel or project idea seeds grounded in the library.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['novel', 'project'] } },
    },
  },
  {
    type: 'function',
    name: 'save_insight',
    description: 'Persist a user insight into working memory so later chats continue from it.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
]

const MODE_INSTRUCTIONS: Record<AssistantMode, string> = {
  discuss: 'Collaborate. Continue the user\'s intellectual thread. Cite memories as [n]. Ask a sharp follow-up when it would actually help.',
  novel: 'Propose novel ideas that combine threads already in the library. Prefer surprising but evidenced intersections. Number ideas. Cite supporting [n].',
  project: 'Propose buildable projects that continue the collections and open loops in working memory. Make them concrete: outcome, first slice, why it fits the trail.',
  timeline: 'Organize a dated SOTA AI timeline from saved items. Group by year/month. Distinguish model releases, papers, products, techniques. Note what the user seemed to care about at each beat. Do not invent dates.',
}

function modeFromText(value: string | undefined): AssistantMode {
  if (value === 'novel' || value === 'project' || value === 'timeline' || value === 'discuss') return value
  return 'discuss'
}

export function listConversations() {
  const db = openAssistantDb()
  return db.prepare(`
    SELECT id, title, mode, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations ORDER BY updated_at DESC LIMIT 40
  `).all()
}

export function getConversation(id: string): { conversation: { id: string; title: string; mode: AssistantMode }; messages: ChatMessage[] } | null {
  const db = openAssistantDb()
  const conversation = db.prepare('SELECT id, title, mode FROM conversations WHERE id = ?').get(id) as { id: string; title: string; mode: string } | undefined
  if (!conversation) return null
  const rows = db.prepare(`
    SELECT id, conversation_id AS conversationId, role, content, citations, created_at AS createdAt
    FROM messages WHERE conversation_id = ? ORDER BY created_at
  `).all(id) as Array<Record<string, unknown>>
  return {
    conversation: { id: conversation.id, title: conversation.title, mode: modeFromText(conversation.mode) },
    messages: rows.map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversationId),
      role: row.role as ChatMessage['role'],
      content: String(row.content),
      citations: parseJson<Citation[]>(String(row.citations ?? '[]'), []),
      createdAt: String(row.createdAt),
    })),
  }
}

function ensureConversation(id: string | undefined, mode: AssistantMode, title: string): string {
  const db = openAssistantDb()
  if (id) {
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id)
    if (existing) {
      db.prepare('UPDATE conversations SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mode, id)
      return id
    }
  }
  const created = id && /^[a-z0-9:-]+$/i.test(id) ? id : `conv:${randomUUID()}`
  db.prepare(`
    INSERT INTO conversations(id, title, mode) VALUES(?, ?, ?)
  `).run(created, title.slice(0, 80) || 'New conversation', mode)
  return created
}

function insertMessage(conversationId: string, role: ChatMessage['role'], content: string, citations: Citation[] = []): ChatMessage {
  const db = openAssistantDb()
  const message: ChatMessage = {
    id: `msg:${randomUUID()}`,
    conversationId,
    role,
    content,
    citations,
    createdAt: new Date().toISOString(),
  }
  db.prepare(`
    INSERT INTO messages(id, conversation_id, role, content, citations, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(message.id, conversationId, role, content, safeJson(citations), message.createdAt)
  db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId)
  if (role === 'user') {
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId) as { title: string }
    if (conv.title === 'New conversation') {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(content.replace(/\s+/g, ' ').trim().slice(0, 72), conversationId)
    }
  }
  return message
}

async function runTool(name: string, args: Record<string, unknown>, mode: AssistantMode): Promise<unknown> {
  const db = openAssistantDb()
  if (name === 'search_library') {
    const memories = await searchMemories(db, String(args.query ?? ''), {
      limit: Number(args.limit ?? 10),
      sourceType: typeof args.source_type === 'string' ? args.source_type as never : undefined,
      since: typeof args.since === 'string' ? args.since : undefined,
      mode,
    })
    return memories.map((m) => ({
      id: m.id, title: m.title, url: m.url, sourceType: m.sourceType,
      occurredAt: m.occurredAt, author: m.author, excerpt: m.body.slice(0, 360),
    }))
  }
  if (name === 'get_timeline') {
    return searchTimeline(db, {
      query: typeof args.query === 'string' ? args.query : undefined,
      since: typeof args.since === 'string' ? args.since : undefined,
      until: typeof args.until === 'string' ? args.until : undefined,
      kind: typeof args.kind === 'string' ? args.kind : undefined,
      limit: 24,
    })
  }
  if (name === 'get_themes') return listThemes(db).slice(0, 12)
  if (name === 'get_ideas') {
    const kind = args.kind === 'novel' || args.kind === 'project' ? args.kind : undefined
    return listIdeas(db, kind).slice(0, 12)
  }
  if (name === 'save_insight') {
    const text = String(args.text ?? '').trim()
    if (!text) return { ok: false }
    const current = getProfile(db).notes ?? ''
    const next = `${current}\n- ${new Date().toISOString().slice(0, 10)}: ${text}`.trim()
    db.prepare(`
      INSERT INTO profile(key, content, updated_at) VALUES('notes', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP
    `).run(next)
    return { ok: true }
  }
  return { error: `unknown tool ${name}` }
}

/** One-line library description built from the indexed trajectory, so the prompt describes this user's library. */
function librarySummary(profile: Record<string, string>): string {
  const trajectory = parseJson<{
    counts?: { x?: number; favorites?: number; youtube?: number; documents?: number }
    range?: { firstSeen?: string | null; lastSeen?: string | null }
    gravity?: string[]
  }>(profile.trajectory ?? '{}', {})
  const counts = trajectory.counts ?? {}
  const parts = ([[counts.x, 'X bookmarks'], [counts.youtube, 'YouTube saves'], [counts.favorites, 'browser favorites'], [counts.documents, 'documents']] as const)
    .filter(([n]) => Number(n) > 0)
    .map(([n, label]) => `${Number(n).toLocaleString('en-US')} ${label}`)
  const first = trajectory.range?.firstSeen?.slice(0, 4)
  const last = trajectory.range?.lastSeen?.slice(0, 4)
  const span = first && last ? ` spanning ${first}–${last}` : ''
  const gravity = trajectory.gravity?.length ? ` Gravity: ${trajectory.gravity.join(', ')}.` : ''
  return `a local library of ${parts.join(', ') || 'saved items'}${span}.${gravity}`
}

function systemPrompt(mode: AssistantMode, profile: Record<string, string>): string {
  return `You are the user's second brain over ${librarySummary(profile)}

You are isolated from the knowledge-graph visualization. Your job is collaborative discussion that continues where they left off — not a generic chatbot.

${MODE_INSTRUCTIONS[mode]}

Working memory:
${profile.narrative ? `Narrative:\n${profile.narrative}\n` : ''}
${profile.continue ? `Continue:\n${profile.continue}\n` : ''}
${profile.tastes ? `Tastes:\n${profile.tastes}\n` : ''}
${profile.open_loops ? `Open loops:\n${profile.open_loops}\n` : ''}
${profile.notes ? `Saved insights:\n${profile.notes}\n` : ''}

Rules:
- Ground claims in LIBRARY CONTEXT and tool results. Cite as [1], [2].
- If something is not in the library, say so. Do not invent bookmarks, dates, or papers.
- Prefer the user's trajectory over generic advice.
- Be dense, specific, and collaborative.`
}

function fallbackAnswer(mode: AssistantMode, brief: Brief): string {
  if (mode === 'timeline') {
    const lines = brief.events.slice(0, 20).map((event) => `- ${(event.occurredAt ?? '').slice(0, 10) || 'undated'} · **${event.kind}** · ${event.title}`)
    return `## SOTA timeline from your library\n\n${lines.join('\n') || '_Index has no dated events yet. Run `npm run assistant:index`._'}\n\n${PROVIDER_HINT}`
  }
  if (mode === 'novel' || mode === 'project') {
    const lines = brief.ideas.filter((idea) => mode === 'novel' ? idea.kind === 'novel' : idea.kind === 'project')
      .map((idea) => `### ${idea.title}\n${idea.pitch}`)
    return `## ${mode === 'novel' ? 'Novel ideas' : 'Project ideas'} from your trail\n\n${lines.join('\n\n') || '_No idea seeds yet. Run the indexer._'}\n\n${PROVIDER_HINT}`
  }
  const packed = packMemories(brief.memories, 8, 360)
  return `I retrieved these memories, but no chat provider is available. ${PROVIDER_HINT}\n\n${packed || '_No memories in the assistant index. Run `npm run assistant:index`._'}`
}

function libraryContext(brief: Brief): string {
  return `LIBRARY CONTEXT (complete for this turn):\n${packMemories(brief.memories)}\n\nThemes: ${brief.themes.map((t) => `${t.label} (${t.itemCount}, v=${t.velocity})`).join('; ')}\n\nTimeline slice:\n${brief.events.slice(0, 10).map((e) => `- ${(e.occurredAt ?? '').slice(0, 10)} [${e.kind}] ${e.title}`).join('\n')}\n\nIdea seeds:\n${brief.ideas.slice(0, 6).map((i) => `- [${i.kind}] ${i.title}: ${i.pitch}`).join('\n')}`
}

export function availableProviders(): Record<ChatProvider, boolean> {
  return { xai: hasXaiKey(), claude: cliAvailable('claude'), codex: cliAvailable('codex'), grok: cliAvailable('grok') }
}

/** `auto` picks the xAI API when keyed, else the first agent CLI on PATH; null means retrieval-only. */
export function resolveProvider(requested?: string): ChatProvider | null {
  const wanted = (requested?.trim() || config.assistantProvider).toLowerCase()
  const available = availableProviders()
  if (wanted === 'auto') return PROVIDER_ORDER.find((provider) => available[provider]) ?? null
  if (wanted === 'none' || wanted === 'retrieval') return null
  if (!PROVIDER_ORDER.includes(wanted as ChatProvider)) {
    throw new Error(`Unknown assistant provider "${wanted}". Use auto, xai, claude, codex, grok, or none.`)
  }
  if (!available[wanted as ChatProvider]) {
    throw new Error(wanted === 'xai' ? 'XAI_API_KEY is not set.' : `The ${wanted} CLI was not found on PATH.`)
  }
  return wanted as ChatProvider
}

export async function chatAssistant(input: {
  conversationId?: string
  message: string
  mode?: AssistantMode
  provider?: string
}): Promise<{ conversationId: string; message: ChatMessage; citations: Citation[]; provider: ChatProvider | 'retrieval' }> {
  const mode = input.mode ?? 'discuss'
  const text = input.message.trim()
  if (!text) throw new Error('Message is required')
  const provider = resolveProvider(input.provider)

  const conversationId = ensureConversation(input.conversationId, mode, text)
  insertMessage(conversationId, 'user', text)
  const brief = await briefForQuery(text, mode, mode === 'timeline' ? 10 : 12)

  if (!provider) {
    const content = fallbackAnswer(mode, brief)
    const message = insertMessage(conversationId, 'assistant', content, brief.citations)
    return { conversationId, message, citations: brief.citations, provider: 'retrieval' }
  }

  const history = getConversation(conversationId)?.messages ?? []
  const prior: XaiMessage[] = history
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .slice(-12, -1)
    .map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content }))

  let content: string
  if (provider === 'xai') {
    const messages: XaiMessage[] = [
      { role: 'system', content: systemPrompt(mode, brief.profile) },
      { role: 'user', content: libraryContext(brief) },
      ...prior,
      { role: 'user', content: text },
    ]

    let result = await xaiRespond({ messages, tools: TOOLS, toolChoice: 'auto' })
    for (let round = 0; round < 4 && result.toolCalls.length; round++) {
      const outputs: unknown[] = []
      for (const call of result.toolCalls) {
        outputs.push({ tool: call.name, result: await runTool(call.name, call.arguments, mode) })
      }
      messages.push({ role: 'assistant', content: result.text || 'Working from the index…' })
      messages.push({ role: 'user', content: `Tool results (complete):\n${JSON.stringify(outputs).slice(0, 14000)}` })
      result = await xaiRespond({ messages, tools: TOOLS, toolChoice: 'auto' })
    }
    content = result.text
  } else {
    // Agent CLIs answer in one tool-free turn, so the retrieval pack stands in for tool calls.
    const transcript = prior.map((row) => `${row.role === 'user' ? 'USER' : 'ASSISTANT'}: ${row.content}`).join('\n\n')
    const prompt = [
      systemPrompt(mode, brief.profile),
      'Tools are disabled. The library context below is complete; do not read files or search the web.',
      libraryContext(brief),
      transcript ? `CONVERSATION SO FAR:\n${transcript}` : '',
      `USER: ${text}`,
    ].filter(Boolean).join('\n\n')
    content = await runCliPrompt(provider, prompt)
  }

  const message = insertMessage(conversationId, 'assistant', content.trim() || 'I could not form an answer from the index.', brief.citations)
  return { conversationId, message, citations: brief.citations, provider }
}
