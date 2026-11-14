import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { graphDigest } from '@z1/graph'
import type { ChatRequest, ChatResult, ModelHandle } from '@z1/node'
import {
  canonicalLlmRequest,
  decodeLlmPayload,
  llmRequestHash,
  runGraph,
  type ApprovalService,
  type LlmService,
  type RecordLlmMode,
} from '@z1/runtime'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createRuntime, loadRuntimeConfig, type Runtime } from '../src/index.ts'

const MODEL: ModelHandle = { provider: 'mock', model: 'mock-1' }

const RESULT: ChatResult = {
  message: { role: 'assistant', content: 'scripted answer' },
  toolCalls: [],
  usage: { inputTokens: 11, outputTokens: 7 },
  stopReason: 'stop',
}

const approval: ApprovalService = { request: async () => 'allowed-once' }

let root: string
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-record-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

async function makeRuntime(mode: RecordLlmMode): Promise<Runtime> {
  const directory = join(root, `${mode}-${randomUUID()}`)
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: directory,
      env: {},
      overrides: {
        dbPath: join(directory, 'runs.db'),
        modulesPath: join(directory, 'modules'),
        recordLlm: mode,
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

interface Recorded {
  readonly runId: string
  readonly events: readonly unknown[]
  readonly requests: readonly ChatRequest[]
}

async function runAgent(runtime: Runtime, model: ModelHandle = MODEL): Promise<Recorded> {
  const requests: ChatRequest[] = []
  const llm: LlmService = {
    chat: async (request) => {
      requests.push(request)
      return RESULT
    },
  }

  const graph = runtime.templates.build('agent.loop', { model })
  const runId = `run_${randomUUID()}`
  const now = Date.now()
  runtime.journal.createRun({
    runId,
    graphId: graph.id,
    graphDigest: graphDigest(graph),
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })

  const handle = await runtime.beginRun({ runId, approval, llm })
  try {
    const result = await runGraph({
      graph,
      registry: handle.registry,
      services: handle.services,
      input: 'hello',
      journal: runtime.journal,
      runId,
    })
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'scripted answer' })
  } finally {
    await handle.dispose()
  }
  runtime.journal.updateRun(runId, { status: 'completed', updatedAt: Date.now() })

  return { runId, events: runtime.journal.read(runId), requests }
}

