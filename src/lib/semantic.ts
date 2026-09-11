const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}_-]*/gu

export const EMBEDDING_DIMENSIONS = 32
export const EMBEDDING_MODEL = 'atlas-hash-32-v1'

function hash32(value: string, seed = 2166136261): number {
  let hash = seed >>> 0
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => Number((value / length).toFixed(6)))
}

/**
 * Deterministic, local semantic features. This is intentionally model-free so the
 * knowledge layer remains available offline; external embeddings can be stored
 * beside it later under a different model name.
 */
export function embedText(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0)
  const tokens = (text.toLowerCase().match(TOKEN_RE) ?? []).slice(0, 2400)
  const features: Array<{ value: string; weight: number }> = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    features.push({ value: token, weight: 1 + Math.min(1.4, token.length / 12) })
    if (i + 1 < tokens.length) features.push({ value: `${token} ${tokens[i + 1]}`, weight: 0.72 })
    if (i + 2 < tokens.length) features.push({ value: `${token} ${tokens[i + 1]} ${tokens[i + 2]}`, weight: 0.34 })
  }

  for (const feature of features) {
    const first = hash32(feature.value)
    const second = hash32(feature.value, 2246822519)
    const index = first % dimensions
    const sign = (second & 1) === 0 ? 1 : -1
    vector[index] += sign * feature.weight
    vector[(index + 7 + (second % Math.max(1, dimensions - 1))) % dimensions] += sign * feature.weight * 0.38
  }

  return normalize(vector)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0
}

export function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite)
  if (value instanceof Uint8Array) {
    const bytes = value.byteOffset % 4 === 0 ? value : value.slice()   // alignment guard for pooled Buffers
    return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
  }
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []
  } catch {
    return []
  }
}

/** LSH-style sign bucket used to avoid all-pairs semantic comparisons. */
export function embeddingBucket(vector: number[], bits = 10): string {
  let bucket = 0
  for (let i = 0; i < Math.min(bits, vector.length); i++) if (vector[i] >= 0) bucket |= (1 << i)
  return bucket.toString(36)
}

