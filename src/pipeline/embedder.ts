import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { config } from '../lib/env'

export const SEMANTIC_MODEL = 'minilm-l6-v2'
export const SEMANTIC_DIMS = 384

const BATCH_SIZE = 32
const CHUNK_CHARS = 1200
const CHUNK_OVERLAP = 200
const MAX_CHUNKS = 32

let extractor: Promise<FeatureExtractionPipeline> | null = null
function getExtractor(dtype: 'fp32' | 'q8' = 'fp32') {
  env.cacheDir = config.modelsDir
  if (process.env.XBG_OFFLINE === '1') env.allowRemoteModels = false
  // first call's dtype wins the memo; later calls reuse the loaded model
  return (extractor ??= pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype }))
}

/** Batch-embed. Returns L2-normalized 384-dim vectors (so similarity = dot). */
export async function embedTexts(texts: string[], dtype: 'fp32' | 'q8' = 'fp32'): Promise<Float32Array[]> {
  if (!texts.length) return []
  const extract = await getExtractor(dtype)
  const vectors: Float32Array[] = []
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE)
    const output = await extract(batch, { pooling: 'mean', normalize: true })
    const data = output.data as Float32Array
    for (let i = 0; i < batch.length; i++) vectors.push(data.slice(i * SEMANTIC_DIMS, (i + 1) * SEMANTIC_DIMS))
  }
  return vectors
}

/** Single query — convenience for the server. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embedTexts([text])
  return vector
}

/** Chunk ~1,200 chars (200 overlap, ≤32 chunks), batch-embed, mean-pool, re-normalize.
 *  MiniLM truncates at 256 wordpieces, so a single call would embed only the head of a long doc. */
export async function embedDocument(text: string): Promise<Float32Array> {
  const chunks: string[] = []
  for (let start = 0; start < text.length && chunks.length < MAX_CHUNKS; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    chunks.push(text.slice(start, start + CHUNK_CHARS))
  }
  if (!chunks.length) chunks.push(text)
  const vectors = await embedTexts(chunks)
  if (vectors.length === 1) return vectors[0]
  const pooled = new Float32Array(SEMANTIC_DIMS)
  for (const vector of vectors) for (let i = 0; i < SEMANTIC_DIMS; i++) pooled[i] += vector[i]
  let sum = 0
  for (let i = 0; i < SEMANTIC_DIMS; i++) sum += pooled[i] * pooled[i]
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0
  for (let i = 0; i < SEMANTIC_DIMS; i++) pooled[i] *= scale
  return pooled
}

export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}
