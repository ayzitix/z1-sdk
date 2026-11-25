import type { Json, ModelHandle, NodeRegistry, ToolSchema } from '@z1/node'
import type {
  ApprovalService,
  Journal,
  RunEvent,
  RuntimeServices,
} from '@z1/runtime'

/** Exact tool name the host composes into the parent tool service. */
export const SUBAGENT_TOOL_NAME = 'subagent'

/** `description` is a short label for the parent transcript, not a task. */
export const MAX_SUBAGENT_DESCRIPTION_LENGTH = 120

/** The child prompt is capped in UTF-8 bytes, not UTF-16 code units. */
export const MAX_SUBAGENT_PROMPT_BYTES = 64 * 1024

/** One grant list may not name more tools than this. */
export const MAX_SUBAGENT_TOOL_ENTRIES = 64

/** Tool names are exact identifiers, not patterns. */
export const MAX_SUBAGENT_TOOL_NAME_LENGTH = 128

export const DEFAULT_SUBAGENT_MAX_DEPTH = 1
export const DEFAULT_SUBAGENT_MAX_CHILDREN = 4
export const DEFAULT_SUBAGENT_MAX_TOTAL = 8

/**
 * The child loop cap the agent loop itself can express.
 *
 * `z1.flow.loop` validates `maxIterations` as `int().min(1).max(10_000)`, so a
 * larger value cannot be represented in a graph at all: it would build fine and
 * fail later, inside `buildAgentGraph`, as an invalid-graph error with no run
 * row and no useful message. `maxSteps` is checked against this bound when the
 * options are normalised, so the failure names the option.
 */
export const MAX_SUBAGENT_MAX_STEPS = 10_000

/**
 * The child loop cap when the host does not set one: a runaway guard, not a
 * working limit.
 *
 * It is `@z1/agent`'s own `maxSteps` ceiling (10 000), so a child inherits the
 * parent's bound instead of a tighter one nobody could explain. A cap is a bad
 * primary limit for a delegation: the work is sized by the task, not by a turn
 * count, and a child stopped at 24 turns loses the *next action* even when its
 * window and its wall-clock budget are both barely used. The real limits are
 * the 75% context hand-off ({@link SUBAGENT_HANDOFF_RATIO}) and the soft time
 * budget ({@link DEFAULT_SUBAGENT_TIME_BUDGET_MS}), both of which end the run
 * with a report instead of an error.
 *
 * The cap stays configurable: a host that wants a lower bound (tests, cost
 * control) passes `maxSteps` and gets `partial`/`child_failed` with the
 * step-cap detail. A value above {@link MAX_SUBAGENT_MAX_STEPS} is rejected as
 * `invalid_input` rather than left to fail inside the graph.
 */
export const DEFAULT_SUBAGENT_MAX_STEPS = MAX_SUBAGENT_MAX_STEPS

/**
 * A historical hard guard, retained for compatibility. **It is not the
 * default**: the default hard guard is the child's soft time budget plus
 * {@link DEFAULT_SUBAGENT_REPORT_GRACE_MS} (42 minutes for the 40-minute
 * default budget), so the graceful stop always gets to write its report first.
 *
 * A timeout is `child_timeout` with **no report**, unlike the soft budget, so
 * an explicit `timeoutMs` shorter than `timeBudgetMs` disables the hand-off
 * report entirely: the child is killed before it can write one. That includes
 * passing this constant explicitly (`timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS`,
 * four minutes), which will stop every child before its 40-minute budget is
 * reached. Use `resolveChildBudgets({ timeBudgetMs })` from `@z1/subagent` to
 * derive a bound that still leaves room for the report.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 240_000

/**
 * Soft wall-clock budget of one child run: 40 minutes.
 *
 * The context hand-off bounds a child by *tokens*, which says nothing about a
 * task that is slow rather than large - a child waiting on a build, a network
 * call or a pathological retry loop burns the user's patience without filling
 * its window. At this budget the child stops taking new work, writes the same
 * kind of hand-off report, and the parent gets `partial`/`time_limit` instead
 * of a bare truncation. The default matches the ceiling this package already
 * documented for a delegation (`DEFAULT_SUBAGENT_TIMEOUT_MS` used to be the
 * only bound), now applied as a graceful stop rather than a kill.
 */
