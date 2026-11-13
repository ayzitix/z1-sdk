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
import { homedir } from 'node:os'
import { createServer, type IncomingMessage } from 'node:http'
import { join } from 'node:path'

import {
  GraphParseError,
  graphDigest,
  parseGraph,
  validateGraphTree,
  type GraphDocument,
  type GraphParseIssue,
  type ValidationIssue,
} from '@z1/graph'
import { SqliteJournal, type RunRecord, type RunStatus } from '@z1/journal'
import { ModuleStore } from '@z1/module'
import type { ApprovalDecision, Json, NodeRegistry } from '@z1/node'
import { createBuiltinRegistry } from '@z1/nodes'
import { ModuleRuntime } from '@z1/node-host'
import {
  APP_ERRORS,
  JsonRpcPeer,
  appFault,
  assertEnum,
  assertParams,
  describeNodes,
  invalidParams,
  runNotFound,
  type MethodMap,
  type RemoteMethodName,
  type RunReply,
  type SequencedEvent,
} from '@z1/protocol'
import {
  createMockRuntimeServices,
  runGraph,
  type ApprovalService,
  type LlmService,
  type RunEvent,
  type RunResult,
  type RuntimeServices,
} from '@z1/runtime'
import { WebSocketServer, type WebSocket } from 'ws'

import { LiveLlmRouter } from './live-llm.ts'
import {
  cloneRegistry,
  declarationRegistry,
  moduleFault,
  moduleSummary,
  proposalSummary,
} from './modules.ts'
import { SocketTransport } from './socket-transport.ts'
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
  readonly connectionId: string
  readonly decide: (decision: ApprovalDecision) => void
}

