/**
 * Child-process bootstrap for `@z1/node-host`.
 *
 * This file is spawned directly by Node (`node --permission ... worker.js
 * <entry>`), so it must stay self-contained: only `node:` builtins at runtime,
 * no imports from `@z1/*`. Type-only imports below are erased at build time.
 *
 * It never trusts the host either: every inbound message is validated, and
 * every outbound result is checked to be plain JSON before it crosses IPC.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatDelta,
  ChatRequest,
  ChatResult,
  Json,
  ToolSchema,
} from '@z1/node'
import type { DeclaredPort } from '@z1/module'
import type {
  HostToWorker,
  WorkerLogLevel,
  WorkerNodeInfo,
  WorkerToHost,
} from './protocol.ts'

const NODE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const PORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const MAX_JSON_DEPTH = 100

const LEVELS: readonly WorkerLogLevel[] = ['debug', 'info', 'warn', 'error']

interface NetRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

interface NetResponse {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
}

interface ModuleContext {
  readonly inputs: Record<string, unknown>
  readonly config: unknown
  readonly input: unknown
  readonly signal: AbortSignal
  log(level: WorkerLogLevel, message: string, data?: unknown): void
  emit(port: string, chunk: unknown): void
  llm: {
    chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult>
  }
  tools: {
    call(name: string, args: Json): Promise<Json>
    list(): Promise<readonly ToolSchema[]>
  }
  fs: {
    read(path: string): Promise<string>
    write(path: string, data: string): Promise<void>
  }
  net: { request(request: NetRequest): Promise<NetResponse> }
  approval: { request(request: ApprovalRequest): Promise<ApprovalDecision> }
  runSubgraph(): never
}

interface ModuleNode {
  readonly info: WorkerNodeInfo
  readonly execute: (ctx: ModuleContext) => unknown
}

/** The `ctx` handed to every factory exported in the entry's `services`. */
interface ModuleServiceContext {
  readonly moduleId: string
  readonly version: string
  readonly directory: string
  readonly config: Record<string, unknown>
  log(level: WorkerLogLevel, message: string, data?: unknown): void
  /** Resolve a service of *this* module only; undefined otherwise. */
  get(name: string): unknown
  /**
   * Signal of the service call currently running, aborted when the host
   * cancels or times the call out. Best-effort: nothing waits for the service.
   */
  readonly signal: AbortSignal
  fs: {
    read(path: string): Promise<string>
    write(path: string, data: string): Promise<void>
  }
  net: { request(request: NetRequest): Promise<NetResponse> }
  llm: {
    chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult>
  }
  tools: {
    call(name: string, args: Json): Promise<Json>
    list(): Promise<readonly ToolSchema[]>
  }
  approval: { request(request: ApprovalRequest): Promise<ApprovalDecision> }
}

/** Ambient per-call data, so `ctx` getters do not need threading by hand. */
interface ServiceCallContext {
  readonly runId: string
  readonly signal: AbortSignal
}

const callContext = new AsyncLocalStorage<ServiceCallContext>()
/** Never aborted; used when a service reads `ctx.signal` outside a call. */
const IDLE_SIGNAL = new AbortController().signal

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly onDelta?: (delta: ChatDelta) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function send(message: WorkerToHost): void {
  const channel = process.send
  if (channel === undefined) throw new Error('module worker must be started with an IPC channel')
  // `Reflect.apply` keeps `this` bound to `process`; a bare `channel(msg)` would not.
  Reflect.apply(channel, process, [message])
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function fatal(message: string): never {
  try {
    send({ t: 'fatal', message })
  } catch {
    // The host may already be gone; exiting is still the right move.
  }
  process.exit(1)
}

function readTitle(raw: Record<string, unknown>, where: string): string | undefined {
  const title = raw['title']
  if (title === undefined) return undefined
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error(`${where} title must be a non-empty string`)
  }
  return title
}

