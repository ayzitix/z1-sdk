import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChatDelta, ChatRequest } from '@z1/node'
import type { ApprovalService, FsService, LlmService, ToolService } from '@z1/runtime'
import {
  DEFAULT_SERVICE_CALL_TIMEOUT_MS,
  ModuleWorker,
  type WorkerHostOptions,
  type WorkerHostServices,
} from '../src/index.ts'

const MODULE_DIR = fileURLToPath(new URL('./fixtures/echo-services', import.meta.url))

const SERVICE_IDS = [
  'llm',
  'tools',
  'fs',
  'pid',
  'crasher',
  'slow',
  'echo-fs',
  'artifacts',
  'memory',
  'bad',
  'bad-llm',
  'workspace',
]

const request: ChatRequest = {
  model: { provider: 'stub', model: 'stub-1' },
  messages: [{ role: 'user', content: 'hello' }],
}

const workers: ModuleWorker[] = []

function createServices(): WorkerHostServices {
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
    chat: async () => {
      throw new Error('unexpected host llm.chat in this test')
    },
  }
  const approval: ApprovalService = {
    request: async () => 'allowed-once',
  }
  return { llm, tools, fs, approval }
}

function createWorker(overrides: Partial<WorkerHostOptions> = {}): ModuleWorker {
  const worker = new ModuleWorker({
    moduleDir: MODULE_DIR,
    entry: 'index.js',
    manifestNodeIds: [],
    manifestServiceIds: SERVICE_IDS,
    capabilities: { fs: { read: ['${moduleDir}/**'] } },
    services: createServices(),
    ...overrides,
  })
  workers.push(worker)
  return worker
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    await worker.dispose().catch(() => undefined)
  }
})

describe('service RPC', () => {
  test('startAll reports the exported service ids and no nodes', async () => {
    const worker = createWorker()
    const started = await worker.startAll()

    expect(started.nodes).toEqual([])
    expect(started.services.map((service) => service.id).sort()).toEqual([...SERVICE_IDS].sort())
    expect(worker.services.map((service) => service.id).sort()).toEqual([...SERVICE_IDS].sort())
    expect(worker.alive).toBe(true)
  }, 20_000)

  test('ctx.workspace defaults to the host cwd, not the module dir', async () => {
    const worker = createWorker()
    await worker.startAll()

    const reported = (await worker.serviceCall('workspace', 'get', [])) as {
      workspace: string
      directory: string
    }
    expect(reported.workspace).toBe(resolve(process.cwd()))
    expect(reported.directory).toBe(MODULE_DIR)
    expect(reported.workspace).not.toBe(reported.directory)
  }, 20_000)

  test('ctx.workspace follows the workspace option', async () => {
    const workspace = resolve(MODULE_DIR, '..')
    const worker = createWorker({ workspace })
    await worker.startAll()

    const reported = (await worker.serviceCall('workspace', 'get', [])) as {
      workspace: string
      directory: string
    }
    expect(reported.workspace).toBe(workspace)
    expect(reported.directory).toBe(MODULE_DIR)
  }, 20_000)

  test('llm.chat streams deltas and returns the final answer', async () => {
    const worker = createWorker()
    await worker.startAll()

    const deltas: ChatDelta[] = []
    const result = await worker.serviceCall('llm', 'chat', [request], {
      onDelta: (delta) => deltas.push(delta as ChatDelta),
    })

    expect(deltas).toEqual([
      { type: 'text', text: 'svc-a' },
      { type: 'text', text: 'svc-b' },
    ])
    expect(result).toEqual({
      message: { role: 'assistant', content: 'svc: hello' },
      toolCalls: [],
      stopReason: 'stop',
    })
  }, 20_000)

  test('tools.call round-trips name and args, tools.list returns the schema list', async () => {
    const worker = createWorker()
    await worker.startAll()

    await expect(worker.serviceCall('tools', 'call', ['echo', { x: 1 }])).resolves.toEqual({
      ok: true,
      name: 'echo',
      args: { x: 1 },
    })
    await expect(worker.serviceCall('tools', 'list', [])).resolves.toEqual([])
  }, 20_000)

  test('pid.get runs in the child process', async () => {
    const worker = createWorker()
    await worker.startAll()

    const result = await worker.serviceCall('pid', 'get', [])
    expect(result).toEqual({ pid: expect.any(Number) })
    expect((result as { pid: number }).pid).not.toBe(process.pid)
  }, 20_000)

  test('a throwing method rejects but leaves the worker usable', async () => {
    const worker = createWorker()
    await worker.startAll()

    await expect(worker.serviceCall('crasher', 'boom', [])).rejects.toThrow(/boom from service/)
    expect(worker.alive).toBe(true)

    await expect(worker.serviceCall('tools', 'call', ['still-here', null])).resolves.toEqual({
      ok: true,
      name: 'still-here',
      args: null,
    })
  }, 20_000)

  test('unknown services, unknown methods, and non-JSON args reject', async () => {
    const worker = createWorker()
    await worker.startAll()

    await expect(worker.serviceCall('nope', 'get', [])).rejects.toThrow(/does not export service/)
    await expect(worker.serviceCall('tools', 'missing', [])).rejects.toThrow(/has no method/)
    await expect(
      worker.serviceCall('tools', 'call', [() => undefined]),
    ).rejects.toThrow(/not JSON/)
    expect(worker.alive).toBe(true)
  }, 20_000)

  test('a timeout cancels the call, rejects, and keeps the worker alive', async () => {
    const worker = createWorker()
    await worker.startAll()

    await expect(
      worker.serviceCall('slow', 'wait', [], { timeoutMs: 200 }),
    ).rejects.toThrow(/exceeded its 200ms timeout/)
    expect(worker.alive).toBe(true)

    await expect(worker.serviceCall('pid', 'get', [])).resolves.toEqual({
      pid: expect.any(Number),
    })
  }, 20_000)

  test('the default timeout is the 300 s tool budget, not 120 s', async () => {
    expect(DEFAULT_SERVICE_CALL_TIMEOUT_MS).toBe(300_000)
    const worker = createWorker()
    await worker.startAll()

    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let settled = false
      const outcome = worker.serviceCall('slow', 'wait', []).then(
        () => {
          settled = true
          return 'resolved'
        },
        (error: unknown) => {
          settled = true
          return error instanceof Error ? error.message : String(error)
        },
      )
      // The pending timer is registered only after `#awaitReady` settles.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(DEFAULT_SERVICE_CALL_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toMatch(/exceeded its 300000ms timeout/)
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)

  test('dispose rejects a pending service call', async () => {
    const worker = createWorker()
    await worker.startAll()

    const pending = worker.serviceCall('slow', 'wait', [])
    const rejection = expect(pending).rejects.toThrow(/disposed/)
    await new Promise((settle) => setTimeout(settle, 50))
    await worker.dispose()

    await rejection
  }, 20_000)

  test('a service-only entry starts under the permission flags', async () => {
    const worker = createWorker({ capabilities: {} })
    const started = await worker.startAll()

    expect(started.nodes).toEqual([])
    expect(started.services).toHaveLength(SERVICE_IDS.length)
    // No fs capability, and the entry itself never reads outside its directory.
    await expect(worker.serviceCall('fs', 'read', ['/etc/passwd'])).rejects.toThrow(
      /not implemented/,
    )
  }, 20_000)
})
