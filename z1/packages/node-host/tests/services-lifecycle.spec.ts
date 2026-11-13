import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { ApprovalRequest } from '@z1/node'
import type { ApprovalService, FsService, LlmService, ToolService } from '@z1/runtime'
import {
  ModuleWorker,
  type WorkerHostOptions,
  type WorkerHostServices,
} from '../src/index.ts'

const EXTRAS = fileURLToPath(new URL('./fixtures/service-extras', import.meta.url))
const GETTER = fileURLToPath(new URL('./fixtures/service-getter', import.meta.url))
const NODE_BAD = fileURLToPath(new URL('./fixtures/node-bad-service', import.meta.url))

const EXTRAS_SERVICES = ['llm', 'tools', 'getter', 'dispose', 'dispose-thrower']
const GETTER_SERVICES = ['getter']

const approvalRequest: ApprovalRequest = { action: 'tool.call', target: 'echo' }

const workers: ModuleWorker[] = []
const cleanup: string[] = []

function tempLog(): string {
  const path = join(
    tmpdir(),
    `z1-dispose-${String(process.pid)}-${Math.random().toString(36).slice(2)}.log`,
  )
  cleanup.push(path)
  return path
}

function hostServices(overrides: Partial<WorkerHostServices> = {}): WorkerHostServices {
  const fs: FsService = {
    read: async () => {
      throw new Error('host fs.read is not stubbed in this test')
    },
    write: async () => {
      throw new Error('host fs.write is not stubbed in this test')
    },
  }
  const tools: ToolService = {
    call: async (name, args) => ({ called: name, args }),
    list: async () => [],
  }
  const llm: LlmService = {
    chat: async () => ({
      message: { role: 'assistant', content: 'pong' },
      toolCalls: [],
      stopReason: 'stop',
    }),
  }
  const approval: ApprovalService = { request: async () => 'allowed-once' }
  return { llm, tools, fs, approval, ...overrides }
}

function createWorker(options: Partial<WorkerHostOptions> & Pick<WorkerHostOptions, 'moduleDir' | 'entry' | 'manifestNodeIds'>): ModuleWorker {
  const worker = new ModuleWorker({
    capabilities: {},
    services: hostServices(),
    ...options,
  })
  workers.push(worker)
  return worker
}

function extras(overrides: Partial<WorkerHostOptions> = {}): ModuleWorker {
  return createWorker({
    moduleDir: EXTRAS,
    entry: 'index.js',
    manifestNodeIds: [],
    manifestServiceIds: EXTRAS_SERVICES,
    ...overrides,
  })
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    await worker.dispose().catch(() => undefined)
  }
  for (const path of cleanup.splice(0)) {
    await rm(path, { force: true }).catch(() => undefined)
  }
})

describe('service loading is opt-in for node workers', () => {
  test('loadServices:false never reads services; the node still runs', async () => {
    const worker = createWorker({
      moduleDir: NODE_BAD,
      entry: 'index.js',
      manifestNodeIds: ['com.example.node-bad.ping'],
      // `services.llm` throws: reading it at all would kill the handshake.
      loadServices: false,
      services: hostServices(),
    })

    const started = await worker.startAll()
    expect(started.services).toEqual([])
    expect(started.nodes.map((node) => node.id)).toEqual(['com.example.node-bad.ping'])

    await expect(worker.execute('com.example.node-bad.ping', {}, {}, null)).resolves.toEqual({
      pong: true,
    })
    expect(worker.alive).toBe(true)
  }, 20_000)

  test('a service-only entry may omit `nodes` when loadServices is true', async () => {
    const worker = extras()
    const started = await worker.startAll()

    expect(started.nodes).toEqual([])
    expect(started.services.map((service) => service.id).sort()).toEqual(
      [...EXTRAS_SERVICES].sort(),
    )
  }, 20_000)
})

describe('dispose RPC', () => {
  test('dispose() lets services release resources before the child is killed', async () => {
    const log = tempLog()
    const worker = extras({
      env: { DISPOSE_LOG: log },
      capabilities: { fs: { write: [log] } },
    })
    await worker.startAll()

    const before = await readFile(log, 'utf8').catch(() => '')
    expect(before).toBe('')

    // `dispose-thrower` rejects; that must not stop `dispose` or the writer.
    await expect(worker.dispose()).resolves.toBeUndefined()
    const after = await readFile(log, 'utf8')
    expect(after).toBe('dispose\n')
  }, 20_000)
})

