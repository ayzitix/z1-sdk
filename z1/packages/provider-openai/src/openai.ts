import type {
  ChatDelta,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatUsage,
  Json,
  ModelInfo,
  ToolCall,
  ToolSchema,
} from '@z1/node'
import type { LlmService } from '@z1/runtime'
import {
  abortError,
  backoffMs,
  delay,
  isAbortError,
  isRetryableStatus,
  resolveRetryOptions,
  retryAfterMs,
  type ResolvedRetryOptions,
} from './retry.ts'
import { readSseData } from './sse.ts'
import type { OpenAiProviderOptions } from './types.ts'

/** How long a discovered model list is trusted. Discovery is not configuration. */
const MODELS_TTL_MS = 5 * 60_000

/** Minimal shape of the OpenAI wire payload; only the fields we read are typed. */
interface WireFunctionCall {
  name?: string
  arguments?: string
}

interface WireToolCall {
  id?: string
  index?: number
  function?: WireFunctionCall
}

interface WireMessage {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: WireToolCall[]
}

interface WireChoice {
  delta?: WireMessage
  message?: WireMessage
  finish_reason?: string | null
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

interface WireResponse {
  choices?: WireChoice[]
  usage?: WireUsage
}

interface WireRequestToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireRequestMessage {
  role: ChatMessage['role']
  content: string
  tool_calls?: WireRequestToolCall[]
  tool_call_id?: string
}

interface WireToolDefinition {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, Json> }
}

interface ChatRequestBody {
  model: string
  messages: WireRequestMessage[]
  stream: boolean
  temperature?: number
  max_tokens?: number
  tools?: WireToolDefinition[]
}

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

type ToolCallDelta = Extract<ChatDelta, { type: 'tool_call' }>

export class OpenAiLlmService implements LlmService {
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly extraHeaders: Record<string, string> | undefined
  private readonly fetchImpl: typeof fetch
  private readonly retry: ResolvedRetryOptions
  private readonly signal: AbortSignal | undefined
  /**
   * Monotonic across every call this service makes, so a synthetic id can
   * never collide with one handed out for an earlier request (or turn).
   */
  private syntheticCalls = 0
  /** Live model list, kept only in memory and only for {@link MODELS_TTL_MS}. */
  private models: { at: number; models: readonly ModelInfo[] } | undefined
  private modelsInFlight: Promise<readonly ModelInfo[]> | undefined

  constructor(options: OpenAiProviderOptions) {
    this.endpoint = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.extraHeaders = options.headers
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.retry = resolveRetryOptions(options.retry)
    this.signal = options.signal
  }

  /**
   * `GET {baseURL}/models`, cached per service instance.
   *
   * The list is discovery, never configuration: it is not persisted, and a
   * provider that does not implement the endpoint fails with its own status so
   * the caller can fall back to an explicit model id.
   */
  async listModels(
    _request: { provider: string },
    signal?: AbortSignal,
  ): Promise<readonly ModelInfo[]> {
    const now = Date.now()
    if (this.models !== undefined && now - this.models.at < MODELS_TTL_MS) {
      return this.models.models
    }
    // One request per provider even when several nodes ask at once.
    this.modelsInFlight ??= this.fetchModels(signal)
      .then((models) => {
        this.models = { at: Date.now(), models }
        return models
      })
      .finally(() => {
        this.modelsInFlight = undefined
      })
    return await this.modelsInFlight
  }

  private async fetchModels(signal: AbortSignal | undefined): Promise<readonly ModelInfo[]> {
    const response = await this.request('/models', {
      method: 'GET',
      headers: this.headers(),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      const detail = redact(await readErrorBody(response), this.apiKey)
      const status = `${response.status} ${response.statusText}`.trim()
      throw new Error(
        `model discovery failed for ${this.endpoint} (${detail.length > 0 ? `${status}: ${detail}` : status})`,
      )
    }
    const raw: unknown = await response.json()
    const data = isRecord(raw) && Array.isArray(raw['data']) ? raw['data'] : []
    const models: ModelInfo[] = []
    const seen = new Set<string>()
    for (const entry of data) {
      if (!isRecord(entry)) continue
      const id = entry['id']
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      const name = entry['name']
      const ownedBy = entry['owned_by']
      const created = entry['created']
      models.push({
        id,
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof ownedBy === 'string' ? { ownedBy } : {}),
        ...(typeof created === 'number' ? { created } : {}),
      })
    }
    return models
  }

