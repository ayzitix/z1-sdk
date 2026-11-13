/**
 * Host-side adapters over a worker-based service module.
 *
 * A `worker` service never touches the host process: the host calls
 * {@link ModuleWorker.serviceCall}, the child runs the module's method, and
 * every result comes back over IPC as JSON. These adapters validate that JSON
 * against the runtime service interface, so module code cannot smuggle a
 * non-JSON or wrongly shaped value into a node.
 *
 * `workerArtifactService` is the one exception to plain JSON: bytes travel as
 * base64. `put` sends `{ data, mime }` and expects `{ hash, mime }`; `get`
 * sends `{ hash }` and expects `{ data, mime }`.
 *
 * @module @z1/node-host/adapters
 */

import type {
  ChatDelta,
  ChatMessage,
  ChatRequest,
  ChatResult,
  Json,
  MemoryContextRequest,
  MemoryEnvelope,
  MemoryService,
  ToolCall,
  ToolSchema,
} from '@z1/node'
import type { ArtifactService, FsService, LlmService, ToolService } from '@z1/runtime'
import type { ModuleWorker } from './host.ts'

const ROLES: readonly ChatMessage['role'][] = ['system', 'user', 'assistant', 'tool']
const STOP_REASONS: readonly ChatResult['stopReason'][] = [
  'stop',
  'tool_calls',
  'length',
  'error',
]
const MAX_JSON_DEPTH = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(serviceId: string, where: string, detail: string): never {
  throw new Error(`service "${serviceId}" returned an invalid ${where}: ${detail}`)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/** Validate a value the child produced as plain JSON. */
function asJson(value: unknown, serviceId: string, where: string, depth = 0): Json {
  if (depth > MAX_JSON_DEPTH) invalid(serviceId, where, 'nested too deeply')
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value as string | boolean
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) invalid(serviceId, where, 'non-finite number')
    return value as number
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      asJson(entry, serviceId, `${where}[${String(index)}]`, depth + 1),
    )
  }
  if (isRecord(value)) {
    const result: Record<string, Json> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[key] = asJson(entry, serviceId, `${where}.${key}`, depth + 1)
    }
    return result
  }
  invalid(serviceId, where, `${describe(value)} is not JSON`)
}

function readString(
  raw: Record<string, unknown>,
  key: string,
  serviceId: string,
  where: string,
): string {
  const value = raw[key]
  if (typeof value !== 'string') {
    invalid(serviceId, where, `"${key}" must be a string, got ${describe(value)}`)
  }
  return value
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  serviceId: string,
  where: string,
): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(serviceId, where, `"${key}" must be a string`)
  return value
}

function parseToolCall(raw: unknown, serviceId: string, where: string): ToolCall {
  if (!isRecord(raw)) invalid(serviceId, where, `must be an object, got ${describe(raw)}`)
  const id = readString(raw, 'id', serviceId, where)
  const name = readString(raw, 'name', serviceId, where)
  return { id, name, arguments: asJson(raw['arguments'] ?? null, serviceId, `${where}.arguments`) }
}

function parseToolCalls(raw: unknown, serviceId: string, where: string): ToolCall[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) invalid(serviceId, where, `must be an array, got ${describe(raw)}`)
  const list: unknown[] = raw
  return list.map((entry, index) => parseToolCall(entry, serviceId, `${where}[${String(index)}]`))
}

function parseMessage(raw: unknown, serviceId: string, where: string): ChatMessage {
  if (!isRecord(raw)) invalid(serviceId, where, `must be an object, got ${describe(raw)}`)
  const role = raw['role']
  if (typeof role !== 'string' || !ROLES.includes(role as ChatMessage['role'])) {
    invalid(serviceId, where, `"role" must be one of ${ROLES.join(', ')}`)
  }
  const message: ChatMessage = {
    role: role as ChatMessage['role'],
    content: readString(raw, 'content', serviceId, where),
  }
  const toolCallId = optionalString(raw, 'toolCallId', serviceId, where)
  if (toolCallId !== undefined) message.toolCallId = toolCallId
  const toolCalls = parseToolCalls(raw['toolCalls'], serviceId, `${where}.toolCalls`)
  if (toolCalls.length > 0) message.toolCalls = toolCalls
  return message
}

