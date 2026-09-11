# Architecture — Knowledge Atlas (second brain)

Guide for AI agents (and humans) working on this codebase. Prefer this file over reverse-engineering from scratch.

---

## 1. What this system is

**Local-first personal knowledge graph** over:

| Source | How it enters | DB identity |
|--------|----------------|-------------|
| X bookmarks | Playwright crawler (`crawl:x`) | `bookmarks` / node `bookmark:{id}` |
| Browser favorites | Netscape HTML import | `bookmarks` with `source=import` or `author_handle=browser-favorites` / often `favorite` graph type |
| YouTube | Playwright playlist crawler (`crawl:youtube`) | `youtube_*` / node `youtube:{id}` |
| Documents | File/URL ingest API | `documents` / node `document:{id}` |

Product surface: **Knowledge Atlas** — hierarchical explore (atlas → topic → category), hybrid search, free-form correlation graph, collections, soft archive/remove, and **Ask library** Q&A grounded in retrieval.

The **second brain** layer is not a separate product: it is the ranking + constellation + Q&A path that turns the catalog into navigable memory (find → evaluate → render → ask).

---

## 2. Stack and runtime

| Layer | Tech |
|-------|------|
| Language | TypeScript (`"type": "module"`) |
| API | Express 5 on `127.0.0.1:4177` (`src/server/index.ts`) |
| Web | React 19 + Vite 7, root `src/web`, port `5173` |
| DB | SQLite via `better-sqlite3`, WAL mode (`data/bookmarks.db`) |
| Graph UI | graphology + Sigma WebGL; custom SVG edges/labels |
| Embeddings | MiniLM-L6-v2 ONNX (`@huggingface/transformers`) + hash embed `atlas-hash-32-v1` |
| Crawl | Playwright: bundled Chromium, or a cloned Chrome / Edge profile (`src/pipeline/browser-profile.ts`) |
| LLM providers | Claude / Codex / Grok CLIs (`src/lib/llm-cli.ts`); xAI API for the assistant |

**Dev (two processes):**

```bash
npm install
npm run dev          # api (tsx watch) + web (vite) via concurrently
```

- UI: http://127.0.0.1:5173  
- API: http://127.0.0.1:4177  
- Vite proxies `/api` and `/thumbnails` → API (**10 min** timeout for long Grok asks)

**Production-ish:** `npm run build` → `dist/`; `npm start` serves API + static `dist` (SPA fallback never shadows `/api/*`).

---

## 3. Repository map

```
src/
  lib/           # Shared: db, env, types, hash/slug, semantic hash embed, X tweet normalizer
  pipeline/      # Offline/batch: crawl, import, classify, links, media, graph rebuild, embeddings
  assistant/     # Isolated second-brain index + chat (does not write the catalog)
  server/        # Online: Express API, explore, second-brain rank, vector index, ask, assistant
  web/           # SPA: main shell, ExploreCanvas, GraphCanvas, assistant-app, layout, dust shaders
scripts/         # Smoke helpers (e.g. second-brain ranking on live DB)
data/            # Runtime data (gitignored DB, models, thumbs, backups, assistant.db)
profiles/        # Browser profiles for Playwright (gitignored)
```

### Critical files (start here)

| Path | Role |
|------|------|
| `src/lib/db.ts` | Schema bootstrap (`initDb`), WAL, singleton connection |
| `src/lib/env.ts` | `config.*` paths/ports from env |
| `src/lib/types.ts` | `SearchResult`, graph DTOs, score breakdown |
| `src/pipeline/store.ts` | Bookmark upsert, **`buildFtsQuery`**, FTS rebuild |
| `src/pipeline/graph.ts` | Full graph rebuild, tags, `correlates_with` |
| `src/pipeline/classifier.ts` | Fixed 16-topic taxonomy + local tags |
| `src/pipeline/embedder.ts` | MiniLM embed query/document |
| `src/pipeline/placement.ts` | k-NN placement, `semantic_similarity` edges |
| `src/server/index.ts` | All HTTP routes, hybrid search, ask, assistant mount |
| `src/lib/llm-cli.ts` | Shared claude / codex / grok CLI runner (Ask + assistant) |
| `src/assistant/` | Isolated second-brain index + chat (`data/assistant.db`) |
| `src/server/explore.ts` | Atlas/topic/category/search explore API + dust |
| `src/server/second-brain.ts` | Multi-signal rank, MMR, concepts, bridges |
| `src/server/vector-index.ts` | In-RAM MiniLM flat index |
| `src/web/main.tsx` | View stack, search, ask UI, curation |
| `src/web/layout/unified-layout.ts` | 4D layout: groups, settle, project, labels |
| `src/web/components/ExploreCanvas.tsx` | Hierarchy canvas + curved edges |
| `src/web/components/GraphCanvas.tsx` | Free graph + edge bundles |
| `vite.config.ts` | Proxy + long timeouts |