export const DEFAULT_SUBAGENT_TIME_BUDGET_MS = 40 * 60 * 1000

/**
 * Room the report turn gets after either stop, in milliseconds.
 *
 * The soft budget aborts the graph and *then* asks for the report, so the hard
 * timer must be strictly later than the soft one: `timeBudgetMs + this` is the
 * default `timeoutMs`. Without the grace the hard timer would fire while the
 * report is being written and turn a `partial` into a `child_timeout`.
 */
export const DEFAULT_SUBAGENT_REPORT_GRACE_MS = 2 * 60 * 1000

/**
 * Hard cap on the report turn itself, in milliseconds.
 *
 * The report is one tool-free model call appended to an already-large
 * transcript, so it can stall like any other call. `LlmService.chat` takes no
 * signal, so this is a race, not a cancellation: the run keeps whatever the
 * child had and says the report could not be produced.
 */
export const SUBAGENT_REPORT_TIMEOUT_MS = 60_000

/** Smallest wall-clock cap a caller may ask for on one child, in minutes. */
export const MIN_SUBAGENT_TIME_MINUTES = 1

/** Largest wall-clock cap a caller may ask for on one child, in minutes. */
export const MAX_SUBAGENT_TIME_MINUTES = 120

/**
 * Fraction of the context window at which a child stops working and reports.
 *
 * A child that fills its window is cut off mid-task by the provider, and the
 * parent gets a failure with no content: the work is lost and the user learns
 * nothing. Stopping earlier costs the *next action*, never the *report* - at
 * the threshold the child is asked what is done, what is not, and how to
 * continue, which is the only useful thing a truncated run can say. Three
 * quarters leaves a full quarter of the window for that report.
 */
export const SUBAGENT_HANDOFF_RATIO = 0.75

/** The context window a child assumes when its host does not know one. */
export const DEFAULT_SUBAGENT_CONTEXT_WINDOW = 128_000

/**
 * The model-facing input. `enable` is required: delegation never inherits the
 * parent's tool set implicitly. `disable` is applied afterwards and wins.
 */
export interface SubagentToolSelection {
  readonly enable: readonly string[]
  readonly disable?: readonly string[]
}

export interface SubagentInput {
  readonly description: string
  readonly prompt: string
  readonly tools: SubagentToolSelection
  /**
   * `true` waits for the child and returns its result text; omitted or `false`
   * runs it in the background and returns `{ runId, status: 'running' }` at
   * once. Parsed by {@link parseSubagentInput}.
   */
  readonly wait?: boolean
  /**
   * The parent agent's own wall-clock cap for this child, in whole minutes
   * ({@link MIN_SUBAGENT_TIME_MINUTES}..{@link MAX_SUBAGENT_TIME_MINUTES}).
   *
   * A parent that knows a task must not run for an hour - a quick lookup it
   * delegated only to keep its own context clean - can say so instead of
   * burning the host default. Omitted, the host's `timeBudgetMs` applies.
   * The model may only *lower* the budget: a request above the host's is
   * clamped to it, and an out-of-range value is rejected with an
   * `invalid_input` {@link SubagentError} rather than silently corrected.
   */
  readonly timeMinutes?: number
}

/**
 * The parent's raw inventory plus its effective set.
 *
 * `installed` answers "does this name exist?" and `enabled` is the ceiling: the
 * tools the parent itself may call right now. Keeping them separate is what
 * makes "no installed tool" and "installed but disabled" distinct errors.
 */
export interface SubagentInventory {
  readonly installed: readonly ToolSchema[]
  readonly enabled: readonly ToolSchema[]
}

