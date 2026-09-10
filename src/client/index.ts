import {
  type ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'

// DSH 0.1.2-rc.1：模型目录从 connection.api.llm.models 迁移到
// remote.session.modelCatalog()（由 @deepseek-ai/dsh-api-session-controller 提供）。
// 这里用足量的结构类型描述返回形状，避免引入新的编译期依赖。
interface RemoteModelCatalogEffort {
  id: string
  name: string
}
interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: { efforts?: RemoteModelCatalogEffort[] }
}
type ModelProviderGroup = {
  id: string
  name: string
  models: ModelCatalogModel[]
}
interface RemoteModelCatalogResponse {
  ok: boolean
  value?: {
  default?: { provider: string; model: string; reasoningEffort?: string }
  groups: ModelProviderGroup[]
  failures?: Array<{ provider?: string; message?: string }>
  }
  error?: { code?: string; message?: string }
}
interface RemoteSessionHandle {
  modelCatalog(): Promise<RemoteModelCatalogResponse>
}
interface RemoteHandle {
  session: RemoteSessionHandle
}
import {
  INLINE_CHAT_CHANNEL,
  INLINE_CHAT_MODEL_STORAGE_KEY,
  INLINE_CHAT_STORAGE_KEY,
  isRecord,
  parseModelSelection,
  type InlineChatMessageInput,
  type InlineChatModelResponse,
  type InlineChatModelSelection,
  type InlineChatPollResponse,
  type InlineChatStartResponse,
} from '../core'

export const name = 'dsh-inline-chat-client'
export const inject = ['connection', 'remote', 'remote.session', 'sessions'] as const

/** 会话 modelSelection projection 的本地结构描述（官方选择器同源语义：current = next ?? 全局默认）。 */
interface SelectionProjectionSnapshot {
  next?: InlineChatModelSelection
}
interface SessionBindingLike {
  session?: {
    projections?: {
      faceOf(key: string): { getSnapshot(): unknown }
    }
  }
}
interface SessionsServiceLike {
  list?: {
    getSnapshot?(): { current?: unknown }
    subscribe?(fn: () => void): () => void
  }
  binding?(id: unknown): SessionBindingLike | undefined
}

interface ClientContext {
  connection: ConnectionHandle
  remote: RemoteHandle
  sessions: SessionsServiceLike
  on?: (name: 'dispose', callback: () => void) => void
}

interface StoredMessage extends InlineChatMessageInput {
  reasoning?: string
  error?: boolean
}

export function apply(ctx: ClientContext): void {
  if (typeof document === 'undefined') return

  const boot = () => {
    const mounted = mount(ctx)
    ctx.on?.('dispose', mounted.dispose)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
    ctx.on?.('dispose', () => document.removeEventListener('DOMContentLoaded', boot))
  } else {
    boot()
  }
}

