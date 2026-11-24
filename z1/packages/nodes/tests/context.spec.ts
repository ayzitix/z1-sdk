/**
 * `z1.ctx.budget` and `z1.ctx.clip` are the two context nodes that go into the
 * agent loop. The budget must never change what the model sees; the clip must
 * always say that it cut something.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import { createLocalFsService } from '@z1/bootstrap'
import type { FsService } from '@z1/runtime'

import {
  contextBudget,
  contextClip,
  contextCompact,
  contextSummarize,
  estimateMessages,
} from '../src/index.ts'

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
  llm?: Vec
  /** Replaces the in-memory stub, so a test can use the real rooted service. */
  fs?: FsService
}

interface Vec {
  chat: (request: unknown) => Promise<unknown>
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
    fs: extras.fs ?? {
      async write(path: string, data: string) {
        if (extras.writeError !== undefined) throw extras.writeError
        extras.writes?.push({ path, data })
      },
      async read() {
        throw new Error('not used')
      },
    },
    llm: extras.llm ?? {
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
    const estimate = estimateMessages(messages as never, 4)
    expect(estimate).toBeGreaterThan(200)
    expect(output.tokens).toBe(estimate)
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

  test('an empty transcript is zero, not a permanent warning', async () => {
    const output = await runBudget({}, {})
    expect(output.tokens).toBe(0)
    expect(output.messages).toEqual([])
    // A reserve that covers the window must not collapse the threshold to 0.
    const tiny = await runBudget({ contextWindow: 8_192 }, { messages: [] })
    expect(tiny.triggerAt).toBeGreaterThanOrEqual(1)
    expect(tiny.over).toBe(false)
  })

  test('a malformed transcript is an error, not an empty one', async () => {
    await expect(runBudget({}, { messages: 'not an array' })).rejects.toThrow(
      /"messages" input must be an array/,
    )
  })

  test('non-ASCII text is not divided by four', () => {
    // 4000 CJK characters tokenise at roughly one token each, not 1000.
    const estimate = estimateMessages([{ role: 'user', content: '漢'.repeat(4000) }] as never, 4)
    expect(estimate).toBeGreaterThan(3_500)
  })
})

