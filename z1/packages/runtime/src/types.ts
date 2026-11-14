import type { GraphDocument } from '@z1/graph'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatDelta,
  ChatRequest,
  ChatResult,
  ChatUsage,
  Json,
  MemoryService,
  NodeRegistry,
  ProviderGetRequest,
  ProviderGetResponse,
  ToolSchema,
} from '@z1/node'

export interface LlmService {
  chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult>
  /**
   * An authenticated **metadata read** against a configured provider.
   *
   * The host owns the base URL, the credential and the retry policy; the caller
   * supplies only a path and a query. This exists so a module can ask a provider
   * what it serves without the SDK knowing any provider's address: which path
   * (`/models`, `/api/tags`, `/openai/models`), which query (`?api-version`,
   * `?type=text`) and how to read the body are the module's business.
   *
   * Deliberately GET-only. A model turn must go through {@link chat} so it is
   * journaled; this is for metadata, never for inference.
   */
  get?(request: ProviderGetRequest, signal?: AbortSignal): Promise<ProviderGetResponse>
}

export interface ToolService {
  call(name: string, args: Json): Promise<Json>
  list(): Promise<readonly ToolSchema[]>
}

export interface FsService {
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
}

export interface ArtifactService {
  put(data: Uint8Array, mime: string): Promise<string>
  get(hash: string): Promise<Uint8Array>
}

export interface ApprovalService {
  request(
    request: ApprovalRequest,
    context: { runId: string; nodeId: string },
  ): Promise<ApprovalDecision>
}

/** An approval the run stopped on, waiting for a `--resume` decision. */
export interface PendingApproval {
  /** Hierarchical execution path of the node that needs the decision. */
  path: string
  request: ApprovalRequest
}

/** Every observable event of a run. `node.stream` is never journaled. */
export type RunEvent =
  | {
      type: 'run.started'
      runId: string
      graphId: string
      /** Semantic digest of the graph, checked again by `resume`. */
      graphDigest: string
      /** The run seed (`options.input`, or `null` when absent). */
      input: Json
      /** sha256 of the canonical JSON of `input`, checked again by `resume`. */
      inputDigest: string
      at: number
    }
  | { type: 'run.resumed'; runId: string; at: number }
  | {
      type: 'node.started'
      runId: string
      nodeId: string
      path: string
      attempt: number
      at: number
    }
  | {
      type: 'node.stream'
      runId: string
      nodeId: string
      path: string
      port: string
      chunk: Json
    }
  | {
      type: 'node.cached'
      runId: string
      nodeId: string
      path: string
      at: number
      /** Omitted for an in-run cache hit; `'resume'` when replayed from the journal. */
      reason?: 'cache' | 'resume'
    }
  | {
      type: 'node.completed'
      runId: string
      nodeId: string
      path: string
      attempt: number
      durationMs: number
      at: number
      /** Validated port outputs, persisted so a resume can replay the node. */
      outputs: Record<string, Json>
    }
  | {
      type: 'node.failed'
      runId: string
      nodeId: string
      path: string
      attempt: number
      error: string
      at: number
    }
  | {
      type: 'approval.requested'
      runId: string
      nodeId: string
      path: string
      request: ApprovalRequest
    }
  | {
      type: 'approval.decided'
      runId: string
      nodeId: string
      path: string
      decision: ApprovalDecision
    }
  | {
      type: 'llm.request'
      runId: string
      /** Execution path of the calling node, or `(ambient)` outside one. */
      path: string
      provider: string
      model: string
      attempt: number
      /** sha256 of the canonical, redacted request; also the blob hash. */
      requestHash: string
      /** Present only when `Z1_RECORD_LLM=full`. */
      requestBlob?: string
      at: number
    }
  | {
      type: 'llm.response'
      runId: string
      path: string
      provider: string
      model: string
      attempt: number
      /** sha256 of the canonical, redacted response; also the blob hash. */
      responseHash: string
      /** Present only when `Z1_RECORD_LLM=full`. */
      responseBlob?: string
      usage?: ChatUsage
      latencyMs: number
      stopReason: ChatResult['stopReason']
      at: number
    }
  | { type: 'run.suspended'; runId: string; at: number; path: string }
  | { type: 'run.completed'; runId: string; at: number; outputs: Record<string, Json> }
  | { type: 'run.failed'; runId: string; at: number; error: string }
  | { type: 'run.cancelled'; runId: string; at: number }

/** A structured log line emitted by a node through `NodeContext.log`. */
export interface LogEntry {
  runId: string
  nodeId: string
  path: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data?: Json
}

export interface RuntimeServices {
  llm: LlmService
  tools: ToolService
  fs: FsService
  artifacts: ArtifactService
  approval: ApprovalService
  /** External memory over the run tree; nodes see it as `ctx.memory`. */
  memory?: MemoryService
  /** Receives every run event, including stream chunks. */
  onEvent?: (event: RunEvent) => void
  /** Receives node log lines; a no-op when omitted. */
  onLog?: (entry: LogEntry) => void
}

export interface Journal {
  append(event: RunEvent): void | Promise<void>
  read(runId: string): readonly RunEvent[]
}

export interface RunOptions {
  graph: GraphDocument
  input?: Json
  registry: NodeRegistry
  services: RuntimeServices
  runId?: string
  signal?: AbortSignal
  /** Journal sink; in-memory when omitted. */
  journal?: Journal
  /** Execution path prefix for nested runs. Internal. */
  pathPrefix?: string
  /** Replay completed nodes from the journal instead of executing them. */
  resume?: boolean
  /** Stop before an `ask` node and return `status: 'suspended'`. */
  suspendOnApproval?: boolean
}

export interface RunResult {
  runId: string
  status: 'completed' | 'failed' | 'cancelled' | 'suspended'
  outputs: Record<string, Json>
  error?: string
  /** Set with `status: 'suspended'`: the approval a resume must decide. */
  pendingApproval?: PendingApproval
}
