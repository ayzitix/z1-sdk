import type { z } from 'zod'

import type { MemoryService } from './memory.ts'

/** Wire value: everything a node may send through a port or persist. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type PortKind = 'data' | 'flow'
export type StreamMode = 'value' | 'stream'

/**
 * A port is either a typed data edge or a flow (control) edge. Flow ports carry
 * no value, so a graph can be scheduled without inventing a payload for them.
 */
export type PortSpec =
  | {
      kind: 'data'
      id: string
      title?: string
      description?: string
      /** Zod schema for the wire value; also exported as JSON Schema for the UI. */
      schema: z.ZodType
      /** Default true. */
      required?: boolean
      /** Default 'value'. */
      mode?: StreamMode
      /**
       * Readiness of a connected data input. `'all'` (default) makes the node
       * wait for this port; `'any'` ports form a group the node can start on as
       * soon as one of them resolves.
       */
      waitFor?: 'all' | 'any'
    }
  | { kind: 'flow'; id: string; title?: string; description?: string }

export type AutonomyMode = 'auto' | 'ask' | 'deny'

export interface AutonomyPolicy {
  mode: AutonomyMode
  reason?: string
  timeoutMs?: number
  onTimeout?: 'deny' | 'approve'
}

export type Capability =
  | { kind: 'fs.read'; paths: readonly string[] }
  | { kind: 'fs.write'; paths: readonly string[] }
  | { kind: 'net'; hosts: readonly string[]; methods?: readonly string[] }
  | { kind: 'process.spawn'; commands?: readonly string[] }
  | { kind: 'spend'; currency: string; perCall?: number; perRun?: number }
  | { kind: 'secrets'; refs: readonly string[] }

export interface ModelHandle {
  provider: string
  model: string
  credentialRef?: string
  params?: Record<string, Json>
}

export interface ToolCall {
  id: string
  name: string
  arguments: Json
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface ToolSchema {
  name: string
  description?: string
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, Json>
}

export interface ChatRequest {
  model: ModelHandle
  messages: readonly ChatMessage[]
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
}

export interface ChatResult {
  message: ChatMessage
  toolCalls: readonly ToolCall[]
  usage?: ChatUsage
  stopReason: 'stop' | 'tool_calls' | 'length' | 'error'
}

export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }

export interface ApprovalRequest {
  /** 'tool.call' | 'fs.write' | 'net.request' | 'spend' | custom. */
  action: string
  target?: string
  reason?: string
  preview?: Json
  proposalHash?: string
}

export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled'

export interface SubgraphRunOptions {
  /** GraphDocument; typed in @z1/runtime to avoid an import cycle. */
  graph: unknown
  input?: Json
  /**
   * Segment inserted between the calling node's path and the nested nodes, e.g.
   * the loop iteration or map index. Without it every repeat shares one path and
   * a journal resume cannot tell the repetitions apart.
   */
  label?: string
}

export interface NodeContext<C = unknown> {
  readonly runId: string
  readonly nodeId: string
  /** Hierarchical execution path, e.g. `loop1/0/chat`. */
  readonly path: string
  readonly attempt: number
  readonly input: Json
  readonly config: C
  readonly signal: AbortSignal
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Json): void
  /** Out-of-band stream chunk for a data output port. Never journaled per chunk. */
  emit(port: string, chunk: Json): void
  llm: { chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult> }
  tools: {
    call(name: string, args: Json): Promise<Json>
    list(): Promise<readonly ToolSchema[]>
  }
  fs: {
    read(path: string): Promise<string>
    write(path: string, data: string): Promise<void>
  }
  artifacts: {
    put(data: Uint8Array, mime: string): Promise<string>
    get(hash: string): Promise<Uint8Array>
  }
  approval: { request(request: ApprovalRequest): Promise<ApprovalDecision> }
  /** External memory over the run tree; absent when the host supplies none. */
  readonly memory?: MemoryService
  /** Run a nested graph (loop body, subgraph node). Shares services and run id. */
  runSubgraph(options: SubgraphRunOptions): Promise<{ outputs: Record<string, Json> }>
}

export type NodeOutputs = Record<string, Json | undefined>

export interface NodeDefinition<C = unknown> {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly description?: string
  readonly category: string
  readonly config: z.ZodType<C>
  /**
   * Config the palette inserts into a freshly dropped node. Must satisfy
   * `config`, so a new node is valid before the human edits anything.
   */
  readonly defaultConfig?: Json
  readonly inputs: readonly PortSpec[]
  readonly outputs: readonly PortSpec[]
  readonly capabilities?: readonly Capability[]
  readonly autonomy?: AutonomyPolicy
  readonly timeoutMs?: number
  readonly retry?: { attempts: number; backoffMs: number }
  /** false disables the per-run output cache for this node (default true). */
  readonly cacheable?: boolean
  execute(ctx: NodeContext<C>): Promise<NodeOutputs>
}