export interface ToolGrant {
  /** Expanded `enable`, in parent list order, before `disable`, without the subagent tool. */
  readonly requested: readonly string[]
  /** The effective grant: `requested` minus `disable`. */
  readonly names: readonly string[]
  /** Names present in both `enable` and `disable`; denied and reported. */
  readonly denied: readonly string[]
}

export interface ToolGrantContext {
  readonly inventory: SubagentInventory
  /** The delegation tool itself; defaults to `subagent`. */
  readonly toolName?: string
  /** Delegation depth of the parent agent (0 is the main agent). */
  readonly depth?: number
  /**
   * Retained for diagnostics; v1 clamps this to 1. Nested delegation is not
   * supported, so an explicit delegation tool name is rejected regardless.
   */
  readonly maxDepth?: number
  /** Maximum entries in `enable` and, separately, `disable`; defaults to 64. */
  readonly maxEntries?: number
}

export interface SubagentInputLimits {
  readonly maxDescriptionLength?: number
  readonly maxPromptBytes?: number
  readonly maxToolEntries?: number
  readonly maxToolNameLength?: number
}

export type SubagentGrantErrorCode =
  | 'invalid_tools'
  | 'invalid_name'
  | 'too_many_tools'
  | 'unknown_tool'
  | 'disabled_tool'
  | 'invalid_pattern'
  | 'depth_exceeded'
  | 'duplicate_tool'

export type SubagentErrorCode =
  | SubagentGrantErrorCode
  | 'invalid_input'
  | 'limit_exceeded'
  | 'child_tool_missing'
  | 'child_failed'
  | 'child_timeout'
  | 'child_cancelled'
  | 'child_suspended'
  | 'no_output'
  /**
   * The child stopped at the context hand-off threshold rather than finishing
   * or breaking. `partial`, not `failed`: it did work and it reported what
   * remains, which is the useful outcome when a window runs out.
   *
   * Only a run that did *not* finish reaches this code: a graph that produced
   * its answer keeps `completed`, even when the threshold was crossed while the
   * last event was being written.
   */
  | 'context_limit'
  /**
   * The child stopped at its soft wall-clock budget rather than finishing or
   * breaking. Same shape as `context_limit`: `partial` with a hand-off report,
   * because running out of *time* says nothing about the work being wrong.
   *
   * Like `context_limit`, it is only for a run that did not finish: a timer that
   * fires while a completed run's terminal event is being appended does not
   * discard that run's answer.
   */
  | 'time_limit'

/**
 * The stable token every `SubagentError` message starts with. A host that only
 * receives text (a log, a `{ error }` tool result) can match it instead of
 * parsing prose; the structured `code` stays the primary channel.
 */
export const subagentErrorPrefix = (code: SubagentErrorCode): string => `subagent ${code}: `

export class SubagentError extends Error {
  readonly code: SubagentErrorCode

  constructor(code: SubagentErrorCode, message: string, options?: ErrorOptions) {
    super(message.startsWith(subagentErrorPrefix(code)) ? message : `${subagentErrorPrefix(code)}${message}`, options)
    this.name = 'SubagentError'
    this.code = code
    // A `ToolService.call` argument may be structured-cloned before the call
    // leaves the host, so the code is an own enumerable field rather than a
    // class-only property; `codeOf` reads it structurally across that boundary.
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: true,
    })
  }
}

/** A throw that lost its `SubagentError` identity but kept `{ name, code }`. */
export interface SubagentErrorTap {
  readonly code: SubagentErrorCode
  readonly message: string
}

/**
 * The error code of anything that is (or looks like) a `SubagentError`, read
 * structurally so a cloned or re-wrapped error is not silently `child_failed`.
 */
export function subagentErrorTap(error: unknown): SubagentErrorTap | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (!(error instanceof SubagentError)) return undefined
  // Subclasses rename themselves (`SubagentGrantError`); the code is inherited
  // and own, so `instanceof` is the test, not the name.
  const code = error.code
  return {
    code,
    message: typeof error.message === 'string' ? error.message : '',
  }
}

