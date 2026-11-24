import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteJournal } from '@z1/journal'
import { ModuleStore } from '@z1/module'
import {
  APP_ERRORS,
  JsonRpcPeer,
  type ApprovalRequestParams,
  type ApprovalRequestResult,
  type NotificationMap,
  type SequencedEvent,
} from '@z1/protocol'
import { afterEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'

import { SocketTransport, startServer, type ServerOptions, type Z1Server } from '../src/index.ts'

const servers: Z1Server[] = []
const directories: string[] = []
const sockets: WebSocket[] = []
const peers: JsonRpcPeer[] = []

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close()
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const server of servers.splice(0)) await server.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function makeServer(options: Partial<ServerOptions> = {}): Promise<{
  server: Z1Server
  dbPath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'z1-server-'))
  directories.push(directory)
  const dbPath = join(directory, 'runs.db')
  const server = await startServer({ dbPath, ...options })
  servers.push(server)
  return { server, dbPath }
}

function openSocket(socket: WebSocket): Promise<void> {
  sockets.push(socket)
  return new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve()
    })
    socket.once('error', reject)
  })
}

async function connect(server: Z1Server): Promise<JsonRpcPeer> {
  const socket = new WebSocket(`${server.url}/ws?token=${server.token}`)
  await openSocket(socket)
  const peer = new JsonRpcPeer(new SocketTransport(socket), { requestTimeoutMs: 5_000 })
  peers.push(peer)
  await peer.request('initialize', { clientName: 'server-test' })
  return peer
}

/**
 * The shipped client, plus every `approval/request` frame it was asked with.
 *
 * The id of a repeat is only visible on the wire: a `JsonRpcPeer` exposes the
 * params of an inbound request, not the frame it arrived in.
 */
async function connectRecorded(server: Z1Server): Promise<{
  peer: JsonRpcPeer
  approvals: Array<Record<string, unknown>>
}> {
  const socket = new WebSocket(`${server.url}/ws?token=${server.token}`)
  const approvals: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    const frame = JSON.parse(text) as Record<string, unknown>
    if (frame['method'] === 'approval/request') approvals.push(frame)
  })
  await openSocket(socket)
  const peer = new JsonRpcPeer(new SocketTransport(socket), { requestTimeoutMs: 5_000 })
  peers.push(peer)
  await peer.request('initialize', { clientName: 'recorded' })
  return { peer, approvals }
}

/**
 * A client that speaks raw frames.
 *
 * A `JsonRpcPeer` drops an error for an id it is not waiting for, and the server
 * refuses an unusable `approval/request` reply exactly that way, so the refusal
 * is only observable on the wire.
 */
async function rawClient(server: Z1Server): Promise<{
  frames: Array<Record<string, unknown>>
  send: (frame: unknown) => void
  waitFor: (
    predicate: (frame: Record<string, unknown>) => boolean,
    what: string,
  ) => Promise<Record<string, unknown>>
  close: () => void
}> {
  const socket = new WebSocket(`${server.url}/ws?token=${server.token}`)
  await openSocket(socket)
  const frames: Array<Record<string, unknown>> = []
  socket.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    frames.push(JSON.parse(text) as Record<string, unknown>)
  })
  return {
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    async waitFor(predicate, what) {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const hit = frames.find(predicate)
        if (hit !== undefined) return hit
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`timed out waiting for ${what}`)
    },
    close: () => socket.close(),
  }
}

interface NodeJson {
  id: string
  type: string
  version: string
  config: unknown
  autonomy?: { mode: 'ask' | 'auto' | 'deny' }
  position: { x: number; y: number }
}

function node(
  id: string,
  type: string,
  config: unknown,
  autonomy?: { mode: 'ask' | 'auto' | 'deny' },
): NodeJson {
  return {
    id,
    type,
    version: '1.0.0',
    config,
    position: { x: 0, y: 0 },
    ...(autonomy === undefined ? {} : { autonomy }),
  }
}

/** The `hello` example: input -> template -> output, with one flow edge. */
function helloGraph(autonomy?: { mode: 'ask' | 'auto' | 'deny' }): unknown {
  return {
    schemaVersion: 1,
    id: 'hello',
    nodes: [
      node('input', 'z1.core.input', {}),
      node('template', 'z1.core.template', { template: 'hello {{name}}' }, autonomy),
      node('output', 'z1.core.output', {}),
    ],
    edges: [
      {
        id: 'e-in-vars',
        kind: 'data',
        from: { node: 'input', port: 'value' },
        to: { node: 'template', port: 'vars' },
      },
      {
        id: 'e-template-value',
        kind: 'data',
        from: { node: 'template', port: 'text' },
        to: { node: 'output', port: 'value' },
      },
      {
        id: 'f-in-output',
        kind: 'flow',
        from: { node: 'input', port: 'out' },
        to: { node: 'output', port: 'in' },
      },
    ],
  }
}

