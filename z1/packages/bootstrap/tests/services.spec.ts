import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { graphDigest, parseGraph } from '@z1/graph'
import { ModuleStore, type ModuleManifest } from '@z1/module'
import type { ChatRequest } from '@z1/node'
import { runGraph } from '@z1/runtime'
import type { ApprovalService } from '@z1/runtime'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createRuntime, loadRuntimeConfig, type Runtime } from '../src/index.ts'

let root: string
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-bootstrap-services-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

const approval: ApprovalService = { request: async () => 'allowed-once' }

const request: ChatRequest = {
  model: { provider: 'stub', model: 'stub-1' },
  messages: [{ role: 'user', content: 'hello' }],
}

/** Write an echo-llm source tree and install+activate it in `store`. */
async function installService(
  storeRoot: string,
  id: string,
  version: string,
  label: string,
  disposeKey?: string,
  mode: 'worker' | 'host' = 'host',
): Promise<void> {
  const source = await mkdtemp(join(root, 'src-'))
  const manifest: ModuleManifest = {
    schemaVersion: 1,
    id,
    version,
    title: label,
    license: 'MIT',
    engines: { z1: '>=0.1.0' },
    entry: 'index.js',
    nodes: [],
    services: [
      mode === 'host'
        ? { id: 'llm', kind: 'llm', trusted: true }
        : { id: 'llm', kind: 'llm', mode: 'worker' },
    ],
  }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const counter = JSON.stringify(disposeKey ?? `${id}@${version}`)
  await writeFile(
    join(source, 'index.js'),
    `export const nodes = []
const key = ${counter}
globalThis.__z1ServiceDisposes ??= {}
export const services = {
  llm(ctx) {
    return {
      async chat(request) {
        const users = request.messages.filter((m) => m.role === 'user')
        return {
          message: { role: 'assistant', content: ${JSON.stringify(`${label}: `)} + (users.at(-1)?.content ?? '') },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      dispose() {
        globalThis.__z1ServiceDisposes[key] = (globalThis.__z1ServiceDisposes[key] ?? 0) + 1
        ctx.log('info', 'disposed')
      },
    }
  },
}
`,
  )

  const store = new ModuleStore(storeRoot)
  store.propose(source)
  store.approve(id, version)
  store.activate(id, version)
}

/** Install an arbitrary service-only module; `code` is the whole entry. */
async function installWorkerModule(
  storeRoot: string,
  options: {
    id: string
    version: string
    services: NonNullable<ModuleManifest['services']>
    code: string
  },
): Promise<void> {
  const source = await mkdtemp(join(root, 'src-'))
  const manifest: ModuleManifest = {
    schemaVersion: 1,
    id: options.id,
    version: options.version,
    title: options.id,
    license: 'MIT',
    engines: { z1: '>=0.1.0' },
    entry: 'index.js',
    nodes: [],
    services: options.services,
  }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(source, 'index.js'), options.code)

  const store = new ModuleStore(storeRoot)
  store.propose(source)
  store.approve(options.id, options.version)
  store.activate(options.id, options.version)
}

