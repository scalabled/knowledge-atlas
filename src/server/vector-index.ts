import type Database from 'better-sqlite3'
import { SEMANTIC_DIMS, SEMANTIC_MODEL } from '../pipeline/embedder'

export interface VectorHit { nodeId: string; type: string; cos: number }

let ids: string[] = []
let typeNames: string[] = []
let types = new Uint8Array(0)
let matrix = new Float32Array(0)
let rows = 0
let rowById = new Map<string, number>()
let loaded = false

function typeCode(type: string): number {
  const index = typeNames.indexOf(type)
  if (index !== -1) return index
  typeNames.push(type)
  return typeNames.length - 1
}

function ensureCapacity(count: number) {
  if (count <= types.length) return
  const capacity = Math.max(count, rows * 2, 1024)
  const nextMatrix = new Float32Array(capacity * SEMANTIC_DIMS)
  nextMatrix.set(matrix.subarray(0, rows * SEMANTIC_DIMS))
  matrix = nextMatrix
  const nextTypes = new Uint8Array(capacity)
  nextTypes.set(types.subarray(0, rows))
  types = nextTypes
}

function writeRow(row: number, blob: Uint8Array) {
  const bytes = blob.byteOffset % 4 === 0 ? blob : new Uint8Array(blob)   // copy realigns pooled Buffers
  matrix.set(new Float32Array(bytes.buffer, bytes.byteOffset, SEMANTIC_DIMS), row * SEMANTIC_DIMS)
}

/** Flat in-RAM index over minilm-l6-v2 vectors; rows are L2-normalized so cosine = dot. */
export const vectorIndex = {
  ensureLoaded(db: Database.Database): void {
    if (loaded) return
    const dbRows = db.prepare(`SELECT e.owner_id AS nodeId, n.type AS type, e.vector AS vector
      FROM embeddings e JOIN graph_nodes n ON n.id = e.owner_id
      WHERE e.owner_type = 'graph_node' AND e.model = ?`).all(SEMANTIC_MODEL) as Array<{ nodeId: string; type: string; vector: unknown }>
    ids = []
    typeNames = []
    rowById = new Map()
    rows = 0
    types = new Uint8Array(dbRows.length)
    matrix = new Float32Array(dbRows.length * SEMANTIC_DIMS)
    for (const row of dbRows) {
      if (!(row.vector instanceof Uint8Array) || row.vector.byteLength !== SEMANTIC_DIMS * 4) continue
      ids.push(row.nodeId)
      types[rows] = typeCode(row.type)
      writeRow(rows, row.vector)
      rowById.set(row.nodeId, rows)
      rows++
    }
    loaded = true
  },
  search(q: Float32Array, opts: { types?: Set<string>; limit: number; minCos: number }): VectorHit[] {
    const wanted = opts.types
    const allowed = wanted ? typeNames.map((name) => wanted.has(name)) : null
    const hits: VectorHit[] = []
    for (let row = 0; row < rows; row++) {
      if (allowed && !allowed[types[row]]) continue
      const base = row * SEMANTIC_DIMS
      let dot = 0
      for (let i = 0; i < SEMANTIC_DIMS; i++) dot += matrix[base + i] * q[i]
      if (dot < opts.minCos) continue
      hits.push({ nodeId: ids[row], type: typeNames[types[row]], cos: dot })
    }
    return hits.sort((a, b) => b.cos - a.cos).slice(0, opts.limit)
  },
  upsert(nodeId: string, type: string, vec: Float32Array): void {
    if (!loaded) return   // DB is the source of truth; the next ensureLoaded picks it up
    let row = rowById.get(nodeId)
    if (row === undefined) {
      ensureCapacity(rows + 1)
      row = rows++
      ids.push(nodeId)
      rowById.set(nodeId, row)
    }
    types[row] = typeCode(type)
    matrix.set(vec.subarray(0, SEMANTIC_DIMS), row * SEMANTIC_DIMS)
  },
  invalidate(): void {
    loaded = false
    rows = 0
    ids = []
    typeNames = []
    types = new Uint8Array(0)
    matrix = new Float32Array(0)
    rowById = new Map()
  },
  isLoaded(): boolean {
    return loaded
  },
}
