import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ChatDelta, ChatMessage, ChatRequest, ToolSchema } from '@z1/node'
import { createOpenAiLlmService } from '../src/index.ts'

type Scenario = 'stream' | 'tools' | 'json' | 'fail'

interface CapturedRequest {
  method: string | undefined
  url: string
  authorization: string | undefined
  body: Record<string, unknown>
}

const API_KEY = 'test-key-123'

let server: ReturnType<typeof createServer>
let baseURL = ''
let captured: CapturedRequest[] = []
let scenario: Scenario = 'stream'

const tools: ToolSchema[] = [
  {
    name: 'lookup',
    description: 'Look something up',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
]

function sse(res: ServerResponse, events: unknown[], usage?: Record<string, unknown>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  if (usage !== undefined) res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function respond(res: ServerResponse): void {
  switch (scenario) {
    case 'fail':
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('upstream exploded')
      return
    case 'json':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'one shot',
                tool_calls: [{ id: 'call_json', function: { name: 'lookup', arguments: '{"q":"z"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
      )
      return
    case 'tools':
      sse(
        res,
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ],
        { prompt_tokens: 11, completion_tokens: 7 },
      )
      return
    case 'stream':
      sse(
        res,
        [
          { choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' } }] },
          { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
        ],
        { prompt_tokens: 9, completion_tokens: 5 },
      )
  }
}

beforeEach(async () => {
  captured = []
  scenario = 'stream'
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      captured.push({
        method: req.method,
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: JSON.parse(raw) as Record<string, unknown>,
      })
      respond(res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  baseURL = `http://127.0.0.1:${address.port}/v1`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: { provider: 'openai', model: 'gpt-test' },
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  }
}

describe('OpenAiLlmService', () => {
  test('sends auth, mapped messages and tools, and assembles streamed text', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'lookup', arguments: { q: 'y' } }] },
      { role: 'tool', content: 'result', toolCallId: 'call_0' },
    ]
    const deltas: ChatDelta[] = []
    const service = createOpenAiLlmService({
      baseURL: `${baseURL}/`,
      apiKey: API_KEY,
      headers: { 'x-extra': 'yes' },
      fetch: (input, init) => {
        expect(new Headers(init?.headers).get('x-extra')).toBe('yes')
        return fetch(input, init)
      },
    })

    const result = await service.chat(request({ messages, tools, temperature: 0.2, maxTokens: 64 }), (delta) =>
      deltas.push(delta),
    )

    const sent = captured[0]
    expect(sent?.method).toBe('POST')
    expect(sent?.url).toBe('/v1/chat/completions')
    expect(sent?.authorization).toBe(`Bearer ${API_KEY}`)
    const body = sent?.body ?? {}
    expect(body['model']).toBe('gpt-test')
    expect(body['stream']).toBe(true)
    expect(body['temperature']).toBe(0.2)
    expect(body['max_tokens']).toBe(64)
    expect(body['messages']).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'lookup', arguments: '{"q":"y"}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'call_0' },
    ])
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look something up',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ])

    const textDeltas = deltas.filter((delta) => delta.type === 'text')
    expect(textDeltas).toHaveLength(3)
    expect(textDeltas.map((delta) => (delta.type === 'text' ? delta.text : '')).join('')).toBe('Hello world')
    expect(result.message.content).toBe('Hello world')
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('stop')
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 5 })
  })

  test('assembles tool-call deltas into a parsed ToolCall', async () => {
    scenario = 'tools'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })
    const deltas: ChatDelta[] = []

    const result = await service.chat(request(), (delta) => deltas.push(delta))

    const toolDeltas = deltas.filter((delta) => delta.type === 'tool_call')
    expect(toolDeltas).toHaveLength(2)
    expect(toolDeltas[0]).toMatchObject({ index: 0, id: 'call_1', name: 'lookup' })
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }])
    expect(result.message.toolCalls).toEqual(result.toolCalls)
    expect(result.stopReason).toBe('tool_calls')
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
  })

  test('reads a non-streaming JSON response', async () => {
    scenario = 'json'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })
    const deltas: ChatDelta[] = []

    const result = await service.chat(
      request({ model: { provider: 'openai', model: 'gpt-test', params: { stream: false } } }),
      (delta) => deltas.push(delta),
    )

    expect(captured[0]?.body['stream']).toBe(false)
    expect(deltas).toEqual([])
    expect(result.message).toEqual({
      role: 'assistant',
      content: 'one shot',
      toolCalls: [{ id: 'call_json', name: 'lookup', arguments: { q: 'z' } }],
    })
    expect(result.stopReason).toBe('tool_calls')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 })
  })

  test('throws with the status when the endpoint fails', async () => {
    scenario = 'fail'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    await expect(service.chat(request())).rejects.toThrow(/500/)
    await expect(service.chat(request())).rejects.toThrow(/upstream exploded/)
  })
})
