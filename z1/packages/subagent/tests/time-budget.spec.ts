import { describe, expect, test } from 'vitest'

import type { RunEvent } from '@z1/runtime'

import {
  createSubagentTool,
  DEFAULT_SUBAGENT_MAX_STEPS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_SUBAGENT_REPORT_GRACE_MS,
  DEFAULT_SUBAGENT_TIME_BUDGET_MS,
  MAX_SUBAGENT_TIME_MINUTES,
  MIN_SUBAGENT_TIME_MINUTES,
  SubagentError,
  subagentHandoffRequest,
  MAX_SUBAGENT_MAX_STEPS,
  resolveChildBudgets,
  type SubagentInventory,
} from '../src/index.ts'
import { gracefulStopReason, owesFailedEvent } from '../src/run.ts'
import { createFakeHost, createTestJournal, schema, staticLlm, workingLlm } from './fakes.ts'

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

/**
 * The soft time budget: a child can be enormous-but-slow, not only large.
 *
 * A token bound says nothing about a run stuck on a build, a network call or a
 * retry loop, so the child also has a wall-clock budget. It ends the run the
 * same way the context hand-off does - stop, then one tool-free report - and
 * only a *hard* timeout remains a kill. These tests use real runs: the timers,
 * the abort and the report turn all interact, and constants cannot prove it.
 */
describe('the soft time budget', () => {
  test('ends the run with one report: partial/time_limit', async () => {
    const child = workingLlm({ delayMs: 5, report: 'Done: read 4 files.' })
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      timeBudgetMs: 100,
    })

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('time_limit')
    // Deliberately no `steps > 0`: how many turns fit in the budget depends on
    // the machine, and the fact under test is that the stop reports - not how
    // fast the first turn was.
    expect(result.steps).toBeLessThan(DEFAULT_SUBAGENT_MAX_STEPS)
    expect(result.detail).toMatch(/^stopped at the 100ms time budget after \d+ model turns?$/)
    expect(result.detail).not.toContain('context window')
    expect(result.detail).not.toContain('step cap')
    expect(result.output).toBe('Done: read 4 files.')
    expect(result.message).toBe(`subagent time_limit: ${result.detail ?? ''}`)

    // Exactly one report, tool-free, and its prompt names the time budget.
    expect(child.reportRequests).toHaveLength(1)
    const report = child.reportRequests[0]
    expect(report?.tools).toEqual([])
    expect(report?.messages.at(-1)?.content).toBe(subagentHandoffRequest('time'))
    expect(report?.messages.at(-1)?.content).toContain('time budget')
    expect(report?.messages.at(-1)?.content).not.toContain('context window is nearly full')

    expect(result.text).toContain('status: partial · time_limit')
    expect(result.text).toContain('Done: read 4 files.')

    // The hand-off journal row: `failed`, because the graph was aborted mid-run,
    // with a terminal event that agrees with the row.
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
    expect((journal.events.get(runId) ?? []).map((event) => event.type).at(-1)).toBe('run.failed')
  })

  test('a hard timeout shorter than the budget stays child_timeout, no report', async () => {
    // The brief's question: when both are true, which wins? The timeout, and the
    // reason is in `resolveChildBudgets`: an absolute bound is not renegotiable,
    // and the report is a model call the child was not granted. Here the hard
    // timer fires while the child is mid-turn, well before its 10s budget.
    const child = workingLlm({ delayMs: 400 })
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      timeBudgetMs: 10_000,
      timeoutMs: 30,
    })

    const result = await tool.call(args)

    expect(result.status).toBe('timeout')
    expect(result.errorCode).toBe('child_timeout')
    expect(result.detail).toContain('timed out after 30ms')
    expect(result.detail).not.toContain('time budget')
    expect(child.reportRequests).toHaveLength(0)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('failed')
  })

  test('an external cancel while the budget expires is cancelled, with no report', async () => {
    // The tie that must not be lost: the soft timer aborts the child, and the
    // host aborts at the moment the child's cancellation reaches the journal -
    // so both are true when the run settles. The parent's cancellation wins,
    // and nothing is written to a run the parent will never read.
    const child = workingLlm({ delayMs: 400 })
    const journal = createTestJournal()
    const parent = new AbortController()
    const append = journal.append.bind(journal)
    journal.append = (event: RunEvent): void => {
      append(event)
      if (event.type === 'run.cancelled') parent.abort()
    }
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      timeBudgetMs: 30,
      signal: parent.signal,
    })

    const result = await tool.call(args)

    expect(parent.signal.aborted).toBe(true)
    expect(result.status).toBe('cancelled')
    expect(result.errorCode).toBe('child_cancelled')
    expect(result.detail).toContain('cancelled by the parent')
    expect(result.output).toBe('')
    expect(child.reportRequests).toHaveLength(0)
    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('cancelled')
  })

  test('a failed report keeps the time_limit status and says the report is missing', async () => {
    const child = workingLlm({ delayMs: 5, failReport: true })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm })
    const tool = createSubagentTool({ model, host, inventory, timeBudgetMs: 100 })

    const result = await tool.call(args)

    expect(result.status).toBe('partial')
    expect(result.errorCode).toBe('time_limit')
    expect(result.output).toBe('')
    expect(result.detail).toMatch(
      /^stopped at the 100ms time budget after \d+ model turns?; the report could not be produced$/,
    )
    expect(child.reportRequests).toHaveLength(1)
  })
})

