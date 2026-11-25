import type {
  ChatRequest,
  ChatResult,
  Json,
  NodeRegistry,
  ToolSchema,
} from '@z1/node'
import type { Journal, LlmService, RunEvent } from '@z1/runtime'
import { createMockRuntimeServices, type MockRuntimeServices } from '@z1/runtime'
import { createBuiltinRegistry } from '@z1/nodes'

import type {
  SubagentHost,
  SubagentRunHandle,
  SubagentRunOverrides,
  SubagentRunPatch,
  SubagentRunRecord,
  SubagentRunRecorder,
} from '../src/index.ts'

/** A minimal tool declaration; grant tests do not care about parameters. */
export function schema(name: string, description = name): ToolSchema {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

export interface TestJournal extends Journal, SubagentRunRecorder {
  readonly events: Map<string, RunEvent[]>
  readonly runs: Map<string, SubagentRunRecord>
  readonly updates: { readonly runId: string; readonly patch: SubagentRunPatch }[]
  /**
   * Reject the next append of `type` once (then accept it). Used to make
   * `runGraph` lose a specific event, e.g. its own terminal append.
   */
  failNext(type: RunEvent['type'], reason?: string): void
}

/**
 * An in-memory journal with the same obligations as `SqliteJournal`: a run row
 * must exist before events are appended, and the row's status is updated
 * explicitly. The object provides both capabilities, so passing it as
 * `host.journal` exercises the package's complete-recorder auto-detection.
 */
export function createTestJournal(): TestJournal {
  const events = new Map<string, RunEvent[]>()
  const runs = new Map<string, SubagentRunRecord>()
  const updates: { runId: string; patch: SubagentRunPatch }[] = []
  const failing = new Map<string, string>()

  return {
    events,
    runs,
    updates,

    failNext(type: RunEvent['type'], reason = 'journal: append lost'): void {
      failing.set(type, reason)
    },

    createRun(record: SubagentRunRecord): void {
      if (runs.has(record.runId)) {
        throw new Error(`journal: run ${record.runId} already exists`)
      }
      runs.set(record.runId, record)
      events.set(record.runId, [])
    },

    updateRun(runId: string, patch: SubagentRunPatch): void {
      const record = runs.get(runId)
      if (record === undefined) throw new Error(`journal: unknown run ${runId}`)
      updates.push({ runId, patch })
      runs.set(runId, { ...record, ...patch })
    },

    append(event: RunEvent): void {
      const rows = events.get(event.runId)
      if (rows === undefined) {
        throw new Error(`journal: cannot append to unknown run ${event.runId}`)
      }
      const reason = failing.get(event.type)
      if (reason !== undefined) {
        failing.delete(event.type)
        throw new Error(reason)
      }
      rows.push(event)
    },

    read(runId: string): readonly RunEvent[] {
      return events.get(runId) ?? []
    },
  }
}

export interface FakeHostOptions {
  readonly tools?: readonly ToolSchema[] | (() => Promise<readonly ToolSchema[]>)
  readonly llm?: LlmService
  readonly journal?: Journal
  /**
   * Explicit run recorder. Omit it to exercise the production shape where the
   * package auto-detects a complete recorder on `journal`; pass a partial object
   * only in tests that prove it is rejected.
   */
  readonly runs?: SubagentRunRecorder
  /** Runs after `beginRun` is recorded, before a handle is returned. */
  readonly beforeBegin?: () => void | Promise<void>
  /** Runs inside the fake handle's `dispose()`. */
  readonly beforeDispose?: () => void | Promise<void>
  /**
   * Serve this as the handle's `services.onEvent`. The package *replaces* it on
   * the child run with its own forwarding wrapper, so this only proves which
   * channel is authoritative; it is never seen by the parent.
   */
  readonly hostOnEvent?: (event: RunEvent) => void
}

export class FakeHandle implements SubagentRunHandle {
  readonly registry: NodeRegistry
  readonly services: MockRuntimeServices
  readonly #beforeDispose: (() => void | Promise<void>) | undefined
  disposed = false

  constructor(
    registry: NodeRegistry,
    services: MockRuntimeServices,
    beforeDispose?: () => void | Promise<void>,
  ) {
    this.registry = registry
    this.services = services
    this.#beforeDispose = beforeDispose
  }

  async dispose(): Promise<void> {
    if (this.#beforeDispose !== undefined) await this.#beforeDispose()
    this.disposed = true
  }
}

export interface FakeHost extends SubagentHost {
  readonly journal: Journal
  readonly runs?: SubagentRunRecorder
  readonly beginCalls: SubagentRunOverrides[]
  readonly handles: FakeHandle[]
}

/**
 * A structural `SubagentHost`: a real bootstrap `RunHandle` and a real
 * `runGraph` run inside the package, while `beginRun` itself stays observable.
 */
export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const journal = options.journal ?? createTestJournal()
  const beginCalls: SubagentRunOverrides[] = []
  const handles: FakeHandle[] = []

  return {
    journal,
    ...(options.runs === undefined ? {} : { runs: options.runs }),
    beginCalls,
    handles,

    async beginRun(overrides: SubagentRunOverrides): Promise<SubagentRunHandle> {
      beginCalls.push(overrides)
      if (options.beforeBegin !== undefined) await options.beforeBegin()

      const services = createMockRuntimeServices()
      const source = options.tools ?? []
      services.tools = {
        async list(): Promise<readonly ToolSchema[]> {
          return typeof source === 'function' ? await source() : source
        },
        async call(name: string, args: Json): Promise<Json> {
          services.toolCalls.push({ name, args })
          return { ok: true, name, args }
        },
      }
      if (options.llm !== undefined) services.llm = options.llm
      services.approval = overrides.approval
      if (options.hostOnEvent !== undefined) services.onEvent = options.hostOnEvent

      const handle = new FakeHandle(
        createBuiltinRegistry(),
        services,
        options.beforeDispose,
      )
      handles.push(handle)
      return handle
    },
  }
}

export interface CapturedLlm {
  readonly llm: LlmService
  readonly requests: ChatRequest[]
}

/** A model that answers every turn with the same final text. */
export function staticLlm(reply: string): CapturedLlm {
  const requests: ChatRequest[] = []
  return {
    requests,
    llm: {
      async chat(request: ChatRequest): Promise<ChatResult> {
        requests.push(request)
        return {
          message: { role: 'assistant', content: reply },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    },
  }
}

/** A model that never settles, for the timeout test. */
export const hangingLlm: LlmService = {
  async chat(): Promise<ChatResult> {
    return await new Promise<ChatResult>(() => {
      // Deliberately unresolved: the child timeout must abort the run without
      // the model cooperating.
    })
  },
}

/**
 * A model that blocks on its first call until the test releases it.
 *
 * `LlmService.chat` has no signal argument, and the executor races a node
 * attempt against the run signal itself, so a hanging model still ends the
 * run on abort. `pendingCall` lets a test abort a *live* child turn without a
 * sleep; `failNext()` covers the other path, where the node throws and
 * `runGraph` takes its failure branch instead of returning `cancelled`.
 */
export interface GatedLlm {
  readonly llm: LlmService
  /** Resolves once the model is inside its first `chat`. */
  readonly pendingCall: Promise<void>
  /** End the gate with the given reply; a later call blocks again. */
  release(reply?: string): void
  /**
   * Make the *next* model call (one that has not started yet) throw the way a
   * real provider does when its own request is aborted. Tests use it to force
   * `runGraph`'s failure branch after a host abort.
   */
  failNext(): void
}

export function gatedLlm(): GatedLlm {
  let started!: () => void
  const pendingCall = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: (reply: string) => void
  const answer = new Promise<string>((resolve) => {
    release = resolve
  })
  let failNext = false
  return {
    pendingCall,
    release: (reply = 'released') => release(reply),
    failNext: () => {
      failNext = true
    },
    llm: {
      async chat(): Promise<ChatResult> {
        started()
        if (failNext) {
          failNext = false
          throw new Error('provider request aborted')
        }
        const reply = await answer
        return {
          message: { role: 'assistant', content: reply },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    },
  }
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export interface WorkingLlmOptions {
  /**
   * Prompt tokens the provider reports on a turn, as a *per-turn increment*: a
   * real `inputTokens` is the size of the prompt the provider was given, so it
   * grows with the transcript. Turn `n` therefore reports `n * this`.
   *
   * Omitted, the model reports no `usage` at all - the shape that made the
   * budget-node fallback necessary.
   */
  readonly inputTokensPerTurn?: number
  /**
   * Assistant text per child turn, or a function of the turn number. Long text
   * drives the transcript estimate; distinct text makes "the child's last text"
   * a testable fact.
   */
  readonly text?: string | ((turn: number) => string)
  /** Answer of the tool-free report turn. */
  readonly report?: string
  /** Make the report turn throw, the way a provider fails a request. */
  readonly failReport?: boolean
  /** Answer the report turn with empty content instead of text. */
  readonly emptyReport?: boolean
  /** Artificial work time per child turn, in milliseconds. */
  readonly delayMs?: number
  /**
   * Answer with plain text (no tool call) from this turn on, so the child graph
   * *completes*. Used to pit a completion against a budget timer.
   */
  readonly finalAfterTurns?: number
  /** The text of that final answer. */
  readonly finalText?: string
  /**
   * Hold the report turn open until the test releases it, so a cancellation can
   * arrive *while* the report is being written - the window that decides
   * whether a late `cancel()` is honoured.
   */
  readonly gateReport?: boolean
}

export interface WorkingLlm {
  readonly llm: LlmService
  /** Every model call, in order: child turns and the one report turn alike. */
  readonly requests: ChatRequest[]
  /** Only the tool-free report calls; the child's own turns always carry tools. */
  readonly reportRequests: ChatRequest[]
  /** Completed child turns, i.e. calls that produced a tool call. */
  get turns(): number
  /** Resolves once a report turn is in flight; needs `gateReport`. */
  readonly reportStarted: Promise<void>
  /** Let a gated report turn answer; needs `gateReport`. */
  releaseReport(reply?: string): void
}

/**
 * A child model that never stops on its own: every turn emits a tool call, so
 * the loop keeps going until a budget, a cap or a cancel ends it.
 *
 * A call with an empty `tools` array is the report turn - the runner makes it
 * tool-free on purpose - so one model can serve both and the test can count how
 * many reports were asked for. That count is the assertion that separates "the
 * child stopped gracefully and reported" from "the child was cut off".
 */
export function workingLlm(options: WorkingLlmOptions = {}): WorkingLlm {
  const requests: ChatRequest[] = []
  const reportRequests: ChatRequest[] = []
  let turns = 0
  let started!: () => void
  const reportStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: (reply: string) => void
  const released = new Promise<string>((resolve) => {
    release = resolve
  })
  return {
    requests,
    reportRequests,
    reportStarted,
    releaseReport: (reply = 'late report') => release(reply),
    get turns(): number {
      return turns
    },
    llm: {
      async chat(request: ChatRequest): Promise<ChatResult> {
        requests.push(request)
        const isReport = request.tools !== undefined && request.tools.length === 0
        if (isReport) {
          reportRequests.push(request)
          if (options.failReport === true) throw new Error('provider request failed')
          const gated = options.gateReport === true
          if (gated) started()
          const content = gated
            ? await released
            : options.emptyReport === true
              ? ''
              : (options.report ?? 'hand-off report')
          return {
            message: { role: 'assistant', content },
            toolCalls: [],
            stopReason: 'stop',
          }
        }
        if (options.delayMs !== undefined && options.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        }
        turns += 1
        if (options.finalAfterTurns !== undefined && turns >= options.finalAfterTurns) {
          return {
            message: { role: 'assistant', content: options.finalText ?? 'final answer' },
            toolCalls: [],
            stopReason: 'stop',
          }
        }
        const text = typeof options.text === 'function' ? options.text(turns) : (options.text ?? '')
        return {
          message: { role: 'assistant', content: text },
          toolCalls: [{ id: `call_${String(turns)}`, name: 'read', arguments: {} }],
          stopReason: 'tool_calls',
          ...(options.inputTokensPerTurn === undefined
            ? {}
            : {
                usage: {
                  inputTokens: options.inputTokensPerTurn * turns,
                  outputTokens: 10,
                },
              }),
        }
      },
    },
  }
}
