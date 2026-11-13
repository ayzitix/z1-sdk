import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { ChatDelta, ChatRequest, Json } from '@z1/node'
import type { ApprovalService, FsService, LlmService, ToolService } from '@z1/runtime'
import {
  ModuleWorker,
  workerArtifactService,
  workerFsService,
  workerLlmService,
  workerMemoryService,
  workerToolService,
} from '../src/index.ts'
import type { WorkerHostServices } from '../src/index.ts'

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
]

const request: ChatRequest = {
  model: { provider: 'stub', model: 'stub-1' },
  messages: [{ role: 'user', content: 'hello' }],
}

const workers: ModuleWorker[] = []

function hostServices(): WorkerHostServices {
  const fs: FsService = {
    read: async () => {
      throw new Error('host fs is not stubbed in this test')
    },
    write: async () => {
      throw new Error('host fs is not stubbed in this test')
    },
  }
  const tools: ToolService = {
    call: async () => null,
    list: async () => [],
  }
  const llm: LlmService = {
    chat: async () => {
      throw new Error('host llm is not stubbed in this test')
    },
  }
  const approval: ApprovalService = { request: async () => 'allowed-once' }
  return { llm, tools, fs, approval }
}

async function startWorker(): Promise<ModuleWorker> {
  const worker = new ModuleWorker({
    moduleDir: MODULE_DIR,
    entry: 'index.js',
    manifestNodeIds: [],
    manifestServiceIds: SERVICE_IDS,
    capabilities: {},
    services: hostServices(),
  })
  workers.push(worker)
  await worker.startAll()
  return worker
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    await worker.dispose().catch(() => undefined)
  }
})

describe('worker service adapters', () => {
  test('workerLlmService streams validated deltas and returns the answer', async () => {
    const worker = await startWorker()
    const llm = workerLlmService(worker, 'llm')

    const deltas: ChatDelta[] = []
    const result = await llm.chat(request, (delta) => deltas.push(delta))

    expect(deltas).toEqual([
      { type: 'text', text: 'svc-a' },
      { type: 'text', text: 'svc-b' },
    ])
    expect(result.message).toEqual({ role: 'assistant', content: 'svc: hello' })
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('stop')
  }, 20_000)

  test('workerLlmService works without a delta sink', async () => {
    const worker = await startWorker()
    const result = await workerLlmService(worker, 'llm').chat(request)

    expect(result.message.content).toBe('svc: hello')
  }, 20_000)

  test('workerToolService calls a tool and lists empty schemas', async () => {
    const worker = await startWorker()
    const tools = workerToolService(worker, 'tools')

    const args: Json = { x: 1, nested: [true, null] }
    await expect(tools.call('echo', args)).resolves.toEqual({ ok: true, name: 'echo', args })
    await expect(tools.list()).resolves.toEqual([])
  }, 20_000)

  test('workerFsService reads back what it wrote', async () => {
    const worker = await startWorker()
    const fs = workerFsService(worker, 'echo-fs')

    await fs.write('/tmp/somewhere.txt', 'agent output')
    await expect(fs.read('/tmp/somewhere.txt')).resolves.toBe('agent output')
    await expect(fs.read('/tmp/missing.txt')).rejects.toThrow(/no such file/)
  }, 20_000)

  test('workerArtifactService base64-round-trips bytes and keeps the mime', async () => {
    const worker = await startWorker()
    const artifacts = workerArtifactService(worker, 'artifacts')

    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
    const hash = await artifacts.put(bytes, 'image/png')
    expect(hash).toBe('artifact-1')

    const returned = await artifacts.get(hash)
    expect(returned).toBeInstanceOf(Uint8Array)
    expect([...returned]).toEqual([...bytes])

    await expect(artifacts.get('missing')).rejects.toThrow(/no artifact/)
  }, 20_000)

  test('workerMemoryService validates the envelope', async () => {
    const worker = await startWorker()
    const memory = workerMemoryService(worker, 'memory')

    const envelope = await memory.buildContext({ runId: 'run_1' })
    expect(envelope.text).toBe('mem:run_1')
    expect(envelope.messages).toEqual([{ role: 'system', content: 'remember' }])
    expect(envelope.spine).toEqual(['run'])
    expect(envelope.siblings).toEqual([])
    expect(envelope.recent).toEqual([{ path: 'a', type: 'node', summary: 'did it' }])
    expect('writeSummary' in memory).toBe(false)
  }, 20_000)

  test('a malformed chat result is rejected', async () => {
    const worker = await startWorker()
    const llm = workerLlmService(worker, 'bad-llm')

    await expect(llm.chat(request)).rejects.toThrow(/invalid chat result.message/)
    expect(worker.alive).toBe(true)
  }, 20_000)

  test('a malformed delta is rejected before it reaches the caller', async () => {
    const worker = await startWorker()
    const llm = workerLlmService(worker, 'bad')

    const deltas: ChatDelta[] = []
    await expect(llm.chat(request, (delta) => deltas.push(delta))).rejects.toThrow(
      /invalid chat delta/,
    )
    expect(deltas).toEqual([])
    expect(worker.alive).toBe(true)
  }, 20_000)
})
