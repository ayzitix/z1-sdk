import { describe, expect, test } from 'vitest'

import {
  JSON_RPC_ERRORS,
  JsonRpcFault,
  JsonRpcPeer,
  assertEnum,
  assertOptionalNumber,
  assertParams,
  createMemoryTransportPair,
} from '../src/index.ts'

describe('assertParams', () => {
  test('accepts an object with every required key', () => {
    const params: unknown = { graph: { schemaVersion: 1 } }
    assertParams(params, ['graph'])
    expect(params).toHaveProperty('graph')
  })

  test('rejects a non-object payload with -32602', () => {
    try {
      assertParams('nope', [])
      throw new Error('expected a fault')
    } catch (error) {
      if (!(error instanceof JsonRpcFault)) throw new Error('expected a fault')
      expect(error.code).toBe(JSON_RPC_ERRORS.invalidParams)
    }
  })

  test('rejects a malformed run.start before it reaches the engine', async () => {
    const [a, b] = createMemoryTransportPair()
    const client = new JsonRpcPeer(a)
    const server = new JsonRpcPeer(b)
    let executed = 0
    server.onRequest('run.start', (params) => {
      assertParams(params, ['graph'])
      executed += 1
      return { runId: 'r1', status: 'completed', outputs: {} }
    })

    const error = await client.request('run.start', { graph: undefined }).catch((caught: unknown) => caught)
    if (!(error instanceof JsonRpcFault)) throw new Error('expected a fault')
    expect(error.code).toBe(JSON_RPC_ERRORS.invalidParams)
    expect(executed).toBe(0)
    client.close()
  })

  test('assertEnum and assertOptionalNumber enforce the documented shapes', () => {
    expect(assertEnum('ask', ['auto', 'ask', 'deny'], 'approvalMode')).toBe('ask')
    expect(assertOptionalNumber(undefined, 'afterSeq')).toBeUndefined()
    expect(assertOptionalNumber(7, 'afterSeq')).toBe(7)
    expect(() => assertEnum('sometimes', ['auto', 'ask', 'deny'], 'approvalMode')).toThrow(JsonRpcFault)
    expect(() => assertOptionalNumber(Number.NaN, 'afterSeq')).toThrow(JsonRpcFault)
  })
})