interface ResolvedConfig {
  readonly host: string
  readonly port: number
  readonly token: string
  readonly registry: NodeRegistry
  readonly live: boolean
  readonly env: NodeJS.ProcessEnv
  readonly approvalTimeoutMs: number
  readonly modulesPath: string
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

function approvalKey(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`
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
  if (typeof options.dbPath !== 'string' || options.dbPath === '') {
    throw new Error('startServer: dbPath is required')
  }
  const config: ResolvedConfig = {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? 0,
    token: options.token ?? randomBytes(TOKEN_BYTES).toString('hex'),
    registry: options.registry ?? createBuiltinRegistry(),
    live: options.live ?? false,
    env: options.env ?? process.env,
    approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    modulesPath:
      options.modulesPath ??
      (options.env ?? process.env)['Z1_MODULES_DIR'] ??
      join(homedir(), '.z1', 'modules'),
  }

  const modules = new ModuleStore(config.modulesPath)
  const journal = new SqliteJournal(options.dbPath)
  const runs = new Map<string, RunState>()
  const approvals = new Map<string, PendingApproval>()
  const connections = new Set<Connection>()
  /** runId+nodeId -> execution path of the node that asked; see `createApprovalService`. */
  const approvalPaths = new Map<string, string>()

  // One mock and at most one live router per server: provider clients cache an
  // HTTP agent, so rebuilding them per run would leak sockets.
  const mockServices = createMockRuntimeServices()
  const llm: LlmService = config.live
    ? new LiveLlmRouter(mockServices.llm, config.env)
    : mockServices.llm

  function publish(runId: string, seq: number, event: RunEvent): void {
    const state = runs.get(runId)
    if (state === undefined) return
    for (const subscriber of state.subscribers) {
      subscriber.peer.notify('run.event', { runId, seq, event })
    }
  }

  const tee = new TeeJournal(journal, (runId, seq, event) => {
    if (event.type === 'approval.requested') {
      // The runtime calls the approval service with `nodeId` only; the path is
      // already journaled on the event delivered just before the request.
      approvalPaths.set(approvalKey(runId, event.nodeId), event.path)
    }
    publish(runId, seq, event)
  })

  function readSequenced(runId: string, afterSeq: number | undefined): SequencedEvent[] {
    const events: SequencedEvent[] = journal
      .read(runId)
      .map((event, index) => ({ seq: index + 1, event }))
    return afterSeq === undefined ? events : events.filter((item) => item.seq > afterSeq)
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

  /** Built-ins plus stubs for every active module declaration. */
  function currentRegistry(): NodeRegistry {
    return declarationRegistry(config.registry, modules)
  }

  function hasActiveModules(): boolean {
    return modules.list().some((module) => module.active)
  }

  function assertValid(graph: GraphDocument): void {
    const issues = validateGraphTree(graph, currentRegistry())
    if (issues.length === 0) return
    const codes = [...new Set(issues.map((issue) => issue.code))].join(', ')
    throw appFault(APP_ERRORS.graphInvalid, `invalid graph: ${codes}`, { issues })
  }

  function createApprovalService(runId: string, connection: Connection): ApprovalService {
    return {
      request: async (request, context) => {
        const approvalId = `apr_${randomUUID()}`
        const path = approvalPaths.get(approvalKey(runId, context.nodeId)) ?? context.nodeId
        const decision = await new Promise<ApprovalDecision>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined

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

          timer = setTimeout(() => {
            fail(
              new Error(
                `approval ${approvalId} for node "${context.nodeId}" timed out after ${config.approvalTimeoutMs}ms`,
              ),
            )
          }, config.approvalTimeoutMs)
          timer.unref?.()

          approvals.set(approvalId, { approvalId, runId, connectionId: connection.id, decide })
          connection.approvals.add(approvalId)

          // A client may answer either by replying to this request (the
          // protocol shape) or with `approval.respond`; both settle the same
          // entry, and the first answer wins.
          void connection.peer
            .request('approval/request', {
              approvalId,
              runId,
              nodeId: context.nodeId,
              path,
              request,
            })
            .then(
              (reply) => {
                decide(reply.decision)
              },
              () => {
                decide('cancelled')
              },
            )
        })
        return decision
      },
    }
  }

  function createServices(runId: string, connection: Connection): RuntimeServices {
    const mock = createMockRuntimeServices()
    return {
      llm,
      tools: mock.tools,
      fs: mock.fs,
      artifacts: {
        put: async (data, mime) => journal.putBlob(data, mime),
        get: async (hash) => {
          const blob = journal.getBlob(hash)
          if (blob === undefined) throw new Error(`artifact not found: ${hash}`)
          return blob.bytes
        },
      },
      approval: createApprovalService(runId, connection),
    }
  }

  function notifyStatus(state: RunState): void {
    for (const subscriber of state.subscribers) {
      subscriber.peer.notify('run.status', { runId: state.runId, status: state.status })
    }
  }

  async function runAndSettle(
    state: RunState,
    args: StartArgs,
    connection: Connection,
  ): Promise<RunReply> {
    const services = createServices(state.runId, connection)
    let moduleRuntime: ModuleRuntime | undefined
    let registry: NodeRegistry = config.registry
    let result: RunResult | undefined
    let failure: string | undefined
    try {
      if (hasActiveModules()) {
        // Workers are per run: a module crash must not poison later runs, and an
        // approval from module code must reach the connection that started it.
        const runtime = new ModuleRuntime({
          store: modules,
          services: {
            llm: services.llm,
            tools: services.tools,
            fs: services.fs,
            approval: services.approval,
          },
          // The runtime registers into its base, so each run gets a fresh copy.
          baseRegistry: cloneRegistry(config.registry),
          onCapabilityDenied: (info) => {
            modules.recordDenied(info.moduleId, info.version, `${info.kind}: ${info.detail}`)
          },
        })
        moduleRuntime = runtime
        registry = await runtime.start()
      }
      result = await runGraph({
        graph: args.graph,
        registry,
        services,
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
      await moduleRuntime?.dispose()
    }

    if (result === undefined) {
      const message = failure ?? 'run failed'
      state.status = 'failed'
      journal.updateRun(state.runId, { status: 'failed', updatedAt: Date.now() })
      notifyStatus(state)
      return { runId: state.runId, status: 'failed', outputs: {}, error: message }
    }

    state.status = result.status
    journal.updateRun(state.runId, { status: result.status, updatedAt: Date.now() })
    notifyStatus(state)

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
    if (previous !== undefined && previous.status === 'running') {
      throw appFault(APP_ERRORS.conflict, `run ${args.runId} is already running`, {
        runId: args.runId,
      })
    }
    if (args.resume) {
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

    handle(connection, 'node.list', () => describeNodes(currentRegistry()))

    handle(connection, 'graph.validate', (params) => {
      assertParams(params, ['graph'])
      let issues: ValidationIssue[]
      try {
        issues = [...validateGraphTree(parseGraph(params['graph']), currentRegistry())]
      } catch (error) {
        if (!(error instanceof GraphParseError)) throw error
        issues = error.issues.map(parseIssue)
      }
      return { ok: issues.length === 0, issues }
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
      if (state === undefined) throw runNotFound(runId)
      state.controller.abort()
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
      const events = readSequenced(runId, undefined)

      let forkSeq: number
      if (nodePath !== undefined) {
        const started = events.find(
          (item) => item.event.type === 'node.started' && item.event.path === nodePath,
        )
        if (started === undefined) {
          throw invalidParams(`no node.started event for path "${nodePath}"`, { nodePath })
        }
        // The fork happens just before that node ran.
        forkSeq = started.seq - 1
      } else {
        forkSeq = atSeq ?? events.length
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
        throw appFault(APP_ERRORS.approvalNotFound, `unknown approval: ${approvalId}`, {
          approvalId,
        })
      }
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

  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('z1 server: connect to the /ws WebSocket endpoint\n')
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

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      httpServer.off('error', onError)
      resolve()
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(config.port, config.host)
  })

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    wss.close()
    httpServer.close()
    journal.close()
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
      journal.close()
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
