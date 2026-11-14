import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalJson,
  graphDigest,
  parseGraph,
  validateGraph,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
} from '@z1/graph'
import {
  parsePortValue,
  type ApprovalDecision,
  type ApprovalRequest,
  type AutonomyPolicy,
  type Json,
  type NodeContext,
  type NodeDefinition,
  type NodeOutputs,
  type SubgraphRunOptions,
} from '@z1/node'
import { RunFailure } from './errors.ts'
import { MemoryJournal } from './journal.ts'
import { withLlmCallContext, type LlmCallContext } from './llm-context.ts'
import type { Journal, RunEvent, RunOptions, RunResult, RuntimeServices } from './types.ts'

/** State replayed from the journal when `RunOptions.resume` is set. */
interface ResumeState {
  /** path -> validated outputs of a previously completed node. */
  readonly completed: Map<string, Record<string, Json>>
  /** path -> a decision already recorded for an approval request. */
  readonly decisions: Map<string, ApprovalDecision>
  /** path -> a request that was journaled but never decided. */
  readonly pending: Map<string, ApprovalRequest>
}

/** Shared by every nested graph of one `runGraph` call. */
interface RunContext {
  readonly runId: string
  readonly services: RuntimeServices
  readonly journal: Journal
  readonly cache: Map<string, Record<string, Json>>
  readonly resume: ResumeState
}

function emptyResumeState(): ResumeState {
  return { completed: new Map(), decisions: new Map(), pending: new Map() }
}

type ResumeLoad =
  | {
      readonly state: ResumeState
      /** The run seed recorded in `run.started`; `null` when the run had none. */
      readonly input: Json
      readonly inputDigest: string
    }
  | { readonly error: string }

/** Digest of the run seed: a resume must present exactly the same input. */
function digestInput(input: Json): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex')
}

/**
 * Rebuild the resume view for `runId`. A resume is only safe against the same
 * graph: the digest in `run.started` is the contract that node ids and configs
 * still mean what the journal says they mean.
 */
function loadResumeState(
  journal: Journal,
  runId: string,
  graph: GraphDocument,
): ResumeLoad {
  const events = journal.read(runId)
  const started = events.find((event) => event.type === 'run.started')
  if (started === undefined) {
    return {
      error: new RunFailure(
        'RESUME_MISMATCH',
        `journal has no run.started event for run "${runId}"`,
      ).message,
    }
  }
  const digest = graphDigest(graph)
  if (started.graphDigest !== digest) {
    return {
      error: new RunFailure(
        'RESUME_MISMATCH',
        `graph digest ${digest} does not match journal digest ${started.graphDigest} for run "${runId}"`,
      ).message,
    }
  }

  const state = emptyResumeState()
  for (const event of events) {
    switch (event.type) {
      case 'node.completed':
        state.completed.set(event.path, event.outputs)
        break
      case 'approval.requested':
        state.pending.set(event.path, event.request)
        break
      case 'approval.decided':
        state.decisions.set(event.path, event.decision)
        // A later request for the same path starts a fresh approval cycle.
        state.pending.delete(event.path)
        break
      default:
        break
    }
  }
  return { state, input: started.input ?? null, inputDigest: started.inputDigest }
}

interface ResolvedInputs {
  readonly values: Record<string, Json>
  readonly missing: readonly string[]
  /** True when the port `waitFor` contract is satisfied. */
  readonly ready: boolean
}

type NodeOutcome =
  | { kind: 'completed'; outputs: Record<string, Json>; attempt: number }
  | { kind: 'cached'; outputs: Record<string, Json> }
  | { kind: 'failed'; error: RunFailure; attempt: number }
  | { kind: 'suspended'; path: string; request: ApprovalRequest }
  | { kind: 'cancelled' }

type AttemptOutcome =
  | { kind: 'ok'; outputs: NodeOutputs }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

