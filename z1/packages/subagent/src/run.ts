import { randomUUID } from 'node:crypto'

import { buildAgentGraph } from '@z1/agent'
import { graphDigest } from '@z1/graph'
import type { ApprovalDecision, ChatMessage, Json, ToolCall, ToolSchema } from '@z1/node'
import {
  runGraph,
  type ApprovalService,
  type Journal,
  type RunEvent,
  type RunResult,
} from '@z1/runtime'

import { normalizeToolName, parseSubagentInput, resolveToolGrant } from './grant.ts'
import {
  subagentHandoffRequest,
  subagentSystemPrompt,
  type SubagentStopReason,
} from './prompt.ts'
import {
  backgroundLaunchText,
  contextLimitDetail,
  partialText,
  resultText,
  stepCapDetail,
  stepLimitSteps,
  timeLimitDetail,
} from './result.ts'
import { restrictToolService } from './restrict.ts'
import {
  DEFAULT_SUBAGENT_CONTEXT_WINDOW,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  DEFAULT_SUBAGENT_MAX_STEPS,
  DEFAULT_SUBAGENT_REPORT_GRACE_MS,
  DEFAULT_SUBAGENT_TIME_BUDGET_MS,
  MAX_SUBAGENT_DESCRIPTION_LENGTH,
  MAX_SUBAGENT_MAX_STEPS,
  MAX_SUBAGENT_PROMPT_BYTES,
  MAX_SUBAGENT_TOOL_ENTRIES,
  SUBAGENT_HANDOFF_RATIO,
  SUBAGENT_REPORT_TIMEOUT_MS,
  SUBAGENT_TOOL_NAME,
  SubagentBudget,
  SubagentError,
  type RunEventWithRunId,
  type SubagentBackgroundResult,
  type SubagentCallGuard,
  type SubagentHost,
  type SubagentInventory,
  type SubagentLaunch,
  type SubagentRunHandle,
  type SubagentRunRecorder,
  type SubagentRunStatus,
  type SubagentToolOptions,
  type SubagentToolResult,
  type SubagentToolStatus,
} from './types.ts'

/** A child never gets an interactive approval in v1. */
export const denyApprovalService: ApprovalService = {
  async request(): Promise<ApprovalDecision> {
    return 'rejected'
  },
}

interface NormalizedOptions {
  readonly model: SubagentToolOptions['model']
  readonly host: SubagentHost
  readonly inventory: SubagentInventory
  readonly toolName: string
  readonly depth: number
  readonly maxSteps: number
  /**
   * The host's soft wall-clock budget, in milliseconds. A model-facing
   * `timeMinutes` may lower it for one child; `resolveChildBudgets` decides.
   */
  readonly timeBudgetMs: number
  /**
   * The host's hard outer guard, or `undefined` when the host did not set one.
   * `undefined` is meaningful: `resolveChildBudgets` then derives the guard from the
   * *child's* budget (soft + grace), which a per-call `timeMinutes` can lower.
   */
  readonly timeoutMs: number | undefined
  /**
   * The token count at which the child stops working and reports instead.
   * Derived once from the window and `SUBAGENT_HANDOFF_RATIO`, so every path
   * (timing, reporting, tests) uses the same number.
   */
  readonly handoffTokens: number
  readonly contextWindow: number
  readonly maxDescriptionLength: number
  readonly maxPromptBytes: number
  readonly maxToolEntries: number
  readonly budget: SubagentBudget
  readonly approval: ApprovalService
  readonly moduleApproval: ApprovalService
  readonly signal: AbortSignal | undefined
  readonly guardCall: SubagentCallGuard | undefined
  readonly onEvent: SubagentToolOptions['onEvent']
  readonly onBackground: SubagentToolOptions['onBackground']
  readonly runs: SubagentRunRecorder | undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The prompt-side token count from a chat node's `usage` record, when the
 * provider reported one.
 *
 * `inputTokens` is the SDK's own field (`ChatUsage` in `@z1/node`), so it is
 * checked first: a real provider reports `{ inputTokens, outputTokens }`, and
 * looking only for the OpenAI-compatible spelling is what made the hand-off
 * unreachable outside tests. The remaining keys are tolerated because a host
 * may wire a provider adapter that speaks `prompt_tokens` or a bare total, and
 * `totalTokens` is a usable floor when nothing prompt-side exists.
 */
function promptTokensOf(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage as Record<string, unknown>
  for (const key of [
    'inputTokens',
    'input_tokens',
    'promptTokens',
    'prompt_tokens',
    'totalTokens',
    'total_tokens',
  ]) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  }
  return undefined
}

/**
 * The transcript estimate from the child loop's budget node.
 *
 * `@z1/agent` runs `z1.ctx.budget` every iteration; its `tokens` output is a
 * character-based estimate of the messages about to be sent. It is a *fallback*
 * for a provider that reports no usage at all, and it is deliberately the
 * weaker number: it counts the messages and nothing else, so it cannot see the
 * tool schemas the provider also bills, and it is computed before the iteration
 * it gates. Using it as an authority would fire the hand-off early on a
 * tool-heavy child; ignoring it altogether would let such a child run into a
 * provider error with no report.
 */
function budgetTokensOf(outputs: unknown): number | undefined {
  if (typeof outputs !== 'object' || outputs === null) return undefined
  const tokens = (outputs as Record<string, unknown>)['tokens']
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return undefined
  return Math.round(tokens)
}

/** The larger of the two token readings; either one alone when only it exists. */
function largerTokens(
  reported: number | undefined,
  estimated: number | undefined,
): number | undefined {
  if (reported === undefined) return estimated
  if (estimated === undefined) return reported
  return Math.max(reported, estimated)
}

function integerOption(
  value: number,
  name: string,
  minimum: number,
): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new SubagentError(
      'invalid_input',
      `${name} must be an integer >= ${minimum}, got ${String(value)}`,
    )
  }
  return value
}

const defaultBudgets = new WeakMap<SubagentHost, SubagentBudget>()

/**
 * One budget per host unless the caller supplies one. This is what makes
 * `maxTotal` a session limit when a host, such as the CLI, creates a fresh
 * subagent tool for every turn.
 */
export function subagentBudgetFor(host: SubagentHost): SubagentBudget {
  let budget = defaultBudgets.get(host)
  if (budget === undefined) {
    budget = new SubagentBudget()
    defaultBudgets.set(host, budget)
  }
  return budget
}

function isRunRecorder(value: unknown): value is SubagentRunRecorder {
  if (typeof value !== 'object' || value === null) return false
  const recorder = value as { createRun?: unknown; updateRun?: unknown }
  return (
    typeof recorder.createRun === 'function' &&
    typeof recorder.updateRun === 'function'
  )
}

type JournalRunCapability =
  | { readonly kind: 'complete'; readonly recorder: SubagentRunRecorder }
  | { readonly kind: 'partial' }
  | { readonly kind: 'none' }

/**
 * A production `Runtime` exposes one `SqliteJournal` that is both the event
 * journal and the run recorder. Detect the complete capability on `journal`
 * when the host did not pass a separate `runs`; a half-capable journal is a
 * host bug and is rejected before any child starts.
 */
function journalRunCapability(journal: Journal): JournalRunCapability {
  const candidate = journal as Partial<SubagentRunRecorder>
  const create = typeof candidate.createRun === 'function'
  const update = typeof candidate.updateRun === 'function'
  if (create && update) {
    return { kind: 'complete', recorder: journal as unknown as SubagentRunRecorder }
  }
  if (create || update) return { kind: 'partial' }
  return { kind: 'none' }
}

