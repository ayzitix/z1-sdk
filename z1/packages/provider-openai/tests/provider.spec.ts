import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ChatDelta, ChatMessage, ChatRequest, ToolSchema } from '@z1/node'
import { createOpenAiLlmService } from '../src/index.ts'

type Scenario =
  | 'stream'
  | 'tools'
  | 'json'
  | 'fail'
  | 'error-chunk'
  | 'bad-args'
  | 'empty-args'
  | 'no-id'
  | 'bare-cr'
  | 'no-done'
  | 'no-completion'
  | 'truncated-event'
  | 'cut-mid-event'
  | 'done-padded'
  | 'done-padded-tail'

interface Failure {
  status: number
  retryAfter?: string
  body?: string
}

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
let failures: Failure[] = []

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
  const failure = failures.shift()
  if (failure !== undefined) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (failure.retryAfter !== undefined) headers['retry-after'] = failure.retryAfter
    res.writeHead(failure.status, headers)
    res.end(failure.body ?? JSON.stringify({ error: { message: 'transient upstream' } }))
    return
  }

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
    case 'error-chunk':
      // A 200 SSE stream may still announce an upstream failure mid-stream.
      sse(res, [
        { error: { message: 'upstream stream broke', type: 'server_error', code: 'overloaded' } },
      ])
      return
    case 'bad-args':
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_bad', function: { name: 'lookup', arguments: '{"q": "unterminated' } },
                ],
                finish_reason: 'tool_calls',
              },
            },
          ],
        },
      ])
      return
    case 'empty-args':
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_empty', function: { name: 'lookup' } }],
                finish_reason: 'tool_calls',
              },
            },
          ],
        },
      ])
      return
    case 'no-id':
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{}' } }],
                finish_reason: 'tool_calls',
              },
            },
          ],
        },
      ])
      return
    case 'usage-null':
      // With `stream_options.include_usage` OpenAI puts `"usage": null` on
      // every chunk but the closing one. A null means "not yet", not a crash.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const event of [
        { choices: [{ delta: { role: 'assistant', content: 'Hel' } }], usage: null },
        { choices: [{ delta: { content: 'lo' } }], usage: null },
        { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }], usage: null },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 5 } },
      ]) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    case 'bare-cr':
      // A bare CR is a legal event-stream terminator, so the framing must not
      // depend on LF being present.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { choices: [{ delta: { role: 'assistant', content: 'cr' } }] },
        { choices: [{ delta: { content: ' framed' }, finish_reason: 'stop' }] },
      ]) {
        res.write(`data: ${JSON.stringify(event)}\r\r`)
      }
      res.write('data: [DONE]\r\r')
      res.end()
      return
    case 'no-done':
      // A closing [DONE] is the provider's own marker; `finish_reason` already
      // says the model finished.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }] })}\n\n`)
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      )
      res.end()
      return
    case 'no-completion':
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'cut' } }] })}\n\n`)
      res.end()
      return
    case 'truncated-event':
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`)
      // An event whose JSON stops mid-object, followed by a blank line.
      res.write('data: {"choices":[{"delta":{"content":"b"\n\n')
      res.end()
      return
    case 'cut-mid-event':
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`)
      // The connection dies inside an event: no terminator ever arrives.
      res.write('data: {"choices":[{"delta"')
      res.end()
      return
    case 'done-padded':
      // A server may pad the terminator; the padding is not part of the payload.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'pad' }, finish_reason: 'stop' }] })}\n\n`,
      )
      res.write('data: [DONE] \t\n\n')
      res.end()
      return
    case 'done-padded-tail':
      // The same padding on a terminator that never got its newline.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' }, finish_reason: 'stop' }] })}\n\n`,
      )
      res.write('data: [DONE]  ')
      res.end()
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
  failures = []
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
    // A streamed turn asks for the closing usage chunk, or `usage` is lost.
    expect(body['stream_options']).toEqual({ include_usage: true })
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

  test('treats a null usage chunk as "not yet" and keeps the closing one', async () => {
    scenario = 'usage-null'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })
    const deltas: ChatDelta[] = []

    const result = await service.chat(request(), (delta) => deltas.push(delta))

    expect(deltas.filter((delta) => delta.type === 'text')).toHaveLength(3)
    expect(result.message.content).toBe('Hello world')
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

  test('rejects when a streamed chunk carries an error object', async () => {
    scenario = 'error-chunk'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    await expect(service.chat(request())).rejects.toThrow(/upstream stream broke/)
    await expect(service.chat(request())).rejects.toThrow(/server_error/)
  })

  test('accepts a stream framed with bare CR line endings', async () => {
    scenario = 'bare-cr'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    const result = await service.chat(request())

    expect(result.message.content).toBe('cr framed')
    expect(result.stopReason).toBe('stop')
  })

  test('accepts a stream that ends without [DONE] once finish_reason arrived', async () => {
    scenario = 'no-done'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    const result = await service.chat(request())

    expect(result.message.content).toBe('half')
    expect(result.stopReason).toBe('stop')
  })

  test('rejects a stream that ends before completion', async () => {
    scenario = 'no-completion'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    await expect(service.chat(request())).rejects.toThrow(/ended before completion/)
  })

  test('accepts a [DONE] terminator padded with trailing whitespace', async () => {
    scenario = 'done-padded'
    const first = await createOpenAiLlmService({ baseURL, apiKey: API_KEY }).chat(request())
    expect(first.message.content).toBe('pad')
    expect(first.stopReason).toBe('stop')

    // The same padding on a terminator that never got its newline.
    scenario = 'done-padded-tail'
    const second = await createOpenAiLlmService({ baseURL, apiKey: API_KEY }).chat(request())
    expect(second.message.content).toBe('tail')
  })

  test('rejects an event whose JSON is truncated instead of dropping it', async () => {
    scenario = 'truncated-event'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    await expect(service.chat(request())).rejects.toThrow(/not JSON/)
  })

  test('rejects a stream that stops in the middle of an event', async () => {
    scenario = 'cut-mid-event'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    await expect(service.chat(request())).rejects.toThrow(/ended mid-event/)
  })

  test('throws naming the tool when streamed arguments are malformed JSON', async () => {
    scenario = 'bad-args'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    await expect(service.chat(request())).rejects.toThrow(/tool call "lookup"/)
    await expect(service.chat(request())).rejects.toThrow(/malformed JSON/)
  })

  test('keeps empty tool arguments as an empty object', async () => {
    scenario = 'empty-args'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    const result = await service.chat(request())

    expect(result.toolCalls).toEqual([{ id: 'call_empty', name: 'lookup', arguments: {} }])
  })

  test('synthetic tool-call ids are unique across chat calls', async () => {
    scenario = 'no-id'
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY })

    const first = await service.chat(request())
    const second = await service.chat(request())

    const firstId = first.toolCalls[0]?.id ?? ''
    const secondId = second.toolCalls[0]?.id ?? ''
    expect(firstId).toMatch(/^call_\d+_0$/)
    expect(secondId).toMatch(/^call_\d+_0$/)
    expect(firstId).not.toBe(secondId)
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
    expect(captured[0]?.body['stream_options']).toBeUndefined()
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
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY, retry: { attempts: 1 } })

    await expect(service.chat(request())).rejects.toThrow(/500/)
    await expect(service.chat(request())).rejects.toThrow(/upstream exploded/)
  })
})

