import { openDb, initDb } from '../src/lib/db'
import { runSecondBrain, expandQueryConcepts } from '../src/server/second-brain'
import { buildFtsQuery } from '../src/pipeline/store'

const db = openDb()
initDb(db)
const query = process.argv[2] ?? 'agentic memory knowledge graph second brain'
console.log('query:', query)
console.log('expand:', expandQueryConcepts(query))

const fts = buildFtsQuery(query)
const lex = db.prepare(`
  SELECT b.id, b.tweet_id AS tweetId, b.text, b.author_handle AS authorHandle, b.author_name AS authorName,
    b.tweet_created_at AS tweetCreatedAt,
    COALESCE((SELECT group_concat(t.name, '|||') FROM bookmark_topics bt JOIN topics t ON t.id=bt.topic_id WHERE bt.bookmark_id=b.id), '') AS topics,
    COALESCE((SELECT group_concat(tag, '|||') FROM bookmark_tags WHERE bookmark_id=b.id), '') AS tags,
    bm25(bookmark_fts) AS score
  FROM bookmark_fts JOIN bookmarks b ON b.id = bookmark_fts.bookmark_id
  WHERE bookmark_fts MATCH ? ORDER BY score LIMIT 100
`).all(fts) as Array<Record<string, unknown>>

function split(s: unknown) {
  const text = String(s ?? '')
  return text ? text.split('|||').filter(Boolean) : []
}
const merged = new Map()
lex.forEach((row, i) => {
  merged.set(`bookmark:${row.id}`, {
    id: String(row.id),
    itemType: 'x' as const,
    tweetId: String(row.tweetId),
    text: String(row.text),
    authorHandle: String(row.authorHandle),
    authorName: String(row.authorName),
    tweetCreatedAt: row.tweetCreatedAt ? String(row.tweetCreatedAt) : null,
    topics: split(row.topics),
    tags: split(row.tags),
    domains: [] as string[],
    mediaTypes: [] as string[],
    score: Number(row.score),
    lexicalRank: (i + 1) / Math.max(lex.length, 1),
  })
})
const brain = runSecondBrain(db, query, [...merged.values()], 24)
console.log(JSON.stringify({
  pool: lex.length,
  total: brain.total,
  concepts: brain.concepts.map((c) => ({ label: c.label, count: c.count })),
  bridges: brain.bridges.slice(0, 5).map((b) => ({ label: b.label.slice(0, 70), concepts: b.concepts })),
  top: brain.results.slice(0, 10).map((r) => ({
    score: Number(r.rankScore?.toFixed(3)),
    why: r.why,
    concepts: r.conceptKeys,
    text: (r.title || r.text).replace(/\s+/g, ' ').slice(0, 100),
  })),
}, null, 2))