export interface SubagentGrantErrorDetails {
  readonly requested?: readonly string[]
  readonly denied?: readonly string[]
}

/**
 * A grant failure carries the names it managed to resolve, so a caller can
 * report both the error and what the model asked for without re-parsing input.
 */
export class SubagentGrantError extends SubagentError {
  readonly requested: readonly string[]
  readonly denied: readonly string[]

  constructor(
    code: SubagentGrantErrorCode,
    message: string,
    details: SubagentGrantErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(code, message, options)
    this.name = 'SubagentGrantError'
    this.requested = details.requested ?? []
    this.denied = details.denied ?? []
    // The base constructor sets an own enumerable `code`; a subclass field
    // declaration would shadow it with a non-enumerable one, so it is
    // re-asserted here for the same structured-clone reason.
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: true,
    })
  }
}

export interface SubagentBudgetOptions {
  /** Concurrent child runs sharing this budget; defaults to 4. */
  readonly maxChildren?: number
  /** Child runs started from this budget over its lifetime; defaults to 8. */
  readonly maxTotal?: number
}

/**
 * A call-only policy hook: it checks the live host policy and throws to revoke
 * the call. It never dispatches the tool; the caller performs the call after it
 * returns.
 */
export type SubagentCallGuard = (name: string, args: Json) => void | Promise<void>

export interface SubagentReservation {
  /** Count the child as started; call only after `beginRun` succeeded. */
  commit(): void
  /** Release the active slot; safe to call more than once. */
  release(): void
}

function positiveInteger(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new SubagentError(
      'invalid_input',
      `${name} must be an integer >= ${minimum}, got ${String(value)}`,
    )
  }
  return value
}

/**
 * Shared child-run budget. Hosts that create a subagent tool per turn should
 * reuse one budget so `maxTotal` is a session limit rather than a tool-instance
 * limit; `createSubagentTool` falls back to one budget per host.
 */
export class SubagentBudget {
  readonly maxChildren: number
  readonly maxTotal: number
  #active = 0
  #total = 0

  constructor(options: SubagentBudgetOptions = {}) {
    this.maxChildren = positiveInteger(
      options.maxChildren ?? DEFAULT_SUBAGENT_MAX_CHILDREN,
      'maxChildren',
      1,
    )
    this.maxTotal = positiveInteger(
      options.maxTotal ?? DEFAULT_SUBAGENT_MAX_TOTAL,
      'maxTotal',
      1,
    )
  }

  /** Children currently running (reserved, whether committed or not). */
  get active(): number {
    return this.#active
  }

  /** Children that have actually reached `beginRun`. */
  get total(): number {
    return this.#total
  }

  /**
   * Reserve one active slot before a side effect. Throws when the concurrency
   * or lifetime cap is already reached, so the caller never starts a child it
   * cannot account for. A reservation that fails before `commit()` rolls the
   * active slot back on `release()` and does not consume `maxTotal`.
   */
  reserve(): SubagentReservation {
    if (this.#active >= this.maxChildren) {
      throw new SubagentError(
        'limit_exceeded',
        `subagent budget: ${String(this.maxChildren)} child run(s) are already active`,
      )
    }
    if (this.#total >= this.maxTotal) {
      throw new SubagentError(
        'limit_exceeded',
        `subagent budget: ${String(this.maxTotal)} child run(s) have already started`,
      )
    }

    this.#active += 1
    let committed = false
    let released = false

    return {
      commit: (): void => {
        if (committed || released) return
        committed = true
        this.#total += 1
      },
      release: (): void => {
        if (released) return
        released = true
        this.#active -= 1
      },
    }
  }
}

export type SubagentRunStatus = 'completed' | 'failed' | 'cancelled' | 'suspended'
export type SubagentRunRecordStatus = 'running' | SubagentRunStatus

/**
 * The row `runGraph` needs when the journal stores run records. It deliberately
 * has no `parentRunId`: a child is recorded through its own run events and the
 * parent tool result, never through fork lineage.
 */