const DEFAULT_TIMEOUT_MS = 120_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function deliver(context: RunContext, event: RunEvent): Promise<void> {
  // Stream chunks are high-volume observation data; only the live listener sees them.
  if (event.type !== 'node.stream') await context.journal.append(event)
  context.services.onEvent?.(event)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(signal?.aborted !== true)
  if (isAborted(signal)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Race a node execution against its timeout and the run signal. The node gets a
 * combined signal so it can stop cooperating work early, but the race itself
 * still settles even when the node ignores it.
 */
function executeAttempt(
  definition: NodeDefinition<unknown>,
  ctx: NodeContext<unknown>,
  scope: LlmCallContext,
  controller: AbortController,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: AttemptOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }

    timer = setTimeout(() => {
      finish({ kind: 'timeout' })
      controller.abort()
    }, timeoutMs)

    if (signal.aborted) {
      finish({ kind: 'cancelled' })
      return
    }
    signal.addEventListener('abort', () => finish({ kind: 'cancelled' }), { once: true })

    // The recording decorator lives on the ambient service, so the path and
    // attempt reach it as an async-local scope instead of a node argument.
    const execution = Promise.resolve().then(() =>
      withLlmCallContext(scope, () => definition.execute(ctx)),
    )
    void execution.then(
      (outputs) => finish({ kind: 'ok', outputs }),
      (error: unknown) => finish({ kind: 'error', error }),
    )
  })
}

type ApprovalOutcome =
  | { kind: 'decision'; decision: ApprovalDecision }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: unknown }

/**
 * Ask for approval, racing the request against `policy.timeoutMs` and the run
 * signal. The promise settles exactly once, so a late decision after a timeout
 * or abort is ignored.
 */
function requestApproval(
  services: RuntimeServices,
  request: ApprovalRequest,
  context: { runId: string; nodeId: string },
  policy: AutonomyPolicy,
  signal: AbortSignal | undefined,
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function onAbort(): void {
      finish({ kind: 'cancelled' })
    }

    const finish = (outcome: ApprovalOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    if (signal?.aborted === true) {
      finish({ kind: 'cancelled' })
      return
    }

    if (policy.timeoutMs !== undefined) {
      timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, policy.timeoutMs))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    Promise.resolve()
      .then(() => services.approval.request(request, context))
      .then(
        (decision) => finish({ kind: 'decision', decision }),
        (error: unknown) => finish({ kind: 'error', error }),
      )
  })
}

