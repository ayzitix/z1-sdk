/**
 * Browser client for the `z1 serve` JSON-RPC WebSocket endpoint.
 *
 * The peer from `@z1/protocol` owns envelopes and matching; this module only
 * adapts the browser `WebSocket` to the `Transport` interface and adds typed
 * wrappers for the methods the canvas uses.
 *
 * @module canvas/api
 */

import type { ApprovalDecision } from '@z1/node'
import {
  JsonRpcFault,
  JsonRpcPeer,
  type ApprovalRequestParams,
  type ArtifactGetResult,
  type GraphValidateResult,
  type InitializeResult,
  type ModuleAuditResult,
  type ModuleListResult,
  type ModuleSummary,
  type NodeDescriptor,
  type NotificationMap,
  type ProposalSummary,
  type RunForkResult,
  type RunGetResult,
  type RunListResult,
  type RunReply,
  type RunResumeParams,
  type RunStartParams,
  type RunStatus,
  type RunSubscribeResult,
  type Transport,
} from '@z1/protocol'

/** One notification as the server sends it. */
type RunEventNotification = NotificationMap['run.event']
type RunStatusNotification = NotificationMap['run.status']

/** Resolves an approval request; the peer sends the answer back to the server. */
export type ApprovalHandler = (
  params: ApprovalRequestParams,
) => Promise<ApprovalDecision> | ApprovalDecision

/** Turns an unknown thrown value into a message a user can read. */
export function errorText(error: unknown): string {
  if (error instanceof JsonRpcFault) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Normalize whatever the user typed in the toolbar into a socket URL.
 *
 * `ws://host:port` is the documented form, so a bare origin grows the `/ws`
 * path and the token query. An explicit path is preserved.
 */
export function socketUrl(rawUrl: string, token: string): string {
  const trimmed = rawUrl.trim()
  const base = trimmed.length === 0 ? 'ws://127.0.0.1:43219' : trimmed
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`invalid server url: ${rawUrl}`)
  }
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`server url must be ws:// or wss://: ${rawUrl}`)
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws'
  const trimmedToken = token.trim()
  if (trimmedToken.length > 0) url.searchParams.set('token', trimmedToken)
  else url.searchParams.delete('token')
  return url.toString()
}

class SocketTransport implements Transport {
  readonly #socket: WebSocket
  readonly #messageHandlers = new Set<(text: string) => void>()
  readonly #closeHandlers = new Set<() => void>()
  #closed = false

  constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      if (this.#closed || typeof event.data !== 'string') return
      for (const handler of [...this.#messageHandlers]) handler(event.data)
    })
    socket.addEventListener('close', () => this.#shutdown())
    socket.addEventListener('error', () => this.#shutdown())
  }

  send(text: string): void {
    if (this.#closed) throw new Error('websocket is closed')
    if (this.#socket.readyState !== WebSocket.OPEN) throw new Error('websocket is not open')
    this.#socket.send(text)
  }

  onMessage(handler: (text: string) => void): () => void {
    if (this.#closed) return () => {}
    this.#messageHandlers.add(handler)
    return () => {
      this.#messageHandlers.delete(handler)
    }
  }

  onClose(handler: () => void): () => void {
    if (this.#closed) return () => {}
    this.#closeHandlers.add(handler)
    return () => {
      this.#closeHandlers.delete(handler)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#socket.close()
    this.#messageHandlers.clear()
    this.#closeHandlers.clear()
  }

  #shutdown(): void {
    if (this.#closed) return
    this.#closed = true
    this.#messageHandlers.clear()
    const handlers = [...this.#closeHandlers]
    this.#closeHandlers.clear()
    for (const handler of handlers) handler()
  }
}

/** Open a socket and wait for it, rejecting on error or an early close. */
function openSocket(url: string, token: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl(url, token))
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    const onOpen = (): void => {
      cleanup()
      resolve(socket)
    }
    const onError = (): void => {
      cleanup()
      reject(new Error(`cannot connect to ${socket.url}`))
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error(`connection closed before it opened: ${socket.url}`))
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}

/**
 * A connected canvas client.
 *
 * Requests never time out: `run.start` stays open for as long as the run does,
 * and an approval request may wait for a human indefinitely.
 */
export class CanvasClient {
  readonly #transport: SocketTransport
  readonly #peer: JsonRpcPeer
  #approvalHandler: ApprovalHandler | undefined

  private constructor(socket: WebSocket) {
    this.#transport = new SocketTransport(socket)
    this.#peer = new JsonRpcPeer(this.#transport, { requestTimeoutMs: 0 })
    this.#peer.onRequest('approval/request', async (params) => {
      const handler = this.#approvalHandler
      const decision = handler === undefined ? 'rejected' : await handler(params)
      return { decision }
    })
  }

  /** Connect to a server origin or full socket URL. */
  static async connect(url: string, token: string): Promise<CanvasClient> {
    const socket = await openSocket(url, token)
    return new CanvasClient(socket)
  }

  initialize(clientName = 'z1-canvas'): Promise<InitializeResult> {
    return this.#peer.request('initialize', { clientName, protocolVersion: '1' })
  }

  nodeList(): Promise<NodeDescriptor[]> {
    return this.#peer.request('node.list', {})
  }

  graphValidate(graph: unknown): Promise<GraphValidateResult> {
    return this.#peer.request('graph.validate', { graph })
  }

  runStart(params: RunStartParams): Promise<RunReply> {
    return this.#peer.request('run.start', params)
  }

  runResume(params: RunResumeParams): Promise<RunReply> {
    return this.#peer.request('run.resume', params)
  }

  runGet(runId: string, afterSeq?: number): Promise<RunGetResult> {
    return this.#peer.request(
      'run.get',
      afterSeq === undefined ? { runId } : { runId, afterSeq },
    )
  }

  runList(): Promise<RunListResult> {
    return this.#peer.request('run.list', {})
  }

  runSubscribe(runId: string, afterSeq?: number): Promise<RunSubscribeResult> {
    return this.#peer.request(
      'run.subscribe',
      afterSeq === undefined ? { runId } : { runId, afterSeq },
    )
  }

  runFork(runId: string, fork: { atSeq?: number; nodePath?: string }): Promise<RunForkResult> {
    return this.#peer.request('run.fork', { runId, ...fork })
  }

  runCancel(runId: string): Promise<Record<string, never>> {
    return this.#peer.request('run.cancel', { runId })
  }

  approvalRespond(
    approvalId: string,
    decision: Extract<ApprovalDecision, 'allowed-once' | 'rejected'>,
  ): Promise<Record<string, never>> {
    return this.#peer.request('approval.respond', { approvalId, decision })
  }

  artifactGet(hash: string): Promise<ArtifactGetResult> {
    return this.#peer.request('artifact.get', { hash })
  }

  moduleList(): Promise<ModuleListResult> {
    return this.#peer.request('module.list', {})
  }

  modulePropose(directory: string): Promise<ProposalSummary> {
    return this.#peer.request('module.propose', { directory })
  }

  moduleApprove(
    moduleId: string,
    version: string,
    futureVersions?: boolean,
  ): Promise<ModuleSummary> {
    return this.#peer.request(
      'module.approve',
      futureVersions === undefined ? { moduleId, version } : { moduleId, version, futureVersions },
    )
  }

  moduleRollback(moduleId: string): Promise<ModuleSummary> {
    return this.#peer.request('module.rollback', { moduleId })
  }

  moduleAudit(): Promise<ModuleAuditResult> {
    return this.#peer.request('module.audit', {})
  }

  /** Answer server approval requests. The last registered handler wins. */
  onApprovalRequest(handler: ApprovalHandler): () => void {
    this.#approvalHandler = handler
    return () => {
      if (this.#approvalHandler === handler) this.#approvalHandler = undefined
    }
  }

  onRunEvent(handler: (notification: RunEventNotification) => void): () => void {
    return this.#peer.onNotification('run.event', handler)
  }

  onRunStatus(handler: (notification: RunStatusNotification) => void): () => void {
    return this.#peer.onNotification('run.status', handler)
  }

  onClose(handler: () => void): () => void {
    return this.#transport.onClose(handler)
  }

  close(): void {
    this.#peer.close()
  }
}

/** Convenience wrapper for `CanvasClient.connect`. */
export function connect(url: string, token: string): Promise<CanvasClient> {
  return CanvasClient.connect(url, token)
}

export type { RunEventNotification, RunStatusNotification, RunStatus }
