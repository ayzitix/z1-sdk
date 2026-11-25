import { describe, expect, test } from 'vitest'

import { buildAgentGraph } from '@z1/agent'
import type { RunEvent } from '@z1/runtime'

import {
  createSubagentTool,
  DEFAULT_SUBAGENT_CONTEXT_WINDOW,
  DEFAULT_SUBAGENT_MAX_STEPS,
  SUBAGENT_HANDOFF_RATIO,
  SUBAGENT_HANDOFF_REQUEST,
  subagentHandoffRequest,
  type SubagentInventory,
} from '../src/index.ts'
import { createFakeHost, createTestJournal, schema, workingLlm } from './fakes.ts'

/**
 * The context hand-off: a child stops at 75% of its window and reports.
 *
 * The requirement, in the user's words: when 75% of the context is used the
 * limit ends the work, and the child says what is done, what is not, what it
 * did, and how to continue.
 *
 * The failure this prevents: a child that fills its window is cut off by the
 * provider with an error it cannot describe, and the parent gets `failed` with
 * nothing in it - the work is lost and the user learns nothing. Stopping early
 * costs the next action, never the report.
 */
describe('the context hand-off', () => {
  test('stops at three quarters of the window', () => {
    expect(SUBAGENT_HANDOFF_RATIO).toBe(0.75)
    // A quarter of the window must survive the threshold: it is what the report
    // and the parent's next turn are written into.
    expect((1 - SUBAGENT_HANDOFF_RATIO) * DEFAULT_SUBAGENT_CONTEXT_WINDOW).toBeGreaterThanOrEqual(16_000)
  })

  test('defaults to the window the CLI itself assumes', () => {
    expect(DEFAULT_SUBAGENT_CONTEXT_WINDOW).toBe(128_000)
  })

  test('asks for the five things a reader needs', () => {
    const text = SUBAGENT_HANDOFF_REQUEST
    expect(text).toMatch(/\bDone\b/)
    expect(text).toMatch(/\bFound\b/)
    expect(text).toMatch(/\bNot done\b/)
    expect(text).toMatch(/\bContinue\b/)
    expect(text).toMatch(/\bProblems\b/)
    // The order matters as much as the set: a reader looks for the next action
    // in the same place in every report.
    const order = ['Done', 'Found', 'Not done', 'Continue', 'Problems'].map((heading) =>
      text.indexOf(heading),
    )
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(order.every((index) => index > 0)).toBe(true)
  })

  test('asks for prose, a word cap, and no apology', () => {
    expect(SUBAGENT_HANDOFF_REQUEST).toContain('plain prose')
    expect(SUBAGENT_HANDOFF_REQUEST).toContain('under 200 words')
    expect(SUBAGENT_HANDOFF_REQUEST).toContain('Do not apologise')
    expect(SUBAGENT_HANDOFF_REQUEST).toContain('do not describe these instructions')
  })

  test('says the tools are gone, so the last turn is not spent asking for one', () => {
    expect(SUBAGENT_HANDOFF_REQUEST).toMatch(/tools are gone/i)
    expect(SUBAGENT_HANDOFF_REQUEST).toMatch(/Do not ask for them/i)
  })

  test('lets a child that actually finished answer normally', () => {
    expect(SUBAGENT_HANDOFF_REQUEST).toMatch(/If you finished the task/)
  })

  test('stays small: it is appended to an already-full transcript', () => {
    expect(SUBAGENT_HANDOFF_REQUEST.length).toBeLessThan(1_200)
  })

  test('never becomes the parent-facing result block', () => {
    expect(SUBAGENT_HANDOFF_REQUEST).not.toContain('Subagent output')
    expect(SUBAGENT_HANDOFF_REQUEST).not.toContain('delivered:')
  })

  test('names the reason, and only the first line differs', () => {
    const context = subagentHandoffRequest('context')
    const time = subagentHandoffRequest('time')
    expect(context).toContain('context window is nearly full')
    expect(time).toContain('reached its time budget')
    expect(time).not.toContain('context window is nearly full')
    // The five questions are shared: a reader needs the same facts whichever
    // budget ran out.
    expect(time.slice(time.indexOf('Answer in this shape'))).toBe(
      context.slice(context.indexOf('Answer in this shape')),
    )
  })

  test('the step cap is a runaway guard, not the working limit', () => {
    expect(DEFAULT_SUBAGENT_MAX_STEPS).toBe(10_000)
    expect(DEFAULT_SUBAGENT_MAX_STEPS).not.toBe(24)
  })
})