---

## 4. Data model (SQLite)

Authoritative schema: `initDb()` in `src/lib/db.ts`. Highlights:

### Content tables
- **`bookmarks`** — X + favorites (favorites: `source='import'` or `author_handle='browser-favorites'`)
- **`authors`**, **`media_items`**, **`links`**
- **`youtube_videos`**, **`youtube_playlists`**, **`youtube_playlist_items`**
- **`documents`**, **`document_topics`**, **`document_tags`**

### Taxonomy
- **`topics`** — fixed slugs (`ai-ml`, `engineering`, …, `unsorted`)
- **`bookmark_topics`**, **`youtube_video_topics`**, **`document_topics`**
- **`tags`**, **`bookmark_tags`**, **`youtube_video_tags`**, …

### Graph (materialized for navigation)
- **`graph_nodes`** — `id`, `type`, `key`, `label`, `summary`, `metadata` (JSON), `weight`
- **`graph_edges`** — `source_id`, `target_id`, `type`, `weight`, `metadata`
  - Structural: `has_topic`, `has_tag`, `authored_by`, `references_link`, …
  - Soft knowledge: **`correlates_with`** (shared rare tags/domains)
  - Semantic: **`semantic_similarity`** (MiniLM)

### Search / vectors
- FTS5: `bookmark_fts`, `link_fts`, `youtube_fts`, `document_fts`
- **`embeddings`** — `(owner_type, owner_id, model)` → blob/vector; models `minilm-l6-v2`, `atlas-hash-32-v1`

### Curation / org
- **`curated_items`** — soft archive/remove
- **`collections`**, **`collection_items`**
- **`crawl_runs`**, knowledge layer tables (`knowledge_*` via `refreshKnowledgeLayer`)

### Node ID conventions
Always use these prefixes when joining UI ↔ API ↔ graph:

- `bookmark:{bookmarkId}`
- `youtube:{videoRowId}`
- `document:{docId}`
- `topic:{slug}`, `tag:{name}`, `author:{handle}`, `domain:{host}`, …

---

## 5. Pipelines (offline)

CLI: `tsx src/pipeline/cli.ts <command>` (npm scripts wrap these).

| Command | Purpose |
|---------|---------|
| `crawl-x` / `npm run crawl:x` | Playwright X bookmarks → upsert → classify → graph |
| `crawl-youtube` | Watch Later + playlists from `XBG_YOUTUBE_PLAYLISTS` / `--playlists` |
| `import-favorites` | HTML bookmarks export |
| `import-siftly` | Legacy Siftly DB |
| `links` | Fetch + summarize outbound links |
| `media-describe` | Vision/alt for media |
| `classify` | Topics + semantic tags |
| `build-graph` | Reset derived graph, correlations, FTS, knowledge, MiniLM edges |
| `embed` | Backfill MiniLM embeddings |
| `enrich` | links + media + classify + graph |
| `stats` | Counts |

### Crawl notes (X and YouTube)
- Browser: `XBG_BROWSER` / `--browser` = `chromium` (default; dedicated profile under `./profiles`, sign in once), `chrome`, or `edge` (clones the signed-in profile to `./profiles/<browser>-<profile>-clone`; `--browser-profile` picks the profile folder, `--no-clone-profile` uses it in place). User-data paths cover macOS, Windows, and Linux.
- X: intercepts the GraphQL Bookmarks timeline; scrolls until idle, or stops after N existing-only pages with `--stop-after-existing-pages N`
- YouTube: waits for sign-in when headed; transcripts use `yt-dlp --cookies-from-browser` from `XBG_COOKIES_BROWSER` (derived from `XBG_BROWSER` when unset)
- **Backup first:** `sqlite3 data/bookmarks.db ".backup 'data/backups/bookmarks-….db'"`

