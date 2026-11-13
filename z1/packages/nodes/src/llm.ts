import { z } from 'zod'
import {
  defineNode,
  type ChatMessage,
  type ChatRequest,
  type Json,
  type ModelHandle,
  type NodeDefinition,
  type ToolCall,
  type ToolSchema,
} from '@z1/node'
import {
  asJson,
  dataPort,
  flowPort,
  inputValues,
  isRecord,
  jsonValue,
  NODE_VERSION,
} from './shared.ts'

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: jsonValue,
})

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
})

const modelHandleSchema = z.object({
  provider: z.string(),
  model: z.string(),
  credentialRef: z.string().optional(),
  params: z.record(z.string(), jsonValue).optional(),
})

function toModelHandle(value: unknown): ModelHandle | undefined {
  if (!isRecord(value)) return undefined
  const provider = value['provider']
  const model = value['model']
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined

  const handle: ModelHandle = { provider, model }
  const credentialRef = value['credentialRef']
  if (typeof credentialRef === 'string') handle.credentialRef = credentialRef
  const params = value['params']
  if (isRecord(params)) handle.params = params
  return handle
}

function toToolCalls(value: Json | undefined): ToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: ToolCall[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = entry['id']
    const name = entry['name']
    if (typeof id !== 'string' || typeof name !== 'string') continue
    calls.push({ id, name, arguments: entry['arguments'] ?? null })
  }
  return calls
}

const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), jsonValue).optional(),
})

/** Rebuilds the typed tool declarations from their wire value. */
function toToolSchemas(value: Json | undefined): ToolSchema[] {
  if (!Array.isArray(value)) return []
  const schemas: ToolSchema[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const name = entry['name']
    if (typeof name !== 'string') continue
    const schema: ToolSchema = {
      name,
      parameters: isRecord(entry['parameters']) ? entry['parameters'] : {},
    }
    if (typeof entry['description'] === 'string') schema.description = entry['description']
    schemas.push(schema)
  }
  return schemas
}

/** Rebuilds the typed messages from a wire value, keeping tool-call fidelity. */
function toChatMessages(value: Json | undefined): ChatMessage[] {
  if (!Array.isArray(value)) return []
  const messages: ChatMessage[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const role = entry['role']
    const content = entry['content']
    if (typeof content !== 'string') continue
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue

    const message: ChatMessage = { role, content }
    const toolCallId = entry['toolCallId']
    if (typeof toolCallId === 'string') message.toolCallId = toolCallId
    const toolCalls = toToolCalls(entry['toolCalls'])
    if (toolCalls.length > 0) message.toolCalls = toolCalls
    messages.push(message)
  }
  return messages
}

const model = defineNode({
  id: 'z1.llm.model',
  version: NODE_VERSION,
  title: 'Model',
  description: 'Resolves a provider/model pair into a serializable handle.',
  category: 'llm',
  config: z.object({
    provider: z.string(),
    model: z.string(),
    credentialRef: z.string().optional(),
    params: z.record(z.string(), jsonValue).optional(),
  }),
  inputs: [],
  outputs: [dataPort('model', modelHandleSchema)],
  execute: async (ctx) => {
    const handle: ModelHandle = { provider: ctx.config.provider, model: ctx.config.model }
    if (ctx.config.credentialRef !== undefined) handle.credentialRef = ctx.config.credentialRef
    if (ctx.config.params !== undefined) handle.params = ctx.config.params
    return { model: asJson(handle) }
  },
})

const chat = defineNode({
  id: 'z1.llm.chat',
  version: NODE_VERSION,
  title: 'Chat',
  description: 'One model turn; streams text deltas on the "text" port.',
  category: 'llm',
  config: z.object({
    model: modelHandleSchema.optional(),
    system: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
  inputs: [
    flowPort('in'),
    dataPort('model', modelHandleSchema, false),
    dataPort('messages', z.array(chatMessageSchema), false),
    dataPort('tools', z.array(toolSchema), false),
    // A composed system prompt usually arrives from `z1.prompt.stack`; when the
    // port is connected it wins over config.system.
    dataPort('system', z.string(), false),
    // Convenience for one-shot turns: a single user message without building
    // the `messages` array in the graph.
    dataPort('prompt', z.string(), false),
  ],
  outputs: [
    dataPort('text', z.string()),
    dataPort('message', chatMessageSchema),
    dataPort('toolCalls', z.array(toolCallSchema)),
    dataPort('usage', z.record(z.string(), jsonValue)),
    dataPort('hasToolCalls', z.boolean()),
    // A chat turn is a normal flow step, so it can carry the spine forward.
    flowPort('out'),
  ],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    // A connected `model` port wins over config.model: the graph author wired a
    // handle on purpose, so config is only the fallback when the port is absent.
    const hasModelPort = Object.hasOwn(values, 'model')
    const portModel = hasModelPort ? toModelHandle(values['model']) : undefined
    const resolved = hasModelPort ? portModel : toModelHandle(ctx.config.model)
    if (resolved === undefined) {
      throw new Error(
        hasModelPort
          ? 'z1.llm.chat: the "model" input is not a model handle'
          : 'z1.llm.chat: no model — connect the "model" input or set config.model',
      )
    }

    const messages = toChatMessages(values['messages'])
    const prompt = values['prompt']
    // `prompt` is the convenience path only when no messages were supplied; an
    // empty string is still a user message with empty content.
    if (messages.length === 0 && typeof prompt === 'string') {
      messages.push({ role: 'user', content: prompt })
    }
    // A connected `system` port is authoritative; config.system is the fallback.
    // Either way, an empty or whitespace-only string means "no system message".
    const rawSystem = Object.hasOwn(values, 'system')
      ? values['system']
      : ctx.config.system
    const system =
      typeof rawSystem === 'string' && rawSystem.trim() !== '' ? rawSystem : undefined
    // Never duplicate a system message the caller already put first.
    const withSystem =
      system === undefined || messages[0]?.role === 'system'
        ? messages
        : [{ role: 'system' as const, content: system }, ...messages]
    // A connected `tools` port is a deliberate declaration, so an empty array
    // still means "no tools" and is forwarded as such.
    const tools = Object.hasOwn(values, 'tools') ? toToolSchemas(values['tools']) : undefined
    const request: ChatRequest = {
      model: resolved,
      messages: withSystem,
      ...(tools !== undefined ? { tools } : {}),
      ...(ctx.config.maxTokens !== undefined ? { maxTokens: ctx.config.maxTokens } : {}),
    }

    const result = await ctx.llm.chat(request, (delta) => {
      // Empty chunks carry no information and would spam the event stream.
      if (delta.type !== 'text' || delta.text.length === 0) return
      ctx.emit('text', delta.text)
    })

    return {
      text: result.message.content,
      message: asJson(result.message),
      toolCalls: asJson([...result.toolCalls]),
      usage: result.usage === undefined ? {} : asJson(result.usage),
      hasToolCalls: result.toolCalls.length > 0,
      out: true,
    }
  },
})

export const llmNodes: readonly NodeDefinition[] = [model, chat]
export { chat as llmChat, model as llmModel }
