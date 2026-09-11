import type { Express } from 'express'
import { availableProviders, chatAssistant, getConversation, listConversations } from '../assistant/chat'
import { openAssistantDb } from '../assistant/db'
import { loadAssistantStatus } from '../assistant/indexer'
import { briefForQuery, listIdeas, listThemes, searchTimeline } from '../assistant/retrieve'
import type { AssistantMode } from '../assistant/types'
import { hasXaiKey } from '../assistant/xai'

function modeOf(value: unknown): AssistantMode {
  const text = String(value ?? '')
  if (text === 'novel' || text === 'project' || text === 'timeline' || text === 'discuss') return text
  return 'discuss'
}

export function mountAssistant(app: Express): void {
  app.get('/api/assistant/status', (_req, res) => {
    try {
      res.json({ ...loadAssistantStatus(), xai: hasXaiKey(), providers: availableProviders() })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/assistant/themes', (_req, res) => {
    try {
      res.json(listThemes(openAssistantDb()))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/assistant/ideas', (req, res) => {
    try {
      const kind = req.query.kind === 'novel' || req.query.kind === 'project' ? req.query.kind : undefined
      res.json(listIdeas(openAssistantDb(), kind))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/assistant/timeline', (req, res) => {
    try {
      res.json(searchTimeline(openAssistantDb(), {
        query: typeof req.query.q === 'string' ? req.query.q : undefined,
        since: typeof req.query.since === 'string' ? req.query.since : undefined,
        until: typeof req.query.until === 'string' ? req.query.until : undefined,
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
        limit: Number(req.query.limit ?? 40),
      }))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/assistant/brief', async (req, res) => {
    try {
      const q = String(req.query.q ?? '').trim()
      if (!q) return res.status(400).json({ error: 'q is required' })
      res.json(await briefForQuery(q, modeOf(req.query.mode)))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/assistant/conversations', (_req, res) => {
    try {
      res.json(listConversations())
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/assistant/conversations/:id', (req, res) => {
    try {
      const found = getConversation(req.params.id)
      if (!found) return res.status(404).json({ error: 'Conversation not found' })
      res.json(found)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/assistant/chat', async (req, res) => {
    try {
      const message = String(req.body?.message ?? '').trim()
      if (!message) return res.status(400).json({ error: 'message is required' })
      const result = await chatAssistant({
        message,
        conversationId: req.body?.conversationId ? String(req.body.conversationId) : undefined,
        mode: modeOf(req.body?.mode),
        provider: typeof req.body?.provider === 'string' ? req.body.provider : undefined,
      })
      res.json(result)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