test('a full recording journals the request and response and resolves both blobs', async () => {
  const runtime = await makeRuntime('full')
  const { runId, events, requests } = await runAgent(runtime)

  const requests_ = events.filter(
    (event): event is Extract<(typeof events)[number], { type: 'llm.request' }> =>
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === 'llm.request',
  )
  const responses = events.filter(
    (event): event is Extract<(typeof events)[number], { type: 'llm.response' }> =>
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === 'llm.response',
  )

  expect(requests_).toHaveLength(1)
  expect(responses).toHaveLength(1)
  const request = requests_[0]
  const response = responses[0]
  expect(request?.runId).toBe(runId)
  expect(request?.path).toBe('loop/0/chat')
  expect(request?.attempt).toBe(1)
  expect(request?.provider).toBe('mock')
  expect(request?.model).toBe('mock-1')

  const sent = requests[0]
  expect(sent).toBeDefined()
  expect(request?.requestHash).toBe(llmRequestHash(sent as ChatRequest))
  expect(request?.requestBlob).toBe(request?.requestHash)

  const requestBlob = runtime.journal.getBlob(request?.requestBlob ?? '')
  expect(requestBlob).toBeDefined()
  expect(decodeLlmPayload(requestBlob?.bytes ?? new Uint8Array())).toEqual(sent)

  expect(response?.responseHash).toBeDefined()
  expect(response?.responseBlob).toBe(response?.responseHash)
  const responseBlob = runtime.journal.getBlob(response?.responseBlob ?? '')
  expect(responseBlob).toBeDefined()
  expect(decodeLlmPayload(responseBlob?.bytes ?? new Uint8Array())).toEqual(RESULT)
  expect(response?.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
  expect(response?.stopReason).toBe('stop')
  expect(response?.latencyMs).toBeGreaterThanOrEqual(0)
})

test('credential-shaped request fields never reach the blob', async () => {
  const runtime = await makeRuntime('full')
  const { events } = await runAgent(runtime, {
    provider: 'mock',
    model: 'mock-1',
    params: {
      authorization: 'Bearer top-secret',
      RIVER_API_KEY: 'sk-live-123',
      temperature: 0,
    },
  })

  const request = events.find(
    (event) => (event as { type?: string }).type === 'llm.request',
  ) as { requestBlob?: string } | undefined
  const blob = runtime.journal.getBlob(request?.requestBlob ?? '')
  expect(blob).toBeDefined()
  const text = new TextDecoder().decode(blob?.bytes)
  expect(text).not.toContain('top-secret')
  expect(text).not.toContain('sk-live-123')
  expect(text).toContain('[redacted]')
  expect(JSON.parse(text)).toMatchObject({ model: { params: { temperature: 0 } } })
  // The hash is over the redacted text, so it stays the cassette's key.
  expect(canonicalLlmRequest(JSON.parse(text) as ChatRequest)).toBe(text)
})

test('redaction covers snake_case, camelCase and header pairs', async () => {
  const runtime = await makeRuntime('full')
  const { events } = await runAgent(runtime, {
    provider: 'mock',
    model: 'mock-1',
    params: {
      access_token: 'leak-1',
      accessToken: 'leak-2',
      apiToken: 'leak-3',
      bearer: 'leak-4',
      client_secret: 'leak-5',
      credentials: 'leak-6',
      headers: [{ name: 'Authorization', value: 'leak-7' }],
      // Not a credential, must survive so the request stays meaningful.
      max_tokens: 512,
      temperature: 0,
    },
  })

  const request = events.find(
    (event) => (event as { type?: string }).type === 'llm.request',
  ) as { requestBlob?: string } | undefined
  const text = new TextDecoder().decode(runtime.journal.getBlob(request?.requestBlob ?? '')?.bytes)
  for (const leak of ['leak-1', 'leak-2', 'leak-3', 'leak-4', 'leak-5', 'leak-6', 'leak-7']) {
    expect(text, leak).not.toContain(leak)
  }
  expect(JSON.parse(text)).toMatchObject({ model: { params: { max_tokens: 512, temperature: 0 } } })
})

test('a failed turn is journaled as llm.failed, not left as a bare request', async () => {
  const runtime = await makeRuntime('full')
  const failing: LlmService = {
    chat: async () => {
      throw new Error('upstream 503')
    },
  }
  const graph = runtime.templates.build('agent.loop', { model: MODEL })
  const runId = `run_${randomUUID()}`
  const now = Date.now()
  runtime.journal.createRun({
    runId,
    graphId: graph.id,
    graphDigest: graphDigest(graph),
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })
  const handle = await runtime.beginRun({ runId, approval, llm: failing })
  try {
    const result = await runGraph({
      graph,
      registry: handle.registry,
      services: handle.services,
      input: 'hello',
      journal: runtime.journal,
      runId,
    })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('upstream 503')
  } finally {
    await handle.dispose()
  }

  const types = runtime.journal
    .read(runId)
    .map((event) => event.type)
    .filter((type) => type.startsWith('llm.'))
  expect(types).toContain('llm.request')
  expect(types).toContain('llm.failed')
  expect(types).not.toContain('llm.response')
})

test('hashes mode journals events without writing payload blobs', async () => {
  const runtime = await makeRuntime('hashes')
  const { events, requests } = await runAgent(runtime)

  const llmEvents = events.filter((event) =>
    String((event as { type?: string }).type).startsWith('llm.'),
  )
  expect(llmEvents).toHaveLength(2)
  for (const event of llmEvents) {
    expect(event).not.toHaveProperty('requestBlob')
    expect(event).not.toHaveProperty('responseBlob')
  }

  const sent = requests[0]
  expect(sent).toBeDefined()
  expect(runtime.journal.getBlob(llmRequestHash(sent as ChatRequest))).toBeUndefined()
})

test('off mode writes neither events nor blobs', async () => {
  const runtime = await makeRuntime('off')
  const { events, requests } = await runAgent(runtime)

  expect(
    events.filter((event) => String((event as { type?: string }).type).startsWith('llm.')),
  ).toEqual([])
  const sent = requests[0]
  expect(sent).toBeDefined()
  expect(runtime.journal.getBlob(llmRequestHash(sent as ChatRequest))).toBeUndefined()
})
