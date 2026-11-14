import { expect, test } from 'vitest'

import {
  CassetteError,
  createCassetteLlmService,
  formatCassette,
  metaKey,
  parseCassette,
  type CassetteTurn,
} from '../src/index.ts'

const chatTurn: CassetteTurn = {
  version: 1,
  path: 'loop/0/chat',
  provider: 'mock',
  model: 'mock-1',
  attempt: 1,
  requestHash: 'abc',
  request: { model: { provider: 'mock', model: 'mock-1' }, messages: [{ role: 'user', content: 'hi' }] },
  response: {
    message: { role: 'assistant', content: 'hello' },
    toolCalls: [],
    stopReason: 'stop',
  },
}

const metaTurn: CassetteTurn = {
  version: 1,
  kind: 'meta',
  path: 'chat',
  provider: 'openai',
  method: 'GET',
  urlPath: '/models',
  query: { 'api-version': '2024' },
  status: 200,
  ok: true,
  truncated: false,
  body: '{"data":[{"id":"a"}]}',
}

test('a cassette with chat and metadata turns round-trips through JSONL', () => {
  const parsed = parseCassette(formatCassette([chatTurn, metaTurn]))
  expect(parsed).toHaveLength(2)
  expect(parsed[0]).toEqual(chatTurn)
  expect(parsed[1]).toEqual(metaTurn)
})

test('a file written before metadata existed still parses as chat', () => {
  const legacy = JSON.stringify({
    version: 1,
    path: 'loop/0/chat',
    provider: 'mock',
    model: 'mock-1',
    attempt: 1,
    requestHash: 'abc',
    request: chatTurn.request,
    response: chatTurn.response,
  })
  const parsed = parseCassette(`${legacy}\n`)
  expect(parsed[0]?.kind).toBeUndefined()
})

test('meta turns are matched by provider, path and sorted query', () => {
  expect(metaKey('openai', '/models')).toBe(metaKey('openai', '/models', {}))
  expect(metaKey('openai', '/models', { a: '1', b: '2' })).toBe(
    metaKey('openai', '/models', { b: '2', a: '1' }),
  )
  expect(metaKey('openai', '/models', { a: '1' })).not.toBe(metaKey('openai', '/models'))
})

test('replay serves metadata and never falls back on a miss', async () => {
  const service = createCassetteLlmService({ turns: [metaTurn] })

  await expect(
    service.get?.({ provider: 'openai', path: '/models', query: { 'api-version': '2024' } }),
  ).resolves.toEqual({
    status: 200,
    ok: true,
    body: '{"data":[{"id":"a"}]}',
    truncated: false,
  })

  await expect(service.get?.({ provider: 'openai', path: '/models' })).rejects.toThrow(
    /cassette miss for GET \/models on "openai"/,
  )
  await expect(service.get?.({ provider: 'other', path: '/models' })).rejects.toThrow(CassetteError)
})

test('a query value cannot forge another query', () => {
  expect(metaKey('x', '/m', { a: '1&b=2' })).not.toBe(metaKey('x', '/m', { a: '1', b: '2' }))
  expect(metaKey('x', '/m', { a: '=' })).not.toBe(metaKey('x', '/m', { a: '', '=': '' }))
})

test('a cassette with two different answers for one key is rejected', () => {
  const other: CassetteTurn = { ...metaTurn, body: '{"data":[]}' }
  expect(() => createCassetteLlmService({ turns: [metaTurn, other] })).toThrow(
    /two different metadata reads for GET \/models/,
  )
  // The same answer twice is the same recording, not a conflict.
  expect(() => createCassetteLlmService({ turns: [metaTurn, metaTurn] })).not.toThrow()
})

test('a non-string query value is rejected, not silently dropped', () => {
  const line = JSON.stringify({
    version: 1,
    kind: 'meta',
    path: 'p',
    provider: 'x',
    urlPath: '/m',
    query: { page: 2 },
    status: 200,
    body: '',
  })
  expect(() => parseCassette(`${line}\n`)).toThrow(/query\.page must be a string/)
})

test('a missing ok is derived from the status', () => {
  const base = {
    version: 1,
    kind: 'meta',
    path: 'p',
    provider: 'x',
    urlPath: '/m',
    body: '',
  }
  const ok = parseCassette(`${JSON.stringify({ ...base, status: 200 })}\n`)[0]
  const failed = parseCassette(`${JSON.stringify({ ...base, status: 500 })}\n`)[0]
  expect(ok?.kind === 'meta' ? ok.ok : undefined).toBe(true)
  expect(failed?.kind === 'meta' ? failed.ok : undefined).toBe(false)
})

test('an unknown kind is an error, not a chat turn', () => {
  const line = JSON.stringify({ version: 1, kind: 'video', path: 'p', provider: 'x' })
  expect(() => parseCassette(`${line}\n`)).toThrow(/unknown kind "video"/)
})

test('a malformed meta line names itself', () => {
  const broken = JSON.stringify({ version: 1, kind: 'meta', path: 'p', provider: 'x', urlPath: '/m', status: '200', body: '' })
  expect(() => parseCassette(`${broken}\n`)).toThrow(/line 1: "status" must be a number/)
})
