import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { graphDigest } from '@z1/graph'
import type { ChatResult, ModelHandle } from '@z1/node'
import {
  CassetteError,
  createCassetteLlmService,
  formatCassette,
  parseCassette,
  runGraph,
  type ApprovalService,
  type LlmService,
  type RecordLlmMode,
} from '@z1/runtime'
import { afterAll, beforeAll, expect, test } from 'vitest'

import {
  createRuntime,
  exportCassette,
  loadCassette,
  loadRuntimeConfig,
  type Runtime,
} from '../src/index.ts'

const MODEL: ModelHandle = { provider: 'mock', model: 'mock-1' }

const RESULT: ChatResult = {
  message: { role: 'assistant', content: 'recorded answer' },
  toolCalls: [],
  usage: { inputTokens: 5, outputTokens: 3 },
  stopReason: 'stop',
}

const approval: ApprovalService = { request: async () => 'allowed-once' }

let root: string
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-cassette-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

async function makeRuntime(
  overrides: { mode?: RecordLlmMode; cassette?: string } = {},
): Promise<Runtime> {
  const directory = join(root, `${randomUUID()}`)
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: directory,
      env: {},
      overrides: {
        dbPath: join(directory, 'runs.db'),
        modulesPath: join(directory, 'modules'),
        recordLlm: overrides.mode ?? 'full',
        ...(overrides.cassette === undefined ? {} : { cassette: overrides.cassette }),
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

/** One agent run; `llm` is only passed when the test wants to control it. */
async function runAgent(runtime: Runtime, llm?: LlmService): Promise<string> {
  const graph = runtime.templates.build('agent.loop', { model: MODEL })
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

  const handle = await runtime.beginRun({ runId, approval, ...(llm === undefined ? {} : { llm }) })
  try {
    const result = await runGraph({
      graph,
      registry: handle.registry,
      services: handle.services,
      input: 'hello',
      journal: runtime.journal,
      runId,
    })
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'recorded answer' })
  } finally {
    await handle.dispose()
  }
  runtime.journal.updateRun(runId, { status: 'completed', updatedAt: Date.now() })
  return runId
}

function scripted(): LlmService {
  return { chat: async () => RESULT }
}

test('a recorded run exports and replays without a provider', async () => {
  const runtime = await makeRuntime()
  const runId = await runAgent(runtime, scripted())

  const turns = exportCassette(runtime.journal, runId)
  expect(turns).toHaveLength(1)
  expect(turns[0]?.path).toBe('loop/0/chat')
  expect(turns[0]?.request.messages.at(-1)).toMatchObject({ content: 'hello' })
  expect(turns[0]?.response).toEqual(RESULT)

  const file = join(root, 'round-trip.jsonl')
  await writeFile(file, formatCassette(turns), 'utf8')

  // The file is the contract: parse what a user would hand to the CLI.
  expect(parseCassette(await readFile(file, 'utf8'))).toEqual(turns)

  // A cassette-configured runtime has no provider registry at all: this would
  // throw a credential error if replay touched the network path.
  const replay = await makeRuntime({ cassette: file })
  expect(replay.config.cassette).toBe(file)
  const replayId = await runAgent(replay)
  const replayed = replay.journal.read(replayId)
  expect(
    replayed.filter((event) => event.type === 'llm.response'),
  ).toHaveLength(1)
})

test('hashes mode cannot export payloads and says why', async () => {
  const runtime = await makeRuntime({ mode: 'hashes' })
  const runId = await runAgent(runtime, scripted())

  expect(() => exportCassette(runtime.journal, runId)).toThrow(/Z1_RECORD_LLM=hashes/)
})

test('off mode records no model events and export refuses', async () => {
  const runtime = await makeRuntime({ mode: 'off' })
  const runId = await runAgent(runtime, scripted())

  const llmEvents = runtime.journal
    .read(runId)
    .filter((event) => event.type === 'llm.request' || event.type === 'llm.response')
  expect(llmEvents).toHaveLength(0)
  expect(() => exportCassette(runtime.journal, runId)).toThrow(/no recorded model calls/)
})

test('a replay miss names the path and never falls back', async () => {
  const runtime = await makeRuntime()
  const runId = await runAgent(runtime, scripted())
  const file = join(root, 'miss.jsonl')
  await writeFile(file, formatCassette(exportCassette(runtime.journal, runId)), 'utf8')

  const service = createCassetteLlmService({ turns: loadCassette(file) })
  await expect(
    service.chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'something else' }],
    }),
  ).rejects.toThrow(CassetteError)
  await expect(
    service.chat({
      model: MODEL,
      messages: [{ role: 'user', content: 'something else' }],
    }),
  ).rejects.toThrow(/cassette miss for mock\/mock-1/)
})