test('rejects a connection with the wrong token and accepts the right one', async () => {
  const { server } = await makeServer()

  const denied = new WebSocket(`${server.url}/ws?token=wrong`)
  sockets.push(denied)
  const failure = await new Promise<Error>((resolve) => {
    denied.once('error', resolve)
  })
  expect(failure.message).toContain('401')

  const peer = await connect(server)
  const initialized = await peer.request('initialize', { clientName: 'again' })
  expect(initialized.serverName).toBe('z1')
  expect(initialized.capabilities.approvals).toBe(true)
})

test('accepts the token from an Authorization header', async () => {
  const { server } = await makeServer()
  const socket = new WebSocket(`${server.url}/ws`, {
    headers: { authorization: `Bearer ${server.token}` },
  })
  await openSocket(socket)
  const peer = new JsonRpcPeer(new SocketTransport(socket), { requestTimeoutMs: 5_000 })
  peers.push(peer)
  const initialized = await peer.request('initialize', { clientName: 'header' })
  expect(initialized.serverName).toBe('z1')
})

test('node.list describes the builtins and graph.validate flags a dangling edge', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const ids = (await peer.request('node.list', {})).map((descriptor) => descriptor.id)
  expect(ids).toContain('z1.core.input')
  expect(ids).toContain('z1.core.output')
  expect(ids).toContain('z1.llm.chat')

  const dangling = {
    schemaVersion: 1,
    id: 'dangling',
    nodes: [node('input', 'z1.core.input', {})],
    edges: [
      {
        id: 'e-missing',
        kind: 'data',
        from: { node: 'input', port: 'value' },
        to: { node: 'missing', port: 'in' },
      },
    ],
  }
  const result = await peer.request('graph.validate', { graph: dangling })
  expect(result.ok).toBe(false)
  expect(result.issues.some((issue) => issue.code === 'dangling-edge')).toBe(true)
})

test('run.start completes a hello graph and streams events', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const events: NotificationMap['run.event'][] = []
  const statuses: NotificationMap['run.status'][] = []
  peer.onNotification('run.event', (notification) => {
    events.push(notification)
  })
  peer.onNotification('run.status', (notification) => {
    statuses.push(notification)
  })

  const reply = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'world' },
  })
  expect(reply.status).toBe('completed')
  expect(reply.outputs).toEqual({ output: 'hello world' })

  expect(events.length).toBeGreaterThan(0)
  expect(events.every((notification) => notification.runId === reply.runId)).toBe(true)
  const seqs = events.map((notification) => notification.seq)
  expect(new Set(seqs).size).toBe(seqs.length)
  for (const [index, seq] of seqs.entries()) {
    if (index === 0) continue
    expect(seq).toBeGreaterThan(seqs[index - 1] ?? 0)
  }
  expect(statuses).toContainEqual({ runId: reply.runId, status: 'completed' })
})

test('a module node started over the server journals its model turn', async () => {
  // The regression this covers: `run.start` called `beginRun` without a run id,
  // so the bridge could not attribute the module node's chat to any run and it
  // was served by the ambient service, silently unjournaled.
  const store = await mkdtemp(join(tmpdir(), 'z1-server-modules-'))
  directories.push(store)
  const source = join(store, 'src')
  await mkdir(source, { recursive: true })
  await writeFile(
    join(source, 'z1.module.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'com.example.talk',
      version: '1.0.0',
      title: 'talk',
      license: 'MIT',
      engines: { z1: '>=0.1.0' },
      entry: 'index.js',
      nodes: [
        {
          id: 'com.example.talk.chat',
          version: '1.0.0',
          title: 'Chat',
          category: 'example',
          inputs: [],
          outputs: [{ kind: 'data', id: 'value' }, { kind: 'flow', id: 'out' }],
        },
      ],
    }),
    'utf8',
  )
  await writeFile(
    join(source, 'index.js'),
    `export const nodes = [{
  id: 'com.example.talk.chat',
  version: '1.0.0',
  title: 'Chat',
  category: 'example',
  inputs: [],
  outputs: [{ kind: 'data', id: 'value' }, { kind: 'flow', id: 'out' }],
  async execute(ctx) {
    const reply = await ctx.llm.chat({
      model: { provider: 'mock', model: 'mock-1' },
      messages: [{ role: 'user', content: 'from the module' }],
    })
    return { value: reply.message.content, out: true }
  },
}]
`,
    'utf8',
  )
  const modules = new ModuleStore(join(store, 'modules'))
  modules.propose(source)
  modules.install('com.example.talk', '1.0.0', {
    capabilities: { llm: { providers: ['mock'] } },
    futureVersions: false,
  })
  modules.activate('com.example.talk', '1.0.0')

  const { server, dbPath } = await makeServer({ modulesPath: join(store, 'modules') })
  const peer = await connect(server)
  const reply = await peer.request('run.start', {
    graph: {
      schemaVersion: 1,
      id: 'module-node',
      nodes: [
        node('call', 'com.example.talk.chat', {}),
        node('out', 'z1.core.output', {}),
      ],
      edges: [
        { id: 'd1', kind: 'data', from: { node: 'call', port: 'value' }, to: { node: 'out', port: 'value' } },
        { id: 'f1', kind: 'flow', from: { node: 'call', port: 'out' }, to: { node: 'out', port: 'in' } },
      ],
    },
  })
  expect(reply.status).toBe('completed')

  const journal = new SqliteJournal(dbPath)
  try {
    const events = journal.ownedEvents(reply.runId).map((entry) => entry.event)
    const llm = events.filter((event) => event.type.startsWith('llm.'))
    expect(llm.map((event) => event.type)).toEqual(['llm.request', 'llm.response'])
    expect(llm[0]?.type === 'llm.request' ? llm[0].path : undefined).toBe('call')
  } finally {
    journal.close()
  }
})

