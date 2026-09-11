import type Database from 'better-sqlite3'
import { parseJson, safeJson, slugify, stableId } from '../lib/hash'
import { refreshTagCounts } from './store'

interface TopicDef {
  slug: string
  name: string
  color: string
  description: string
  keywords: string[]
}

const TOPICS: TopicDef[] = [
  {
    slug: 'ai-ml',
    name: 'AI & Machine Learning',
    color: '#7c3aed',
    description: 'LLMs, agents, model releases, prompts, AI products, research, inference, RAG, multimodal AI.',
    keywords: ['ai', 'llm', 'gpt', 'claude', 'openai', 'anthropic', 'gemini', 'grok', 'mistral', 'llama', 'agent', 'agents', 'prompt', 'prompts', 'rag', 'embedding', 'embeddings', 'inference', 'model', 'models', 'transformer', 'diffusion', 'multimodal', 'eval', 'benchmark', 'fine-tune', 'cursor', 'copilot', 'midjourney', 'sora', 'runway'],
  },
  {
    slug: 'engineering',
    name: 'Software Engineering',
    color: '#0891b2',
    description: 'Code, architecture, infrastructure, APIs, databases, frameworks, developer tools, deployment.',
    keywords: ['code', 'coding', 'developer', 'engineering', 'software', 'typescript', 'javascript', 'python', 'rust', 'go', 'react', 'nextjs', 'api', 'database', 'sql', 'postgres', 'sqlite', 'docker', 'kubernetes', 'github', 'repo', 'cli', 'terminal', 'debug', 'deploy', 'backend', 'frontend', 'server', 'framework', 'library'],
  },
  {
    slug: 'product-design',
    name: 'Product & Design',
    color: '#db2777',
    description: 'Product strategy, UX, UI, design systems, Figma, interaction design, visual craft.',
    keywords: ['product', 'design', 'designer', 'ux', 'ui', 'figma', 'prototype', 'wireframe', 'interface', 'layout', 'typography', 'brand', 'branding', 'component', 'components', 'motion', 'animation', 'usability', 'research', 'onboarding', 'saas'],
  },
  {
    slug: 'startups-business',
    name: 'Startups & Business',
    color: '#f97316',
    description: 'Founders, startups, GTM, fundraising, growth, strategy, sales, marketing, company building.',
    keywords: ['startup', 'startups', 'founder', 'founders', 'business', 'saas', 'revenue', 'mrr', 'arr', 'fundraising', 'vc', 'investor', 'ycombinator', 'yc', 'growth', 'marketing', 'sales', 'pricing', 'customers', 'gtm', 'strategy', 'market', 'acquisition', 'bootstrapped'],
  },
  {
    slug: 'finance-markets',
    name: 'Finance & Markets',
    color: '#16a34a',
    description: 'Stocks, macro, investing, options, rates, real estate, commodities, market analysis.',
    keywords: ['finance', 'market', 'markets', 'stocks', 'stock', 'equity', 'investing', 'investor', 'options', 'trading', 'macro', 'fed', 'inflation', 'rates', 'bonds', 'yield', 'portfolio', 'earnings', 'recession', 'housing', 'real estate', 'commodity', 'oil', 'gold'],
  },
  {
    slug: 'crypto-web3',
    name: 'Crypto & Web3',
    color: '#d97706',
    description: 'Crypto, Bitcoin, Ethereum, Solana, DeFi, NFTs, wallets, chains, protocols, on-chain data.',
    keywords: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'defi', 'nft', 'web3', 'wallet', 'token', 'tokens', 'airdrop', 'chain', 'blockchain', 'onchain', 'dex', 'dao', 'stablecoin', 'memecoin', 'uniswap', 'coinbase', 'binance', 'etherscan', 'pumpfun'],
  },
  {
    slug: 'science-research',
    name: 'Science & Research',
    color: '#2563eb',
    description: 'Papers, scientific discoveries, biology, physics, neuroscience, robotics, space, energy.',
    keywords: ['research', 'paper', 'papers', 'arxiv', 'science', 'scientific', 'biology', 'physics', 'neuroscience', 'robotics', 'robot', 'space', 'climate', 'energy', 'quantum', 'chemistry', 'medicine', 'medical', 'study', 'dataset', 'benchmark'],
  },
  {
    slug: 'security-privacy',
    name: 'Security & Privacy',
    color: '#dc2626',
    description: 'Cybersecurity, privacy, vulnerabilities, exploits, OPSEC, authentication, malware.',
    keywords: ['security', 'privacy', 'cyber', 'hack', 'hacking', 'exploit', 'vulnerability', 'cve', 'breach', 'malware', 'phishing', 'auth', 'authentication', 'encryption', 'opsec', 'password', 'vpn', 'zero-day', 'ransomware'],
  },
  {
    slug: 'health-longevity',
    name: 'Health & Longevity',
    color: '#0d9488',
    description: 'Fitness, nutrition, sleep, longevity, biohacking, mental health, supplements, wearables.',
    keywords: ['health', 'fitness', 'nutrition', 'sleep', 'longevity', 'biohacking', 'workout', 'exercise', 'diet', 'protein', 'supplement', 'supplements', 'mental', 'meditation', 'whoop', 'oura', 'heart', 'metabolic', 'stress'],
  },
  {
    slug: 'productivity-pkm',
    name: 'Productivity & PKM',
    color: '#9333ea',
    description: 'Workflow, focus, systems, note-taking, personal knowledge management, automation.',
    keywords: ['productivity', 'focus', 'workflow', 'workflows', 'automation', 'automate', 'habit', 'habits', 'notes', 'notion', 'obsidian', 'pkm', 'zettelkasten', 'calendar', 'task', 'tasks', 'deep work', 'routine', 'system', 'systems'],
  },
  {
    slug: 'news-politics',
    name: 'News & Politics',
    color: '#4f46e5',
    description: 'Current events, policy, geopolitics, regulation, elections, public institutions.',
    keywords: ['news', 'breaking', 'politics', 'political', 'policy', 'regulation', 'election', 'government', 'law', 'lawsuit', 'court', 'geopolitics', 'war', 'china', 'russia', 'congress', 'senate', 'president', 'administration'],
  },
  {
    slug: 'culture-memes',
    name: 'Culture & Memes',
    color: '#eab308',
    description: 'Humor, memes, internet culture, entertainment, social commentary, viral posts.',
    keywords: ['meme', 'memes', 'funny', 'lol', 'humor', 'joke', 'satire', 'viral', 'culture', 'internet', 'shitpost', 'comedy', 'roast', 'entertainment', 'movie', 'music', 'game', 'gaming'],
  },
  {
    slug: 'media-creative',
    name: 'Media & Creative',
    color: '#ea580c',
    description: 'Video, writing, publishing, creator tools, visual media, storytelling, content workflows.',
    keywords: ['video', 'creator', 'content', 'youtube', 'podcast', 'writing', 'writer', 'newsletter', 'substack', 'publishing', 'story', 'storytelling', 'film', 'photo', 'photography', 'editing', 'creative'],
  },
  {
    slug: 'learning-reference',
    name: 'Learning & Reference',
    color: '#0284c7',
    description: 'Tutorials, explainers, guides, threads, resources, checklists, educational references.',
    keywords: ['learn', 'learning', 'tutorial', 'guide', 'resource', 'resources', 'thread', 'threads', 'explainer', 'course', 'lesson', 'checklist', 'tips', 'how to', 'reference', 'book', 'books'],
  },
  {
    slug: 'tools-products',
    name: 'Tools & Products',
    color: '#65a30d',
    description: 'Apps, tools, product launches, libraries, templates, services, useful utilities.',
    keywords: ['tool', 'tools', 'app', 'apps', 'product', 'launch', 'template', 'templates', 'plugin', 'extension', 'library', 'service', 'platform', 'utility', 'dashboard', 'software', 'download'],
  },
  {
    slug: 'people-network',
    name: 'People & Network',
    color: '#64748b',
    description: 'People, creators, accounts, communities, personal updates, hiring, networking.',
    keywords: ['people', 'person', 'creator', 'account', 'community', 'hiring', 'job', 'career', 'founder', 'team', 'network', 'meetup', 'conference', 'event', 'personal'],
  },
  {
    slug: 'unsorted',
    name: 'Unsorted',
    color: '#71717a',
    description: 'Bookmarks that do not yet have enough evidence for a specific topic.',
    keywords: [],
  },
]

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'you', 'your', 'are', 'was', 'were', 'have', 'has',
  'had', 'not', 'but', 'what', 'when', 'where', 'why', 'how', 'all', 'can', 'will', 'just', 'like', 'about',
  'into', 'more', 'than', 'they', 'them', 'their', 'our', 'out', 'one', 'new', 'now', 'get', 'use', 'via',
  'https', 'http', 'com', 'www', 'amp', 'who', 'which', 'there', 'here', 'been', 'would', 'should',
  'author', 'unknown', 'domain', 'media', 'photo', 'photos', 'video', 'videos', 'image', 'images', 'tweet',
  'post', 'posts', 'xcom', 'twitter', 'tco', 'first', 'most', 'many', 'much', 'time', 'times', 'every',
  'something', 'anything', 'things', 'thing', 'really', 'very', 'actually', 'because', 'only', 'also',
  'still', 'make', 'made', 'makes', 'making', 'want', 'wants', 'need', 'needs', 'way', 'ways', 'see',
  'look', 'looks', 'going', 'back', 'over', 'under', 'then', 'these', 'those', 'its', 'own', 'don',
  'people', 'person', 'built', 'build', 'building', 'work', 'works', 'working', 'any', 'some', 'same',
  'using', 'used', 'everything', 'everyone', 'know', 'knows', 'run', 'runs', 'running', 'through',
  'years', 'year', 'before', 'after', 'open', 'isn', 'isnt', 'good', 'great', 'best', 'better',
  'right', 'real', 'today', 'tomorrow', 'yesterday', 'day', 'days', 'week', 'weeks', 'month', 'months',
  'long', 'short', 'big', 'small', 'high', 'low', 'lot', 'lots',
  'could', 'would', 'even', 'full', 'last', 'across', 'around', 'being', 'between', 'without',
  'within', 'again', 'another', 'others', 'other', 'while', 'where', 'whether', 'ever', 'never',
  'always', 'maybe', 'probably', 'basically', 'literally', 'simple', 'hard', 'easy', 'free',
  'above', 'below', 'already', 'different', 'each', 'either', 'neither', 'both', 'few', 'less',
  'least', 'enough', 'else', 'etc', 'per', 'plus', 'minus', 'near', 'next', 'previous', 'past',
  'future', 'latest', 'ago', 'hours', 'hour', 'minute', 'minutes', 'second', 'seconds',
  'his', 'her', 'hers', 'him', 'she', 'he', 'we', 'whoever', 'anyone', 'someone', 'somebody',
  'nobody', 'lets', 'let', 'does', 'doesn', 'did', 'didn', 'done', 'doing', 'got', 'gets',
  'getting', 'based', 'called', 'call', 'calls', 'calling', 'come', 'comes', 'coming', 'came',
  'become', 'becomes', 'became', 'entire', 'whole', 'able', 'unable', 'available', 'unavailable',
  'find', 'finds', 'finding', 'found', 'ask', 'asks', 'asked', 'asking', 'answer', 'answers',
  'answered', 'help', 'helps', 'helped', 'start', 'starts', 'started', 'starting', 'end',
  'ends', 'ended', 'ending', 'add', 'adds', 'added', 'adding', 'change', 'changes', 'changed',
  'changing', 'check', 'checks', 'checked', 'checking', 'share', 'shares', 'shared', 'sharing',
  'take', 'takes', 'took', 'taken', 'give', 'gives', 'gave', 'given', 'read', 'reads', 'reading',
  'try', 'tries', 'tried', 'trying', 'understand', 'understands', 'understood', 'love', 'almost',
  'single', 'double', 'two', 'three', 'four', 'five', 'too', 'behind', 'away', 'instead',
  'part', 'parts', 'may', 'might', 'must', 'shall', 'cannot', 'cant', 'won', 'wont',
  'create', 'creates', 'created', 'creating', 'generate', 'generates', 'generated', 'generating',
  'text', 'link', 'links',
  'think', 'thinks', 'thinking', 'thought', 'feel', 'feels', 'feeling', 'felt', 'believe',
  'believes', 'believed', 'introduce', 'introduces', 'introduced', 'introducing', 'live',
  'lives', 'living', 'down', 'idea', 'ideas', 'account', 'accounts', 'demo', 'demos', 'fast',
  'slow', 'approach', 'approaches', 'issue', 'issues', 'problem', 'problems', 'case', 'cases',
  'point', 'points', 'level', 'levels', 'kind', 'kinds', 'sort', 'sorts', 'place', 'places',
  'happen', 'happens', 'happened', 'happening', 'show', 'shows', 'showed', 'shown', 'showing',
  'move', 'moves', 'moved', 'moving', 'put', 'puts', 'putting', 'keep', 'keeps', 'kept',
  'complex', 'fully', 'example', 'examples', 'bookmark', 'bookmarks', 'untitled',
])