function normalizeOptions(options: SubagentToolOptions): NormalizedOptions {
  const depth = integerOption(options.depth ?? 0, 'depth', 0)
  if (depth >= DEFAULT_SUBAGENT_MAX_DEPTH) {
    throw new SubagentError(
      'depth_exceeded',
      `subagent cannot run at depth ${String(depth)}: v1 supports only the main agent (maxDepth ${String(DEFAULT_SUBAGENT_MAX_DEPTH)})`,
    )
  }
  const explicitRuns = options.host.runs
  let runs: SubagentRunRecorder | undefined
  if (explicitRuns !== undefined) {
    if (!isRunRecorder(explicitRuns)) {
      throw new SubagentError(
        'invalid_input',
        'subagent host.runs must provide both createRun and updateRun',
      )
    }
    // An explicit complete recorder wins; the event journal's shape is
    // irrelevant, so a partial journal wrapper does not block a valid host.
    runs = explicitRuns
  } else {
    const journalRuns = journalRunCapability(options.host.journal)
    if (journalRuns.kind === 'partial') {
      throw new SubagentError(
        'invalid_input',
        'subagent host.journal must provide both createRun and updateRun, or neither; use host.runs for a separate recorder',
      )
    }
    if (journalRuns.kind === 'complete') runs = journalRuns.recorder
  }
  const maxSteps = integerOption(
    options.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS,
    'maxSteps',
    1,
  )
  // The loop's schema cannot express more than this, so a larger cap would build
  // a graph and fail inside `buildAgentGraph` - after `beginRun`, with no run row
  // and an invalid-graph message that never names `maxSteps`. Reject it here.
  if (maxSteps > MAX_SUBAGENT_MAX_STEPS) {
    throw new SubagentError(
      'invalid_input',
      `maxSteps must be <= ${String(MAX_SUBAGENT_MAX_STEPS)} (the agent loop's iteration ceiling), got ${String(maxSteps)}`,
    )
  }
  // The hard guard is deliberately optional at this layer: its default depends
  // on the child's effective soft budget, which a per-call `timeMinutes` can
  // lower. `resolveChildBudgets` fills it in.
  const timeoutMs =
    options.timeoutMs === undefined ? undefined : integerOption(options.timeoutMs, 'timeoutMs', 1)
  const timeBudgetMs = integerOption(
    options.timeBudgetMs ?? DEFAULT_SUBAGENT_TIME_BUDGET_MS,
    'timeBudgetMs',
    1,
  )
  const maxDescriptionLength = Math.min(
    integerOption(
      options.maxDescriptionLength ?? MAX_SUBAGENT_DESCRIPTION_LENGTH,
      'maxDescriptionLength',
      1,
    ),
    MAX_SUBAGENT_DESCRIPTION_LENGTH,
  )
  const maxPromptBytes = Math.min(
    integerOption(
      options.maxPromptBytes ?? MAX_SUBAGENT_PROMPT_BYTES,
      'maxPromptBytes',
      1,
    ),
    MAX_SUBAGENT_PROMPT_BYTES,
  )
  const maxToolEntries = Math.min(
    integerOption(
      options.maxToolEntries ?? MAX_SUBAGENT_TOOL_ENTRIES,
      'maxToolEntries',
      1,
    ),
    MAX_SUBAGENT_TOOL_ENTRIES,
  )
  const toolName = normalizeToolName(
    options.name ?? SUBAGENT_TOOL_NAME,
    'subagent tool name',
  )
  const approval = options.approval ?? denyApprovalService
  // The child's window: whatever the host knows, or the documented default. The
  // hand-off point is a fraction of it, computed once so every reader agrees.
  const contextWindow = integerOption(
    options.contextWindow ?? DEFAULT_SUBAGENT_CONTEXT_WINDOW,
    'contextWindow',
    1,
  )
  const handoffTokens = Math.max(1, Math.floor(contextWindow * SUBAGENT_HANDOFF_RATIO))

  return {
    model: options.model,
    host: options.host,
    inventory: options.inventory,
    toolName,
    depth,
    maxSteps,
    timeBudgetMs,
    timeoutMs,
    handoffTokens,
    contextWindow,
    maxDescriptionLength,
    maxPromptBytes,
    maxToolEntries,
    budget: options.budget ?? subagentBudgetFor(options.host),
    approval,
    moduleApproval: options.moduleApproval ?? denyApprovalService,
    signal: options.signal,
    guardCall: options.guardCall,
    onEvent: options.onEvent,
    onBackground: options.onBackground,
    runs,
  }
}

export interface ChildBudgetInput {
  /** The host's soft budget, in milliseconds. */
  readonly timeBudgetMs: number
  /** The host's explicit hard guard; omitted means "derive it from the budget". */
  readonly timeoutMs?: number
  /** The model's request for this child; it may only lower the host budget. */
  readonly timeMinutes?: number
}

/**
 * The two deadlines of one child, after the model's optional `timeMinutes`.
 *
 * The soft budget is the interesting one: it ends the run *gracefully* (abort,
 * then a tool-free report). The hard guard exists only to bound a child whose
 * graceful stop is stuck, so its default is the soft budget plus
 * {@link DEFAULT_SUBAGENT_REPORT_GRACE_MS} - strictly later, or it would fire
 * while the report is being written and turn a `partial` into a `child_timeout`.
 *
 * An explicit `timeoutMs` wins over that derivation even when it is *shorter*
 * than the soft budget, and then the hard guard is the honest deadline: the
 * child is killed at `timeoutMs` and the result is `child_timeout` with no
 * report. The two timers race in `runChildGraph`; a tie is resolved in favour
 * of the timeout in `settleChild`, because a child that overran its absolute
 * bound must not get another model call.
 */
export function resolveChildBudgets(
  input: ChildBudgetInput,
): { readonly timeBudgetMs: number; readonly timeoutMs: number } {
  // The model may only lower the host's budget: a parent that asks for 90
  // minutes cannot buy more than the host allows, and one that asks for 2 gets
  // a shorter leash on this child alone.
  const requested = input.timeMinutes === undefined ? undefined : input.timeMinutes * 60_000
  const timeBudgetMs =
    requested === undefined ? input.timeBudgetMs : Math.min(requested, input.timeBudgetMs)
  const timeoutMs =
    input.timeoutMs ?? Math.max(1, timeBudgetMs + DEFAULT_SUBAGENT_REPORT_GRACE_MS)
  return { timeBudgetMs, timeoutMs }
}

function toolSchemas(
  listed: readonly ToolSchema[],
): Map<string, ToolSchema> {
  const byName = new Map<string, ToolSchema>()
  for (const schema of listed) {
    // A duplicate is a host inventory bug; first wins so the grant order stays
    // deterministic, while the grant itself was already validated.
    if (!byName.has(schema.name)) byName.set(schema.name, schema)
  }
  return byName
}

/** The terminal event that matches a final row status. */
function terminalEventFor(
  status: 'cancelled' | 'failed',
  runId: string,
  error: string,
): RunEvent {
  return status === 'cancelled'
    ? { type: 'run.cancelled', runId, at: Date.now() }
    : { type: 'run.failed', runId, at: Date.now(), error }
}

/**
 * A child's row and its events must agree.
 *
 * `runGraph` writes its own terminal event on most paths, but the events can
 * still disagree with this package's row:
 *
 * - a throw can leave the *wrong* terminal event: when the executor's
 *   `run.cancelled` append is rejected it falls back to `failEarly`, which
 *   writes `run.failed` and resolves;
 * - a timeout is the internal controller's abort, so the executor writes
 *   `run.cancelled` while the row — correctly — says `failed`;
 * - a throw can leave *no* terminal event at all.
 *
 * So the caller passes the terminal event its row names, and this function
 * appends it unless the journal already ends with that same event. An
 * earlier, different terminal event stays: the journal is append-only, and
 * the last terminal event is what a reader renders next to the row.
 */
async function ensureTerminalEvent(
  journal: Journal,
  runId: string,
  event: RunEvent,
): Promise<void> {
  try {
    const last = journal.read(runId).at(-1)
    if (last?.type === event.type && last.runId === runId) return
  } catch {
    // Unreadable: try one append; a journal that also rejects it is caught
    // below, and the row update is still the caller's hard requirement.
  }
  try {
    await journal.append(event)
  } catch (e) {
    // Best-effort: a failing journal must not turn the child's outcome into a
    // different error.
  }
}