test('an approved node runs after approval/request is answered', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const requests: ApprovalRequestParams[] = []
  peer.onRequest('approval/request', (params) => {
    requests.push(params)
    return { decision: 'allowed-once' }
  })

  const reply = await peer.request('run.start', { graph: helloGraph({ mode: 'ask' }) })
  expect(reply.status).toBe('completed')
  expect(reply.outputs).toEqual({ output: 'hello ' })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.nodeId).toBe('template')
  expect(requests[0]?.path).toBe('template')
  expect(requests[0]?.approvalId).toMatch(/^apr_/)

  await expect(
    peer.request('approval.respond', { approvalId: 'apr_missing', decision: 'rejected' }),
  ).rejects.toMatchObject({ code: 1003 })
})

test('an unusable approval reply is asked again and the client can answer', async () => {
  const { server } = await makeServer()
  const { peer, approvals } = await connectRecorded(server)

  let answers = 0
  peer.onRequest('approval/request', () => {
    answers += 1
    // The shipped peer sends whatever the handler returns: `null` is a legal
    // JSON-RPC result and an illegal decision.
    return (answers === 1 ? null : { decision: 'rejected' }) as ApprovalRequestResult
  })

  const reply = await peer.request('run.start', { graph: helloGraph({ mode: 'ask' }) })

  expect(reply.status).toBe('failed')
  expect(reply.error).toContain('APPROVAL_REJECTED')
  // The refusal alone is invisible to this client: only a second request is.
  expect(answers).toBe(2)
  expect(approvals).toHaveLength(2)
  expect(approvals[1]?.['id']).not.toBe(approvals[0]?.['id'])
  const first = approvals[0]?.['params'] as ApprovalRequestParams
  const second = approvals[1]?.['params'] as ApprovalRequestParams
  // Same approval, same node: the repeat is a retry, not a new decision point.
  expect(second.approvalId).toBe(first.approvalId)
  expect(second.nodeId).toBe(first.nodeId)
  expect(second.path).toBe(first.path)
})

test('three unusable approval replies hand the run to the deadline', async () => {
  // A short deadline so the test measures the policy, not the 300s default.
  const { server } = await makeServer({ approvalTimeoutMs: 500 })
  const { peer, approvals } = await connectRecorded(server)

  let answers = 0
  peer.onRequest('approval/request', () => {
    answers += 1
    return null as unknown as ApprovalRequestResult
  })

  const startedAt = Date.now()
  const reply = await peer.request('run.start', { graph: helloGraph({ mode: 'ask' }) })
  const took = Date.now() - startedAt

  // Three asks, then the approval is left to time out like one nobody answered.
  expect(answers).toBe(3)
  expect(approvals).toHaveLength(3)
  expect(reply.status).toBe('failed')
  expect(reply.error).toContain('timed out')
  expect(took).toBeLessThan(5_000)
})

test('an unusable approval/request reply is answered by a repeat, not by an error frame', async () => {
  const { server } = await makeServer()
  const client = await rawClient(server)
  client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientName: 'raw' } })
  client.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'run.start',
    params: { graph: helloGraph({ mode: 'ask' }), runId: 'run_refused_reply' },
  })

  const asked = await client.waitFor(
    (frame) => frame['method'] === 'approval/request',
    'approval/request',
  )
  const params = asked['params'] as { approvalId: string }
  // A result that is not an object used to throw inside the peer: the whole
  // server died on an unhandled rejection.
  client.send({ jsonrpc: '2.0', id: asked['id'], result: null })

  // The repeat is the refusal: a `-32602` on the answered id would be dropped by
  // a shipped peer, and could be matched against one of its own requests.
  const reAsked = await client.waitFor(
    (frame) => frame['method'] === 'approval/request' && frame['id'] !== asked['id'],
    'the repeated approval/request',
  )
  expect((reAsked['params'] as { approvalId: string }).approvalId).toBe(params.approvalId)
  expect(client.frames.some((frame) => frame['error'] !== undefined)).toBe(false)

  // Nothing settled the approval: the run is still open and nothing ran.
  client.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'run.get',
    params: { runId: 'run_refused_reply' },
  })
  const got = await client.waitFor((frame) => frame['id'] === 3, 'run.get')
  expect((got['result'] as { record: { status: string } }).record.status).toBe('running')
  expect(client.frames.some((frame) => frame['id'] === 2 && frame['result'] !== undefined)).toBe(
    false,
  )

  // A usable answer still settles it through `approval.respond`.
  client.send({
    jsonrpc: '2.0',
    id: 4,
    method: 'approval.respond',
    params: { approvalId: params.approvalId, decision: 'rejected' },
  })
  await client.waitFor((frame) => frame['id'] === 4, 'approval.respond')
  const reply = await client.waitFor(
    (frame) => frame['id'] === 2 && frame['result'] !== undefined,
    'the run reply',
  )
  expect(reply['result']).toMatchObject({ runId: 'run_refused_reply', status: 'failed' })
  expect((reply['result'] as { error?: string }).error).toContain('APPROVAL_REJECTED')
  client.close()
})

