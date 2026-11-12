/**
 * `Transport` over one WebSocket.
 *
 * The peer above it owns JSON-RPC framing; this adapter only moves whole text
 * frames and forwards close, so the same peer could serve a stdio client.
 *
 * @module @z1/server/socket-transport
 */

import type { Transport } from '@z1/protocol'
import type { RawData, WebSocket } from 'ws'

/** WebSocket frames arrive as Buffer, ArrayBuffer or a list of Buffers. */
function decode(data: RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

export class SocketTransport implements Transport {
  readonly #socket: WebSocket
  readonly #messageHandlers = new Set<(text: string) => void>()
  readonly #closeHandlers = new Set<() => void>()
  #closed = false

  constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on('message', (data: RawData) => {
      if (this.#closed) return
      const text = decode(data)
      for (const handler of [...this.#messageHandlers]) handler(text)
    })
    // Without a listener a socket error is an uncaught exception that would take
    // down every other connection with it.
    socket.on('error', () => this.#shutdown())
    socket.on('close', () => this.#shutdown())
  }

  send(text: string): void {
    if (this.#closed) return
    if (this.#socket.readyState !== this.#socket.OPEN) return
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
    const wasOpen = !this.#closed
    this.#shutdown()
    if (wasOpen) this.#socket.close()
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
