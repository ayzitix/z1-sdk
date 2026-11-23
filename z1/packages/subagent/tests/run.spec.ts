import { describe, expect, test, vi } from 'vitest'

import { SqliteJournal } from '@z1/journal'
import type { ChatResult, Json } from '@z1/node'
import {
  MemoryJournal,
  type Journal,
  type LlmService,
  type RunEvent,
} from '@z1/runtime'

import {
  createSubagentTool,
  SUBAGENT_TOOL_NAME,
  SubagentBudget,
  SubagentError,
  type SubagentCallGuard,
  type SubagentInventory,
  type SubagentRunRecorder,
} from '../src/index.ts'
import {
  createFakeHost,
  createTestJournal,
  gatedLlm,
  hangingLlm,
  schema,
  staticLlm,
  tick,
} from './fakes.ts'

const wiring = vi.hoisted(() => ({
  calls: [] as string[][],
  callCalls: 0,
  listCalls: 0,
}))

// Wrap the real restrictToolService so the test can prove its returned service
// is the one runGraph receives, not just that the function was called.
vi.mock('../src/restrict.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/restrict.ts')>()
  return {
    ...actual,
    restrictToolService: (
      inner: Parameters<typeof actual.restrictToolService>[0],
      names: readonly string[],
      options: Parameters<typeof actual.restrictToolService>[2] = {},
    ) => {
      wiring.calls.push([...names])
      const service = actual.restrictToolService(inner, names, options)
      return {
        async list() {
          wiring.listCalls += 1
          return await service.list()
        },
        async call(name: string, args: Json) {
          wiring.callCalls += 1
          return await service.call(name, args)
        },
      }
    },
  }
})

const MODEL = { provider: 'mock', model: 'mock-1' } as const

const inventory: SubagentInventory = {
  installed: [schema('read'), schema('grep'), schema('shell')],
  enabled: [schema('read'), schema('grep')],
}

const validArgs = {
  description: 'inspect one file',
  prompt: 'read the file and report the first line',
  tools: { enable: ['read'] },
}

interface ToolOverrides {
  readonly inventory?: SubagentInventory
  readonly depth?: number
  readonly maxSteps?: number
  readonly timeoutMs?: number
  readonly budget?: SubagentBudget
  readonly guardCall?: SubagentCallGuard
  readonly signal?: AbortSignal
}

function toolFor(
  host: ReturnType<typeof createFakeHost>,
  overrides: ToolOverrides = {},
) {
  return createSubagentTool({
    model: MODEL,
    host,
    inventory: overrides.inventory ?? inventory,
    ...(overrides.depth === undefined ? {} : { depth: overrides.depth }),
    ...(overrides.maxSteps === undefined ? {} : { maxSteps: overrides.maxSteps }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.budget === undefined ? {} : { budget: overrides.budget }),
    ...(overrides.guardCall === undefined ? {} : { guardCall: overrides.guardCall }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  })
}

async function runError(promise: Promise<unknown>): Promise<SubagentError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SubagentError)
    return error as SubagentError
  }
  throw new Error('expected the subagent run to fail')
}

