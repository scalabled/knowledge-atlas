import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUp, Brain, Compass, ExternalLink, Lightbulb, LoaderCircle, MessageSquarePlus,
  Network, Sparkles, TimerReset,
} from 'lucide-react'
import MarkdownView from './components/MarkdownView'

type Mode = 'discuss' | 'novel' | 'project' | 'timeline'

interface Status {
  memories: number
  embeddings: number
  events: number
  ideas: number
  themes: number
  conversations: number
  xai?: boolean
  providers?: Record<string, boolean>
  lastRun: { status: string; startedAt: string; finishedAt: string | null; memoriesWritten: number } | null
  catalog?: { x: number; favorites: number; youtube: number; documents: number }
}

interface Citation {
  id: string
  title: string
  url: string | null
  sourceType: string
  occurredAt: string | null
  author: string | null
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  citations: Citation[]
  createdAt: string
}

interface Conversation {
  id: string
  title: string
  mode: string
  updatedAt: string
}

interface Theme {
  slug: string
  label: string
  itemCount: number
  recentCount: number
  velocity: number
}

interface Idea {
  kind: string
  title: string
  pitch: string
}

interface EventRow {
  occurredAt: string | null
  kind: string
  title: string
}

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'discuss', label: 'Discuss', hint: 'Continue the thread' },
  { id: 'novel', label: 'Novel ideas', hint: 'Intersections in the trail' },
  { id: 'project', label: 'Projects', hint: 'What to build next' },
  { id: 'timeline', label: 'SOTA timeline', hint: 'Dated AI advancements' },
]

const PROVIDERS: Array<{ id: string; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'xai', label: 'xAI API' },
  { id: 'claude', label: 'Claude CLI' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'grok', label: 'Grok CLI' },
]

const PROVIDER_KEY = 'assistant-provider'

