import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import type { GraphDocument } from '@z1/graph'
import type { NodeDefinition } from '@z1/node'
import { NodeRegistry } from '@z1/node'
import { runGraph } from '@z1/runtime'
import type {
  ApprovalService,
  ArtifactService,
  FsService,
  LlmService,
  ToolService,
} from '@z1/runtime'
import {
  ModuleWorker,
  moduleNodeDefinition,
  type WorkerHostOptions,
  type WorkerHostServices,
  type WorkerLogEvent,
  type WorkerStreamEvent,
} from '../src/index.ts'

const MODULE_DIR = fileURLToPath(new URL('./fixtures/echo', import.meta.url))

const NODE_IDS = [
  'com.example.echo.echo',
  'com.example.echo.reader',
  'com.example.echo.crasher',
  'com.example.echo.sleeper',
  'com.example.echo.llmer',
  'com.example.echo.modeller',
  'com.example.echo.denied',
  'com.example.echo.fetcher',
  'com.example.echo.subgrapher',
]

const echoId = 'com.example.echo.echo'

const workers: ModuleWorker[] = []

interface Probes {
  logs: WorkerLogEvent[]
  streams: WorkerStreamEvent[]
}

function createServices(probes: Probes): WorkerHostServices {
  const fs: FsService = {
    read: (path) => readFile(path, 'utf8'),
    write: async () => {
      throw new Error('fs.write is not stubbed in this test')
    },
  }
  const tools: ToolService = {
    call: async (name) => {
      throw new Error(`unexpected tool call "${name}"`)
    },
    list: async () => [],
  }
  const llm: LlmService = {
    get: async (request) => ({
      status: 200,
      ok: true,
      body: `{"data":[{"id":"${request.provider}-one"}]}`,
      truncated: false,
    }),
    chat: async (_request, onDelta) => {
      onDelta?.({ type: 'text', text: 'po' })
      return {
        message: { role: 'assistant', content: 'pong' },
        toolCalls: [],
        stopReason: 'stop',
      }
    },
  }
  const approval: ApprovalService = {
    request: async () => 'allowed-once',
  }
  return {
    llm,
    tools,
    fs,
    approval,
    onLog: (event) => probes.logs.push(event),
    onStream: (event) => probes.streams.push(event),
  }
}

function createWorker(
  probes: Probes,
  overrides: Partial<WorkerHostOptions> = {},
): ModuleWorker {
  const worker = new ModuleWorker({
    moduleDir: MODULE_DIR,
    entry: 'index.js',
    manifestNodeIds: NODE_IDS,
    capabilities: {
      fs: { read: ['${moduleDir}/**'] },
      net: { hosts: ['127.0.0.1'] },
    },
    services: createServices(probes),
    ...overrides,
  })
  workers.push(worker)
  return worker
}

function freshProbes(): Probes {
  return { logs: [], streams: [] }
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    await worker.dispose().catch(() => undefined)
  }
})

test('start reports descriptors and echo streams plus logs', async () => {
  const probes = freshProbes()
  const worker = createWorker(probes)
  const nodes = await worker.start()

  expect(nodes.map((node) => node.id).sort()).toEqual([...NODE_IDS].sort())
  const echo = nodes.find((node) => node.id === echoId)
  expect(echo?.version).toBe('1.0.0')
  expect(echo?.inputs).toHaveLength(1)
  expect(echo?.outputs).toHaveLength(2)

  const outputs = await worker.execute(echoId, {}, { text: 'hello' }, null)

  expect(outputs).toEqual({ text: 'hello', out: true })
  expect(probes.streams).toEqual([{ nodeId: echoId, port: 'text', chunk: 'partial' }])
  expect(probes.logs.some((line) => line.message === 'echo started')).toBe(true)
}, 20_000)

test('fs.read inside moduleDir is allowed, outside is denied', async () => {
  const probes = freshProbes()
  const worker = createWorker(probes)
  await worker.start()

  const allowed = await worker.execute(
    'com.example.echo.reader',
    {},
    { path: `${MODULE_DIR}/index.js` },
    null,
  )
  expect(allowed['text']).toContain('export const nodes')

  await expect(
    worker.execute('com.example.echo.denied', {}, {}, null),
  ).rejects.toThrow(/capability denied for fs\.read/)

  const audit = probes.logs.filter((line) => line.level === 'warn')
  expect(audit.some((line) => line.message.includes('/etc/passwd'))).toBe(true)
}, 20_000)

test('net requests are denied unless the host is declared', async () => {
  const probes = freshProbes()
  const worker = createWorker(probes)
  await worker.start()

  await expect(
    worker.execute('com.example.echo.fetcher', {}, { url: 'http://example.com/' }, null),
  ).rejects.toThrow(/capability denied for net\.request/)

  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('hello net')
  })
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no server address')
    const url = `http://127.0.0.1:${address.port}/`
    const outputs = await worker.execute('com.example.echo.fetcher', {}, { url }, null)
    expect(outputs).toEqual({ status: 200, body: 'hello net' })
  } finally {
    await new Promise<void>((settle) => server.close(() => settle()))
  }
}, 20_000)

