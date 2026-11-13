import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { randomUUID } from 'node:crypto'

import { graphDigest, parseGraph } from '@z1/graph'
import type { Json } from '@z1/node'
import { runGraph, type ApprovalService, type RunResult } from '@z1/runtime'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createRuntime, loadRuntimeConfig, type Runtime } from '../src/index.ts'

let root: string
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-bootstrap-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

async function makeRuntime(useMemory = true): Promise<Runtime> {
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      env: {},
      overrides: {
        dbPath: join(root, 'runs.db'),
        graphsPath: join(root, 'graphs'),
        modulesPath: join(root, 'modules'),
        useMemory,
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

const approval: ApprovalService = {
  request: async () => 'allowed-once',
}

function node(id: string, type: string, config: Record<string, unknown> = {}): unknown {
  return { id, type, version: '1.0.0', config, position: { x: 0, y: 0 } }
}

function helloGraph(): unknown {
  return {
    schemaVersion: 1,
    id: 'hello',
    nodes: [
      node('input', 'z1.core.input'),
      node('template', 'z1.core.template', { template: 'hello {{name}}' }),
      node('output', 'z1.core.output'),
    ],
    edges: [
      {
        id: 'e-in-vars',
        kind: 'data',
        from: { node: 'input', port: 'value' },
        to: { node: 'template', port: 'vars' },
      },
      {
        id: 'e-template-value',
        kind: 'data',
        from: { node: 'template', port: 'text' },
        to: { node: 'output', port: 'value' },
      },
      {
        id: 'f-in-output',
        kind: 'flow',
        from: { node: 'input', port: 'out' },
        to: { node: 'output', port: 'in' },
      },
    ],
  }
}

/** `a-input` sorts before `b-memory`, so the memory node sees the input step. */
function memoryGraph(): unknown {
  return {
    schemaVersion: 1,
    id: 'memory',
    nodes: [
      node('a-input', 'z1.core.input'),
      node('b-memory', 'z1.memory.context'),
      node('c-output', 'z1.core.output'),
    ],
    edges: [
      {
        id: 'e-memory-text',
        kind: 'data',
        from: { node: 'b-memory', port: 'text' },
        to: { node: 'c-output', port: 'value' },
      },
      {
        id: 'f-input-output',
        kind: 'flow',
        from: { node: 'a-input', port: 'out' },
        to: { node: 'c-output', port: 'in' },
      },
    ],
  }
}

async function runOne(runtime: Runtime, graph: unknown, input: Json): Promise<RunResult> {
  const document = parseGraph(graph)
  // A caller owns the run record, exactly like the CLI and the server do.
  const runId = `run_${randomUUID()}`
  const now = Date.now()
  runtime.journal.createRun({
    runId,
    graphId: document.id,
    graphDigest: graphDigest(document),
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })
  const handle = await runtime.beginRun({ approval })
  try {
    return await runGraph({
      graph: document,
      registry: handle.registry,
      services: handle.services,
      journal: runtime.journal,
      runId,
      input,
    })
  } finally {
    await handle.dispose()
  }
}

test('createRuntime exposes its resources and begins a working run', async () => {
  const runtime = await makeRuntime()

  expect(runtime.config.dbPath).toBe(join(root, 'runs.db'))
  expect(runtime.memory).toBeDefined()
  expect(runtime.registry.has('z1.core.template', '1.0.0')).toBe(true)
  expect(runtime.providers.has('mock')).toBe(true)

  const result = await runOne(runtime, helloGraph(), { name: 'world' })

  expect(result.status).toBe('completed')
  expect(result.outputs).toEqual({ output: 'hello world' })
})

test('ctx.memory sees the branch journal through a z1.memory.context node', async () => {
  const runtime = await makeRuntime()

  const prior = await runOne(runtime, helloGraph(), { name: 'prior' })
  expect(prior.status).toBe('completed')

  const result = await runOne(runtime, memoryGraph(), { name: 'again' })

  expect(result.status).toBe('completed')
  expect(typeof result.outputs['output']).toBe('string')
  const text = result.outputs['output'] as string
  expect(text).toContain('Recent steps')
  expect(text).toContain('a-input')
})

test('memory is absent when the config disables it', async () => {
  const runtime = await makeRuntime(false)

  expect(runtime.memory).toBeUndefined()
  const result = await runOne(runtime, memoryGraph(), null)
  expect(result.outputs['output']).toBe('')
})

test('close is idempotent and rejects new runs', async () => {
  const runtime = await makeRuntime()

  await runtime.close()
  await runtime.close()

  await expect(runtime.beginRun({ approval })).rejects.toThrow(/runtime is closed/)
})
