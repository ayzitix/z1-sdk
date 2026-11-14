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

test('a settled run is pruned once its last subscriber disconnects', async () => {
  const { server } = await makeServer()
  const first = await connect(server)
  const started = await first.request('run.start', { graph: helloGraph() })
  expect(started.status).toBe('completed')

  // While watched, the run still has server-side state.
  await expect(first.request('run.cancel', { runId: started.runId })).resolves.toEqual({})

  first.close()
  const observer = await connect(server)
  // `run.cancel` needs a `RunState`; once the settled run is pruned it is a
  // not-found rather than a stale no-op abort.
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await observer.request('run.cancel', { runId: started.runId })
    } catch (error) {
      expect(error).toMatchObject({ code: APP_ERRORS.runNotFound })
      // The journal still has the trace, and subscribe rebuilds state.
      const replay = await observer.request('run.subscribe', { runId: started.runId })
      expect(replay.events.length).toBeGreaterThan(0)
      const got = await observer.request('run.get', { runId: started.runId })
      expect(got.record.status).toBe('completed')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('settled run was never pruned from the runs map')
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