### Graph rebuild order (`rebuildGraph`)
1. Tag counts, wipe derived tables  
2. Structural nodes/edges from content  
3. `correlates_with` (rare tags / mid domains)  
4. FTS rebuild  
5. Knowledge layer (hash embeds, claims)  
6. MiniLM `semantic_similarity` edges + placement  

Bulk truth is rebuild-heavy; UI curation deletes nodes immediately but restore needs `graph:build`.

---

## 6. Online API

All under `/api`. CORS origin: `config.webOrigin`.

| Route | Purpose |
|-------|---------|
| `GET /api/stats` | Library counts |
| `GET /api/search?q=&source=&limit=&mode=second-brain` | Hybrid search; second-brain mode returns concepts/bridges |
| `GET /api/explore` | Hierarchy: `level=atlas\|topic\|category\|search\|dust` + `source`, `topic`, `facet`, `key`, `q` |
| `GET /api/graph` | Free graph by `node` or search `q` |
| `GET /api/graph/expand` | Grow neighborhood |
| `GET /api/items/:type/:id` | Detail payload |
| `POST /api/ask` | Second-brain retrieve + CLI answer (grok/claude/codex) |
| `POST /api/ask/related` | Grok with **web_search + web_fetch** on existing answer |
| `POST /api/curation` | archive/remove |
| `GET/POST /api/collections…` | Collections |
| `POST /api/ingest`, `/api/ingest/url` | Documents |
| `POST /api/youtube/transcripts` | Transcripts |

### Hybrid search (`searchItems`)
1. Lexical: FTS via **`buildFtsQuery`** (must sanitize `@`, stopwords, quote tokens — FTS5 breaks on bare `@`)  
2. Author boost: `@handles` pull author rows + mention-LIKE  
3. Quoted phrases: extra phrase MATCH  
4. Semantic: MiniLM → `vectorIndex.search`  
5. Merge ranks → **`runSecondBrain`** (evaluate + MMR)

### Second brain (`src/server/second-brain.ts`)
Inspired by library corpus (GraphRAG, agent memory, zettelkasten):

1. **Find** — hybrid candidate pool  
2. **Evaluate** — weighted: lexical, semantic, recency, graph centrality, richness, concept ontology  
3. **MMR** — diversify authors/concepts  
4. **Render helpers** — concept clusters, bridge nodes (multi-concept), co-occurrence edges  

`score` = lower-is-better (UI sort). `rankScore` / `scoreBreakdown.composite` = higher-is-better.  
`why[]` explains rank for UI chips.

Concept ontology keys: `second-brain`, `agentic-memory`, `knowledge-graph`, `graph-theory`, `rag`, `agents`, `context-systems`.

### Explore levels
- **atlas** — topics as children; co-occurrence arcs; dust samples  
- **topic** — facet hubs (tags/authors/domains/channels)  
- **category** — up to 150 items (newest first), gold edges  
- **search** — second-brain results as children; prefer concept groups over topics when ≥2 concepts  

Caches in `explore.ts` invalidate via `invalidateExploreCaches()` after writes.

### Ask library
1. Retrieve with second-brain (compact **16×~700 char** context — avoid model “truncated” confabulation)  
2. Prompt asserts context is **complete**; tools disabled for answer  
3. Providers:
   - **grok** (default): `grok --prompt-file … --tools '' --max-turns 12`  
   - **claude**: `claude -p --model claude-opus-5` (`CLAUDE_CLI_MODEL` in `src/lib/llm-cli.ts`)  
   - **codex**: `codex exec …`  
4. **Related X + web**: `POST /api/ask/related` with rendered answer → Grok **with** `web_search,web_fetch` + `--always-approve`  
5. UI: Markdown (`react-markdown` + GFM); provider preference in `localStorage` key `atlas-ask-provider`

---

## 7. Frontend architecture

### View stack (`main.tsx`)
```
atlas → topic(facet) → category(key)
      ↘ search(query)
      ↘ node(graph free-form)
```

Breadcrumbs = trail. Search-as-you-type (280ms) pushes/pops search views.

