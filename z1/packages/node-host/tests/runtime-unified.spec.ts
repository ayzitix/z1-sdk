import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type {
  InstalledModule,
  ModuleCapabilities,
  ModuleServiceDeclaration,
} from '@z1/module'
import { ModuleStore } from '@z1/module'
import type { ChatRequest, Json, NodeContext } from '@z1/node'
import type { NodeRegistry } from '@z1/node'
import type {
  ApprovalService,
  FsService,
  LlmService,
  ToolService,
} from '@z1/runtime'
import {
  ModuleRuntime,
  type WorkerHostServices,
  type WorkerLogEvent,
} from '../src/index.ts'

const UNIFIED = fileURLToPath(new URL('./fixtures/unified', import.meta.url))
const SERVICE_ONLY = fileURLToPath(new URL('./fixtures/service-only', import.meta.url))
const BAD_SERVICE = fileURLToPath(new URL('./fixtures/bad-service', import.meta.url))
const NODE_BAD_SERVICE = fileURLToPath(
  new URL('./fixtures/node-bad-service', import.meta.url),
)

const UNIFIED_ID = 'com.example.unified'
const SERVICE_ONLY_ID = 'com.example.service-only'
const BAD_SERVICE_ID = 'com.example.bad-service'
const NODE_BAD_ID = 'com.example.node-bad'

const UNIFIED_PID_NODE = 'com.example.unified.pid'
const NODE_BAD_PID_NODE = 'com.example.node-bad.ping'

const request: ChatRequest = {
  model: { provider: 'stub', model: 'stub-1' },
  messages: [{ role: 'user', content: 'hi' }],
}

interface Harness {
  store: ModuleStore
  runtime: ModuleRuntime
  logs: WorkerLogEvent[]
}

const roots: string[] = []
const runtimes: ModuleRuntime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.dispose().catch(() => undefined)
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function hostServices(logs: WorkerLogEvent[]): WorkerHostServices {
  const fs: FsService = {
    read: async () => {
      throw new Error('host fs.read is not stubbed in this test')
    },
    write: async () => {
      throw new Error('host fs.write is not stubbed in this test')
    },
  }
  const tools: ToolService = {
    call: async () => null,
    list: async () => [],
  }
  const llm: LlmService = {
    chat: async () => ({
      message: { role: 'assistant', content: 'host-pong' },
      toolCalls: [],
      stopReason: 'stop',
    }),
  }
  const approval: ApprovalService = { request: async () => 'allowed-once' }
  return { llm, tools, fs, approval, onLog: (event) => logs.push(event) }
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'z1-runtime-'))
  roots.push(root)
  const store = new ModuleStore(root)
  const logs: WorkerLogEvent[] = []
  const runtime = new ModuleRuntime({ store, services: hostServices(logs) })
  runtimes.push(runtime)
  return { store, runtime, logs }
}

function installModule(
  store: ModuleStore,
  source: string,
  options: {
    capabilities?: ModuleCapabilities
    services?: ModuleServiceDeclaration[]
  } = {},
): InstalledModule {
  const proposed = store.propose(source)
  const { id, version } = proposed.manifest
  const installed = store.install(id, version, {
    capabilities: options.capabilities ?? proposed.manifest.capabilities ?? {},
    services: options.services ?? proposed.manifest.services ?? [],
    futureVersions: false,
  })
  return store.activate(id)
}

async function runNode(
  registry: NodeRegistry,
  id: string,
  version = '1.0.0',
): Promise<Record<string, unknown>> {
  const definition = registry.get(id, version)
  if (definition === undefined) throw new Error(`node "${id}"@${version} is not registered`)
  const ctx = {
    runId: 'run-1',
    nodeId: id,
    path: id,
    attempt: 0,
    input: {} as Json,
    config: {},
    signal: new AbortController().signal,
    log: () => {},
    emit: () => {},
  } as unknown as NodeContext<unknown>
  return (await definition.execute(ctx)) as Record<string, unknown>
}

