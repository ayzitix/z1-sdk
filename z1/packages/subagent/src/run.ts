import { randomUUID } from 'node:crypto'

import { buildAgentGraph } from '@z1/agent'
import { graphDigest } from '@z1/graph'
import type { ApprovalDecision, ToolSchema } from '@z1/node'
import {
  runGraph,
  type ApprovalService,
  type Journal,
  type RunResult,
} from '@z1/runtime'

import { normalizeToolName, parseSubagentInput, resolveToolGrant } from './grant.ts'
import { subagentSystemPrompt } from './prompt.ts'
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
  type SubagentCallGuard,
  type SubagentHost,
  type SubagentInventory,
  type SubagentRunHandle,
  type SubagentRunRecorder,
  type SubagentRunStatus,
  type SubagentToolOptions,
  type SubagentToolResult,
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
 * Run one child agent synchronously.
 *
 * Everything that can invalidate the grant is checked before `beginRun`, so an
 * invalid selection cannot start a child, write a run record, or append an
 * event. Once the child handle exists it is disposed on every path, including
 * timeout, a disappeared tool, and a failed run.
 *
 * `ToolService.call()` has no run/node/signal context yet, so the parent's
 * cancellation is not propagated in v1: the child graph is bounded by
 * `timeoutMs` and its own step limit instead. Setup (`beginRun`, child tool
 * re-listing, journal create/update) and teardown (`dispose`) are not covered
 * by that timer; they remain host responsibilities.
 */
export async function runSubagent(
  input: unknown,
  options: SubagentToolOptions,
): Promise<SubagentToolResult> {
  const limits = normalizeOptions(options)

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
    const signal =
      limits.signal === undefined
        ? controller.signal
        : AbortSignal.any([limits.signal, controller.signal])
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, limits.timeoutMs)

    let result: RunResult
    try {
      result = await runGraph({
        graph,
        registry: child.registry,
        services: { ...child.services, tools: childTools },
        input: parsed.prompt,
        runId: childRunId,
        journal,
        tools: grant.names,
        signal,
        suspendOnApproval: false,
      })
    } catch (error) {
      if (runs !== undefined) {
        try {
          await recordFinalStatus(runs, childRunId, 'failed')
        } catch {
          // The original run failure is the useful error; a broken journal
          // cannot be repaired here.
        }
      }
      throw new SubagentError(
        'child_failed',
        `subagent run ${childRunId} failed: ${errorMessage(error)}`,
        { cause: error },
      )
    } finally {
      clearTimeout(timer)
    }

    if (runs !== undefined) {
      await recordFinalStatus(runs, childRunId, result.status)
    }

    if (timedOut) {
      throw new SubagentError(
        'child_timeout',
        `subagent graph run ${childRunId} timed out after ${String(limits.timeoutMs)}ms`,
      )
    }
    if (result.status === 'failed') {
      throw new SubagentError(
        'child_failed',
        `subagent run ${childRunId} failed: ${result.error ?? 'unknown error'}`,
      )
    }
    if (result.status === 'cancelled') {
      throw new SubagentError(
        'child_cancelled',
        `subagent run ${childRunId} was cancelled`,
      )
    }
    if (result.status === 'suspended') {
      throw new SubagentError(
        'child_suspended',
        `subagent run ${childRunId} suspended on approval at ${
          result.pendingApproval?.path ?? 'unknown path'
        }`,
      )
    }

    const output = result.outputs['output']
    if (typeof output !== 'string') {
      throw new SubagentError(
        'no_output',
        `subagent run ${childRunId} completed without a text output`,
      )
    }

    return {
      runId: childRunId,
      status: 'completed',
      tools: [...grant.names],
      denied: [...grant.denied],
      output,
    }
  } finally {
    reservation.release()
    if (child !== undefined) await child.dispose()
  }
}