describe('runSubagent journal and lifecycle', () => {
  test('records the child run without fork lineage', async () => {
    const model = staticLlm('child answer')
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: model.llm,
      journal,
    })
    const tool = toolFor(host)

    const result = await tool.call(validArgs)

    expect(result.runId).toMatch(/^run_/)
    const record = journal.runs.get(result.runId)
    expect(record?.graphId).toBe('agent.loop')
    expect(record?.graphDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(record?.status).toBe('completed')
    expect(record).not.toHaveProperty('parentRunId')
    expect(Object.hasOwn(record ?? {}, 'parentRunId')).toBe(false)

    expect(journal.updates).toHaveLength(1)
    expect(journal.updates[0]).toMatchObject({
      runId: result.runId,
      patch: { status: 'completed' },
    })

    const events = journal.events.get(result.runId) ?? []
    expect(events.map((event) => event.type)).toContain('run.started')
    expect(events.map((event) => event.type)).toContain('run.completed')
    expect(events.every((event) => event.runId === result.runId)).toBe(true)

    const started = events.find((event) => event.type === 'run.started')
    expect(started?.type === 'run.started' ? started.input : undefined).toBe(validArgs.prompt)
  })

  test('runSubagent wires the restricted service result into runGraph', async () => {
    wiring.calls.length = 0
    wiring.callCalls = 0
    wiring.listCalls = 0
    const host = createFakeHost({
      tools: [schema('read'), schema('shell')],
    })
    const tool = toolFor(host)

    const result = await tool.call({
      ...validArgs,
      prompt: '[[tool:read]] read the file',
    })

    expect(result.output).toBe('mock: done')
    expect(wiring.calls).toEqual([['read']])
    expect(wiring.callCalls).toBe(1)
    expect(host.handles[0]?.services.toolCalls).toEqual([{ name: 'read', args: {} }])

    // An empty grant forces the graph to ask the live list; the wrapper's list
    // must be the service that answers.
    wiring.calls.length = 0
    wiring.listCalls = 0
    const empty = await tool.call({ ...validArgs, tools: { enable: [] } })
    expect(empty.tools).toEqual([])
    expect(wiring.calls).toEqual([[]])
    expect(wiring.listCalls).toBeGreaterThan(0)
  })

  test('passes deny approval and module approval to beginRun', async () => {
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
    })
    const tool = toolFor(host)

    await tool.call(validArgs)

    const begin = host.beginCalls[0]
    expect(begin).toBeDefined()
    await expect(
      begin?.approval.request({ action: 'tool.call' }, { runId: 'parent', nodeId: 'n' }),
    ).resolves.toBe('rejected')
    await expect(
      begin?.moduleApproval?.request({ action: 'module' }, { runId: 'parent', nodeId: 'n' }),
    ).resolves.toBe('rejected')
  })

  test('disposes the child on timeout and records a failed run', async () => {
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: hangingLlm,
      journal,
    })
    const tool = toolFor(host, { timeoutMs: 20 })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_timeout')
    expect(error.message).toContain('graph run')
    expect(host.handles[0]?.disposed).toBe(true)
    const runId = host.beginCalls[0]?.runId
    expect(runId).toBeDefined()
    // A timeout is not a parent cancellation: the child did not finish, so its
    // row is `failed`, unlike a host abort which records `cancelled`.
    expect(journal.runs.get(runId ?? '')?.status).toBe('failed')
  })

  test('disposes the child when the run fails at the step limit', async () => {
    let call = 0
    const alwaysToolCall: LlmService = {
      async chat(): Promise<ChatResult> {
        call += 1
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: `call_${String(call)}`, name: 'read', arguments: {} }],
          stopReason: 'tool_calls',
        }
      },
    }
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: alwaysToolCall,
      journal,
    })
    const tool = toolFor(host, { maxSteps: 2 })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_failed')
    expect(error.message).toContain('step limit reached after 2 steps')
    expect(host.handles[0]?.disposed).toBe(true)
    const runId = host.beginCalls[0]?.runId
    expect(journal.runs.get(runId ?? '')?.status).toBe('failed')
    expect(host.handles[0]?.services.toolCalls).toHaveLength(2)
  })

  test('a beginRun failure starts no child and does not consume maxTotal', async () => {
    const budget = new SubagentBudget({ maxTotal: 1 })
    const host = createFakeHost({
      beforeBegin: async () => {
        throw new Error('runtime is closed')
      },
    })
    const tool = toolFor(host, { budget })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_failed')
    expect(error.message).toContain('runtime is closed')
    expect(host.handles).toEqual([])
    expect(budget.total).toBe(0)
    expect(budget.active).toBe(0)
  })

  test('a journal createRun failure still disposes the child', async () => {
    const journal = createTestJournal()
    journal.createRun = () => {
      throw new Error('journal is closed')
    }
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      journal,
    })
    const tool = toolFor(host)

    await expect(tool.call(validArgs)).rejects.toThrow(/journal is closed/)
    expect(host.handles[0]?.disposed).toBe(true)
  })

  test('a create-only run recorder fails before beginRun', async () => {
    const journal = createTestJournal()
    const createOnly = {
      createRun: journal.createRun,
    } as unknown as SubagentRunRecorder
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      journal,
      runs: createOnly,
    })
    const tool = toolFor(host)

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('both createRun and updateRun')
    expect(host.beginCalls).toEqual([])
    expect(journal.runs.size).toBe(0)
  })

  test('an update-only run recorder fails before beginRun', async () => {
    const journal = createTestJournal()
    const updateOnly = {
      updateRun: journal.updateRun,
    } as unknown as SubagentRunRecorder
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      journal,
      runs: updateOnly,
    })
    const tool = toolFor(host)

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain('both createRun and updateRun')
    expect(host.beginCalls).toEqual([])
    expect(journal.runs.size).toBe(0)
  })

  test('a failing completed update is retried as failed and fails closed', async () => {
    const journal = createTestJournal()
    const statuses: string[] = []
    const recorder: SubagentRunRecorder = {
      createRun(record): void {
        journal.createRun(record)
      },
      updateRun(runId, patch): void {
        statuses.push(patch.status)
        if (patch.status === 'completed') throw new Error('disk full')
        journal.updateRun(runId, patch)
      },
    }
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      journal,
      runs: recorder,
    })
    const tool = toolFor(host)

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_failed')
    expect(error.message).toContain('could not record completed status')
    expect(statuses).toEqual(['completed', 'failed'])
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
    expect(host.handles[0]?.disposed).toBe(true)
  })

  test('a failing failed-status update is retried once and records failed', async () => {
    const journal = createTestJournal()
    const statuses: string[] = []
    let failedUpdates = 0
    const recorder: SubagentRunRecorder = {
      createRun(record): void {
        journal.createRun(record)
      },
      updateRun(runId, patch): void {
        statuses.push(patch.status)
        if (patch.status === 'failed') {
          failedUpdates += 1
          if (failedUpdates === 1) throw new Error('transient disk error')
        }
        journal.updateRun(runId, patch)
      },
    }
    let calls = 0
    const alwaysToolCall: LlmService = {
      async chat(): Promise<ChatResult> {
        calls += 1
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: `call_${String(calls)}`, name: 'read', arguments: {} }],
          stopReason: 'tool_calls',
        }
      },
    }
    const host = createFakeHost({
      tools: [schema('read')],
      llm: alwaysToolCall,
      journal,
      runs: recorder,
    })
    const tool = toolFor(host, { maxSteps: 1 })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_failed')
    expect(error.message).toContain('step limit reached after 1 steps')
    expect(statuses).toEqual(['failed', 'failed'])
    expect(failedUpdates).toBe(2)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
    expect(host.handles[0]?.disposed).toBe(true)
  })

  test('a partial run journal on host.journal is rejected before beginRun', async () => {
    for (const kind of ['create', 'update'] as const) {
      const base = createTestJournal()
      const partial = {
        append: base.append.bind(base),
        read: base.read.bind(base),
        ...(kind === 'create'
          ? { createRun: base.createRun.bind(base) }
          : { updateRun: base.updateRun.bind(base) }),
      } as unknown as Journal
      const host = createFakeHost({
        tools: [schema('read')],
        llm: staticLlm('ok').llm,
        journal: partial,
      })
      const tool = toolFor(host)

      const error = await runError(tool.call(validArgs))

      expect(error.code).toBe('invalid_input')
      expect(error.message).toContain('host.journal must provide both')
      expect(host.beginCalls).toEqual([])
      expect(base.runs.size).toBe(0)
    }
  })

  test('explicit complete runs wins over a partial journal capability', async () => {
    const events = new Map<string, RunEvent[]>()
    const partialJournal = {
      append(event: RunEvent): void {
        const rows = events.get(event.runId) ?? []
        rows.push(event)
        events.set(event.runId, rows)
      },
      read(runId: string): readonly RunEvent[] {
        return events.get(runId) ?? []
      },
      createRun(): void {
        // Deliberately only one of the two recorder methods.
      },
    } as unknown as Journal
    const recorder = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      journal: partialJournal,
      runs: recorder,
    })
    const tool = toolFor(host)

    const result = await tool.call(validArgs)

    expect(result.status).toBe('completed')
    expect(recorder.runs.get(result.runId)?.status).toBe('completed')
    expect(
      events.get(result.runId)?.some((event) => event.type === 'run.completed'),
    ).toBe(true)
  })

  test('an event-only MemoryJournal runs without run rows', async () => {
    const journal = new MemoryJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      journal,
    })
    expect(host.runs).toBeUndefined()
    const tool = toolFor(host)

    const result = await tool.call(validArgs)

    expect(result.status).toBe('completed')
    expect(
      journal.read(result.runId).some((event) => event.type === 'run.completed'),
    ).toBe(true)
  })

  test('a production-shaped host with a SqliteJournal and no runs records a completed row', async () => {
    const journal = new SqliteJournal(':memory:')
    try {
      const host = createFakeHost({
        tools: [schema('read')],
        llm: staticLlm('ok').llm,
        journal,
      })
      expect(host.runs).toBeUndefined()
      const tool = toolFor(host)

      const result = await tool.call(validArgs)

      const record = journal.getRun(result.runId)
      expect(record?.status).toBe('completed')
      expect(record).not.toHaveProperty('parentRunId')
      expect(
        journal.read(result.runId).some((event) => event.type === 'run.completed'),
      ).toBe(true)
    } finally {
      journal.close()
    }
  })

  test('a failed child updates its durable row to failed', async () => {
    const journal = new SqliteJournal(':memory:')
    try {
      let calls = 0
      const alwaysToolCall: LlmService = {
        async chat(): Promise<ChatResult> {
          calls += 1
          return {
            message: { role: 'assistant', content: '' },
            toolCalls: [
              { id: `call_${String(calls)}`, name: 'read', arguments: {} },
            ],
            stopReason: 'tool_calls',
          }
        },
      }
      const host = createFakeHost({
        tools: [schema('read')],
        llm: alwaysToolCall,
        journal,
      })
      const tool = toolFor(host, { maxSteps: 1 })

      const error = await runError(tool.call(validArgs))

      expect(error.code).toBe('child_failed')
      const runId = host.beginCalls[0]?.runId ?? ''
      expect(journal.getRun(runId)?.status).toBe('failed')
    } finally {
      journal.close()
    }
  })

  test('an event-only durable wrapper fails closed without a running row', async () => {
    const inner = new SqliteJournal(':memory:')
    try {
      const tee = {
        append(event: RunEvent): void {
          inner.append(event)
        },
        read(runId: string): readonly RunEvent[] {
          return inner.read(runId)
        },
      }
      const host = createFakeHost({
        tools: [schema('read')],
        llm: staticLlm('ok').llm,
        journal: tee,
      })
      const tool = toolFor(host)

      const error = await runError(tool.call(validArgs))

      expect(error.code).toBe('child_failed')
      expect(error.message).toContain('cannot append to unknown run')
      const runId = host.beginCalls[0]?.runId ?? ''
      expect(inner.getRun(runId)).toBeUndefined()
      expect(host.handles[0]?.disposed).toBe(true)
    } finally {
      inner.close()
    }
  })

  test('a guardCall hook revokes a granted child tool mid-run', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host, {
      guardCall: (name) => {
        if (name === 'read') throw new Error('tool "read" is off')
      },
    })

    const result = await tool.call({
      ...validArgs,
      prompt: '[[tool:read]] read the file',
    })

    expect(result.output).toBe('mock: done')
    expect(host.handles[0]?.services.toolCalls).toEqual([])
    const second = host.handles[0]?.services.chatCalls[1]
    const toolMessage = second?.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('is off')
  })

  test('the timeout covers the graph run, not child tool setup', async () => {
    let release!: () => void
    const listGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = createFakeHost({
      tools: async () => {
        await listGate
        return [schema('read')]
      },
      llm: staticLlm('ok').llm,
    })
    const tool = toolFor(host, { timeoutMs: 10 })

    const pending = tool.call(validArgs)
    await tick()

    const outcome = await Promise.race([
      pending.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ])
    expect(outcome).toBe('pending')

    release()
    await expect(pending).resolves.toMatchObject({ status: 'completed' })
  })
})

