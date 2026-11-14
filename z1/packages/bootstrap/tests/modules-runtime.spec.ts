import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { graphDigest, parseGraph, type GraphDocument } from '@z1/graph'
import { ModuleStore, type ModuleManifest } from '@z1/module'
import type { Json } from '@z1/node'
import { runGraph } from '@z1/runtime'
import type { ApprovalService, LlmService, RunResult } from '@z1/runtime'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { createRuntime, loadRuntimeConfig, type Runtime, type RunHandle } from '../src/index.ts'

let root: string
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-bootstrap-modules-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  rmSync(root, { recursive: true, force: true })
})

const allowAll: ApprovalService = { request: async () => 'allowed-once' }

/** Write a module source tree; `entry` is the whole `index.js`. */
async function moduleSource(
  manifest: Omit<ModuleManifest, 'schemaVersion' | 'license' | 'engines'>,
  entry: string,
): Promise<string> {
  const source = await mkdtemp(join(root, 'src-'))
  const document: ModuleManifest = {
    schemaVersion: 1,
    license: 'MIT',
    engines: { z1: '>=0.1.0' },
    ...manifest,
  }
  await writeFile(join(source, 'z1.module.json'), JSON.stringify(document, null, 2))
  await writeFile(join(source, 'index.js'), entry)
  return source
}

async function installModule(
  modulesPath: string,
  source: string,
  options: {
    id: string
    version: string
    /** Explicit grant; omit to approve exactly what the manifest requests. */
    grant?: { services: NonNullable<ModuleManifest['services']> }
  },
): Promise<void> {
  const store = new ModuleStore(modulesPath)
  store.propose(source)
  if (options.grant === undefined) {
    store.approve(options.id, options.version)
  } else {
    store.install(options.id, options.version, {
      capabilities: {},
      services: options.grant.services,
      futureVersions: false,
    })
  }
  store.activate(options.id, options.version)
}

