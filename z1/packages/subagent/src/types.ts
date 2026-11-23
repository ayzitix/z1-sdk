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
export const DEFAULT_SUBAGENT_MAX_STEPS = 24
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 240_000

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
 * `partial` is a child that used up its step cap: it is not `failed`, because
 * a child that ran out of steps has usually done most of the work, and its
 * last text is carried so the parent can decide what to do with it.
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
  /** Child agent loop cap; defaults to 24. */
  readonly maxSteps?: number
  /**
   * Child graph-run timeout; defaults to 240_000 ms. This does not cover
   * `beginRun`, child tool re-listing, journal setup/update, or `dispose`;
   * those are host responsibilities.
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
 */
export interface SubagentToolResult {
  readonly runId: string
  readonly status: SubagentToolStatus
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
   * `subagent child_timeout: graph run … timed out after 240000ms`. Present
   * exactly when `status` is not `completed`; a host that only gets the text
   * of a failed result can still match the code.
   */
  readonly message?: string
  /** The model-facing block, `\n`-separated; starts with the data preamble. */
  readonly text: string
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