test('an unusable approval decision never runs the node', async () => {
  const { server } = await makeServer()
  const client = await rawClient(server)
  client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientName: 'raw' } })

  const cases: Array<[string, unknown]> = [
    ['an empty object', {}],
    ['a bare string', 'rejected'],
    ['a null decision', { decision: null }],
    ['an unknown decision', { decision: 'approved' }],
  ]
  let id = 10
  for (const [label, result] of cases) {
    const runId = `run_reply_${id}`
    const startId = id
    id += 1
    client.send({
      jsonrpc: '2.0',
      id: startId,
      method: 'run.start',
      params: { graph: helloGraph({ mode: 'ask' }), runId },
    })
    const asked = await client.waitFor(
      (frame) =>
        frame['method'] === 'approval/request' &&
        (frame['params'] as { runId: string }).runId === runId,
      `approval/request for ${label}`,
    )
    client.send({ jsonrpc: '2.0', id: asked['id'], result })
    // The repeat, not an error frame, is what a client can see: the same
    // approval asked again with a fresh id.
    const reAsked = await client.waitFor(
      (frame) =>
        frame['method'] === 'approval/request' &&
        (frame['params'] as { runId: string }).runId === runId &&
        frame['id'] !== asked['id'],
      `the repeat for ${label}`,
    )
    expect((reAsked['params'] as { approvalId: string }).approvalId, label).toBe(
      (asked['params'] as { approvalId: string }).approvalId,
    )

    // The node has not run: rejecting now fails the run instead of finding it
    // completed, which is what an "anything but rejected is allowed" reading did.
    const approvalId = (asked['params'] as { approvalId: string }).approvalId
    client.send({
      jsonrpc: '2.0',
      id,
      method: 'approval.respond',
      params: { approvalId, decision: 'rejected' },
    })
    await client.waitFor((frame) => frame['id'] === id, `approval.respond for ${label}`)
    id += 1
    const reply = await client.waitFor(
      (frame) => frame['id'] === startId,
      `the run reply for ${label}`,
    )
    expect((reply['result'] as { status: string }).status, label).toBe('failed')
    expect((reply['result'] as { error?: string }).error, label).toContain('APPROVAL_REJECTED')
  }
  client.close()
})

test('an unusable approval reply does not leak as an unhandled rejection', async () => {
  const seen: string[] = []
  const onRejection = (reason: unknown): void => {
    seen.push(String(reason))
  }
  process.on('unhandledRejection', onRejection)
  try {
    const { server } = await makeServer()
    const client = await rawClient(server)
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientName: 'raw' } })
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'run.start',
      params: { graph: helloGraph({ mode: 'ask' }), runId: 'run_no_rejection' },
    })
    const asked = await client.waitFor(
      (frame) => frame['method'] === 'approval/request',
      'approval/request',
    )
    client.send({ jsonrpc: '2.0', id: asked['id'], result: null })
    await client.waitFor(
      (frame) => frame['method'] === 'approval/request' && frame['id'] !== asked['id'],
      'the repeated approval/request',
    )
    // A turn of the loop is enough for a stray rejection to surface.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([])
    client.close()
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('a rejected node fails the run with APPROVAL_REJECTED', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  peer.onRequest('approval/request', () => ({ decision: 'rejected' }))

  const reply = await peer.request('run.start', { graph: helloGraph({ mode: 'ask' }) })
  expect(reply.status).toBe('failed')
  expect(reply.error).toContain('APPROVAL_REJECTED')
})

test('run.get replays the journal and run.subscribe honours afterSeq', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const reply = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'ada' },
  })
  const got = await peer.request('run.get', { runId: reply.runId })
  expect(got.record.status).toBe('completed')
  expect(got.record.graphId).toBe('hello')
  expect(got.events.length).toBeGreaterThan(2)
  expect(got.events[0]?.event.type).toBe('run.started')

  const cursor = got.events[1]?.seq ?? 0
  const subscribed = await peer.request('run.subscribe', {
    runId: reply.runId,
    afterSeq: cursor,
  })
  expect(subscribed.events.every((event) => event.seq > cursor)).toBe(true)
  expect(subscribed.events.length).toBe(got.events.length - cursor)

  const empty = await peer.request('run.subscribe', {
    runId: reply.runId,
    afterSeq: got.events.length,
  })
  expect(empty.events).toEqual([])
})