describe('runSubagent limits', () => {
  test('refuses to run when the caller is already at depth 1', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host, { depth: 1 })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('depth_exceeded')
    expect(error.message).toContain('v1 supports only the main agent')
    expect(host.beginCalls).toEqual([])
  })

  test('refuses a grant that names the delegation tool', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const hostInventory: SubagentInventory = {
      installed: [...inventory.installed, schema(SUBAGENT_TOOL_NAME)],
      enabled: [...inventory.enabled, schema(SUBAGENT_TOOL_NAME)],
    }
    const tool = toolFor(host, { inventory: hostInventory })

    const error = await runError(
      tool.call({ ...validArgs, tools: { enable: [SUBAGENT_TOOL_NAME] } }),
    )

    expect(error.code).toBe('depth_exceeded')
    expect(host.beginCalls).toEqual([])
  })

  test('default budget allows 4 active and 8 total children', () => {
    const active = new SubagentBudget()
    const reservations = Array.from({ length: 4 }, () => active.reserve())
    expect(() => active.reserve()).toThrow(/4 child run\(s\) are already active/)
    for (const reservation of reservations) reservation.release()

    const total = new SubagentBudget()
    for (let index = 0; index < 8; index += 1) {
      const reservation = total.reserve()
      reservation.commit()
      reservation.release()
    }
    expect(() => total.reserve()).toThrow(/8 child run\(s\) have already started/)
  })

  test('a shared budget caps maxTotal across tool instances', async () => {
    const budget = new SubagentBudget({ maxTotal: 1 })
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
    })
    const first = toolFor(host, { budget })
    const second = toolFor(host, { budget })

    await first.call(validArgs)
    const error = await runError(second.call(validArgs))

    expect(error.code).toBe('limit_exceeded')
    expect(host.beginCalls).toHaveLength(1)
  })

  test('maxChildren rejects a concurrent child before beginRun', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const budget = new SubagentBudget({ maxChildren: 1 })
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      beforeBegin: async () => {
        await gate
      },
    })
    const tool = toolFor(host, { budget })

    const first = tool.call(validArgs)
    await tick()
    expect(host.beginCalls).toHaveLength(1)

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('limit_exceeded')
    expect(host.beginCalls).toHaveLength(1)

    release()
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(budget.active).toBe(0)
    expect(budget.total).toBe(1)
  })
})