function readDescription(raw: Record<string, unknown>, where: string): string | undefined {
  const description = raw['description']
  if (description === undefined) return undefined
  if (typeof description !== 'string') throw new Error(`${where} description must be a string`)
  return description
}

function parsePort(raw: unknown, where: string): DeclaredPort {
  if (!isRecord(raw)) throw new Error(`${where} must be an object`)
  const id = raw['id']
  if (typeof id !== 'string' || !PORT_ID_PATTERN.test(id)) {
    throw new Error(`${where} id must be a non-empty port id`)
  }
  const kind = raw['kind']
  if (kind === 'flow') {
    const port: DeclaredPort = { kind: 'flow', id }
    const title = readTitle(raw, where)
    if (title !== undefined) port.title = title
    const description = readDescription(raw, where)
    if (description !== undefined) port.description = description
    return port
  }
  if (kind !== 'data') throw new Error(`${where} kind must be "data" or "flow"`)

  const port: DeclaredPort = { kind: 'data', id }
  const title = readTitle(raw, where)
  if (title !== undefined) port.title = title
  const description = readDescription(raw, where)
  if (description !== undefined) port.description = description
  const schema = raw['schema']
  if (schema !== undefined) {
    if (!isRecord(schema)) throw new Error(`${where} schema must be an object`)
    port.schema = schema
  }
  const required = raw['required']
  if (required !== undefined) {
    if (typeof required !== 'boolean') throw new Error(`${where} required must be a boolean`)
    port.required = required
  }
  const mode = raw['mode']
  if (mode !== undefined) {
    if (mode !== 'value' && mode !== 'stream') {
      throw new Error(`${where} mode must be "value" or "stream"`)
    }
    port.mode = mode
  }
  return port
}