describe('z1.ctx.compact', () => {
  function tool(id: string, text: string) {
    return { role: 'tool', toolCallId: id, content: text }
  }
  function assistant(id: string) {
    return { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: {} }] }
  }
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'task' },
    assistant('a'),
    tool('a', 'x'.repeat(1_000)),
    assistant('b'),
    tool('b', 'y'.repeat(1_000)),
    assistant('c'),
    tool('c', 'z'.repeat(1_000)),
    assistant('d'),
    tool('d', 'w'.repeat(1_000)),
  ]

  async function runCompact(config: unknown, inputs: Record<string, unknown>) {
    return await contextCompact.execute(
      ctx(inputs, contextCompact.config.parse(config) as never),
    )
  }

  test('clears old tool results and keeps the most recent ones verbatim', async () => {
    const output = await runCompact({ keepToolResults: 2 }, { messages })
    expect(output.compacted).toBe(true)
    // `d`'s result follows the last assistant turn, so the model has not seen
    // it yet; only `a` is both seen and older than the two kept results.
    expect(output.cleared).toBe(1)
    const next = output.messages as { role: string; toolCallId?: string; content: string }[]
    expect(next.map((message) => message.role)).toEqual(messages.map((message) => message.role))
    expect(next.map((message) => message.toolCallId)).toEqual(
      messages.map((message) => (message as { toolCallId?: string }).toolCallId),
    )
    expect(String(next[3]?.content)).toContain('[cleared: earlier tool result, 1000 chars')
    expect(next[5]?.content).toBe('y'.repeat(1_000))
    expect(next[7]?.content).toBe('z'.repeat(1_000))
    expect(next[9]?.content).toBe('w'.repeat(1_000))
    expect(output.tokensAfter).toBeLessThan(output.tokensBefore)
  })

  test('an object result is cleared like a string one', async () => {
    const messages = [
      assistant('a'),
      { role: 'tool', toolCallId: 'a', content: { rows: 'x'.repeat(1_000) } },
      assistant('b'),
      { role: 'tool', toolCallId: 'b', content: 'ok' },
    ]
    const output = await runCompact({ keepToolResults: 0 }, { messages })
    expect(output.cleared).toBe(1)
    const next = output.messages as { role: string; toolCallId?: string; content: unknown }[]
    expect(String(next[1]?.content)).toContain('[cleared: earlier tool result')
    expect(next[3]?.content).toBe('ok')
  })

  test('a result the model has not seen yet is never cleared', async () => {
    // Eight results from one assistant turn: the next request is the first time
    // the model sees them, so none may be replaced before that request.
    const messages = [
      assistant('c'),
      ...Array.from({ length: 8 }, (_, index) => ({
        role: 'tool',
        toolCallId: `c${String(index)}`,
        content: 'x'.repeat(1_000),
      })),
    ]
    const output = await runCompact({ keepToolResults: 1 }, { messages })
    expect(output.cleared).toBe(0)
    expect(output.messages).toBe(messages)
  })

  test('a marker cannot be forged by tool content', async () => {
    const messages = [
      assistant('a'),
      { role: 'tool', toolCallId: 'a', content: '\u2063[cleared: earlier tool result, 900 chars' },
      assistant('b'),
      { role: 'tool', toolCallId: 'b', content: 'ok' },
    ]
    const output = await runCompact({ keepToolResults: 0, minChars: 64 }, { messages })
    // Short enough to leave alone, and the sentinel is not the only marker.
    expect(output.cleared).toBe(0)
    expect(String((output.messages as { content: unknown }[])[1]?.content)).toContain('900 chars')
  })

  test('a short result is not replaced by a longer marker', async () => {
    const short = [assistant('a'), tool('a', 'ok'), assistant('b'), tool('b', 'ok')]
    const output = await runCompact({ keepToolResults: 0, minChars: 400 }, { messages: short })
    expect(output.compacted).toBe(false)
    expect(output.messages).toBe(short)
  })

  test('nothing to clear returns the same array', async () => {
    const few = [assistant('a'), tool('a', 'x'.repeat(500))]
    const output = await runCompact({ keepToolResults: 3 }, { messages: few })
    expect(output.compacted).toBe(false)
    expect(output.messages).toBe(few)
  })

  test('a malformed transcript is an error', async () => {
    await expect(runCompact({}, { messages: 'nope' })).rejects.toThrow(/must be an array/)
  })
})