async function makeRuntime(
  modulesPath: string,
  overrides: { useModules?: boolean; useServiceModules?: boolean } = {},
): Promise<Runtime> {
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      env: {},
      overrides: {
        dbPath: join(root, `runs-${randomUUID()}.db`),
        graphsPath: join(root, 'graphs'),
        modulesPath,
        ...(overrides.useModules === undefined ? {} : { useModules: overrides.useModules }),
        ...(overrides.useServiceModules === undefined
          ? {}
          : { useServiceModules: overrides.useServiceModules }),
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

/** `input` -> `z1.llm.chat` -> `z1.core.output`: the shortest service path. */
function chatGraph(): GraphDocument {
  return parseGraph({
    schemaVersion: 1,
    id: 'chat',
    nodes: [
      { id: 'input', type: 'z1.core.input', version: '1.0.0', config: {}, position: { x: 0, y: 0 } },
      { id: 'chat', type: 'z1.llm.chat', version: '1.0.0', config: { model: { provider: 'mock', model: 'mock-1' } }, position: { x: 200, y: 0 } },
      { id: 'out', type: 'z1.core.output', version: '1.0.0', config: {}, position: { x: 400, y: 0 } },
    ],
    edges: [
      {
        id: 'd-in-prompt',
        kind: 'data',
        from: { node: 'input', port: 'value' },
        to: { node: 'chat', port: 'prompt' },
      },
      {
        id: 'd-chat-text',
        kind: 'data',
        from: { node: 'chat', port: 'text' },
        to: { node: 'out', port: 'value' },
      },
      {
        id: 'f-in-chat',
        kind: 'flow',
        from: { node: 'input', port: 'out' },
        to: { node: 'chat', port: 'in' },
      },
      {
        id: 'f-chat-out',
        kind: 'flow',
        from: { node: 'chat', port: 'out' },
        to: { node: 'out', port: 'in' },
      },
    ],
  })
}

/** `node` -> `z1.core.output`: executes a module node and returns its value. */
function moduleNodeGraph(type: string): GraphDocument {
  return parseGraph({
    schemaVersion: 1,
    id: 'module-node',
    nodes: [
      { id: 'node', type, version: '1.0.0', config: {}, position: { x: 0, y: 0 } },
      { id: 'out', type: 'z1.core.output', version: '1.0.0', config: {}, position: { x: 200, y: 0 } },
    ],
    edges: [
      {
        id: 'd-node-value',
        kind: 'data',
        from: { node: 'node', port: 'value' },
        to: { node: 'out', port: 'value' },
      },
      {
        id: 'f-node-out',
        kind: 'flow',
        from: { node: 'node', port: 'out' },
        to: { node: 'out', port: 'in' },
      },
    ],
  })
}

async function run(
  runtime: Runtime,
  graph: GraphDocument,
  options: {
    runId?: string
    input?: Json
    approval?: ApprovalService
    useServiceModules?: boolean
    /** Called with the handle before the graph runs. */
    onHandle?: (handle: RunHandle, runId: string) => void | Promise<void>
  } = {},
): Promise<RunResult> {
  const runId = options.runId ?? `run_${randomUUID()}`
  const now = Date.now()
  runtime.journal.createRun({
    runId,
    graphId: graph.id,
    graphDigest: graphDigest(graph),
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })
  const handle = await runtime.beginRun({
    runId,
    approval: options.approval ?? allowAll,
    ...(options.useServiceModules === undefined
      ? {}
      : { useServiceModules: options.useServiceModules }),
  })
  try {
    await options.onHandle?.(handle, runId)
    return await runGraph({
      graph,
      registry: handle.registry,
      services: handle.services,
      journal: runtime.journal,
      runId,
      input: options.input ?? 'hello',
    })
  } finally {
    await handle.dispose()
  }
}

async function runText(runtime: Runtime, options: Parameters<typeof run>[2] = {}): Promise<string> {
  const result = await run(runtime, chatGraph(), options)
  if (result.status !== 'completed') throw new Error(result.error ?? `run ${result.status}`)
  return String(result.outputs['output'] ?? '')
}

const PID_SERVICE = `
export const nodes = []
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
`

describe('a module is only runnable when it was granted', () => {
  test('an installed version with no grant entry is not active and is not loaded', async () => {
    const modulesPath = join(root, 'store-ungranted')
    const source = await moduleSource(
      {
        id: 'com.example.sneaky',
        version: '1.0.0',
        title: 'sneaky',
        entry: 'index.js',
        nodes: [
          {
            id: 'com.example.sneaky.node',
            version: '1.0.0',
            title: 'Node',
            category: 'example',
            inputs: [],
            outputs: [{ kind: 'data', id: 'value' }],
          },
        ],
      },
      `export const nodes = [{
  id: 'com.example.sneaky.node',
  version: '1.0.0',
  title: 'Node',
  category: 'example',
  inputs: [],
  outputs: [{ kind: 'data', id: 'value' }],
  async execute() { return { value: 'ran without a grant' } },
}]
`,
    )
    await installModule(modulesPath, source, { id: 'com.example.sneaky', version: '1.0.0' })

    // Simulate a tampered store: the version stays "active", the grant is gone.
    const statePath = join(modulesPath, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
    state['grants'] = []
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')

    const runtime = await makeRuntime(modulesPath)
    const installed = runtime.modules.get('com.example.sneaky', '1.0.0')
    expect(installed).toBeDefined()
    expect(installed?.active).toBe(false)
    expect(runtime.registry.has('com.example.sneaky.node', '1.0.0')).toBe(false)

    // And a graph that names the node cannot run it.
    const result = await run(runtime, moduleNodeGraph('com.example.sneaky.node'))
    expect(result.status).toBe('failed')
  })
})

describe('module node model traffic', () => {
  test("a module node's chat is journaled under its run and path", async () => {
    const modulesPath = join(root, 'store-talk')
    const source = await moduleSource(
      {
        id: 'com.example.talk',
        version: '1.0.0',
        title: 'talk',
        entry: 'index.js',
        nodes: [
          {
            id: 'com.example.talk.chat',
            version: '1.0.0',
            title: 'Chat',
            category: 'example',
            inputs: [],
            outputs: [
              { kind: 'data', id: 'value' },
              { kind: 'flow', id: 'out' },
            ],
          },
        ],
      },
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
    )
    // The manifest gate: a node may call the provider the grant names.
    const store = new ModuleStore(modulesPath)
    store.propose(source)
    store.install('com.example.talk', '1.0.0', {
      capabilities: { llm: { providers: ['mock'] } },
      futureVersions: false,
    })
    store.activate('com.example.talk', '1.0.0')

    const runtime = await makeRuntime(modulesPath)
    const runId = `run_${randomUUID()}`
    const result = await run(runtime, moduleNodeGraph('com.example.talk.chat'), { runId })
    expect(result.status).toBe('completed')

    const events = runtime.journal
      .ownedEvents(runId)
      .map((entry) => entry.event)
      .filter((event) => event.type.startsWith('llm.'))
    expect(events.map((event) => event.type)).toEqual(['llm.request', 'llm.response'])
    const [request, response] = events
    expect(request?.type === 'llm.request' ? request.path : undefined).toBe('node')
    expect(request?.type === 'llm.request' ? request.provider : undefined).toBe('mock')
    expect(response?.type === 'llm.response' ? response.path : undefined).toBe('node')
    expect(response?.type === 'llm.response' ? response.latencyMs : undefined).toBeGreaterThanOrEqual(0)
  })
})

describe('persistent module runtime', () => {
  test('one child hosts nodes and services across runs', async () => {
    const modulesPath = join(root, 'store-duo')
    const source = await moduleSource(
      {
        id: 'com.example.duo',
        version: '1.0.0',
        title: 'duo',
        entry: 'index.js',
        nodes: [
          {
            id: 'com.example.duo.pid',
            version: '1.0.0',
            title: 'Pid',
            category: 'example',
            inputs: [],
            outputs: [
              { kind: 'data', id: 'value' },
              { kind: 'flow', id: 'out' },
            ],
          },
        ],
        services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
      },
      `export const nodes = [{
  id: 'com.example.duo.pid',
  version: '1.0.0',
  title: 'Pid',
  category: 'example',
  inputs: [],
  outputs: [{ kind: 'data', id: 'value' }, { kind: 'flow', id: 'out' }],
  async execute() {
    return { value: String(process.pid), out: true }
  },
}]
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
    )
    await installModule(modulesPath, source, { id: 'com.example.duo', version: '1.0.0' })
    const runtime = await makeRuntime(modulesPath)

    const first = await runText(runtime)
    const second = await runText(runtime)
    expect(first).toMatch(/^pid: \d+$/)
    // Two beginRun calls, one child: the service pid is identical.
    expect(second).toBe(first)

    const servicePid = first.replace('pid: ', '')
    const node = await run(runtime, moduleNodeGraph('com.example.duo.pid'))
    expect(node.status).toBe('completed')
    expect(node.outputs['output']).toBe(servicePid)

    // close() is idempotent and disposes once (the dispose counter in
    // `services.spec.ts` covers host services; here the promise just settles).
    await expect(runtime.close()).resolves.toBeUndefined()
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  test('useModules:false ignores a legacy host service', async () => {
    const modulesPath = join(root, 'store-nomodules')
    const source = await moduleSource(
      {
        id: 'com.example.legacy-llm',
        version: '1.0.0',
        title: 'legacy',
        entry: 'index.js',
        nodes: [],
        services: [{ id: 'llm', kind: 'llm', trusted: true }],
      },
      `export const nodes = []
export const services = {
  llm() {
    return {
      async chat() {
        return {
          message: { role: 'assistant', content: 'legacy: hello' },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
`,
    )
    await installModule(modulesPath, source, { id: 'com.example.legacy-llm', version: '1.0.0' })
    const runtime = await makeRuntime(modulesPath, { useModules: false })

    expect(await runText(runtime)).toBe('mock: hello')
  })

  test('a per-run switch turns a service module on and off', async () => {
    const modulesPath = join(root, 'store-perswitch')
    const source = await moduleSource(
      {
        id: 'com.example.switch-llm',
        version: '1.0.0',
        title: 'switch',
        entry: 'index.js',
        nodes: [],
        services: [{ id: 'llm', kind: 'llm', trusted: true }],
      },
      `export const nodes = []
export const services = {
  llm() {
    return {
      async chat() {
        return {
          message: { role: 'assistant', content: 'service: hello' },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
`,
    )
    await installModule(modulesPath, source, { id: 'com.example.switch-llm', version: '1.0.0' })
    const runtime = await makeRuntime(modulesPath)

    expect(await runText(runtime, { useServiceModules: false })).toBe('mock: hello')
    // Nothing was cached from the first run: the second uses the service.
    expect(await runText(runtime, { useServiceModules: true })).toBe('service: hello')
  })

  test('a grant that omits the service does not start it', async () => {
    const modulesPath = join(root, 'store-narrow')
    const source = await moduleSource(
      {
        id: 'com.example.narrow-llm',
        version: '1.0.0',
        title: 'narrow',
        entry: 'index.js',
        nodes: [],
        services: [{ id: 'llm', kind: 'llm', trusted: true }],
      },
      `export const nodes = []
export const services = {
  llm() {
    return {
      async chat() {
        return {
          message: { role: 'assistant', content: 'narrow: hello' },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
`,
    )
    await installModule(modulesPath, source, {
      id: 'com.example.narrow-llm',
      version: '1.0.0',
      grant: { services: [] },
    })
    const runtime = await makeRuntime(modulesPath)

    // The manifest requests an llm; the grant approves none.
    expect(await runText(runtime)).toBe('mock: hello')
    const installed = runtime.modules.get('com.example.narrow-llm')
    expect(installed?.manifest.services).toHaveLength(1)
    expect(installed?.grant.services).toHaveLength(0)
  })

  test('a crashed child is respawned for the next run', async () => {
    const modulesPath = join(root, 'store-crash')
    const source = await moduleSource(
      {
        id: 'com.example.crashy',
        version: '1.0.0',
        title: 'crashy',
        entry: 'index.js',
        nodes: [],
        services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
      },
      `export const nodes = []
export const services = {
  llm() {
    return {
      async chat(request) {
        const text = String(request.messages.at(-1)?.content ?? '')
        if (text.includes('boom')) process.exit(1)
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
    )
    await installModule(modulesPath, source, { id: 'com.example.crashy', version: '1.0.0' })
    const runtime = await makeRuntime(modulesPath)

    const before = await runText(runtime, { input: 'hi' })
    await expect(runText(runtime, { input: 'boom' })).rejects.toThrow()
    const after = await runText(runtime, { input: 'hi' })

    expect(after).toMatch(/^pid: \d+$/)
    expect(after).not.toBe(before)
  })

  test('worker service approvals reach the run and are unregistered on dispose', async () => {
    const modulesPath = join(root, 'store-approval')
    const source = await moduleSource(
      {
        id: 'com.example.ask-llm',
        version: '1.0.0',
        title: 'ask',
        entry: 'index.js',
        nodes: [],
        services: [{ id: 'llm', kind: 'llm', mode: 'worker' }],
      },
      `export const nodes = []
export const services = {
  llm(ctx) {
    return {
      async chat() {
        const decision = await ctx.approval.request({ action: 'tool.call', target: 'echo' })
        return {
          message: { role: 'assistant', content: 'decision: ' + decision },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
`,
    )
    await installModule(modulesPath, source, { id: 'com.example.ask-llm', version: '1.0.0' })
    const runtime = await makeRuntime(modulesPath)

    expect(await runText(runtime, { approval: allowAll })).toBe('decision: allowed-once')

    const reject: ApprovalService = { request: async () => 'rejected' }
    await expect(runText(runtime, { approval: reject })).rejects.toThrow(/approval was rejected/)

    // After dispose the mapping is gone: a stale adapter cannot borrow it, and
    // the request fails cleanly instead of reaching another run.
    const runId = `run_${randomUUID()}`
    const handle = await runtime.beginRun({ runId, approval: allowAll })
    const stale = handle.services.llm as LlmService
    await handle.dispose()
    await expect(
      stale.chat({
        model: { provider: 'mock', model: 'mock-1' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/not available for run/)
  })
})
