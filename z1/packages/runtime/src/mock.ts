import { createHash } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatDelta,
  ChatRequest,
  ChatResult,
  Json,
  ToolSchema,
} from '@z1/node'
import type { RuntimeServices } from './types.ts'

export type MockApprovalBehavior =
  | ApprovalDecision
  | ((
      request: ApprovalRequest,
      context: { runId: string; nodeId: string },
    ) => ApprovalDecision | Promise<ApprovalDecision>)

export interface MockRuntimeOptions {
  /** Defaults to `allowed-once`. */
  approval?: MockApprovalBehavior
}

export interface MockRuntimeServices extends RuntimeServices {
  readonly files: Map<string, string>
  readonly chatCalls: ChatRequest[]
  readonly toolCalls: { name: string; args: Json }[]
}

function lastUserContent(messages: readonly { role: string; content: string }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'user') return message.content
  }
  return ''
}

const TOOL_MARKER = /\[\[tool:([^\]]+)\]\]/

/**
 * Deterministic in-memory services for tests and the M0 CLI. Everything is
 * byte-for-byte reproducible except approval, which callers configure.
 */
export function createMockRuntimeServices(
  options: MockRuntimeOptions = {},
): MockRuntimeServices {
  const files = new Map<string, string>()
  const blobs = new Map<string, Uint8Array>()
  const chatCalls: ChatRequest[] = []
  const toolCalls: { name: string; args: Json }[] = []
  const approvalBehavior = options.approval ?? 'allowed-once'

  return {
    files,
    chatCalls,
    toolCalls,
    llm: {
      async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult> {
        chatCalls.push(request)
        const content = lastUserContent(request.messages)
        const marker = TOOL_MARKER.exec(content)

        if (marker !== null) {
          const name = marker[1] ?? ''
          return {
            message: { role: 'assistant', content: '' },
            toolCalls: [{ id: 'call_1', name, arguments: {} }],
            stopReason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        }

        const reply = `mock: ${content}`
        if (onDelta !== undefined) {
          const words = reply.split(' ')
          for (const [index, word] of words.entries()) {
            onDelta({ type: 'text', text: index === 0 ? word : ` ${word}` })
          }
        }

        return {
          message: { role: 'assistant', content: reply },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    },
    tools: {
      async call(name: string, args: Json): Promise<Json> {
        toolCalls.push({ name, args })
        return { ok: true, name, args }
      },
      async list(): Promise<readonly ToolSchema[]> {
        return []
      },
    },
    fs: {
      async read(path: string): Promise<string> {
        const data = files.get(path)
        if (data === undefined) throw new Error(`ENOENT: no such file "${path}"`)
        return data
      },
      async write(path: string, data: string): Promise<void> {
        files.set(path, data)
      },
    },
    artifacts: {
      async put(data: Uint8Array, _mime: string): Promise<string> {
        const hash = createHash('sha256').update(data).digest('hex')
        blobs.set(hash, data)
        return hash
      },
      async get(hash: string): Promise<Uint8Array> {
        const data = blobs.get(hash)
        if (data === undefined) throw new Error(`unknown artifact "${hash}"`)
        return data
      },
    },
    approval: {
      async request(
        request: ApprovalRequest,
        context: { runId: string; nodeId: string },
      ): Promise<ApprovalDecision> {
        if (typeof approvalBehavior === 'function') {
          return await approvalBehavior(request, context)
        }
        return approvalBehavior
      },
    },
  }
}