function parseChatResult(raw: unknown, serviceId: string): ChatResult {
  if (!isRecord(raw)) invalid(serviceId, 'chat result', `must be an object, got ${describe(raw)}`)
  const message = parseMessage(raw['message'], serviceId, 'chat result.message')
  const toolCalls = parseToolCalls(raw['toolCalls'], serviceId, 'chat result.toolCalls')
  const stopReason = raw['stopReason']
  if (typeof stopReason !== 'string' || !STOP_REASONS.includes(stopReason as ChatResult['stopReason'])) {
    invalid(serviceId, 'chat result', `"stopReason" must be one of ${STOP_REASONS.join(', ')}`)
  }

  const result: ChatResult = {
    message,
    toolCalls,
    stopReason: stopReason as ChatResult['stopReason'],
  }
  const usage = raw['usage']
  if (usage !== undefined) {
    if (!isRecord(usage)) invalid(serviceId, 'chat result.usage', 'must be an object')
    const inputTokens = usage['inputTokens']
    const outputTokens = usage['outputTokens']
    if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) {
      invalid(serviceId, 'chat result.usage', '"inputTokens" must be a finite number')
    }
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) {
      invalid(serviceId, 'chat result.usage', '"outputTokens" must be a finite number')
    }
    result.usage = { inputTokens, outputTokens }
  }
  return result
}

/** Validate one streamed chunk before it reaches node code. */
function parseDelta(raw: unknown, serviceId: string): ChatDelta {
  if (!isRecord(raw)) invalid(serviceId, 'chat delta', `must be an object, got ${describe(raw)}`)
  const type = raw['type']
  if (type === 'text' || type === 'reasoning') {
    return { type, text: readString(raw, 'text', serviceId, `chat delta "${type}"`) }
  }
  if (type === 'tool_call') {
    const index = raw['index']
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      invalid(serviceId, 'chat delta "tool_call"', '"index" must be a non-negative integer')
    }
    const delta: Extract<ChatDelta, { type: 'tool_call' }> = { type: 'tool_call', index }
    const id = optionalString(raw, 'id', serviceId, 'chat delta "tool_call"')
    const name = optionalString(raw, 'name', serviceId, 'chat delta "tool_call"')
    const argumentsDelta = optionalString(raw, 'argumentsDelta', serviceId, 'chat delta "tool_call"')
    if (id !== undefined) delta.id = id
    if (name !== undefined) delta.name = name
    if (argumentsDelta !== undefined) delta.argumentsDelta = argumentsDelta
    return delta
  }
  invalid(serviceId, 'chat delta', `"type" must be text, reasoning or tool_call`)
}

function parseToolSchema(raw: unknown, serviceId: string, where: string): ToolSchema {
  if (!isRecord(raw)) invalid(serviceId, where, `must be an object, got ${describe(raw)}`)
  const schema: ToolSchema = { name: readString(raw, 'name', serviceId, where), parameters: {} }
  const description = optionalString(raw, 'description', serviceId, where)
  if (description !== undefined) schema.description = description
  const parameters = raw['parameters']
  if (parameters !== undefined) {
    const json = asJson(parameters, serviceId, `${where}.parameters`)
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      invalid(serviceId, `${where}.parameters`, 'must be an object')
    }
    schema.parameters = json as Record<string, Json>
  }
  return schema
}

function parseToolSchemas(raw: unknown, serviceId: string): ToolSchema[] {
  if (!Array.isArray(raw)) {
    invalid(serviceId, 'tool list', `must be an array, got ${describe(raw)}`)
  }
  const list: unknown[] = raw
  return list.map((entry, index) =>
    parseToolSchema(entry, serviceId, `tool list[${String(index)}]`),
  )
}

function parseMemoryEnvelope(raw: unknown, serviceId: string): MemoryEnvelope {
  if (!isRecord(raw)) invalid(serviceId, 'memory envelope', `must be an object, got ${describe(raw)}`)
  const text = readString(raw, 'text', serviceId, 'memory envelope')

  const rawMessages = raw['messages']
  if (!Array.isArray(rawMessages)) {
    invalid(serviceId, 'memory envelope', '"messages" must be an array')
  }
  const messages: unknown[] = rawMessages

  const stringList = (key: 'spine' | 'siblings'): string[] => {
    const value = raw[key]
    if (!Array.isArray(value)) {
      invalid(serviceId, 'memory envelope', `"${key}" must be an array of strings`)
    }
    const list: unknown[] = value
    if (list.some((entry) => typeof entry !== 'string')) {
      invalid(serviceId, 'memory envelope', `"${key}" must be an array of strings`)
    }
    return list.map((entry) => String(entry))
  }

  const recentRaw = raw['recent']
  if (!Array.isArray(recentRaw)) {
    invalid(serviceId, 'memory envelope', '"recent" must be an array')
  }
  const recentList: unknown[] = recentRaw
  const recent = recentList.map((entry, index) => {
    const where = `memory envelope.recent[${String(index)}]`
    if (!isRecord(entry)) invalid(serviceId, where, 'must be an object')
    return {
      path: readString(entry, 'path', serviceId, where),
      type: readString(entry, 'type', serviceId, where),
      summary: readString(entry, 'summary', serviceId, where),
    }
  })

  return {
    text,
    messages: messages.map((entry, index) =>
      parseMessage(entry, serviceId, `memory envelope.messages[${String(index)}]`),
    ),
    spine: stringList('spine'),
    siblings: stringList('siblings'),
    recent,
  }
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
}