/**
 * Record a final status. The first write is retried once as `failed`: that
 * covers a transient error on the actual failure status and turns a failed
 * completed/cancelled/suspended row into a failed row. The tool call still
 * fails closed if the requested status was not recorded. If the recorder
 * rejects both writes it cannot be repaired here; the row may remain `running`
 * but the call never reports success.
 */
async function recordFinalStatus(
  runs: SubagentRunRecorder,
  runId: string,
  status: SubagentRunStatus,
): Promise<void> {
  let firstError: unknown
  try {
    await runs.updateRun(runId, { status, updatedAt: Date.now() })
    return
  } catch (error) {
    firstError = error
  }

  const retryStatus: SubagentRunStatus = 'failed'
  try {
    await runs.updateRun(runId, { status: retryStatus, updatedAt: Date.now() })
  } catch (retryError) {
    throw new SubagentError(
      'child_failed',
      `subagent run ${runId} could not record ${status} status (${errorMessage(firstError)}) or failed status (${errorMessage(retryError)})`,
      { cause: firstError },
    )
  }

  // A failed row is accurate for a failed child; the normal status handling
  // below reports the child's own failure. For any other status the requested
  // outcome was not recorded, so the call fails closed instead of claiming it.
  if (status === 'failed') return
  throw new SubagentError(
    'child_failed',
    `subagent run ${runId} could not record ${status} status: ${errorMessage(firstError)}`,
    { cause: firstError },
  )
}

/**
 * Why a child ended early. `cancelled` is only ever the host's own signal;
 * the internal `timeoutMs` timer and a run-scoped abort are never reported as
 * a parent cancellation, because "the parent went away" and "the child failed"
 * call for different messages and different journal rows.
 */
function cancelSource(hostAborted: boolean, timedOut: boolean): 'external' | 'internal' | undefined {
  if (hostAborted) return 'external'
  if (timedOut) return 'internal'
  return undefined
}

/** The facts that decide how a finished child is reported. */
export interface ChildStopFacts {
  /** The *host's* signal (or a background child's `cancel()`), never the controller. */
  readonly hostAborted: boolean
  /** The hard `timeoutMs` guard fired. */
  readonly timedOut: boolean
  /**
   * The budget that stopped the child *first*, recorded when it aborted the
   * run. When a slow stop crosses both budgets, the one that fired first is the
   * one that ended the work, so it is the one the report names.
   */
  readonly stopCause: SubagentStopReason | undefined
}

/**
 * Whether a finished child is a *graceful* stop, and why - or `undefined` when
 * it is not one (it completed, broke, was cancelled, or timed out).
 *
 * The precedence, in one place, because getting it wrong is what silently
 * dropped the report:
 *
 * 1. a real host abort is a cancellation, even when a budget had also expired:
 *    the parent will never read the output, so a report turn would spend a
 *    model call on nobody's behalf;
 * 2. a hard timeout beats both budgets: an absolute bound is not renegotiable,
 *    and the report is a model call the child was not granted. Making the report
 *    safe here would mean keeping the client alive past a deadline the host
 *    chose to enforce, which is exactly what a deadline is for;
 * 3. otherwise the recorded cause decides. It is not re-derived here, and in
 *    particular a crossed *later* budget can never rename the stop: a run that
 *    hit the window at 09:00 and the clock at 09:01 stopped on the window.
 */
export function gracefulStopReason(
  facts: ChildStopFacts,
): SubagentStopReason | undefined {
  if (facts.hostAborted || facts.timedOut) return undefined
  return facts.stopCause
}


/**
 * The result for a run the host cancelled, and the row that goes with it.
 *
 * Shared by the ordinary cancellation path and the late one - a `cancel()` or a
 * Ctrl-C that lands while the hand-off report is being written - so the two can
 * never disagree about the status, the message or the row.
 *
 * The row is rewritten to the same final status the graph wrote, and stays
 * `cancelled` even when (rarely) the run had no chance to write its own
 * `run.cancelled`. The message names the parent so the CLI can render a
 * cancellation as one. A journal that also rejects the write during a host
 * abort is not worth replacing the cancellation with.
 */
async function cancelResult(input: {
  readonly setup: ChildSetup
  readonly shared: {
    readonly runId: string
    readonly tools: readonly string[]
    readonly denied: readonly string[]
    readonly steps: number
    readonly elapsedMs: number
  }
  readonly kept: string | undefined
  readonly startLost: boolean
  readonly hostAborted: boolean
  readonly message: string
}): Promise<SubagentToolResult> {
  const { setup, shared, kept } = input
  const journal = setup.limits.host.journal
  const runs = setup.limits.runs
  if (!input.startLost) {
    await ensureTerminalEvent(
      journal,
      shared.runId,
      terminalEventFor('cancelled', shared.runId, input.message),
    )
  }
  if (runs !== undefined) {
    try {
      await recordFinalStatus(runs, shared.runId, 'cancelled')
    } catch (error) {
      if (!input.hostAborted) throw error
    }
  }
  return {
    ...shared,
    status: 'cancelled',
    errorCode: 'child_cancelled',
    output: '',
    ...(kept === undefined ? {} : { partial: kept }),
    message: `subagent child_cancelled: ${input.message}`,
    detail: input.message,
    text: resultText({
      runId: shared.runId,
      status: 'cancelled',
      errorCode: 'child_cancelled',
      steps: shared.steps,
      elapsedMs: shared.elapsedMs,
      tools: shared.tools,
      denied: shared.denied,
      ...(kept === undefined ? {} : { partial: kept }),
      detail: input.message,
    }).text,
  }
}


/**
 * Whether the graceful-stop path owes the journal a `run.failed`.
 *
 * The row it writes is `failed`, so the trace must end with a matching event
 * unless the graph already ended in a way that is true in its own right:
 *
 * - `cancelled` - the internal abort of the budget, which the executor journals
 *   as `run.cancelled`; the row says `failed`, so the events need the correction;
 * - `undefined` - the graph threw instead of returning, so no terminal event was
 *   written at all;
 * - `failed` - already the status the row names;
 * - `completed` - never reaches the call: `settleChild` skips the graceful branch
 *   for a completed graph, so the row stays `completed` and its own
 *   `run.completed` stays last. The arm is kept so the predicate stays total.
 */
export function owesFailedEvent(result: RunResult | undefined): boolean {
  return result === undefined || result.status === 'cancelled'
}

/** The single decision point: the terminal row and error for a finished run. */
type ChildOutcome =
  | { readonly kind: 'cancelled'; readonly message: string }
  | {
      readonly kind: 'failed'
      readonly code: 'child_failed' | 'child_timeout'
      readonly message: string
    }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'completed' }

function childOutcome(
  hostAborted: boolean,
  timedOut: boolean,
  timeoutMs: number,
  childRunId: string,
  result: RunResult | undefined,
  thrown: unknown,
): ChildOutcome {
  const source = cancelSource(hostAborted, timedOut)
  if (source === 'external') {
    // A host abort wins over the run's own verdict: even a graph that
    // "completed" raced the cancel, and the parent will never read it.
    return {
      kind: 'cancelled',
      message: thrown === undefined
        ? `run ${childRunId} was cancelled by the parent`
        : `run ${childRunId} was cancelled by the parent: ${errorMessage(thrown)}`,
    }
  }
  if (source === 'internal') {
    return {
      kind: 'failed',
      code: 'child_timeout',
      message: `graph run ${childRunId} timed out after ${String(timeoutMs)}ms`,
    }
  }
  if (result === undefined) {
    return {
      kind: 'failed',
      code: 'child_failed',
      message: `run ${childRunId} failed: ${errorMessage(thrown)}`,
    }
  }
  if (result.status === 'failed') {
    return {
      kind: 'failed',
      code: 'child_failed',
      message: `run ${childRunId} failed: ${result.error ?? 'unknown error'}`,
    }
  }
  if (result.status === 'cancelled') {
    // Not the host's: the child run's own signal was aborted inside
    // `runGraph`. Not a `failed` child, and not a parent cancellation.
    return { kind: 'cancelled', message: `run ${childRunId} was cancelled` }
  }
  if (result.status === 'suspended') return { kind: 'suspended' }
  return { kind: 'completed' }
}