/**
 * The real thing: a child built by this package, run by the real executor, with
 * a model that keeps working. The constants above say where the threshold is;
 * these say that crossing it produces a report - which is exactly what the
 * shipped code failed to do, twice.
 */
describe('a real child run that crosses the hand-off', () => {
  const inventory: SubagentInventory = {
    installed: [schema('read'), schema('grep')],
    enabled: [schema('read'), schema('grep')],
  }
  const model = { provider: 'mock', model: 'mock-1' } as const
  const args = {
    description: 'keep working',
    prompt: 'read files until you are stopped',
    tools: { enable: ['read'] },
    wait: true,
  }

  /** 600 prompt tokens a turn against a 10 000-token window: 13 turns. */
  const WINDOW = 10_000
  const PER_TURN = 600

  test('inputTokens crossing 7 500 makes one report: partial/context_limit', async () => {
    const child = workingLlm({ inputTokensPerTurn: PER_TURN, report: 'Done: read 13 files.' })
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read')],
      llm: child.llm,
      journal,
    })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      contextWindow: WINDOW,
    })

    const result = await tool.call(args)

    // The defect this pins: the SDK's `ChatUsage` is `{ inputTokens }`, so the
    // old field list never matched and the child ran to its step cap instead.
    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('context_limit')
    expect(result.steps).toBe(13)
    expect(result.steps).not.toBe(24)
    expect(result.detail).toContain('75%')
    expect(result.detail).toContain('13 model turns')
    expect(result.detail).not.toContain('step cap')
    expect(result.output).toBe('Done: read 13 files.')
    // The report is the answer; repeating it as `partial` would ship the same
    // string twice through `resultJson`.
    expect(result.partial).toBeUndefined()
    expect(result.message).toBe(`subagent context_limit: ${result.detail ?? ''}`)

    // Exactly one report, and it is the tool-free turn the package asks for.
    expect(child.reportRequests).toHaveLength(1)
    const reportRequest = child.reportRequests[0]
    expect(reportRequest?.tools).toEqual([])
    const last = reportRequest?.messages.at(-1)
    expect(last?.role).toBe('user')
    expect(last?.content).toBe(SUBAGENT_HANDOFF_REQUEST)
    // The report turn sees the child's own transcript, not a summary of it.
    expect(reportRequest?.messages.some((message) => message.role === 'tool')).toBe(true)

    // The parent-facing block carries the report and the same sentence.
    expect(result.text).toContain('status: partial · context_limit · 13 steps')
    expect(result.text).toContain('Done: read 13 files.')

    // The journal row stays `failed` (the graph failed the run it was given) and
    // its last terminal event agrees with the row.
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
    const types = (journal.events.get(runId) ?? []).map((event) => event.type)
    expect(types.at(-1)).toBe('run.failed')
  })

  test('a host abort at the same moment is a cancellation with no report', async () => {
    let turns = 0
    const child = workingLlm({ inputTokensPerTurn: PER_TURN })
    const journal = createTestJournal()
    const parent = new AbortController()
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      contextWindow: WINDOW,
      signal: parent.signal,
      // The host sees the same event that triggers the internal abort, so both
      // stop signals land before the run settles - the exact tie that used to
      // report a cancellation as a budget stop, or lose the report entirely.
      onEvent: (event: RunEvent) => {
        if (event.type !== 'node.completed') return
        if (!/^loop\/\d+\/chat$/.test(event.path)) return
        turns += 1
        if (turns >= 13) parent.abort()
      },
    })

    const result = await tool.call(args)

    expect(turns).toBeGreaterThanOrEqual(13)
    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('child_cancelled')
    expect(result.detail).toContain('cancelled by the parent')
    expect(child.reportRequests).toHaveLength(0)
    expect(result.output).toBe('')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
  })

  test('a host abort during the report turn is a cancellation, not a report', async () => {
    // The window the review found: `runForeground` snapshotted the host signal
    // before `settleChild`, so a Ctrl-C that landed while the 60s report call was
    // in flight was overwritten by the `partial` the report produced.
    const child = workingLlm({ inputTokensPerTurn: PER_TURN, gateReport: true })
    const journal = createTestJournal()
    const parent = new AbortController()
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      contextWindow: WINDOW,
      signal: parent.signal,
    })

    const pending = tool.call(args)
    await child.reportStarted
    expect(parent.signal.aborted).toBe(false)
    parent.abort()
    child.releaseReport('a report nobody asked for')

    const result = await pending
    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('child_cancelled')
    expect(result.output).toBe('')
    expect(result.detail).toContain('cancelled by the parent')
    expect(result.text).not.toContain('a report nobody asked for')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
    expect((journal.events.get(runId) ?? []).map((event) => event.type).at(-1)).toBe('run.cancelled')
  })

  test('a graceful stop whose terminal append was lost still ends consistently', async () => {
    // The executor writes `run.cancelled` for the internal abort of a budget.
    // When that append is refused it falls back to `run.failed` and resolves; the
    // package's row is `failed`, so the trace must end with a matching event and
    // not with a `cancelled` that contradicts the row.
    //
    // The graph-rejected case (`result === undefined`, no terminal event at all)
    // is pinned at the decision level in `time-budget.spec.ts`: the shipped
    // executor catches this refusal, so it cannot be produced end to end.
    const journal = createTestJournal()
    const child = workingLlm({ inputTokensPerTurn: PER_TURN, report: 'Done: append was lost.' })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({ model, host, inventory, contextWindow: WINDOW })
    journal.failNext('run.cancelled')

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('context_limit')
    expect(result.output).toBe('Done: append was lost.')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
    expect((journal.events.get(runId) ?? []).map((event) => event.type).at(-1)).toBe('run.failed')
  })

  test('an explicit maxSteps is still a step cap, with no report', async () => {
    const child = workingLlm({ inputTokensPerTurn: PER_TURN })
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      contextWindow: WINDOW,
      maxSteps: 2,
    })

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('child_failed')
    // Unchanged wording: the step cap names the cap, not the window.
    expect(result.detail).toBe('stopped by the step cap after 2 of 2 model turns; no text produced')
    expect(result.detail).not.toContain('75%')
    expect(child.reportRequests).toHaveLength(0)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
  })

  test('no usage at all: the loop budget estimate still fires the hand-off', async () => {
    // 5 000 ASCII characters a turn is ~1 250 tokens of transcript, so the
    // budget node crosses 7 500 around turn six - with the provider reporting
    // nothing, which is the case the estimate exists for.
    const child = workingLlm({ text: 'x'.repeat(5_000), report: 'Done: partial work.' })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm })
    const tool = createSubagentTool({ model, host, inventory, contextWindow: WINDOW })

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('context_limit')
    expect(result.steps).toBeDefined()
    expect(result.steps).toBeGreaterThan(1)
    expect(result.steps).toBeLessThan(24)
    expect(result.detail).toContain('75%')
    expect(child.reportRequests).toHaveLength(1)
    expect(result.output).toBe('Done: partial work.')
    // No child turn reported usage: the estimate is the only measure there was.
    expect(child.requests.every((request) => request.tools?.length !== 0)).toBe(false)
  })

  test('the report transcript is a conversation a provider would accept', async () => {
    // The defect: the old collection took `outputs.message` from every completed
    // node, so each turn's assistant message appeared twice (`chat` and
    // `assistantMsg`) and the system message landed after the user message.
    const child = workingLlm({ inputTokensPerTurn: PER_TURN, report: 'report' })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm })
    const tool = createSubagentTool({ model, host, inventory, contextWindow: WINDOW })

    const result = await tool.call(args)
    expect(result.status).toBe('partial')

    const request = child.reportRequests[0]?.messages ?? []
    // The request is the merged transcript plus the one hand-off instruction.
    expect(request.at(-1)?.role).toBe('user')
    expect(request.at(-1)?.content).toBe(SUBAGENT_HANDOFF_REQUEST)
    const messages = request.slice(0, -1)
    const roles = messages.map((message) => message.role)

    // The conversation opens the way a chat request must: system, then user.
    expect(roles[0]).toBe('system')
    expect(roles[1]).toBe('user')
    expect(roles.filter((role) => role === 'system')).toHaveLength(1)
    // One assistant message per *merged* turn, never two in a row. The turn
    // that crossed the threshold is one behind: the stop aborts the loop body
    // right after the chat node, so that turn was never merged. It is not
    // invented here - its text reaches the parent as the kept partial - because
    // an assistant `toolCalls` with no tool results is what a provider rejects.
    expect(roles.filter((role) => role === 'assistant')).toHaveLength((result.steps ?? 0) - 1)
    for (let index = 1; index < roles.length; index += 1) {
      expect(`${String(roles[index - 1])}->${String(roles[index])}`).not.toBe('assistant->assistant')
    }
    // Every tool result names its own call, and that call is in the transcript:
    // an orphan tool message is what makes a provider reject a request.
    const callIds = messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id))
    const resultIds = messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId)
    expect(resultIds.every((id) => typeof id === 'string')).toBe(true)
    expect(new Set(resultIds).size).toBe(resultIds.length)
    for (const id of resultIds) expect(callIds).toContain(id)
    // The transcript ends in a completed turn: the last assistant message keeps
    // its call and the tool result that answers it.
    expect(roles.at(-1)).toBe('tool')
    const lastAssistant = messages.filter((message) => message.role === 'assistant').at(-1)
    expect(lastAssistant?.toolCalls).toHaveLength(1)
    expect(messages.at(-1)?.toolCallId).toBe(lastAssistant?.toolCalls?.[0]?.id)
  })

  test('a failed report keeps the partial status and says so', async () => {
    const child = workingLlm({ inputTokensPerTurn: PER_TURN, failReport: true })
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({ model, host, inventory, contextWindow: WINDOW })

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('context_limit')
    expect(result.output).toBe('')
    expect(result.partial).toBeUndefined()
    expect(result.detail).toContain('the report could not be produced')
    expect(result.detail).toContain('75%')
    expect(child.reportRequests).toHaveLength(1)
    // The run is not downgraded to a failure because the summary failed.
    expect(result.text).toContain('status: partial · context_limit · 13 steps')
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
  })

  test('a failed report keeps the child last text instead of an empty answer', async () => {
    // The defect: `output` was set to '' and `partial` only to the report, so a
    // failed report threw away everything the child had said - the one thing the
    // parent can act on.
    const child = workingLlm({
      inputTokensPerTurn: PER_TURN,
      failReport: true,
      text: (turn) => `working on step ${String(turn)}`,
    })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm })
    const tool = createSubagentTool({ model, host, inventory, contextWindow: WINDOW })

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('context_limit')
    expect(result.output).toBe('')
    expect(result.detail).toContain('the report could not be produced')
    // The child's own last text, from its own journal, not a summary of it.
    expect(result.partial).toBe('working on step 13')
    expect(result.text).toContain('last text from the subagent:')
    expect(result.text).toContain('working on step 13')
    expect(result.text).toContain('partial work; it is not the answer')
  })

  test('an empty report likewise falls back to the child last text', async () => {
    const child = workingLlm({
      inputTokensPerTurn: PER_TURN,
      emptyReport: true,
      text: (turn) => `working on step ${String(turn)}`,
    })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm })
    const tool = createSubagentTool({ model, host, inventory, contextWindow: WINDOW })

    const result = await tool.call(args)

    expect(result.output).toBe('')
    expect(result.partial).toBe('working on step 13')
    expect(result.detail).toContain('the report could not be produced')
    expect(result.text).toContain('working on step 13')
  })

  test('an empty report is treated as no report, not as an empty answer', async () => {
    const child = workingLlm({ inputTokensPerTurn: PER_TURN, emptyReport: true })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm })
    const tool = createSubagentTool({ model, host, inventory, contextWindow: WINDOW })

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('context_limit')
    expect(result.output).toBe('')
    expect(result.detail).toContain('the report could not be produced')
    expect(child.reportRequests).toHaveLength(1)
  })
})

