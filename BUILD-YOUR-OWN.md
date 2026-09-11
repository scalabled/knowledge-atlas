# Build your own with an agent

Knowledge Atlas is a pattern as much as an app: **collect** saved items into one catalog, **enrich** them, **materialize** a graph, **explore and search** it, and run a **second-brain assistant** over a read-only mirror. You can point a coding agent (Claude Code, Codex, Cursor, …) at this repo and have it set the project up on your data, or adapt it to a different library.

Copy the prompt below into your agent from a clone of this repo, fill in the bracketed parts, and delete the options you don't need.

---

```text
You are working in a clone of Knowledge Atlas, a local-first knowledge graph and
second-brain assistant over saved items. Before changing anything, read
ARCHITECTURE.md end to end, then README.md, docs/USING-YOUR-OWN-DATA.md, and
docs/ASSISTANT.md. Treat the "Invariants agents must not break" section of
ARCHITECTURE.md as hard rules.

## My goal
[One or two sentences, e.g. "Set this up on my X bookmarks and YouTube Watch
Later" or "Adapt this to my Raindrop.io bookmarks and Kindle highlights instead
of X".]

## My environment
- OS: [macOS / Windows / Linux]
- Browser I'm signed in with: [Chrome / Edge / neither — use bundled Chromium]
- LLM access for enrichment and chat: [none / claude CLI / codex CLI / grok CLI / XAI_API_KEY / ANTHROPIC_API_KEY]
- Sources I want: [X bookmarks, YouTube playlists (IDs: ...), browser bookmark
  export at <path>, documents in <folder>, NEW SOURCE: <name + how to export or
  reach it>]
- Topics I care about (optional, for the taxonomy): [list]

## What to do

### Option A: set it up on my data
1. Install dependencies and the Playwright Chromium browser. Create .env from
   .env.example and set XBG_BROWSER, XBG_BROWSER_PROFILE, and
   XBG_YOUTUBE_PLAYLISTS for my environment.
2. Back up data/bookmarks.db if it exists, as the README describes.
3. Run each collector I listed. For the first X/YouTube run, run headed and tell
   me when I need to sign in; don't type credentials yourself.
4. Run `npm run embed:real`, `npm run enrich`, then `npm run assistant:index`.
5. Start the app with `npm run dev`, confirm the atlas loads and search returns
   results, and report counts from `npm run stats` and `npm run assistant:status`.

### Option B: adapt it to a new source or use case
1. Propose a plan before editing: which catalog tables the new source maps onto
   (reuse `bookmarks`/`links`/`media_items` when items are link-like, or add
   tables alongside `youtube_videos`/`documents` when they aren't), the graph
   node type and ID prefix, and how it appears in explore, search, and the
   assistant mirror.
2. Implement the collector as a module under src/pipeline/ that upserts
   idempotently, wire a CLI command in src/pipeline/cli.ts and an npm script,
   and rebuild FTS and the graph after import.
3. Extend src/pipeline/graph.ts, src/server/explore.ts, and
   src/assistant/catalog.ts so the new items become nodes, show up in the atlas,
   and are mirrored into the assistant index.
4. If my topics differ, edit the taxonomy in src/pipeline/classifier.ts and
   re-run classify + graph:build.
5. Add or extend tests next to the existing ones, then run `npm run check` and
   `npm test`.
6. Update README.md and ARCHITECTURE.md for anything you added.

## Rules
- Never commit data/, profiles/, .env, or anything containing my library,
  cookies, or keys.
- Assistant code must stay read-only against data/bookmarks.db.
- Search must go through buildFtsQuery; keep node ID prefixes consistent.
- Keep crawl delays at their defaults or slower; only read my own saved items.
- Ask me before deleting data, running a full re-crawl, or anything irreversible.
- When done, summarize what changed, the commands you ran and their results,
  and anything I still need to do by hand.
```

---

## Ideas for adaptations

| Library | Collector approach |
|---|---|
| Pocket / Instapaper / Raindrop | Official export (HTML/CSV) or API → `bookmarks` + `links` |
| GitHub stars | GitHub REST API (`/user/starred`) → new `repos` table or link-like bookmarks |
| Readwise / Kindle highlights | Readwise export API or `My Clippings.txt` → documents with one chunk per highlight |
| Reddit / Hacker News saves | Account export or API → link-like bookmarks with the comment thread as body |
| Research papers | Zotero export or arXiv IDs → documents (PDF ingest) with authors as entities |
| Team knowledge | A folder of Markdown or Notion export → document ingest, collections per project |