describe('runSubagent parent cancellation', () => {
  test('a host abort during a live child turn records and reports cancelled', async () => {
    const model = gatedLlm()
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: model.llm,
      journal,
    })
    const parent = new AbortController()
    const tool = toolFor(host, { signal: parent.signal })

    const pending = tool.call(validArgs)
    await model.pendingCall
    const runId = host.beginCalls[0]?.runId ?? ''
    // The row exists and is `running` while the child is live.
    expect(journal.runs.get(runId)?.status).toBe('running')

    parent.abort()

    const error = await runError(pending)
    expect(error.code).toBe('child_cancelled')
    expect(error.message).toContain('cancelled by the parent')
    expect(host.handles[0]?.disposed).toBe(true)

    const record = journal.runs.get(runId)
    expect(record?.status).toBe('cancelled')
    expect(record).not.toHaveProperty('parentRunId')
    expect(Object.hasOwn(record ?? {}, 'parentRunId')).toBe(false)

    const events = journal.events.get(runId) ?? []
    expect(events.map((event) => event.type)).toContain('run.cancelled')
    expect(events.map((event) => event.type)).not.toContain('run.failed')
    // The child's restricted tool service never ran a tool call.
    expect(host.handles[0]?.services.toolCalls).toEqual([])
  })

  test('a child that throws during the run is cancelled when the host aborted', async () => {
    // The other `runGraph` shape: the run itself throws instead of returning a
    // result, so the call arrives with no `RunResult`. The journal row and the
    // error must still say "the parent cancelled", not "the child failed". The
    // host aborts from inside the run (on its `run.started` append), so the
    // abort lands mid-run rather than in the pre-start check.
    const model = gatedLlm()
    model.failNext()
    const journal = createTestJournal()
    const parent = new AbortController()
    const append = journal.append.bind(journal)
    journal.append = (event: RunEvent): void => {
      append(event)
      if (event.type === 'run.started') parent.abort()
    }
    const host = createFakeHost({
      tools: [schema('read')],
      llm: model.llm,
      journal,
    })
    const tool = toolFor(host, { signal: parent.signal })

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('child_cancelled')
    // Whether the abort surfaced as a throw, a `cancelled` result or a racing
    // completion, the error names the parent.
    expect(error.message).toContain('cancelled by the parent')
    expect(host.handles[0]?.disposed).toBe(true)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
  })

  test('a cancelled child whose terminal append was lost still ends with run.cancelled', async () => {
    // L-4: the row is rewritten to `cancelled`, so the events must not stop at
    // `node.started` or end on a contradicting `run.failed`. When the
    // executor's own `run.cancelled` append is rejected it falls back to
    // `run.failed`; the package then appends the `run.cancelled` its row names,
    // so the trace ends consistently.
    const journal = createTestJournal()
    const parent = new AbortController()
    const append = journal.append.bind(journal)
    journal.append = (event: RunEvent): void => {
      append(event)
      if (event.type === 'run.started') parent.abort()
    }
    journal.failNext('run.cancelled')
    const host = createFakeHost({ tools: [schema('read')], journal })
    const tool = toolFor(host, { signal: parent.signal })

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('child_cancelled')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
    const types = (journal.events.get(runId) ?? []).map((event) => event.type)
    // The executor's fallback `run.failed` is append-only history; what matters
    // is that the trace ends with the row's own terminal event, once.
    expect(types.at(-1)).toBe('run.cancelled')
    expect(types.filter((type) => type === 'run.cancelled')).toHaveLength(1)
  })

  test('an abort mid-run keeps the executor terminal event with no duplicate', async () => {
    // The normal abort path: `runGraph` writes `run.cancelled` itself and
    // resolves, so the package must not append a second one.
    const journal = createTestJournal()
    const parent = new AbortController()
    const append = journal.append.bind(journal)
    journal.append = (event: RunEvent): void => {
      append(event)
      if (event.type === 'run.started') parent.abort()
    }
    const host = createFakeHost({ tools: [schema('read')], journal })
    const tool = toolFor(host, { signal: parent.signal })

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('child_cancelled')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
    const types = (journal.events.get(runId) ?? []).map((event) => event.type)
    expect(types.filter((type) => type === 'run.cancelled')).toHaveLength(1)
    expect(types.filter((type) => type.startsWith('run.')).slice(-1)).toEqual(['run.cancelled'])
  })

  test('a timeout row failed ends with run.failed, not only run.cancelled', async () => {
    // The internal timer aborts the child, so `runGraph` writes
    // `run.cancelled` while the row says `failed`; the package appends the
    // matching `run.failed` so the last terminal event agrees with the row.
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], llm: hangingLlm, journal })
    const tool = toolFor(host, { timeoutMs: 20 })

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('child_timeout')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
    const types = (journal.events.get(runId) ?? []).map((event) => event.type)
    expect(types.at(-1)).toBe('run.failed')
    expect(types.filter((type) => type === 'run.failed')).toHaveLength(1)
  })

  test('a ledger that lost run.started gets no orphan terminal append', async () => {
    // `SqliteJournal` refuses an append to an unknown run. When the very first
    // event is lost, the run never started from the journal's point of view,
    // so there is nothing to append a terminal event to; the call still reports
    // an error, and no orphan event is invented.
    const journal = createTestJournal()
    const parent = new AbortController()
    journal.failNext('run.started')
    const host = createFakeHost({ tools: [schema('read')], journal })
    parent.abort()
    const tool = toolFor(host, { signal: parent.signal })

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('child_cancelled')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.events.get(runId) ?? []).toEqual([])
  })

  test('an abort before the call starts no child at all', async () => {
    const parent = new AbortController()
    parent.abort()
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host, { signal: parent.signal })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_cancelled')
    expect(error.message).toContain('before it started')
    expect(host.beginCalls).toEqual([])
    expect(host.handles).toEqual([])
    expect((host.journal as ReturnType<typeof createTestJournal>).runs.size).toBe(0)
  })

  test('an abort before a zero-grant child starts still starts no child', async () => {
    const parent = new AbortController()
    parent.abort()
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], journal })
    const tool = toolFor(host, { signal: parent.signal })

    const error = await runError(tool.call({ ...validArgs, tools: { enable: [] } }))

    expect(error.code).toBe('child_cancelled')
    expect(host.beginCalls).toEqual([])
    expect(journal.runs.size).toBe(0)
  })

  test('a zero-grant child is cancelled by a host abort like any other', async () => {
    const model = gatedLlm()
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], llm: model.llm, journal })
    const parent = new AbortController()
    const tool = toolFor(host, { signal: parent.signal })

    const pending = tool.call({ ...validArgs, tools: { enable: [] } })
    await model.pendingCall
    parent.abort()

    const error = await runError(pending)
    expect(error.code).toBe('child_cancelled')
    expect(host.handles[0]?.disposed).toBe(true)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
  })

  test('a timeout stays a timeout, not a cancellation', async () => {
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: hangingLlm,
      journal,
    })
    // A live host signal that is never aborted: only the timer can end the run.
    const tool = toolFor(host, {
      timeoutMs: 20,
      signal: new AbortController().signal,
    })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_timeout')
    expect(error.message).not.toContain('parent')
    expect(host.handles[0]?.disposed).toBe(true)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
  })

  test('a genuine child error stays failed with a live host signal', async () => {
    let call = 0
    const alwaysToolCall: LlmService = {
      async chat(): Promise<ChatResult> {
        call += 1
        return {
          message: { role: 'assistant', content: '' },
          toolCalls: [{ id: `call_${String(call)}`, name: 'read', arguments: {} }],
          stopReason: 'tool_calls',
        }
      },
    }
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: alwaysToolCall,
      journal,
    })
    const tool = toolFor(host, {
      maxSteps: 2,
      signal: new AbortController().signal,
    })

    const error = await runError(tool.call(validArgs))

    expect(error.code).toBe('child_failed')
    expect(error.message).toContain('step limit reached after 2 steps')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
  })

  test('a node that rejects with AbortError during a host abort is cancelled', async () => {
    // AbortSignal.reason / a provider adapter's rethrow is the canonical abort
    // error; it must not make an aborted child look failed.
    const journal = createTestJournal()
    const parent = new AbortController()
    const append = journal.append.bind(journal)
    journal.append = (event: RunEvent): void => {
      append(event)
      if (event.type === 'run.started') parent.abort()
    }
    const host = createFakeHost({
      tools: [schema('read')],
      llm: {
        async chat(): Promise<never> {
          throw new DOMException('This operation was aborted', 'AbortError')
        },
      },
      journal,
    })
    const tool = toolFor(host, { signal: parent.signal })

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('child_cancelled')
    expect(host.handles[0]?.disposed).toBe(true)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
  })

  test('an abort that races a finished graph still reports cancelled', async () => {
    // The host cancels while the child's one-shot model reply is in flight.
    // Even if the graph happens to finish, the parent will never read that
    // result: the row and the error say cancelled, not completed.
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: staticLlm('ok').llm,
      journal,
    })
    const parent = new AbortController()
    const tool = toolFor(host, { signal: parent.signal })

    // The mock replies synchronously, so abort on the run's own start event.
    const append = journal.append.bind(journal)
    journal.append = (event: RunEvent): void => {
      append(event)
      if (event.type === 'run.started') parent.abort()
    }

    const error = await runError(tool.call(validArgs))
    expect(error.code).toBe('child_cancelled')
    expect(host.handles[0]?.disposed).toBe(true)
    const runId = host.beginCalls[0]?.runId ?? ''
    const record = journal.runs.get(runId)
    expect(record?.status).toBe('cancelled')
    expect(record).not.toHaveProperty('parentRunId')
  })
})