test('run.fork at a node path links the new run to its parent', async () => {
  const { server, dbPath } = await makeServer()
  const peer = await connect(server)

  const reply = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'fork' },
  })
  const got = await peer.request('run.get', { runId: reply.runId })
  const started: SequencedEvent | undefined = got.events.find(
    (item) => item.event.type === 'node.started' && item.event.path === 'template',
  )
  expect(started).toBeDefined()

  const fork = await peer.request('run.fork', { runId: reply.runId, nodePath: 'template' })
  expect(fork.runId).not.toBe(reply.runId)
  expect(fork.parentRunId).toBe(reply.runId)
  expect(fork.forkSeq).toBe((started?.seq ?? 0) - 1)

  const journal = new SqliteJournal(dbPath)
  try {
    const record = journal.getRun(fork.runId)
    expect(record?.parentRunId).toBe(reply.runId)
    expect(record?.forkSeq).toBe(fork.forkSeq)
    expect(journal.listRuns().map((run) => run.runId)).toEqual(
      expect.arrayContaining([reply.runId, fork.runId]),
    )
  } finally {
    journal.close()
  }
})

test('artifact.get reads a blob written through the journal', async () => {
  const { server, dbPath } = await makeServer()
  const peer = await connect(server)

  const journal = new SqliteJournal(dbPath)
  let hash: string
  try {
    hash = journal.putBlob(new Uint8Array(Buffer.from('artifact body', 'utf8')), 'text/plain')
  } finally {
    journal.close()
  }

  const result = await peer.request('artifact.get', { hash })
  expect(result.hash).toBe(hash)
  expect(result.mime).toBe('text/plain')
  expect(Buffer.from(result.base64, 'base64').toString('utf8')).toBe('artifact body')

  await expect(peer.request('artifact.get', { hash: 'deadbeef' })).rejects.toMatchObject({
    code: APP_ERRORS.artifactNotFound,
  })
  expect(APP_ERRORS.artifactNotFound).toBe(1006)
})

test('run.resume replays an unfinished run and requires the graph', async () => {
  const { server, dbPath } = await makeServer()
  const peer = await connect(server)

  const started = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'resume' },
  })
  expect(started.status).toBe('completed')

  // The run ended, and a finished id may not be resumed. Fork its journal into
  // a run that is still open — everything up to but excluding the terminal row
  // — so every `node.completed` is replayable while the resume is legal.
  const forkedRunId = 'run_resume_unfinished'
  const journal = new SqliteJournal(dbPath)
  try {
    const owned = journal.ownedEvents(started.runId)
    const terminal = owned[owned.length - 1]
    expect(terminal?.event.type).toBe('run.completed')
    journal.fork(started.runId, (terminal?.seq ?? 1) - 1, forkedRunId)
  } finally {
    journal.close()
  }

  const resumed = await peer.request('run.resume', {
    runId: forkedRunId,
    graph: helloGraph(),
    input: { name: 'resume' },
  })
  expect(resumed.runId).toBe(forkedRunId)
  expect(resumed.status).toBe('completed')

  const got = await peer.request('run.get', { runId: forkedRunId })
  expect(got.events.some((item) => item.event.type === 'run.resumed')).toBe(true)
  // The template replayed its journaled completion instead of executing again.
  const cached = got.events.filter(
    (item) => item.event.type === 'node.cached' && item.event.path === 'template',
  )
  expect(cached).toHaveLength(1)
  expect(
    got.events.filter(
      (item) => item.event.type === 'node.started' && item.event.path === 'template',
    ),
  ).toHaveLength(1)

  await expect(peer.request('run.resume', { runId: forkedRunId })).rejects.toMatchObject({
    code: -32602,
  })

  // The terminal-state rule still holds: the finished id is refused before its
  // row is touched, so a completed run never gains a second failure record.
  await expect(
    peer.request('run.resume', {
      runId: started.runId,
      graph: helloGraph(),
      input: { name: 'resume' },
    }),
  ).rejects.toMatchObject({ code: APP_ERRORS.conflict })

  const finished = await peer.request('run.get', { runId: started.runId })
  expect(finished.record.status).toBe('completed')
  expect(finished.events.filter((item) => item.event.type === 'run.failed')).toHaveLength(0)
  expect(finished.events.filter((item) => item.event.type === 'run.completed')).toHaveLength(1)
})

test('approval.respond decides an approval the client has not replied to', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  let approvalId: string | undefined
  peer.onRequest('approval/request', (params) => {
    approvalId = params.approvalId
    // Never resolves: the answer arrives through `approval.respond` instead.
    return new Promise<{ decision: 'allowed-once' }>(() => {})
  })

  const started = peer.request('run.start', { graph: helloGraph({ mode: 'ask' }) })
  for (let attempt = 0; attempt < 500 && approvalId === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(approvalId).toBeDefined()

  await peer.request('approval.respond', {
    approvalId: approvalId ?? '',
    decision: 'allowed-once',
  })
  const reply = await started
  expect(reply.status).toBe('completed')
})

