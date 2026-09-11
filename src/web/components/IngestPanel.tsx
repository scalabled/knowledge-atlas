import { useRef, useState } from 'react'
import { FileUp, Link2, LoaderCircle, UploadCloud } from 'lucide-react'

export interface IngestedDoc {
  id: string
  nodeId: string
  title: string
  docType: string
  topics: string[]
  neighbors: Array<{ nodeId: string; cos: number; type: string }>
  created: boolean
}
interface IngestResponse { ingested?: IngestedDoc[]; errors?: Array<{ filename: string; error: string }>; error?: string }

function summarize(data: IngestResponse): string {
  const parts = (data.ingested ?? []).map((doc) =>
    `${doc.created ? 'Ingested' : 'Already in library'} “${doc.title.length > 44 ? `${doc.title.slice(0, 43)}…` : doc.title}” · ${doc.neighbors.length} neighbors`)
  parts.push(...(data.errors ?? []).map((item) => `${item.filename}: ${item.error}`))
  return parts.slice(0, 3).join(' — ') || data.error || 'Nothing ingested'
}

export default function IngestPanel({ onDone }: { onDone: (message: string, first?: IngestedDoc) => void }) {
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [url, setUrl] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = async (request: Promise<Response>) => {
    setBusy(true)
    try {
      const data = await (await request).json() as IngestResponse
      onDone(summarize(data), data.ingested?.[0])
    } catch (error) {
      onDone(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  const sendFiles = (files: FileList | null) => {
    const list = [...files ?? []].slice(0, 25)
    if (!list.length || busy) return
    const form = new FormData()
    for (const file of list) form.append('files', file)
    void submit(fetch('/api/ingest', { method: 'POST', body: form }))
  }

  const sendUrl = () => {
    const trimmed = url.trim()
    if (!trimmed || busy) return
    setUrl('')
    void submit(fetch('/api/ingest/url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: trimmed }) }))
  }

  return <div className="ingest-panel">
    <button
      className={`ingest-drop ${dragging ? 'dragging' : ''}`}
      disabled={busy}
      onClick={() => inputRef.current?.click()}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); sendFiles(event.dataTransfer.files) }}
    >
      {busy ? <LoaderCircle className="spin" size={15} /> : <UploadCloud size={15} />}
      <span>{busy ? 'Ingesting…' : 'Drop notes or docs here, or click to browse'}</span>
    </button>
    <input ref={inputRef} type="file" multiple hidden onChange={(event) => { sendFiles(event.target.files); event.target.value = '' }} />
    <div className="ingest-url">
      <Link2 size={13} />
      <input value={url} onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && sendUrl()} placeholder="Ingest a URL" disabled={busy} />
      <button onClick={sendUrl} disabled={busy || !url.trim()} aria-label="Ingest URL"><FileUp size={14} /></button>
    </div>
  </div>
}
