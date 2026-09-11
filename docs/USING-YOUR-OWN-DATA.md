# Using Knowledge Atlas with your own data

This guide takes you from an empty clone to a searchable, explorable library, and shows how to keep it current and bend it to your own use case.

Everything lives in two SQLite files:

- `data/bookmarks.db` — the **catalog**: every item, link, image, topic, tag, embedding, and the materialized graph.
- `data/assistant.db` — the **assistant index**, derived read-only from the catalog.

Both are gitignored and rebuildable. Back up the catalog before large crawls (see the README).

## 1. Setup

```bash
npm install
npx playwright install chromium     # bundled browser for the crawlers
cp .env.example .env
```

Every setting has a working default. The ones you're most likely to change:

| Variable | Default | What it controls |
|---|---|---|
| `XBG_BROWSER` | `chromium` | Crawler browser: `chromium`, `chrome`, or `edge` |
| `XBG_BROWSER_PROFILE` | `Default` | Chrome/Edge profile folder to clone |
| `XBG_YOUTUBE_PLAYLISTS` | `WL` | Playlists to crawl, as `ID` or `ID=Name`, comma-separated |
| `XBG_COOKIES_BROWSER` | derived | `yt-dlp` cookie source for transcripts |
| `XBG_ASSISTANT_PROVIDER` | `auto` | Assistant chat: `auto`, `xai`, `claude`, `codex`, `grok`, `none` |
| `ANTHROPIC_API_KEY` | — | Optional: LLM link summaries and image descriptions |
| `XAI_API_KEY` | — | Optional: xAI API for the assistant and `assistant:distill` |

## 2. Choose how the crawlers sign in

**Bundled Chromium (default, any OS).** The crawler opens a window with a dedicated profile under `./profiles/`. Sign in once; later runs (including `--headless`) reuse the session.

```bash
npm run crawl:x          # sign in to X in the window that opens
npm run crawl:youtube    # sign in to YouTube in the window that opens
```

**Your Chrome or Edge profile.** Set `XBG_BROWSER=chrome` (or `edge`). The crawler copies your profile's session files to `./profiles/<browser>-<profile>-clone` and launches the real browser against the copy, so your browser can stay open.

```bash
npm run crawl:x -- --browser chrome --browser-profile "Profile 1" --headless
```

If the copied session doesn't sign you in (some Chrome versions bind cookie encryption to the original profile), use bundled Chromium instead.

## 3. Collect

### X bookmarks

```bash
npm run crawl:x -- --headless --stop-after-existing-pages 3
```

The crawler scrolls `x.com/i/bookmarks`, intercepts the bookmark timeline responses, and upserts each tweet with its author, media, and links. `--stop-after-existing-pages 3` makes routine runs incremental: it stops after three consecutive pages of bookmarks already in the catalog. Drop it for a full re-crawl. Each run then re-classifies and rebuilds the graph.

Useful flags: `--delay-ms 1400` (scroll pacing), `--idle-rounds 60`, `--max-scrolls 10000`, `--headed`.

### YouTube

```bash
# in .env
XBG_YOUTUBE_PLAYLISTS=WL,PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=Research talks

npm run crawl:youtube -- --headless
npm run crawl:youtube -- --playlists PLxxxx=Research talks   # one-off
```

The playlist ID is the `list=` value in a playlist URL. The crawl stores videos, fetches metadata and thumbnails, and rebuilds the graph. For transcripts:

```bash
python3 -m pip install --user yt-dlp
npm run youtube:transcripts -- --ids VIDEO_ID_1,VIDEO_ID_2
```

Transcripts can also be fetched per video from the item popup in the app.

### Browser bookmarks

Export bookmarks as HTML from any browser (Chrome: Bookmark manager → ⋮ → Export; Firefox: Library → Import and Backup → Export; Safari: File → Export Bookmarks), then:

```bash
npm run import:favorites -- --source ~/Downloads/bookmarks.html
```

### Documents

Drop files onto the ingest panel in the app, or call the API:

```bash
curl -F file=@notes.md http://127.0.0.1:4177/api/ingest
curl -H 'Content-Type: application/json' -d '{"url":"https://example.com/post"}' http://127.0.0.1:4177/api/ingest/url
```

Documents are embedded and placed next to their nearest neighbors without a full graph rebuild.

## 4. Enrich and embed

```bash
npm run enrich -- --link-limit 500 --media-limit 50 --concurrency 5
npm run embed:real
```

- `enrich` fetches linked pages (Readability extraction), summarizes them, describes images, classifies topics and tags, and rebuilds the graph. Without `ANTHROPIC_API_KEY` it uses extractive summaries and alt text.
- `embed:real` backfills 384-dim MiniLM embeddings locally (the model downloads once to `data/models/`). It's resumable and only embeds new items.

Run `embed:real` before a graph rebuild so new items get semantic-similarity edges; if you embed afterwards, run `npm run graph:build` again.

## 5. Explore, search, ask

```bash
npm run dev    # API on :4177, UI on http://127.0.0.1:5173
```

- **Atlas → Topic → Category** drill-down; switch a topic between Tags, Authors, Domains, and Channels.
- **Search** is hybrid. Quote phrases, use `@handle` to boost an author, and filter by source (X / Web / YouTube).
- **Ask library** answers from retrieved items via the `claude`, `codex`, or `grok` CLI.
- **Collections**, **archive**, and **remove** are soft and incremental; `npm run graph:build` restores archived items.

## 6. The second-brain assistant

```bash
npm run assistant:index
```

This mirrors every catalog item into `data/assistant.db` (read-only against the catalog; safe during a crawl), copies embeddings, and derives:

- **Themes** with 90-day volume and velocity
- **Open threads**: your largest and fastest-growing themes, biggest collections, and the video queue
- **Timeline events**: model releases, papers, and products mentioned in your saves
- **Idea seeds** from topic overlaps and collections

Open **Second brain** in the app, or use `npm run assistant:chat`. See [ASSISTANT.md](ASSISTANT.md) for providers and modes.

## 7. Keep it current

A routine update is:

```bash
npm run crawl:x -- --headless --stop-after-existing-pages 3
npm run crawl:youtube -- --headless
npm run embed:real
npm run enrich
npm run assistant:index
```

Schedule it with cron or launchd if you like. Crawls are incremental, embedding and indexing skip unchanged items, and all steps are safe to re-run.

## 8. Customize

| To change | Edit |
|---|---|
| Topic taxonomy and keywords | `src/pipeline/classifier.ts` (topics, keywords, tag rules) |
| Search-preset concepts (e.g. "Agentic memory") | `src/server/second-brain.ts` ontology |
| Timeline event patterns | `src/assistant/events.ts` |
| Ranking weights | `src/server/second-brain.ts` evaluate step |
| A new source | Add a pipeline module that upserts into the catalog, then a CLI command in `src/pipeline/cli.ts` |

After changing the taxonomy, run `npm run classify && npm run graph:build && npm run assistant:index`.

For a bigger departure, such as a different source entirely, see [BUILD-YOUR-OWN.md](../BUILD-YOUR-OWN.md) for an agent prompt.

## Troubleshooting

- **"X login is required" in headless mode**: run once without `--headless` and sign in.
- **"profile not found"**: pass `--browser-profile` with the folder name from `chrome://version` → Profile Path.
- **Semantic search returns nothing**: run `npm run embed:real`, then restart the API.
- **New items lack semantic edges**: run `npm run graph:build` after `embed:real`.
- **Assistant says the index is empty**: run `npm run assistant:index`.