function mount(ctx: ClientContext): { dispose: () => void } {
  const old = document.querySelector<HTMLElement>('[data-dsh-inline-chat-root]')
  const oldDispose = (old as (HTMLElement & { __dshInlineChatDispose?: () => void }) | null)?.__dshInlineChatDispose
  oldDispose?.()
  old?.remove()

  const host = document.createElement('div')
  host.dataset.dshInlineChatRoot = 'true'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = markup()
  document.body.append(host)

  const button = mustElement<HTMLButtonElement>(shadow, '[data-action="toggle"]')
  const panel = mustElement<HTMLElement>(shadow, '[data-panel]')
  const close = mustElement<HTMLButtonElement>(shadow, '[data-action="close"]')
  const fresh = mustElement<HTMLButtonElement>(shadow, '[data-action="new"]')
  const form = mustElement<HTMLFormElement>(shadow, 'form')
  const input = mustElement<HTMLTextAreaElement>(shadow, 'textarea')
  const submit = mustElement<HTMLButtonElement>(shadow, '[data-action="send"]')
  const list = mustElement<HTMLElement>(shadow, '[data-messages]')
  const status = mustElement<HTMLElement>(shadow, '[data-status]')
  const modelSelect = mustElement<HTMLSelectElement>(shadow, '[data-model-select]')
  const effortWrap = mustElement<HTMLElement>(shadow, '[data-effort-wrap]')
  const effortSelect = mustElement<HTMLSelectElement>(shadow, '[data-effort-select]')
  const effortShell = mustElement<HTMLElement>(shadow, '[data-effort-wrap]')

  let messages = loadMessages()
  let modelGroups: ModelProviderGroup[] = []
  let selection = loadModelSelection()
  let selectionSource: 'follow' | 'user' = 'follow'
  let modelLoading = true
  let modelNotice = '正在加载模型…'
  let open = false
  let sending = false
  let generation = 0
  let disposed = false
  let controller: AbortController | undefined
  let activeRequestId: string | undefined
  const modelController = new AbortController()

  const resizeInput = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 28), 144)}px`
  }

  const renderComposer = () => {
    status.textContent = sending ? '正在生成…' : modelNotice
    submit.disabled = sending ? false : (!input.value.trim() || !selection)
    submit.dataset.mode = sending ? 'stop' : 'send'
    submit.title = sending ? '停止生成' : '发送'
    submit.setAttribute('aria-label', sending ? '停止生成' : '发送')
    input.disabled = sending
    modelSelect.disabled = sending || modelLoading || modelSelect.options.length === 0
    effortSelect.disabled = sending
    resizeInput()
  }

  const render = () => {
    panel.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    button.title = open ? '关闭辅助 Chat' : '打开辅助 Chat'
    // 重建前记录思考块展开态，重建后恢复（默认折叠；手动展开的在重绘后保持展开）
    const openStates = Array.from(list.children).map((el) => {
      const details = el.querySelector?.('details')
      return details?.open ?? false
    })
    list.innerHTML = messages.length
      ? messages.map((message, index) => renderMessage(message, openStates[index] ?? false)).join('')
      : emptyStateMarkup()
    Array.from(list.children).forEach((el, idx) => {
      if (!openStates[idx]) return
      const details = el.querySelector?.('details')
      if (details) details.open = true
    })
    list.scrollTop = list.scrollHeight
    renderComposer()
  }

  // 流式期间只就地更新最后一条消息，不重建 <details>，点击展开/收起不会被重绘竞态打断
  let streamingArticle: HTMLElement | undefined
  const renderStreaming = () => {
    const last = messages.at(-1)
    if (!last || last.role !== 'assistant' || last.error) {
      streamingArticle = undefined
      render()
      return
    }
    let article: HTMLElement | undefined = streamingArticle
    if (!article || !article.isConnected || list.lastElementChild !== article || list.children.length !== messages.length) {
      render()
      article = list.lastElementChild instanceof HTMLElement ? list.lastElementChild : undefined
      streamingArticle = article
      return
    }
    const textEl = article.querySelector('.message-text')
    if (textEl) textEl.textContent = normalizeAssistantText(last.text)
    if (last.reasoning !== undefined) {
      const details = article.querySelector('details')
      if (!details) {
        render()
        article = list.lastElementChild instanceof HTMLElement ? list.lastElementChild : undefined
        streamingArticle = article
        return
      }
      const reasoningEl = details.querySelector('.reasoning')
      if (reasoningEl) reasoningEl.textContent = last.reasoning
    }
    list.scrollTop = list.scrollHeight
  }

  const setOpen = (value: boolean) => {
    open = value
    render()
    if (open) window.setTimeout(() => input.focus(), 0)
  }

  const cancelActive = () => {
    generation += 1
    const requestId = activeRequestId
    activeRequestId = undefined
    controller?.abort()
    controller = undefined
    sending = false
    if (requestId) void ctx.connection.rpc.call(INLINE_CHAT_CHANNEL, 'cancel', { requestId })
  }

  const reset = () => {
    cancelActive()
    messages = []
    input.value = ''
    saveMessages(messages)
    render()
    input.focus()
  }

  const stop = () => {
    if (!sending) return
    cancelActive()
    saveMessages(messages)
    render()
    input.focus()
  }

  const send = async () => {
    const text = input.value.trim()
    const requestSelection = selection ? { ...selection } : undefined
    if (!text || sending || !requestSelection) return

    input.value = ''
    messages.push({ role: 'user', text })
    saveMessages(messages)
    sending = true
    const currentGeneration = ++generation
    const requestController = new AbortController()
    controller = requestController
    let receivedAssistant = false
    render()

    try {
      const result = await ctx.connection.rpc.call(
        INLINE_CHAT_CHANNEL,
        'start',
        {
          messages: messages
            .filter((message) => message.text.trim())
            .map(({ role, text: value }) => ({ role, text: value })),
          selection: requestSelection,
        },
        requestController.signal,
      )
      if (!isRpcSuccess(result) || !isRecord(result.value) || typeof result.value.requestId !== 'string') {
        throw new Error(isRpcFailure(result) ? result.error.message : '辅助 Chat 启动失败')
      }

      const requestId = (result.value as unknown as InlineChatStartResponse).requestId
      activeRequestId = requestId
      while (currentGeneration === generation && !requestController.signal.aborted) {
        const poll = await ctx.connection.rpc.call(
          INLINE_CHAT_CHANNEL,
          'poll',
          { requestId },
          requestController.signal,
        )
        if (!isRpcSuccess(poll) || !isRecord(poll.value)) {
          throw new Error(isRpcFailure(poll) ? poll.error.message : '辅助 Chat 获取回复失败')
        }
        const value = poll.value as unknown as InlineChatPollResponse
        if (!Array.isArray(value.events) || typeof value.done !== 'boolean') {
          throw new Error('辅助 Chat 返回内容无效')
        }
        for (const event of value.events) {
          if (currentGeneration !== generation) break
          if (event.type === 'delta') {
            appendAssistant(event.text)
            receivedAssistant = true
          }
          if (event.type === 'reasoning') {
            appendReasoning(event.text)
            receivedAssistant = true
          }
          if (event.type === 'error') throw new Error(event.message)
          saveMessages(messages)
          renderStreaming()
        }
        if (value.done) break
        await sleep(80, requestController.signal)
      }
      if (currentGeneration === generation && !receivedAssistant) {
        throw new Error('模型没有返回可显示的内容')
      }
    } catch (error) {
      if (currentGeneration === generation && !requestController.signal.aborted) {
        messages.push({ role: 'assistant', text: `请求失败：${error instanceof Error ? error.message : String(error)}`, error: true })
        saveMessages(messages)
        render()
      }
    } finally {
      if (currentGeneration === generation) {
        sending = false
        controller = undefined
        activeRequestId = undefined
        streamingArticle = undefined
        render()
        input.focus()
      }
    }
  }

  const appendAssistant = (text: string) => {
    const last = messages.at(-1)
    if (!last || last.role !== 'assistant' || last.error) messages.push({ role: 'assistant', text: '' })
    messages.at(-1)!.text += text
  }

  const appendReasoning = (text: string) => {
    const last = messages.at(-1)
    if (!last || last.role !== 'assistant' || last.error) messages.push({ role: 'assistant', text: '' })
    messages.at(-1)!.reasoning = `${messages.at(-1)!.reasoning ?? ''}${text}`
  }

  const renderModelOptions = () => {
    modelSelect.replaceChildren()
    if (modelLoading) {
      modelSelect.append(new Option('正在加载模型…', ''))
      setEffortVisible(false)
      fitSelectWidth(modelSelect)
      renderComposer()
      return
    }

    for (const group of modelGroups) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = group.name
      for (const model of group.models) {
        const label = String(model.name ?? '').trim() || model.id
        optgroup.append(new Option(label, encodeModelKey(group.id, model.id)))
      }
      if (optgroup.children.length) modelSelect.append(optgroup)
    }

    if (selection && !findModel(modelGroups, selection)) {
      const fallback = document.createElement('optgroup')
      fallback.label = '当前默认模型'
      fallback.append(new Option(selection.model, encodeModelKey(selection.provider, selection.model)))
      modelSelect.prepend(fallback)
    }

    if (!modelSelect.options.length) {
      const placeholder = new Option(selection?.model || '未配置模型', '')
      placeholder.disabled = true
      placeholder.selected = true
      modelSelect.append(placeholder)
    }

    if (!selection) selection = firstSelection(modelGroups)
    if (selection) {
      const key = encodeModelKey(selection.provider, selection.model)
      modelSelect.value = key
      if (modelSelect.value !== key) {
        modelSelect.append(new Option(selection.model, key))
        modelSelect.value = key
      }
    }
    fitSelectWidth(modelSelect)
    renderEffortOptions()
    renderComposer()
  }

  const setEffortVisible = (visible: boolean) => {
    effortShell.hidden = !visible
    effortShell.dataset.visible = String(visible)
  }

  const renderEffortOptions = () => {
    effortSelect.replaceChildren()
    const model = selection ? findModel(modelGroups, selection) : undefined
    const efforts = (model?.reasoning?.efforts ?? []).filter((effort) =>
      typeof effort?.id === 'string'
      && effort.id.trim().length > 0
      && typeof effort?.name === 'string'
      && effort.name.trim().length > 0,
    )
    if (!efforts.length) {
      setEffortVisible(false)
      if (selection?.reasoningEffort) {
        selection = { provider: selection.provider, model: selection.model }
        saveModelSelection(selection)
      }
      return
    }

    setEffortVisible(true)
    effortSelect.append(new Option('推理：默认', ''))
    for (const effort of efforts) effortSelect.append(new Option(`推理：${effort.name}`, effort.id))
    effortSelect.value = selection?.reasoningEffort ?? ''
    fitSelectWidth(effortSelect, 112)
  }

  /** 读主界面当前打开会话所选模型（官方选择器同源：会话 modelSelection projection 的 next）。 */
  const currentSessionSelection = (): InlineChatModelSelection | undefined => {
    try {
      const current = (ctx.sessions.list?.getSnapshot?.() as { current?: unknown } | undefined)?.current
      if (typeof current !== 'string' || current.length === 0) return undefined
      const projected = ctx.sessions.binding?.(current)?.session?.projections?.faceOf('modelSelection')?.getSnapshot()
      if (!isRecord(projected)) return undefined
      return parseModelSelection((projected as SelectionProjectionSnapshot).next)
    } catch {
      return undefined
    }
  }

  const raced = <T,>(promise: Promise<T>, label: string): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(label)), 10_000)
      promise.then(
        (value) => { window.clearTimeout(timer); resolve(value) },
        (error) => { window.clearTimeout(timer); reject(error) },
      )
    })
  }

  const loadModels = async () => {
    try {
      if (!ctx.remote?.session?.modelCatalog) {
        throw new Error('ctx.remote 不可用（remotes/gateway bundle 未加载；重启 dsh web 后请硬刷新页面）')
      }
      const [catalogResult, defaultResult] = await Promise.allSettled([
        raced(ctx.remote.session.modelCatalog(), '模型目录请求超过 10 秒未响应'),
        ctx.connection.rpc.call(INLINE_CHAT_CHANNEL, 'default-model', {}, modelController.signal),
      ])
      if (disposed) return

      let defaultSelection: InlineChatModelSelection | undefined
      if (defaultResult.status === 'fulfilled' && isRpcSuccess(defaultResult.value) && isRecord(defaultResult.value.value)) {
        defaultSelection = parseModelSelection((defaultResult.value.value as unknown as InlineChatModelResponse).selection)
      }

      let catalogLoaded = false
      let catalogError = ''
      if (catalogResult.status === 'fulfilled') {
        const catalog = catalogResult.value
        if (catalog?.ok && catalog.value) {
          modelGroups = catalog.value.groups ?? []
          catalogLoaded = true
        } else if (catalog && !catalog.ok) {
          const failure = catalog.error
          catalogError = failure ? `${failure.code ?? 'error'}: ${failure.message ?? ''}` : '目录响应失败'
        } else {
          catalogError = '目录响应内容无效'
        }
      } else {
        catalogError = catalogResult.reason instanceof Error ? catalogResult.reason.message : String(catalogResult.reason)
      }

      if (catalogLoaded) {
        const followTarget = currentSessionSelection()
        if (followTarget && findModel(modelGroups, followTarget)) {
          if (selectionSource === 'follow') selection = followTarget
        } else if (!selection || !findModel(modelGroups, selection)) {
          selection = defaultSelection ?? firstSelection(modelGroups)
        }
      } else if (!selection) {
        selection = defaultSelection ?? firstSelection(modelGroups)
      }
      if (selection) saveModelSelection(selection)

      modelLoading = false
      modelNotice = catalogLoaded ? '' : (selection ? '' : `没有可用模型：${catalogError}`)
      renderModelOptions()
    } catch (error) {
      if (disposed) return
      const message = error instanceof Error ? error.message : String(error)
      console.error('[dsh-inline-chat] 模型目录加载失败:', error)
      modelLoading = false
      modelNotice = selection ? '' : `没有可用模型：${message}`
      renderModelOptions()
    }
  }

  button.addEventListener('click', () => {
    const next = !open
    setOpen(next)
    if (next) {
      selectionSource = 'follow'
      if (!sending) void loadModels()
    }
  })
  close.addEventListener('click', () => setOpen(false))
  fresh.addEventListener('click', reset)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (sending) stop()
    else void send()
  })
  input.addEventListener('input', renderComposer)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      if (!sending) void send()
    }
  })
  modelSelect.addEventListener('change', () => {
    const next = decodeModelKey(modelSelect.value)
    if (!next) return
    selection = next
    selectionSource = 'user'
    saveModelSelection(selection)
    fitSelectWidth(modelSelect)
    renderEffortOptions()
    renderComposer()
  })
  effortSelect.addEventListener('change', () => {
    if (!selection) return
    selection = {
      provider: selection.provider,
      model: selection.model,
      ...(effortSelect.value ? { reasoningEffort: effortSelect.value } : {}),
    }
    saveModelSelection(selection)
    fitSelectWidth(effortSelect, 112)
  })

  render()
  void loadModels()

  let refollowTimer: number | undefined
  const refollowOnSessionChange = () => {
    window.clearTimeout(refollowTimer)
    refollowTimer = window.setTimeout(() => {
      if (disposed || !open || sending) return
      if (selectionSource !== 'follow') return
      void loadModels()
    }, 150)
  }
  const unsubscribeSessions = ctx.sessions?.list?.subscribe?.(() => {
    if (disposed) return
    refollowOnSessionChange()
  })
  ctx.on?.('dispose', () => {
    window.clearTimeout(refollowTimer)
    unsubscribeSessions?.()
  })

  const dispose = () => {
    disposed = true
    cancelActive()
    modelController.abort()
    host.remove()
  }
  ;(host as HTMLElement & { __dshInlineChatDispose?: () => void }).__dshInlineChatDispose = dispose
  return { dispose }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'))
    }, { once: true })
  })
}

function loadMessages(): StoredMessage[] {
  try {
    const raw = localStorage.getItem(INLINE_CHAT_STORAGE_KEY)
    const value: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(value)) return []
    return value.filter((item): item is StoredMessage => isRecord(item)
      && (item.role === 'user' || item.role === 'assistant')
      && typeof item.text === 'string')
  } catch {
    return []
  }
}

function saveMessages(messages: readonly StoredMessage[]): void {
  try {
    localStorage.setItem(INLINE_CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-50)))
  } catch {
    // 隐私模式或存储空间不足时，聊天仍可在当前页面正常使用。
  }
}

function loadModelSelection(): InlineChatModelSelection | undefined {
  try {
    const raw = localStorage.getItem(INLINE_CHAT_MODEL_STORAGE_KEY)
    return raw ? parseModelSelection(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
}

function saveModelSelection(selection: InlineChatModelSelection): void {
  try {
    localStorage.setItem(INLINE_CHAT_MODEL_STORAGE_KEY, JSON.stringify(selection))
  } catch {
    // 模型选择无法持久化时仅影响刷新后的默认值。
  }
}

function firstSelection(groups: readonly ModelProviderGroup[]): InlineChatModelSelection | undefined {
  for (const group of groups) {
    const model = group.models[0]
    if (model) return { provider: group.id, model: model.id }
  }
  return undefined
}

function findModel(groups: readonly ModelProviderGroup[], selection: InlineChatModelSelection): ModelCatalogModel | undefined {
  return groups.find((group) => group.id === selection.provider)?.models.find((model) => model.id === selection.model)
}

function encodeModelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function decodeModelKey(value: string): InlineChatModelSelection | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
    return parseModelSelection({ provider: parsed[0], model: parsed[1] })
  } catch {
    return undefined
  }
}

let measureContext: CanvasRenderingContext2D | undefined

/** 让 select 宽度贴合当前选中项文本（原生 select 会按最宽 option 撑开）。 */
function fitSelectWidth(el: HTMLSelectElement, maxWidth = 178): void {
  if (typeof document === 'undefined') return
  const context = measureContext ?? (measureContext = document.createElement('canvas').getContext('2d') ?? undefined)
  if (!context) return
  const style = getComputedStyle(el)
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const label = el.selectedOptions[0]?.textContent ?? ''
  if (!label) {
    el.style.width = ''
    return
  }
  const reserved = 8 + 24 + 2 // CSS 左 padding 8px + 右侧箭头区 24px + 取整余量
  const width = Math.min(Math.ceil(context.measureText(label).width) + reserved, maxWidth)
  el.style.width = `${width}px`
}

function renderMessage(message: StoredMessage, open = false): string {
  const errorClass = message.error ? ' message-error' : ''
  const reasoning = message.reasoning
    ? `<details${open ? ' open' : ''}><summary>思考过程<span class="chev">▸</span></summary><div class="reasoning">${escapeHtml(message.reasoning)}</div></details>`
    : ''
  if (message.role === 'user') {
    return `<article class="message user${errorClass}"><div class="message-text">${escapeHtml(message.text)}</div></article>`
  }
  return `<article class="message assistant${errorClass}"><div class="assistant-mark" aria-hidden="true">D</div><div class="assistant-body">${reasoning}<div class="message-text">${escapeHtml(normalizeAssistantText(message.text))}</div></div></article>`
}

function normalizeAssistantText(value: string): string {
  // 模型常用 Markdown 的空行分段，但不同模型可能连续返回多个空行。
  // 当前轻量渲染器使用 pre-wrap，连续空行会被原样放大成大段垂直间距。
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n')
}

function emptyStateMarkup(): string {
  return `<div class="empty"><div class="empty-mark" aria-hidden="true">D</div><div class="empty-title">有什么可以帮你？</div><div class="empty-copy">这是独立的全局辅助 Chat，不读取当前页面内容，也不会写入左侧会话记录。</div></div>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character))
}

