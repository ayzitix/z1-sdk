import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChatRequest, ChatResult, Json, ModelHandle } from '@z1/node'
import type { ApprovalService, LlmService } from '@z1/runtime'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

import { createRuntime, loadRuntimeConfig, type Runtime } from '../src/index.ts'

/**
 * `tool.create` through the composition root.
 *
 * The sdk is not published and must not be needed by a test, so the
 * `Z1_TOOL_SDK_PATH` checkout below is a five-line ESM module that only exports
 * `createToolCreator`: it calls the host's `generate` hook and returns a
 * proposal, which is the whole contract the port speaks. What is under test is
 * the bootstrap's own wiring - the switch, the model hook, and the error a run
 * gets when either is missing.
 */

const MODEL: ModelHandle = { provider: 'mock', model: 'fake-1' }
const TOOL_REQUEST = { name: 'tool.find-todos', purpose: 'Find TODO comments.' }

/** The exact prompt pair the fake creator asks for. */
const SYSTEM_PROMPT = 'creator system: write one tool file'
const USER_PROMPT = 'creator user: tool.find-todos'

const FAKE_SDK = `
export function createToolCreator(options) {
  return {
    async propose(request) {
      const source = await options.generate({
        system: '${SYSTEM_PROMPT}',
        user: 'creator user: ' + request.name,
        attempt: 1,
      })
      return {
        projectDir: '/proposal/' + request.name,
        sha256: 'a'.repeat(64),
        attempts: 1,
        manifest: { name: request.name, version: '0.1.0' },
        summary: { lines: ['Reads workspace files matching "**/*".'], risk: 'read-only' },
        history: [],
        smoke: { ok: true, runs: [{ ok: true, denied: 0, args: null, codes: [], durationMs: 1 }] },
        source: source,
      }
    },
  }
}
`

let root: string
let fakeSdk: string
let missingSdk: string
let runtimeSeq = 0
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-tool-creator-wiring-'))
  fakeSdk = join(root, 'fake-sdk')
  await mkdir(fakeSdk, { recursive: true })
  await writeFile(join(fakeSdk, 'index.js'), FAKE_SDK, 'utf8')
  missingSdk = join(root, 'no-checkout-here')
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const approval: ApprovalService = { request: async () => 'allowed-once' }

interface FakeLlm extends LlmService {
  readonly requests: ChatRequest[]
}

/** A model that answers with a tool source and keeps every request it saw. */
function fakeLlm(): FakeLlm {
  const requests: ChatRequest[] = []
  return {
    requests,
    async chat(request: ChatRequest): Promise<ChatResult> {
      requests.push(request)
      return {
        message: { role: 'assistant', content: 'export const tool = defineTool({})' },
        toolCalls: [],
        stopReason: 'stop',
      }
    },
  }
}

async function makeRuntime(env: Record<string, string | undefined>): Promise<Runtime> {
  runtimeSeq += 1
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      env,
      overrides: {
        dbPath: join(root, `runs-${String(runtimeSeq)}.db`),
        graphsPath: join(root, 'graphs'),
        modulesPath: join(root, 'modules'),
        useModules: false,
        useServiceModules: false,
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

function asRecord(value: Json): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value
}

test('a run model turns tool.create into one two-message model call', async () => {
  vi.stubEnv('Z1_TOOL_SDK_PATH', fakeSdk)
  const runtime = await makeRuntime({ Z1_TOOL_CREATOR: '1' })
  const llm = fakeLlm()
  const handle = await runtime.beginRun({ approval, llm, model: MODEL })

  try {
    const summary = asRecord(await handle.services.tools.call('tool.create', TOOL_REQUEST))

    expect(summary['name']).toBe('tool.find-todos')
    expect(summary['version']).toBe('0.1.0')
    expect(summary['projectDir']).toBe('/proposal/tool.find-todos')
    expect(String(summary['next'])).toContain('z1-tool install /proposal/tool.find-todos')

    // Exactly one call, so the proposal cost one model turn and nothing else.
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]?.model).toEqual(MODEL)
    expect(llm.requests[0]?.messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ])
    // The creator reads source text from the reply; a tool call would starve it.
    expect(llm.requests[0]?.tools).toEqual([])
  } finally {
    await handle.dispose()
  }
})

test('the tool is present by default and gone when the switch says off', async () => {
  vi.stubEnv('Z1_TOOL_SDK_PATH', fakeSdk)

  // Default: system tool, listed beside the run's own tools.
  const on = await makeRuntime({})
  const onHandle = await on.beginRun({ approval, llm: fakeLlm(), model: MODEL })
  try {
    expect((await onHandle.services.tools.list()).map((schema) => schema.name)).toContain(
      'tool.create',
    )
  } finally {
    await onHandle.dispose()
  }

  // `Z1_TOOL_CREATOR=0`: the run's own tool service answers, as it always did.
  const llm = fakeLlm()
  const runtime = await makeRuntime({ Z1_TOOL_CREATOR: '0' })
  const handle = await runtime.beginRun({ approval, llm, model: MODEL })

  try {
    expect((await handle.services.tools.list()).map((schema) => schema.name)).not.toContain(
      'tool.create',
    )
    // Not intercepted: the run's own tool service answers, as it always did.
    expect(await handle.services.tools.call('tool.create', TOOL_REQUEST)).toEqual({
      ok: true,
      name: 'tool.create',
      args: TOOL_REQUEST,
    })
    expect(llm.requests).toEqual([])
  } finally {
    await handle.dispose()
  }
})

test('a missing sdk checkout is reported as tool_creator_unavailable', async () => {
  vi.stubEnv('Z1_TOOL_SDK_PATH', missingSdk)
  const runtime = await makeRuntime({ Z1_TOOL_CREATOR: '1' })
  const llm = fakeLlm()
  const handle = await runtime.beginRun({ approval, llm, model: MODEL })

  try {
    const error = await handle.services.tools
      .call('tool.create', TOOL_REQUEST)
      .catch((caught: unknown) => caught)

    expect((error as { code?: string }).code).toBe('tool_creator_unavailable')
    expect((error as Error).message).toContain('Z1_TOOL_SDK_PATH')
    expect((error as Error).message).toContain('not published on npm')
    expect(llm.requests).toEqual([])
  } finally {
    await handle.dispose()
  }
})

test('a run without a model reports model_unavailable instead of guessing one', async () => {
  vi.stubEnv('Z1_TOOL_SDK_PATH', fakeSdk)
  const runtime = await makeRuntime({ Z1_TOOL_CREATOR: '1' })
  const llm = fakeLlm()
  // No `model` on the run: the hook cannot name a provider, so it is not built.
  const handle = await runtime.beginRun({ approval, llm })

  try {
    const error = await handle.services.tools
      .call('tool.create', TOOL_REQUEST)
      .catch((caught: unknown) => caught)

    expect((error as { code?: string }).code).toBe('model_unavailable')
    expect((error as Error).message).toContain('generate')
    expect(llm.requests).toEqual([])
  } finally {
    await handle.dispose()
  }
})
