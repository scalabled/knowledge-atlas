import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/env'
import { parseJson } from '../lib/hash'
import { ASSISTANT_SCHEMA_SQL, ASSISTANT_SCHEMA_VERSION } from './schema'
import type { IndexStats } from './types'

const assistantConnections = new Map<string, Database.Database>()

export function openCatalogReadonly(dbPath = config.dbPath): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Catalog database not found at ${dbPath}. The indexer never creates or writes the catalog.`)
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 8000 })
  db.pragma('query_only = ON')
  db.pragma('busy_timeout = 8000')
  return db
}

export function openAssistantDb(dbPath = config.assistantDbPath): Database.Database {
  const existing = assistantConnections.get(dbPath)
  if (existing) return existing
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('busy_timeout = 5000')
  initAssistantDb(db)
  assistantConnections.set(dbPath, db)
  return db
}

export function closeAssistantDb(dbPath = config.assistantDbPath): void {
  const db = assistantConnections.get(dbPath)
  if (!db) return
  db.close()
  assistantConnections.delete(dbPath)
}

export function initAssistantDb(db: Database.Database): void {
  db.exec(ASSISTANT_SCHEMA_SQL)
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
  if (version?.value !== ASSISTANT_SCHEMA_VERSION) {
    db.prepare(`
      INSERT INTO meta(key, value, updated_at) VALUES('schema_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(ASSISTANT_SCHEMA_VERSION)
  }
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO meta(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value)
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

export function assistantStats(db: Database.Database): IndexStats {
  const run = db.prepare(`
    SELECT id, status, started_at AS startedAt, finished_at AS finishedAt,
      memories_written AS memoriesWritten, memories_skipped AS memoriesSkipped,
      events_written AS eventsWritten, ideas_written AS ideasWritten,
      embeddings_copied AS embeddingsCopied
    FROM index_runs ORDER BY started_at DESC LIMIT 1
  `).get() as IndexStats['lastRun'] | undefined

  return {
    memories: count(db, 'SELECT COUNT(*) AS n FROM memories'),
    embeddings: count(db, 'SELECT COUNT(*) AS n FROM memory_embeddings'),
    events: count(db, 'SELECT COUNT(*) AS n FROM events'),
    ideas: count(db, 'SELECT COUNT(*) AS n FROM ideas'),
    themes: count(db, 'SELECT COUNT(*) AS n FROM themes'),
    conversations: count(db, 'SELECT COUNT(*) AS n FROM conversations'),
    lastRun: run ?? null,
  }
}

export function readJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  return parseJson(value, fallback)
}