  async chat(
    request: ChatRequest,
    onDelta?: (delta: ChatDelta) => void,
  ): Promise<ChatResult> {
    const stream = request.model.params?.['stream'] !== false
    const body = buildBody(request, stream)
    const response = await this.send(JSON.stringify(body))

    if (!response.ok) {
      const detail = redact(await readErrorBody(response), this.apiKey)
      const status = `${response.status} ${response.statusText}`.trim()
      const message = detail.length > 0 ? `${status}: ${detail}` : status
      throw new Error(`openai-compatible request failed (${message})`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!stream || contentType.includes('application/json')) {
      return this.readComplete(response)
    }
    if (response.body === null) {
      throw new Error('openai-compatible request returned an empty body')
    }

    const accumulator = new ChatAccumulator(onDelta, () => this.nextSyntheticCall())
    let finishReason: string | undefined
    let usage: ChatUsage | undefined

    for await (const payload of readSseData(response.body)) {
      if (payload === '[DONE]') break
      const chunk = parseObject(payload)
      if (chunk === undefined) continue
      if (chunk['error'] !== undefined) throw this.streamError(chunk['error'])
      const data = chunk as WireResponse
      const choice = data.choices?.[0]
      if (choice?.delta !== undefined) accumulator.apply(choice.delta)
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
      const chunkUsage = toUsage(data.usage)
      if (chunkUsage !== undefined) usage = chunkUsage
    }

    return accumulator.finish(finishReason, usage)
  }

  /** A privacy-safe message for an upstream `{ error: ... }` object. */
  private streamError(error: unknown): Error {
    return new Error(`openai-compatible stream error: ${redact(describeError(error), this.apiKey)}`)
  }

  private nextSyntheticCall(): number {
    this.syntheticCalls += 1
    return this.syntheticCalls
  }

  /**
   * POSTs the body, retrying 429/5xx and network failures. Retries happen
   * before the response stream is read, so a retried attempt emits no deltas.
   */
  private send(body: string): Promise<Response> {
    return this.request('/chat/completions', initFor(this.headers(), body, this.signal))
  }

  /** One URL path, with the shared retry policy. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.endpoint}${path}`
    const signal = this.signal ?? (init.signal as AbortSignal | null | undefined) ?? undefined
    for (let attempt = 1; ; attempt += 1) {
      if (isAborted(signal)) throw abortError()
      let response: Response
      try {
        response = await this.fetchImpl(url, init)
      } catch (error) {
        if (isAbortError(error) || isAborted(signal)) throw error
        if (attempt >= this.retry.attempts) throw error
        await delay(backoffMs(attempt, this.retry), signal)
        continue
      }

      if (response.ok || !isRetryableStatus(response.status)) return response
      if (attempt >= this.retry.attempts) return response
      const waitMs =
        retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt, this.retry)
      await discardBody(response)
      await delay(waitMs, signal)
    }
  }

  /** Non-streaming callers get one complete message; no deltas are emitted. */
  private async readComplete(response: Response): Promise<ChatResult> {
    const raw: unknown = await response.json()
    if (isRecord(raw) && raw['error'] !== undefined) throw this.streamError(raw['error'])
    const data = isRecord(raw) ? (raw as WireResponse) : {}
    const choice = data.choices?.[0]
    const accumulator = new ChatAccumulator(undefined, () => this.nextSyntheticCall())
    if (choice?.message !== undefined) accumulator.apply(choice.message)
    return accumulator.finish(choice?.finish_reason ?? undefined, toUsage(data.usage))
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    }
    if (this.extraHeaders !== undefined) Object.assign(headers, this.extraHeaders)
    return headers
  }
}

export function createOpenAiLlmService(options: OpenAiProviderOptions): OpenAiLlmService {
  return new OpenAiLlmService(options)
}

class ChatAccumulator {
  private text = ''
  private readonly calls = new Map<number, ToolCallAccumulator>()
  private readonly onDelta: ((delta: ChatDelta) => void) | undefined
  private readonly nextCallSeq: () => number

  constructor(onDelta: ((delta: ChatDelta) => void) | undefined, nextCallSeq: () => number) {
    this.onDelta = onDelta
    this.nextCallSeq = nextCallSeq
  }

  /** Consumes a streaming delta, or a complete message from a JSON response. */
  apply(message: WireMessage): void {
    const content = message.content
    if (typeof content === 'string' && content.length > 0) {
      this.text += content
      this.emit({ type: 'text', text: content })
    }

    const reasoning = message.reasoning_content ?? message.reasoning
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      this.emit({ type: 'reasoning', text: reasoning })
    }