describe('service approval bridge', () => {
  test('an allowed decision returns the decision and carries the runId', async () => {
    const seen: Array<{ runId: string; nodeId: string }> = []
    const resolver: ApprovalService = {
      request: async (_request, context) => {
        seen.push(context)
        return 'allowed-once'
      },
    }
    const worker = extras({ services: hostServices({ approvalFor: () => resolver }) })
    await worker.startAll()

    await expect(
      worker.serviceCall('llm', 'approval', [approvalRequest], { runId: 'r1' }),
    ).resolves.toEqual({ decision: 'allowed-once' })
    expect(seen).toEqual([{ runId: 'r1', nodeId: 'module' }])
  }, 20_000)

  test('a refused decision surfaces as an error inside the service', async () => {
    const resolver: ApprovalService = { request: async () => 'rejected' }
    const worker = extras({ services: hostServices({ approvalFor: () => resolver }) })
    await worker.startAll()

    await expect(
      worker.serviceCall('llm', 'approval', [approvalRequest], { runId: 'r1' }),
    ).rejects.toThrow(/approval was rejected/)

    // The service can observe the refusal too, not just see a dropped call.
    const caught = await worker.serviceCall('llm', 'tryApproval', [approvalRequest], {
      runId: 'r1',
    })
    expect(caught).toEqual({ error: expect.stringMatching(/approval was rejected/) })
    expect(worker.alive).toBe(true)
  }, 20_000)

  test('without approvalFor a service approval is refused', async () => {
    const worker = extras()
    await worker.startAll()

    await expect(
      worker.serviceCall('llm', 'approval', [approvalRequest], { runId: 'r1' }),
    ).rejects.toThrow(/approval.request is not available for run "r1"/)
  }, 20_000)
})

describe('manifest capability gates for services', () => {
  test('ctx.tools.call is denied without capabilities.tools and allowed with names', async () => {
    const denied = extras()
    await denied.startAll()
    await expect(denied.serviceCall('tools', 'call', ['echo'])).rejects.toThrow(
      /capability "tools" not granted/,
    )

    const granted = extras({ capabilities: { tools: { names: ['echo'] } } })
    await granted.startAll()
    await expect(granted.serviceCall('tools', 'call', ['echo'])).resolves.toEqual({
      called: 'echo',
      args: { x: 1 },
    })
    await expect(granted.serviceCall('tools', 'call', ['other'])).rejects.toThrow(
      /capability "tools" not granted/,
    )
  }, 20_000)

  test('ctx.llm.chat is denied without capabilities.llm and allowed by provider', async () => {
    const denied = extras()
    await denied.startAll()
    await expect(denied.serviceCall('llm', 'chat', ['mock'])).rejects.toThrow(
      /capability "llm" not granted/,
    )

    const granted = extras({ capabilities: { llm: { providers: ['mock'] } } })
    await granted.startAll()
    await expect(granted.serviceCall('llm', 'chat', ['mock'])).resolves.toEqual({ text: 'pong' })
    await expect(granted.serviceCall('llm', 'chat', ['other'])).rejects.toThrow(
      /capability "llm" not granted/,
    )
  }, 20_000)
})

describe('ctx.get is module-scoped', () => {
  test('a module sees its own services only', async () => {
    const a = extras()
    await a.startAll()
    await expect(a.serviceCall('getter', 'lookup', ['llm'])).resolves.toEqual({ found: true })

    const b = createWorker({
      moduleDir: GETTER,
      entry: 'index.js',
      manifestNodeIds: [],
      manifestServiceIds: GETTER_SERVICES,
    })
    await b.startAll()
    // `llm` exists in module A, but never in module B's context.
    await expect(b.serviceCall('getter', 'lookup', ['llm'])).resolves.toEqual({ found: false })
    await expect(b.serviceCall('getter', 'lookup', ['getter'])).resolves.toEqual({ found: true })
  }, 20_000)
})

describe('service cancellation', () => {
  test('a timed-out call aborts ctx.signal inside the service', async () => {
    const worker = extras()
    await worker.startAll()

    await expect(
      worker.serviceCall('llm', 'watch', [], { timeoutMs: 250 }),
    ).rejects.toThrow(/exceeded its 250ms timeout/)
    expect(worker.alive).toBe(true)

    let observed = false
    for (let attempt = 0; attempt < 20 && !observed; attempt += 1) {
      const status = (await worker.serviceCall('llm', 'status', [])) as { aborted: boolean }
      observed = status.aborted
      if (!observed) await new Promise((settle) => setTimeout(settle, 25))
    }
    expect(observed).toBe(true)
  }, 20_000)
})
