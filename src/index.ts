import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { ReasoningEffortId, createAssistantMessage, createUserMessage, type GenerateOptions, type LlmRuntime, type Message } from '@deepseek-ai/dsh-llm'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import {
  INLINE_CHAT_CHANNEL,
  isRecord,
  parseRequestId,
  parseStartRequest,
  type InlineChatMessageInput,
  type InlineChatModelResponse,
  type InlineChatModelSelection,
  type InlineChatPollResponse,
  type InlineChatStartResponse,
  type InlineChatStreamEvent,
} from './core'

export const name = 'dsh-inline-chat'
export const inject = ['connection', 'llm', 'agentDefaultModel'] as const

interface HostContext extends Context {
  connection: HostConnectionHandle
  llm: LlmRuntime
  agentDefaultModel: AgentDefaultModelConfig
}

interface PendingRequest {
  messages: InlineChatMessageInput[]
  selection?: InlineChatModelSelection
  events: InlineChatStreamEvent[]
  done: boolean
  controller: AbortController
}

export function apply(ctx: HostContext): void {
  const pending = new Map<string, PendingRequest>()
  let sequence = 0

  ctx.connection.rpc.handle(INLINE_CHAT_CHANNEL, async (endpoint, payload) => {
    if (endpoint === 'default-model') {
      const value: InlineChatModelResponse = {
        selection: ctx.agentDefaultModel.currentSelection(),
      }
      return success(value)
    }

    if (endpoint === 'start') {
      const request = parseStartRequest(payload)
      if (!request || request.messages.length === 0 || request.messages.at(-1)?.role !== 'user') {
        return failure('辅助 Chat 请求内容无效')
      }

      const requestId = `${Date.now().toString(36)}-${(++sequence).toString(36)}`
      const job: PendingRequest = {
        messages: request.messages,
        selection: request.selection,
        events: [],
        done: false,
        controller: new AbortController(),
      }
      pending.set(requestId, job)
      void runGeneration(ctx, job)
      const value: InlineChatStartResponse = { requestId }
      return success(value)
    }

    if (endpoint === 'poll') {
      const requestId = parseRequestId(payload)
      const job = requestId ? pending.get(requestId) : undefined
      if (!job) return failure('辅助 Chat 请求不存在或已失效')

      const value: InlineChatPollResponse = {
        events: job.events.splice(0),
        done: job.done,
      }
      if (job.done) pending.delete(requestId!)
      return success(value)
    }

    if (endpoint === 'cancel') {
      const requestId = parseRequestId(payload)
      const job = requestId ? pending.get(requestId) : undefined
      if (job) job.controller.abort()
      if (requestId) pending.delete(requestId)
      return success({ cancelled: Boolean(job) })
    }

    return failure('未知的辅助 Chat 操作')
  }, { authority: 'trusted-host' })
}

async function runGeneration(ctx: HostContext, job: PendingRequest): Promise<void> {
  const emit = (event: InlineChatStreamEvent): void => {
    if (!job.controller.signal.aborted) job.events.push(event)
  }

  try {
    const selection = job.selection ?? ctx.agentDefaultModel.currentSelection()
    const messages = toModelMessages(job.messages, selection)
    const options: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort ? ReasoningEffortId(selection.reasoningEffort) : undefined,
      messages,
      signal: job.controller.signal,
    }

    for await (const chunk of ctx.llm.stream(options)) {
      if (job.controller.signal.aborted) return
      if (chunk.type === 'text-delta' && chunk.text) emit({ type: 'delta', text: chunk.text })
      if (chunk.type === 'reasoning-delta' && chunk.text) emit({ type: 'reasoning', text: chunk.text })
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          emit({ type: 'error', message: chunk.reason.failure.message })
        } else {
          emit({ type: 'done', reason: chunk.reason.kind })
        }
      }
    }
  } catch (error) {
    if (!job.controller.signal.aborted) emit({ type: 'error', message: publicErrorMessage(error) })
  } finally {
    if (!job.controller.signal.aborted && !job.events.some((event) => event.type === 'done' || event.type === 'error')) {
      emit({ type: 'done', reason: 'stop' })
    }
    job.done = true
  }
}

function toModelMessages(
  inputs: readonly InlineChatMessageInput[],
  selection: InlineChatModelSelection,
): Message[] {
  return inputs.map((item) => {
    const content = [{ type: 'text' as const, text: item.text }]
    if (item.role === 'user') return createUserMessage({ content, source: { kind: 'user' } })
    return createAssistantMessage({ content, source: { provider: selection.provider, model: selection.model } })
  })
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function failure(message: string): { ok: false; error: { code: 'bad-request'; message: string; details: { issues: never[] } } } {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function publicErrorMessage(error: unknown): string {
  if (isRecord(error)) {
    const failure = error.failure
    if (isRecord(failure) && typeof failure.message === 'string') return failure.message
    if (typeof error.message === 'string') return error.message
  }
  return '辅助 Chat 生成失败，请稍后重试'
}
