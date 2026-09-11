# Second-brain assistant

The catalog (`data/bookmarks.db`) is the **collect** layer. The assistant index (`data/assistant.db`) is the **think** layer. They stay separate so crawls and graph rebuilds never wait on chat, and chat never changes the catalog.

## Layers

1. **Collect**: `crawl:x`, `crawl:youtube`, bookmark import, document ingest. The assistant never runs these.
2. **Mirror**: a read-only scan of every X bookmark, favorite, YouTube video, and document into `memories` + FTS, with MiniLM vectors copied from the catalog.
3. **Structure**: themes (volume and 90-day velocity), heuristic timeline events, bridge and collection idea seeds, and a deterministic profile (trajectory, gravity, open threads) derived from the library itself.
4. **Distill** (optional, `XAI_API_KEY`): an LLM writes a narrative profile, a canonical timeline, and novel/project ideas aligned with the trail.
5. **Use**: chat (`/#assistant` or `npm run assistant:chat`) with retrieval. Conversations and saved insights persist in the assistant DB.
6. **Govern**: incremental `content_hash` skips, an isolated WAL, and read-only catalog access.

## Commands

| Script | What it does |
|---|---|
| `npm run assistant:index` | Mirror + structure (add `-- --distill` to also distill) |
| `npm run assistant:distill` | LLM pass over an existing index (requires `XAI_API_KEY`) |
| `npm run assistant:status` | Counts and last run |
| `npm run assistant:query -- "<q>"` | Retrieve memories, themes, events, and ideas without chatting |
| `npm run assistant:chat -- --mode <mode> --provider <p> "<msg>"` | One chat turn |

Code lives in `src/assistant/`. HTTP is `/api/assistant/*`. The UI is `src/web/assistant-app.tsx`.

## Modes

| Intent | Mode | What it uses |
|---|---|---|
| Continue a conversation | `discuss` | Profile + hybrid retrieval |
| Novel ideas | `novel` | Cross-topic bridges + idea seeds |
| Project ideas | `project` | Collections and open threads |
| SOTA AI timeline | `timeline` | Dated events from your saves |

Answers cite memories as `[n]` and are instructed never to invent items.

## Providers

| Provider | How it answers |
|---|---|
| `xai` | xAI Responses API with tools (`search_library`, `get_timeline`, `get_themes`, `get_ideas`, `save_insight`) for up to four rounds |
| `claude` | `claude -p --model claude-opus-5` with the retrieval pack over stdin, tools disabled |
| `codex` | `codex exec` in a read-only sandbox, prompt over stdin |
| `grok` | Grok Build CLI with a prompt file, tools and web search disabled |

`auto` picks `xai` when `XAI_API_KEY` is set, otherwise the first of `claude`, `codex`, or `grok` found on `PATH`. When nothing is available, chat returns a retrieval briefing (matching memories, timeline, or idea seeds) instead of failing. Choose per message in the UI, per call with `--provider`, or globally with `XBG_ASSISTANT_PROVIDER`.

CLI providers answer in a single tool-free turn, so the retrieval pack sent with each message is the complete context.

## Isolation rules

- The catalog is opened with `readonly: true` and `query_only=ON`.
- Writes go only to `data/assistant.db`.
- Assistant code never runs `crawl:*`, `classify`, `enrich`, or `graph:build`.
- Indexing is safe while a crawl is running (WAL readers).