test('approval.respond is refused once the run is cancelled', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  let approvalId: string | undefined
  const notices: Array<Record<string, unknown>> = []
  peer.onNotification('approval.abandoned', (params) => notices.push(params))
  peer.onRequest('approval/request', (params) => {
    approvalId = params.approvalId
    return new Promise<ApprovalRequestResult>(() => {})
  })

  const started = peer.request('run.start', {
    graph: helloGraph({ mode: 'ask' }),
    runId: 'run_cancelled_approval',
  })
  for (let attempt = 0; attempt < 500 && approvalId === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(approvalId).toBeDefined()

  await peer.request('run.cancel', { runId: 'run_cancelled_approval' })
  // The pending record is gone with the run, so the answer is a refusal and not
  // the silent `{}` a stale entry used to return.
  await expect(
    peer.request('approval.respond', { approvalId: approvalId ?? '', decision: 'allowed-once' }),
  ).rejects.toMatchObject({
    code: APP_ERRORS.conflict,
    message: 'run run_cancelled_approval is not waiting for approval',
  })
  const cancelled = await started
  expect(cancelled.status).toBe('cancelled')
  expect(notices).toEqual([
    {
      runId: 'run_cancelled_approval',
      approvalId: approvalId ?? '',
      nodeId: 'template',
      path: 'template',
      reason: 'run-cancelled',
    },
  ])
})

test('a decided approval cannot be answered twice', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  let approvalId: string | undefined
  peer.onRequest('approval/request', (params) => {
    approvalId = params.approvalId
    return new Promise<ApprovalRequestResult>(() => {})
  })

  const started = peer.request('run.start', { graph: helloGraph({ mode: 'ask' }) })
  for (let attempt = 0; attempt < 500 && approvalId === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(approvalId).toBeDefined()

  // The first answer is the normal path and still resolves to `{}`.
  await expect(
    peer.request('approval.respond', { approvalId: approvalId ?? '', decision: 'allowed-once' }),
  ).resolves.toEqual({})
  expect((await started).status).toBe('completed')
  // The second one has no entry left: a decided approval is not a switch.
  await expect(
    peer.request('approval.respond', { approvalId: approvalId ?? '', decision: 'rejected' }),
  ).rejects.toMatchObject({ code: APP_ERRORS.approvalNotFound })
})

test('the server announces an approval it stopped asking about', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const notices: Array<Record<string, unknown>> = []
  peer.onNotification('approval.abandoned', (params) => notices.push(params))
  peer.onRequest('approval/request', () => null as unknown as ApprovalRequestResult)

  const started = peer.request('run.start', {
    graph: helloGraph({ mode: 'ask' }),
    runId: 'run_abandoned_notice',
  })
  for (let attempt = 0; attempt < 500 && notices.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }

  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({
    runId: 'run_abandoned_notice',
    nodeId: 'template',
    path: 'template',
    reason: 'replies-exhausted',
  })
  const approvalId = notices[0]?.['approvalId'] as string
  expect(approvalId).toMatch(/^apr_/)

  // Knowing it was abandoned does not end the wait: `approval.respond` still
  // decides it, which is the policy after the attempt budget.
  await peer.request('approval.respond', { approvalId, decision: 'rejected' })
  expect((await started).status).toBe('failed')
})

