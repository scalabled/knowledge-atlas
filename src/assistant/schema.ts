export const ASSISTANT_SCHEMA_VERSION = '1'

export const ASSISTANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS index_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    memories_written INTEGER NOT NULL DEFAULT 0,
    memories_skipped INTEGER NOT NULL DEFAULT 0,
    events_written INTEGER NOT NULL DEFAULT 0,
    ideas_written INTEGER NOT NULL DEFAULT 0,
    embeddings_copied INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    graph_node_id TEXT,
    url TEXT,
    occurred_at TEXT,
    catalog_updated_at TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT,
    author_name TEXT,
    topics TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    content_hash TEXT NOT NULL,
    richness REAL NOT NULL DEFAULT 0,
    topic_primary TEXT,
    kind TEXT NOT NULL DEFAULT 'item',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_type, source_id)
  );

  CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY(memory_id, model),
    FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    title,
    body,
    author,
    topics,
    tags,
    tokenize='porter unicode61'
  );

  CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    description TEXT,
    first_seen TEXT,
    last_seen TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    recent_count INTEGER NOT NULL DEFAULT 0,
    previous_count INTEGER NOT NULL DEFAULT 0,
    velocity REAL NOT NULL DEFAULT 0,
    monthly TEXT NOT NULL DEFAULT '{}',
    top_authors TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    occurred_at TEXT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT,
    entities TEXT NOT NULL DEFAULT '[]',
    memory_ids TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT 'heuristic',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('novel','project')),
    title TEXT NOT NULL,
    pitch TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    novelty REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'seed',
    source TEXT NOT NULL DEFAULT 'bridge',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS profile (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New conversation',
    mode TEXT NOT NULL DEFAULT 'discuss',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_memories_occurred ON memories(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_type);
  CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic_primary);
  CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
  CREATE INDEX IF NOT EXISTS idx_ideas_kind ON ideas(kind);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
`