describe('the two deadlines', () => {
  test('the defaults are the documented 40 minutes and a 2-minute grace', () => {
    expect(DEFAULT_SUBAGENT_TIME_BUDGET_MS).toBe(40 * 60 * 1000)
    expect(DEFAULT_SUBAGENT_REPORT_GRACE_MS).toBe(2 * 60 * 1000)
    // The default details read in minutes, which is the unit a host thinks in.
    expect(
      resolveChildBudgets({ timeBudgetMs: DEFAULT_SUBAGENT_TIME_BUDGET_MS }),
    ).toEqual({
      timeBudgetMs: 2_400_000,
      timeoutMs: 2_400_000 + 120_000,
    })
  })

  test('the model may only lower the host budget', () => {
    const host = 5 * 60_000
    // A shorter leash on this one child: 2 minutes of the 5 allowed.
    expect(resolveChildBudgets({ timeBudgetMs: host, timeMinutes: 2 })).toEqual({
      timeBudgetMs: 120_000,
      // The hard guard follows the child's own budget, so the report still fits.
      timeoutMs: 120_000 + DEFAULT_SUBAGENT_REPORT_GRACE_MS,
    })
    // A longer request is clamped to the host's, never granted.
    expect(resolveChildBudgets({ timeBudgetMs: host, timeMinutes: 90 }).timeBudgetMs).toBe(host)
  })

  test('an explicit timeout is kept even when it is shorter than the budget', () => {
    expect(
      resolveChildBudgets({ timeBudgetMs: 60_000, timeoutMs: 5_000, timeMinutes: 1 }),
    ).toEqual({ timeBudgetMs: 60_000, timeoutMs: 5_000 })
  })

  test('the precedence is cancel, then timeout, then the recorded cause', () => {
    const none = { hostAborted: false, timedOut: false, stopCause: undefined as const }
    const both = { hostAborted: true, timedOut: true, stopCause: 'time' as const }

    // 1. A parent cancellation wins over every budget: there is nobody left to
    //    read a report.
    expect(gracefulStopReason(both)).toBeUndefined()
    // 2. A hard timeout beats the budgets: the run must not spend another model
    //    call past an absolute deadline.
    expect(gracefulStopReason({ ...both, hostAborted: false })).toBeUndefined()
    // 3. Otherwise the cause recorded at abort time is returned as-is.
    expect(gracefulStopReason({ ...none, stopCause: 'time' })).toBe('time')
    expect(gracefulStopReason({ ...none, stopCause: 'context' })).toBe('context')
    // Nothing graceful about a child that simply finished or broke.
    expect(gracefulStopReason(none)).toBeUndefined()
  })

  /**
   * Both budgets can be true at once, and the report must name the one that
   * stopped the run. The cause is therefore recorded when each budget aborts,
   * with `??=`, rather than derived from two flags afterwards - deriving it is
   * what made "time" win every tie, including the hand-off-then-clock order.
   */
  test('the first budget to fire owns the report, in either order', async () => {
    const firstContext = { ...{ hostAborted: false, timedOut: false }, stopCause: 'context' as const }
    const firstTime = { ...{ hostAborted: false, timedOut: false }, stopCause: 'time' as const }
    expect(gracefulStopReason(firstContext)).toBe('context')
    expect(gracefulStopReason(firstTime)).toBe('time')

    // The same rule through a real run: a context hand-off that fires long
    // before a 10-minute budget is a `context_limit`, and its report says so.
    const child = workingLlm({ inputTokensPerTurn: 600 })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      contextWindow: 10_000,
      timeBudgetMs: 600_000,
    })
    const result = await tool.call(args)
    expect(result.errorCode).toBe('context_limit')
    expect(child.reportRequests[0]?.messages.at(-1)?.content).toContain(
      'context window is nearly full',
    )
  })

  test('an explicit timeout short enough to pre-empt the budget disables the report', async () => {
    // The migration trap the constant's name invites: passing
    // `DEFAULT_SUBAGENT_TIMEOUT_MS` explicitly restores a four-minute kill, which
    // is shorter than the 40-minute soft budget, so the child dies with
    // `child_timeout` and never writes the report.
    const budgets = resolveChildBudgets({
      timeBudgetMs: DEFAULT_SUBAGENT_TIME_BUDGET_MS,
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    })
    expect(budgets.timeoutMs).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS)
    expect(budgets.timeoutMs).toBeLessThan(budgets.timeBudgetMs)

    // And the derived default keeps the room: budget plus the grace.
    const derived = resolveChildBudgets({ timeBudgetMs: DEFAULT_SUBAGENT_TIME_BUDGET_MS })
    expect(derived.timeoutMs).toBeGreaterThan(derived.timeBudgetMs)
  })

  test('the step ceiling is the parent loop ceiling, not a working limit', () => {
    expect(DEFAULT_SUBAGENT_MAX_STEPS).toBe(10_000)
    expect(MIN_SUBAGENT_TIME_MINUTES).toBe(1)
    expect(MAX_SUBAGENT_TIME_MINUTES).toBe(120)
  })
})

