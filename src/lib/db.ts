import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './env'

let singleton: Database.Database | null = null

export function openDb(dbPath = config.dbPath): Database.Database {
  if (singleton && dbPath === config.dbPath) return singleton

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')

  if (dbPath === config.dbPath) singleton = db
  return db
}

export function closeDb(): void {
  singleton?.close()
  singleton = null
}

export function initDb(db = openDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS authors (
      id TEXT PRIMARY KEY,
      handle TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      profile_image_url TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      tweet_id TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL,
      author_id TEXT,
      author_handle TEXT NOT NULL,
      author_name TEXT NOT NULL,
      tweet_created_at TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'bookmark',
      language TEXT,
      conversation_id TEXT,
      in_reply_to_tweet_id TEXT,
      quoted_tweet_id TEXT,
      retweeted_tweet_id TEXT,
      FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      bookmark_id TEXT NOT NULL,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail_url TEXT,
      local_path TEXT,
      alt_text TEXT,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      image_summary TEXT,
      image_tags TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
      UNIQUE(bookmark_id, url)
    );

    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      bookmark_id TEXT NOT NULL,
      url TEXT NOT NULL,
      expanded_url TEXT,
      canonical_url TEXT,
      domain TEXT,
      title TEXT,
      description TEXT,
      site_name TEXT,
      content_type TEXT,
      article_text TEXT,
      summary TEXT,
      tags TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      fetched_at TEXT,
      summarized_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
      UNIQUE(bookmark_id, url)
    );

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'local-rules',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bookmark_topics (
      bookmark_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      rationale TEXT,
      source TEXT NOT NULL DEFAULT 'local-rules',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(bookmark_id, topic_id),
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      tag TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'semantic',
      count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bookmark_tags (
      bookmark_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      source TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(bookmark_id, tag, source),
      FOREIGN KEY (bookmark_id) REFERENCES bookmarks(id) ON DELETE CASCADE,
      FOREIGN KEY (tag) REFERENCES tags(tag) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      summary TEXT,
      metadata TEXT,
      weight INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(type, key)
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, type)
    );

    CREATE TABLE IF NOT EXISTS crawl_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'bookmark',
      status TEXT NOT NULL DEFAULT 'running',
      profile_dir TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      pages_seen INTEGER NOT NULL DEFAULT 0,
      tweets_seen INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_responses (
      id TEXT PRIMARY KEY,
      crawl_run_id TEXT,
      url TEXT NOT NULL,
      operation_name TEXT,
      tweets_found INTEGER NOT NULL DEFAULT 0,
      cursor TEXT,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS processing_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      target_id TEXT,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_playlists (
      id TEXT PRIMARY KEY,
      playlist_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'playlist',
      description TEXT,
      video_count INTEGER,
      metadata TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_videos (
      id TEXT PRIMARY KEY,
      video_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      channel_id TEXT,
      channel_name TEXT NOT NULL DEFAULT '',
      channel_url TEXT,
      duration_seconds INTEGER,
      published_at TEXT,
      view_count INTEGER,
      thumbnail_url TEXT,
      local_thumbnail_path TEXT,
      transcript TEXT,
      transcript_language TEXT,
      transcript_status TEXT NOT NULL DEFAULT 'pending',
      transcript_fetched_at TEXT,
      keywords TEXT,
      raw_json TEXT NOT NULL DEFAULT '{}',
      curation_status TEXT NOT NULL DEFAULT 'active',
      curation_note TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_playlist_items (
      playlist_id TEXT NOT NULL,
      video_id TEXT NOT NULL,
      position INTEGER,
      added_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(playlist_id, video_id),
      FOREIGN KEY (playlist_id) REFERENCES youtube_playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (video_id) REFERENCES youtube_videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS youtube_video_topics (
      video_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      rationale TEXT,
      source TEXT NOT NULL DEFAULT 'local-rules',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(video_id, topic_id),
      FOREIGN KEY (video_id) REFERENCES youtube_videos(id) ON DELETE CASCADE,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS youtube_video_tags (
      video_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      source TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(video_id, tag, source),
      FOREIGN KEY (video_id) REFERENCES youtube_videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      color TEXT NOT NULL DEFAULT '#14b8a6',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      collection_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(collection_id, item_type, item_id),
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS curated_items (
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(item_type, item_id)
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 40),
      canonical_name TEXT NOT NULL,
      description TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_type, canonical_name)
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'derived',
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence BETWEEN 0 AND 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(entity_id, alias, source),
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS knowledge_episodes (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      occurred_at TEXT,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_type, source_id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_claims (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_type TEXT,
      object_id TEXT,
      object_value TEXT,
      confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
      status TEXT NOT NULL DEFAULT 'derived' CHECK(status IN ('derived','reviewed','disputed','rejected')),
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS claim_evidence (
      claim_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      excerpt TEXT,
      weight REAL NOT NULL DEFAULT 1 CHECK(weight >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(claim_id, source_type, source_id),
      FOREIGN KEY(claim_id) REFERENCES knowledge_claims(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK(dimensions > 0),
      vector TEXT NOT NULL,
      bucket TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(owner_type, owner_id, model)
    );

    CREATE INDEX IF NOT EXISTS idx_bookmarks_author ON bookmarks(author_handle);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(tweet_created_at);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_source ON bookmarks(source);
    CREATE INDEX IF NOT EXISTS idx_media_bookmark ON media_items(bookmark_id);
    CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type);
    CREATE INDEX IF NOT EXISTS idx_links_bookmark ON links(bookmark_id);
    CREATE INDEX IF NOT EXISTS idx_links_domain ON links(domain);
    CREATE INDEX IF NOT EXISTS idx_links_status ON links(status);
    CREATE INDEX IF NOT EXISTS idx_bookmark_topics_topic ON bookmark_topics(topic_id);
    CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tag ON bookmark_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_weight ON graph_nodes(weight);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
    CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel ON youtube_videos(channel_name);
    CREATE INDEX IF NOT EXISTS idx_youtube_videos_status ON youtube_videos(curation_status);
    CREATE INDEX IF NOT EXISTS idx_youtube_playlist_items_video ON youtube_playlist_items(video_id);
    CREATE INDEX IF NOT EXISTS idx_youtube_video_topics_topic ON youtube_video_topics(topic_id);
    CREATE INDEX IF NOT EXISTS idx_youtube_video_tags_tag ON youtube_video_tags(tag);
    CREATE INDEX IF NOT EXISTS idx_collection_items_item ON collection_items(item_type, item_id);
    CREATE INDEX IF NOT EXISTS idx_curated_items_status ON curated_items(item_type, status);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_episodes_source ON knowledge_episodes(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_claims_subject ON knowledge_claims(subject_type, subject_id);
    CREATE INDEX IF NOT EXISTS idx_claims_object ON knowledge_claims(object_type, object_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_bucket ON embeddings(model, bucket);

    CREATE VIRTUAL TABLE IF NOT EXISTS bookmark_fts USING fts5(
      bookmark_id UNINDEXED,
      tweet_id UNINDEXED,
      text,
      author,
      topics,
      tags,
      link_text,
      media_text,
      tokenize='porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS link_fts USING fts5(
      link_id UNINDEXED,
      bookmark_id UNINDEXED,
      title,
      description,
      summary,
      article_text,
      tags,
      tokenize='porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS youtube_fts USING fts5(
      video_id UNINDEXED,
      title,
      description,
      channel,
      transcript,
      topics,
      tags,
      playlists,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,                      -- 'doc:' || stableHash(content bytes | canonical URL)
      doc_type TEXT NOT NULL,                   -- 'text'|'markdown'|'pdf'|'docx'|'xlsx'|'pptx'|'image'|'url'
      title TEXT NOT NULL,
      source_url TEXT,
      local_path TEXT,
      mime_type TEXT,
      content_text TEXT NOT NULL DEFAULT '',    -- extracted text (markdown: raw md is canonical here)
      summary TEXT,
      page_count INTEGER,
      byte_size INTEGER,
      content_hash TEXT UNIQUE,                 -- sha1 of file bytes / canonical URL — dedup + race safety
      status TEXT NOT NULL DEFAULT 'ingested',  -- 'ingested' | 'error'
      error_message TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      curation_status TEXT NOT NULL DEFAULT 'active',
      ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_topics (
      document_id TEXT NOT NULL, topic_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5, rationale TEXT, source TEXT NOT NULL DEFAULT 'local-rules',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(document_id, topic_id),
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY(topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      document_id TEXT NOT NULL, tag TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'semantic-local',
      weight REAL NOT NULL DEFAULT 1,
      PRIMARY KEY(document_id, tag, source),
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
    CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_document_topics_topic ON document_topics(topic_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
      document_id UNINDEXED, title, content, topics, tags, tokenize='porter unicode61'
    );
  `)
}

export function withTransaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)()
}