/**
 * One delegation, validated and launched: the run row exists, the child handle
 * is live, and everything `settleChild` needs afterwards is here.
 */
interface ChildSetup {
  readonly limits: NormalizedOptions
  readonly childRunId: string
  readonly child: SubagentRunHandle
  readonly grant: { readonly names: readonly string[]; readonly denied: readonly string[] }
  readonly schemas: readonly ToolSchema[]
  readonly graph: ReturnType<typeof buildAgentGraph>
  /** This child's soft wall-clock budget, after any model-facing `timeMinutes`. */
  readonly timeBudgetMs: number
  /** This child's hard outer guard; see `resolveChildBudgets` for the defaulting rule. */
  readonly timeoutMs: number
}

/**
 * Resolve the grant and start one child.
 *
 * Everything that can invalidate the grant is checked before `beginRun`, so an
 * invalid selection cannot start a child, write a run record, or append an
 * event. Once the child handle exists it is disposed on every failure path
 * here; a returned setup owns the handle and its caller must dispose it.
 *
 * The budget slot is *not* taken here: the caller reserves it first and
 * releases it when the child ends, which for a background child is long after
 * this function returned.
 */
async function beginChild(
  parsed: ReturnType<typeof parseSubagentInput>,
  limits: NormalizedOptions,
  childRunId: string,
): Promise<ChildSetup> {
  const budgets = resolveChildBudgets({
    timeBudgetMs: limits.timeBudgetMs,
    ...(limits.timeoutMs === undefined ? {} : { timeoutMs: limits.timeoutMs }),
    ...(parsed.timeMinutes === undefined ? {} : { timeMinutes: parsed.timeMinutes }),
  })
  const grant = resolveToolGrant(parsed.tools, {
    inventory: limits.inventory,
    toolName: limits.toolName,
    depth: limits.depth,
    maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
    maxEntries: limits.maxToolEntries,
  })

  let child: SubagentRunHandle | undefined
  try {
    child = await limits.host.beginRun({
      runId: childRunId,
      approval: limits.approval,
      moduleApproval: limits.moduleApproval,
    })
  } catch (error) {
    throw new SubagentError(
      'child_failed',
      `cannot start subagent run ${childRunId}: ${errorMessage(error)}`,
      { cause: error },
    )
  }

  try {
    let listed: readonly ToolSchema[]
    try {
      listed = await child.services.tools.list()
    } catch (error) {
      throw new SubagentError(
        'child_failed',
        `cannot list tools for subagent run ${childRunId}: ${errorMessage(error)}`,
        { cause: error },
      )
    }

    const byName = toolSchemas(listed)
    const missing = grant.names.filter((name) => !byName.has(name))
    if (missing.length > 0) {
      throw new SubagentError(
        'child_tool_missing',
        `subagent run ${childRunId} cannot start: granted tool(s) ${missing
          .map((name) => `"${name}"`)
          .join(', ')} disappeared before the child started`,
      )
    }

    const schemas = grant.names.map((name) => {
      const schema = byName.get(name)
      // The missing check above makes this total; the guard satisfies the
      // compiler without weakening it to a non-null assertion.
      if (schema === undefined) {
        throw new SubagentError(
          'child_tool_missing',
          `subagent run ${childRunId} cannot start: tool "${name}" disappeared`,
        )
      }
      return schema
    })

    // `contextWindow` is deliberately *not* forwarded to the graph, even though
    // the loop's budget node knows the option. The node's compaction trigger is
    // `floor((window - min(reserveTokens, window)) * threshold)` with a
    // 16 384-token default reserve, so a 10 000-token child window would clamp
    // the usable window to 1 and put the compaction threshold at token 1: every
    // step would summarise the transcript. The budget node therefore keeps its
    // documented 128k default, and the hand-off bounds the child instead:
    // 75% of a 10 000-token window is 7 500 tokens, far below the 94 873-token
    // point at which the node would ask for compaction. For a child window in
    // (0, ~126 500) tokens the hand-off always fires first; at the 128k default
    // the two nearly coincide, and compaction - a summarise-and-continue, not a
    // stop - may run first, which only shrinks the transcript.
    const graph = buildAgentGraph({
      model: limits.model,
      tools: schemas,
      system: subagentSystemPrompt({ tools: grant.names }),
      maxSteps: limits.maxSteps,
    })

    const runs = limits.runs
    if (runs !== undefined) {
      const now = Date.now()
      await runs.createRun({
        runId: childRunId,
        graphId: graph.id,
        graphDigest: graphDigest(graph),
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
    }

    return {
      limits,
      childRunId,
      child,
      grant,
      schemas,
      graph,
      timeBudgetMs: budgets.timeBudgetMs,
      timeoutMs: budgets.timeoutMs,
    }
  } catch (error) {
    await child.dispose()
    throw error
  }
}

/** One graph pass of a child: what `runGraph` returned and what it counted. */
interface ChildRun {
  readonly result: RunResult | undefined
  readonly thrown: unknown
  readonly steps: number
  readonly timedOut: boolean
  /**
   * Which budget ended the run *first*: the soft time budget (`'time'`) or the
   * context hand-off (`'context'`). Recorded at abort time, not derived
   * afterwards, because a slow stop can cross both and the report has to name
   * the one that actually stopped it.
   */
  readonly stopCause: SubagentStopReason | undefined
  readonly startLost: boolean
  readonly lostStartError: unknown
}

/**
 * Run the child's graph and wait for it.
 *
 * `limits.onEvent` is forwarded into the child `runGraph` (the host sees the
 * child's own events and never the parent's). `onSteps`, when given, is called
 * after every model turn, so `/agents` can count a running background child
 * without reading the journal.
 */
async function runChildGraph(
  setup: ChildSetup,
  prompt: string,
  signals: { readonly foreground: AbortController; readonly host: AbortSignal | undefined },
  onSteps?: (steps: number) => void,
): Promise<ChildRun> {
  const { limits, child, childRunId, grant, schemas } = setup
  const journal = limits.host.journal
  const childTools = restrictToolService(child.services.tools, grant.names, {
    inventory: schemas,
    ...(limits.guardCall === undefined ? {} : { guardCall: limits.guardCall }),
  })

  // The package always observes its own child: a host may want the stream
  // (a CLI counts steps live), but the step count must also reach the result
  // when no callback is installed, so the counting lives here and the host
  // callback sees exactly these events and never the parent's.
  let steps = 0
  let timedOut = false
  /**
   * The first budget that stopped the child, or `undefined` if none did. Set
   * with `??=`: whichever fires first owns the report, so a hand-off that is
   * already unwinding is not renamed by the clock (or the reverse).
   */
  let stopCause: SubagentStopReason | undefined
  let thrown: unknown
  /** The last transcript estimate the loop's budget node published. */
  let budgetTokens: number | undefined
  const forward = limits.onEvent
  const childEvents = (event: RunEvent): void => {
    if (event.type === 'node.started' && /^loop\/\d+\/chat$/.test(event.path)) {
      steps += 1
      if (onSteps !== undefined) {
        try {
          onSteps(steps)
        } catch {
          // Observation only.
        }
      }
    }
    // The loop's budget node is the fallback measure of a child whose provider
    // reports no usage: it estimates the transcript it is about to send. It runs
    // *before* the chat node of the same iteration, so the newest value here
    // lags the turn that just finished by that turn's own messages - and it
    // cannot see tool schemas at all. Hence: a floor, never an authority.
    if (event.type === 'node.completed' && event.path !== undefined && /^loop\/\d+\/budget$/.test(event.path)) {
      const estimate = budgetTokensOf(event.outputs)
      if (estimate !== undefined) budgetTokens = estimate
    }
    // The budget is checked on the *result* of a step, before the next one
    // starts: crossing the threshold must stop the work, not truncate a step
    // that is already in flight.
    if (event.type === 'node.completed' && event.path !== undefined && /^loop\/\d+\/chat$/.test(event.path)) {
      const usage = (event.outputs as Record<string, unknown> | undefined)?.['usage']
      // The stricter of the two readings. The provider's count is authoritative
      // for the request it made; the estimate counts the whole transcript
      // including the system prompt, which a provider may or may not bill. Taking
      // the larger means a provider that reports nothing, or reports only part of
      // the prompt, cannot keep a child working past a window that is in fact
      // nearly full - the failure that costs the report.
      const tokens = largerTokens(promptTokensOf(usage), budgetTokens)
      if (tokens !== undefined && tokens >= limits.handoffTokens) {
        stopCause ??= 'context'
        // Stop the graph here: the work must end at the threshold, not at the
        // next provider failure. The report is written afterwards, from what
        // the run already produced.
        controller.abort()
      }
    }
    if (forward === undefined) return
    try {
      forward(event as RunEventWithRunId)
    } catch {
      // A host observer is diagnostic; it must not fail the child run.
    }
  }
  const controller = signals.foreground
  const signal =
    signals.host === undefined
      ? controller.signal
      : AbortSignal.any([signals.host, controller.signal])
  /**
   * The soft budget: stop the work, keep the report.
   *
   * It aborts the same controller the timeout does, so the graph resolves
   * `cancelled` - which is why `settleChild` reads its own flag rather than the
   * run's status. The two timers race; if the hard one fires in the same tick
   * the timeout wins (see `resolveChildBudgets`), because an absolute bound is not
   * renegotiable.
   */
  const budgetTimer = setTimeout(() => {
    if (timedOut) return
    stopCause ??= 'time'
    controller.abort()
  }, setup.timeBudgetMs)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, setup.timeoutMs)
  let result: RunResult | undefined
  // Ledger awareness: a host journal that refuses `run.started` leaves no
  // row a terminal event could attach to (`SqliteJournal` rejects appends to
  // an unknown run), so recovery there is impossible and pointless.
  let startLost = false
  // A wrapper throw and a `runGraph`-swallowed throw both leave the run with
  // no row; the second is recognised after the run from the failure text,
  // which is the only trace `runGraph` keeps of its own failed append.
  let lostStartError: unknown
  const ledger: Journal = {
    append: (event) => {
      try {
        return journal.append(event)
      } catch (error) {
        if (event.type === 'run.started') {
          startLost = true
          lostStartError = error
        }
        throw error
      }
    },
    read: (runId) => journal.read(runId),
  }
  try {
    result = await runGraph({
      graph: setup.graph,
      registry: child.registry,
      services: {
        ...child.services,
        tools: childTools,
        onEvent: childEvents,
      },
      input: prompt,
      runId: childRunId,
      journal: ledger,
      tools: grant.names,
      signal,
      suspendOnApproval: false,
    })
  } catch (error) {
    thrown = error
  } finally {
    clearTimeout(timer)
    clearTimeout(budgetTimer)
    // `runGraph` turns a throw while starting into a `failed` result whose
    // error *is* the thrown message, so a lost `run.started` shows up here
    // and never reaches the ledger wrapper's catch. The phrase is
    // `SqliteJournal`'s own; a false positive only skips a best-effort
    // terminal append that would be rejected anyway.
    const failure = result?.error ?? (thrown === undefined ? undefined : errorMessage(thrown))
    if (!startLost && failure !== undefined && failure.includes('cannot append to unknown run')) {
      startLost = true
      lostStartError = failure
    }
  }
  return {
    result,
    thrown,
    steps,
    timedOut,
    stopCause,
    startLost,
    lostStartError,
  }
}

/**
 * Ask the child's own model for a status report, when the run stopped at a
 * budget instead of finishing.
 *
 * This is the one turn that is allowed to run *after* the graph has ended, and
 * it is deliberately tool-free: the child cannot continue the work, it can only
 * say where the work stands. That is what makes the report trustworthy - the
 * text comes from the same transcript the child produced, not from a summary of
 * a summary.
 *
 * `reason` selects the opening line of the request only; the five questions are
 * the same, because a reader needs the same facts whether the child ran out of
 * window or out of time.
 *
 * Two things can go wrong and neither is fatal: the provider can fail, and it
 * can hang. `LlmService.chat` takes no signal, so the cap is a race against
 * {@link SUBAGENT_REPORT_TIMEOUT_MS} rather than a cancellation - the run keeps
 * whatever the child already had, because a missing report is still better than
 * a lost run.
 */
async function handoffReport(
  setup: ChildSetup,
  events: readonly RunEvent[],
  reason: SubagentStopReason,
): Promise<string | undefined> {
  const llm = setup.child.services.llm
  if (llm === undefined) return undefined
  const messages = transcriptOf(events)
  if (messages.length === 0) return undefined
  let cap: ReturnType<typeof setTimeout> | undefined
  try {
    const reply = llm.chat({
      model: setup.limits.model,
      messages: [...messages, { role: 'user', content: subagentHandoffRequest(reason) }],
      // No tools: the window is nearly full (or the clock is gone) and the work
      // is stopping. Offering them would only invite another round.
      tools: [],
    })
    const deadline = new Promise<undefined>((resolve) => {
      cap = setTimeout(() => {
        resolve(undefined)
      }, SUBAGENT_REPORT_TIMEOUT_MS)
    })
    // A race, not a cancellation: the pending promise keeps its handlers, so a
    // late rejection cannot surface as an unhandled one.
    const result = await Promise.race([reply, deadline])
    if (result === undefined) return undefined
    const text = result.message.content
    return typeof text === 'string' && text.trim().length > 0 ? text.trim() : undefined
  } catch {
    // A provider that fails here loses only the summary, not the run.
    return undefined
  } finally {
    if (cap !== undefined) clearTimeout(cap)
  }
}

/**
 * The loop's merged transcript, as the next iteration would see it.
 *
 * `@z1/agent` keeps the conversation on `messagesMerge` and feeds it to
 * `outValue` (`d19`), so `messagesMerge`'s `value` *is* the loop state; reading
 * the event rather than rebuilding it is what keeps the order the child saw.
 * `outValue` itself is not used: `z1.core.output` declares no output ports and
 * returns `{}`, so its `node.completed` carries no transcript at all.
 *
 * `ctxMerge` is the same array one step earlier in the turn (post-compaction,
 * pre-answer) and is only a fallback for a graph without the merge.
 */
const LOOP_TRANSCRIPT = /^loop\/\d+\/(?:messagesMerge|ctxMerge)$/

/**
 * The child's transcript as chat messages, in the order the model saw them.
 *
 * The old implementation collected `outputs.message` from *every* completed
 * node, which produced a transcript no provider would accept: the assistant
 * message appeared twice per turn (`chat` and `assistantMsg` are two nodes over
 * one message) and the system message landed after the user message, because
 * the prompt stack completes after the seed. A report written from that is a
 * report written from a broken conversation.
 *
 * So the loop's own merged transcript is used verbatim: it is the array the next
 * iteration would have sent, so it is ordered, deduplicated, post-compaction and
 * provider-valid by construction - every assistant `toolCalls` is followed by
 * its results, because the loop only merges them together. Rebuilding that by
 * hand is how the duplicates and the misplaced system message got in.
 *
 * The newest merge is one turn behind a stop: the hand-off aborts the body right
 * after the chat node, so that turn's messages were never merged (and its tool
 * results do not exist). Its *text* still reaches the parent through the kept
 * partial, and inventing the missing half here would put an assistant
 * `toolCalls` with no tool results in front of a provider.
 *
 * The collected fallback is only for a run that never completed an iteration:
 * system messages first, one assistant message per turn.
 */
function transcriptOf(events: readonly RunEvent[]): readonly ChatMessage[] {
  return lastLoopTranscript(events) ?? collectedTranscript(events)
}

/** The newest loop transcript snapshot, validated as `ChatMessage[]`. */
function lastLoopTranscript(events: readonly RunEvent[]): readonly ChatMessage[] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'node.completed') continue
    if (event.path === undefined || !LOOP_TRANSCRIPT.test(event.path)) continue
    const value = (event.outputs as Record<string, unknown> | undefined)?.['value']
    if (!Array.isArray(value)) continue
    const messages = toChatMessages(value)
    if (messages.length > 0) return messages
  }
  return undefined
}

