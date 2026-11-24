/**
 * Local headless `z1` server: JSON-RPC 2.0 over one WebSocket per client.
 *
 * A connection is a session, not a run: runs are owned by the server and keyed
 * by id, so a client may start a run, disconnect, and reattach with
 * `run.subscribe`. Every run is journaled in SQLite before its events are
 * announced, so the live stream and `run.get` never disagree.
 *
 * @module @z1/server
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'

import { createRuntime, loadRuntimeConfig, type RunHandle } from '@z1/bootstrap'
import {
  GraphParseError,
  graphDigest,
  parseGraph,
  validateGraphTree,
  type GraphDocument,
  type GraphParseIssue,
  type ValidationIssue,
} from '@z1/graph'
import type { RunRecord, RunStatus } from '@z1/journal'
import type { ApprovalDecision, Json } from '@z1/node'
import {
  APP_ERRORS,
  JsonRpcPeer,
  appFault,
  assertEnum,
  assertParams,
  describeNodes,
  invalidParams,
  runNotFound,
  type ApprovalAbandonedReason,
  type MethodMap,
  type RemoteMethodName,
  type RunReply,
  type SequencedEvent,
} from '@z1/protocol'
import {
  runGraph,
  type ApprovalService,
  type ArtifactService,
  type RunEvent,
  type RunResult,
} from '@z1/runtime'
import { WebSocketServer, type WebSocket } from 'ws'

import { GraphStore } from './graphs.ts'
import { moduleFault, moduleSummary, proposalSummary } from './modules.ts'
import { SocketTransport } from './socket-transport.ts'
import { createStaticHandler } from './static.ts'
import { TeeJournal } from './tee-journal.ts'
import type { ServerOptions, Z1Server } from './types.ts'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000
const WS_PATH = '/ws'
/** Random token length in bytes; 16 bytes is 32 hex characters. */
const TOKEN_BYTES = 16

/** One client socket plus the approvals it is expected to answer. */
interface Connection {
  readonly id: string
  readonly transport: SocketTransport
  readonly peer: JsonRpcPeer
  readonly approvals: Set<string>
}

/** A run this server owns, kept after it settles so watchers can reattach. */
interface RunState {
  readonly runId: string
  readonly controller: AbortController
  status: RunStatus
  readonly subscribers: Set<Connection>
  settled?: Promise<void>
}

/** An `approval/request` waiting for the initiating client. */
interface PendingApproval {
  readonly approvalId: string
  readonly runId: string
  readonly nodeId: string
  readonly path: string
  readonly connectionId: string
  readonly decide: (decision: ApprovalDecision) => void
  /** Drop the entry without deciding: the run is gone, nothing can land. */
  readonly abandon: (reason: ApprovalAbandonedReason) => void
}

interface ResolvedConfig {
  readonly host: string
  readonly port: number
  readonly token: string
  readonly approvalTimeoutMs: number
  readonly staticDir?: string
}

interface StartArgs {
  readonly runId: string
  readonly graph: GraphDocument
  readonly resume: boolean
  readonly input?: Json
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stringParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw invalidParams(`param "${field}" must be a non-empty string`, { param: field })
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return stringParam(value, field)
}

function optionalSeq(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidParams(`param "${field}" must be a non-negative integer`, { param: field })
  }
  return value
}

/** Decisions a client may answer `approval/request` with; `cancelled` is ours. */
const APPROVAL_REPLY_DECISIONS = ['allowed-once', 'rejected'] as const

/**
 * How many `approval/request` frames one approval may send.
 *
 * A client that answers unusably is asked again, because a result has no reply
 * channel of its own: re-asking is the only refusal a shipped peer can see. The
 * count is bounded so a client that answers garbage forever cannot turn one
 * blocked run into an unbounded stream of requests.
 */
const APPROVAL_REPLY_ATTEMPTS = 3

/** How many settled approval ids are remembered for a late `approval.respond`. */
const ABANDONED_APPROVALS_KEPT = 256

/**
 * The one refusal for an approval the caller may not see.
 *
 * Deliberately identical to the answer for an id nobody ever issued: a client
 * that guesses an id must not learn whether it exists, belongs to another
 * connection, or has already been decided.
 */
function unknownApproval(approvalId: string): ReturnType<typeof appFault> {
  return appFault(APP_ERRORS.approvalNotFound, `unknown approval: ${approvalId}`, { approvalId })
}

