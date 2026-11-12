import type {
  ChatDelta,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatUsage,
  Json,
  ToolCall,
  ToolSchema,
} from '@z1/node'
import type { LlmService } from '@z1/runtime'
import { readSseData } from './sse.ts'
import type { OpenAiProviderOptions } from './types.ts'

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

  constructor(options: OpenAiProviderOptions) {
    this.endpoint = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.extraHeaders = options.headers
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async chat(
    request: ChatRequest,
    onDelta?: (delta: ChatDelta) => void,
  ): Promise<ChatResult> {
    const stream = request.model.params?.['stream'] !== false
    const body = buildBody(request, stream)
    const response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })

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

    const accumulator = new ChatAccumulator(onDelta)
    let finishReason: string | undefined
    let usage: ChatUsage | undefined

    for await (const payload of readSseData(response.body)) {
      if (payload === '[DONE]') break
      const chunk = parseObject(payload) as WireResponse | undefined
      if (chunk === undefined) continue
      const choice = chunk.choices?.[0]
      if (choice?.delta !== undefined) accumulator.apply(choice.delta)
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
      const chunkUsage = toUsage(chunk.usage)
      if (chunkUsage !== undefined) usage = chunkUsage
    }

    return accumulator.finish(finishReason, usage)
  }

  /** Non-streaming callers get one complete message; no deltas are emitted. */
  private async readComplete(response: Response): Promise<ChatResult> {
    const raw: unknown = await response.json()
    const data = isRecord(raw) ? (raw as WireResponse) : {}
    const choice = data.choices?.[0]
    const accumulator = new ChatAccumulator(undefined)
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

  constructor(onDelta: ((delta: ChatDelta) => void) | undefined) {
    this.onDelta = onDelta
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
        id: entry.id.length > 0 ? entry.id : `call_${index}`,
        name: entry.name,
        arguments: parseArguments(entry.arguments),
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

/** Empty arguments mean "no arguments"; a truncated stream must not fail the run. */
function parseArguments(raw: string): Json {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const value: unknown = JSON.parse(trimmed)
    return isJson(value) ? value : {}
  } catch {
    return {}
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

function parseObject(payload: string): unknown {
  try {
    const value: unknown = JSON.parse(payload)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
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
