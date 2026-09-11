import { config } from '../lib/env'

export interface XaiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface XaiTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface XaiToolCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
}

export interface XaiResult {
  id?: string
  text: string
  toolCalls: XaiToolCall[]
  raw: unknown
}

function requireKey(): string {
  if (!config.xaiApiKey) {
    throw new Error('XAI_API_KEY is not set. Add it to .env to chat and distill with the xAI API.')
  }
  return config.xaiApiKey
}

export function hasXaiKey(): boolean {
  return Boolean(config.xaiApiKey)
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function extract(data: Record<string, unknown>): XaiResult {
  const output = Array.isArray(data.output) ? data.output as Array<Record<string, unknown>> : []
  const texts: string[] = []
  const toolCalls: XaiToolCall[] = []
  for (const item of output) {
    const type = String(item.type ?? '')
    if (type === 'function_call' || type === 'tool_call') {
      toolCalls.push({
        callId: String(item.call_id ?? item.id ?? ''),
        name: String(item.name ?? ''),
        arguments: parseArguments(item.arguments),
      })
      continue
    }
    if (type === 'message') {
      const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []
      for (const part of content) {
        if (typeof part.text === 'string') texts.push(part.text)
      }
    }
  }
  if (!texts.length && typeof data.output_text === 'string') texts.push(data.output_text)
  return { id: typeof data.id === 'string' ? data.id : undefined, text: texts.join('\n').trim(), toolCalls, raw: data }
}

export async function xaiRespond(input: {
  messages: XaiMessage[]
  tools?: XaiTool[]
  previousResponseId?: string
  toolChoice?: 'auto' | 'required' | 'none'
  json?: boolean
  timeoutMs?: number
}): Promise<XaiResult> {
  const key = requireKey()
  const body: Record<string, unknown> = {
    model: config.xaiModel,
    input: input.messages,
    store: false,
  }
  if (input.previousResponseId) body.previous_response_id = input.previousResponseId
  if (input.tools?.length) {
    body.tools = input.tools
    body.tool_choice = input.toolChoice ?? 'auto'
  }
  if (input.json) body.text = { format: { type: 'json_object' } }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 120_000)
  try {
    const res = await fetch(`${config.xaiBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = await res.json() as Record<string, unknown>
    if (!res.ok) {
      const message = typeof data.error === 'object' && data.error && 'message' in data.error
        ? String((data.error as { message: unknown }).message)
        : JSON.stringify(data).slice(0, 400)
      throw new Error(`xAI ${res.status}: ${message}`)
    }
    return extract(data)
  } finally {
    clearTimeout(timer)
  }
}

export async function xaiJson<T>(messages: XaiMessage[], timeoutMs = 120_000): Promise<T> {
  const result = await xaiRespond({ messages, json: true, timeoutMs })
  const text = result.text.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const payload = (fenced ? fenced[1] : text).trim()
  return JSON.parse(payload) as T
}

export function toolOutput(callId: string, output: unknown): Record<string, unknown> {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: typeof output === 'string' ? output : JSON.stringify(output),
  }
}