describe('the model-facing timeMinutes', () => {
  const invalid = [0, -1, 121, 1.5, '5', null, true]

  test('is rejected out of range instead of clamped, before any child starts', async () => {
    for (const value of invalid) {
      const host = createFakeHost({ tools: [schema('read')] })
      const tool = createSubagentTool({ model, host, inventory })
      const error = await tool
        .call({ ...args, timeMinutes: value })
        .then(() => undefined, (thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(SubagentError)
      expect((error as SubagentError).code).toBe('invalid_input')
      expect((error as SubagentError).message).toContain('timeMinutes')
      expect((error as SubagentError).message).toContain('between 1 and 120 minutes')
      expect(host.beginCalls).toEqual([])
    }
  })

  test('is accepted in range and starts the child', async () => {
    const host = createFakeHost({ tools: [schema('read')], llm: staticLlm('ok').llm })
    const tool = createSubagentTool({ model, host, inventory })

    const result = await tool.call({ ...args, timeMinutes: 2 })

    expect(host.beginCalls).toHaveLength(1)
    // `timeMinutes` is a cap, not a delay: a child that finishes on its first
    // turn is `completed` whatever its budget is.
    expect(result.status).toBe('completed')
  })

  test('is advertised to the model with its bounds and is optional', () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = createSubagentTool({ model, host, inventory })
    const parameters = tool.schema.parameters as {
      required?: readonly string[]
      properties?: Record<string, Record<string, unknown>>
    }
    const property = parameters.properties?.['timeMinutes']
    expect(property?.['type']).toBe('integer')
    expect(property?.['minimum']).toBe(MIN_SUBAGENT_TIME_MINUTES)
    expect(property?.['maximum']).toBe(MAX_SUBAGENT_TIME_MINUTES)
    expect(property?.['description']).toContain('partial')
    expect(parameters.required).not.toContain('timeMinutes')
  })
})

describe('the graceful stop owes the journal a matching terminal event', () => {
  /**
   * The row this path writes is `failed`, so the trace has to end with an event
   * that says the same - except where the graph's own ending is true.
   *
   * Pinned as a decision because the `undefined` case cannot be produced through
   * the shipped executor: its cancel path catches a refused `run.cancelled`
   * append and resolves `failed`. The guard is what keeps a graph that *does*
   * reject from leaving a `failed` row with no terminal event, which `/agents`
   * renders as a run that is still going.
   */
  test('a cancelled or missing result needs the event, a completed one does not', () => {
    expect(owesFailedEvent(undefined)).toBe(true)
    expect(
      owesFailedEvent({ runId: 'run_x', status: 'cancelled', outputs: {} }),
    ).toBe(true)
    expect(
      owesFailedEvent({ runId: 'run_x', status: 'completed', outputs: {} }),
    ).toBe(false)
    expect(
      owesFailedEvent({ runId: 'run_x', status: 'failed', outputs: {}, error: 'boom' }),
    ).toBe(false)
  })
})

/**
 * The completion race: a timer must never turn a finished run into a summary of
 * itself.
 *
 * `Journal.append` is `void | Promise<void>`, and a durable journal yields. The
 * soft timer can therefore fire *inside* the awaited append of `run.completed`,
 * when the child has already produced its answer. The defect this pins: the
 * graceful branch ran a report turn, returned `partial`/`time_limit` with the
 * report as `output`, rewrote the row to `failed`, and left `run.completed` as
 * the last event - the child's real answer silently replaced by a description of
 * the work that had just succeeded.
 */
describe('a completed run is never re-labelled by a budget', () => {
  test('a timer firing during the run.completed append keeps the real answer', async () => {
    const journal = createTestJournal()
    const append = journal.append.bind(journal)
    // A host journal that yields on the terminal append, like SQLite flushing.
    journal.append = (event: RunEvent): void | Promise<void> => {
      if (event.type !== 'run.completed') {
        append(event)
        return
      }
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          append(event)
          resolve()
        }, 250)
      })
    }
    const child = workingLlm({ finalAfterTurns: 1, finalText: 'the real answer' })
    const host = createFakeHost({ tools: [schema('read')], llm: child.llm, journal })
    const tool = createSubagentTool({
      model,
      host,
      inventory,
      // Short enough to fire inside the 250 ms append, long enough that the
      // single turn is finished before it does.
      timeBudgetMs: 30,
    })

    const result = await tool.call(args)

    expect(result.status).toBe('completed')
    expect(result.errorCode).toBeUndefined()
    expect(result.output).toBe('the real answer')
    expect(result.text).toContain('status: completed')
    expect(result.text).toContain('the real answer')
    // No report turn at all: there is nothing to hand off.
    expect(child.reportRequests).toHaveLength(0)

    const runId = host.beginCalls[0]?.runId ?? ''
    expect(journal.runs.get(runId)?.status).toBe('completed')
    expect((journal.events.get(runId) ?? []).map((event) => event.type).at(-1)).toBe('run.completed')
  })
})