/**
 * The transcript of a run that never completed a loop iteration: the events
 * themselves, ordered so the result is still a legal conversation.
 */
function collectedTranscript(events: readonly RunEvent[]): readonly ChatMessage[] {
  const system: ChatMessage[] = []
  const rest: ChatMessage[] = []
  let previous: ChatMessage | undefined
  for (const event of events) {
    if (event.type !== 'node.completed') continue
    // `assistantMsg` repeats the assistant message the `chat` node already
    // reported; keeping both is what doubled every turn.
    if (event.path !== undefined && event.path.endsWith('/assistantMsg')) continue
    const message = chatMessageOf(event.outputs)
    if (message === undefined) continue
    if (message.role === 'system') {
      // The prompt stack completes after the seed, so a system message found in
      // event order is not at the position the provider expects.
      if (!system.some((entry) => entry.content === message.content)) system.push(message)
      continue
    }
    if (message.role === 'assistant' && previous?.role === 'assistant' && sameMessage(previous, message)) {
      continue
    }
    previous = message
    rest.push(message)
  }
  return [...system, ...rest]
}

/** Structural equality for two chat messages, on the fields a model reads. */
function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  return (
    left.content === right.content &&
    JSON.stringify(left.toolCalls ?? []) === JSON.stringify(right.toolCalls ?? []) &&
    left.toolCallId === right.toolCallId
  )
}

