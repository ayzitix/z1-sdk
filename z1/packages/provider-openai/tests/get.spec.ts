/**
 * `LlmService.get`: an authenticated GET with the host's credential.
 *
 * The SDK knows a base URL and a key, nothing about a provider's catalog path or
 * response shape. These tests pin that boundary: the path and query are passed
 * through, the host part cannot be redirected, and a non-2xx answer is returned
 * rather than thrown so the caller can explain it.
 */

import { createServer } from 'node:http'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createOpenAiLlmService } from '../src/index.ts'

interface Captured {
  method: string | undefined
  url: string
  authorization: string | undefined
}

let server: ReturnType<typeof createServer>
let baseURL = ''
let captured: Captured[] = []
let status = 200
let body = '{"data":[]}'

beforeEach(async () => {
  captured = []
  status = 200
  body = '{"data":[]}'
  server = createServer((request, response) => {
    captured.push({
      method: request.method,
      url: request.url ?? '',
      authorization: request.headers.authorization,
    })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  baseURL = `http://127.0.0.1:${address.port}/v1`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

function service() {
  return createOpenAiLlmService({ baseURL, apiKey: 'sk-test' })
}

test('a path is appended to the configured base URL with the key', async () => {
  body = '{"data":[{"id":"a"}]}'
  const response = await service().get({ provider: 'openai', path: '/models' })

  expect(response).toEqual({ status: 200, ok: true, body: '{"data":[{"id":"a"}]}', truncated: false })
  expect(captured).toEqual([
    { method: 'GET', url: '/v1/models', authorization: 'Bearer sk-test' },
  ])
})

test('query values are encoded separately from the path', async () => {
  await service().get({
    provider: 'azure',
    path: '/openai/models',
    query: { 'api-version': '2024-10-21', filter: 'a b' },
  })
  expect(captured[0]?.url).toBe('/v1/openai/models?api-version=2024-10-21&filter=a+b')
})

test('a non-2xx answer is returned, not thrown, so the caller can explain it', async () => {
  status = 404
  body = '{"error":{"message":"no such endpoint"}}'
  const response = await service().get({ provider: 'x', path: '/models' })
  expect(response.status).toBe(404)
  expect(response.ok).toBe(false)
  expect(response.body).toContain('no such endpoint')
})

test('the caller cannot leave the configured base URL', async () => {
  await expect(
    service().get({ provider: 'x', path: 'https://evil.test/v1/models' }),
  ).rejects.toThrow(/must start with a single/)
  await expect(service().get({ provider: 'x', path: '//evil.test/models' })).rejects.toThrow(
    /must start with a single/,
  )
  await expect(service().get({ provider: 'x', path: '/../admin' })).rejects.toThrow(
    /must not contain/,
  )
  expect(captured).toEqual([], 'a rejected path must never reach the network')
})

test('a slow provider is retried once before the answer is returned', async () => {
  // The retry policy applies to metadata reads too: a 429 on /models is common.
  let calls = 0
  const flaky = createServer((request, response) => {
    calls += 1
    if (calls === 1) {
      response.writeHead(429, { 'retry-after': '0' })
      response.end('{"error":"slow down"}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"data":[{"id":"ok"}]}')
  })
  await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve))
  try {
    const address = flaky.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const client = createOpenAiLlmService({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'sk-test',
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const response = await client.get({ provider: 'x', path: '/models' })
    expect(response.status).toBe(200)
    expect(response.body).toContain('"ok"')
    expect(calls).toBe(2)
  } finally {
    await new Promise<void>((resolve) => flaky.close(() => resolve()))
  }
})