/**
 * The choice not to wire `contextWindow` into the graph's budget node.
 *
 * The node's compaction trigger is `floor((window - min(reserve, window)) *
 * 0.85)`; with the documented 16 384-token reserve a 10 000-token window clamps
 * the usable window to 1 and asks for compaction on every step. So the child's
 * budget node keeps its 128k default and the hand-off, not compaction, is what
 * bounds a small-window child. These are the numbers that make that safe.
 */
describe('the hand-off is what bounds a child, not the loop compaction', () => {
  test('a 10 000-token child hands off long before the 128k compaction trigger', () => {
    const window = 128_000
    const reserve = 16_384
    const threshold = 0.85
    const triggerAt = Math.max(1, Math.floor(Math.max(1, window - Math.min(reserve, window)) * threshold))

    // 94 873: what `z1.ctx.budget` asks for at its defaults.
    expect(triggerAt).toBe(94_873)
    // 7 500: where a 10 000-token child is stopped and reports.
    expect(Math.floor(10_000 * SUBAGENT_HANDOFF_RATIO)).toBe(7_500)
    expect(7_500).toBeLessThan(triggerAt)
  })

  test('passing a small window to the budget node would compact every step', () => {
    // The arithmetic that decided it: reserve is clamped to the window, so the
    // usable window collapses to 1 and the trigger lands on the first token.
    const window = 10_000
    const reserve = Math.min(16_384, window)
    const usable = Math.max(1, window - reserve)
    expect(Math.max(1, Math.floor(usable * 0.85))).toBe(1)
  })

  test('the graph this package builds leaves the budget node at its defaults', () => {
    const graph = buildAgentGraph({
      model: { provider: 'mock', model: 'mock-1' },
      maxSteps: DEFAULT_SUBAGENT_MAX_STEPS,
    })
    // The loop body is a nested graph, so the budget node is not top-level: it
    // is reachable only through the loop node's config.
    const budgets = findNodes(graph, (node) => node.type === 'z1.ctx.budget')
    expect(budgets.map((node) => node.id)).toEqual(['budget'])
    // No `contextWindow`, no `reserveTokens`: the node's own 128k/16 384
    // defaults apply, which is what keeps its compaction trigger at 94 873
    // instead of collapsing to 1.
    expect(budgets[0]?.config).toEqual({})
  })
})