### Layout (`unified-layout.ts`)
- Group nodes by level (topic / facet / source / concept)  
- Place group centers (ring + separation); members in golden-angle slots  
- **z** = recency, **w** = source mix; `project4D` for dimension slider  
- Settle: collision, weak same-group edge springs, clamp to group disk  
- Search/category: extra **spaceBoost / sepPad** so constellations read as islands  
- Labels: non-overlapping `solveLabels`  
- Layout cache key prefix **`atlas-layout:v3:`** (bump on intentional layout breaks)

### Canvases
- **ExploreCanvas** — hierarchy; SVG filaments/ribbons/cubics for edges; dust field  
- **GraphCanvas** — free graph; bundled cubic/quadratic edges; grow  

Lenses: `unified | territories | depth | time` (same as layout modes in UI).

---

## 8. Embeddings dual system

| Model | Dims | Use |
|-------|------|-----|
| `minilm-l6-v2` | 384 | Search, placement, semantic edges (authoritative similarity) |
| `atlas-hash-32-v1` | 32 | Offline/layout relevance channel, knowledge scaffolding |

Do not mix them in the same cosine comparison. Vector index loads MiniLM rows into RAM on first semantic search.

---

## 9. Environment

Copy `.env.example` → `.env` (gitignored).

| Variable | Default | Meaning |
|----------|---------|---------|
| `XBG_DB` | `./data/bookmarks.db` | SQLite path |
| `XBG_API_PORT` | `4177` | API port |
| `XBG_WEB_ORIGIN` | `http://127.0.0.1:5173` | CORS |
| `XBG_ASSISTANT_DB` | `./data/assistant.db` | Assistant index |
| `XBG_BROWSER` | `chromium` | Crawler browser: `chromium`, `chrome`, `edge` |
| `XBG_BROWSER_PROFILE` | `Default` | Chrome/Edge profile folder to clone |
| `XBG_COOKIES_BROWSER` | derived | `yt-dlp` cookie source (`none` disables) |
| `XBG_YOUTUBE_PLAYLISTS` | `WL` | Playlists as `ID` or `ID=Name`, comma-separated |
| `XBG_X_PROFILE` | `./profiles/x` | X crawler profile (chromium mode) |
| `XBG_YOUTUBE_PROFILE` | `./profiles/youtube` | YouTube crawler profile (chromium mode) |
| `XBG_ASSISTANT_PROVIDER` | `auto` | Assistant chat: `auto`, `xai`, `claude`, `codex`, `grok`, `none` |
| `XAI_API_KEY` / `XAI_MODEL` | — / `grok-4.6` | xAI API for assistant chat + distill |
| `ANTHROPIC_API_KEY` | — | Optional link/media LLM enrichment |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Link summaries + image descriptions (`claude-haiku-4-5` for cheaper bulk runs) |

Agent CLIs (`claude`, `codex`, `grok`) resolve from `PATH`; `~/.grok/bin` is added for Grok Build installs (`cliEnv` in `src/lib/llm-cli.ts`).

---

## 10. Tests and checks

```bash
npm run check              # tsc --noEmit
npm test                   # layout, second-brain, and assistant unit tests
npm run test:layout
npm run test:second-brain
npx tsx scripts/smoke-second-brain.ts   # live DB ranking smoke
```

Layout tests guard overlap ratios, finite coords, labels, power cells.  
Second-brain tests: ontology expand, ranking, MMR diversity, bridges.

---

## 11. Invariants agents must not break

1. **FTS queries** — always go through `buildFtsQuery`; never raw user strings in `MATCH` (`@` / operators break FTS5).  
2. **Score contract** — UI sorts relevance with **lower `score` better**; second brain sets `score = 1 - rankScore`.  
3. **Node IDs** — preserve prefixes; don’t invent alternate schemes.  
4. **Favorites filter** — web vs X is `source` / `author_handle`, not a separate table.  
5. **Explore caches** — call `invalidateExploreCaches()` (+ second-brain degree cache) after bulk mutations.  
6. **Proxy timeouts** — long ask/related need the Vite 600s proxy; short timeouts return HTML → “Unexpected token `<`”.  
7. **Ask context** — keep compact and mark complete; large dumps cause “prompt was truncated” confabulation.  
8. **Layout semantics** — atlas/topic/category/search group keys; don’t replace unified layout without updating tests and cache version.  
9. **Gitignore** — never commit `data/bookmarks.db`, profiles, models, thumbnails, `.env`.  
10. **Backup before crawl** — SQLite `.backup` under `data/backups/`.
11. **Assistant isolation** — `src/assistant/` writes only `data/assistant.db`. Catalog access is read-only. Never crawl or `graph:build` from assistant code.