function parsePorts(value: unknown, where: string): DeclaredPort[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`)
  return value.map((port, index) => parsePort(port, `${where}[${index}]`))
}

function parseNode(raw: unknown, index: number): ModuleNode {
  const where = `nodes[${index}]`
  if (!isRecord(raw)) throw new Error(`${where} must be an object`)

  const id = raw['id']
  if (typeof id !== 'string' || !NODE_ID_PATTERN.test(id)) {
    throw new Error(`${where}.id must be a dotted lower-kebab node id`)
  }
  const version = raw['version']
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`node "${id}" version must be semver x.y.z`)
  }
  const title = raw['title']
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error(`node "${id}" title must be a non-empty string`)
  }
  const category = raw['category']
  if (typeof category !== 'string' || category.trim().length === 0) {
    throw new Error(`node "${id}" category must be a non-empty string`)
  }
  const execute = raw['execute']
  if (typeof execute !== 'function') {
    throw new Error(`node "${id}" must export an execute(ctx) function`)
  }

  const info: WorkerNodeInfo = {
    id,
    version,
    title,
    category,
    inputs: parsePorts(raw['inputs'], `node "${id}" inputs`),
    outputs: parsePorts(raw['outputs'], `node "${id}" outputs`),
  }
  return { info, execute: execute as (ctx: ModuleContext) => unknown }
}

/** Accept only plain JSON values; rejects cycles by depth as well as cycles. */
function toJsonValue(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (depth > MAX_JSON_DEPTH) throw new Error('module value is nested too deeply')
  if (value === null) return null

  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('module value contains a non-finite number')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('module value contains a cycle')
    seen.add(value)
    try {
      return value.map((item) => toJsonValue(item, depth + 1, seen))
    } finally {
      seen.delete(value)
    }
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new Error('module value contains a cycle')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('module value contains an object that is not a plain record')
    }
    seen.add(value)
    try {
      const result: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        result[key] = toJsonValue(entry, depth + 1, seen)
      }
      return result
    } finally {
      seen.delete(value)
    }
  }
  throw new Error(`module value contains a ${kind === 'undefined' ? 'undefined' : kind} that is not JSON`)
}

const entry = process.argv[2]
if (entry === undefined || entry.length === 0) {
  fatal('missing module entry path (expected process.argv[2])')
}

let loaded: unknown
try {
  loaded = (await import(pathToFileURL(entry).href)) as unknown
} catch (error) {
  fatal(`could not import module entry: ${errorText(error)}`)
}

const rawNodes = isRecord(loaded) ? (loaded['nodes'] ?? loaded['default']) : undefined

/** Optional argv[3] metadata the host passes alongside the entry path. */
interface EntryMetadata {
  moduleId: string
  version: string
  config: Record<string, unknown>
  /**
   * Whether this child should instantiate the entry's `services`. Node-only
   * workers pass `false`, so a throwing factory cannot break node execution.
   */
  loadServices: boolean
  /** Service ids the manifest declares (informational; the host validates ids). */
  serviceIds: string[]
}

function readEntryMetadata(raw: string | undefined): EntryMetadata {
  const metadata: EntryMetadata = {
    moduleId: 'unknown',
    version: '0.0.0',
    config: {},
    // A host that sends no metadata keeps the pre-loadServices behaviour.
    loadServices: true,
    serviceIds: [],
  }
  if (raw === undefined || raw.length === 0) return metadata
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return metadata
  }
  if (!isRecord(parsed)) return metadata
  const moduleId = parsed['moduleId']
  if (typeof moduleId === 'string' && moduleId.length > 0) metadata.moduleId = moduleId
  const version = parsed['version']
  if (typeof version === 'string' && version.length > 0) metadata.version = version
  const config = parsed['config']
  if (isRecord(config)) metadata.config = config

  const declared = parsed['serviceIds']
  const hasServiceIds = Array.isArray(declared)
  if (hasServiceIds) {
    metadata.serviceIds = declared.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    )
  }
  const loadServices = parsed['loadServices']
  metadata.loadServices =
    typeof loadServices === 'boolean' ? loadServices : hasServiceIds
  return metadata
}

const metadata = readEntryMetadata(process.argv[3])

let exportedNodes: unknown[]
if (Array.isArray(rawNodes)) {
  exportedNodes = rawNodes
} else if (rawNodes === undefined && metadata.loadServices) {
  // A service-only module may omit `nodes` entirely: the manifest declares
  // none, and the host only asked for its services.
  exportedNodes = []
} else {
  fatal('module entry must export `nodes` (or a default array of nodes)')
}

const nodes = new Map<string, ModuleNode>()
exportedNodes.forEach((raw: unknown, index: number) => {
  let node: ModuleNode
  try {
    node = parseNode(raw, index)
  } catch (error) {
    fatal(errorText(error))
  }
  if (nodes.has(node.info.id)) fatal(`duplicate exported node id "${node.info.id}"`)
  nodes.set(node.info.id, node)
})

const info = [...nodes.values()].map((node) => node.info)

const moduleDirectory = dirname(entry)

function serviceLog(
  serviceId: string,
  level: WorkerLogLevel,
  message: string,
  data?: unknown,
): void {
  const payload: WorkerToHost = {
    t: 'log',
    id: 0,
    nodeId: `service:${serviceId}`,
    level: LEVELS.includes(level) ? level : 'info',
    message,
  }
  if (data !== undefined) payload.data = data
  try {
    send(payload)
  } catch {
    // The host is gone; logs are diagnostics only.
  }
}

function serviceContext(
  serviceId: string,
  started: Map<string, Record<string, unknown>>,
): ModuleServiceContext {
  const invoke = (method: string, args: unknown): Promise<unknown> => call(0, method, args)
  const current = (): ServiceCallContext | undefined => callContext.getStore()
  return {
    moduleId: metadata.moduleId,
    version: metadata.version,
    directory: moduleDirectory,
    config: metadata.config,
    log: (level, message, data) => serviceLog(serviceId, level, message, data),
    // One child serves one module, so `started` never contains another
    // module's services: `ctx.get` is module-scoped by construction.
    get: (name) => started.get(name),
    get signal() {
      return current()?.signal ?? IDLE_SIGNAL
    },
    fs: {
      read: (path) => invoke('fs.read', { path }) as Promise<string>,
      write: (path, data) => invoke('fs.write', { path, data }) as Promise<void>,
    },
    net: {
      request: (netRequest) => invoke('net.request', netRequest) as Promise<NetResponse>,
    },
    llm: {
      chat: (chatRequest, onDelta) =>
        call(0, 'llm.chat', chatRequest, onDelta) as Promise<ChatResult>,
    },
    tools: {
      call: (name, args) => invoke('tools.call', { name, args }) as Promise<Json>,
      list: () => invoke('tools.list', null) as Promise<readonly ToolSchema[]>,
    },
    approval: {
      // The approval is run-scoped, so the wrapper carries the ambient runId.
      request: (approvalRequest) =>
        invoke('approval.request', {
          runId: current()?.runId ?? '',
          request: approvalRequest,
        }) as Promise<ApprovalDecision>,
    },
  }
}

const services = new Map<string, Record<string, unknown>>()
/** Instances that export `dispose()`, called once on the `dispose` RPC. */
const disposables: Array<() => Promise<unknown>> = []
// Declared before the factories run so a service may use ctx.fs/net while it is
// still being constructed.
const executions = new Map<number, AbortController>()
const pendingCalls = new Map<number, PendingCall>()
let callSequence = 0
// Node-only workers never touch `loaded.services`: a factory that throws (or a
// factory with a side effect) must not be able to break node execution.
if (metadata.loadServices) {
  const rawServices = isRecord(loaded) ? loaded['services'] : undefined
  if (rawServices !== undefined) {
    if (!isRecord(rawServices)) {
      fatal('module entry `services` must be an object of factory functions')
    }
    for (const [serviceId, factory] of Object.entries(rawServices)) {
      if (serviceId.length === 0) fatal('module entry exports a service with an empty id')
      if (typeof factory !== 'function') {
        fatal(`service "${serviceId}" must be a factory function (ctx) => instance`)
      }
      let instance: unknown
      try {
        instance = await (factory as (ctx: ModuleServiceContext) => unknown)(
          serviceContext(serviceId, services),
        )
      } catch (error) {
        fatal(`service "${serviceId}" failed to start: ${errorText(error)}`)
      }
      if (!isRecord(instance)) {
        fatal(`service "${serviceId}" factory did not return an object`)
      }
      services.set(serviceId, instance)
      const dispose = instance['dispose']
      if (typeof dispose === 'function') {
        const callable = dispose as () => unknown
        disposables.push(async () => await callable.call(instance))
      }
    }
  }
}

send({
  t: 'ready',
  nodes: info,
  services: [...services.keys()].map((id) => ({ id })),
})

function call(
  executionId: number,
  method: string,
  args: unknown,
  onDelta?: (delta: ChatDelta) => void,
): Promise<unknown> {
  callSequence += 1
  const callId = callSequence
  return new Promise((resolve, reject) => {
    const pending: PendingCall = { resolve, reject }
    if (onDelta !== undefined) {
      pendingCalls.set(callId, { ...pending, onDelta })
    } else {
      pendingCalls.set(callId, pending)
    }
    send({ t: 'call', id: executionId, callId, method, args })
  })
}

function createContext(
  executionId: number,
  nodeId: string,
  request: Extract<HostToWorker, { t: 'execute' }>,
  signal: AbortSignal,
): ModuleContext {
  const inputs = isRecord(request.inputs) ? request.inputs : {}
  const invoke = (method: string, args: unknown): Promise<unknown> =>
    call(executionId, method, args)

  return {
    inputs,
    config: request.config,
    input: request.seed,
    signal,
    log(level, message, data) {
      const payload: WorkerToHost = {
        t: 'log',
        id: executionId,
        nodeId,
        level: LEVELS.includes(level) ? level : 'info',
        message,
      }
      if (data !== undefined) payload.data = data
      send(payload)
    },
    emit(port, chunk) {
      send({ t: 'stream', id: executionId, nodeId, port, chunk })
    },
    llm: {
      chat: (chatRequest, onDelta) =>
        call(
          executionId,
          'llm.chat',
          chatRequest,
          onDelta,
        ) as Promise<ChatResult>,
    },
    tools: {
      call: (name, args) =>
        invoke('tools.call', { name, args }) as Promise<Json>,
      list: () => invoke('tools.list', null) as Promise<readonly ToolSchema[]>,
    },
    fs: {
      read: (path) => invoke('fs.read', { path }) as Promise<string>,
      write: (path, data) => invoke('fs.write', { path, data }) as Promise<void>,
    },
    net: {
      request: (netRequest) => invoke('net.request', netRequest) as Promise<NetResponse>,
    },
    approval: {
      request: (approvalRequest) =>
        invoke('approval.request', approvalRequest) as Promise<ApprovalDecision>,
    },
    runSubgraph() {
      throw new Error(
        'runSubgraph is not available inside module nodes (M4); build the nesting in the host graph instead',
      )
    },
  }
}

async function runNode(
  executionId: number,
  node: ModuleNode,
  request: Extract<HostToWorker, { t: 'execute' }>,
): Promise<void> {
  const controller = new AbortController()
  executions.set(executionId, controller)
  const ctx = createContext(executionId, node.info.id, request, controller.signal)

  try {
    const produced = await node.execute(ctx)
    if (controller.signal.aborted) return
    const outputs = toJsonValue(produced)
    if (!isRecord(outputs)) {
      throw new Error(`node "${node.info.id}" must return a plain object of port values`)
    }
    send({ t: 'result', id: executionId, outputs })
  } catch (error) {
    if (controller.signal.aborted) return
    const payload: WorkerToHost = { t: 'error', id: executionId, message: errorText(error) }
    if (error instanceof Error && typeof error.stack === 'string') payload.stack = error.stack
    try {
      send(payload)
    } catch {
      // The host is gone; nothing left to report to.
    }
  } finally {
    executions.delete(executionId)
  }
}

/** Service call ids in flight, and those the host cancelled. */
const activeServiceCalls = new Set<number>()
const cancelledServices = new Set<number>()
/** Per-call controllers, so a cancel can abort `ctx.signal` (best-effort). */
const serviceCallSignals = new Map<number, AbortController>()

function sendServiceDelta(id: number, delta: unknown): void {
  send({ t: 'service-delta', id, delta: toJsonValue(delta) })
}

function dropCancelled(serviceId: string, method: string, id: number): boolean {
  if (!cancelledServices.delete(id)) return false
  serviceLog(
    serviceId,
    'debug',
    `service call "${serviceId}.${method}" was cancelled; result dropped`,
  )
  return true
}

async function runServiceCall(
  id: number,
  serviceId: string,
  method: string,
  rawArgs: unknown,
  runId: string,
): Promise<void> {
  activeServiceCalls.add(id)
  const controller = new AbortController()
  serviceCallSignals.set(id, controller)
  try {
    const produced = await callContext.run({ runId, signal: controller.signal }, async () => {
      const instance = services.get(serviceId)
      if (instance === undefined) {
        throw new Error(`module entry does not export service "${serviceId}"`)
      }
      const member = instance[method]
      if (typeof member !== 'function') {
        throw new Error(`service "${serviceId}" has no method "${method}"`)
      }
      const callable = member as (...callArgs: unknown[]) => unknown
      const args: unknown[] = Array.isArray(rawArgs) ? [...rawArgs] : []
      // A streaming method declares it by taking an extra parameter.
      if (method === 'chat' && callable.length > args.length) {
        args.push((delta: unknown) => sendServiceDelta(id, delta))
      }

      return await Reflect.apply(callable, instance, args)
    })
    if (dropCancelled(serviceId, method, id)) return
    const value = produced === undefined ? null : toJsonValue(produced)
    send({ t: 'service-result', id, value })
  } catch (error) {
    if (dropCancelled(serviceId, method, id)) return
    const payload: WorkerToHost = {
      t: 'service-error',
      id,
      message: errorText(error),
    }
    if (error instanceof Error && typeof error.stack === 'string') payload.stack = error.stack
    try {
      send(payload)
    } catch {
      // The host is gone; nothing left to report to.
    }
  } finally {
    activeServiceCalls.delete(id)
    serviceCallSignals.delete(id)
  }
}

let disposing: Promise<void> | undefined

/** Dispose every instantiated service, then confirm on the wire. */
function disposeServices(): Promise<void> {
  disposing ??= (async () => {
    await Promise.allSettled(disposables.map(async (dispose) => await dispose()))
    try {
      send({ t: 'disposed' })
    } catch {
      // The host is gone; the exit that follows is the real signal.
    }
  })()
  return disposing
}

process.on('message', (raw: unknown) => {
  if (!isRecord(raw)) return
  const type = raw['t']

  if (type === 'service-call') {
    const id = raw['id']
    const serviceId = raw['serviceId']
    const method = raw['method']
    if (typeof id !== 'number' || typeof serviceId !== 'string' || typeof method !== 'string') {
      return
    }
    const context = raw['context']
    const runId =
      isRecord(context) && typeof context['runId'] === 'string' ? context['runId'] : ''
    void runServiceCall(id, serviceId, method, raw['args'], runId)
    return
  }

  if (type === 'service-cancel') {
    const id = raw['id']
    if (typeof id === 'number' && activeServiceCalls.has(id)) {
      cancelledServices.add(id)
      // Best-effort: services may watch `ctx.signal`, nothing waits for them.
      serviceCallSignals.get(id)?.abort(new Error('service call was cancelled'))
    }
    return
  }

  if (type === 'dispose') {
    void disposeServices()
    return
  }

  if (type === 'execute') {
    const id = raw['id']
    const nodeId = raw['nodeId']
    if (typeof id !== 'number' || typeof nodeId !== 'string') return
    const node = nodes.get(nodeId)
    if (node === undefined) {
      send({ t: 'error', id, message: `module entry does not export node "${nodeId}"` })
      return
    }
    const request: Extract<HostToWorker, { t: 'execute' }> = {
      t: 'execute',
      id,
      nodeId,
      config: raw['config'],
      inputs: isRecord(raw['inputs']) ? raw['inputs'] : {},
      seed: raw['seed'],
    }
    void runNode(id, node, request)
    return
  }

  if (type === 'cancel') {
    for (const controller of executions.values()) controller.abort()
    return
  }

  if (type === 'call-result') {
    const callId = raw['callId']
    if (typeof callId !== 'number') return
    const pending = pendingCalls.get(callId)
    if (pending === undefined) return
    pendingCalls.delete(callId)
    if (raw['ok'] === true) {
      pending.resolve(raw['value'])
    } else {
      const message = raw['error']
      pending.reject(new Error(typeof message === 'string' ? message : 'capability call failed'))
    }
    return
  }

  if (type === 'delta') {
    const callId = raw['callId']
    if (typeof callId !== 'number') return
    const pending = pendingCalls.get(callId)
    if (pending?.onDelta === undefined) return
    pending.onDelta(raw['delta'] as ChatDelta)
  }
})

process.on('unhandledRejection', (reason: unknown) => {
  try {
    process.stderr.write(`module unhandled rejection: ${errorText(reason)}\n`)
  } catch {
    // stderr is only a diagnostic channel here.
  }
})