export interface SubagentRunRecord {
  readonly runId: string
  readonly graphId: string
  readonly graphDigest: string
  readonly status: SubagentRunRecordStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SubagentRunPatch {
  readonly status: SubagentRunStatus
  readonly updatedAt: number
}

/**
 * The run-record half of a durable journal. Both methods are required
 * together: a create-only recorder would leave a completed child as a
 * `running` row, and an update-only recorder would fail on the first event.
 * The package also auto-detects this complete capability on `host.journal`, so
 * a production `SqliteJournal` needs no separate `runs` property; an explicit
 * complete recorder takes precedence over the journal's shape. An event-only
 * journal such as `MemoryJournal` omits it entirely.
 */
export interface SubagentRunRecorder {
  createRun(record: SubagentRunRecord): void | Promise<void>
  updateRun(runId: string, patch: SubagentRunPatch): void | Promise<void>
}

export interface SubagentRunOverrides {
  readonly runId?: string
  readonly approval: ApprovalService
  readonly moduleApproval?: ApprovalService
}

/**
 * The part of a bootstrap `RunHandle` this package needs. Structural on
 * purpose: `@z1/subagent` must not import `@z1/bootstrap` (that would create a
 * cycle), while a real `RunHandle` remains assignable.
 */
export interface SubagentRunHandle {
  readonly registry: NodeRegistry
  readonly services: RuntimeServices
  dispose(): Promise<void>
}

export interface SubagentHost {
  /** Event journal handed to `runGraph`. */
  readonly journal: Journal
  /**
   * Run-record capability. An explicit complete recorder always wins. When it
   * is omitted, a complete recorder is auto-detected on `journal` (a production
   * `SqliteJournal` has both methods), so a `{ journal, beginRun }` host works
   * unchanged; a journal with only one of the two methods is rejected before a
   * child starts. An event-only journal such as `MemoryJournal` needs neither.
   */
  readonly runs?: SubagentRunRecorder
  beginRun(overrides: SubagentRunOverrides): Promise<SubagentRunHandle>
}

/**
 * What a finished delegation reports.
 *
 * `partial` is a child that ran out of a budget rather than out of work: it hit
 * its step cap, its context hand-off point or its soft time budget. It is not
 * `failed`, because such a child has usually done most of the work, and its
 * last text (or its hand-off report) is carried so the parent can decide what
 * to do with it.
 */
export type SubagentToolStatus = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'partial'

export interface SubagentToolOptions {
  /** Model used for every child run; the model-facing input cannot change it. */
  readonly model: ModelHandle
  readonly host: SubagentHost
  /** Installed tools and the parent's effective ceiling. */
  readonly inventory: SubagentInventory
  /** Tool name; defaults to `subagent`. */
  readonly name?: string
  /**
   * Delegation depth of the calling agent; defaults to 0. v1 supports only
   * depth 0: a child never receives the subagent tool.
   */
  readonly depth?: number
  /**
   * Child agent loop cap; defaults to {@link DEFAULT_SUBAGENT_MAX_STEPS}
   * (10 000, the parent loop's own ceiling).
   *
   * This is a runaway guard, not the working limit: a child is meant to stop at
   * its context hand-off or its time budget, both of which produce a report. A
   * host that sets a lower cap gets `partial`/`child_failed` with the step-cap
   * detail instead. Above {@link MAX_SUBAGENT_MAX_STEPS} the option is rejected
   * as `invalid_input`, because the loop node cannot express a larger cap.
   */
  readonly maxSteps?: number
  /**
   * The child model's context window, in tokens. The child stops taking new
   * work at `SUBAGENT_HANDOFF_RATIO` of it and reports instead of running into
   * a provider failure, so the host should set this to the real window when it
   * knows one. Defaults to `DEFAULT_SUBAGENT_CONTEXT_WINDOW`.
   */
  readonly contextWindow?: number
  /**
   * Soft wall-clock budget of one child run; defaults to
   * {@link DEFAULT_SUBAGENT_TIME_BUDGET_MS} (40 minutes).
   *
   * When it expires the child stops taking new work and writes the same
   * tool-free hand-off report the context hand-off writes; the result is
   * `partial`/`time_limit`. A model-facing `timeMinutes` may lower it for one
   * call, never raise it. Like `timeoutMs` it covers the child graph run, not
   * `beginRun`, child tool re-listing, journal setup or `dispose`.
   */
  readonly timeBudgetMs?: number
  /**
   * Hard outer guard of one child graph run, in milliseconds.
   *
   * Default: the child's effective soft budget plus
   * {@link DEFAULT_SUBAGENT_REPORT_GRACE_MS}, so the graceful stop always gets
   * to write its report before this timer fires. An explicit value shorter than
   * the soft budget wins (the closer deadline is the honest one) and the run
   * ends as `child_timeout` with **no report** - the child is killed before it
   * can write one. That includes passing the historical
   * {@link DEFAULT_SUBAGENT_TIMEOUT_MS} (four minutes), which pre-empts the
   * 40-minute budget entirely; `resolveChildBudgets({ timeBudgetMs })` derives a
   * bound that keeps room for the report.
   *
   * Neither guard covers `beginRun`, child tool re-listing, journal
   * setup/update, or `dispose`; those are host responsibilities.
   */
  readonly timeoutMs?: number
  /** May only lower the 120-character contract cap. */
  readonly maxDescriptionLength?: number
  /** May only lower the 64 KiB UTF-8 contract cap. */
  readonly maxPromptBytes?: number
  /** May only lower the 64-entry contract cap. */
  readonly maxToolEntries?: number
  /** Shared budget; defaults to one budget per `host`. */
  readonly budget?: SubagentBudget
  /** Child node approval; defaults to deny. */
  readonly approval?: ApprovalService
  /** Child module approval; defaults to deny, independently of `approval`. */
  readonly moduleApproval?: ApprovalService
  /**
   * Optional host signal. It is not read from `ToolService.call()` (that API
   * has no run context yet); the host passes it explicitly, usually the
   * parent turn's `AbortController.signal`. Aborting it is a *parent
   * cancellation*: the child graph stops and the run is recorded and reported
   * as `cancelled`, never `failed`. `timeoutMs` is separate and stays
   * `child_timeout`.
   */
  readonly signal?: AbortSignal
  /**
   * Optional call-only policy hook for the child's tool service, invoked before
   * every granted call is forwarded. The CLI can wire its live `/tools` guard
   * here so a mid-run `/tools off read` revokes a child tool.
   */
  readonly guardCall?: SubagentCallGuard
  /**
   * Receives every child run event as it happens (before the journal append),
   * tagged with `runId`. A host uses this to count the child's steps and to
   * refresh a "N subagents running" line without reading the journal.
   *
   * Setup and the run's own event stream only: it is never given the parent's
   * events, so a host cannot confuse the two.
   */
  readonly onEvent?: (event: RunEventWithRunId) => void
  /**
   * Called once a background child's run row exists and the child is about to
   * start, with a handle the host keeps in order to observe and stop it. It is
   * the background counterpart of `onEvent`: the *result* arrives through
   * `handle.result`, never as a tool result.
   *
   * A host that loses the handle cannot stop the child but does not leak it:
   * the child is still bounded by `timeoutMs` and its budget slot is released
   * when it ends.
   */
  readonly onBackground?: (handle: SubagentLaunch) => void
}

/** A launch the model must not wait for: the run exists, the outcome does not. */
export interface SubagentLaunch {
  /** The launch result the tool call returns: `{ status: 'running' }`. */
  readonly result: SubagentBackgroundResult
  /**
   * Resolves with the child's final result (a finished child is a result, never
   * a throw - the same rule `wait: true` follows) or rejects only when the
   * final run row could not be recorded, mirroring the foreground path.
   */
  readonly done: Promise<SubagentToolResult>
  /**
   * Stop the child now. Idempotent; a child that already settled ignores it.
   * The child records `cancelled` (never `failed`), exactly like a host signal.
   */
  cancel(reason?: unknown): void
  /** The child's own controller; it is never wired to the parent turn's. */
  readonly controller: AbortController
}

/** A child event. Every `RunEvent` already carries `runId`; this names it. */
export type RunEventWithRunId = RunEvent & { readonly runId: string }

/**
 * The machine-readable half of a delegation result.
 *
 * `status` is the honest outcome, including `partial` (step cap) and
 * `timeout`; `errorCode` is the package's code (`child_timeout`,
 * `child_cancelled`, `child_failed`, `no_output`, …) so a host can tell a
 * timeout from a parent cancellation without parsing text. `text` is the block
 * the model reads - data, never instructions - and always starts with
 * {@link SUBAGENT_RESULT_PREAMBLE}.
 *
 * A failed run does not throw: the caller gets this object with `isError: true`
 * on the tool channel (see `call`), so the code survives the tool boundary the
 * way `z1.tool.call`'s `{ isError: true }` result does.
 *
 * A background launch is a {@link SubagentLaunch}: the tool call resolves
 * before the child has an outcome, and the outcome reaches the host through the
 * launch task's promise, never as a tool result.
 */
export interface SubagentToolResult {
  readonly runId: string
  /**
   * `running` only on a {@link SubagentBackgroundResult}; every entry of a
   * finished result is the package's tool status.
   */
  readonly status: SubagentToolStatus | 'running'
  readonly tools: readonly string[]
  readonly denied: readonly string[]
  /** The child's answer; empty when it produced none. */
  readonly output: string
  /** Always present on a non-`completed`/`partial` result. */
  readonly errorCode?: SubagentErrorCode
  /** The child's last assistant text when the run did not complete. */
  readonly partial?: string
  /** Child loop iterations the run completed (from `node.started` events). */
  readonly steps?: number
  /** Wall time of the child graph run, in milliseconds. */
  readonly elapsedMs?: number
  /** One sentence describing how the run ended. */
  readonly detail?: string
  /**
   * The failed-run message, prefixed with a stable machine token:
   * `subagent child_timeout: graph run … timed out after <timeoutMs>ms`. Present
   * exactly when `status` is not `completed`; a host that only gets the text
   * of a failed result can still match the code.
   */
  readonly message?: string
  /** The model-facing block, `\n`-separated; starts with the data preamble. */
  readonly text: string
}

/**
 * What a background launch returns in the model's step: the run exists, it is
 * not finished, and its result will not come back through this tool call.
 *
 * `text` is the model-facing block (one line plus the run id), so the model
 * knows the child was started and that it must not wait for it.
 */
export interface SubagentBackgroundResult extends SubagentToolResult {
  readonly status: 'running'
}

/** The host-side tool: a schema plus the callable implementation. */
export interface SubagentTool {
  readonly schema: ToolSchema
  call(args: Json): Promise<SubagentToolResult>
}

export interface RestrictToolServiceOptions {
  /** Schemas to advertise without another `inner.list()` call. */
  readonly inventory?: readonly ToolSchema[]
  /**
   * Optional live policy hook, called before a granted call is forwarded. A
   * host can install its call-only `/tools` guard here; throwing revokes the
   * call without the restricted service advertising an ungranted tool.
   */
  readonly guardCall?: SubagentCallGuard
}

export interface WithSubagentToolOptions {
  /**
   * Inventory used for the composition-time collision check. Defaults to
   * `inner.list()`; a CLI should pass its raw snapshot (before this subagent
   * tool is added) so a disabled tool that happens to be named `subagent` still
   * counts as a collision. Do not include the composed subagent schema itself.
   */
  readonly inventory?: readonly ToolSchema[]
  /**
   * Optional live policy hook for the composite's own name. The CLI can pass
   * its call-only `/tools` guard here so a mid-run `/tools off subagent`
   * revokes the tool before a child starts; non-composite names are forwarded
   * to `inner.call` and are guarded there.
   */
  readonly guardCall?: SubagentCallGuard
}