const STARTERS: Array<{ mode: Mode; label: string; prompt: string }> = [
  { mode: 'discuss', label: 'Continue where I left off', prompt: 'Read my library trajectory and tell me where I actually left off — open loops, gravity, and the next conversation we should have.' },
  { mode: 'novel', label: 'Novel ideas from the trail', prompt: 'Propose novel ideas that only make sense given what I have been saving. Prefer intersections between my strongest themes. Cite memories.' },
  { mode: 'project', label: 'Projects I should build', prompt: 'Propose concrete projects that continue my collections and open loops. First slice for each.' },
  { mode: 'timeline', label: 'SOTA AI timeline', prompt: 'Organize a timeline of SOTA AI advancements from my saved X, YouTube, and web items. Group by year. Call out what I seemed to care about at each beat.' },
]

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!text.trim()) throw new Error(`API ${res.status} empty body`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON from API (HTTP ${res.status})`)
  }
}

export default function AssistantApp({ onOpenAtlas }: { onOpenAtlas: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [mode, setMode] = useState<Mode>('discuss')
  const [provider, setProvider] = useState<string>(() => {
    try { return localStorage.getItem(PROVIDER_KEY) || 'auto' } catch { return 'auto' }
  })
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [themes, setThemes] = useState<Theme[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const scroller = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    fetch('/api/assistant/status').then((res) => readJson<Status>(res)).then(setStatus).catch(() => {})
    fetch('/api/assistant/conversations').then((res) => readJson<Conversation[]>(res)).then(setConversations).catch(() => {})
    fetch('/api/assistant/themes').then((res) => readJson<Theme[]>(res)).then(setThemes).catch(() => {})
    fetch('/api/assistant/ideas').then((res) => readJson<Idea[]>(res)).then(setIdeas).catch(() => {})
    fetch('/api/assistant/timeline?since=2023-01-01&limit=16').then((res) => readJson<EventRow[]>(res)).then(setEvents).catch(() => {})
  }, [])

  useEffect(() => {
    document.title = 'Second brain'
    refresh()
    return () => { document.title = 'Knowledge Atlas' }
  }, [refresh])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  async function openConversation(id: string) {
    const found = await readJson<{ conversation: { mode: Mode }; messages: ChatMessage[] }>(
      await fetch(`/api/assistant/conversations/${id}`),
    )
    setConversationId(id)
    setMessages(found.messages)
    setMode(found.conversation.mode)
    setError('')
  }

  function chooseProvider(value: string) {
    setProvider(value)
    try { localStorage.setItem(PROVIDER_KEY, value) } catch { /* storage unavailable */ }
  }

  function newChat() {
    setConversationId(null)
    setMessages([])
    setError('')
  }

  async function send(text = draft) {
    const message = text.trim()
    if (!message || busy) return
    setDraft('')
    setBusy(true)
    setError('')
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: 'user', content: message, citations: [], createdAt: new Date().toISOString() },
    ])
    try {
      const result = await readJson<{ conversationId: string; message: ChatMessage; citations: Citation[] }>(
        await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, mode, conversationId, provider }),
        }),
      )
      setConversationId(result.conversationId)
      const loaded = await readJson<{ messages: ChatMessage[] }>(
        await fetch(`/api/assistant/conversations/${result.conversationId}`),
      )
      setMessages(loaded.messages)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const empty = !status || status.memories === 0
  const noProvider = Boolean(status?.providers) && !Object.values(status?.providers ?? {}).some(Boolean)

  return (
    <div className="assistant-shell">
      <aside className="assistant-rail">
        <div className="assistant-brand">
          <div className="brand-mark"><Brain size={19} /></div>
          <div>
            <h1>Second brain</h1>
            <span>Chat over the library index</span>
          </div>
        </div>
        <button className="atlas-link" onClick={onOpenAtlas}><Network size={14} />Knowledge Atlas</button>
        <button className="new-chat" onClick={newChat}><MessageSquarePlus size={14} />New conversation</button>
        <div className="mode-grid">
          {MODES.map((item) => (
            <button key={item.id} className={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)} title={item.hint}>
              {item.id === 'timeline' ? <TimerReset size={13} /> : item.id === 'novel' || item.id === 'project' ? <Lightbulb size={13} /> : <Sparkles size={13} />}
              {item.label}
            </button>
          ))}
        </div>
        <label className="provider-picker">
          <span>Answer with</span>
          <select value={provider} onChange={(event) => chooseProvider(event.target.value)}>
            {PROVIDERS.map((item) => {
              const missing = item.id !== 'auto' && status?.providers ? !status.providers[item.id] : false
              return <option key={item.id} value={item.id} disabled={missing}>{item.label}{missing ? ' (not found)' : ''}</option>
            })}
          </select>
        </label>
        <div className="stat-grid four">
          <div><strong>{(status?.memories ?? 0).toLocaleString()}</strong><span>Memories</span></div>
          <div><strong>{(status?.events ?? 0).toLocaleString()}</strong><span>Events</span></div>
          <div><strong>{(status?.ideas ?? 0).toLocaleString()}</strong><span>Ideas</span></div>
          <div><strong>{(status?.themes ?? 0).toLocaleString()}</strong><span>Themes</span></div>
        </div>
        {empty ? <p className="index-hint">Index is empty. Run <code>npm run assistant:index</code>. It never writes the catalog database.</p> : null}
        {noProvider ? <p className="index-hint">Retrieval works now. For live chat, set <code>XAI_API_KEY</code> or install the <code>claude</code>, <code>codex</code>, or <code>grok</code> CLI.</p> : null}
        <div className="rail-heading">Conversations</div>
        <div className="conv-list">
          {conversations.map((conv) => (
            <button key={conv.id} className={conv.id === conversationId ? 'active' : ''} onClick={() => void openConversation(conv.id)}>
              <b>{conv.title}</b>
              <span>{conv.mode}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="assistant-main">
        <div className="assistant-log" ref={scroller}>
          {messages.length === 0 ? (
            <div className="assistant-empty">
              <Brain size={28} />
              <h2>Continue where you left off</h2>
              <p>This surface is isolated from the graph. It talks to a derived index of your X bookmarks, YouTube, and favorites.</p>
              <div className="starter-grid">
                {STARTERS.map((starter) => (
                  <button key={starter.label} onClick={() => { setMode(starter.mode); void send(starter.prompt) }}>
                    <strong>{starter.label}</strong>
                    <span>{starter.prompt.slice(0, 110)}…</span>
                  </button>
                ))}
              </div>
            </div>
          ) : messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role}`}>
              {message.role === 'assistant' ? <MarkdownView content={message.content} /> : <p>{message.content}</p>}
              {message.role === 'assistant' && message.citations?.length ? (
                <div className="cite-row">
                  {message.citations.slice(0, 8).map((cite, index) => (
                    <a key={cite.id} href={cite.url ?? undefined} target="_blank" rel="noreferrer">
                      [{index + 1}] {cite.title.slice(0, 48)}
                    </a>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
          {busy ? <div className="bubble assistant pending"><LoaderCircle className="spin" size={16} /> Searching the index…</div> : null}
          {error ? <div className="assistant-error">{error}</div> : null}
        </div>
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={MODES.find((item) => item.id === mode)?.hint}
            rows={3}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Send"><ArrowUp size={16} /></button>
        </form>
      </main>

      <aside className="assistant-context">
        <div className="rail-heading"><Compass size={14} /> Themes</div>
        <div className="theme-list">
          {themes.slice(0, 8).map((theme) => (
            <div key={theme.slug}>
              <b>{theme.label}</b>
              <span>{theme.itemCount.toLocaleString()} · 90d {theme.recentCount} · v {theme.velocity.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="rail-heading"><TimerReset size={14} /> Timeline</div>
        <div className="event-list">
          {events.slice(0, 10).map((event, index) => (
            <div key={`${event.title}-${index}`}>
              <b>{(event.occurredAt ?? '').slice(0, 10) || 'undated'}</b>
              <span>{event.kind} · {event.title}</span>
            </div>
          ))}
        </div>
        <div className="rail-heading"><Lightbulb size={14} /> Idea seeds</div>
        <div className="idea-list">
          {ideas.slice(0, 6).map((idea) => (
            <button key={idea.title} onClick={() => { setMode(idea.kind === 'project' ? 'project' : 'novel'); void send(`Develop this ${idea.kind} idea against my library: ${idea.title}. ${idea.pitch}`) }}>
              <b>{idea.title}</b>
              <span>{idea.pitch.slice(0, 140)}</span>
            </button>
          ))}
        </div>
        <p className="index-hint"><ExternalLink size={12} /> Graph visualization is unchanged — this rail is the assistant index only.</p>
      </aside>
    </div>
  )
}