/** One `ChatMessage` from a node's `outputs.message`, or `undefined`. */
function chatMessageOf(outputs: unknown): ChatMessage | undefined {
  if (typeof outputs !== 'object' || outputs === null) return undefined
  const message = (outputs as Record<string, unknown>)['message']
  if (typeof message !== 'object' || message === null) return undefined
  const validated = toChatMessages([message])
  return validated[0]
}

/**
 * Validate a transcript read from an event as `ChatMessage[]`.
 *
 * A malformed entry is dropped rather than forwarded: the report turn is the
 * one place a bad message would reach a provider with no node in between to
 * report it. `toolCalls` and `toolCallId` are kept, because a `tool` message
 * without its call is exactly what makes a provider reject a transcript.
 */
function toChatMessages(value: readonly unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const role = record['role']
    const content = record['content']
    if (typeof content !== 'string') continue
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    const message: ChatMessage = { role, content }
    if (typeof record['toolCallId'] === 'string') message.toolCallId = record['toolCallId']
    const toolCalls = toToolCalls(record['toolCalls'])
    if (toolCalls.length > 0) message.toolCalls = toolCalls
    messages.push(message)
  }
  return messages
}

/** The `toolCalls` array of an assistant message, keeping its call ids. */
function toToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: ToolCall[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = record['id']
    const name = record['name']
    if (typeof id !== 'string' || typeof name !== 'string') continue
    calls.push({ id, name, arguments: (record['arguments'] ?? null) as Json })
  }
  return calls
}

/**
 * Turn one finished child graph into the result the host reads, and write the
 * terminal row.
 *
 * `hostAborted` is a *getter* over the host's signal - `runForeground` passes
 * `hostSignal?.aborted` and a background child passes its `cancel()` flag -
 * never the child's own controller. That matters because the child's controller
 * is also what the soft time budget and the context hand-off abort: those are
 * graceful stops that still report, and reading the controller here would
 * report every one of them as a parent cancellation.
 *
 * It is a getter, not a snapshot, because the report turn takes time: a Ctrl-C
 * (foreground) or a `cancel()` (background) can arrive while the report is in
 * flight, and the run must then be reported as the cancellation it is. So the
 * value is read again after the report, and the cancel wins.
 *
 * So the precedence is:
 *
 * 1. a real host abort - `cancelled`/`child_cancelled`, no report, even when a
 *    budget had already expired;
 * 2. a hard timeout - `child_timeout`, no report (see `resolveChildBudgets`: an
 *    absolute bound is not renegotiable, and the report turn is a model call
 *    the child was not granted);
 * 3. an expired soft budget or a crossed context threshold, *for a run that did
 *    not complete* - `partial` with the tool-free hand-off report; a completed
 *    graph is never re-labelled, because it already has the answer the report
 *    would only describe;
 * 4. a step cap - `partial`/`child_failed` with the step-cap detail, no report;
 * 5. everything else, as the graph resolved it.
 *
 * Steps 1-3 are decided here, before the cancelled/failed return, because the
 * graph resolves `cancelled` for the internal abort of steps 2 and 3; doing it
 * after that return is what made a hand-off unreachable.
 */
