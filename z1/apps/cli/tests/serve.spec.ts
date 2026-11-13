import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcPeer, type RunReply } from '@z1/protocol'
import { SocketTransport } from '@z1/server'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const HELLO = fileURLToPath(new URL('../../../examples/hello.graph.json', import.meta.url))
/** The workspace-installed tsx shim; vitest runs from the `z1` package root. */
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
const TIMEOUT_MS = 20_000

/** `--port 0` hands the OS the choice, so the printed port is the real one. */
interface ServeInfo {
  url: string
  token: string
  port: number
}

const children: ChildProcessWithoutNullStreams[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function tempDb(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'z1-serve-'))
  directories.push(directory)
  return join(directory, 'runs.db')
}

interface Spawned {
  child: ChildProcessWithoutNullStreams
  /** Resolves with the first stdout line, or rejects if the process exits first. */
  firstLine: Promise<string>
  stderr(): string
  exited: Promise<number>
}

function spawnServe(args: readonly string[]): Spawned {
  const child = spawn(TSX, [BIN, 'serve', ...args], {
    stdio: 'pipe',
    env: { ...process.env },
  })
  children.push(child)

  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  const exited = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      resolve(code ?? -1)
    })
  })

  const firstLine = new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8')
      const newline = stdout.indexOf('\n')
      if (newline === -1) return
      child.stdout.off('data', onData)
      resolve(stdout.slice(0, newline))
    }
    child.stdout.on('data', onData)
    // A startup failure never prints a line, so surface stderr instead of waiting.
    void exited.then((code) => {
      child.stdout.off('data', onData)
      reject(new Error(`serve exited with ${String(code)} before printing: ${stderr}`))
    })
  })

  return { child, firstLine, stderr: () => stderr, exited }
}

async function startServe(): Promise<{ info: ServeInfo; child: ChildProcessWithoutNullStreams; exited: Promise<number> }> {
  const dbPath = await tempDb()
  const spawned = spawnServe(['--port', '0', '--db', dbPath, '--json'])
  const line = await spawned.firstLine
  const info = JSON.parse(line) as ServeInfo
  return { info, child: spawned.child, exited: spawned.exited }
}

async function connect(url: string, token: string): Promise<JsonRpcPeer> {
  const socket = new WebSocket(`${url}/ws?token=${token}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve()
    })
    socket.once('error', (error) => {
      reject(error)
    })
  })
  return new JsonRpcPeer(new SocketTransport(socket), { requestTimeoutMs: 10_000 })
}

describe('z1 serve', () => {
  test('prints one JSON line and serves the protocol over the socket', async () => {
    const { info, child, exited } = await startServe()

    expect(Object.keys(info).sort()).toEqual(['port', 'token', 'url'])
    expect(info.url).toBe(`ws://127.0.0.1:${String(info.port)}`)
    expect(info.port).toBeGreaterThan(0)
    expect(info.token).toMatch(/^[0-9a-f]{32}$/)

    const peer = await connect(info.url, info.token)
    try {
      const initialized = await peer.request('initialize', { clientName: 'serve-test' })
      expect(initialized.serverName).toBe('z1')
      expect(initialized.protocolVersion).toBe('1')

      const nodes = await peer.request('node.list', {})
      expect(nodes.some((node) => node.id === 'z1.core.template')).toBe(true)

      const graph: unknown = JSON.parse(await readFile(HELLO, 'utf8'))
      const reply: RunReply = await peer.request('run.start', {
        graph,
        input: { name: 'world' },
      })
      expect(reply.status).toBe('completed')
      expect(reply.outputs['output']).toBe('hello world')
    } finally {
      peer.close()
    }

    // SIGTERM is the documented stop: the server closes and the CLI exits 0.
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
  }, TIMEOUT_MS)

  test('accepts --modules-dir and uses that store', async () => {
    const dbPath = await tempDb()
    const modulesRoot = await mkdtemp(join(tmpdir(), 'z1-serve-modules-'))
    directories.push(modulesRoot)
    const modulesDir = join(modulesRoot, 'store')
    const spawned = spawnServe([
      '--port',
      '0',
      '--db',
      dbPath,
      '--modules-dir',
      modulesDir,
      '--json',
    ])
    const line = await spawned.firstLine
    const info = JSON.parse(line) as ServeInfo

    const peer = await connect(info.url, info.token)
    try {
      const listed = await peer.request('module.list', {})
      expect(listed.modules).toEqual([])
      // The runtime created the configured store rather than the default one.
      expect(existsSync(modulesDir)).toBe(true)
    } finally {
      peer.close()
    }

    spawned.child.kill('SIGTERM')
    expect(await spawned.exited).toBe(0)
  }, TIMEOUT_MS)

  test('rejects a wrong token', async () => {
    const { info, child, exited } = await startServe()
    try {
      await expect(connect(info.url, 'not-the-token')).rejects.toThrow()
    } finally {
      child.kill('SIGTERM')
      expect(await exited).toBe(0)
    }
  }, TIMEOUT_MS)

  test('unknown option is a usage error', async () => {
    const dbPath = await tempDb()
    // Spawned directly: this one never prints a listening line, so there is no
    // first line to await (and no rejected promise left dangling).
    const child = spawn(TSX, [BIN, 'serve', '--bogus', '--db', dbPath], {
      stdio: 'pipe',
      env: { ...process.env },
    })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const code = await new Promise<number>((resolve) => {
      child.on('close', (exitCode) => {
        resolve(exitCode ?? -1)
      })
    })
    expect(code).toBe(2)
    expect(stderr).toContain('--bogus')
  }, TIMEOUT_MS)
})
