import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { ModuleStore } from '@z1/module'
import type { Json } from '@z1/node'
import type { ApprovalService, ToolService } from '@z1/runtime'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createRuntime, loadRuntimeConfig, type Runtime, type RunHandle } from '../src/index.ts'

/** The example module that ships with the repo. */
const MODULE_SOURCE = fileURLToPath(new URL('../../../examples/modules/z1-tools', import.meta.url))

const MODULE_ID = 'com.z1.tools'
const MODULE_VERSION = '0.1.0'

const allowAll: ApprovalService = { request: async () => 'allowed-once' }

let root: string
let workspace: string
let modulesDir: string
let runtime: Runtime
let handle: RunHandle
let tools: ToolService
let server: Server
let serverUrl: string

const NOTE = 'note.txt'
const NOTE_RELATIVE = `raw/${NOTE}`
const NOTE_ABSOLUTE = (): string => join(workspace, NOTE_RELATIVE)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-tools-module-'))
  workspace = join(root, 'workspace')
  modulesDir = join(root, 'modules')
  await mkdir(workspace, { recursive: true })

  // Propose -> approve -> activate the shipped example, then run it.
  const store = new ModuleStore(modulesDir)
  store.propose(MODULE_SOURCE)
  store.approve(MODULE_ID, MODULE_VERSION)
  store.activate(MODULE_ID, MODULE_VERSION)

  runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: workspace,
      env: {},
      overrides: {
        dbPath: join(root, `runs-${randomUUID()}.db`),
        graphsPath: join(root, 'graphs'),
        modulesPath: modulesDir,
      },
    }),
  )

  handle = await runtime.beginRun({ runId: `run_${randomUUID()}`, approval: allowAll })
  tools = handle.services.tools

  server = createServer((request, response) => {
    response.statusCode = 201
    response.setHeader('content-type', 'text/plain')
    response.end(`tools-ok ${request.method}`)
  })
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => done())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  serverUrl = `http://127.0.0.1:${address.port}/`
})

afterAll(async () => {
  await handle?.dispose()
  await runtime?.close()
  await new Promise<void>((done) => {
    server?.close(() => done())
  })
  await rm(root, { recursive: true, force: true })
})

/** The tool result is JSON; tests read named fields. */
function call(name: string, args: Record<string, Json>): Promise<Json> {
  return tools.call(name, args as Json)
}

describe('z1 tools module', () => {
  test('exposes the seven tools with JSON Schema parameters', async () => {
    const schemas = await tools.list()
    expect(schemas.map((schema) => schema.name)).toEqual([
      'read',
      'write',
      'edit',
      'list',
      'glob',
      'shell',
      'http',
    ])
    for (const schema of schemas) {
      expect(schema.parameters['type']).toBe('object')
      expect(Array.isArray(schema.parameters['required'])).toBe(true)
      expect(schema.description?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('write creates parent directories and reports bytes', async () => {
    const result = (await call('write', { path: NOTE_RELATIVE, content: 'hello z1\n' })) as {
      path: string
      bytes: number
    }
    expect(result.path).toBe(NOTE_ABSOLUTE())
    expect(result.bytes).toBe(Buffer.byteLength('hello z1\n', 'utf8'))
    expect(await readFile(NOTE_ABSOLUTE(), 'utf8')).toBe('hello z1\n')
  })

  test('read returns the same text and honours the line window', async () => {
    const all = (await call('read', { path: NOTE_RELATIVE })) as {
      content: string
      totalLines: number
    }
    expect(all.content).toBe('hello z1\n')

    const window = (await call('read', { path: NOTE_ABSOLUTE(), offset: 1, limit: 1 })) as {
      content: string
      offset: number
    }
    expect(window.content).toBe('hello z1\n')
    expect(window.offset).toBe(1)

    await expect(call('read', { path: join(workspace, 'missing.txt') })).rejects.toThrow(
      /cannot read/,
    )
  })

  test('edit replaces text and refuses an ambiguous match', async () => {
    const result = (await call('edit', {
      path: NOTE_RELATIVE,
      oldText: 'hello',
      newText: 'hi',
    })) as { path: string; replacements: number }
    expect(result.replacements).toBe(1)
    expect(await readFile(NOTE_ABSOLUTE(), 'utf8')).toBe('hi z1\n')

    await call('write', { path: NOTE_RELATIVE, content: 'aa aa\n' })
    await expect(
      call('edit', { path: NOTE_RELATIVE, oldText: 'aa', newText: 'bb' }),
    ).rejects.toThrow(/occurs 2 times/)

    const all = (await call('edit', {
      path: NOTE_RELATIVE,
      oldText: 'aa',
      newText: 'bb',
      replaceAll: true,
    })) as { replacements: number }
    expect(all.replacements).toBe(2)
    expect(await readFile(NOTE_ABSOLUTE(), 'utf8')).toBe('bb bb\n')
  })

  test('glob finds the file under the workspace', async () => {
    const result = (await call('glob', { pattern: '**/*.txt', path: '.' })) as {
      matches: string[]
    }
    expect(result.matches).toContain(NOTE_ABSOLUTE())

    const absolute = (await call('glob', { pattern: '**/note.txt', path: workspace })) as {
      matches: string[]
    }
    expect(absolute.matches).toContain(NOTE_ABSOLUTE())
  })

  test('list returns the workspace entry (recursively)', async () => {
    const flat = (await call('list', { path: '.' })) as {
      path: string
      entries: Array<{ name: string; type: string; depth: number }>
    }
    expect(flat.path).toBe(workspace)
    expect(flat.entries.map((entry) => entry.name)).toContain('raw')

    const deep = (await call('list', { path: workspace, recursive: true })) as {
      entries: Array<{ path: string; depth: number }>
    }
    const note = deep.entries.find((entry) => entry.path === NOTE_ABSOLUTE())
    expect(note?.depth).toBe(2)
  })

  test('shell runs a command and returns the host result', async () => {
    const result = (await call('shell', {
      command: 'node',
      args: ['-e', "console.log('shell-ok')"],
    })) as { code: number; stdout: string; stderr: string; truncated: boolean }
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('shell-ok')
    expect(result.truncated).toBe(false)
  })

  test('http reaches a local server through ctx.net', async () => {
    const result = (await call('http', { url: serverUrl })) as {
      status: number
      body: string
      headers: Record<string, string>
    }
    expect(result.status).toBe(201)
    expect(result.body).toBe('tools-ok GET')
    expect(result.headers['content-type']).toBe('text/plain')
  })

  test('relative and absolute paths both resolve', async () => {
    const relative = (await call('write', { path: 'rel/deep.txt', content: 'rel\n' })) as {
      path: string
    }
    expect(relative.path).toBe(join(workspace, 'rel', 'deep.txt'))

    const absolute = (await call('write', {
      path: join(workspace, 'abs.txt'),
      content: 'abs\n',
    })) as { path: string }
    expect(absolute.path).toBe(join(workspace, 'abs.txt'))

    const back = (await call('read', { path: 'abs.txt' })) as { content: string }
    expect(back.content).toBe('abs\n')
  })

  test('a rejected approval stops write before it touches disk', async () => {
    const reject: ApprovalService = { request: async () => 'rejected' }
    const denied = await runtime.beginRun({
      runId: `run_${randomUUID()}`,
      approval: reject,
    })
    try {
      const target = join(workspace, 'denied.txt')
      await expect(
        denied.services.tools.call('write', { path: target, content: 'nope' } as Json),
      ).rejects.toThrow(/approval rejected/)
      await expect(access(target)).rejects.toThrow()
    } finally {
      await denied.dispose()
    }
  })
})