test('a redirect to a host outside the allowlist is denied', async () => {
  const probes = freshProbes()
  // Only `localhost` is granted; the redirect points at 127.0.0.1.
  const worker = createWorker(probes, { capabilities: { net: { hosts: ['localhost'] } } })
  await worker.start()

  let port = 0
  const server: Server = createServer((request, response) => {
    if (request.url === '/redir') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/secret` })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('INTERNAL-ONLY')
  })
  await new Promise<void>((settle) => server.listen(0, settle))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no server address')
    port = address.port

    await expect(
      worker.execute('com.example.echo.fetcher', {}, { url: `http://localhost:${port}/redir` }, null),
    ).rejects.toThrow(/capability denied for net\.request/)
  } finally {
    await new Promise<void>((settle) => server.close(() => settle()))
  }
}, 20_000)

test('a redirect between allowlisted hosts is followed', async () => {
  const probes = freshProbes()
  const worker = createWorker(probes, {
    capabilities: { net: { hosts: ['localhost', '127.0.0.1'] } },
  })
  await worker.start()

  let port = 0
  const server: Server = createServer((request, response) => {
    if (request.url === '/redir') {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/final` })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('final body')
  })
  await new Promise<void>((settle) => server.listen(0, settle))
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no server address')
    port = address.port

    const outputs = await worker.execute(
      'com.example.echo.fetcher',
      {},
      { url: `http://localhost:${port}/redir` },
      null,
    )
    expect(outputs).toEqual({ status: 200, body: 'final body' })
  } finally {
    await new Promise<void>((settle) => server.close(() => settle()))
  }
}, 20_000)

test('llm.get is gated by the same grant as llm.chat', async () => {
  const probes = freshProbes()
  // No `llm` capability at all: discovery must be refused, not forwarded.
  const denied = createWorker(probes, { capabilities: {} })
  await denied.start()
  await expect(
    denied.execute('com.example.echo.modeller', {}, { provider: 'stub' }, null),
  ).rejects.toThrow(/capability "llm" not granted for llm\.get/)

  // A granted provider is listed; another one is still refused.
  const allowed = createWorker(probes, { capabilities: { llm: { providers: ['stub'] } } })
  await allowed.start()
  const outputs = await allowed.execute(
    'com.example.echo.modeller',
    {},
    { provider: 'stub' },
    null,
  )
  expect(outputs).toEqual({ ids: '{"data":[{"id":"stub-one"}]}' })

  await expect(
    allowed.execute('com.example.echo.modeller', {}, { provider: 'other' }, null),
  ).rejects.toThrow(/capability "llm" not granted for llm\.get/)
}, 20_000)

test('llm.chat is forwarded to the host service with deltas', async () => {
  const probes = freshProbes()
  const seen: string[] = []
  const services = createServices(probes)
  const worker = new ModuleWorker({
    moduleDir: MODULE_DIR,
    entry: 'index.js',
    manifestNodeIds: NODE_IDS,
    // Manifest gate: `ctx.llm.chat` needs a declared provider.
    capabilities: { fs: { read: ['${moduleDir}/**'] }, llm: { providers: ['stub'] } },
    services: {
      ...services,
      llm: {
        chat: async (request, onDelta) => {
          const first = request.messages[0]
          seen.push(typeof first?.content === 'string' ? first.content : '')
          onDelta?.({ type: 'text', text: 'po' })
          return {
            message: { role: 'assistant', content: 'pong' },
            toolCalls: [],
            stopReason: 'stop',
          }
        },
      },
    },
  })
  workers.push(worker)
  await worker.start()

  const outputs = await worker.execute('com.example.echo.llmer', {}, { prompt: 'ping' }, null)

  expect(outputs['text']).toBe('pong')
  expect(outputs['deltas']).toEqual([{ type: 'text', text: 'po' }])
  expect(seen).toEqual(['ping'])
}, 20_000)

test('a crash rejects the running node, poisons the worker, and start respawns', async () => {
  const probes = freshProbes()
  const worker = createWorker(probes)
  await worker.start()

  await expect(
    worker.execute('com.example.echo.crasher', {}, {}, null),
  ).rejects.toThrow(/worker exited/)

  await expect(
    worker.execute(echoId, {}, { text: 'after' }, null),
  ).rejects.toThrow(/worker exited/)

  const nodes = await worker.start()
  expect(nodes.some((node) => node.id === echoId)).toBe(true)

  const outputs = await worker.execute(echoId, {}, { text: 'revived' }, null)
  expect(outputs['text']).toBe('revived')
}, 20_000)

test('timeout and abort both stop a sleeping node', async () => {
  const probes = freshProbes()
  const timed = createWorker(probes, { timeoutMs: 300 })
  await timed.start()

  await expect(timed.execute('com.example.echo.sleeper', {}, {}, null)).rejects.toThrow(
    /exceeded its 300ms timeout/,
  )

  const aborted = createWorker(freshProbes())
  await aborted.start()
  const controller = new AbortController()
  const running = aborted.execute('com.example.echo.sleeper', {}, {}, null, controller.signal)
  setTimeout(() => controller.abort(new Error('test abort')), 50)

  await expect(running).rejects.toThrow(/cancelled: .*test abort/)
}, 20_000)

test('an exported node id missing from the manifest rejects start', async () => {
  const worker = createWorker(freshProbes(), { manifestNodeIds: [echoId] })

  await expect(worker.start()).rejects.toThrow(/does not declare/)
  expect(worker.alive).toBe(false)
}, 20_000)

test('subgraph calls fail with a clear M4 error', async () => {
  const worker = createWorker(freshProbes())
  await worker.start()

  await expect(
    worker.execute('com.example.echo.subgrapher', {}, {}, null),
  ).rejects.toThrow(/runSubgraph is not available/)
}, 20_000)

test('moduleNodeDefinition runs through runGraph', async () => {
  const probes = freshProbes()
  const worker = createWorker(probes)
  await worker.start()

  const inputDefinition: NodeDefinition = {
    id: 'z1.core.input',
    version: '1.0.0',
    title: 'Input',
    category: 'core',
    config: z.object({}),
    inputs: [],
    outputs: [{ kind: 'data', id: 'value', schema: z.string() }],
    execute: async (ctx) => ({ value: ctx.input }),
  }
  const outputDefinition: NodeDefinition = {
    id: 'z1.core.output',
    version: '1.0.0',
    title: 'Output',
    category: 'core',
    config: z.object({}),
    inputs: [
      { kind: 'flow', id: 'in' },
      { kind: 'data', id: 'value', schema: z.unknown() },
    ],
    outputs: [],
    execute: async () => ({}),
  }

  const registry = new NodeRegistry()
  registry.register(inputDefinition)
  registry.register(outputDefinition)
  registry.register(
    moduleNodeDefinition(
      {
        id: echoId,
        version: '1.0.0',
        title: 'Echo',
        category: 'example',
        inputs: [{ kind: 'data', id: 'text', schema: { type: 'string' }, required: true }],
        outputs: [
          { kind: 'data', id: 'text', schema: { type: 'string' } },
          { kind: 'flow', id: 'out' },
        ],
      },
      worker,
    ),
  )

  const graph: GraphDocument = {
    schemaVersion: 1,
    id: 'module-integration',
    nodes: [
      { id: 'in', type: 'z1.core.input', version: '1.0.0', config: {}, position: { x: 0, y: 0 } },
      { id: 'echo', type: echoId, version: '1.0.0', config: {}, position: { x: 1, y: 0 } },
      { id: 'out', type: 'z1.core.output', version: '1.0.0', config: {}, position: { x: 2, y: 0 } },
    ],
    edges: [
      {
        id: 'e1',
        kind: 'data',
        from: { node: 'in', port: 'value' },
        to: { node: 'echo', port: 'text' },
      },
      {
        id: 'e2',
        kind: 'data',
        from: { node: 'echo', port: 'text' },
        to: { node: 'out', port: 'value' },
      },
      {
        id: 'e3',
        kind: 'flow',
        from: { node: 'echo', port: 'out' },
        to: { node: 'out', port: 'in' },
      },
    ],
  }

  const artifacts: ArtifactService = {
    put: async () => 'hash',
    get: async () => new Uint8Array(),
  }

  const result = await runGraph({
    graph,
    input: 'hi',
    registry,
    services: {
      llm: createServices(probes).llm,
      tools: createServices(probes).tools,
      fs: createServices(probes).fs,
      approval: createServices(probes).approval,
      artifacts,
      onLog: (entry) => probes.logs.push({ nodeId: entry.nodeId, level: entry.level, message: entry.message, ...(entry.data !== undefined ? { data: entry.data } : {}) }),
      onEvent: (event) => {
        if (event.type === 'node.stream') {
          probes.streams.push({ nodeId: event.nodeId, port: event.port, chunk: event.chunk })
        }
      },
    },
  })

  expect(result.status).toBe('completed')
  expect(result.outputs['output']).toBe('hi')
  expect(probes.streams).toContainEqual({ nodeId: 'echo', port: 'text', chunk: 'partial' })
}, 20_000)

test('dispose is idempotent and prevents further use', async () => {
  const worker = createWorker(freshProbes())
  await worker.start()

  await worker.dispose()
  await worker.dispose()

  await expect(worker.execute(echoId, {}, { text: 'x' }, null)).rejects.toThrow(/disposed/)
}, 20_000)