function mustElement<T extends Element>(root: ShadowRoot, selector: string): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error(`dsh-inline-chat: missing ${selector}`)
  return element as T
}

function isRpcSuccess(value: unknown): value is { ok: true; value: unknown } {
  return isRecord(value) && value.ok === true && 'value' in value
}

function isRpcFailure(value: unknown): value is { ok: false; error: { message: string } } {
  return isRecord(value) && value.ok === false && isRecord(value.error) && typeof value.error.message === 'string'
}

function markup(): string {
  return `<style>
:host {
  all: initial;
  --ic-bg: #ffffff;
  --ic-surface: #f7f7f8;
  --ic-surface-hover: #efeff1;
  --ic-border: rgba(15, 23, 42, .10);
  --ic-text: #171717;
  --ic-muted: #737373;
  --ic-subtle: #a3a3a3;
  --ic-primary: #171717;
  --ic-primary-text: #ffffff;
  --ic-danger: #c9362b;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--ic-text);
}
*, *::before, *::after { box-sizing: border-box; }
button, textarea, select { font: inherit; }
.shell { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 12px; }
.toggle { width: 52px; height: 52px; border: 1px solid rgba(255,255,255,.16); border-radius: 50%; display: grid; place-items: center; color: #fff; background: #1f1f1f; box-shadow: 0 10px 30px rgba(0,0,0,.22); cursor: pointer; transition: transform .16s ease, box-shadow .16s ease, background .16s ease; }
.toggle:hover { transform: translateY(-1px); background: #101010; box-shadow: 0 14px 34px rgba(0,0,0,.26); }
.toggle:active { transform: translateY(0) scale(.97); }
.toggle:focus-visible, button:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #4d90fe; outline-offset: 2px; }
.panel { width: min(430px, calc(100vw - 32px)); height: min(680px, calc(100vh - 108px)); min-height: 420px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--ic-border); border-radius: 18px; background: var(--ic-bg); box-shadow: 0 24px 70px rgba(0,0,0,.20), 0 4px 16px rgba(0,0,0,.08); transform-origin: right bottom; animation: panel-in .16s ease-out; }
.panel[hidden] { display: none; }
@keyframes panel-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
.header { height: 58px; flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; padding: 0 14px 0 18px; border-bottom: 1px solid var(--ic-border); background: color-mix(in srgb, var(--ic-bg) 94%, transparent); }
.heading { display: flex; align-items: center; gap: 9px; min-width: 0; }
.title { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.independent { padding: 3px 7px; border-radius: 999px; color: var(--ic-muted); background: var(--ic-surface); font-size: 10px; line-height: 1.2; white-space: nowrap; }
.actions { display: flex; align-items: center; gap: 2px; }
.icon-button { width: 34px; height: 34px; padding: 0; border: 0; border-radius: 9px; display: grid; place-items: center; color: var(--ic-muted); background: transparent; cursor: pointer; transition: color .14s ease, background .14s ease; }
.icon-button:hover { color: var(--ic-text); background: var(--ic-surface-hover); }
.messages { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 20px 18px; scroll-behavior: smooth; background: var(--ic-bg); }
.message { margin: 0 0 20px; color: var(--ic-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.message.user { width: fit-content; max-width: 82%; margin-left: auto; padding: 10px 14px; border-radius: 16px 16px 4px 16px; background: var(--ic-surface); }
.message.assistant { max-width: 100%; display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; align-items: start; }
.assistant-mark, .empty-mark { display: grid; place-items: center; border-radius: 8px; color: #fff; background: #222; font-size: 12px; font-weight: 750; }
.assistant-mark { width: 26px; height: 26px; margin-top: 1px; }
.assistant-body { min-width: 0; padding-top: 3px; }
.message-text { font-size: 13px; line-height: 1.65; }
.message-error .assistant-mark { background: var(--ic-danger); }
.message-error .message-text { color: var(--ic-danger); }
details { color: var(--ic-muted); font-size: 11px; margin-bottom: 5px; }
summary { width: fit-content; cursor: pointer; user-select: none; list-style: none; }
summary::-webkit-details-marker { display: none; }
.chev { display: inline-block; margin-left: 6px; font-size: 10px; color: var(--ic-muted); opacity: 0.75; transition: transform 0.15s ease; }
details[open] > summary .chev { transform: rotate(90deg); }
.reasoning { margin-bottom: 7px; padding-left: 10px; border-left: 2px solid var(--ic-border); color: var(--ic-muted); line-height: 1.55; white-space: pre-wrap; }
.empty { height: 100%; max-width: 290px; margin: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.empty-mark { width: 38px; height: 38px; margin-bottom: 14px; border-radius: 12px; font-size: 15px; box-shadow: 0 5px 16px rgba(0,0,0,.14); }
.empty-title { margin-bottom: 7px; font-size: 16px; font-weight: 650; letter-spacing: -.02em; }
.empty-copy { color: var(--ic-muted); font-size: 12px; line-height: 1.65; }
.footer { flex: 0 0 auto; padding: 0 14px 14px; background: var(--ic-bg); }
.composer { padding: 10px 10px 8px 13px; border: 1px solid var(--ic-border); border-radius: 16px; background: var(--ic-surface); box-shadow: 0 1px 2px rgba(0,0,0,.02); transition: border-color .14s ease, box-shadow .14s ease; }
.composer:focus-within { border-color: var(--ic-border); box-shadow: 0 1px 2px rgba(0,0,0,.02); }
textarea { display: block; width: 100%; min-height: 28px; max-height: 144px; margin: 0; padding: 1px 2px 7px; resize: none; overflow-y: auto; border: 0 !important; outline: none !important; box-shadow: none !important; -webkit-appearance: none; appearance: none; color: var(--ic-text); background: transparent; font-size: 13px; line-height: 1.55; }
textarea:focus, textarea:focus-visible { border: 0 !important; outline: none !important; box-shadow: none !important; }
textarea::placeholder { color: var(--ic-subtle); }
textarea:disabled { opacity: .62; cursor: default; }
.composer-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.model-controls { min-width: 0; display: flex; align-items: center; gap: 4px; }
.select-shell { position: relative; min-width: 0; display: flex; align-items: center; }
.select-shell[hidden], .select-shell[data-visible="false"] { display: none !important; }
.select-shell::after { content: ""; position: absolute; right: 8px; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg); pointer-events: none; opacity: .55; }
select { max-width: 178px; height: 28px; appearance: none; overflow: hidden; text-overflow: ellipsis; padding: 0 24px 0 8px; border: 0; border-radius: 8px; outline: 0; box-shadow: none; color: var(--ic-muted); background: transparent; font-size: 11px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
select:focus, select:focus-visible { outline: 0; box-shadow: none; }
.select-shell:focus-within { outline: 0; box-shadow: none; }
select:hover:not(:disabled) { color: var(--ic-text); background: var(--ic-surface-hover); }
select:disabled { cursor: default; opacity: .65; }
[data-effort-wrap] select { max-width: 112px; }
.send { width: 30px; height: 30px; flex: 0 0 auto; padding: 0; border: 0; border-radius: 9px; display: grid; place-items: center; color: var(--ic-primary-text); background: var(--ic-primary); cursor: pointer; transition: opacity .14s ease, transform .14s ease, background .14s ease; }
.send:hover:not(:disabled) { transform: translateY(-1px); }
.send:active:not(:disabled) { transform: translateY(0) scale(.96); }
.send:disabled { opacity: .22; cursor: default; }
.send .stop-icon { display: none; }
.send[data-mode="stop"] .send-icon { display: none; }
.send[data-mode="stop"] .stop-icon { display: block; }
.status { min-height: 16px; padding: 5px 4px 0; color: var(--ic-muted); font-size: 10px; line-height: 1.4; }
.hint { padding: 6px 4px 0; color: var(--ic-subtle); font-size: 9px; text-align: right; }
@media (prefers-color-scheme: dark) {
  :host { --ic-bg: #1b1b1d; --ic-surface: #252527; --ic-surface-hover: #303033; --ic-border: rgba(255,255,255,.10); --ic-text: #f3f3f3; --ic-muted: #a3a3a3; --ic-subtle: #737373; --ic-primary: #f3f3f3; --ic-primary-text: #171717; }
  .assistant-mark, .empty-mark, .toggle { color: #171717; background: #f3f3f3; }
}
@media (max-width: 520px) {
  .shell { right: 12px; bottom: 12px; }
  .panel { width: calc(100vw - 24px); height: calc(100vh - 84px); min-height: 360px; border-radius: 16px; }
  .messages { padding: 18px 15px 12px; }
  .footer { padding: 0 10px 10px; }
  select { max-width: 145px; }
}
</style>
<div class="shell">
  <section class="panel" data-panel hidden aria-label="辅助 Chat">
    <header class="header">
      <div class="heading"><div class="title">辅助 Chat</div><div class="independent">独立对话</div></div>
      <div class="actions">
        <button class="icon-button" data-action="new" title="新建 Chat" aria-label="新建 Chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button class="icon-button" data-action="close" title="关闭" aria-label="关闭"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </div>
    </header>
    <div class="messages" data-messages></div>
    <div class="footer">
      <form>
        <div class="composer">
          <textarea rows="1" placeholder="发消息给辅助 Chat"></textarea>
          <div class="composer-toolbar">
            <div class="model-controls">
              <label class="select-shell" title="选择模型"><select data-model-select aria-label="选择模型"><option>正在加载模型…</option></select></label>
              <label class="select-shell" data-effort-wrap hidden title="选择推理强度"><select data-effort-select aria-label="选择推理强度"></select></label>
            </div>
            <button class="send" data-action="send" type="submit" title="发送" aria-label="发送" data-mode="send">
              <svg class="send-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>
              <svg class="stop-icon" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
            </button>
          </div>
        </div>
      </form>
      <div class="status" data-status></div>
      <div class="hint">Enter 发送 · Shift + Enter 换行</div>
    </div>
  </section>
  <button class="toggle" data-action="toggle" aria-label="打开辅助 Chat" aria-expanded="false" title="打开辅助 Chat"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 2v-5.2A7.5 7.5 0 1 1 20 11.5Z"/><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01"/></svg></button>
</div>`
}