function isNoiseTag(raw: string): boolean {
  const tag = raw.trim().toLowerCase()
  if (!tag || tag.length < 3 || tag.length > 48) return true
  if (STOPWORDS.has(tag)) return true
  if (/^\d+$/.test(tag)) return true
  if (/^https?$|^www$|^com$/.test(tag)) return true
  if (/^(author|domain|media)(:|\s|$)/.test(tag)) return true
  if (/^(photo|video|image|tweet|post)(\s|$)/.test(tag)) return true
  if (tag.includes(':')) return true
  if (tag.split(/\s+/).some((part) => STOPWORDS.has(part))) return true
  return false
}

export function seedTopics(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT INTO topics(id, slug, name, description, color, model)
    VALUES (@id, @slug, @name, @description, @color, 'local-rules')
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      color = excluded.color,
      updated_at = CURRENT_TIMESTAMP
  `)

  for (const topic of TOPICS) {
    stmt.run({
      id: stableId('topic', topic.slug),
      slug: topic.slug,
      name: topic.name,
      description: topic.description,
      color: topic.color,
    })
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9+#.@-]+/i)
    .map((word) => word.replace(/^[@#]/, '').trim())
    .filter((word) => !isNoiseTag(word))
}

function keywordScore(haystack: string, keyword: string): number {
  const normalized = keyword.toLowerCase()
  if (normalized.includes(' ')) return haystack.includes(normalized) ? 3 : 0
  const re = new RegExp(`(^|[^a-z0-9])${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i')
  return re.test(haystack) ? 1 : 0
}

function extractTopTags(text: string, existingTags: string[]): string[] {
  const counts = new Map<string, number>()
  for (const tag of existingTags) {
    const normalized = tag.toLowerCase()
    if (!isNoiseTag(normalized)) counts.set(normalized, (counts.get(normalized) ?? 0) + 3)
  }
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 24)
    .map(([tag]) => tag)
}

