import type Database from 'better-sqlite3'
import { safeJson, stableId } from '../lib/hash'
import { xaiJson } from './xai'
import { getProfile, listIdeas, listThemes, searchTimeline } from './retrieve'
import type { IdeaKind, TimelineEvent } from './types'

interface DistillResult {
  eventsWritten: number
  ideasWritten: number
}

export async function distillAssistant(
  db: Database.Database,
  opts: { onProgress?: (message: string) => void } = {},
): Promise<DistillResult> {
  const log = opts.onProgress ?? (() => {})
  let eventsWritten = 0
  let ideasWritten = 0

  const themes = listThemes(db)
  const profile = getProfile(db)
  const existingIdeas = listIdeas(db)
  const events = searchTimeline(db, { since: '2023-01-01', limit: 40 })
  const samples = db.prepare(`
    SELECT id, title, substr(body, 1, 420) AS body, occurred_at AS occurredAt, author, topic_primary AS topic
    FROM memories
    WHERE topic_primary = 'ai-ml' AND occurred_at IS NOT NULL
    ORDER BY occurred_at DESC
    LIMIT 36
  `).all() as Array<{ id: string; title: string; body: string; occurredAt: string; author: string; topic: string }>

  log('[assistant] distill: writing narrative profile')
  try {
    const narrative = await xaiJson<{ narrative: string; tastes: string[]; continue: string[] }>([
      {
        role: 'system',
        content: 'You distill a personal knowledge library into a second-brain profile. Return JSON only.',
      },
      {
        role: 'user',
        content: `Library trajectory JSON:\n${profile.trajectory ?? '{}'}\n\nOpen loops:\n${profile.open_loops ?? ''}\n\nTheme summary:\n${themes.slice(0, 8).map((t) => `${t.label}: ${t.itemCount} items, velocity ${t.velocity}`).join('\n')}\n\nRecent AI saves:\n${samples.slice(0, 12).map((s) => `- ${s.occurredAt.slice(0, 10)} @${s.author}: ${s.title}`).join('\n')}\n\nReturn JSON: { "narrative": "2-4 paragraphs continuing this person's intellectual trajectory", "tastes": ["short taste bullets"], "continue": ["where they left off / next moves"] }`,
      },
    ])
    upsertProfile(db, 'narrative', narrative.narrative)
    upsertProfile(db, 'tastes', (narrative.tastes ?? []).join('\n'))
    upsertProfile(db, 'continue', (narrative.continue ?? []).join('\n'))
  } catch (error) {
    log(`[assistant] distill profile failed: ${error instanceof Error ? error.message : error}`)
  }

  log('[assistant] distill: canonical SOTA events')
  try {
    const extracted = await xaiJson<{ events: Array<{ occurred_at?: string; title: string; kind: TimelineEvent['kind']; summary: string; entities?: string[]; memory_ids?: string[] }> }>([
      {
        role: 'system',
        content: 'Extract real AI/SOTA events from a personal library. Ignore ads, hustle threads, and vague takes. JSON only.',
      },
      {
        role: 'user',
        content: `Heuristic events already found:\n${events.slice(0, 20).map((e) => `${(e.occurredAt ?? '').slice(0, 10)} [${e.kind}] ${e.title}`).join('\n')}\n\nRecent AI memories:\n${samples.map((s) => `${s.id} | ${s.occurredAt.slice(0, 10)} | @${s.author} | ${s.title}\n${s.body}`).join('\n---\n')}\n\nReturn JSON: { "events": [{ "occurred_at": "ISO if known", "title": "short canonical title", "kind": "model_release|paper|product|benchmark|technique|industry", "summary": "1-2 sentences", "entities": ["names"], "memory_ids": ["id"] }] }\nMax 18 events. Deduplicate.`,
      },
    ])
    eventsWritten = upsertLlmEvents(db, extracted.events ?? [])
  } catch (error) {
    log(`[assistant] distill events failed: ${error instanceof Error ? error.message : error}`)
  }

  log('[assistant] distill: novel + project ideas')
  try {
    const extracted = await xaiJson<{ ideas: Array<{ kind: IdeaKind; title: string; pitch: string; evidence?: string[]; novelty?: number }> }>([
      {
        role: 'system',
        content: 'Propose ideas that continue THIS library, not generic startup ideas. JSON only.',
      },
      {
        role: 'user',
        content: `Trajectory:\n${profile.trajectory ?? '{}'}\n\nOpen loops:\n${profile.open_loops ?? ''}\n\nExisting idea seeds:\n${existingIdeas.map((i) => `- [${i.kind}] ${i.title}: ${i.pitch}`).join('\n')}\n\nReturn JSON: { "ideas": [{ "kind": "novel"|"project", "title": "...", "pitch": "why this follows from the saved trail", "evidence": ["memory ids or theme slugs"], "novelty": 0-1 }] }\nNeed 5 novel ideas and 5 project ideas. Prefer intersections (AI × science, agents × PKM, spacetime/geometry collections, YouTube transversal).`,
      },
    ])
    ideasWritten = upsertLlmIdeas(db, extracted.ideas ?? [])
  } catch (error) {
    log(`[assistant] distill ideas failed: ${error instanceof Error ? error.message : error}`)
  }

  return { eventsWritten, ideasWritten }
}

function upsertProfile(db: Database.Database, key: string, content: string): void {
  db.prepare(`
    INSERT INTO profile(key, content, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP
  `).run(key, content)
}

function upsertLlmEvents(
  db: Database.Database,
  events: Array<{ occurred_at?: string; title: string; kind: TimelineEvent['kind']; summary: string; entities?: string[]; memory_ids?: string[] }>,
): number {
  db.prepare("DELETE FROM events WHERE source = 'llm'").run()
  const insert = db.prepare(`
    INSERT INTO events(id, occurred_at, title, kind, summary, entities, memory_ids, confidence, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0.78, 'llm')
  `)
  let n = 0
  const tx = db.transaction(() => {
    for (const event of events) {
      if (!event?.title || !event.kind) continue
      insert.run(
        stableId('event-llm', `${event.kind}:${event.title}:${(event.occurred_at ?? '').slice(0, 10)}`),
        event.occurred_at ?? null,
        event.title.slice(0, 180),
        event.kind,
        event.summary ?? '',
        safeJson(event.entities ?? []),
        safeJson(event.memory_ids ?? []),
      )
      n++
    }
  })
  tx()
  return n
}

function upsertLlmIdeas(
  db: Database.Database,
  ideas: Array<{ kind: IdeaKind; title: string; pitch: string; evidence?: string[]; novelty?: number }>,
): number {
  db.prepare("DELETE FROM ideas WHERE source = 'llm'").run()
  const insert = db.prepare(`
    INSERT INTO ideas(id, kind, title, pitch, evidence, novelty, status, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'seed', 'llm', CURRENT_TIMESTAMP)
  `)
  let n = 0
  const tx = db.transaction(() => {
    for (const idea of ideas) {
      if (!idea?.title || !idea.pitch || (idea.kind !== 'novel' && idea.kind !== 'project')) continue
      insert.run(
        stableId('idea-llm', `${idea.kind}:${idea.title}`),
        idea.kind,
        idea.title.slice(0, 160),
        idea.pitch,
        safeJson(idea.evidence ?? []),
        Math.max(0, Math.min(1, Number(idea.novelty ?? 0.6))),
      )
      n++
    }
  })
  tx()
  return n
}