    const calls = message.tool_calls
    if (calls === undefined) return
    calls.forEach((call, position) => {
      const index = typeof call.index === 'number' ? call.index : position
      let entry = this.calls.get(index)
      if (entry === undefined) {
        entry = { id: '', name: '', arguments: '' }
        this.calls.set(index, entry)
      }

      const delta: ToolCallDelta = { type: 'tool_call', index }
      const id = call.id
      if (typeof id === 'string' && id.length > 0) {
        entry.id = id
        delta.id = id
      }
      const name = call.function?.name
      if (typeof name === 'string' && name.length > 0) {
        entry.name = name
        delta.name = name
      }
      const argumentsDelta = call.function?.arguments
      if (typeof argumentsDelta === 'string' && argumentsDelta.length > 0) {
        entry.arguments += argumentsDelta
        delta.argumentsDelta = argumentsDelta
      }
      this.emit(delta)
    })
  }

  finish(reason: string | undefined, usage: ChatUsage | undefined): ChatResult {
    const toolCalls = this.toolCalls()
    const message: ChatMessage = { role: 'assistant', content: this.text }
    if (toolCalls.length > 0) message.toolCalls = toolCalls

    const result: ChatResult = {
      message,
      toolCalls,
      stopReason: mapStopReason(reason),
    }
    if (usage !== undefined) result.usage = usage
    return result
  }

  private toolCalls(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, entry]) => ({
        // The provider is not required to send an id, and a bare index would
        // repeat on the next call. The service counter makes it unique.
        id: entry.id.length > 0 ? entry.id : `call_${this.nextCallSeq()}_${index}`,
        name: entry.name,
        arguments: parseArguments(entry.arguments, entry.name, index),
      }))
  }

  private emit(delta: ChatDelta): void {
    this.onDelta?.(delta)
  }
}

function buildBody(request: ChatRequest, stream: boolean): ChatRequestBody {
  const params = request.model.params ?? {}
  const body: ChatRequestBody = {
    model: request.model.model,
    messages: request.messages.map(toWireMessage),
    stream,
  }

  const temperature = request.temperature ?? numberParam(params['temperature'])
  if (temperature !== undefined) body.temperature = temperature

  const maxTokens = request.maxTokens ?? numberParam(params['max_tokens'])
  if (maxTokens !== undefined) body.max_tokens = maxTokens

  const tools = request.tools
  if (tools !== undefined && tools.length > 0) body.tools = tools.map(toWireTool)
  return body
}

function toWireMessage(message: ChatMessage): WireRequestMessage {
  if (message.role === 'tool') {
    const wire: WireRequestMessage = { role: 'tool', content: message.content }
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId
    return wire
  }

  const wire: WireRequestMessage = { role: message.role, content: message.content }
  if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }))
  }
  return wire
}

function toWireTool(tool: ToolSchema): WireToolDefinition {
  const fn: WireToolDefinition['function'] = {
    name: tool.name,
    parameters: tool.parameters,
  }
  if (tool.description !== undefined) fn.description = tool.description
  return { type: 'function', function: fn }
}

function numberParam(value: Json | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toUsage(usage: WireUsage | undefined): ChatUsage | undefined {
  if (usage === undefined) return undefined
  const inputTokens = usage.prompt_tokens
  const outputTokens = usage.completion_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  return { inputTokens, outputTokens }
}

function mapStopReason(reason: string | undefined): ChatResult['stopReason'] {
  switch (reason) {
    case 'tool_calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'stop':
      return 'stop'
    default:
      return 'error'
  }
}

/** Empty arguments mean "no arguments"; malformed ones must never run a tool. */
function parseArguments(raw: string, toolName: string, index: number): Json {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const value: unknown = JSON.parse(trimmed)
    return isJson(value) ? value : {}
  } catch {
    const label = toolName.length > 0 ? `"${toolName}"` : `#${index}`
    throw new Error(
      `tool call ${label} returned malformed JSON arguments: ${truncate(
        trimmed,
        ARGUMENTS_SNIPPET,
      )}`,
    )
  }
}

function isJson(value: unknown): value is Json {
  if (value === null) return true
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return true
    case 'object':
      return Array.isArray(value)
        ? value.every((entry) => isJson(entry))
        : Object.values(value).every((entry) => isJson(entry))
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObject(payload: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(payload)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** JSON arguments longer than this are cut in the error; the tool still fails. */
const ARGUMENTS_SNIPPET = 200

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * Renders an upstream `{ error: ... }` payload without assuming its shape:
 * providers disagree on whether it carries a message, a type, or a status.
 */
function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  if (!isRecord(error)) return String(error)
  const parts: string[] = []
  const message = error['message']
  if (typeof message === 'string' && message.length > 0) parts.push(message)
  const type = error['type']
  if (typeof type === 'string' && type.length > 0) parts.push(`type=${type}`)
  const code = error['code']
  if (typeof code === 'string' || typeof code === 'number') parts.push(`code=${String(code)}`)
  const status = error['status']
  if (typeof status === 'number') parts.push(`status=${status}`)
  return parts.length > 0 ? parts.join(' ') : 'upstream reported an error'
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** `exactOptionalPropertyTypes` forbids passing an explicit `undefined` signal. */
function initFor(headers: Record<string, string>, body: string, signal: AbortSignal | undefined): RequestInit {
  const init: RequestInit = { method: 'POST', headers, body }
  if (signal !== undefined) init.signal = signal
  return init
}

/** Releases a response we are about to retry so the socket can be reused. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Already consumed or closed; the next attempt is unaffected.
  }
}

/** Keeps upstream error bodies short and never echoes the credential back. */
async function readErrorBody(response: Response): Promise<string> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return ''
  }
  return text.trim().slice(0, 500)
}

function redact(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join('[redacted]')
}