/**
 * The decision an `approval/request` reply carries.
 *
 * A reply is a *result*, not a request, so a malformed one never reaches the
 * peer's own error path. It goes through the same guards as `approval.respond`
 * to keep both answer paths on one contract: a value outside the set must not
 * reach the runtime, where anything but `rejected` counts as allowed.
 */
function approvalReplyDecision(reply: unknown): ApprovalDecision {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) {
    throw invalidParams('an approval/request reply must be an object with a "decision"')
  }
  const decision = (reply as Record<string, unknown>)['decision']
  return assertEnum(decision, APPROVAL_REPLY_DECISIONS, 'decision')
}

/** Parse issues carry zod codes, which the graph validator's union does not cover. */
function parseIssue(issue: GraphParseIssue): ValidationIssue {
  const path = issue.path.map((part) => String(part)).join('.')
  return {
    code: 'invalid-config',
    message: `${path.length > 0 ? path : '<root>'}: ${issue.message}`,
  }
}

function extractToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice('bearer '.length).trim()
  }
  const url = new URL(request.url ?? '/', 'http://localhost')
  return url.searchParams.get('token') ?? undefined
}

/** Constant-time compare; a length mismatch cannot leak through `timingSafeEqual`. */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided === '') return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(provided, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function handle<M extends RemoteMethodName>(
  connection: Connection,
  method: M,
  handler: (
    params: unknown,
  ) => MethodMap[M]['result'] | Promise<MethodMap[M]['result']>,
): void {
  connection.peer.onRequest(method, (params) => handler(params))
}

export async function startServer(options: ServerOptions): Promise<Z1Server> {
  const env = options.env ?? process.env
  const config: ResolvedConfig = {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? 0,
    token: options.token ?? randomBytes(TOKEN_BYTES).toString('hex'),
    approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
  }

  // Paths and `live` come from the same config file/environment/vars the CLI
  // uses; explicit options are overrides only.
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: process.cwd(),
      env,
      overrides: {
        ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
        ...(options.graphsPath === undefined ? {} : { graphsPath: options.graphsPath }),
        ...(options.modulesPath === undefined ? {} : { modulesPath: options.modulesPath }),
        ...(options.live === undefined ? {} : { live: options.live }),
      },
    }),
  )

  const modules = runtime.modules
  const journal = runtime.journal
  const graphs = new GraphStore(runtime.config.graphsPath)
  // Created before the socket is reachable so the first `graph.save` cannot fail
  // on a missing directory.
  try {
    await graphs.init()
  } catch (error) {
    await runtime.close()
    throw error
  }
  const runs = new Map<string, RunState>()
  const approvals = new Map<string, PendingApproval>()
  /**
   * Approval ids whose run stopped waiting, newest last, so a late
   * `approval.respond` gets "not waiting" rather than "unknown approval". The
   * owning connection is kept with it: only that connection is told the run
   * moved on, and anyone else keeps seeing an id that does not exist.
   * Bounded: a long-lived server must not remember every decision forever.
   */
  const abandonedApprovals = new Map<string, { runId: string; connectionId: string }>()
  const connections = new Set<Connection>()

  /** Blobs live in the shared journal, not the per-run mock artifact store. */
  const artifacts: ArtifactService = {
    put: async (data, mime) => journal.putBlob(data, mime),
    get: async (hash) => {
      const blob = journal.getBlob(hash)
      if (blob === undefined) throw new Error(`artifact not found: ${hash}`)
      return blob.bytes
    },
  }

  function publish(runId: string, seq: number, event: RunEvent): void {
    const state = runs.get(runId)
    if (state === undefined) return
    for (const subscriber of state.subscribers) {
      subscriber.peer.notify('run.event', { runId, seq, event })
    }
  }

  /**
   * Last `approval.requested` path per run and node, filled from the tee.
   *
   * The journal replay below is only for a run that began in an earlier server
   * lifetime; a live run never walks its whole trace to answer an approval.
   * Entries are dropped when the run is pruned, so a long-lived server does not
   * accumulate one map per settled run.
   */
  const approvalPaths = new Map<string, Map<string, string>>()

  const tee = new TeeJournal(journal, (runId, seq, event) => {
    if (event.type === 'approval.requested') {
      let paths = approvalPaths.get(runId)
      if (paths === undefined) {
        paths = new Map()
        approvalPaths.set(runId, paths)
      }
      paths.set(event.nodeId, event.path)
    }
    publish(runId, seq, event)
  })

  function readSequenced(runId: string, afterSeq: number | undefined): SequencedEvent[] {
    const start = afterSeq ?? 0
    return journal
      .readAfter(runId, start)
      .map((event, index) => ({ seq: start + index + 1, event }))
  }

  function parseGraphParam(value: unknown): GraphDocument {
    try {
      return parseGraph(value)
    } catch (error) {
      if (error instanceof GraphParseError) {
        throw appFault(APP_ERRORS.graphInvalid, error.message, {
          issues: error.issues.map(parseIssue),
        })
      }
      throw error
    }
  }

  function assertValid(graph: GraphDocument): void {
    const issues = validateGraphTree(graph, runtime.registry)
    if (issues.length === 0) return
    const codes = [...new Set(issues.map((issue) => issue.code))].join(', ')
    throw appFault(APP_ERRORS.graphInvalid, `invalid graph: ${codes}`, { issues })
  }

  /**
   * The runtime calls the approval service with `nodeId` only, while the path
   * is journaled on the `approval.requested` event delivered just before it.
   * Reading it back (rather than caching by runId+nodeId) keeps a loop body
   * that re-enters one node type from losing the previous iteration's path.
   */
  function lastApprovalPath(runId: string, nodeId: string): string {
    const known = approvalPaths.get(runId)?.get(nodeId)
    if (known !== undefined) return known
    // A run resumed from an earlier server process has no tee history here.
    const events = journal.read(runId)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event !== undefined && event.type === 'approval.requested' && event.nodeId === nodeId) {
        return event.path
      }
    }
    return nodeId
  }

  /**
   * The approval gate a run asks through, and how an unusable answer is refused.
   *
   * The server asks with a `approval/request` *request*, so the client answers
   * with a JSON-RPC *result*. A result has no reply channel of its own: no error
   * frame can say "answer again", because the ids of the two directions are
   * separate namespaces. `{id: 2, error: -32602}` sent by the server on the id of
   * its own request is either dropped by the client (an id it is not waiting for)
   * or, worse, matched against an unrelated *outgoing* request the client gave
   * the same number. A bare `-32602` is therefore never a channel.
   *
   * The visible channel is a second request. An unusable answer is followed by a
   * fresh `approval/request` for the same node and path under the same
   * `approvalId`, which the client can answer properly: the repeat *is* the
   * refusal. The run stays `running` throughout, and `approval.respond` keeps
   * working in parallel, so the first usable answer wins. After
   * {@link APPROVAL_REPLY_ATTEMPTS} unusable answers the server stops asking,
   * says so with `approval.abandoned` (a client that only ever saw replies would
   * otherwise wait in silence) and leaves the run to the deadline below: the
   * approval times out like one nobody answered, rather than the server
   * inventing a decision from garbage.
   *
   * An entry also leaves the map when its run stops waiting: cancelled or
   * settled, there is nothing left to decide, and a later `approval.respond`
   * must fail instead of acknowledging a decision that reaches no node.
   */
  function createApprovalService(runId: string, connection: Connection): ApprovalService {
    return {
      request: async (request, context) => {
        const approvalId = `apr_${randomUUID()}`
        const path = lastApprovalPath(runId, context.nodeId)
        const params = { approvalId, runId, nodeId: context.nodeId, path, request }
        const decision = await new Promise<ApprovalDecision>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          let asked = 0
          let announced = false

          function forget(): boolean {
            if (!approvals.delete(approvalId)) return false
            connection.approvals.delete(approvalId)
            if (timer !== undefined) clearTimeout(timer)
            return true
          }
          function decide(settled: ApprovalDecision): void {
            if (forget()) resolve(settled)
          }
          function fail(error: Error): void {
            if (forget()) reject(error)
          }
          /** At most one `approval.abandoned` per approval. */
          function announce(reason: ApprovalAbandonedReason): void {
            if (announced) return
            announced = true
            connection.peer.notify('approval.abandoned', {
              runId,
              approvalId,
              nodeId: context.nodeId,
              path,
              reason,
            })
          }
          function abandon(reason: ApprovalAbandonedReason): void {
            if (!forget()) return
            abandonedApprovals.set(approvalId, { runId, connectionId: connection.id })
            if (abandonedApprovals.size > ABANDONED_APPROVALS_KEPT) {
              const oldest = abandonedApprovals.keys().next().value
              if (oldest !== undefined) abandonedApprovals.delete(oldest)
            }
            announce(reason)
          }

          timer = setTimeout(() => {
            fail(
              new Error(
                `approval ${approvalId} for node "${context.nodeId}" timed out after ${config.approvalTimeoutMs}ms`,
              ),
            )
          }, config.approvalTimeoutMs)
          timer.unref?.()

          approvals.set(approvalId, {
            approvalId,
            runId,
            nodeId: context.nodeId,
            path,
            connectionId: connection.id,
            decide,
            abandon,
          })
          connection.approvals.add(approvalId)

          /** One `approval/request`; an unusable answer re-asks with a fresh id. */
          function ask(): void {
            asked += 1
            void connection.peer.request('approval/request', params).then(
              (reply) => {
                try {
                  decide(approvalReplyDecision(reply))
                } catch {
                  if (asked < APPROVAL_REPLY_ATTEMPTS) ask()
                  else announce('replies-exhausted')
                }
              },
              () => {
                // The request itself failed (socket closed, peer gone): nobody
                // can answer any more, so the run stops instead of waiting out
                // the deadline.
                decide('cancelled')
              },
            )
          }

          ask()
        })
        return decision
      },
    }
  }

  function notifyStatus(state: RunState): void {
    for (const subscriber of state.subscribers) {
      subscriber.peer.notify('run.status', { runId: state.runId, status: state.status })
    }
  }

  /**
   * Drops every approval the run was waiting for.
   *
   * A cancelled or settled run decides nothing more, so the entries go and a
   * late `approval.respond` is refused instead of settling a promise nobody
   * reads. The run's own decision paths already remove their entry through
   * `forget`, so this only touches approvals still pending.
   */
  function abandonRunApprovals(runId: string, reason: ApprovalAbandonedReason): void {
    for (const entry of [...approvals.values()]) {
      if (entry.runId === runId) entry.abandon(reason)
    }
  }

  /**
   * A settled run with no watchers needs no server-side state: its events stay
   * in the journal and `run.subscribe` rebuilds a dormant `RunState` on demand.
   * A running run is never pruned, because its controller is the only cancel.
   */
  function pruneRun(state: RunState): void {
    if (state.status === 'running' || state.subscribers.size > 0) return
    runs.delete(state.runId)
    approvalPaths.delete(state.runId)
  }

  async function runAndSettle(
    state: RunState,
    args: StartArgs,
    connection: Connection,
  ): Promise<RunReply> {
    let handle: RunHandle | undefined
    let result: RunResult | undefined
    let failure: string | undefined
    try {
      // Workers are per run: a module crash must not poison later runs, and an
      // approval from module code must reach the connection that started it.
      handle = await runtime.beginRun({
        // Without the id the runtime cannot attribute a module node's model
        // traffic or its approval to this run: both would resolve to the
        // ambient service and the latest live run.
        runId: state.runId,
        approval: createApprovalService(state.runId, connection),
        moduleApproval: createApprovalService(state.runId, connection),
        artifacts,
      })
      result = await runGraph({
        graph: args.graph,
        registry: handle.registry,
        services: handle.services,
        runId: state.runId,
        signal: state.controller.signal,
        journal: tee,
        resume: args.resume,
        // Approvals are live client requests here, never suspensions.
        suspendOnApproval: false,
        ...(args.input !== undefined ? { input: args.input } : {}),
      })
    } catch (error) {
      failure = errorMessage(error)
    } finally {
      await handle?.dispose()
      // The run is over either way: a decision that arrives now reaches nothing.
      abandonRunApprovals(state.runId, 'run-settled')
    }

    if (result === undefined) {
      const message = failure ?? 'run failed'
      state.status = 'failed'
      journal.updateRun(state.runId, { status: 'failed', updatedAt: Date.now() })
      notifyStatus(state)
      pruneRun(state)
      return { runId: state.runId, status: 'failed', outputs: {}, error: message }
    }

    state.status = result.status
    journal.updateRun(state.runId, { status: result.status, updatedAt: Date.now() })
    notifyStatus(state)
    pruneRun(state)

    const reply: RunReply = {
      runId: state.runId,
      status: result.status,
      outputs: result.outputs,
    }
    if (result.error !== undefined) reply.error = result.error
    if (result.pendingApproval !== undefined) reply.pendingApproval = result.pendingApproval
    return reply
  }

  async function startRun(args: StartArgs, connection: Connection): Promise<RunReply> {
    const previous = runs.get(args.runId)
    if (!args.resume) {
      // A client-chosen id is a claim on a fresh run: reuse would either
      // overwrite the journal row or silently append to someone else's trace.
      if (previous !== undefined || journal.getRun(args.runId) !== undefined) {
        throw appFault(APP_ERRORS.conflict, `run ${args.runId} already exists`, {
          runId: args.runId,
        })
      }
    } else if (previous !== undefined && previous.status === 'running') {
      throw appFault(APP_ERRORS.conflict, `run ${args.runId} is already running`, {
        runId: args.runId,
      })
    }
    if (args.resume) {
      const record = journal.getRun(args.runId)
      // A terminal row is the audit trail of a finished run. Flipping it back
      // to `running` only to record the executor's RESUME_MISMATCH rewrites
      // history for a run that already succeeded, and a pruned `RunState`
      // makes that the first thing a resume does. Refuse before touching it.
      if (
        record !== undefined &&
        (record.status === 'completed' ||
          record.status === 'failed' ||
          record.status === 'cancelled')
      ) {
        throw appFault(APP_ERRORS.conflict, `run ${args.runId} is already ${record.status}`, {
          runId: args.runId,
        })
      }
      journal.updateRun(args.runId, { status: 'running', updatedAt: Date.now() })
    } else {
      const now = Date.now()
      journal.createRun({
        runId: args.runId,
        graphId: args.graph.id,
        graphDigest: graphDigest(args.graph),
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
    }

    const subscribers = new Set<Connection>(previous?.subscribers ?? [])
    subscribers.add(connection)
    const state: RunState = {
      runId: args.runId,
      controller: new AbortController(),
      status: 'running',
      subscribers,
    }
    runs.set(args.runId, state)

    const promise = runAndSettle(state, args, connection)
    // close() waits for this so the journal is never closed under a live run.
    state.settled = promise.then(
      () => undefined,
      () => undefined,
    )
    return await promise
  }

  function registerHandlers(connection: Connection): void {
    handle(connection, 'initialize', () => ({
      serverName: 'z1',
      protocolVersion: '1',
      capabilities: { runs: true, approvals: true, modules: true },
    }))

    handle(connection, 'node.list', () => describeNodes(runtime.registry))

    handle(connection, 'graph.validate', (params) => {
      assertParams(params, ['graph'])
      let issues: ValidationIssue[]
      try {
        issues = [...validateGraphTree(parseGraph(params['graph']), runtime.registry)]
      } catch (error) {
        if (!(error instanceof GraphParseError)) throw error
        issues = error.issues.map(parseIssue)
      }
      return { ok: issues.length === 0, issues }
    })

    handle(connection, 'graph.list', async () => ({ graphs: await graphs.list() }))

    handle(connection, 'graph.get', async (params) => {
      assertParams(params, ['id'])
      return await graphs.get(stringParam(params['id'], 'id'))
    })

    handle(connection, 'graph.save', async (params) => {
      assertParams(params, ['graph'])
      // Structure only: a saved graph may name a node type this server build
      // does not have yet, which is a `graph.validate` concern, not a save one.
      const graph = parseGraphParam(params['graph'])
      const expectedVersion = optionalSeq(params['expectedVersion'], 'expectedVersion')
      return await graphs.save(graph, expectedVersion)
    })

    handle(connection, 'graph.delete', async (params) => {
      assertParams(params, ['id'])
      await graphs.delete(stringParam(params['id'], 'id'))
      return {}
    })

    handle(connection, 'run.start', async (params) => {
      assertParams(params, ['graph'])
      const graph = parseGraphParam(params['graph'])
      assertValid(graph)
      const args: StartArgs = {
        runId: optionalString(params['runId'], 'runId') ?? `run_${randomUUID()}`,
        graph,
        resume: false,
      }
      const input = params['input']
      return await startRun(
        input === undefined ? args : { ...args, input: input as Json },
        connection,
      )
    })

    handle(connection, 'run.resume', async (params) => {
      assertParams(params, ['runId'])
      const runId = stringParam(params['runId'], 'runId')
      const graphParam = params['graph']
      if (graphParam === undefined) {
        // A run record stores the digest, never the graph itself.
        throw invalidParams('run.resume requires the graph being resumed', { param: 'graph' })
      }
      const graph = parseGraphParam(graphParam)
      assertValid(graph)
      if (journal.getRun(runId) === undefined) throw runNotFound(runId)
      const args: StartArgs = { runId, graph, resume: true }
      const input = params['input']
      return await startRun(
        input === undefined ? args : { ...args, input: input as Json },
        connection,
      )
    })

    handle(connection, 'run.cancel', (params) => {
      assertParams(params, ['runId'])
      const runId = stringParam(params['runId'], 'runId')
      const state = runs.get(runId)
      // A settled run keeps its state only while it has a subscriber, so the
      // journal answers for a pruned one. Reading both keeps `run.cancel` from
      // reporting success before the prune and an unknown run after it.
      if (state === undefined) {
        const record = journal.getRun(runId)
        if (record === undefined) throw runNotFound(runId)
        throw appFault(APP_ERRORS.conflict, `run ${runId} is already ${record.status}`, { runId })
      }
      if (state.status !== 'running') {
        throw appFault(APP_ERRORS.conflict, `run ${runId} is already ${state.status}`, { runId })
      }
      state.controller.abort()
      // Cancelling is final for the approval too: the run will not read it.
      abandonRunApprovals(runId, 'run-cancelled')
      return {}
    })

    handle(connection, 'run.list', () => [...journal.listRuns()])

    handle(connection, 'run.get', (params) => {
      assertParams(params, ['runId'])
      const runId = stringParam(params['runId'], 'runId')
      const afterSeq = optionalSeq(params['afterSeq'], 'afterSeq')
      const record: RunRecord | undefined = journal.getRun(runId)
      if (record === undefined) throw runNotFound(runId)
      return { record, events: readSequenced(runId, afterSeq) }
    })

    handle(connection, 'run.subscribe', (params) => {
      assertParams(params, ['runId'])
      const runId = stringParam(params['runId'], 'runId')
      const afterSeq = optionalSeq(params['afterSeq'], 'afterSeq')
      const record = journal.getRun(runId)
      if (record === undefined) throw runNotFound(runId)
      const events = readSequenced(runId, afterSeq)

      let state = runs.get(runId)
      if (state === undefined) {
        // A run from an earlier server lifetime: already settled, so the
        // controller starts aborted and nothing new can be scheduled.
        const controller = new AbortController()
        controller.abort()
        state = { runId, controller, status: record.status, subscribers: new Set() }
        runs.set(runId, state)
      }
      state.subscribers.add(connection)
      return { events }
    })

    handle(connection, 'run.fork', (params) => {
      assertParams(params, ['runId'])
      const runId = stringParam(params['runId'], 'runId')
      if (journal.getRun(runId) === undefined) throw runNotFound(runId)
      const atSeq = optionalSeq(params['atSeq'], 'atSeq')
      const nodePath = optionalString(params['nodePath'], 'nodePath')
      // Fork points live in the run's own numbering (`ownedEvents`), because a
      // prefix inherited from a parent is not this run's to truncate. `run.get`
      // and `run.event` keep merged numbering for cursors; `atSeq` and the
      // returned `forkSeq` are own numbering, like `journal.fork`.
      const owned = journal.ownedEvents(runId)

      let forkSeq: number
      if (nodePath !== undefined) {
        const started = owned.find(
          (item) => item.event.type === 'node.started' && item.event.path === nodePath,
        )
        if (started === undefined) {
          // A path visible in the merged timeline may belong to an ancestor:
          // say so instead of claiming it does not exist.
          const owner = journal
            .read(runId)
            .find((event) => event.type === 'node.started' && event.path === nodePath)?.runId
          throw invalidParams(
            owner === undefined || owner === runId
              ? `no node.started event for path "${nodePath}"`
              : `path "${nodePath}" ran in ancestor run "${owner}"; fork that run instead`,
            { nodePath, ...(owner === undefined ? {} : { ownerRunId: owner }) },
          )
        }
        // The fork happens just before that node ran.
        forkSeq = started.seq - 1
      } else {
        forkSeq = atSeq ?? (owned.length === 0 ? 0 : (owned[owned.length - 1]?.seq ?? 0))
      }

      const newRunId = `run_${randomUUID()}`
      const record = journal.fork(runId, forkSeq, newRunId)
      return { runId: newRunId, parentRunId: record.parentRunId ?? runId, forkSeq }
    })

    handle(connection, 'approval.respond', (params) => {
      assertParams(params, ['approvalId', 'decision'])
      const approvalId = stringParam(params['approvalId'], 'approvalId')
      const decision = assertEnum(
        params['decision'],
        ['allowed-once', 'rejected'] as const,
        'decision',
      )
      const entry = approvals.get(approvalId)
      if (entry === undefined) {
        // A decision for a run that stopped waiting is a different mistake from
        // an id nobody ever issued, and saying which one it is matters to a UI.
        const abandoned = abandonedApprovals.get(approvalId)
        if (abandoned !== undefined && abandoned.connectionId === connection.id) {
          throw appFault(APP_ERRORS.conflict, `run ${abandoned.runId} is not waiting for approval`, {
            approvalId,
            runId: abandoned.runId,
          })
        }
        throw unknownApproval(approvalId)
      }
      // Only the connection the request went to may decide it: a second client
      // that learns the id must not settle a run it did not start. It gets the
      // same answer as a guessed id, so the refusal reveals nothing.
      if (entry.connectionId !== connection.id) throw unknownApproval(approvalId)
      entry.decide(decision)
      return {}
    })

    handle(connection, 'artifact.get', (params) => {
      assertParams(params, ['hash'])
      const hash = stringParam(params['hash'], 'hash')
      const blob = journal.getBlob(hash)
      if (blob === undefined) {
        throw appFault(APP_ERRORS.artifactNotFound, `unknown artifact: ${hash}`, { hash })
      }
      return {
        hash: blob.hash,
        mime: blob.mime,
        base64: Buffer.from(blob.bytes).toString('base64'),
      }
    })

    handle(connection, 'module.list', () => ({
      modules: modules.list().map(moduleSummary),
      proposals: modules.proposals().map(proposalSummary),
    }))

    handle(connection, 'module.propose', (params) => {
      assertParams(params, ['directory'])
      const directory = stringParam(params['directory'], 'directory')
      try {
        return proposalSummary(modules.propose(directory))
      } catch (error) {
        throw moduleFault(error)
      }
    })

    handle(connection, 'module.approve', (params) => {
      assertParams(params, ['moduleId', 'version'])
      const moduleId = stringParam(params['moduleId'], 'moduleId')
      const version = stringParam(params['version'], 'version')
      const futureVersions = params['futureVersions']
      if (futureVersions !== undefined && typeof futureVersions !== 'boolean') {
        throw invalidParams('param "futureVersions" must be a boolean', {
          param: 'futureVersions',
        })
      }
      const proposal = modules
        .proposals()
        .find((candidate) => candidate.manifest.id === moduleId && candidate.manifest.version === version)
      if (proposal === undefined) {
        throw invalidParams(
          `no proposal for "${moduleId}"@${version}; propose it first or pass the exact proposed version`,
          { moduleId, version },
        )
      }
      try {
        modules.approve(moduleId, version, {
          ...(futureVersions !== undefined ? { futureVersions } : {}),
        })
        // Approving makes the new version the active one; a later `node.list`
        // therefore sees different declarations.
        return moduleSummary(modules.activate(moduleId, version))
      } catch (error) {
        throw moduleFault(error)
      }
    })

    handle(connection, 'module.rollback', (params) => {
      assertParams(params, ['moduleId'])
      const moduleId = stringParam(params['moduleId'], 'moduleId')
      try {
        const installed = modules.list().filter((module) => module.manifest.id === moduleId)
        if (installed.length === 0) {
          throw invalidParams(`module "${moduleId}" is not installed`, { moduleId })
        }
        const rolledBack = modules.rollback(moduleId)
        if (rolledBack === undefined) {
          throw invalidParams(`module "${moduleId}" has no earlier version to roll back to`, {
            moduleId,
          })
        }
        return moduleSummary(rolledBack)
      } catch (error) {
        throw moduleFault(error)
      }
    })

    handle(connection, 'module.audit', () => [...modules.audit()])
  }

  function dropConnection(connection: Connection): void {
    connections.delete(connection)
    // A client that goes away cannot approve anything; `cancelled` (rather than
    // an error) makes the run stop cleanly instead of failing a node.
    for (const approvalId of [...connection.approvals]) {
      const entry = approvals.get(approvalId)
      if (entry !== undefined) entry.decide('cancelled')
    }
    for (const state of runs.values()) state.subscribers.delete(connection)
    for (const state of [...runs.values()]) pruneRun(state)
  }

  function onSocket(socket: WebSocket): void {
    const transport = new SocketTransport(socket)
    let connection: Connection | undefined
    // Registered before the peer exists so pending approvals settle as
    // `cancelled` before the peer rejects its outstanding requests.
    transport.onClose(() => {
      if (connection !== undefined) dropConnection(connection)
    })
    // `0` disables the peer timeout: an approval may legitimately wait longer
    // than the default 30s and has its own approvalTimeoutMs deadline.
    const peer = new JsonRpcPeer(transport, { requestTimeoutMs: 0 })
    connection = {
      id: `conn_${randomUUID()}`,
      transport,
      peer,
      approvals: new Set(),
    }
    connections.add(connection)
    registerHandlers(connection)
  }

  const staticHandler =
    config.staticDir === undefined ? undefined : createStaticHandler(config.staticDir)

  const httpServer = createServer((request, response) => {
    const url = request.url ?? '/'
    // The socket endpoint owns this path; serving a page here would mask a
    // client that forgot to upgrade.
    if (url === WS_PATH || url.startsWith(`${WS_PATH}?`)) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('z1 server: connect to the /ws WebSocket endpoint\n')
      return
    }
    if (staticHandler === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('z1 server: connect to the /ws WebSocket endpoint\n')
      return
    }
    void staticHandler(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain' })
      }
      response.end()
    })
  })

  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    verifyClient: (info, done) => {
      const accepted = tokenMatches(config.token, extractToken(info.req))
      // ws writes the 401 itself and drops the socket.
      done(accepted, 401, 'Unauthorized')
    },
  })
  wss.on('connection', (socket) => {
    onSocket(socket)
  })

  /**
   * Bind the port. `ws` forwards the HTTP server's `error`/`listening` events
   * onto the WebSocketServer, and an unhandled `error` there (or on the HTTP
   * server) throws before the other listener runs, so both emitters are wired
   * and a single settled flag makes the pair idempotent.
   */
  async function listenForRequests(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        httpServer.off('error', onError)
        httpServer.off('listening', onListening)
        wss.off('error', onError)
        wss.off('listening', onListening)
      }
      function onError(error: Error): void {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      function onListening(): void {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      httpServer.once('error', onError)
      wss.once('error', onError)
      httpServer.once('listening', onListening)
      wss.once('listening', onListening)
      httpServer.listen(config.port, config.host)
    })
  }

  try {
    await listenForRequests()
  } catch (error) {
    // EADDRINUSE (or a bad host) happens after the runtime opened the journal
    // and module store; release both before surfacing the bind failure.
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve()
      })
    })
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve()
      })
      httpServer.closeAllConnections()
    })
    await runtime.close()
    throw error
  }

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    wss.close()
    httpServer.close()
    await runtime.close()
    throw new Error('startServer: failed to bind a TCP port')
  }

  let closing: Promise<void> | undefined
  async function close(): Promise<void> {
    if (closing !== undefined) return await closing
    closing = (async () => {
      for (const entry of [...approvals.values()]) entry.decide('cancelled')
      const settled: Promise<void>[] = []
      for (const state of runs.values()) {
        state.controller.abort()
        if (state.settled !== undefined) settled.push(state.settled)
      }
      for (const connection of [...connections]) connection.peer.close()
      for (const client of wss.clients) client.terminate()
      await Promise.allSettled(settled)
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve()
        })
      })
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve()
        })
        // close() waits for keep-alive sockets that never speak again.
        httpServer.closeAllConnections()
      })
      // Idempotent, and the last owner of the journal and any live run handles.
      await runtime.close()
    })()
    return await closing
  }

  return {
    url: `ws://${config.host}:${address.port}`,
    token: config.token,
    port: address.port,
    close,
  }
}
