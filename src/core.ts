/** dsh-inline-chat 的跨端协议。只包含可序列化的数据，不依赖浏览器或 Node。 */

export const INLINE_CHAT_CHANNEL = '/dsh-inline-chat'
export const INLINE_CHAT_STORAGE_KEY = 'dsh-inline-chat:v1'
export const INLINE_CHAT_MODEL_STORAGE_KEY = 'dsh-inline-chat:model:v1'

export interface InlineChatMessageInput {
  role: 'user' | 'assistant'
  text: string
}

export interface InlineChatModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface InlineChatStartRequest {
  messages: InlineChatMessageInput[]
  selection?: InlineChatModelSelection
}

export interface InlineChatStartResponse {
  requestId: string
}

export interface InlineChatModelResponse {
  selection: InlineChatModelSelection
}

export interface InlineChatPollRequest {
  requestId: string
}

export interface InlineChatPollResponse {
  events: InlineChatStreamEvent[]
  done: boolean
}

export interface InlineChatCancelRequest {
  requestId: string
}

export type InlineChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isInlineChatMessageInput(value: unknown): value is InlineChatMessageInput {
  if (!isRecord(value)) return false
  return (value.role === 'user' || value.role === 'assistant')
    && typeof value.text === 'string'
    && value.text.trim().length > 0
    && value.text.length <= 20_000
}

export function parseModelSelection(value: unknown): InlineChatModelSelection | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
  const provider = value.provider.trim()
  const model = value.model.trim()
  if (!provider || provider.length > 200 || !model || model.length > 500) return undefined

  if (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== 'string') return undefined
  const reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : undefined
  if (reasoningEffort && reasoningEffort.length > 200) return undefined

  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

export function parseStartRequest(value: unknown): InlineChatStartRequest | undefined {
  if (!isRecord(value) || !Array.isArray(value.messages)) return undefined
  if (value.messages.length > 50) return undefined
  const messages = value.messages.filter(isInlineChatMessageInput)
  if (messages.length !== value.messages.length) return undefined

  const selection = value.selection === undefined ? undefined : parseModelSelection(value.selection)
  if (value.selection !== undefined && !selection) return undefined
  return { messages, ...(selection ? { selection } : {}) }
}

export function parseRequestId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.requestId !== 'string') return undefined
  const requestId = value.requestId.trim()
  return requestId.length > 0 && requestId.length <= 200 ? requestId : undefined
}
