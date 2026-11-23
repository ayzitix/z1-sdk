import { randomUUID } from 'node:crypto'

import { buildAgentGraph } from '@z1/agent'
import { graphDigest } from '@z1/graph'
import type { ApprovalDecision, ToolSchema } from '@z1/node'
import {
  runGraph,
  type ApprovalService,
  type Journal,
  type RunEvent,
  type RunResult,
} from '@z1/runtime'

import { normalizeToolName, parseSubagentInput, resolveToolGrant } from './grant.ts'
import { subagentSystemPrompt } from './prompt.ts'
import { partialText, resultText, stepCapDetail, stepLimitSteps } from './result.ts'
import { restrictToolService } from './restrict.ts'
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  DEFAULT_SUBAGENT_MAX_STEPS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_SUBAGENT_DESCRIPTION_LENGTH,
  MAX_SUBAGENT_PROMPT_BYTES,
  MAX_SUBAGENT_TOOL_ENTRIES,
  SUBAGENT_TOOL_NAME,
  SubagentBudget,
  SubagentError,
  type RunEventWithRunId,
  type SubagentCallGuard,
  type SubagentHost,
  type SubagentInventory,
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
  readonly timeoutMs: number
  readonly maxDescriptionLength: number
  readonly maxPromptBytes: number
  readonly maxToolEntries: number
  readonly budget: SubagentBudget
  readonly approval: ApprovalService
  readonly moduleApproval: ApprovalService
  readonly signal: AbortSignal | undefined
  readonly guardCall: SubagentCallGuard | undefined
  readonly onEvent: SubagentToolOptions['onEvent']
  readonly runs: SubagentRunRecorder | undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const timeoutMs = integerOption(
    options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS,
    'timeoutMs',
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

  return {
    model: options.model,
    host: options.host,
    inventory: options.inventory,
    toolName,
    depth,
    maxSteps,
    timeoutMs,
    maxDescriptionLength,
    maxPromptBytes,
    maxToolEntries,
    budget: options.budget ?? subagentBudgetFor(options.host),
    approval,
    moduleApproval: options.moduleApproval ?? denyApprovalService,
    signal: options.signal,
    guardCall: options.guardCall,
    onEvent: options.onEvent,
    runs,
  }
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
 * Run one child agent synchronously.
 *
 * Everything that can invalidate the grant is checked before `beginRun`, so an
 * invalid selection cannot start a child, write a run record, or append an
 * event. Once the child handle exists it is disposed on every path, including
 * timeout, parent cancellation, a disappeared tool, and a failed run.
 *
 * `ToolService.call()` has no run/node/signal context, so the host passes its
 * cancellation through `options.signal` explicitly. The child runs on
 * `AbortSignal.any([options.signal, timeout])`; `childOutcome` decides the one
 * terminal status and callers see it in the journal row and, in the returned
 * `SubagentToolResult`, as `status` plus `errorCode`:
 *
 * - host signal aborted  → `cancelled` (`child_cancelled`), row `cancelled`
 * - `timeoutMs` expired  → `timeout` (`child_timeout`), row `failed`
 * - step cap exhausted   → `partial` (`child_failed`), row `failed`
 * - anything else        → `failed` (`child_failed` / `no_output` /
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
 */
export async function runSubagent(
  input: unknown,
  options: SubagentToolOptions,
): Promise<SubagentToolResult> {
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
  const grant = resolveToolGrant(parsed.tools, {
    inventory: limits.inventory,
    toolName: limits.toolName,
    depth: limits.depth,
    maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
    maxEntries: limits.maxToolEntries,
  })

  const reservation = limits.budget.reserve()
  const childRunId = `run_${randomUUID()}`
  let child: SubagentRunHandle | undefined

  try {
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
    reservation.commit()

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

    const childTools = restrictToolService(child.services.tools, grant.names, {
      inventory: schemas,
      ...(limits.guardCall === undefined ? {} : { guardCall: limits.guardCall }),
    })
    const graph = buildAgentGraph({
      model: limits.model,
      tools: schemas,
      system: subagentSystemPrompt({ tools: grant.names }),
      maxSteps: limits.maxSteps,
    })

    const journal = limits.host.journal
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

    const controller = new AbortController()
    // The host signal is read once into a local so the post-run snapshot below
    // observes the same object (the options bag is readonly, the signal is not).
    const hostSignal = limits.signal
    const signal =
      hostSignal === undefined
        ? controller.signal
        : AbortSignal.any([hostSignal, controller.signal])

    // The package always observes its own child: a host may want the stream
    // (a CLI counts steps live), but the step count must also reach the result
    // when no callback is installed, so the counting lives here and the host
    // callback sees exactly these events and never the parent's.
    let steps = 0
    let timedOut = false
    let thrown: unknown
    const forward = limits.onEvent
    const childEvents = (event: RunEvent): void => {
      if (event.type === 'node.started' && /^loop\/\d+\/chat$/.test(event.path)) steps += 1
      if (forward === undefined) return
      try {
        forward(event as RunEventWithRunId)
      } catch {
        // A host observer is diagnostic; it must not fail the child run.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, limits.timeoutMs)
    const startedAt = Date.now()
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
        graph,
        registry: child.registry,
        services: {
          ...child.services,
          tools: childTools,
          onEvent: childEvents,
        },
        input: parsed.prompt,
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
    const elapsedMs = Date.now() - startedAt
    // Snapshot after the run settled: by then the host signal is final, and
    // its `aborted` flag is the one fact that separates a parent cancellation
    // from a child failure.
    const hostAborted = hostSignal?.aborted === true

    const outcome = childOutcome(hostAborted, timedOut, limits.timeoutMs, childRunId, result, thrown)

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
        // The row is rewritten to the same final status the graph wrote, and
        // stays `cancelled` even when (rarely) the run had no chance to write
        // its own `run.cancelled`. The message names the parent so the CLI can
        // render a cancellation as one. A journal that also rejects the write
        // during a host abort is not worth replacing the cancellation with.
        if (runs !== undefined) {
          try {
            await recordFinalStatus(runs, childRunId, 'cancelled')
          } catch (error) {
            if (!hostAborted) throw error
          }
        }
        return {
          ...shared,
          status: 'cancelled',
          errorCode: 'child_cancelled',
          output: '',
          ...(kept === undefined ? {} : { partial: kept }),
          message: `subagent child_cancelled: ${outcome.message}`,
          detail: outcome.message,
          text: resultText({
            runId: childRunId,
            status: 'cancelled',
            errorCode: 'child_cancelled',
            steps: stepped,
            elapsedMs,
            tools: shared.tools,
            denied: shared.denied,
            ...(kept === undefined ? {} : { partial: kept }),
            detail: outcome.message,
          }).text,
        }
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
        toolStatusValue === 'partial' && stepped !== undefined
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
  } finally {
    reservation.release()
    if (child !== undefined) await child.dispose()
  }
}
