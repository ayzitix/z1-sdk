import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteJournal } from '@z1/journal'
import {
  APP_ERRORS,
  JsonRpcPeer,
  type ApprovalRequestParams,
  type NotificationMap,
  type SequencedEvent,
} from '@z1/protocol'
import { afterEach, expect, test } from 'vitest'
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

test('run.resume replays a finished run and requires the graph', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const started = await peer.request('run.start', {
    graph: helloGraph(),
    input: { name: 'resume' },
  })
  const resumed = await peer.request('run.resume', {
    runId: started.runId,
    graph: helloGraph(),
    input: { name: 'resume' },
  })
  expect(resumed.runId).toBe(started.runId)
  expect(resumed.status).toBe('completed')

  const got = await peer.request('run.get', { runId: started.runId })
  expect(got.events.some((item) => item.event.type === 'run.resumed')).toBe(true)

  await expect(peer.request('run.resume', { runId: started.runId })).rejects.toMatchObject({
    code: -32602,
  })
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

test('close is idempotent', async () => {
  const { server } = await makeServer()
  await server.close()
  await expect(server.close()).resolves.toBeUndefined()
})
