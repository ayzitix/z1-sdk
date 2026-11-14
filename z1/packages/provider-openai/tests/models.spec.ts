/**
 * `GET {baseURL}/models`: discovery is a request, not a catalogue.
 *
 * A provider that does not implement the endpoint must fail with its own status,
 * and a successful list is cached per service instance so a graph with several
 * provider nodes does not turn one lookup into N.
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
let payload: unknown = { object: 'list', data: [] }

beforeEach(async () => {
  captured = []
  status = 200
  payload = { object: 'list', data: [] }
  server = createServer((request, response) => {
    captured.push({
      method: request.method,
      url: request.url ?? '',
      authorization: request.headers.authorization,
    })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
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

test('lists ids from the standard OpenAI shape, tolerating extra fields', async () => {
  payload = {
    object: 'list',
    data: [
      { id: 'gpt-4.1-mini', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'gpt-4.1', name: 'GPT 4.1', object: 'model' },
      { id: 'gpt-4.1-mini', object: 'model' },
      { object: 'model' },
      { id: '' },
      'not-an-object',
    ],
  }

  const models = await service().listModels({ provider: 'openai' })
  expect(models.map((model) => model.id)).toEqual(['gpt-4.1-mini', 'gpt-4.1'])
  expect(models[0]).toEqual({ id: 'gpt-4.1-mini', ownedBy: 'openai', created: 1 })
  expect(models[1]).toEqual({ id: 'gpt-4.1', name: 'GPT 4.1' })

  expect(captured).toEqual([
    { method: 'GET', url: '/v1/models', authorization: 'Bearer sk-test' },
  ])
})

test('an empty list is a valid answer, not an error', async () => {
  payload = { object: 'list', data: [] }
  await expect(service().listModels({ provider: 'openai' })).resolves.toEqual([])
})

test('a provider without the endpoint fails with its status and does not cache', async () => {
  status = 404
  payload = { error: { message: 'unknown endpoint' } }
  const client = service()

  await expect(client.listModels({ provider: 'x' })).rejects.toThrow(
    /model discovery failed .*404/,
  )
  // A failure is not cached: the next caller may hit a provider that recovered.
  status = 200
  payload = { data: [{ id: 'recovered' }] }
  await expect(client.listModels({ provider: 'x' })).resolves.toEqual([{ id: 'recovered' }])
  expect(captured).toHaveLength(2)
})

test('the list is cached per service instance', async () => {
  payload = { data: [{ id: 'a' }, { id: 'b' }] }
  const client = service()

  await client.listModels({ provider: 'x' })
  await client.listModels({ provider: 'x' })
  expect(captured).toHaveLength(1)

  // A different service (another provider, another process) is not affected.
  await service().listModels({ provider: 'x' })
  expect(captured).toHaveLength(2)
})

test('concurrent callers share one request', async () => {
  payload = { data: [{ id: 'a' }] }
  const client = service()

  const [first, second] = await Promise.all([
    client.listModels({ provider: 'x' }),
    client.listModels({ provider: 'x' }),
  ])
  expect(first).toEqual(second)
  expect(captured).toHaveLength(1)
})
