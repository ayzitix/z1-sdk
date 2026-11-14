/**
 * `z1.ctx.budget` and `z1.ctx.clip` are the two context nodes that go into the
 * agent loop. The budget must never change what the model sees; the clip must
 * always say that it cut something.
 */

import { describe, expect, test } from 'vitest'

import { contextBudget, contextClip, estimateMessages } from '../src/index.ts'

interface Logged {
  level: string
  message: string
}

interface FsWrite {
  path: string
  data: string
}

interface Extras {
  writes?: FsWrite[]
  writeError?: Error
  logs?: Logged[]
}

function ctx(inputs: Record<string, unknown>, config: unknown, extras: Extras = {}) {
  return {
    runId: 'run_test',
    nodeId: 'n',
    path: 'loop/0/toolMap/0/mapClip',
    attempt: 1,
    input: inputs as never,
    config: config as never,
    signal: new AbortController().signal,
    log: (level: string, message: string) => extras.logs?.push({ level, message }),
    emit: () => undefined,
    fs: {
      async write(path: string, data: string) {
        if (extras.writeError !== undefined) throw extras.writeError
        extras.writes?.push({ path, data })
      },
      async read() {
        throw new Error('not used')
      },
    },
    llm: {
      chat: async () => {
        throw new Error('not used')
      },
    },
    tools: { call: async () => null, list: async () => [] },
    artifacts: { put: async () => '', get: async () => new Uint8Array() },
    approval: { request: async () => 'rejected' },
    // The node types expect the full NodeContext shape; the fields above are
    // the only ones these two read.
  } as never
}

/** Parse the config through the node's own schema, as the executor does. */
async function runBudget(config: unknown, inputs: Record<string, unknown>, extras: Extras = {}) {
  const parsed = contextBudget.config.parse(config) as never
  return await contextBudget.execute(ctx(inputs, parsed, extras))
}

async function runClip(config: unknown, inputs: Record<string, unknown>, extras: Extras = {}) {
  const parsed = contextClip.config.parse(config) as never
  return await contextClip.execute(ctx(inputs, parsed, extras))
}

describe('z1.ctx.budget', () => {
  const messages = [
    { role: 'system', content: 's'.repeat(400) },
    { role: 'user', content: 'u'.repeat(400) },
  ]

  test('estimates the transcript and passes it through untouched', async () => {
    const output = await runBudget(
      { contextWindow: 10_000, reserveTokens: 0, threshold: 0.8 },
      { messages },
    )
    expect(estimateMessages(messages as never, 4)).toBe(200)
    expect(output.tokens).toBe(200)
    expect(output.window).toBe(10_000)
    expect(output.triggerAt).toBe(8_000)
    expect(output.over).toBe(false)
    expect(output.messages).toBe(messages)
  })

  test('a reported usage wins when it is larger than the estimate', async () => {
    const output = await runBudget(
      { contextWindow: 10_000, reserveTokens: 0 },
      { messages, usage: { inputTokens: 9_000 } },
    )
    expect(output.tokens).toBe(9_000)
    expect(output.over).toBe(true)
  })

  test('the threshold leaves room for the response', async () => {
    const output = await runBudget(
      { contextWindow: 10_000, reserveTokens: 1_000, threshold: 0.9 },
      { messages, usage: 8_200 },
    )
    expect(output.triggerAt).toBe(8_100)
    expect(output.over).toBe(true)
    expect(output.ratio).toBeCloseTo(0.82, 5)
  })

  test('warns only when over the threshold, and the warning names the numbers', async () => {
    const quiet: Logged[] = []
    await runBudget({}, { messages }, { logs: quiet })
    expect(quiet.every((entry) => entry.level === 'debug')).toBe(true)

    const loud: Logged[] = []
    await runBudget({ contextWindow: 128_000 }, { messages, usage: 120_000 }, { logs: loud })
    const warning = loud.find((entry) => entry.level === 'warn')
    expect(warning?.message).toContain('~120000 of 128000 tokens')
  })

  test('an empty or missing transcript is zero, not an error', async () => {
    const output = await runBudget({}, {})
    expect(output.tokens).toBe(0)
    expect(output.messages).toEqual([])
  })
})

describe('z1.ctx.clip', () => {
  const long = `${'A'.repeat(100)}${'B'.repeat(1_000)}${'C'.repeat(100)}`

  test('a short value is returned unchanged and writes nothing', async () => {
    const writes: FsWrite[] = []
    const output = await runClip({ maxChars: 100 }, { value: 'short' }, { writes })
    expect(output.value).toBe('short')
    expect(output.truncated).toBe(false)
    expect(output.spillPath).toBe('')
    expect(writes).toHaveLength(0)
  })

  test('a long string keeps head and tail, marks the cut and spills the whole text', async () => {
    const writes: FsWrite[] = []
    const output = await runClip(
      { maxChars: 200, headRatio: 0.5 },
      { value: long, name: 'read' },
      { writes },
    )

    expect(output.truncated).toBe(true)
    expect(output.originalChars).toBe(long.length)
    const text = String(output.value)
    expect(text.startsWith('A'.repeat(100))).toBe(true)
    expect(text.endsWith('C'.repeat(100))).toBe(true)
    expect(text).toContain('z1: clipped 1200 chars, 1000 omitted')
    expect(text).toContain('full output at .z1/out/run_test/loop-0-toolMap-0-mapClip-read.txt')
    expect(writes).toEqual([
      { path: '.z1/out/run_test/loop-0-toolMap-0-mapClip-read.txt', data: long },
    ])
  })

  test('an object result is serialized before clipping', async () => {
    const value = { rows: Array.from({ length: 100 }, (_, index) => ({ index })) }
    const output = await runClip({ maxChars: 120 }, { value })
    expect(output.truncated).toBe(true)
    expect(String(output.value)).toContain('"rows"')
  })

  test('a failed spill still returns a clipped value and says so', async () => {
    const logs: Logged[] = []
    const output = await runClip(
      { maxChars: 200 },
      { value: long },
      { writeError: new Error('read-only workspace'), logs },
    )
    expect(output.truncated).toBe(true)
    expect(output.spillPath).toBe('')
    expect(String(output.value)).not.toContain('full output at')
    expect(logs.some((entry) => entry.message.includes('read-only workspace'))).toBe(true)
  })

  test('spill can be turned off', async () => {
    const writes: FsWrite[] = []
    const output = await runClip({ maxChars: 200, spill: false }, { value: long }, { writes })
    expect(writes).toHaveLength(0)
    expect(output.spillPath).toBe('')
    expect(String(output.value)).toContain('clipped 1200 chars')
  })
})
