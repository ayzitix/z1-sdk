/**
 * Transport-agnostic JSON-RPC 2.0 peer.
 *
 * The peer owns envelopes, id matching, timeouts and error mapping; it knows
 * nothing about sockets, stdio or the graph engine. A {@link Transport} is just
 * "send a string, receive a string, close", so the same peer runs over a
 * WebSocket in the server, a byte stream in a client, or an in-memory pair in
 * tests.
 *
 * @module @z1/protocol/transport
 */

import {
  APP_ERRORS,
  JSON_RPC_ERRORS,
  type ErrorCode,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MethodMap,
  type NotificationMap,
} from './types.ts'

/**
 * A message channel. Frames are whole JSON texts: framing (newline, WebSocket
 * message, length prefix) belongs to the transport, never to the peer.
 */
export interface Transport {
  send(text: string): void
  onMessage(handler: (text: string) => void): () => void
  onClose?(handler: () => void): () => void
  close(): void
}

export interface PeerOptions {
  /** Default 30_000. `0` disables the timeout (a request may then never settle). */
  requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** A JSON-RPC error that crosses the wire with its own `code` and `data`. */
export class JsonRpcFault extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'JsonRpcFault'
    this.code = code
    this.data = data
  }
}

/** Build a fault for an application error code. */
export function appFault(code: ErrorCode, message: string, data?: unknown): JsonRpcFault {
  return new JsonRpcFault(code, message, data)
}

type RequestHandler = (params: unknown) => unknown
type NotificationHandler = (params: unknown) => void

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * One JSON-RPC endpoint.
 *
 * Outbound requests are matched to responses by id; a response for an unknown id
 * is dropped (it belongs to a request abandoned by timeout). Inbound requests
 * without a handler get `-32601`, handler faults keep their code, and any other
 * handler failure becomes `-32603`.
 */
export class JsonRpcPeer {
  readonly #transport: Transport
  readonly #timeoutMs: number
  readonly #pending = new Map<JsonRpcId, PendingRequest>()
  readonly #requestHandlers = new Map<string, RequestHandler>()
  readonly #notificationHandlers = new Map<string, NotificationHandler>()
  readonly #unsubscribes: Array<() => void> = []
  #nextId = 1
  #closed = false

  constructor(transport: Transport, options: PeerOptions = {}) {
    this.#transport = transport
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#unsubscribes.push(transport.onMessage((text) => this.#onText(text)))
    if (transport.onClose !== undefined) {
      this.#unsubscribes.push(transport.onClose(() => this.close()))
    }
  }