interface BookmarkForClassification {
  id: string
  text: string
  authorHandle: string
  linkText: string
  tags: string
  mediaText: string
}

function classifyBookmark(row: BookmarkForClassification): Array<{ slug: string; confidence: number; rationale: string }> {
  const haystack = `${row.text} ${row.linkText} ${row.tags} ${row.mediaText}`.toLowerCase()
  const scored = TOPICS
    .filter((topic) => topic.slug !== 'unsorted')
    .map((topic) => {
      const score = topic.keywords.reduce((sum, keyword) => sum + keywordScore(haystack, keyword), 0)
      return { topic, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  if (scored.length === 0) {
    return [{ slug: 'unsorted', confidence: 0.5, rationale: 'No strong local rule matched yet.' }]
  }

  const top = scored[0].score
  return scored
    .filter((item) => item.score >= Math.max(1, top * 0.35))
    .map((item) => ({
      slug: item.topic.slug,
      confidence: Math.min(0.98, 0.45 + item.score / Math.max(top, 1) * 0.48),
      rationale: `Matched local signals for ${item.topic.name}.`,
    }))
}

/** Single-item classification for incremental ingestion — same rules as the batch paths, zero deletes. */
export function classifyText(input: { text: string; linkText?: string; tags?: string[]; mediaText?: string }): {
  topics: Array<{ slug: string; confidence: number; rationale: string }>
  tags: string[]
} {
  const existingTags = input.tags ?? []
  const topics = classifyBookmark({
    id: '',
    text: input.text,
    authorHandle: '',
    linkText: input.linkText ?? '',
    tags: existingTags.join(' '),
    mediaText: input.mediaText ?? '',
  })
  const tags: string[] = []
  for (const tag of extractTopTags(`${input.text} ${input.linkText ?? ''} ${input.mediaText ?? ''}`, existingTags)) {
    const normalized = slugify(tag).replace(/-/g, ' ')
    if (!isNoiseTag(normalized) && !tags.includes(normalized)) tags.push(normalized)
  }
  return { topics, tags }
}

export function classifyAll(db: Database.Database, limit = 0): { classified: number; tagged: number } {
  seedTopics(db)

  const rows = db.prepare(`
    SELECT
      b.id,
      b.text,
      b.author_handle AS authorHandle,
      COALESCE((SELECT group_concat(COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE(description, ''), ' ') FROM links WHERE bookmark_id = b.id), '') AS linkText,
      COALESCE((SELECT group_concat(tag, ' ') FROM bookmark_tags WHERE bookmark_id = b.id AND source = 'hashtag'), '') AS tags,
      COALESCE((SELECT group_concat(COALESCE(image_summary, '') || ' ' || COALESCE(image_tags, ''), ' ') FROM media_items WHERE bookmark_id = b.id), '') AS mediaText
    FROM bookmarks b
    ORDER BY b.tweet_created_at DESC, b.imported_at DESC
    ${limit > 0 ? 'LIMIT ?' : ''}
  `).all(...(limit > 0 ? [limit] : [])) as BookmarkForClassification[]

  const topicBySlug = new Map(
    (db.prepare('SELECT id, slug FROM topics').all() as Array<{ id: string; slug: string }>)
      .map((topic) => [topic.slug, topic.id]),
  )

  const insertTopic = db.prepare(`
    INSERT INTO bookmark_topics(bookmark_id, topic_id, confidence, rationale, source)
    VALUES (?, ?, ?, ?, 'local-rules')
    ON CONFLICT(bookmark_id, topic_id) DO UPDATE SET
      confidence = excluded.confidence,
      rationale = excluded.rationale,
      updated_at = CURRENT_TIMESTAMP
  `)

  const insertTag = db.prepare(`
    INSERT INTO tags(tag, kind, count)
    VALUES (?, 'semantic', 0)
    ON CONFLICT(tag) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `)

  const insertBookmarkTag = db.prepare(`
    INSERT INTO bookmark_tags(bookmark_id, tag, source, weight)
    VALUES (?, ?, 'semantic-local', ?)
    ON CONFLICT(bookmark_id, tag, source) DO UPDATE SET weight = excluded.weight
  `)

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM bookmark_tags WHERE source = 'semantic-local'").run()
    db.prepare("DELETE FROM bookmark_topics WHERE source = 'local-rules'").run()
    for (const row of rows) {
      for (const assignment of classifyBookmark(row)) {
        const topicId = topicBySlug.get(assignment.slug)
        if (topicId) insertTopic.run(row.id, topicId, assignment.confidence, assignment.rationale)
      }

      const tags = extractTopTags(`${row.text} ${row.linkText} ${row.mediaText}`, row.tags.split(/\s+/).filter(Boolean))
      tags.forEach((tag, index) => {
        const normalized = slugify(tag).replace(/-/g, ' ')
        if (isNoiseTag(normalized)) return
        insertTag.run(normalized)
        insertBookmarkTag.run(row.id, normalized, Math.max(0.2, 1 - index * 0.025))
      })
    }
    refreshTagCounts(db)
  })

  tx()
  return { classified: rows.length, tagged: rows.length }
}

export function classifyYouTubeAll(db: Database.Database, limit = 0): { classified: number; tagged: number } {
  seedTopics(db)
  const rows = db.prepare(`
    SELECT id, title, description, channel_name AS channelName, COALESCE(transcript, '') AS transcript,
           COALESCE(keywords, '[]') AS keywords
    FROM youtube_videos
    WHERE curation_status <> 'removed'
    ORDER BY imported_at DESC
    ${limit > 0 ? 'LIMIT ?' : ''}
  `).all(...(limit > 0 ? [limit] : [])) as Array<{
    id: string; title: string; description: string; channelName: string; transcript: string; keywords: string
  }>
  const topicBySlug = new Map(
    (db.prepare('SELECT id, slug FROM topics').all() as Array<{ id: string; slug: string }>).map((topic) => [topic.slug, topic.id]),
  )
  const insertTopic = db.prepare(`
    INSERT INTO youtube_video_topics(video_id, topic_id, confidence, rationale, source)
    VALUES (?, ?, ?, ?, 'local-rules')
    ON CONFLICT(video_id, topic_id) DO UPDATE SET confidence = excluded.confidence,
      rationale = excluded.rationale, updated_at = CURRENT_TIMESTAMP
  `)
  const insertTag = db.prepare(`
    INSERT INTO youtube_video_tags(video_id, tag, source, weight)
    VALUES (?, ?, 'semantic-local', ?)
    ON CONFLICT(video_id, tag, source) DO UPDATE SET weight = excluded.weight
  `)
  db.transaction(() => {
    db.prepare("DELETE FROM youtube_video_tags WHERE source = 'semantic-local'").run()
    db.prepare("DELETE FROM youtube_video_topics WHERE source = 'local-rules'").run()
    for (const row of rows) {
      const keywordList = parseJson<string[]>(row.keywords, [])
      const content = `${row.title} ${row.description} ${row.transcript.slice(0, 80_000)} ${keywordList.join(' ')}`
      const classificationRow: BookmarkForClassification = {
        id: row.id,
        text: `${row.title} ${row.description}`,
        authorHandle: row.channelName,
        linkText: row.transcript.slice(0, 80_000),
        tags: keywordList.join(' '),
        mediaText: '',
      }
      for (const assignment of classifyBookmark(classificationRow)) {
        const topicId = topicBySlug.get(assignment.slug)
        if (topicId) insertTopic.run(row.id, topicId, assignment.confidence, assignment.rationale)
      }
      extractTopTags(content, keywordList).forEach((tag, index) => {
        const normalized = slugify(tag).replace(/-/g, ' ')
        if (!isNoiseTag(normalized)) insertTag.run(row.id, normalized, Math.max(0.2, 1 - index * 0.025))
      })
    }
  })()
  return { classified: rows.length, tagged: rows.length }
}

export function getTopicDefinitions(): TopicDef[] {
  return TOPICS
}
