import { describe, expect, test } from 'vitest'

import {
  APP_ERRORS,
  JSON_RPC_ERRORS,
  JsonRpcFault,
  JsonRpcPeer,
  createMemoryTransportPair,
  type Transport,
} from '../src/index.ts'

function peers(options?: { requestTimeoutMs?: number }): [JsonRpcPeer, JsonRpcPeer, Transport[]] {
  const [a, b] = createMemoryTransportPair()
  return [
    new JsonRpcPeer(a, options),
    new JsonRpcPeer(b, options),
    [a, b],
  ]
}

describe('memory pair', () => {
  test('round-trips a request and its result', async () => {
    const [client, server] = peers()
    server.onRequest('initialize', (params) => ({
      serverName: 'z1',
      protocolVersion: '1',
      capabilities: { runs: true, approvals: true, modules: false },
    }))

    const result = await client.request('initialize', { clientName: 'test' })
    expect(result.serverName).toBe('z1')
    expect(result.capabilities.modules).toBe(false)
    client.close()
  })

  test('resolves concurrent requests by id, out of order', async () => {
    const [client, server] = peers()
    server.onRequest('run.cancel', async (params) => {
      await new Promise((resolve) => setTimeout(resolve, params.runId === 'slow' ? 20 : 1))
      return {}
    })

    const [first, second] = await Promise.all([
      client.request('run.cancel', { runId: 'slow' }),
      client.request('run.cancel', { runId: 'fast' }),
    ])
    expect(first).toEqual({})
    expect(second).toEqual({})
    client.close()
  })

  test('delivers notifications to the registered handler only', async () => {
    const [client, server] = peers()
    const seen: string[] = []
    server.onNotification('run.status', (params) => seen.push(params.status))
    server.onNotification('run.event', () => seen.push('wrong'))

    client.notify('run.status', { runId: 'r1', status: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(seen).toEqual(['completed'])
    client.close()
  })

  test('preserves a thrown JsonRpcFault code and data', async () => {
    const [client, server] = peers()
    server.onRequest('run.get', () => {
      throw new JsonRpcFault(APP_ERRORS.runNotFound, 'run not found: nope', { runId: 'nope' })
    })

    const error = await client.request('run.get', { runId: 'nope' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(JsonRpcFault)
    if (!(error instanceof JsonRpcFault)) throw new Error('expected a fault')
    expect(error.code).toBe(1001)
    expect(error.message).toBe('run not found: nope')
    expect(error.data).toEqual({ runId: 'nope' })
    client.close()
  })

  test('maps a plain handler error to -32603', async () => {
    const [client, server] = peers()
    server.onRequest('run.list', () => {
      throw new Error('boom')
    })

    const error = await client.request('run.list', {}).catch((caught: unknown) => caught)
    if (!(error instanceof JsonRpcFault)) throw new Error('expected a fault')
    expect(error.code).toBe(JSON_RPC_ERRORS.internal)
    expect(error.message).toBe('boom')
    client.close()
  })

  test('answers an unknown method with -32601', async () => {
    const [client, server] = peers()
    server.onRequest('initialize', () => ({
      serverName: 'z1',
      protocolVersion: '1',
      capabilities: { runs: true, approvals: true, modules: false },
    }))

    const error = await client.request('run.list', {}).catch((caught: unknown) => caught)
    if (!(error instanceof JsonRpcFault)) throw new Error('expected a fault')
    expect(error.code).toBe(JSON_RPC_ERRORS.methodNotFound)
    client.close()
  })

  test('replies -32700 to invalid JSON', async () => {
    const [from, to] = createMemoryTransportPair()
    // A bare peer on the receiving side turns the malformed frame into an error.
    const peer = new JsonRpcPeer(to)
    const frames: string[] = []
    from.onMessage((text) => frames.push(text))
    from.send('{not json')

    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(frames).toHaveLength(1)
    peer.close()
    const frame: unknown = JSON.parse(frames[0] ?? '{}')
    expect(frame).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700 },
    })
    from.close()
  })

  test('times out a request when no response ever arrives', async () => {
    const silent: Transport = {
      send: () => {},
      onMessage: () => () => {},
      close: () => {},
    }
    const peer = new JsonRpcPeer(silent, { requestTimeoutMs: 5 })

    const error = await peer.request('run.list', {}).catch((caught: unknown) => caught)
    if (!(error instanceof JsonRpcFault)) throw new Error('expected a fault')
    expect(error.code).toBe(JSON_RPC_ERRORS.internal)
    expect(error.message).toContain('timed out')
    peer.close()
  })

  test('close rejects every pending request', async () => {
    const silent: Transport = {
      send: () => {},
      onMessage: () => () => {},
      close: () => {},
    }
    const peer = new JsonRpcPeer(silent)
    const pending = peer.request('run.list', {})
    peer.close()

    const error = await pending.catch((caught: unknown) => caught)
    if (!(error instanceof JsonRpcFault)) throw new Error('expected a fault')
    expect(error.message).toContain('closed')
    // A closed peer fails fast instead of queueing more work.
    await expect(peer.request('run.list', {})).rejects.toBeInstanceOf(JsonRpcFault)
  })

  test('closing one endpoint rejects the other side too', async () => {
    const [client, server] = peers()
    const pending = client.request('run.list', {})
    server.close()

    await expect(pending).rejects.toBeInstanceOf(JsonRpcFault)
  })
})