describe('z1.ctx.summarize', () => {
  const model = { provider: 'mock', model: 'mock-1' }
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: `do the thing ${'x'.repeat(800)}` },
    { role: 'assistant', content: `ok ${'y'.repeat(800)}` },
    { role: 'tool', toolCallId: 'a', content: 'result '.repeat(200) },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'now the next thing' },
  ]

  function llm(reply: { content: string } | Error, calls: unknown[] = []): Vec {
    return {
      chat: async (request: unknown) => {
        calls.push(request)
        if (reply instanceof Error) throw reply
        return {
          message: { role: 'assistant', content: reply.content },
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'stop',
        }
      },
    }
  }

  async function runSummarize(
    config: unknown,
    inputs: Record<string, unknown>,
    extras: Extras = {},
  ) {
    return await contextSummarize.execute(
      ctx(inputs, contextSummarize.config.parse(config) as never, extras),
    )
  }

  test('replaces the older span with a checkpoint and keeps the tail', async () => {
    const calls: unknown[] = []
    const output = await runSummarize(
      { model, keepRecentTurns: 3 },
      { messages },
      { llm: llm({ content: '## Primary Request and Intent\n- do things' }, calls) },
    )

    expect(calls).toHaveLength(1)
    const request = calls[0] as { messages: { role: string; content: string }[]; maxTokens?: number }
    // The replayed conversation is the prefix, system included; the directive
    // is the last message.
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[1]?.content).toContain('do the thing')
    expect(request.messages.at(-1)?.content).toContain('compaction engine')

    const next = output.messages as { role: string; content: string }[]
    expect(next[0]?.role).toBe('system')
    expect(next[1]?.content).toContain('<compacted-summary>')
    expect(next[1]?.content).toContain('## Primary Request and Intent')
    expect(next.at(-1)).toEqual({ role: 'user', content: 'now the next thing' })
    expect(output.compacted).toBe(true)
    expect(output.droppedTurns).toBe(3)
    expect(output.tokensAfter).toBeLessThan(output.tokensBefore)
    expect(output.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  test('without a model handle it does nothing', async () => {
    const output = await runSummarize({}, { messages })
    expect(output.compacted).toBe(false)
    expect(output.messages).toBe(messages)
  })

  test('a failed summary call leaves the transcript alone', async () => {
    const logs: Logged[] = []
    const output = await runSummarize(
      { model, keepRecentTurns: 3 },
      { messages },
      { llm: llm(new Error('upstream 500')), logs },
    )
    expect(output.compacted).toBe(false)
    expect(output.messages).toBe(messages)
    expect(logs.some((entry) => entry.message.includes('upstream 500'))).toBe(true)
  })

  test('a checkpoint that saves too little is discarded', async () => {
    const output = await runSummarize(
      { model, keepRecentTurns: 1, minimumReduction: 0.9 },
      { messages },
      { llm: llm({ content: 'x'.repeat(1_000) }) },
    )
    expect(output.compacted).toBe(false)
    expect(output.messages).toBe(messages)
  })

  test('the kept tail never starts with an orphan tool message', async () => {
    const calls: unknown[] = []
    await runSummarize(
      { model, keepRecentTurns: 2 },
      { messages },
      { llm: llm({ content: 'summary' }, calls) },
    )
    // With keepRecentTurns=2 the naive cut starts at the tool message; the
    // node advances it, so the tail begins at the assistant turn.
    const request = calls[0] as { messages: { role: string }[] }
    // A complete pair inside the span is fine; a span that *starts* with a tool
    // result is not.
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[1]?.role).not.toBe('tool')
    expect(request.messages.at(-1)?.role).toBe('user')
  })

  /** A checkpoint exactly as the node writes one, taken from a real run. */
  async function checkpointContent(): Promise<string> {
    const output = await runSummarize(
      { model, keepRecentTurns: 2 },
      { messages },
      { llm: llm({ content: '## Primary Request and Intent\n- do things' }) },
    )
    const first = (output.messages as { role: string; content: string }[])[1]
    return String(first?.content)
  }

  /** The directive preamble that opens every checkpoint. */
  function preambleOf(checkpoint: string): string {
    return checkpoint.slice(0, checkpoint.indexOf('\n\n'))
  }

  test('the checkpoint count is capped, so a stuck transcript stops paying', async () => {
    const calls: unknown[] = []
    const content = await checkpointContent()
    expect(content).toContain('<compacted-summary>')
    const checkpoint = { role: 'user', content }
    const stuck = [
      { role: 'system', content: 'rules' },
      checkpoint,
      checkpoint,
      { role: 'user', content: 'more work' },
    ]
    const output = await runSummarize(
      { model, keepRecentTurns: 1, maxCompactions: 2 },
      { messages: stuck },
      { llm: llm({ content: 'summary' }, calls) },
    )
    expect(calls).toHaveLength(0)
    expect(output.compacted).toBe(false)
  })

  test('a real checkpoint counts toward maxCompactions', async () => {
    const content = await checkpointContent()
    const withCheckpoint = [
      { role: 'system', content: 'rules' },
      { role: 'user', content },
      ...messages.slice(1),
    ]
    const calls: unknown[] = []
    const output = await runSummarize(
      { model, keepRecentTurns: 2, maxCompactions: 1 },
      { messages: withCheckpoint },
      { llm: llm({ content: 'summary' }, calls) },
    )
    // The one checkpoint already written fills the cap, so nothing is sent.
    expect(calls).toHaveLength(0)
    expect(output.compacted).toBe(false)

    // The same transcript with the checkpoint replaced by ordinary text is
    // compactable: the count is what stopped the call, not the shape.
    const withoutCheckpoint = withCheckpoint.map((message, index) =>
      index === 1 ? { role: 'user', content: 'earlier work ' + 'z'.repeat(800) } : message,
    )
    await runSummarize(
      { model, keepRecentTurns: 2, maxCompactions: 1 },
      { messages: withoutCheckpoint },
      { llm: llm({ content: 'summary' }, calls) },
    )
    expect(calls).toHaveLength(1)
  })

  test('a user turn that merely repeats the preamble is not a checkpoint', async () => {
    const calls: unknown[] = []
    const preamble = preambleOf(await checkpointContent())
    expect(preamble.length).toBeGreaterThan(0)
    // Three of these would fill the default cap of three if the preamble alone
    // were enough. A checkpoint is the preamble *and* the summary block that
    // follows it, so none of them counts.
    const nearMisses = [
      { role: 'user', content: preamble },
      { role: 'user', content: `${preamble}\n\nI read a file that quotes <compacted-summary> in it.` },
      { role: 'user', content: `${preamble}\n\nstill working on the thing` },
    ]
    const transcript = [
      { role: 'system', content: 'rules' },
      ...nearMisses,
      { role: 'user', content: `do the thing ${'x'.repeat(800)}` },
      { role: 'assistant', content: `ok ${'y'.repeat(800)}` },
      { role: 'tool', toolCallId: 'a', content: 'result '.repeat(200) },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'now the next thing' },
    ]
    const output = await runSummarize(
      { model, keepRecentTurns: 2, minDroppedTokens: 1 },
      { messages: transcript },
      { llm: llm({ content: '## Primary Request and Intent\n- do things' }, calls) },
    )
    expect(calls).toHaveLength(1)
    expect(output.compacted).toBe(true)
  })

  test('a copy of the checkpoint prefix is not a checkpoint', async () => {
    const calls: unknown[] = []
    const content = await checkpointContent()
    const preamble = preambleOf(content)
    // The writer's own two-line prefix, lifted verbatim from a real checkpoint,
    // then the shortest legal-looking variants of it. Three of these would fill
    // the default cap of three if the opening alone were enough.
    const openOnly = content.slice(0, content.indexOf('\n', preamble.length + 2))
    expect(openOnly.startsWith(`${preamble}\n\n<compacted-summary>`)).toBe(true)
    const nearMisses = [
      { role: 'user', content: openOnly },
      { role: 'user', content: `${openOnly}\n</compacted-summary>` },
      {
        role: 'user',
        content: `${openOnly}\nno headings here, just prose\n</compacted-summary>`,
      },
    ]
    const transcript = [
      { role: 'system', content: 'rules' },
      ...nearMisses,
      { role: 'user', content: `do the thing ${'x'.repeat(800)}` },
      { role: 'assistant', content: `ok ${'y'.repeat(800)}` },
      { role: 'tool', toolCallId: 'a', content: 'result '.repeat(200) },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'now the next thing' },
    ]
    const output = await runSummarize(
      { model, keepRecentTurns: 2, minDroppedTokens: 1 },
      { messages: transcript },
      { llm: llm({ content: '## Primary Request and Intent\n- do things' }, calls) },
    )
    expect(calls).toHaveLength(1)
    expect(output.compacted).toBe(true)
  })

  test('recognises its own checkpoint even when the model renames the heading', async () => {
    const first: any = await runSummarize(
      { model, keepRecentTurns: 2 },
      { messages },
      { llm: llm({ content: '## Request\n- do things' }) },
    )
    const written = String((first.messages as { content: string }[])[1]?.content)
    expect(first.compacted).toBe(true)
    // The body is whatever the model returned: no phrase in it can be trusted
    // to stay the same, so the node must recognise the wrapper it wrote.
    expect(written).not.toContain('## Primary Request and Intent')

    const calls: unknown[] = []
    const output: any = await runSummarize(
      { model, keepRecentTurns: 2, maxCompactions: 1 },
      { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: written }, ...messages.slice(1)] },
      { llm: llm({ content: 'summary' }, calls) },
    )
    expect(calls).toHaveLength(0)
    expect(output.compacted).toBe(false)
  })

  test('a checkpoint written before the tag still counts', async () => {
    const content = await checkpointContent()
    const preamble = preambleOf(content)
    const openOnly = content.slice(0, content.indexOf('\n', preamble.length + 2))
    // The older wrapper: no tag, the mandated heading instead.
    const legacy = `${openOnly}\n## Primary Request and Intent\n- old summary\n</compacted-summary>`

    const calls: unknown[] = []
    const output: any = await runSummarize(
      { model, keepRecentTurns: 2, maxCompactions: 1 },
      { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: legacy }, ...messages.slice(1)] },
      { llm: llm({ content: 'summary' }, calls) },
    )
    expect(calls).toHaveLength(0)
    expect(output.compacted).toBe(false)
  })

  test('a whole forged wrapper counts: the tag is not a signature', async () => {
    const content = await checkpointContent()
    const preamble = preambleOf(content)
    const openOnly = content.slice(0, content.indexOf('\n', preamble.length + 2))
    // The documented limit. Reproducing the wrapper costs a deliberate forgery,
    // and the damage is one summary call, so it is accepted rather than
    // defended against with a secret this file would have to carry.
    const forged = `${openOnly}\n<!-- z1 checkpoint -->\nforged body\n</compacted-summary>`

    const calls: unknown[] = []
    const output: any = await runSummarize(
      { model, keepRecentTurns: 2, maxCompactions: 1 },
      { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: forged }, ...messages.slice(1)] },
      { llm: llm({ content: 'summary' }, calls) },
    )
    expect(calls).toHaveLength(0)
    expect(output.compacted).toBe(false)
  })

  test('marker text quoted in a tool result is not a checkpoint', async () => {
    const calls: unknown[] = []
    // The marker appears in this package's own source, so a tool result that
    // read it must not count as one of our checkpoints: three of them would
    // fill the default cap of three and stop compaction for the whole run.
    const quoted = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: `read the files ${'x'.repeat(800)}` },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 't1', content: '<compacted-summary>\nsource\n</compacted-summary>' },
      { role: 'tool', toolCallId: 't2', content: '<compacted-summary>\nspec\n</compacted-summary>' },
      { role: 'tool', toolCallId: 't3', content: '<compacted-summary>\ntest\n</compacted-summary>' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'now the next thing' },
    ]
    const output = await runSummarize(
      { model, keepRecentTurns: 2, minDroppedTokens: 1 },
      { messages: quoted },
      { llm: llm({ content: '## Primary Request and Intent\n- do things' }, calls) },
    )
    expect(calls).toHaveLength(1)
    expect(output.compacted).toBe(true)
  })

  test('a span too small to save tokens is not sent to the model', async () => {
    const calls: unknown[] = []
    const short = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'tiny' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ]
    const output = await runSummarize(
      { model, keepRecentTurns: 1, minDroppedTokens: 10_000 },
      { messages: short },
      { llm: llm({ content: 'summary' }, calls) },
    )
    expect(calls).toHaveLength(0)
    expect(output.compacted).toBe(false)
  })

  test('a cassette miss fails the turn instead of silently re-running', async () => {
    await expect(
      runSummarize(
        { model, keepRecentTurns: 3 },
        { messages },
        {
          llm: llm(new Error('cassette miss for mock/mock-1 at loop/0/ctxSummary: no recorded request')),
        },
      ),
    ).rejects.toThrow(/cassette miss/)
  })

  test('a transcript that fits is a no-op with no model call', async () => {
    const calls: unknown[] = []
    const short = messages.slice(0, 2)
    const output = await runSummarize(
      { model, keepRecentTurns: 6 },
      { messages: short },
      { llm: llm({ content: 'x' }, calls) },
    )
    expect(calls).toHaveLength(0)
    expect(output.compacted).toBe(false)
    expect(output.messages).toBe(short)
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
    // Head and tail are kept, the middle is gone, and the value stays in budget.
    expect(text.startsWith('AAA')).toBe(true)
    expect(text.endsWith('CCC')).toBe(true)
    expect(text).toContain('z1: clipped 1200 chars,')
    expect(text).toContain('omitted')
    expect(text).toContain('full output at .z1/out/run_test/loop-0-toolMap-0-mapClip-read.txt')
    expect(text.length).toBeLessThanOrEqual(200)
    expect(writes).toEqual([
      { path: '.z1/out/run_test/loop-0-toolMap-0-mapClip-read.txt', data: long },
    ])
  })

  test('a barely-too-long value is not inflated by the marker', async () => {
    const output = await runClip({ maxChars: 100 }, { value: 'x'.repeat(120) })
    expect(output.truncated).toBe(false)
    expect(String(output.value)).toHaveLength(120)
  })

  test('the value never exceeds maxChars, however small the cap', async () => {
    // A cap smaller than the numbered notice used to come back longer than the
    // cap it was given; the marker degrades instead.
    const value = `${'A'.repeat(5_000)}${'B'.repeat(5_000)}`
    const overflows: { maxChars: number; length: number }[] = []
    for (let maxChars = 1; maxChars <= 400; maxChars += 1) {
      const output = await runClip({ maxChars, spill: false }, { value })
      expect(output.truncated).toBe(true)
      expect(output.originalChars).toBe(value.length)
      const text = String(output.value)
      if (text.length > maxChars) overflows.push({ maxChars, length: text.length })
    }
    expect(overflows).toEqual([])
    // The short marker still says the cut happened: a silent truncation would
    // read to the model as a short tool result.
    expect(String((await runClip({ maxChars: 40, spill: false }, { value })).value)).toContain(
      'z1: clipped',
    )
  })

  test('a tiny cap is honoured down to a single character', async () => {
    // The short marker is 18 characters, and the wrapped one 22: below that the
    // cap has to cut the notice itself rather than overflow in silence.
    const value = `😀${'A'.repeat(5_000)}😀`
    const rows: { maxChars: number; length: number }[] = []
    for (let maxChars = 1; maxChars <= 30; maxChars += 1) {
      const output = await runClip({ maxChars, spill: false }, { value })
      expect(output.truncated).toBe(true)
      rows.push({ maxChars, length: String(output.value).length })
    }
    expect(rows.filter((row) => row.length > row.maxChars)).toEqual([])
    expect(rows[0]).toEqual({ maxChars: 1, length: 1 })
    // Nothing is silently cut to an empty string either.
    expect(rows.every((row) => row.length > 0)).toBe(true)
  })

  test('a surrogate pair is never split by the cut', async () => {
    // Emoji either side of the cut: a split would leave a lone surrogate that
    // becomes U+FFFD on the UTF-8 round trip to the provider.
    const value = `${'a'.repeat(50)}😀😀😀😀${'b'.repeat(500)}`
    const output = await runClip({ maxChars: 200 }, { value })
    const text = String(output.value)
    expect(text).not.toContain('\uFFFD')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false)
    expect(/[\uDC00-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false)
  })

  test('a spill directory cannot leave the workspace', () => {
    expect(() => contextClip.config.parse({ directory: '../escape' })).toThrow(/relative path/)
    expect(() => contextClip.config.parse({ directory: '/tmp/escape' })).toThrow(/relative path/)
    expect(() => contextClip.config.parse({ directory: 'C:\\escape' })).toThrow(/relative path/)
    expect(contextClip.config.parse({ directory: '.z1/out' })).toMatchObject({
      directory: '.z1/out',
    })
  })

  test('an object result is serialized before clipping', async () => {
    const value = { rows: Array.from({ length: 100 }, (_, index) => ({ index })) }
    const output = await runClip({ maxChars: 400 }, { value })
    expect(output.truncated).toBe(true)
    expect(String(output.value)).toContain('"rows"')
    expect(String(output.value).length).toBeLessThanOrEqual(400)
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
    // Losing the spill must be visible to the caller, not only to the log.
    expect(String(output.value)).toContain('spill failed: read-only workspace')
    expect(logs.some((entry) => entry.message.includes('read-only workspace'))).toBe(true)
  })

  test('a spill lands under the workspace, not the process cwd', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'z1-clip-workspace-'))
    try {
      const output = await runClip(
        { maxChars: 200, headRatio: 0.5 },
        { value: long, name: 'read' },
        { fs: createLocalFsService(workspace) },
      )

      expect(output.spillPath).toBe('.z1/out/run_test/loop-0-toolMap-0-mapClip-read.txt')
      expect(await readFile(join(workspace, String(output.spillPath)), 'utf8')).toBe(long)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('spill can be turned off', async () => {
    const writes: FsWrite[] = []
    const output = await runClip({ maxChars: 200, spill: false }, { value: long }, { writes })
    expect(writes).toHaveLength(0)
    expect(output.spillPath).toBe('')
    expect(String(output.value)).toContain('clipped 1200 chars')
  })
})