describe('OpenAiLlmService retry', () => {
  test('retries a 429 honouring retry-after and succeeds', async () => {
    failures = [
      { status: 429, retryAfter: '0', body: '{"error":{"message":"Account request rate limit exceeded"}}' },
      { status: 429, retryAfter: '0' },
    ]
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY, retry: { baseDelayMs: 1 } })

    const result = await service.chat(request())

    expect(result.message.content).toBe('Hello world')
    expect(captured).toHaveLength(3)
  })

  test('retries a 500 and then succeeds', async () => {
    failures = [{ status: 500 }]
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY, retry: { baseDelayMs: 1 } })

    const result = await service.chat(request())

    expect(result.stopReason).toBe('stop')
    expect(captured).toHaveLength(2)
  })

  test('retries a network failure and then succeeds', async () => {
    let calls = 0
    const service = createOpenAiLlmService({
      baseURL,
      apiKey: API_KEY,
      retry: { baseDelayMs: 1 },
      fetch: async (input, init) => {
        calls += 1
        if (calls < 3) throw new TypeError('fetch failed')
        return await fetch(input, init)
      },
    })

    const result = await service.chat(request())

    expect(result.message.content).toBe('Hello world')
    expect(calls).toBe(3)
    expect(captured).toHaveLength(1)
  })

  test('retries once without stream_options when the server rejects the field', async () => {
    for (const status of [400, 422] as const) {
      captured = []
      failures = [
        {
          status,
          body: '{"error":{"message":"Unrecognized request argument: stream_options"}}',
        },
      ]
      const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY, retry: { attempts: 1 } })

      const result = await service.chat(request())

      expect(captured).toHaveLength(2)
      expect(captured[0]?.body['stream_options']).toEqual({ include_usage: true })
      expect(captured[1]?.body['stream_options']).toBeUndefined()
      expect(result.message.content).toBe('Hello world')
      // The server was never asked for usage, but a compatible one may still
      // send it; this fixture does, and the caller keeps it.
      expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 5 })
    }
  })

  test('does not retry a 400 beyond dropping stream_options', async () => {
    failures = [
      { status: 400, body: '{"error":{"message":"bad request"}}' },
      { status: 400, body: '{"error":{"message":"bad request"}}' },
    ]
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY, retry: { baseDelayMs: 1 } })

    await expect(service.chat(request())).rejects.toThrow(/400.*bad request/s)
    // The first 400 buys exactly one retry without the optional field; the
    // second is the server's real answer and is not retried again.
    expect(captured).toHaveLength(2)
    expect(captured[1]?.body['stream_options']).toBeUndefined()
  })

  test('attempts: 1 disables retry', async () => {
    failures = [{ status: 429 }]
    const service = createOpenAiLlmService({ baseURL, apiKey: API_KEY, retry: { attempts: 1 } })

    await expect(service.chat(request())).rejects.toThrow(/429/)
    expect(captured).toHaveLength(1)
  })

  test('aborting during the backoff stops retrying', async () => {
    failures = [{ status: 429 }, { status: 429 }]
    const controller = new AbortController()
    const service = createOpenAiLlmService({
      baseURL,
      apiKey: API_KEY,
      retry: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
      signal: controller.signal,
    })

    const pending = service.chat(request())
    const settled = pending.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
    )
    while (captured.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()

    await expect(settled).resolves.toBe('AbortError')
    expect(captured).toHaveLength(1)
  })
})
