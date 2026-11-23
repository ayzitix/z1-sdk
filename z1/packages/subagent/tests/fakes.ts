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

  return {
    events,
    runs,
    updates,

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

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
