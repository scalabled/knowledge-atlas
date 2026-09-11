import crypto from 'node:crypto'

export function stableHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16)
}

export function stableId(prefix: string, key: string): string {
  return `${prefix}:${stableHash(key)}`
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled'
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