---

## 12. Common agent workflows

### Fix search / ranking
- FTS: `src/pipeline/store.ts` → `buildFtsQuery`  
- Hybrid + handles: `src/server/index.ts` → `searchX` / `searchItems`  
- Multi-signal: `src/server/second-brain.ts`  
- Explore search packing: `src/server/explore.ts` → `searchLevel`

### Fix graph look (spacing, curves)
- Spacing: `unified-layout.ts` (`spaceBoost`, `sepPad`, settle pads)  
- Edges: `ExploreCanvas.tsx` / `GraphCanvas.tsx` route builders  
- CSS: `src/web/styles/app.css` (`.edge-routes`)  
- Bump layout cache `v3` → `v4` if old positions stick

### Fix Ask library
- Retrieve/prompt: `POST /api/ask` in `index.ts`, `buildAskLibraryPrompt`, `runGrokAsk`  
- Related research: `runGrokRelatedResearch`  
- UI: `main.tsx` + `MarkdownView.tsx`  
- Client JSON safety: `readApiJson`

### Add a pipeline step
1. Implement under `src/pipeline/`  
2. Wire command in `cli.ts` + `package.json` script  
3. Persist via `store` / SQL; rebuild FTS/graph if derived  

### Rebuild knowledge after bulk import
```bash
npm run classify
npm run embed:real -- --limit 5000   # if needed
npm run graph:build
npm run stats
```

---

## 13. Design principles (second brain)

Documented so agents extend consistently:

1. **Memory is structure + retrieval** — edges (tags, correlations, semantic) matter as much as vectors.  
2. **Evaluate multi-signal** — never rank on BM25 or cosine alone.  
3. **Diversify for navigation** — MMR / bridges so one author/topic doesn’t own the map.  
4. **Explain rank** — `why` / score bars build trust.  
5. **Lifecycle** — Collect (crawl/import) → Organize (topics/tags/collections) → Evolve (enrich/graph) → Use (explore/search/ask) → Govern (curation, backups).  
6. **Local-first** — SQLite + optional CLI models; no required cloud for browse/search.

---

## 14. Out of scope / known gaps

- No ANN index (flat MiniLM scan) — fine to tens of k nodes; scale later with HNSW/sqlite-vec  
- Category item ranking still mostly recency (search uses second brain)  
- Knowledge claims/entities sparsely exposed in UI  
- Free graph grow is edge-BFS; placement `growRegion` exists but is lightly wired  
- Dual embedding models can confuse layout “relevance” vs search relevance  

When closing gaps, prefer extending `second-brain.ts` + explore search over parallel one-off rankers.

---

## 15. Isolated assistant (second brain chat)

Separate product surface from the Knowledge Atlas visualization.

| Piece | Path |
|-------|------|
| Derived DB | `data/assistant.db` (`XBG_ASSISTANT_DB`) |
| Indexer | `src/assistant/indexer.ts` via `npm run assistant:index` |
| Chat | `src/assistant/chat.ts`, UI `#assistant` / `src/web/assistant-app.tsx` |
| HTTP | `/api/assistant/*` |
| Chat providers | xAI API (tool calls) or claude / codex / grok CLI (one tool-free turn); `XBG_ASSISTANT_PROVIDER` or per-request `provider` |
| Profile | Trajectory, gravity, and open threads are derived from the index (`deriveOpenLoops` in `indexer.ts`); nothing about a specific library is hardcoded |

**Invariant:** assistant code opens the catalog **read-only**. It must not write `bookmarks.db`, run crawl, or rebuild the graph. Conversations live only in `assistant.db`.

Process and providers: [docs/ASSISTANT.md](docs/ASSISTANT.md).

---

## 16. Quick verification checklist after changes

```bash
npm run check && npm test
curl -s 'http://127.0.0.1:4177/api/stats' | head -c 200
curl -s 'http://127.0.0.1:4177/api/search?q=%40user%20memory&limit=3' | head -c 300
# UI: open http://127.0.0.1:5173 — atlas loads, second-brain preset, Ask with Grok
```
