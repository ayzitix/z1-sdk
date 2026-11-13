import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JsonRpcFault, JsonRpcPeer } from '@z1/protocol'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

import { SocketTransport, startServer, type Z1Server } from '../src/index.ts'

const ECHO_SOURCE = fileURLToPath(new URL('../../../examples/modules/echo', import.meta.url))
const ECHO_NODE = 'com.example.echo.echo'

let directory = ''
let server: Z1Server
let peer: JsonRpcPeer
let socket: WebSocket

/** `const` -> module node -> `z1.core.output`, mirroring the CLI example. */
function echoGraph(): unknown {
  return {
    schemaVersion: 1,
    id: 'echo-module',
    nodes: [
      {
        id: 'constant',
        type: 'z1.core.const',
        version: '1.0.0',
        config: { value: 'hello' },
        position: { x: -220, y: 0 },
      },
      {
        id: 'echo',
        type: ECHO_NODE,
        version: '1.0.0',
        config: {},
        position: { x: 0, y: 0 },
      },
      {
        id: 'result',
        type: 'z1.core.output',
        version: '1.0.0',
        config: {},
        position: { x: 220, y: 0 },
      },
    ],
    edges: [
      {
        id: 'e-const-text',
        kind: 'data',
        from: { node: 'constant', port: 'value' },
        to: { node: 'echo', port: 'text' },
      },
      {
        id: 'e-echo-text',
        kind: 'data',
        from: { node: 'echo', port: 'text' },
        to: { node: 'result', port: 'value' },
      },
      {
        id: 'f-echo-out',
        kind: 'flow',
        from: { node: 'echo', port: 'out' },
        to: { node: 'result', port: 'in' },
      },
    ],
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'z1-server-modules-'))
  server = await startServer({
    dbPath: join(directory, 'runs.db'),
    modulesPath: join(directory, 'modules'),
  })
  socket = new WebSocket(`${server.url}/ws?token=${server.token}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve()
    })
    socket.once('error', reject)
  })
  peer = new JsonRpcPeer(new SocketTransport(socket), { requestTimeoutMs: 30_000 })
  await peer.request('initialize', { clientName: 'modules-test' })
})

afterAll(async () => {
  peer?.close()
  socket?.terminate()
  await server?.close()
  await rm(directory, { recursive: true, force: true })
})

describe('module protocol', () => {
  test('lists nothing, proposes, approves and exposes the declared node', async () => {
    const empty = await peer.request('module.list', {})
    expect(empty).toEqual({ modules: [], proposals: [] })

    const before = await peer.request('node.list', {})
    expect(before.some((descriptor) => descriptor.id === ECHO_NODE)).toBe(false)

    const proposal = await peer.request('module.propose', { directory: ECHO_SOURCE })
    expect(proposal.moduleId).toBe('com.example.echo')
    expect(proposal.version).toBe('1.0.0')
    expect(proposal.directory).toContain('com.example.echo@1.0.0')
    expect(proposal.capabilities.fs?.read?.length ?? 0).toBeGreaterThan(0)

    const listedProposals = await peer.request('module.list', {})
    expect(listedProposals.modules).toEqual([])
    expect(listedProposals.proposals).toHaveLength(1)

    const installed = await peer.request('module.approve', {
      moduleId: 'com.example.echo',
      version: '1.0.0',
    })
    expect(installed.active).toBe(true)
    expect(installed.capabilities.fs?.read?.length ?? 0).toBeGreaterThan(0)
    expect(installed.nodes).toEqual([
      {
        id: ECHO_NODE,
        title: 'Echo',
        category: 'example',
        inputs: 1,
        outputs: 2,
      },
    ])

    const after = await peer.request('node.list', {})
    const declared = after.find((descriptor) => descriptor.id === ECHO_NODE)
    expect(declared).toBeDefined()
    expect(declared?.version).toBe('1.0.0')

    const validation = await peer.request('graph.validate', { graph: echoGraph() })
    expect(validation.issues).toEqual([])
    expect(validation.ok).toBe(true)
  })

  test('approving an unproposed version fails with a clear fault', async () => {
    const fault = await peer
      .request('module.approve', { moduleId: 'com.example.echo', version: '9.9.9' })
      .catch((error: unknown) => error)
    expect(fault).toBeInstanceOf(JsonRpcFault)
    expect((fault as JsonRpcFault).code).toBe(-32602)
    expect((fault as JsonRpcFault).message).toContain('9.9.9')
  })

  test('runs a module node in a real worker', async () => {
    const reply = await peer.request('run.start', { graph: echoGraph() })
    expect(reply.status).toBe('completed')
    expect(reply.outputs).toEqual({ output: 'hello!' })
    expect(String(reply.outputs['output']).endsWith('!')).toBe(true)
  })

  test('audit records propose, approve and install', async () => {
    const entries = await peer.request('module.audit', {})
    const types = new Set(entries.map((entry) => entry.type))
    expect(types.has('propose')).toBe(true)
    expect(types.has('approve')).toBe(true)
    expect(types.has('install')).toBe(true)
  })

  test('rollback with a single version fails clearly', async () => {
    const fault = await peer
      .request('module.rollback', { moduleId: 'com.example.echo' })
      .catch((error: unknown) => error)
    expect(fault).toBeInstanceOf(JsonRpcFault)
    expect((fault as JsonRpcFault).message).toContain('no earlier version')
  })
})