  /** Send a request and await its result; rejects with {@link JsonRpcFault}. */
  request<M extends keyof MethodMap>(
    method: M,
    params: MethodMap[M]['params'],
  ): Promise<MethodMap[M]['result']> {
    if (this.#closed) {
      return Promise.reject(new JsonRpcFault(JSON_RPC_ERRORS.internal, 'JSON-RPC peer closed'))
    }
    const id = this.#nextId++
    const frame: JsonRpcRequest = { jsonrpc: '2.0', id, method: String(method), params }
    return new Promise<MethodMap[M]['result']>((resolve, reject) => {
      const timer =
        this.#timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id)
              reject(
                new JsonRpcFault(JSON_RPC_ERRORS.internal, `request timed out: ${String(method)}`, {
                  method: String(method),
                  timeoutMs: this.#timeoutMs,
                }),
              )
            }, this.#timeoutMs)
          : undefined
      this.#pending.set(id, {
        method: String(method),
        resolve: (result) => { resolve(result as MethodMap[M]['result']) },
        reject,
        timer,
      })
      try {
        this.#send(frame)
      } catch (error) {
        this.#settle(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify<M extends keyof NotificationMap>(method: M, params: NotificationMap[M]): void {
    if (this.#closed) return
    this.#send({ jsonrpc: '2.0', method: String(method), params })
  }

  /**
   * Serve an inbound request. Handlers may be async; a thrown
   * {@link JsonRpcFault} keeps its code, anything else becomes `-32603`.
   * @returns an unsubscribe function.
   */
  onRequest<M extends keyof MethodMap>(
    method: M,
    handler: (
      params: MethodMap[M]['params'],
    ) => Promise<MethodMap[M]['result']> | MethodMap[M]['result'],
  ): () => void {
    if (this.#closed) return () => {}
    const key = String(method)
    const wrapped: RequestHandler = (params) =>
      handler(params as MethodMap[M]['params'])
    this.#requestHandlers.set(key, wrapped)
    return () => {
      if (this.#requestHandlers.get(key) === wrapped) this.#requestHandlers.delete(key)
    }
  }

  /** Receive an inbound notification; unhandled methods are dropped. */
  onNotification<M extends keyof NotificationMap>(
    method: M,
    handler: (params: NotificationMap[M]) => void,
  ): () => void {
    if (this.#closed) return () => {}
    const key = String(method)
    const wrapped: NotificationHandler = (params) =>
      handler(params as NotificationMap[M])
    this.#notificationHandlers.set(key, wrapped)
    return () => {
      if (this.#notificationHandlers.get(key) === wrapped) this.#notificationHandlers.delete(key)
    }
  }

  /**
   * Close the peer: reject every pending request, drop handlers and detach from
   * the transport. Idempotent; later outbound calls fail fast.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#failPending(new JsonRpcFault(JSON_RPC_ERRORS.internal, 'JSON-RPC peer closed'))
    this.#requestHandlers.clear()
    this.#notificationHandlers.clear()
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe()
    this.#transport.close()
  }

  #send(frame: unknown): void {
    this.#transport.send(JSON.stringify(frame))
  }

  #onText(text: string): void {
    if (this.#closed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Per the spec a parse failure has no id, so a `null`-id error frame is the
      // only possible reply; peers must tolerate it arriving unsolicited.
      this.#sendError(null, JSON_RPC_ERRORS.parse, 'parse error: invalid JSON')
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#sendError(null, JSON_RPC_ERRORS.invalidRequest, 'invalid request: not an object')
      return
    }
    const frame = parsed as Record<string, unknown>
    const id = frame['id']
    if (frame['jsonrpc'] !== '2.0') {
      if (isId(id)) this.#sendError(id, JSON_RPC_ERRORS.invalidRequest, 'invalid request: jsonrpc must be "2.0"')
      return
    }
    const method = frame['method']
    if (typeof method === 'string') {
      if (isId(id)) {
        void this.#handleRequest(id, method, frame['params'])
      } else {
        this.#handleNotification(method, frame['params'])
      }
      return
    }
    // A frame with an id but no method is a response (or a malformed request).
    this.#handleResponse(frame)
  }

  async #handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#requestHandlers.get(method)
    if (handler === undefined) {
      this.#sendError(id, JSON_RPC_ERRORS.methodNotFound, `method not found: ${method}`)
      return
    }
    let result: unknown
    try {
      result = await handler(params)
    } catch (error) {
      if (this.#closed) return
      if (error instanceof JsonRpcFault) {
        this.#sendError(id, error.code, error.message, error.data)
      } else {
        this.#sendError(
          id,
          JSON_RPC_ERRORS.internal,
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }
    if (this.#closed) return
    const frame: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      // `undefined` would be dropped by JSON.stringify and produce a result-less frame.
      result: result === undefined ? null : result,
    }
    this.#send(frame)
  }

  #handleNotification(method: string, params: unknown): void {
    const handler = this.#notificationHandlers.get(method)
    if (handler === undefined) return
    try {
      handler(params)
    } catch {
      // A notification has no reply channel; a bad handler must not kill the peer.
    }
  }

  #handleResponse(frame: Record<string, unknown>): void {
    const id = frame['id']
    if (!isId(id)) return
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#settle(id)
    const error = frame['error']
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const body = error as Record<string, unknown>
      const code = body['code']
      const message = body['message']
      pending.reject(
        new JsonRpcFault(
          typeof code === 'number' ? code : JSON_RPC_ERRORS.internal,
          typeof message === 'string' ? message : 'JSON-RPC error',
          body['data'],
        ),
      )
      return
    }
    if (!('result' in frame)) {
      pending.reject(new JsonRpcFault(JSON_RPC_ERRORS.internal, 'response has no result'))
      return
    }
    pending.resolve(frame['result'])
  }

  /** Remove a pending entry and stop its timer. */
  #settle(id: JsonRpcId): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
  }

  #failPending(error: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const waiter of pending) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  #sendError(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    if (this.#closed) return
    const error: JsonRpcError = data === undefined ? { code, message } : { code, message, data }
    const frame: JsonRpcResponse = { jsonrpc: '2.0', id, error }
    this.#send(frame)
  }
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number'
}

/** Fault helper for a malformed payload; `code` is always `-32602`. */
export function invalidParams(message: string, data?: unknown): JsonRpcFault {
  return new JsonRpcFault(JSON_RPC_ERRORS.invalidParams, message, data)
}

/** Fault helper for an unknown run, so servers and tests agree on the code. */
export function runNotFound(runId: string): JsonRpcFault {
  return new JsonRpcFault(APP_ERRORS.runNotFound, `run not found: ${runId}`, { runId })
}

/** Fault helper for an unknown persisted graph; the sibling of {@link runNotFound}. */
export function graphNotFound(id: string): JsonRpcFault {
  return new JsonRpcFault(APP_ERRORS.graphNotFound, `graph not found: ${id}`, { id })
}

/**
 * In-memory {@link Transport} pair for tests and in-process servers. Delivery is
 * queued on the microtask queue, so `send` never re-enters the peer that is
 * handling a frame. Closing either endpoint closes both, like a socket.
 */
export function createMemoryTransportPair(): [Transport, Transport] {
  const left = new MemoryTransport()
  const right = new MemoryTransport()
  left.connect(right)
  right.connect(left)
  return [left, right]
}

class MemoryTransport implements Transport {
  #peer: MemoryTransport | undefined
  readonly #messageHandlers = new Set<(text: string) => void>()
  readonly #closeHandlers = new Set<() => void>()
  #closed = false

  connect(peer: MemoryTransport): void {
    this.#peer = peer
  }

  send(text: string): void {
    if (this.#closed) return
    const target = this.#peer
    if (target === undefined) throw new Error('memory transport is not connected')
    queueMicrotask(() => {
      if (target.#closed) return
      for (const handler of [...target.#messageHandlers]) handler(text)
    })
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
    const peer = this.#peer
    this.#shutdown()
    // Closing one side of a socket closes the other; do the same here so a
    // test cannot accidentally leave a half-live pair behind.
    if (peer !== undefined) peer.#shutdown()
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