test('a second connection cannot answer an approval it did not receive', async () => {
  const { server } = await makeServer()
  const owner = await connect(server)
  const stranger = await connect(server)

  let approvalId: string | undefined
  owner.onRequest('approval/request', (params) => {
    approvalId = params.approvalId
    return new Promise<ApprovalRequestResult>(() => {})
  })

  const started = owner.request('run.start', {
    graph: helloGraph({ mode: 'ask' }),
    runId: 'run_owned_approval',
  })
  for (let attempt = 0; attempt < 500 && approvalId === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(approvalId).toBeDefined()

  // The stranger knows the id and still gets the answer for an id that does not
  // exist: it must not learn that the approval is real, nor whose run it is.
  await expect(
    stranger.request('approval.respond', { approvalId: approvalId ?? '', decision: 'rejected' }),
  ).rejects.toMatchObject({
    code: APP_ERRORS.approvalNotFound,
    message: `unknown approval: ${approvalId ?? ''}`,
  })

  // The run is untouched and still belongs to the connection that was asked.
  const held = await stranger.request('run.get', { runId: 'run_owned_approval' })
  expect(held.record.status).toBe('running')
  await owner.request('approval.respond', {
    approvalId: approvalId ?? '',
    decision: 'allowed-once',
  })
  expect((await started).status).toBe('completed')
})

test('a foreign connection is not told that an approval was abandoned', async () => {
  const { server } = await makeServer()
  const owner = await connect(server)
  const stranger = await connect(server)

  let approvalId: string | undefined
  owner.onRequest('approval/request', (params) => {
    approvalId = params.approvalId
    return new Promise<ApprovalRequestResult>(() => {})
  })

  const started = owner.request('run.start', {
    graph: helloGraph({ mode: 'ask' }),
    runId: 'run_abandoned_owner',
  })
  for (let attempt = 0; attempt < 500 && approvalId === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  expect(approvalId).toBeDefined()

  await owner.request('run.cancel', { runId: 'run_abandoned_owner' })
  expect((await started).status).toBe('cancelled')

  // The owner learns the run moved on, with the run id it already knows.
  await expect(
    owner.request('approval.respond', { approvalId: approvalId ?? '', decision: 'allowed-once' }),
  ).rejects.toMatchObject({ code: APP_ERRORS.conflict })
  // The stranger keeps seeing an id that never existed.
  await expect(
    stranger.request('approval.respond', { approvalId: approvalId ?? '', decision: 'allowed-once' }),
  ).rejects.toMatchObject({ code: APP_ERRORS.approvalNotFound })
})

/** `a-input` and `b-memory` are roots; ids sort input first, so memory sees it. */
function memoryGraph(): unknown {
  return {
    schemaVersion: 1,
    id: 'memory',
    nodes: [
      node('a-input', 'z1.core.input', {}),
      node('b-memory', 'z1.memory.context', {}),
      node('c-output', 'z1.core.output', {}),
    ],
    edges: [
      {
        id: 'e-memory-text',
        kind: 'data',
        from: { node: 'b-memory', port: 'text' },
        to: { node: 'c-output', port: 'value' },
      },
      {
        id: 'f-input-output',
        kind: 'flow',
        from: { node: 'a-input', port: 'out' },
        to: { node: 'c-output', port: 'in' },
      },
    ],
  }
}

/** A loop body whose `template` asks for approval twice in one run. */
function loopApprovalGraph(): unknown {
  return {
    schemaVersion: 1,
    id: 'loop-approval',
    nodes: [
      node('input', 'z1.core.input', {}),
      node('loop', 'z1.flow.loop', {
        body: {
          schemaVersion: 1,
          id: 'body',
          nodes: [
            node('template', 'z1.core.template', { template: '{{value}}' }, { mode: 'ask' }),
            node('output', 'z1.core.output', {}),
          ],
          edges: [
            {
              id: 'e-body-value',
              kind: 'data',
              from: { node: 'template', port: 'text' },
              to: { node: 'output', port: 'value' },
            },
          ],
        },
        maxIterations: 2,
      }),
      node('done', 'z1.core.output', {}),
    ],
    edges: [
      {
        id: 'f-input-loop',
        kind: 'flow',
        from: { node: 'input', port: 'out' },
        to: { node: 'loop', port: 'in' },
      },
      {
        id: 'f-loop-done',
        kind: 'flow',
        from: { node: 'loop', port: 'out' },
        to: { node: 'done', port: 'in' },
      },
      {
        id: 'e-loop-value',
        kind: 'data',
        from: { node: 'loop', port: 'result' },
        to: { node: 'done', port: 'value' },
      },
    ],
  }
}

test('a later run with z1.memory.context sees the branch journal', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const prior = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'prior' },
  })
  expect(prior.status).toBe('completed')

  const reply = await peer.request('run.start', { graph: memoryGraph(), input: { name: 'again' } })
  expect(reply.status).toBe('completed')

  const text = reply.outputs['output']
  expect(typeof text).toBe('string')
  expect((text as string).length).toBeGreaterThan(0)
  expect(text).toContain('Recent steps')
  expect(text).toContain('a-input')
})

test('two approvals for a repeated node id are both answerable by approvalId', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const requests: ApprovalRequestParams[] = []
  peer.onRequest('approval/request', (params) => {
    requests.push(params)
    // Never resolves: each answer arrives through `approval.respond`.
    return new Promise<{ decision: 'allowed-once' }>(() => {})
  })

  const started = peer.request('run.start', { graph: loopApprovalGraph() })
  for (let expected = 1; expected <= 2; expected += 1) {
    for (let attempt = 0; attempt < 500 && requests.length < expected; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const request = requests[expected - 1]
    expect(request).toBeDefined()
    await peer.request('approval.respond', {
      approvalId: request?.approvalId ?? '',
      decision: 'allowed-once',
    })
  }

  const reply = await started
  expect(reply.status).toBe('completed')
  expect(requests).toHaveLength(2)
  expect(requests.map((request) => request.nodeId)).toEqual(['template', 'template'])
  expect(new Set(requests.map((request) => request.approvalId)).size).toBe(2)
  expect(requests[0]?.path).not.toBe(requests[1]?.path)
})

test('close is idempotent', async () => {
  const { server } = await makeServer()
  await server.close()
  await expect(server.close()).resolves.toBeUndefined()
})