async function makeRuntime(options: {
  modulesPath: string
  useServiceModules?: boolean
}): Promise<Runtime> {
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      env: {},
      overrides: {
        dbPath: join(root, `runs-${randomUUID()}.db`),
        graphsPath: join(root, 'graphs'),
        modulesPath: options.modulesPath,
        useServiceModules: options.useServiceModules ?? true,
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

async function runAgent(runtime: Runtime): Promise<string> {
  const graph = parseGraph(
    runtime.templates.build('agent.loop', { model: { provider: 'mock', model: 'mock-1' } }),
  )
  const runId = `run_${randomUUID()}`
  const now = Date.now()
  runtime.journal.createRun({
    runId,
    graphId: graph.id,
    graphDigest: graphDigest(graph),
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })
  const handle = await runtime.beginRun({ approval })
  try {
    const result = await runGraph({
      graph,
      registry: handle.registry,
      services: handle.services,
      journal: runtime.journal,
      runId,
      input: 'hello',
    })
    if (result.status !== 'completed') {
      throw new Error(result.error ?? `run ${result.status}`)
    }
    return String(result.outputs['output'] ?? '')
  } finally {
    await handle.dispose()
  }
}

describe('service modules in the composition root', () => {
  test('an approved service module replaces the built-in llm for a chat graph', async () => {
    const modulesPath = join(root, 'store-echo')
    await installService(modulesPath, 'com.example.echo-llm', '1.0.0', 'echo-llm')
    const runtime = await makeRuntime({ modulesPath })

    expect(runtime.serviceModules).toBeDefined()
    expect(await runAgent(runtime)).toBe('echo-llm: hello')
  })

  test('useServiceModules:false falls back to the mock provider', async () => {
    const modulesPath = join(root, 'store-off')
    await installService(modulesPath, 'com.example.echo-llm', '1.0.0', 'echo-llm')
    const runtime = await makeRuntime({ modulesPath, useServiceModules: false })

    expect(runtime.serviceModules).toBeUndefined()
    expect(await runAgent(runtime)).toBe('mock: hello')
  })

  test('the highest version wins when two modules provide the same kind', async () => {
    const modulesPath = join(root, 'store-versions')
    await installService(modulesPath, 'com.example.old-llm', '1.0.0', 'old')
    await installService(modulesPath, 'com.example.new-llm', '2.0.0', 'new')
    const runtime = await makeRuntime({ modulesPath })

    expect(await runAgent(runtime)).toBe('new: hello')
  })

  test('close disposes started service modules', async () => {
    const modulesPath = join(root, 'store-dispose')
    const key = `dispose-${randomUUID()}`
    await installService(modulesPath, 'com.example.dispose-llm', '1.0.0', 'dispose', key)
    const runtime = await makeRuntime({ modulesPath })
    await runAgent(runtime)
    await runtime.close()

    const counters = (globalThis as { __z1ServiceDisposes?: Record<string, number> })
      .__z1ServiceDisposes
    expect(counters?.[key]).toBe(1)
  })

  test('a worker-mode llm service replaces the mock', async () => {
    const modulesPath = join(root, 'store-worker')
    await installService(modulesPath, 'com.example.echo-llm', '1.0.0', 'echo-llm', undefined, 'worker')
    const runtime = await makeRuntime({ modulesPath })

    expect(await runAgent(runtime)).toBe('echo-llm: hello')
  })

  test('a host-mode llm service with an explicit mode still runs in-process', async () => {
    const modulesPath = join(root, 'store-host-mode')
    await installWorkerModule(modulesPath, {
      id: 'com.example.host-llm',
      version: '1.0.0',
      services: [{ id: 'llm', kind: 'llm', mode: 'host', trusted: true }],
      code: `export const services = {
  llm() {
    return {
      async chat() {
        return {
          message: { role: 'assistant', content: 'host-mode: hello' },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
`,
    })
    const runtime = await makeRuntime({ modulesPath })

    expect(await runAgent(runtime)).toBe('host-mode: hello')
  })

  test('a worker service runs in its own process, not the host', async () => {
    const modulesPath = join(root, 'store-worker-pid')
    await installWorkerModule(modulesPath, {
      id: 'com.example.pid-llm',
      version: '1.0.0',
      services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
      code: `export const nodes = []
export const services = {
  llm() {
    return {
      async chat() {
        return {
          message: { role: 'assistant', content: 'pid: ' + process.pid },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
`,
    })
    const runtime = await makeRuntime({ modulesPath })

    const answer = await runAgent(runtime)
    const match = /^pid: (\d+)$/.exec(answer)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).not.toBe(process.pid)
  })

  test('a throwing worker service fails the run but leaves the runtime usable', async () => {
    const modulesPath = join(root, 'store-worker-crash')
    await installWorkerModule(modulesPath, {
      id: 'com.example.crash-llm',
      version: '1.0.0',
      services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
      code: `export const nodes = []
export const services = {
  llm() {
    return {
      async chat() {
        throw new Error('boom worker service')
      },
    }
  },
}
`,
    })
    const runtime = await makeRuntime({ modulesPath })

    await expect(runAgent(runtime)).rejects.toThrow(/boom worker service/)
    // Second attempt: still a clean rejection, not a dead handle or crash.
    await expect(runAgent(runtime)).rejects.toThrow(/boom worker service/)
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  test('a failing service startup rolls back and can be retried', async () => {
    const modulesPath = join(root, 'store-worker-broken')
    await installWorkerModule(modulesPath, {
      id: 'com.example.broken-llm',
      version: '2.0.0',
      services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
      code: `throw new Error('cannot load')
export const nodes = []
`,
    })
    const runtime = await makeRuntime({ modulesPath })

    await expect(runAgent(runtime)).rejects.toThrow(/cannot start service modules/)
    // Remove the broken module from the store; the cached failure must be gone
    // so the next run starts from scratch and falls back to the mock.
    rmSync(join(modulesPath, 'modules', 'com.example.broken-llm'), {
      recursive: true,
      force: true,
    })
    expect(await runAgent(runtime)).toBe('mock: hello')
  })

  test('close is idempotent with worker services', async () => {
    const modulesPath = join(root, 'store-worker-close')
    await installService(modulesPath, 'com.example.echo-llm', '1.0.0', 'echo-llm', undefined, 'worker')
    const runtime = await makeRuntime({ modulesPath })
    await runAgent(runtime)

    await expect(runtime.close()).resolves.toBeUndefined()
    await expect(runtime.close()).resolves.toBeUndefined()
  })
})
