import fs from 'node:fs'
import path from 'node:path'
import removeMd from 'remove-markdown'

export interface Extracted {
  title: string
  text: string
  pageCount?: number
  meta?: Record<string, unknown>
}

export interface ExtractInput {
  buffer?: Buffer
  filePath?: string
  url?: string
  mimeType?: string
  filename?: string
}

export type DocType = 'text' | 'markdown' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'image' | 'url'

const EXTENSION_TYPES: Record<string, DocType> = {
  '.txt': 'text',
  '.text': 'text',
  '.log': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.csv': 'xlsx',
  '.pptx': 'pptx',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
}

const MIME_TYPES: Record<string, DocType> = {
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

export function detectDocType(input: ExtractInput): DocType {
  if (input.url && !input.buffer && !input.filePath) return 'url'
  const ext = path.extname(input.filename ?? input.filePath ?? '').toLowerCase()
  if (EXTENSION_TYPES[ext]) return EXTENSION_TYPES[ext]
  const mime = (input.mimeType ?? '').toLowerCase().split(';')[0].trim()
  if (MIME_TYPES[mime]) return MIME_TYPES[mime]
  if (mime.startsWith('image/')) return 'image'
  return 'text'
}

function readBuffer(input: ExtractInput): Buffer {
  if (input.buffer) return input.buffer
  if (input.filePath) return fs.readFileSync(input.filePath)
  throw new Error('extractText needs a buffer or filePath')
}

function nameTitle(input: ExtractInput): string {
  return path.basename(input.filename ?? input.filePath ?? '')
    .replace(/\.[^.]*$/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

type Extractor = (input: ExtractInput) => Promise<Extracted>

// phase 2 drops pdf (unpdf), docx (mammoth), xlsx (sheetjs), pptx (officeparser),
// image (describeImageBytes) and url (fetchUrlContent) extractors in here
const EXTRACTORS: Partial<Record<DocType, Extractor>> = {
  async text(input) {
    const text = readBuffer(input).toString('utf8').replace(/^\uFEFF/, '')
    const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''
    return { title: nameTitle(input) || firstLine.slice(0, 120) || 'Untitled document', text }
  },
  async markdown(input) {
    const raw = readBuffer(input).toString('utf8').replace(/^\uFEFF/, '')
    const heading = raw.match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m)?.[1]
    return {
      title: (heading ? removeMd(heading).trim() : '') || nameTitle(input) || 'Untitled document',
      text: removeMd(raw),
    }
  },
}

export async function extractText(input: ExtractInput): Promise<Extracted> {
  const docType = detectDocType(input)
  const extractor = EXTRACTORS[docType]
  if (!extractor) throw new Error(`No ${docType} extractor yet (phase 2)`)
  return extractor(input)
}