/** Direct children of this process, from procfs (empty when unavailable). */
function childPids(): number[] {
  const pids = new Set<number>()
  let threads: string[]
  try {
    threads = readdirSync('/proc/self/task')
  } catch {
    return []
  }
  for (const thread of threads) {
    // Children are attributed to the thread that spawned them, and vitest may
    // run the test body on a worker thread, so every thread is inspected.
    try {
      const raw = readFileSync(`/proc/self/task/${thread}/children`, 'utf8')
      for (const entry of raw.split(/\s+/)) {
        if (entry.length > 0) pids.add(Number(entry))
      }
    } catch {
      // The thread exited between listing and reading; nothing to add.
    }
  }
  return [...pids]
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((settle) => setTimeout(settle, 25))
  }
  throw new Error('condition was not met in time')
}

describe('one worker per module', () => {
  test('a node and its llm service share exactly one child', async () => {
    const { store, runtime } = await harness()
    installModule(store, UNIFIED, {
      // The manifest grants only "manifest-only"; the grant says "stub", so a
      // successful chat proves the child's capabilities came from the grant.
      capabilities: { llm: { providers: ['stub'] } },
    })

    const registry = await runtime.start()
    const worker = runtime.workerFor(UNIFIED_ID)
    expect(worker).toBeDefined()
    expect(worker?.alive).toBe(true)

    const outputs = await runNode(registry, UNIFIED_PID_NODE)
    expect(typeof outputs['pid']).toBe('string')
    const nodePid = String(outputs['pid'])

    const service = runtime.servicesFor(UNIFIED_ID)['llm']
    expect(service?.kind).toBe('llm')
    const chat = await (service?.instance as LlmService).chat(request)
    expect(chat.message.content).toBe(nodePid)

    // One child process, and it is the pid both the node and the service saw.
    const children = childPids()
    if (children.length > 0) expect(children).toEqual([Number(nodePid)])

    // start() is idempotent: same registry, still one child.
    expect(await runtime.start()).toBe(registry)
    if (children.length > 0) expect(childPids()).toEqual([Number(nodePid)])
  }, 30_000)

  test('a declared service whose factory throws fails the module start', async () => {
    const { store, runtime } = await harness()
    installModule(store, BAD_SERVICE)

    // One start attempt: it must name the module and the failing service, then
    // leave the runtime disposed (a failed start is all-or-nothing).
    let failure: unknown
    try {
      await runtime.start()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toMatch(/cannot start module "com\.example\.bad-service"@1\.0\.0/)
    expect(message).toMatch(/bad-service factory exploded/)
    expect(runtime.workerFor(BAD_SERVICE_ID)).toBeUndefined()
    await expect(runtime.start()).rejects.toThrow(/disposed/)
  }, 30_000)

  test('a node-only module never reads its entry services', async () => {
    const { store, runtime } = await harness()
    // The manifest declares no services, so the grant approves none; the entry
    // still exports a throwing `llm` factory that must never be called.
    installModule(store, NODE_BAD_SERVICE)

    const registry = await runtime.start()
    expect(runtime.servicesFor(NODE_BAD_ID)).toEqual({})
    await expect(runNode(registry, NODE_BAD_PID_NODE)).resolves.toEqual({ pong: true })
    expect(runtime.workerFor(NODE_BAD_ID)?.alive).toBe(true)
  }, 30_000)

  test('a service-only module spawns a worker for its service', async () => {
    const { store, runtime } = await harness()
    installModule(store, SERVICE_ONLY, { capabilities: { llm: true } })

    const registry = await runtime.start()
    expect(registry.list()).toEqual([])

    const worker = runtime.workerFor(SERVICE_ONLY_ID)
    expect(worker?.alive).toBe(true)
    expect(worker?.nodes).toEqual([])

    const services = runtime.servicesFor(SERVICE_ONLY_ID)
    expect(Object.keys(services)).toEqual(['llm'])
    const chat = await (services['llm']?.instance as LlmService).chat(request)
    expect(typeof chat.message.content).toBe('string')
    expect(chat.message.content).toMatch(/^\d+$/)
  }, 30_000)
})

describe('respawn after a crash', () => {
  test('workerFor and servicesFor respawn lazily with a new pid', async () => {
    const { store, runtime } = await harness()
    installModule(store, UNIFIED, { capabilities: { llm: true } })
    const registry = await runtime.start()

    const worker = runtime.workerFor(UNIFIED_ID)
    if (worker === undefined) throw new Error('unified module did not load')
    const firstPid = Number((await runNode(registry, UNIFIED_PID_NODE))['pid'])

    process.kill(firstPid, 'SIGKILL')
    await waitFor(() => worker.state === 'dead')
    expect(worker.alive).toBe(false)

    // Any node execution goes through the definition's worker getter, which
    // respawns; a service call does the same on the adapter path.
    const respawned = runtime.workerFor(UNIFIED_ID)
    expect(respawned).toBeDefined()
    expect(respawned).not.toBe(worker)

    const chat = await (
      runtime.servicesFor(UNIFIED_ID)['llm']?.instance as LlmService
    ).chat(request)
    const secondPid = Number(chat.message.content)
    expect(secondPid).not.toBe(firstPid)

    const outputs = await runNode(registry, UNIFIED_PID_NODE)
    expect(Number(outputs['pid'])).toBe(secondPid)
    expect(respawned?.alive).toBe(true)
  }, 40_000)
})

describe('dispose', () => {
  test('runs the service dispose hook, kills the child, and is idempotent', async () => {
    const { store, runtime, logs } = await harness()
    installModule(store, UNIFIED, { capabilities: { llm: true } })
    const registry = await runtime.start()

    const worker = runtime.workerFor(UNIFIED_ID)
    if (worker === undefined) throw new Error('unified module did not load')
    const childPid = Number((await runNode(registry, UNIFIED_PID_NODE))['pid'])
    expect(childPids()).toContain(childPid)
    expect(logs.some((line) => line.message === 'unified-llm-dispose')).toBe(false)

    await runtime.dispose()

    expect(logs.some((line) => line.message === 'unified-llm-dispose')).toBe(true)
    expect(worker.alive).toBe(false)
    expect(() => process.kill(childPid, 0)).toThrow()
    expect(runtime.workerFor(UNIFIED_ID)).toBeUndefined()
    expect(runtime.servicesFor(UNIFIED_ID)).toEqual({})

    await expect(runtime.dispose()).resolves.toBeUndefined()
    await expect(runtime.start()).rejects.toThrow(/disposed/)
  }, 30_000)
})

describe('the grant decides', () => {
  test('a service the grant omits is not started', async () => {
    const { store, runtime } = await harness()
    // The manifest declares `llm`; the grant approves no services at all.
    installModule(store, SERVICE_ONLY, { capabilities: { llm: true }, services: [] })

    await runtime.start()
    expect(runtime.workerFor(SERVICE_ONLY_ID)).toBeUndefined()
    expect(runtime.servicesFor(SERVICE_ONLY_ID)).toEqual({})
  }, 30_000)

  test('capabilities come from the grant, not the manifest', async () => {
    const { store, runtime } = await harness()
    // A grant without `llm` while the manifest grants "manifest-only".
    installModule(store, UNIFIED, { capabilities: {} })
    const registry = await runtime.start()

    // The node needs nothing, so it still runs.
    await expect(runNode(registry, UNIFIED_PID_NODE)).resolves.toHaveProperty('pid')

    const llm = runtime.servicesFor(UNIFIED_ID)['llm']?.instance as LlmService
    await expect(llm.chat(request)).rejects.toThrow(/capability "llm" not granted/)
    expect(runtime.workerFor(UNIFIED_ID)?.alive).toBe(true)
  }, 30_000)
})