async function settleChild(
  setup: ChildSetup,
  run: ChildRun,
  elapsedMs: number,
  hostAborted: () => boolean,
): Promise<SubagentToolResult> {
  const { limits, childRunId, grant } = setup
  const journal = limits.host.journal
  const runs = limits.runs
  const { result, thrown, steps, timedOut, startLost, lostStartError } = run
  const aborted = hostAborted()

  const outcome = childOutcome(aborted, timedOut, setup.timeoutMs, childRunId, result, thrown)

  // A run whose journal row was never durable has nothing to report *about*:
  // `SqliteJournal` refused `run.started`, so the row this package created is
  // not there and the run could not be inspected later. That is a host
  // failure, not a child outcome, so it still throws (`child_failed`) with
  // no terminal append invented.
  if (startLost && (outcome.kind === 'cancelled' || outcome.kind === 'failed')) {
    throw new SubagentError(
      'child_failed',
      `subagent run ${childRunId} could not record its start: ${errorMessage(
        thrown ?? lostStartError,
      )}`,
      thrown === undefined ? undefined : { cause: thrown },
    )
  }

  // Everything below is read before the terminal writes, because the text
  // kept for the parent must be what the child had said by the time it ended.
  const childEventsSeen = (): readonly RunEvent[] => {
    try {
      return journal.read(childRunId)
    } catch {
      return []
    }
  }
  const stepped = Math.max(steps, 0)
  const shared = {
    runId: childRunId,
    tools: [...grant.names],
    denied: [...grant.denied],
    steps: stepped,
    elapsedMs,
  }

  // A completed graph is completed: it has an answer, so there is nothing to hand
  // off. This is not tidiness. `Journal.append` may be a promise a host journal
  // yields on, so the soft timer can fire *inside* the awaited append of
  // `run.completed` - the run has already produced its output at that point. With
  // the cause recorded ("time") and no completion check, the report turn would
  // replace that output with a summary of it, rewrite the row to `failed`, and
  // leave `run.completed` as the last event: a finished child silently losing
  // its answer.
  //
  // A host abort and a hard timeout are decided by `childOutcome` above and still
  // win over a completed graph, which is why this only suppresses the *graceful*
  // stop (and with it the report call) rather than short-circuiting the whole
  // function. The completed result itself is built at the bottom, by the one
  // place that records `completed`.
  const completedRun = result?.status === 'completed'
  const stopReason = completedRun
    ? undefined
    : gracefulStopReason({ hostAborted: aborted, timedOut, stopCause: run.stopCause })
  if (stopReason !== undefined) {
    // Read *before* the report: it is what the child had said by the time the
    // budget stopped it, and the report turn may fail or be cancelled.
    const kept = partialText(childEventsSeen())
    const report = await handoffReport(setup, childEventsSeen(), stopReason)

    // The report turn is a model call, so it is a window in which the host can
    // still change its mind. A cancel that arrives here is the real outcome of
    // the run - the parent is gone and will never read the report - so it wins
    // over the `partial` this branch was about to return, and the row is
    // `cancelled` rather than `failed`.
    if (hostAborted()) {
      return await cancelResult({
        setup,
        shared,
        kept,
        startLost,
        hostAborted: true,
        message: `run ${childRunId} was cancelled by the parent while its report was being written`,
      })
    }

    const detail =
      stopReason === 'time'
        ? timeLimitDetail(setup.timeBudgetMs, stepped, report !== undefined)
        : contextLimitDetail(stepped, SUBAGENT_HANDOFF_RATIO, report !== undefined)
    const errorCode = stopReason === 'time' ? 'time_limit' : 'context_limit'
    // The run's *row* stays `failed`: the graph failed the run it was given (it
    // was aborted mid-turn and produced no completed answer), and a background
    // child's `/agents` entry must not claim otherwise. What the parent needs -
    // "stopped, here is what is left" - travels in the result instead.
    if (runs !== undefined) {
      try {
        await recordFinalStatus(runs, childRunId, 'failed')
      } catch {
        // The report is the useful artefact; a broken journal cannot be repaired.
      }
    }
    // An aborted graph writes `run.cancelled` while the row above says `failed`,
    // and a graph that threw leaves no terminal event at all; either way the
    // package owes the journal the event its row names, the same way the timeout
    // branch does.
    if (!startLost && owesFailedEvent(result)) {
      await ensureTerminalEvent(
        journal,
        childRunId,
        terminalEventFor('failed', childRunId, detail),
      )
    }
    return {
      ...shared,
      status: 'partial',
      errorCode,
      // A report is the answer; the child's own last text is the fallback, so a
      // failed or empty report never throws away what the child had said.
      output: report ?? '',
      ...(report === undefined && kept !== undefined ? { partial: kept } : {}),
      message: `subagent ${errorCode}: ${detail}`,
      detail,
      text: resultText({
        runId: childRunId,
        status: 'partial',
        errorCode,
        steps: stepped,
        elapsedMs,
        tools: shared.tools,
        denied: shared.denied,
        output: report ?? '',
        ...(report === undefined && kept !== undefined ? { partial: kept } : {}),
        detail,
      }).text,
    }
  }

  if (outcome.kind === 'cancelled' || outcome.kind === 'failed') {
    // The row and its events must agree, whatever shape the run ended in:
    //
    // - a host abort can resolve `failed` with `run.failed` (the executor's
    //   fallback when its own `run.cancelled` append was rejected) while the
    //   row is `cancelled`;
    // - a timeout resolves `cancelled` with `run.cancelled` (the internal
    //   controller) while the row is `failed`;
    // - a throw can leave no terminal event at all.
    //
    // So the caller passes the terminal event the row names and appends it
    // when the journal does not already end with it. A normal resolved run
    // ends with its own matching event and is skipped, as is any duplicate.
    // A ledger that lost `run.started` has nothing to append to.
    const status = outcome.kind === 'cancelled' ? 'cancelled' : 'failed'
    if (!startLost) {
      await ensureTerminalEvent(
        journal,
        childRunId,
        terminalEventFor(
          status,
          childRunId,
          thrown === undefined ? outcome.message : errorMessage(thrown),
        ),
      )
    }

    // A child that used up its step cap did work: the journal row stays
    // `failed` (the graph failed the run), but the parent is told `partial`
    // and gets the child's last text instead of a bare error.
    const exhausted =
      outcome.kind === 'failed'
        ? stepLimitSteps(result?.error ?? (thrown === undefined ? undefined : errorMessage(thrown)))
        : undefined
    const kept = partialText(childEventsSeen())

    if (status === 'cancelled') {
      return await cancelResult({
        setup,
        shared,
        kept,
        startLost,
        hostAborted: aborted,
        message: outcome.message,
      })
    }

    if (runs !== undefined) {
      try {
        await recordFinalStatus(runs, childRunId, 'failed')
      } catch {
        // The original run failure is the useful error; a broken journal
        // cannot be repaired here.
      }
    }
    // Narrowed to the failed branch: `outcome.code` is `child_failed` or
    // `child_timeout` (an internal timeout), which the CLI renders apart.
    const code = outcome.kind === 'failed' ? outcome.code : 'child_failed'
    const toolStatusValue: SubagentToolStatus =
      exhausted !== undefined ? 'partial' : code === 'child_timeout' ? 'timeout' : 'failed'
    // One sentence for both readers. On a step cap the graph's own wording
    // (`step limit reached after 1 steps`) would disagree with the model-facing
    // text (`after 1 of 1 model turn`) - and `/agents` prints this `detail` -
    // so the derived sentence is used here as well as in `resultText`.
    const detail =
      toolStatusValue === 'partial'
        ? stepCapDetail(stepped, limits.maxSteps, kept !== undefined)
        : outcome.message
    const text = resultText({
      runId: childRunId,
      status: toolStatusValue,
      errorCode: code,
      steps: stepped,
      // The cap is what stopped the child; `partial` names it so the detail
      // reads `after 1 of 1 model turn` rather than contradicting `1 step`.
      ...(exhausted === undefined ? {} : { maxSteps: limits.maxSteps }),
      elapsedMs,
      tools: shared.tools,
      denied: shared.denied,
      ...(kept === undefined ? {} : { partial: kept }),
      detail,
    }).text
    return {
      ...shared,
      status: toolStatusValue,
      errorCode: code,
      output: '',
      ...(kept === undefined ? {} : { partial: kept }),
      message: `subagent ${code}: ${detail}`,
      detail,
      text,
    }
  }

  // `completed` and `suspended` keep the run's own status. A completed run
  // always has a result; a throw earlier leaves `result` undefined.
  if (runs !== undefined && result !== undefined) {
    await recordFinalStatus(runs, childRunId, result.status)
  }

  if (outcome.kind === 'suspended') {
    const detail = `subagent run ${childRunId} suspended on approval at ${
      result?.pendingApproval?.path ?? 'unknown path'
    }`
    return {
      ...shared,
      status: 'failed',
      errorCode: 'child_suspended',
      output: '',
      message: `subagent child_suspended: ${detail}`,
      detail,
      text: resultText({
        runId: childRunId,
        status: 'failed',
        errorCode: 'child_suspended',
        steps: stepped,
        elapsedMs,
        tools: shared.tools,
        denied: shared.denied,
        detail,
      }).text,
    }
  }

  // `completed` past this point: `result` is defined by the outcome.
  const output = result?.outputs['output']
  if (typeof output !== 'string') {
    const detail = `subagent run ${childRunId} completed without a text output`
    return {
      ...shared,
      status: 'failed',
      errorCode: 'no_output',
      output: '',
      message: `subagent no_output: ${detail}`,
      detail,
      text: resultText({
        runId: childRunId,
        status: 'failed',
        errorCode: 'no_output',
        steps: stepped,
        elapsedMs,
        tools: shared.tools,
        denied: shared.denied,
        detail,
      }).text,
    }
  }

  return {
    ...shared,
    status: 'completed',
    output,
    text: resultText({
      runId: childRunId,
      status: 'completed',
      steps: stepped,
      elapsedMs,
      tools: shared.tools,
      denied: shared.denied,
      output,
    }).text,
  }
}

/**
 * Shared front half of both delegation modes: reject an aborted host, validate
 * the input, price the child into the shared budget, and start it.
 *
 * Returns the setup and the reservation the caller must release when the child
 * ends. A throw releases the reservation and disposes a started child, so a
 * refused delegation leaves no slot taken and no handle open.
 */
async function launch(
  input: unknown,
  options: SubagentToolOptions,
): Promise<{
  readonly limits: NormalizedOptions
  readonly childRunId: string
  readonly setup: ChildSetup
  readonly release: () => void
}> {
  const limits = normalizeOptions(options)

  if (limits.signal?.aborted === true) {
    // The host already cancelled this delegation (a parent Ctrl-C between the
    // model's tool call and this one). Starting a child now would be a child
    // nobody waits for, so fail before the budget and before any run row.
    throw new SubagentError(
      'child_cancelled',
      'subagent run was cancelled by the parent before it started',
      { cause: limits.signal.reason },
    )
  }

  const parsed = parseSubagentInput(input, {
    maxDescriptionLength: limits.maxDescriptionLength,
    maxPromptBytes: limits.maxPromptBytes,
    maxToolEntries: limits.maxToolEntries,
  })

  // Reserved before `beginRun` so two calls racing for the last slot cannot
  // both start; held until the child ends, never until the call returns.
  const reservation = limits.budget.reserve()
  const childRunId = `run_${randomUUID()}`
  try {
    const setup = await beginChild(parsed, limits, childRunId)
    // `beginRun` succeeded: the child counts towards `maxTotal` even though it
    // is not finished yet. The active slot stays held until `finish()`.
    reservation.commit()
    return { limits, childRunId, setup, release: () => reservation.release() }
  } catch (error) {
    reservation.release()
    throw error
  }
}