/** Every node in a graph document, including those nested in subgraph bodies. */
function findNodes(
  document: unknown,
  predicate: (node: { id: string; type: string; config: unknown }) => boolean,
): { id: string; type: string; config: unknown }[] {
  const found: { id: string; type: string; config: unknown }[] = []
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    const record = value as Record<string, unknown>
    const id = record['id']
    const type = record['type']
    if (typeof id === 'string' && typeof type === 'string' && 'config' in record) {
      const node = { id, type, config: record['config'] }
      if (predicate(node)) found.push(node)
    }
    for (const entry of Object.values(record)) walk(entry)
  }
  walk(document)
  return found
}

describe('how close the hand-off is to the compaction trigger', () => {
  /**
   * The boundary of the claim in `beginChild`: the hand-off precedes the loop's
   * 128k compaction trigger for every child window up to about 126 500 tokens.
   * At the 128k default the two nearly coincide, and compaction - a
   * summarise-and-continue, not a stop - may run first. Stated as numbers so a
   * later change to the ratio, the reserve or the threshold fails a test instead
   * of quietly invalidating the comment.
   */
  const triggerAt = 94_873

  test('a 10 000-token window hands off at 7 500, well before compaction', () => {
    expect(Math.floor(10_000 * SUBAGENT_HANDOFF_RATIO)).toBeLessThan(triggerAt)
  })

  test('the crossover is a window of about 126 500 tokens', () => {
    expect(Math.floor(126_497 * SUBAGENT_HANDOFF_RATIO)).toBeLessThan(triggerAt)
    // 96 000 at the 128k default: 1 127 tokens *after* the compaction trigger.
    expect(Math.floor(DEFAULT_SUBAGENT_CONTEXT_WINDOW * SUBAGENT_HANDOFF_RATIO)).toBe(96_000)
    expect(Math.floor(DEFAULT_SUBAGENT_CONTEXT_WINDOW * SUBAGENT_HANDOFF_RATIO)).toBeGreaterThan(
      triggerAt,
    )
  })
})