function cacheKey(
  node: GraphNode,
  path: string,
  config: unknown,
  inputs: Record<string, Json>,
  input: Json,
): string {
  // `input` is `ctx.input`: root nodes (e.g. `z1.core.input` inside a loop
  // body) receive their value there rather than through connected ports, so it
  // must be part of the key or iterations would collide.
  //
  // `path` is part of the key because identical arguments at different
  // positions are different executions: two `flow.map` items, or two tool
  // nodes with the same arguments, must not collapse into one side effect.
  const payload = {
    type: node.type,
    version: node.version,
    config,
    inputs,
    input,
    path,
  }
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

function validateOutputs(
  definition: NodeDefinition<unknown>,
  raw: NodeOutputs,
): Record<string, Json> {
  const outputs: Record<string, Json> = {}
  let trueFlows = 0

  for (const port of definition.outputs) {
    const value = raw[port.id]
    if (value === undefined) continue
    let parsed: unknown
    try {
      parsed = parsePortValue(port, value)
    } catch (error) {
      throw new RunFailure(
        'INVALID_OUTPUT',
        `node "${definition.id}" port "${port.id}": ${errorMessage(error)}`,
      )
    }
    if (port.kind === 'flow' && parsed === true) trueFlows += 1
    outputs[port.id] = parsed as Json
  }

  if (trueFlows > 1) {
    throw new RunFailure(
      'INVALID_OUTPUT',
      `node "${definition.id}" returned ${trueFlows} true flow outputs; at most one may run`,
    )
  }

  return outputs
}

interface NodeRunInput {
  readonly node: GraphNode
  readonly definition: NodeDefinition<unknown>
  readonly config: unknown
  readonly inputs: Record<string, Json>
  readonly path: string
  readonly isRoot: boolean
  readonly options: RunOptions
  readonly context: RunContext
}

function makeContext(input: NodeRunInput, signal: AbortSignal, attempt: number): NodeContext<unknown> {
  const { node, config, inputs, path, isRoot, options, context } = input
  const { runId, services, journal } = context
  const nodeInput: Json = isRoot ? (options.input ?? null) : inputs

  return {
    runId,
    nodeId: node.id,
    path,
    attempt,
    input: nodeInput,
    config,
    signal,
    log: (level, message, data) => {
      services.onLog?.({
        runId,
        nodeId: node.id,
        path,
        level,
        message,
        ...(data !== undefined ? { data } : {}),
      })
    },
    emit: (port, chunk) => {
      if (signal.aborted) return
      services.onEvent?.({
        type: 'node.stream',
        runId,
        nodeId: node.id,
        path,
        port,
        chunk,
      })
    },
    llm: {
      chat: (request, onDelta) => services.llm.chat(request, onDelta),
    },
    tools: {
      call: (name, args) => services.tools.call(name, args),
      list: () => services.tools.list(),
    },
    fs: {
      read: (filePath) => services.fs.read(filePath),
      write: (filePath, data) => services.fs.write(filePath, data),
    },
    artifacts: {
      put: (data, mime) => services.artifacts.put(data, mime),
      get: (hash) => services.artifacts.get(hash),
    },
    approval: {
      request: (request) => services.approval.request(request, { runId, nodeId: node.id }),
    },
    ...(services.memory !== undefined ? { memory: services.memory } : {}),
    runSubgraph: async (subgraph: SubgraphRunOptions) => {
      if (signal.aborted) throw new RunFailure('CANCELLED', 'run cancelled before subgraph')
      const nestedOptions: RunOptions = {
        graph: parseGraph(subgraph.graph),
        registry: options.registry,
        services: options.services,
        runId,
        journal,
        pathPrefix:
          subgraph.label === undefined ? `${path}/` : `${path}/${subgraph.label}/`,
        ...(subgraph.input !== undefined ? { input: subgraph.input } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.suspendOnApproval !== undefined
          ? { suspendOnApproval: options.suspendOnApproval }
          : {}),
      }
      const result = await executeRun(nestedOptions, context)
      if (result.status === 'cancelled') {
        throw new RunFailure('CANCELLED', 'nested run cancelled')
      }
      if (result.status === 'failed') {
        throw new RunFailure('NODE_FAILED', result.error ?? 'nested run failed')
      }
      if (result.status === 'suspended') {
        // A nested graph cannot own `run.suspended`; failing loudly beats
        // returning partial outputs as if the subgraph had completed.
        throw new RunFailure(
          'NODE_FAILED',
          `nested run suspended on approval at ${result.pendingApproval?.path ?? 'unknown path'}`,
        )
      }
      return { outputs: result.outputs }
    },
  }
}

function declaredFlowPorts(definition: NodeDefinition<unknown>): readonly string[] {
  return definition.outputs.filter((port) => port.kind === 'flow').map((port) => port.id)
}

async function runNode(input: NodeRunInput): Promise<NodeOutcome> {
  const { definition, config, inputs, path, options, context } = input

  if (isAborted(options.signal)) return { kind: 'cancelled' }

  const nodeInput: Json = input.isRoot ? (options.input ?? null) : inputs
  const policy: AutonomyPolicy = input.node.autonomy ?? definition.autonomy ?? { mode: 'auto' }

  // Deny is a property of the node instance, not of its outputs: it must reject
  // before the cache can hand back a value produced by an identical sibling.
  if (policy.mode === 'deny') {
    return {
      kind: 'failed',
      attempt: 1,
      error: new RunFailure(
        'AUTONOMY_DENIED',
        policy.reason ?? `node "${input.node.id}" is not allowed to run`,
      ),
    }
  }

  const cacheable = definition.cacheable !== false
  const key = cacheable ? cacheKey(input.node, path, config, inputs, nodeInput) : undefined
  if (key !== undefined) {
    const cached = context.cache.get(key)
    // `ask` intentionally skips re-approval on a hit: the cached output was
    // already produced under an approved execution.
    if (cached !== undefined) return { kind: 'cached', outputs: cached }
  }

  if (policy.mode === 'ask') {
    const decided = context.resume.decisions.get(path)
    if (decided === 'cancelled') return { kind: 'cancelled' }
    if (decided === 'rejected') {
      return {
        kind: 'failed',
        attempt: 1,
        error: new RunFailure(
          'APPROVAL_REJECTED',
          `node "${input.node.id}" was rejected by approval`,
        ),
      }
    }

    // `allowed-once` from the journal proceeds without asking again.
    if (decided === undefined) {
      // A resumed run reuses the journaled request so the same action and
      // target are shown and decided, never a freshly derived one.
      const pending = context.resume.pending.get(path)
      const request: ApprovalRequest = pending ?? {
        action: 'node.execute',
        target: definition.id,
        reason: policy.reason ?? `node "${input.node.id}" requires approval`,
        preview: input.node.config,
      }

      if (pending === undefined) {
        await deliver(context, {
          type: 'approval.requested',
          runId: context.runId,
          nodeId: input.node.id,
          path,
          request,
        })
      }

      if (options.suspendOnApproval === true) {
        return { kind: 'suspended', path, request }
      }

      const outcome = await requestApproval(
        context.services,
        request,
        { runId: context.runId, nodeId: input.node.id },
        policy,
        options.signal,
      )

      if (outcome.kind === 'decision') {
        await deliver(context, {
          type: 'approval.decided',
          runId: context.runId,
          nodeId: input.node.id,
          path,
          decision: outcome.decision,
        })
      }

      if (outcome.kind === 'error') {
        return {
          kind: 'failed',
          attempt: 1,
          error: new RunFailure(
            'NODE_FAILED',
            `approval request for node "${input.node.id}" failed: ${errorMessage(outcome.error)}`,
          ),
        }
      }
      if (outcome.kind === 'cancelled') return { kind: 'cancelled' }
      if (outcome.kind === 'timeout') {
        if (policy.onTimeout !== 'approve') {
          return {
            kind: 'failed',
            attempt: 1,
            error: new RunFailure(
              'APPROVAL_REJECTED',
              `approval for node "${input.node.id}" timed out after ${policy.timeoutMs ?? 0}ms`,
            ),
          }
        }
        // `onTimeout: 'approve'` is a deliberate allowed-once.
      } else {
        if (outcome.decision === 'cancelled') return { kind: 'cancelled' }
        if (outcome.decision === 'rejected') {
          return {
            kind: 'failed',
            attempt: 1,
            error: new RunFailure(
              'APPROVAL_REJECTED',
              `node "${input.node.id}" was rejected by approval`,
            ),
          }
        }
      }
      if (isAborted(options.signal)) return { kind: 'cancelled' }
    }
  }

  let attempt = 1
  while (true) {
    if (isAborted(options.signal)) return { kind: 'cancelled' }

    const startedAt = Date.now()
    await deliver(context, {
      type: 'node.started',
      runId: context.runId,
      nodeId: input.node.id,
      path,
      attempt,
      at: startedAt,
    })

    const controller = new AbortController()
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal])
    const ctx = makeContext(input, signal, attempt)
    const outcome = await executeAttempt(
      definition,
      ctx,
      { runId: context.runId, nodeId: input.node.id, path, attempt },
      controller,
      signal,
      definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )

    if (isAborted(options.signal)) return { kind: 'cancelled' }
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' }

    if (outcome.kind === 'timeout') {
      return {
        kind: 'failed',
        attempt,
        error: new RunFailure(
          'TIMEOUT',
          `node "${input.node.id}" exceeded ${definition.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        ),
      }
    }

    if (outcome.kind === 'error') {
      const retry = definition.retry
      if (retry !== undefined && attempt <= retry.attempts) {
        const waited = await sleep(retry.backoffMs * attempt, options.signal)
        if (!waited) return { kind: 'cancelled' }
        attempt += 1
        continue
      }
      return {
        kind: 'failed',
        attempt,
        error: new RunFailure(
          'NODE_FAILED',
          `node "${input.node.id}" failed: ${errorMessage(outcome.error)}`,
        ),
      }
    }

    let outputs: Record<string, Json>
    try {
      outputs = validateOutputs(definition, outcome.outputs)
    } catch (error) {
      const failure =
        error instanceof RunFailure
          ? error
          : new RunFailure('INVALID_OUTPUT', errorMessage(error))
      return { kind: 'failed', attempt, error: failure }
    }

    await deliver(context, {
      type: 'node.completed',
      runId: context.runId,
      nodeId: input.node.id,
      path,
      attempt,
      durationMs: Date.now() - startedAt,
      at: Date.now(),
      outputs,
    })

    if (key !== undefined) context.cache.set(key, outputs)
    return { kind: 'completed', outputs, attempt }
  }
}

async function executeRun(options: RunOptions, context: RunContext): Promise<RunResult> {
  const { graph, registry, signal } = options
  const { runId } = context
  // Nested graphs share the parent run id; emitting run.* from them would make
  // one trace report several completions for the same run.
  const nested = (options.pathPrefix ?? '') !== ''
  const deliverRun = async (event: RunEvent): Promise<void> => {
    if (!nested) await deliver(context, event)
  }

  const issues = validateGraph(graph, registry)
  if (issues.length > 0) {
    const codes = [...new Set(issues.map((issue) => issue.code))].join(', ')
    const error = `invalid graph: ${codes}`
    await deliverRun({ type: 'run.failed', runId, at: Date.now(), error })
    return { runId, status: 'failed', outputs: {}, error }
  }

  if (options.resume === true) {
    // The journal already carries the original `run.started`; a resume is a
    // continuation of that run, not a second start.
    await deliverRun({ type: 'run.resumed', runId, at: Date.now() })
  } else {
    const seed: Json = options.input ?? null
    await deliverRun({
      type: 'run.started',
      runId,
      graphId: graph.id,
      graphDigest: graphDigest(graph),
      input: seed,
      inputDigest: digestInput(seed),
      at: Date.now(),
    })
  }

  if (isAborted(signal)) {
    await deliverRun({ type: 'run.cancelled', runId, at: Date.now() })
    return { runId, status: 'cancelled', outputs: {} }
  }

  const ordered = [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))
  const incomingData = new Map<string, GraphEdge[]>()
  const incomingFlow = new Map<string, GraphEdge[]>()
  const outgoingFlow = new Map<string, GraphEdge[]>()
  const rootIds = new Set<string>()

  for (const node of ordered) {
    incomingData.set(node.id, [])
    incomingFlow.set(node.id, [])
    outgoingFlow.set(node.id, [])
    rootIds.add(node.id)
  }
  for (const edge of graph.edges) {
    if (edge.kind === 'data') incomingData.get(edge.to.node)?.push(edge)
    else {
      incomingFlow.get(edge.to.node)?.push(edge)
      outgoingFlow.get(edge.from.node)?.push(edge)
    }
    rootIds.delete(edge.to.node)
  }

  const definitions = new Map<string, NodeDefinition<unknown>>()
  for (const node of ordered) {
    const definition = registry.get(node.type, node.version)
    // validateGraph already rejects unknown types; this keeps the executor total.
    if (definition === undefined) {
      const error = new RunFailure('NODE_FAILED', `unknown node type "${node.type}"`).message
      await deliverRun({ type: 'run.failed', runId, at: Date.now(), error })
      return { runId, status: 'failed', outputs: {}, error }
    }
    definitions.set(node.id, definition)
  }

  const executed = new Set<string>()
  const outputValues = new Map<string, Record<string, Json>>()
  const pendingFlow = new Set<string>()
  const outputs: Record<string, Json> = {}
  let outputExecuted = false

  /**
   * `waitFor: 'all'` ports must all resolve; `'any'` ports form a single group
   * that only needs one resolved value. A node whose connected inputs are all
   * `'any'` runs on the first arrival.
   */
  const resolveInputs = (node: GraphNode): ResolvedInputs => {
    const values: Record<string, Json> = {}
    const missing: string[] = []
    const definition = definitions.get(node.id)
    let anyConnected = 0
    let anyResolved = 0
    let allUnresolved = false

    for (const edge of incomingData.get(node.id) ?? []) {
      const port = definition?.inputs.find(
        (candidate) => candidate.kind === 'data' && candidate.id === edge.to.port,
      )
      const waitFor = port !== undefined && port.kind === 'data' ? (port.waitFor ?? 'all') : 'all'
      if (waitFor === 'any') anyConnected += 1

      const source = outputValues.get(edge.from.node)
      const value = source === undefined ? undefined : source[edge.from.port]
      if (value === undefined) {
        missing.push(edge.to.port)
        if (waitFor === 'all') allUnresolved = true
        continue
      }
      values[edge.to.port] = value
      if (waitFor === 'any') anyResolved += 1
    }

    // An empty `any` group imposes no condition; a non-empty one needs a hit.
    const anySatisfied = anyConnected === 0 || anyResolved > 0
    return { values, missing, ready: !allUnresolved && anySatisfied }
  }

  const isRunnable = (node: GraphNode): boolean => {
    if (executed.has(node.id)) return false
    if (!resolveInputs(node).ready) return false
    const needsFlow = (incomingFlow.get(node.id)?.length ?? 0) > 0
    if (needsFlow && !pendingFlow.has(node.id)) return false
    return true
  }

  const propagateFlow = (
    node: GraphNode,
    definition: NodeDefinition<unknown>,
    result: Record<string, Json>,
  ): void => {
    // SPEC §6.3: a node that declares no flow outputs propagates along every
    // outgoing flow edge. There is no exception for `core.output` — a custom
    // definition of it may declare a flow port and sit mid-spine.
    const edges = outgoingFlow.get(node.id) ?? []
    const flowPorts = declaredFlowPorts(definition)

    if (flowPorts.length === 0) {
      for (const edge of edges) pendingFlow.add(edge.to.node)
      return
    }

    const selected = flowPorts.filter((portId) => result[portId] === true)
    const chosen = selected[0]
    if (chosen === undefined) return
    for (const edge of edges) {
      if (edge.from.port === chosen) pendingFlow.add(edge.to.node)
    }
  }

  const failNode = async (
    node: GraphNode,
    path: string,
    attempt: number,
    error: RunFailure,
  ): Promise<RunResult> => {
    await deliver(context, {
      type: 'node.failed',
      runId,
      nodeId: node.id,
      path,
      attempt,
      error: error.message,
      at: Date.now(),
    })
    await deliverRun({
      type: 'run.failed',
      runId,
      at: Date.now(),
      error: error.message,
    })
    return { runId, status: 'failed', outputs, error: error.message }
  }

  while (true) {
    if (isAborted(signal)) {
      await deliverRun({ type: 'run.cancelled', runId, at: Date.now() })
      return { runId, status: 'cancelled', outputs }
    }

    const candidates = ordered.filter(isRunnable)
    // Roots are the intended entry points; running them before data-ready
    // descendants keeps traces deterministic across graph shapes.
    const node = candidates.find((entry) => rootIds.has(entry.id)) ?? candidates[0]

    if (node === undefined) {
      const idle = ordered.filter((entry) => !executed.has(entry.id))
      // No output node is not a deadlock when the graph simply finished: every
      // node ran, so return whatever was accumulated.
      if (outputExecuted || idle.length === 0) {
        await deliverRun({
          type: 'run.completed',
          runId,
          at: Date.now(),
          outputs,
        })
        return { runId, status: 'completed', outputs }
      }

      const missingData: string[] = []
      const missingFlow: string[] = []
      for (const entry of idle) {
        for (const port of resolveInputs(entry).missing) missingData.push(`${entry.id}.${port}`)
        if ((incomingFlow.get(entry.id)?.length ?? 0) > 0 && !pendingFlow.has(entry.id)) {
          missingFlow.push(entry.id)
        }
      }
      const details = [`idle nodes: ${idle.map((entry) => entry.id).join(', ')}`]
      if (missingData.length > 0) details.push(`missing data ports: ${missingData.join(', ')}`)
      if (missingFlow.length > 0) details.push(`missing flow tokens: ${missingFlow.join(', ')}`)
      const error = new RunFailure('DEADLOCK', details.join('; '))
      await deliverRun({ type: 'run.failed', runId, at: Date.now(), error: error.message })
      return { runId, status: 'failed', outputs, error: error.message }
    }

    const definition = definitions.get(node.id)
    if (definition === undefined) {
      const error = new RunFailure('NODE_FAILED', `unknown node type "${node.type}"`)
      await failNode(node, `${options.pathPrefix ?? ''}${node.id}`, 1, error)
      return { runId, status: 'failed', outputs, error: error.message }
    }

    const configResult = definition.config.safeParse(node.config)
    const path = `${options.pathPrefix ?? ''}${node.id}`
    if (!configResult.success) {
      const error = new RunFailure(
        'NODE_FAILED',
        `invalid config for node "${node.id}": ${configResult.error.message}`,
      )
      return await failNode(node, path, 1, error)
    }

    const resolved = resolveInputs(node)
    pendingFlow.delete(node.id)

    // A node completed by an earlier attempt of this run is replayed, never
    // re-executed: its stored outputs are the authoritative result.
    const restored = context.resume.completed.get(path)
    if (restored !== undefined) {
      executed.add(node.id)
      outputValues.set(node.id, restored)
      await deliver(context, {
        type: 'node.cached',
        runId,
        nodeId: node.id,
        path,
        at: Date.now(),
        reason: 'resume',
      })

      if (node.type === 'z1.core.output') {
        outputExecuted = true
        const config = isRecord(configResult.data) ? configResult.data : {}
        const port = typeof config['port'] === 'string' ? config['port'] : 'output'
        const value = resolved.values['value']
        if (value !== undefined) outputs[port] = value
      }
      // Replay must advance the flow exactly like the first execution did,
      // including an output node that sits in the middle of a spine.
      propagateFlow(node, definition, restored)
      continue
    }

    const outcome = await runNode({
      node,
      definition,
      config: configResult.data,
      inputs: resolved.values,
      path,
      isRoot: rootIds.has(node.id),
      options,
      context,
    })

    if (outcome.kind === 'suspended') {
      await deliverRun({ type: 'run.suspended', runId, at: Date.now(), path: outcome.path })
      return {
        runId,
        status: 'suspended',
        outputs,
        pendingApproval: { path: outcome.path, request: outcome.request },
      }
    }

    if (outcome.kind === 'cancelled') {
      await deliverRun({ type: 'run.cancelled', runId, at: Date.now() })
      return { runId, status: 'cancelled', outputs }
    }

    if (outcome.kind === 'failed') {
      return await failNode(node, path, outcome.attempt, outcome.error)
    }

    executed.add(node.id)
    outputValues.set(node.id, outcome.outputs)

    if (outcome.kind === 'cached') {
      await deliver(context, {
        type: 'node.cached',
        runId,
        nodeId: node.id,
        path,
        at: Date.now(),
      })
    }

    if (node.type === 'z1.core.output') {
      outputExecuted = true
      const config = isRecord(configResult.data) ? configResult.data : {}
      const port = typeof config['port'] === 'string' ? config['port'] : 'output'
      const value = resolved.values['value']
      if (value !== undefined) outputs[port] = value
    }
    propagateFlow(node, definition, outcome.outputs)
  }
}

export async function runGraph(options: RunOptions): Promise<RunResult> {
  const runId = options.runId ?? `run_${randomUUID()}`
  const journal = options.journal ?? new MemoryJournal()
  let effective = options
  let resume = emptyResumeState()
  if (options.resume === true) {
    const loaded = loadResumeState(journal, runId, options.graph)
    if ('error' in loaded) {
      return { runId, status: 'failed', outputs: {}, error: loaded.error }
    }
    resume = loaded.state
    if (options.input !== undefined) {
      // A resumed run must be the same run: a different seed would replay
      // stored outputs that were produced from other inputs, so refuse rather
      // than silently mixing two runs in one journal.
      if (digestInput(options.input) !== loaded.inputDigest) {
        const error = new RunFailure(
          'RESUME_MISMATCH',
          'run input differs from the journaled input',
        ).message
        const event: RunEvent = { type: 'run.failed', runId, at: Date.now(), error }
        await journal.append(event)
        options.services.onEvent?.(event)
        return { runId, status: 'failed', outputs: {}, error }
      }
    } else {
      // No input supplied: re-executed nodes see the seed the run started with.
      effective = { ...options, input: loaded.input }
    }
  }
  const context: RunContext = {
    runId,
    services: options.services,
    journal,
    cache: new Map(),
    resume,
  }
  return executeRun(effective, context)
}