function fromBase64(text: string, serviceId: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    invalid(serviceId, 'artifact', '"data" is not valid base64')
  }
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/** `llm.chat`, streaming deltas through the worker's `chat` callback param. */
export function workerLlmService(worker: ModuleWorker, serviceId: string): LlmService {
  return {
    async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult> {
      let deltaError: Error | undefined
      const streamed =
        onDelta === undefined
          ? {}
          : {
              onDelta: (raw: unknown): void => {
                if (deltaError !== undefined) return
                try {
                  onDelta(parseDelta(raw, serviceId))
                } catch (error) {
                  // Throwing here would escape into the worker's IPC handler.
                  deltaError = error instanceof Error ? error : new Error(String(error))
                }
              },
            }
      const result = await worker.serviceCall(serviceId, 'chat', [request], streamed)
      if (deltaError !== undefined) throw deltaError
      return parseChatResult(result, serviceId)
    },
  }
}

/** `tools.call` / `tools.list` over the worker. */
export function workerToolService(worker: ModuleWorker, serviceId: string): ToolService {
  return {
    async call(name: string, args: Json): Promise<Json> {
      const value = await worker.serviceCall(serviceId, 'call', [name, args])
      return asJson(value, serviceId, 'tool result')
    },
    async list(): Promise<readonly ToolSchema[]> {
      return parseToolSchemas(await worker.serviceCall(serviceId, 'list', []), serviceId)
    },
  }
}

/** `fs.read` / `fs.write`, with the worker's own fs capability applied. */
export function workerFsService(worker: ModuleWorker, serviceId: string): FsService {
  return {
    async read(path: string): Promise<string> {
      const value = await worker.serviceCall(serviceId, 'read', [path])
      if (typeof value !== 'string') {
        invalid(serviceId, 'fs read result', `must be a string, got ${describe(value)}`)
      }
      return value
    },
    async write(path: string, data: string): Promise<void> {
      await worker.serviceCall(serviceId, 'write', [path, data])
    },
  }
}

/** Artifacts travel base64-encoded; see the module doc comment for the shape. */
export function workerArtifactService(worker: ModuleWorker, serviceId: string): ArtifactService {
  return {
    async put(data: Uint8Array, mime: string): Promise<string> {
      if (typeof mime !== 'string' || mime.length === 0) {
        throw new Error(`artifact put requires a non-empty mime, got ${describe(mime)}`)
      }
      const raw = await worker.serviceCall(serviceId, 'put', [
        { data: toBase64(data), mime },
      ])
      if (!isRecord(raw)) invalid(serviceId, 'artifact put result', 'must be an object')
      const hash = readString(raw, 'hash', serviceId, 'artifact put result')
      if (hash.length === 0) invalid(serviceId, 'artifact put result', '"hash" must not be empty')
      const returnedMime = readString(raw, 'mime', serviceId, 'artifact put result')
      if (returnedMime !== mime) {
        invalid(
          serviceId,
          'artifact put result',
          `mime changed from "${mime}" to "${returnedMime}"`,
        )
      }
      return hash
    },
    async get(hash: string): Promise<Uint8Array> {
      if (typeof hash !== 'string' || hash.length === 0) {
        throw new Error('artifact get requires a non-empty hash')
      }
      const raw = await worker.serviceCall(serviceId, 'get', [{ hash }])
      if (!isRecord(raw)) invalid(serviceId, 'artifact get result', 'must be an object')
      const data = readString(raw, 'data', serviceId, 'artifact get result')
      const mime = readString(raw, 'mime', serviceId, 'artifact get result')
      if (mime.length === 0) invalid(serviceId, 'artifact get result', '"mime" must not be empty')
      return fromBase64(data, serviceId)
    },
  }
}

/**
 * `memory.buildContext` over the worker.
 *
 * `writeSummary` is deliberately not implemented: it is optional on the host
 * interface, and a worker that does not export it must not fail a run.
 */
export function workerMemoryService(worker: ModuleWorker, serviceId: string): MemoryService {
  return {
    async buildContext(request: MemoryContextRequest): Promise<MemoryEnvelope> {
      return parseMemoryEnvelope(await worker.serviceCall(serviceId, 'buildContext', [request]), serviceId)
    },
  }
}