test('run.fork on a forked run uses own numbering and resumes before the node', async () => {
  const { server, dbPath } = await makeServer()
  const peer = await connect(server)

  const started = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'prefix' },
  })
  // The first fork inherits the parent's prefix, so its merged numbering is
  // already offset from its own.
  const first = await peer.request('run.fork', { runId: started.runId, nodePath: 'template' })

  // Before the fix the fork prefix ended after `template` had completed, so a
  // resume replayed it as cached instead of re-executing it.
  const resumedFirst = await peer.request('run.resume', {
    runId: first.runId,
    graph: helloGraph(),
  })
  expect(resumedFirst.status).toBe('completed')
  expect(resumedFirst.outputs).toEqual({ output: 'hello prefix' })

  const gotFirst = await peer.request('run.get', { runId: first.runId })
  const firstOwnStart = gotFirst.events.find(
    (item) => item.event.type === 'node.started' && item.event.path === 'template',
  )
  expect(firstOwnStart?.event.runId).toBe(first.runId)

  const journal = new SqliteJournal(dbPath)
  let expectedOwnSeq: number
  try {
    const own = journal.ownedEvents(first.runId)
    const ownStart = own.find(
      (entry) => entry.event.type === 'node.started' && entry.event.path === 'template',
    )
    expect(ownStart).toBeDefined()
    expectedOwnSeq = (ownStart?.seq ?? 0) - 1
    // The same event sits at a different position in the merged replay.
    expect(ownStart?.seq).toBeLessThan((firstOwnStart?.seq ?? 0))
  } finally {
    journal.close()
  }

  const second = await peer.request('run.fork', {
    runId: first.runId,
    nodePath: 'template',
  })
  expect(second.forkSeq).toBe(expectedOwnSeq)
  // Own numbering is strictly below the merged cursor for the same node.
  expect(second.forkSeq).toBeLessThan((firstOwnStart?.seq ?? 0) - 1)

  const resumedSecond = await peer.request('run.resume', {
    runId: second.runId,
    graph: helloGraph(),
  })
  expect(resumedSecond.status).toBe('completed')
  expect(resumedSecond.outputs).toEqual({ output: 'hello prefix' })

  const gotSecond = await peer.request('run.get', { runId: second.runId })
  const reExecuted = gotSecond.events.filter(
    (item) => item.event.type === 'node.started' && item.event.path === 'template',
  )
  // Exactly one `node.started` for template, and it belongs to the new run:
  // the node ran again rather than being replayed from the parent prefix.
  expect(reExecuted).toHaveLength(1)
  expect(reExecuted[0]?.event.runId).toBe(second.runId)
})

test('run.start refuses a reused runId with a 1004 conflict', async () => {
  const { server, dbPath } = await makeServer()
  const peer = await connect(server)
  expect(APP_ERRORS.conflict).toBe(1004)

  const first = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'once' },
    runId: 'run_fixed',
  })
  expect(first.runId).toBe('run_fixed')

  await expect(
    peer.request('run.start', { graph: helloGraph(), input: { name: 'twice' }, runId: 'run_fixed' }),
  ).rejects.toMatchObject({ code: APP_ERRORS.conflict })

  const got = await peer.request('run.get', { runId: 'run_fixed' })
  expect(got.events.filter((item) => item.event.type === 'run.started')).toHaveLength(1)

  // The journal alone (no live server state, as after a restart) is enough.
  await server.close()
  const restarted = await startServer({ dbPath })
  servers.push(restarted)
  const peer2 = await connect(restarted)
  await expect(
    peer2.request('run.start', { graph: helloGraph(), runId: 'run_fixed' }),
  ).rejects.toMatchObject({ code: APP_ERRORS.conflict })
})

test('a settled run keeps one run.cancel answer across the prune', async () => {
  const { server } = await makeServer()
  const first = await connect(server)
  const started = await first.request('run.start', { graph: helloGraph() })
  expect(started.status).toBe('completed')

  const refusal = { code: APP_ERRORS.conflict, message: `run ${started.runId} is already completed` }
  // While watched, the run still has server-side state.
  await expect(first.request('run.cancel', { runId: started.runId })).rejects.toMatchObject(refusal)

  first.close()
  const observer = await connect(server)
  // `dropConnection` prunes a settled run once its last subscriber is gone, and
  // the journal then answers instead. Both states must give the same refusal:
  // the answer may not depend on whether the state is still in memory.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await expect(observer.request('run.cancel', { runId: started.runId })).rejects.toMatchObject(
      refusal,
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  // The journal still has the trace, and subscribe rebuilds state from it.
  const replay = await observer.request('run.subscribe', { runId: started.runId })
  expect(replay.events.length).toBeGreaterThan(0)
  const got = await observer.request('run.get', { runId: started.runId })
  expect(got.record.status).toBe('completed')
})

test('run.cancel reports an unknown run as not found', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  await expect(peer.request('run.cancel', { runId: 'run_never_started' })).rejects.toMatchObject({
    code: APP_ERRORS.runNotFound,
  })
})

test('a failed listen closes the journal instead of leaking the runtime', async () => {
  const blocker = createNetServer()
  await new Promise<void>((resolve) => {
    blocker.listen(0, '127.0.0.1', resolve)
  })
  const address = blocker.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  const directory = await mkdtemp(join(tmpdir(), 'z1-server-'))
  directories.push(directory)
  const close = vi.spyOn(SqliteJournal.prototype, 'close')
  try {
    await expect(
      startServer({ dbPath: join(directory, 'runs.db'), host: '127.0.0.1', port }),
    ).rejects.toThrow(/EADDRINUSE|address already in use/i)
    expect(close).toHaveBeenCalled()
  } finally {
    close.mockRestore()
    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve()
      })
    })
  }
})