/** Dispose the handle and release the slot once the child has fully ended. */
async function finish(launched: {
  readonly setup: ChildSetup
  readonly release: () => void
}): Promise<void> {
  try {
    await launched.setup.child.dispose()
  } finally {
    launched.release()
  }
}

/**
 * Run one child agent synchronously (`wait: true`, the v1 behaviour).
 *
 * `ToolService.call()` has no run/node/signal context, so the host passes its
 * cancellation through `options.signal` explicitly. The child runs on
 * `AbortSignal.any([options.signal, controller])`, where `controller` is aborted
 * by the hard timeout, the soft time budget and the context hand-off;
 * `settleChild` decides the one terminal status and callers see it in the
 * journal row and, in the returned `SubagentToolResult`, as `status` plus
 * `errorCode`:
 *
 * - host signal aborted   → `cancelled` (`child_cancelled`), row `cancelled`,
 *   no report
 * - `timeoutMs` expired   → `timeout` (`child_timeout`), row `failed`, no report
 * - soft time budget      → `partial` (`time_limit`), row `failed`, with report,
 *   unless the graph had already completed
 * - context hand-off      → `partial` (`context_limit`), row `failed`, with
 *   report, same exception
 * - step cap exhausted    → `partial` (`child_failed`), row `failed`
 * - anything else         → `failed` (`child_failed` / `no_output` /
 *   `child_suspended`) or `completed`
 *
 * A run that ends badly is a *result*, not a throw: the tool surface can only
 * carry a message plus `isError`, so the code travels in the result object and
 * the message carries a stable `subagent <code>:` prefix. Only failures that
 * happen before the child exists (an invalid grant, an exhausted budget, a
 * `beginRun` error) still throw; they never had a run to report.
 *
 * Setup (`beginRun`, child tool re-listing, journal create/update) and teardown
 * (`dispose`) are not covered by the timer; they remain host responsibilities,
 * and an already-cancelled host signal is honoured before `beginRun` so an
 * aborted turn never starts a child.
 *
 * Default `runSubagent` delegates here; `wait: true` is exactly this function,
 * unchanged from v1.
 */
async function runForeground(
  input: unknown,
  options: SubagentToolOptions,
): Promise<SubagentToolResult> {
  const launched = await launch(input, options)
  try {
    const { limits, setup } = launched
    const controller = new AbortController()
    // The host signal is read once into a local so the post-run snapshot below
    // observes the same object (the options bag is readonly, the signal is not).
    const hostSignal = limits.signal
    const startedAt = Date.now()
    // Foreground keeps v1's wiring: the turn's signal and the timeout both end
    // the child, and an aborted turn is reported as a parent cancellation.
    const run = await runChildGraph(setup, promptOf(input), {
      foreground: controller,
      host: hostSignal,
    })
    const elapsedMs = Date.now() - startedAt
    // A *getter*, not a snapshot: the host signal is the one fact that separates
    // a parent cancellation from a child failure, and it can still become true
    // while the hand-off report is being written. `settleChild` reads it again
    // after that turn, so a Ctrl-C during the report cancels the run instead of
    // being overwritten by the `partial` the report would have produced.
    return await settleChild(setup, run, elapsedMs, () => hostSignal?.aborted === true)
  } finally {
    await finish(launched)
  }
}

/** The prompt the child receives, read exactly as `parseSubagentInput` did. */
function promptOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const value = (input as { prompt?: unknown }).prompt
  return typeof value === 'string' ? value : ''
}

/**
 * `runSubagent`: one delegation, background by default.
 *
 * With `wait: true` this is exactly v1: block until the child ends and return
 * its result (a {@link SubagentToolResult}; a failed child is a result, never a
 * throw).
 *
 * Without `wait`, the promise resolves as soon as the child exists with a
 * {@link SubagentBackgroundResult} (`{ status: 'running' }`). The child keeps
 * running on its own `AbortController`, its budget slot is held until it ends,
 * and its outcome is reported to `options.onBackground` through a
 * {@link SubagentLaunch} - never through this return value, because the parent
 * must not treat a completed child's text as a tool result.
 */
export async function runSubagent(
  input: unknown,
  options: SubagentToolOptions,
): Promise<SubagentToolResult> {
  const wait = waitFlag(input)
  if (wait) return await runForeground(input, options)
  return await runBackground(input, options)
}

/**
 * Read `wait` before validation so a malformed value is not mistaken for
 * "background": only a literal `true` (or the string `'true'` an engine may
 * produce) chooses foreground. `parseSubagentInput` rejects everything else
 * with `invalid_input`.
 */
function waitFlag(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const value = (input as { wait?: unknown }).wait
  return value === true || value === 'true'
}

/**
 * Launch a background child and return its launch result immediately.
 *
 * The child owns a fresh `AbortController`; `options.signal` (the parent
 * turn) is deliberately not wired to it, so a turn abort stops only foreground
 * children. The promise returned here resolves once `beginChild` returned, so
 * the model's next step starts while the child is still on its first turn.
 */
async function runBackground(
  input: unknown,
  options: SubagentToolOptions,
): Promise<SubagentBackgroundResult> {
  const launched = await launch(input, options)
  const { setup } = launched
  const controller = new AbortController()
  // A background child's only "parent" is `cancel()`: the timeout, the soft
  // budget and the hand-off all abort the same controller, so the controller's
  // own flag cannot tell them apart. This flag can, and it is what makes a
  // cancelled child `cancelled` and a stopped one `partial`.
  let cancelled = false
  let settled = false
  let resolveDone!: (value: SubagentToolResult) => void
  let rejectDone!: (reason: unknown) => void
  const done = new Promise<SubagentToolResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // The host may drop the handle; the promise must never surface as an
  // unhandled rejection. A host that awaits `done` still sees the error.
  done.catch(() => {})

  const launchHandle: SubagentLaunch = {
    result: {
      runId: setup.childRunId,
      status: 'running',
      tools: [...setup.grant.names],
      denied: [...setup.grant.denied],
      output: '',
      text: backgroundLaunchText({
        runId: setup.childRunId,
        tools: setup.grant.names,
        denied: setup.grant.denied,
      }).text,
    },
    done,
    controller,
    cancel: (reason?: unknown): void => {
      // Only `settled` stops a cancellation. Testing `controller.signal.aborted`
      // here would swallow the one cancel that matters most: by the time a
      // hand-off report is being written the controller is *already* aborted by
      // the budget, so the host's `cancel()` would be ignored and the parent
      // would still be handed a report it asked not to receive.
      if (settled) return
      cancelled = true
      controller.abort(reason)
    },
  }

  const elapsed = (startedAt: number): number => Math.max(0, Date.now() - startedAt)

  // The child's whole life is one detached task: start, settle, dispose,
  // release, and only then report. Reporting last means a host that awaits
  // `done` never sees the slot still held or the handle still open.
  void (async () => {
    const startedAt = Date.now()
    try {
      const run = await runChildGraph(setup, promptOf(input), { foreground: controller, host: undefined })
      // The getter, not the value: `cancel()` can still fire while the report
      // turn runs, and that cancellation must win.
      const result = await settleChild(setup, run, elapsed(startedAt), () => cancelled)
      await finish(launched)
      settled = true
      resolveDone(result)
    } catch (error) {
      await finish(launched)
      settled = true
      rejectDone(error)
    }
  })()

  try {
    options.onBackground?.(launchHandle)
  } catch {
    // A host observer is diagnostic; it must not fail the launch.
  }
  return launchHandle.result
}
