import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    services: [{ id: 'llm', kind: 'llm', trusted: true }],
  }
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const counter = JSON.stringify(disposeKey ?? `${id}@${version}`)
  await writeFile(
    join(source, 'index.js'),
    `const key = ${counter}
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
})
