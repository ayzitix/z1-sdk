import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { graphDigest, parseGraph } from '@z1/graph'
import { JsonRpcPeer } from '@z1/protocol'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'

import { SocketTransport, startServer, type Z1Server } from '../src/index.ts'

const servers: Z1Server[] = []
const directories: string[] = []
const peers: JsonRpcPeer[] = []

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close()
  for (const server of servers.splice(0)) await server.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

/** A server with its journal and graph library in one throwaway directory. */
async function makeServer(): Promise<{ server: Z1Server; graphsPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'z1-graphs-'))
  directories.push(directory)
  const graphsPath = join(directory, 'graphs')
  const server = await startServer({ dbPath: join(directory, 'runs.db'), graphsPath })
  servers.push(server)
  return { server, graphsPath }
}

async function connect(server: Z1Server): Promise<JsonRpcPeer> {
  const socket = new WebSocket(`${server.url}/ws?token=${server.token}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve()
    })
    socket.once('error', reject)
  })
  const peer = new JsonRpcPeer(new SocketTransport(socket), { requestTimeoutMs: 5_000 })
  peers.push(peer)
  await peer.request('initialize', { clientName: 'graphs-test' })
  return peer
}

function node(id: string, type: string, config: unknown): Record<string, unknown> {
  return { id, type, version: '1.0.0', config, position: { x: 0, y: 0 } }
}

/** input -> template -> output: id, title and two nodes with one flow edge. */
function helloGraph(id: string, title?: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    ...(title === undefined ? {} : { title }),
    nodes: [
      node('input', 'z1.core.input', {}),
      node('template', 'z1.core.template', { template: 'hi' }),
      node('output', 'z1.core.output', {}),
    ],
    edges: [
      {
        id: 'e-value',
        kind: 'data',
        from: { node: 'template', port: 'text' },
        to: { node: 'output', port: 'value' },
      },
      {
        id: 'f-start',
        kind: 'flow',
        from: { node: 'input', port: 'out' },
        to: { node: 'output', port: 'in' },
      },
    ],
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

test('graph.save then graph.get round-trips the document and its metadata', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const saved = await peer.request('graph.save', { graph: helloGraph('hello', 'Hello') })
  expect(saved.id).toBe('hello')
  expect(saved.version).toBe(1)
  expect(typeof saved.updatedAt).toBe('number')

  const got = await peer.request('graph.get', { id: 'hello' })
  expect(got.version).toBe(1)
  expect(got.updatedAt).toBe(saved.updatedAt)
  expect(got.graph.id).toBe('hello')
  expect(got.graph.title).toBe('Hello')
  expect(got.graph.nodes.map((entry) => entry.id)).toEqual(['input', 'template', 'output'])
  expect(got.graph.edges.map((entry) => entry.id)).toEqual(['e-value', 'f-start'])
})

test('graph.save bumps the version and rejects a stale expectedVersion', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  await peer.request('graph.save', { graph: helloGraph('counter') })
  const second = await peer.request('graph.save', {
    graph: helloGraph('counter', 'Second'),
    expectedVersion: 1,
  })
  expect(second.version).toBe(2)

  await expect(
    peer.request('graph.save', { graph: helloGraph('counter', 'Third'), expectedVersion: 1 }),
  ).rejects.toMatchObject({ code: 1004 })

  // The rejected save must not have advanced the stored version.
  const stillSecond = await peer.request('graph.get', { id: 'counter' })
  expect(stillSecond.version).toBe(2)
  expect(stillSecond.graph.title).toBe('Second')

  const third = await peer.request('graph.save', {
    graph: helloGraph('counter', 'Third'),
    expectedVersion: 2,
  })
  expect(third.version).toBe(3)
})

test('graph.save rejects an invalid graph structure and an invalid id', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  await expect(
    peer.request('graph.save', { graph: { id: 'broken' } }),
  ).rejects.toMatchObject({ code: 1002 })

  await expect(
    peer.request('graph.save', { graph: helloGraph('../escape') }),
  ).rejects.toMatchObject({ code: -32602 })

  await expect(peer.request('graph.get', { id: 'missing' })).rejects.toMatchObject({ code: 1007 })
})

test('graph.save is structure-only: an unknown node type still saves', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  const graph = {
    schemaVersion: 1,
    id: 'future',
    nodes: [node('future', 'z1.future.node', {})],
    edges: [],
  }
  const saved = await peer.request('graph.save', { graph })
  expect(saved.version).toBe(1)
})

test('graph.list is newest first and carries counts and the digest', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  for (const id of ['first', 'second', 'third']) {
    await peer.request('graph.save', { graph: helloGraph(id, id) })
    await settle()
  }

  const { graphs } = await peer.request('graph.list', {})
  expect(graphs.map((summary) => summary.id)).toEqual(['third', 'second', 'first'])
  const third = graphs[0]
  if (third === undefined) throw new Error('expected a summary')
  expect(third.title).toBe('third')
  expect(third.version).toBe(1)
  expect(third.nodes).toBe(3)
  expect(third.edges).toBe(2)
  expect(third.digest).toBe(graphDigest(parseGraph(helloGraph('third', 'third'))))
})

test('graph.delete removes the file and is idempotent', async () => {
  const { server } = await makeServer()
  const peer = await connect(server)

  await peer.request('graph.save', { graph: helloGraph('gone') })
  expect(await peer.request('graph.delete', { id: 'gone' })).toEqual({})
  await expect(peer.request('graph.get', { id: 'gone' })).rejects.toMatchObject({ code: 1007 })

  // Deleting a graph that never existed is a success, not a 1007.
  expect(await peer.request('graph.delete', { id: 'gone' })).toEqual({})
  const { graphs } = await peer.request('graph.list', {})
  expect(graphs).toEqual([])
})

test('graph.list skips a corrupt file instead of failing', async () => {
  const { server, graphsPath } = await makeServer()
  const peer = await connect(server)

  await peer.request('graph.save', { graph: helloGraph('good') })
  await writeFile(join(graphsPath, 'broken.json'), '{not json', 'utf8')
  await writeFile(join(graphsPath, 'wrong-shape.json'), '{"version":1}', 'utf8')

  const { graphs } = await peer.request('graph.list', {})
  expect(graphs.map((summary) => summary.id)).toEqual(['good'])

  // `get` stays honest about unreadable bytes; only `list` degrades quietly.
  await expect(peer.request('graph.get', { id: 'broken' })).rejects.toMatchObject({ code: 1002 })
})

test('overwriting a graph is atomic and leaves no temp file behind', async () => {
  const { server, graphsPath } = await makeServer()
  const peer = await connect(server)

  await peer.request('graph.save', { graph: helloGraph('atomic', 'Before') })
  await peer.request('graph.save', { graph: helloGraph('atomic', 'After'), expectedVersion: 1 })

  const entries = await readdir(graphsPath)
  expect(entries).toEqual(['atomic.json'])
  expect(entries.some((entry) => entry.includes('.tmp'))).toBe(false)

  // The single file on disk is complete and is the newest version.
  const raw = await readFile(join(graphsPath, 'atomic.json'), 'utf8')
  const file = JSON.parse(raw) as { version: number; updatedAt: number; graph: { title: string } }
  expect(file.version).toBe(2)
  expect(file.updatedAt).toBeGreaterThan(0)
  expect(file.graph.title).toBe('After')
})
