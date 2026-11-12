/**
 * Wire types for the `z1` node-graph JSON-RPC 2.0 protocol.
 *
 * This package owns the transport-agnostic contract only: envelopes, the method
 * map and notification map, and the descriptors the canvas renders. Runtime,
 * journal and graph value types are imported from their owning packages so the
 * server, the CLI and the canvas cannot drift from the engine.
 *
 * @module @z1/protocol/types
 */

import type { ValidationIssue } from '@z1/graph'
import type { RunRecord, RunStatus } from '@z1/journal'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Json,
  PortKind,
  StreamMode,
} from '@z1/node'
import type { PendingApproval, RunEvent } from '@z1/runtime'

export type { RunStatus }

/** JSON-RPC request id: a string or a number, echoed verbatim in the response. */
export type JsonRpcId = string | number

/** A request: a method plus an id whose result the caller awaits. */
export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: M
  params: P
}

/** A notification: a method with no id, so no response is ever sent. */
export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: '2.0'
  method: M
  params: P
}

/** The `error` member of a failed response. */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: R
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  /** `null` when the request could not be parsed, per the spec. */
  id: JsonRpcId | null
  error: JsonRpcError
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure

/** Standard JSON-RPC 2.0 error codes. */
export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

/** Application error codes, carried in the same `code` member. */
export const APP_ERRORS = {
  runNotFound: 1001,
  graphInvalid: 1002,
  approvalNotFound: 1003,
  conflict: 1004,
  unauthorized: 1005,
  artifactNotFound: 1006,
} as const

export type JsonRpcErrorCode = (typeof JSON_RPC_ERRORS)[keyof typeof JSON_RPC_ERRORS]
export type AppErrorCode = (typeof APP_ERRORS)[keyof typeof APP_ERRORS]
export type ErrorCode = JsonRpcErrorCode | AppErrorCode

/** Params of a method that takes none. */
export type EmptyParams = Record<string, never>

// --- descriptors -----------------------------------------------------------

/**
 * One port as the canvas sees it. `schema` is JSON Schema, already converted
 * from the node's zod schema by `portJsonSchema`; flow ports carry no value and
 * therefore no schema, `required` or `mode`.
 */
export interface PortDescriptor {
  id: string
  kind: PortKind
  /** Data ports only. Defaults to the definition's value (`true`). */
  required?: boolean
  /** Data ports only. Defaults to `'value'`. */
  mode?: StreamMode
  schema?: Record<string, unknown>
}

export interface NodeDescriptor {
  id: string
  version: string
  title: string
  category: string
  inputs: PortDescriptor[]
  outputs: PortDescriptor[]
}

/** One journal event plus its per-run sequence number. */
export interface SequencedEvent {
  seq: number
  event: RunEvent
}

// --- method params/results -------------------------------------------------

export interface InitializeParams {
  clientName: string
  protocolVersion?: '1'
}

export interface InitializeResult {
  serverName: 'z1'
  protocolVersion: '1'
  capabilities: {
    runs: true
    approvals: true
    /** Module packaging ships after M3. */
    modules: false
  }
}

export type NodeListParams = EmptyParams

export type NodeListResult = NodeDescriptor[]

export interface GraphValidateParams {
  graph: unknown
}

export interface GraphValidateResult {
  ok: boolean
  issues: ValidationIssue[]
}

/** How a node's approval policy is resolved for this run. */
export type ApprovalMode = 'auto' | 'ask' | 'deny'

export interface RunStartParams {
  graph: unknown
  input?: Json
  approvalMode?: ApprovalMode
  /** Replay completed nodes from the journal instead of executing them. */
  resume?: boolean
  runId?: string
}

export interface RunResumeParams {
  runId: string
  /** Omitted when the journal already holds the graph. */
  graph?: unknown
  input?: Json
  approvalMode?: ApprovalMode
}

export interface RunCancelParams {
  runId: string
}

export type RunListParams = EmptyParams

export type RunListResult = RunRecord[]

export interface RunGetParams {
  runId: string
  /** Return only events with `seq > afterSeq`; defaults to every event. */
  afterSeq?: number
}

export interface RunGetResult {
  record: RunRecord
  events: SequencedEvent[]
}

export interface RunSubscribeParams {
  runId: string
  afterSeq?: number
}

/** Replay result; live events then arrive as `run.event` notifications. */
export interface RunSubscribeResult {
  events: SequencedEvent[]
}

export interface RunForkParams {
  runId: string
  /** Fork point; defaults to the end of the parent's journal. */
  atSeq?: number
  /** Restrict the fork to one node's subtree. */
  nodePath?: string
}

export interface RunForkResult {
  runId: string
  parentRunId: string
  forkSeq: number
}

export interface ApprovalRespondParams {
  approvalId: string
  /** `cancelled` is never a client decision: it aborts the run instead. */
  decision: Extract<ApprovalDecision, 'allowed-once' | 'rejected'>
}

export interface ArtifactGetParams {
  hash: string
}

export interface ArtifactGetResult {
  hash: string
  mime: string
  base64: string
}

/**
 * The outcome of a `run.start`/`run.resume`. `error` is the engine's message;
 * `pendingApproval` is set when the run suspended on an `ask` node.
 */
export interface RunReply {
  runId: string
  status: Exclude<RunStatus, 'running'>
  outputs: Record<string, Json>
  error?: string
  pendingApproval?: PendingApproval
}

// --- server -> client ------------------------------------------------------

export interface ApprovalRequestParams {
  approvalId: string
  runId: string
  nodeId: string
  /** Hierarchical execution path of the node asking. */
  path: string
  request: ApprovalRequest
}

export interface ApprovalRequestResult {
  decision: ApprovalDecision
}

/**
 * Methods the server may invoke on the client. `approval/request` is the only
 * one: a run blocked on `ask` must not return until the human answers, so the
 * client's reply is a request result rather than a fire-and-forget notification.
 */
export interface ClientMethodMap {
  'approval/request': { params: ApprovalRequestParams; result: ApprovalRequestResult }
}

/**
 * Methods a peer can serve, keyed by wire name. Both directions share one map so
 * a single `JsonRpcPeer` can act as client and server; the direction of each
 * entry is documented on {@link RemoteMethodName} and {@link ClientMethodMap}.
 */
export interface MethodMap extends ClientMethodMap {
  initialize: { params: InitializeParams; result: InitializeResult }
  'node.list': { params: NodeListParams; result: NodeListResult }
  'graph.validate': { params: GraphValidateParams; result: GraphValidateResult }
  'run.start': { params: RunStartParams; result: RunReply }
  'run.resume': { params: RunResumeParams; result: RunReply }
  'run.cancel': { params: RunCancelParams; result: EmptyParams }
  'run.list': { params: RunListParams; result: RunListResult }
  'run.get': { params: RunGetParams; result: RunGetResult }
  'run.subscribe': { params: RunSubscribeParams; result: RunSubscribeResult }
  'run.fork': { params: RunForkParams; result: RunForkResult }
  'approval.respond': { params: ApprovalRespondParams; result: EmptyParams }
  'artifact.get': { params: ArtifactGetParams; result: ArtifactGetResult }
}

/** Client-to-server method names (everything except the server's own calls). */
export type RemoteMethodName = Exclude<keyof MethodMap, keyof ClientMethodMap>

// --- server -> client notifications ---------------------------------------

export interface NotificationMap {
  'run.event': { runId: string; seq: number; event: RunEvent }
  'run.status': { runId: string; status: RunStatus }
}

export type NotificationName = keyof NotificationMap
