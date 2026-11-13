import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkFs,
  checkLlm,
  checkNet,
  checkTool,
  resolveCapabilityPath,
  type DeclaredPort,
  type ModuleCapabilities,
} from '@z1/module'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatDelta,
  ChatRequest,
  Json,
} from '@z1/node'
import type { ApprovalService, FsService, LlmService, ToolService } from '@z1/runtime'
import type {
  HostToWorker,
  WorkerLogLevel,
  WorkerNodeInfo,
  WorkerServiceInfo,
} from './protocol.ts'

const PACKAGE = '@z1/node-host'

const HANDSHAKE_TIMEOUT_MS = 10_000
const KILL_GRACE_MS = 2_000
/** How long `dispose()` waits for the child's `disposed` handshake. */
const DISPOSE_GRACE_MS = 2_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_NET_BODY_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

const LEVELS: readonly WorkerLogLevel[] = ['debug', 'info', 'warn', 'error']
const PORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** A log line produced by module code (ctx.log or its stdout/stderr). */
export interface WorkerLogEvent {
  nodeId: string
  level: WorkerLogLevel
  message: string
  data?: Json
}

/** A stream chunk produced by `ctx.emit(port, chunk)`. */
export interface WorkerStreamEvent {
  nodeId: string
  port: string
  chunk: Json
}

/** Per-execution sinks, used by the adapter to reach a NodeContext. */
export interface WorkerExecutionHooks {
  onLog?: (event: WorkerLogEvent) => void
  onStream?: (event: WorkerStreamEvent) => void
}

/** One host-side refusal to perform a privileged call for module code. */
export interface WorkerCapabilityDenial {
  moduleId: string
  version: string
  /** `fs.read`, `fs.write`, `net.request`, `approval.request`, `unsupported`, … */
  kind: string
  detail: string
}

export interface WorkerHostServices {
  llm: LlmService
  tools: ToolService
  fs: FsService
  approval: ApprovalService
  /**
   * Approval channel for *service*-originated requests, resolved per run. Node
   * executions keep using `approval`; a service approval with no resolver here
   * is rejected rather than silently borrowing the node channel.
   */
  approvalFor?: (runId: string) => ApprovalService | undefined
  /** Capability denials and piped stdout/stderr are reported here. */
  onLog?: (event: WorkerLogEvent) => void
  onStream?: (event: WorkerStreamEvent) => void
  /**
   * Called for every host-side denial, including ones the module catches and
   * swallows. The runtime layer turns this into an audit entry.
   */
  onCapabilityDenied?: (info: WorkerCapabilityDenial) => void
}

export interface WorkerHostOptions {
  /** Absolute or cwd-relative directory that owns the entry. */
  moduleDir: string
  /** Entry path relative to `moduleDir`; the file is imported by the child. */
  entry: string
  /** Node ids the manifest declares; exported ids must be a subset. */
  manifestNodeIds: string[]
  /** Service ids the manifest declares; reported ids must be a subset. */
  manifestServiceIds?: readonly string[]
  /**
   * Whether the child should instantiate the entry's `services`.
   *
   * Defaults to `manifestServiceIds !== undefined`, so a deployment that says
   * nothing about services keeps loading them. A node-only worker passes
   * `false`: its services are never read, so a throwing factory cannot break
   * node execution.
   */
  loadServices?: boolean
  capabilities: ModuleCapabilities
  services: WorkerHostServices
  /** Identity reported with capability denials; the store knows it. */
  moduleId?: string
  moduleVersion?: string
  /** Defaults to 120_000 ms. */
  timeoutMs?: number
  maxMemoryMb?: number
  env?: Record<string, string>
}

/** What `startAll` reports: the nodes and services an entry exports. */
export interface StartedWorker {
  nodes: WorkerNodeInfo[]
  services: WorkerServiceInfo[]
}

/** Streaming and timeout knobs for {@link ModuleWorker.serviceCall}. */
export interface ServiceCallOptions {
  onDelta?: (delta: unknown) => void
  /** Defaults to 120_000 ms. */
  timeoutMs?: number
  /**
   * Run this call belongs to. The child receives it as the call context, so
   * service approvals can be resolved per run. Defaults to `''`.
   */
  runId?: string
}

interface PendingExecution {
  readonly id: number
  readonly nodeId: string
  readonly child: ChildProcess
  readonly hooks: WorkerExecutionHooks | undefined
  readonly signal: AbortSignal | undefined
  readonly onAbort: (() => void) | undefined
  readonly resolve: (outputs: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
  killTimer: NodeJS.Timeout | undefined
  settled: boolean
}

interface PendingServiceCall {
  readonly id: number
  readonly serviceId: string
  readonly method: string
  readonly onDelta: ((delta: unknown) => void) | undefined
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
  settled: boolean
}

interface SendResult {
  ok: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject service call arguments that cannot survive structured clone as JSON.
 * The values travel through IPC, so non-JSON shapes are a caller bug.
 */
function assertServiceArgs(value: unknown, where: string, seen: Set<object> = new Set()): void {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`${where} contains a non-finite number`)
    }
    return
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${where} contains a cycle`)
    seen.add(value)
    try {
      value.forEach((item, index) => assertServiceArgs(item, `${where}[${index}]`, seen))
    } finally {
      seen.delete(value)
    }
    return
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new Error(`${where} contains a cycle`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${where} contains an object that is not a plain record`)
    }
    seen.add(value)
    try {
      for (const [key, entry] of Object.entries(value)) {
        assertServiceArgs(entry, `${where}.${key}`, seen)
      }
    } finally {
      seen.delete(value)
    }
    return
  }
  throw new Error(`${where} contains a ${kind} that is not JSON`)
}

/** Validate the untrusted `services` list from the `ready` payload. */
function parseServiceInfo(raw: unknown, index: number): WorkerServiceInfo {
  if (!isRecord(raw)) throw new Error(`services[${index}] must be an object`)
  const id = raw['id']
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`services[${index}].id is missing`)
  }
  return { id }
}

function parseServiceInfos(raw: unknown): WorkerServiceInfo[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('services must be an array')
  return raw.map((service, index) => parseServiceInfo(service, index))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Locate the child bootstrap for a given `host` module URL.
 *
 * The bootstrap is spawned as plain JavaScript: Node type-stripping a `.ts`
 * bootstrap changes how it resolves imports, so TypeScript is only a last
 * resort for tests that run straight from `src`. When the package is loaded
 * from `src` (tsx, tsconfig paths), the built sibling lives one level up in
 * `lib/`. A missing build is a configuration error, never a silent fallback.
 */
export function resolveWorkerBootstrap(moduleUrl: string | URL): string {
  const candidates = [
    // Built next to host.js (the normal installed/packaged path).
    new URL('./worker.js', moduleUrl),
    // Running from src/: the package's own build output.
    new URL('../lib/worker.js', moduleUrl),
    // Last resort for tests with no build present.
    new URL('./worker.ts', moduleUrl),
  ]
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    if (existsSync(path)) return path
  }
  throw new Error(
    `${PACKAGE}: worker bootstrap not found next to ${fileURLToPath(moduleUrl)}; ` +
      'build @z1/node-host first (pnpm -C z1 build)',
  )
}

function bootstrapPath(): string {
  return resolveWorkerBootstrap(import.meta.url)
}

/**
 * Directory whose `package.json` tells Node the bootstrap is ESM.
 *
 * The child runs under `--permission`, which also hides Node's own package
 * lookups. Without this file the `.js` bootstrap is treated as CommonJS and
 * `import()` of an ES module entry is routed through `require(esm)`, which is a
 * cycle. Walk up from the bootstrap so both `lib/worker.js` and (`src/`) point
 * at the package root.
 */
export function bootstrapPackageRoot(bootstrap: string): string {
  let directory = dirname(bootstrap)
  for (;;) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return dirname(bootstrap)
    directory = parent
  }
}

function parsePort(raw: unknown, where: string): DeclaredPort {
  if (!isRecord(raw)) throw new Error(`${where} must be an object`)
  const id = raw['id']
  if (typeof id !== 'string' || !PORT_ID_PATTERN.test(id)) {
    throw new Error(`${where} has an invalid port id`)
  }
  const title = raw['title']
  if (title !== undefined && typeof title !== 'string') {
    throw new Error(`${where} title must be a string`)
  }
  const description = raw['description']
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(`${where} description must be a string`)
  }
  if (raw['kind'] === 'flow') {
    const port: DeclaredPort = { kind: 'flow', id }
    if (title !== undefined) port.title = title
    if (description !== undefined) port.description = description
    return port
  }
  if (raw['kind'] !== 'data') throw new Error(`${where} kind must be "data" or "flow"`)
  const port: DeclaredPort = { kind: 'data', id }
  if (title !== undefined) port.title = title
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
    if (mode !== 'value' && mode !== 'stream') throw new Error(`${where} has an invalid mode`)
    port.mode = mode
  }
  return port
}

function parsePorts(raw: unknown, where: string): DeclaredPort[] {
  if (!Array.isArray(raw)) throw new Error(`${where} must be an array`)
  return raw.map((port, index) => parsePort(port, `${where}[${index}]`))
}

/** Validate the untrusted `ready` payload from the child. */
function parseNodeInfo(raw: unknown, index: number): WorkerNodeInfo {
  if (!isRecord(raw)) throw new Error(`nodes[${index}] must be an object`)
  const id = raw['id']
  const version = raw['version']
  const title = raw['title']
  const category = raw['category']
  if (typeof id !== 'string' || id.length === 0) throw new Error(`nodes[${index}].id is missing`)
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`node "${id}" has no version`)
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error(`node "${id}" has no title`)
  }
  if (typeof category !== 'string' || category.trim().length === 0) {
    throw new Error(`node "${id}" has no category`)
  }
  return {
    id,
    version,
    title,
    category,
    inputs: parsePorts(raw['inputs'], `node "${id}" inputs`),
    outputs: parsePorts(raw['outputs'], `node "${id}" outputs`),
  }
}

async function readBody(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (response.body === null) return { body: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = MAX_NET_BODY_BYTES - total
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
      }
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
    total += value.byteLength
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { body: new TextDecoder().decode(merged), truncated }
}

function headersRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

/**
 * Runs one module entry in a child process under Node's permission model and
 * brokers every privileged operation back to the host services.
 *
 * One worker is single-process: a crash rejects every pending execution and
 * leaves the worker dead until `start()` spawns a fresh child.
 */
export class ModuleWorker {
  readonly #options: WorkerHostOptions
  readonly #moduleDir: string
  readonly #capabilities: ModuleCapabilities
  readonly #loadServices: boolean
  readonly #bootstrap: string
  readonly #bootstrapPackage: string
  readonly #executions = new Map<number, PendingExecution>()
  readonly #serviceCalls = new Map<number, PendingServiceCall>()
  #child: ChildProcess | undefined
  #state: 'idle' | 'starting' | 'ready' | 'dead' | 'disposed' = 'idle'
  /** Identity used only for denial reporting; never trusted for policy. */
  #moduleId: string
  #moduleVersion: string
  #nodes: readonly WorkerNodeInfo[] = []
  #workerServices: readonly WorkerServiceInfo[] = []
  #starting: Promise<StartedWorker> | undefined
  #startResolve: ((started: StartedWorker) => void) | undefined
  #startReject: ((error: Error) => void) | undefined
  #handshakeTimer: NodeJS.Timeout | undefined
  #sequence = 0
  #serviceSequence = 0
  #disposePromise: Promise<void> | undefined
  /** Set while `dispose()` waits for the child's `disposed` handshake. */
  #disposeWait: (() => void) | undefined

  constructor(options: WorkerHostOptions) {
    this.#options = options
    this.#moduleDir = resolve(options.moduleDir)
    this.#capabilities = options.capabilities
    this.#loadServices = options.loadServices ?? options.manifestServiceIds !== undefined
    this.#bootstrap = bootstrapPath()
    this.#bootstrapPackage = bootstrapPackageRoot(this.#bootstrap)
    this.#moduleId = options.moduleId ?? 'unknown'
    this.#moduleVersion = options.moduleVersion ?? '0.0.0'
  }

  get packageName(): string {
    return PACKAGE
  }

  /** True while a child is spawned and ready for `execute`. */
  get alive(): boolean {
    return this.#state === 'ready'
  }

  /**
   * Lifecycle of this worker object. `dead` means the child exited (or failed
   * to start) and a call must go through the owner that can respawn it.
   */
  get state(): 'idle' | 'starting' | 'ready' | 'dead' | 'disposed' {
    return this.#state
  }

  get nodes(): readonly WorkerNodeInfo[] {
    return this.#nodes
  }

  /** Services reported by the child's `ready` handshake. */
  get services(): readonly WorkerServiceInfo[] {
    return this.#workerServices
  }

  start(): Promise<readonly WorkerNodeInfo[]> {
    return this.startAll().then((started) => started.nodes)
  }

  /** `start` plus the service ids the entry exports. */
  startAll(): Promise<StartedWorker> {
    if (this.#state === 'disposed') {
      return Promise.reject(new Error('module worker has been disposed'))
    }
    if (this.#state === 'ready') {
      return Promise.resolve({
        nodes: [...this.#nodes],
        services: [...this.#workerServices],
      })
    }
    if (this.#starting !== undefined) return this.#starting

    const entryPath = resolve(this.#moduleDir, this.#options.entry)
    if (!existsSync(entryPath)) {
      return Promise.reject(new Error(`module entry not found: ${entryPath}`))
    }

    const promise = new Promise<StartedWorker>((resolveReady, rejectReady) => {
      this.#startResolve = resolveReady
      this.#startReject = rejectReady
    })
    this.#starting = promise
    this.#spawn()

    this.#handshakeTimer = setTimeout(() => {
      this.#failStart(
        new Error(`module worker did not report ready within ${HANDSHAKE_TIMEOUT_MS}ms`),
      )
      this.#killChild(this.#child)
    }, HANDSHAKE_TIMEOUT_MS)
    this.#handshakeTimer.unref?.()

    return promise
  }

  async execute(
    nodeId: string,
    config: unknown,
    inputs: Record<string, unknown>,
    seed: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.#awaitReady()
    return this.#execute(nodeId, config, inputs, seed, signal, undefined)
  }

  /**
   * `execute` plus per-run sinks. The adapter uses this so a module's log and
   * stream calls reach the executor's NodeContext instead of a global service.
   */
  async executeWithHooks(
    nodeId: string,
    config: unknown,
    inputs: Record<string, unknown>,
    seed: unknown,
    signal: AbortSignal | undefined,
    hooks: WorkerExecutionHooks,
  ): Promise<Record<string, unknown>> {
    await this.#awaitReady()
    return this.#execute(nodeId, config, inputs, seed, signal, hooks)
  }

  /**
   * Wait for an in-flight handshake instead of rejecting a call that arrives
   * while the child is still booting.
   *
   * A runtime that respawns a dead module returns the new worker immediately, so
   * the very next call lands in `starting`; waiting makes the respawn
   * transparent without hiding a failed handshake, which still rejects.
   */
  async #awaitReady(): Promise<void> {
    if (this.#state === 'starting') {
      const starting = this.#starting
      if (starting !== undefined) await starting.catch(() => undefined)
    }
    if (this.#state === 'ready') return
    throw new Error(
      this.#state === 'disposed'
        ? 'module worker has been disposed'
        : this.#state === 'dead'
          ? 'module worker exited; call start() to respawn'
          : 'module worker is not ready; call start() first',
    )
  }

  /**
   * Call a method on a service the entry exports, inside the child process.
   *
   * Numeric ids are internal; the returned value is whatever the method
   * returned (JSON-safe, `undefined` normalised to `null` by the child).
   */
  async serviceCall(
    serviceId: string,
    method: string,
    args: readonly unknown[],
    options: ServiceCallOptions = {},
  ): Promise<unknown> {
    await this.#awaitReady()
    const child = this.#child
    if (child === undefined) {
      return Promise.reject(new Error('module worker exited; call start() to respawn'))
    }
    try {
      assertServiceArgs(args, `serviceCall("${serviceId}.${method}") args`)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const id = ++this.#serviceSequence

    return new Promise<unknown>((resolveValue, rejectValue) => {
      const pending: PendingServiceCall = {
        id,
        serviceId,
        method,
        onDelta: options.onDelta,
        resolve: resolveValue,
        reject: rejectValue,
        timer: undefined,
        settled: false,
      }
      this.#serviceCalls.set(id, pending)

      pending.timer = setTimeout(() => {
        if (pending.settled) return
        this.#settleServiceCall(pending, {
          ok: false,
          error: new Error(
            `service call "${serviceId}.${method}" exceeded its ${timeoutMs}ms timeout`,
          ),
        })
        this.#send({ t: 'service-cancel', id })
      }, timeoutMs)
      pending.timer.unref?.()

      const sent = this.#send({
        t: 'service-call',
        id,
        serviceId,
        method,
        args: [...args],
        context: { runId: options.runId ?? '' },
      })
      if (!sent.ok) {
        this.#settleServiceCall(pending, {
          ok: false,
          error: new Error('module worker exited before the service call could be dispatched'),
        })
      }
    })
  }

  /** Ask the child to abort and kill it after the 2 s grace period. */
  cancel(reason = 'module worker cancelled'): void {
    if (this.#child === undefined) return
    this.#send({ t: 'cancel', reason })
    for (const execution of [...this.#executions.values()]) {
      this.#abortExecution(execution, reason)
    }
    for (const pending of [...this.#serviceCalls.values()]) {
      this.#send({ t: 'service-cancel', id: pending.id })
      this.#settleServiceCall(pending, { ok: false, error: new Error(reason) })
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposePromise = this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    const child = this.#child
    const wasReady = this.#state === 'ready'
    this.#clearHandshake()
    const failure = new Error('module worker was disposed')
    this.#failStart(failure)
    for (const execution of [...this.#executions.values()]) {
      this.#settle(execution, { ok: false, error: failure })
    }
    for (const pending of [...this.#serviceCalls.values()]) {
      this.#settleServiceCall(pending, { ok: false, error: failure })
    }
    this.#state = 'disposed'
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      // A started service may hold resources; let it release them. Node-only
      // workers never instantiated services, so they skip the round trip.
      if (this.#loadServices && wasReady) await this.#requestServiceDispose(child)
      try {
        child.send({ t: 'cancel', reason: 'disposed' } satisfies HostToWorker)
      } catch {
        // The channel may already be closed.
      }
      this.#killChild(child)
      this.#child = undefined
      await new Promise<void>((settle) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          settle()
          return
        }
        const timer = setTimeout(settle, 1_000)
        timer.unref?.()
        child.once('exit', () => {
          clearTimeout(timer)
          settle()
        })
      })
    }
    this.#child = undefined
  }

  /** Send `dispose` and wait at most {@link DISPOSE_GRACE_MS} for `disposed`. */
  #requestServiceDispose(child: ChildProcess): Promise<void> {
    return new Promise<void>((settle) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        this.#disposeWait = undefined
        clearTimeout(timer)
        child.off('exit', finish)
        settle()
      }
      const timer = setTimeout(finish, DISPOSE_GRACE_MS)
      timer.unref?.()
      this.#disposeWait = finish
      child.once('exit', finish)
      try {
        child.send({ t: 'dispose' } satisfies HostToWorker)
      } catch {
        finish()
      }
    })
  }

  #spawn(): void {
    const entryPath = resolve(this.#moduleDir, this.#options.entry)
    const args = [
      '--permission',
      `--allow-fs-read=${this.#bootstrap}`,
      // Let Node see the bootstrap package's "type": "module".
      `--allow-fs-read=${join(this.#bootstrapPackage, 'package.json')}`,
      `--allow-fs-read=${this.#moduleDir}`,
    ]

    const writePatterns = this.#capabilities.fs?.write ?? []
    for (const pattern of writePatterns) {
      if (pattern.trim().length === 0) continue
      const expanded = resolve(this.#moduleDir, resolveCapabilityPath(pattern, this.#moduleDir))
      args.push(`--allow-fs-write=${isAbsolute(expanded) ? expanded : resolve(expanded)}`)
    }

    if (this.#options.maxMemoryMb !== undefined) {
      args.push(`--max-old-space-size=${Math.trunc(this.#options.maxMemoryMb)}`)
    }
    args.push(
      this.#bootstrap,
      entryPath,
      JSON.stringify({
        moduleId: this.#moduleId,
        version: this.#moduleVersion,
        config: {},
        // Node-only workers get `loadServices: false` so the child never reads
        // or instantiates `services`.
        loadServices: this.#loadServices,
        serviceIds: [...(this.#options.manifestServiceIds ?? [])],
      }),
    )

    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' }
    for (const [key, value] of Object.entries(this.#options.env ?? {})) env[key] = value

    this.#nodes = []
    this.#workerServices = []
    this.#state = 'starting'

    const child = spawn(process.execPath, args, {
      cwd: this.#moduleDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.#child = child

    child.on('message', (message: unknown) => {
      this.#handleMessage(child, message)
    })
    child.on('error', (error: Error) => {
      if (this.#child !== child) return
      this.#failStart(new Error(`module worker failed to start: ${error.message}`))
      this.#handleExit(child, null, null)
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#handleExit(child, code, signal)
    })

    this.#pipe(child.stdout, 'info')
    this.#pipe(child.stderr, 'warn')
  }

  /** stdout/stderr are diagnostics only — never protocol. */
  #pipe(stream: NodeJS.ReadableStream | null, level: WorkerLogLevel): void {
    if (stream === null) return
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        this.#services.onLog?.({ nodeId: 'module', level, message: line })
      }
    })
  }

  get #services(): WorkerHostServices {
    return this.#options.services
  }

  #send(message: HostToWorker): SendResult {
    const child = this.#child
    if (child === undefined || child.connected !== true) return { ok: false }
    try {
      child.send(message)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  #handleMessage(child: ChildProcess, raw: unknown): void {
    if (this.#child !== child || !isRecord(raw)) return
    const type = raw['t']

    if (type === 'ready') {
      this.#handleReady(child, raw['nodes'], raw['services'])
      return
    }
    if (type === 'fatal') {
      const message = raw['message']
      this.#failStart(
        new Error(`module entry failed: ${typeof message === 'string' ? message : 'unknown error'}`),
      )
      this.#killChild(child)
      return
    }

    if (type === 'service-result') {
      const id = raw['id']
      if (typeof id !== 'number') return
      const pending = this.#serviceCalls.get(id)
      if (pending === undefined) return
      this.#settleServiceCall(pending, { ok: true, value: raw['value'] })
      return
    }
    if (type === 'service-error') {
      const id = raw['id']
      if (typeof id !== 'number') return
      const pending = this.#serviceCalls.get(id)
      if (pending === undefined) return
      const message = raw['message']
      this.#settleServiceCall(pending, {
        ok: false,
        error: new Error(
          typeof message === 'string'
            ? message
            : `service call "${pending.serviceId}.${pending.method}" failed`,
        ),
      })
      return
    }
    if (type === 'service-delta') {
      const id = raw['id']
      if (typeof id !== 'number') return
      this.#serviceCalls.get(id)?.onDelta?.(raw['delta'])
      return
    }
    if (type === 'disposed') {
      this.#disposeWait?.()
      return
    }

    const executionId = raw['id']
    if (typeof executionId !== 'number') return

    if (type === 'log') {
      this.#handleLog(executionId, raw)
      return
    }
    if (type === 'stream') {
      const execution = this.#executions.get(executionId)
      const port = raw['port']
      if (typeof port !== 'string') return
      const event: WorkerStreamEvent = {
        nodeId: typeof raw['nodeId'] === 'string' ? raw['nodeId'] : (execution?.nodeId ?? 'module'),
        port,
        chunk: raw['chunk'] as Json,
      }
      if (execution?.hooks?.onStream !== undefined) execution.hooks.onStream(event)
      else this.#services.onStream?.(event)
      return
    }
    if (type === 'call') {
      const callId = raw['callId']
      const method = raw['method']
      if (typeof callId !== 'number' || typeof method !== 'string') return
      const execution = this.#executions.get(executionId)
      void this.#handleCall(child, callId, method, raw['args'], execution?.nodeId ?? 'module')
      return
    }
    if (type === 'result') {
      const execution = this.#executions.get(executionId)
      if (execution === undefined) return
      const outputs = raw['outputs']
      if (!isRecord(outputs)) {
        this.#settle(execution, {
          ok: false,
          error: new Error(`node "${execution.nodeId}" returned a non-record result`),
        })
        return
      }
      this.#settle(execution, { ok: true, outputs })
      return
    }
    if (type === 'error') {
      const execution = this.#executions.get(executionId)
      if (execution === undefined) return
      const message = raw['message']
      this.#settle(execution, {
        ok: false,
        error: new Error(
          `module node "${execution.nodeId}" failed: ${
            typeof message === 'string' ? message : 'unknown error'
          }`,
        ),
      })
    }
  }

  #handleReady(child: ChildProcess, raw: unknown, rawServices: unknown): void {
    if (this.#child !== child || this.#state !== 'starting') return
    if (!Array.isArray(raw)) {
      this.#failStart(new Error('module worker sent an invalid ready payload'))
      this.#killChild(child)
      return
    }

    let nodes: WorkerNodeInfo[]
    try {
      nodes = raw.map((node, index) => parseNodeInfo(node, index))
    } catch (error) {
      this.#failStart(new Error(`module worker sent invalid node descriptors: ${errorMessage(error)}`))
      this.#killChild(child)
      return
    }

    let services: WorkerServiceInfo[]
    try {
      services = parseServiceInfos(rawServices)
    } catch (error) {
      this.#failStart(new Error(`module worker sent invalid service descriptors: ${errorMessage(error)}`))
      this.#killChild(child)
      return
    }

    const declared = new Set(this.#options.manifestNodeIds)
    for (const node of nodes) {
      if (!declared.has(node.id)) {
        this.#failStart(
          new Error(
            `module exports node "${node.id}" which the manifest does not declare`,
          ),
        )
        this.#killChild(child)
        return
      }
    }

    const declaredServices = this.#options.manifestServiceIds
    const seen = new Set<string>()
    for (const service of services) {
      if (seen.has(service.id)) {
        this.#failStart(new Error(`module exports service "${service.id}" more than once`))
        this.#killChild(child)
        return
      }
      seen.add(service.id)
      if (declaredServices !== undefined && !declaredServices.includes(service.id)) {
        this.#failStart(
          new Error(
            `module exports service "${service.id}" which the manifest does not declare`,
          ),
        )
        this.#killChild(child)
        return
      }
    }

    this.#clearHandshake()
    this.#nodes = nodes
    this.#workerServices = services
    this.#state = 'ready'
    const resolveReady = this.#startResolve
    this.#startResolve = undefined
    this.#startReject = undefined
    this.#starting = undefined
    resolveReady?.({ nodes: [...nodes], services: [...services] })
  }

  #failStart(error: Error): void {
    const rejectReady = this.#startReject
    this.#startReject = undefined
    this.#startResolve = undefined
    this.#starting = undefined
    if (this.#state !== 'disposed') this.#state = 'dead'
    rejectReady?.(error)
  }

  #clearHandshake(): void {
    if (this.#handshakeTimer !== undefined) {
      clearTimeout(this.#handshakeTimer)
      this.#handshakeTimer = undefined
    }
  }

  #killChild(child: ChildProcess | undefined): void {
    if (child === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGKILL')
  }

  #handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return
    this.#child = undefined
    this.#nodes = []
    this.#workerServices = []
    const wasStarting = this.#state === 'starting'
    if (this.#state !== 'disposed') this.#state = 'dead'
    this.#clearHandshake()

    const suffix = `worker exited (code ${code === null ? 'null' : code}, signal ${
      signal === null ? 'null' : signal
    })`
    if (wasStarting) {
      this.#failStart(new Error(`module worker exited before ready`))
    }
    for (const execution of [...this.#executions.values()]) {
      this.#settle(execution, {
        ok: false,
        error: new Error(`${suffix} while running module node "${execution.nodeId}"`),
      })
    }
    for (const pending of [...this.#serviceCalls.values()]) {
      this.#settleServiceCall(pending, {
        ok: false,
        error: new Error(
          `${suffix} while waiting for service call "${pending.serviceId}.${pending.method}"`,
        ),
      })
    }
  }

  #handleLog(executionId: number, raw: Record<string, unknown>): void {
    const level = raw['level']
    const message = raw['message']
    if (typeof message !== 'string') return
    const execution = this.#executions.get(executionId)
    const event: WorkerLogEvent = {
      nodeId: typeof raw['nodeId'] === 'string' ? raw['nodeId'] : (execution?.nodeId ?? 'module'),
      level: LEVELS.includes(level as WorkerLogLevel) ? (level as WorkerLogLevel) : 'info',
      message,
      ...(raw['data'] !== undefined ? { data: raw['data'] as Json } : {}),
    }
    if (execution?.hooks?.onLog !== undefined) execution.hooks.onLog(event)
    else this.#services.onLog?.(event)
  }

  #execute(
    nodeId: string,
    config: unknown,
    inputs: Record<string, unknown>,
    seed: unknown,
    signal: AbortSignal | undefined,
    hooks: WorkerExecutionHooks | undefined,
  ): Promise<Record<string, unknown>> {
    if (this.#state === 'disposed') {
      return Promise.reject(new Error('module worker has been disposed'))
    }
    if (this.#state !== 'ready') {
      return Promise.reject(
        new Error(
          this.#state === 'dead'
            ? 'module worker exited; call start() to respawn'
            : 'module worker is not ready; call start() first',
        ),
      )
    }
    if (signal?.aborted === true) {
      return Promise.reject(new Error(`module node "${nodeId}" aborted before execution`))
    }

    const child = this.#child
    if (child === undefined) {
      return Promise.reject(new Error('module worker exited; call start() to respawn'))
    }

    const executionId = ++this.#sequence
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<Record<string, unknown>>((resolveOutputs, rejectOutputs) => {
      let execution: PendingExecution
      const onAbort =
        signal === undefined
          ? undefined
          : (): void => {
              const reason = signal.reason
              this.#abortExecution(
                execution,
                `module node "${nodeId}" was cancelled${
                  reason === undefined ? '' : `: ${errorMessage(reason)}`
                }`,
              )
            }

      execution = {
        id: executionId,
        nodeId,
        child,
        hooks,
        signal,
        onAbort,
        resolve: resolveOutputs,
        reject: rejectOutputs,
        timer: undefined,
        killTimer: undefined,
        settled: false,
      }
      this.#executions.set(executionId, execution)

      execution.timer = setTimeout(() => {
        this.#abortExecution(
          execution,
          `module node "${nodeId}" exceeded its ${timeoutMs}ms timeout`,
        )
      }, timeoutMs)
      execution.timer.unref?.()

      if (onAbort !== undefined) signal?.addEventListener('abort', onAbort, { once: true })

      const sent = this.#send({
        t: 'execute',
        id: executionId,
        nodeId,
        config,
        inputs,
        seed,
      })
      if (!sent.ok) {
        this.#settle(execution, {
          ok: false,
          error: new Error('module worker exited before the node could be dispatched'),
        })
      }
    })
  }

  #abortExecution(execution: PendingExecution, reason: string): void {
    if (execution.settled) return
    this.#send({ t: 'cancel', reason })
    execution.killTimer = setTimeout(() => {
      this.#killChild(execution.child)
    }, KILL_GRACE_MS)
    execution.killTimer.unref?.()
    this.#settle(execution, { ok: false, error: new Error(reason) }, true)
  }

  #settle(
    execution: PendingExecution,
    outcome: { ok: true; outputs: Record<string, unknown> } | { ok: false; error: Error },
    keepKillTimer = false,
  ): void {
    if (execution.settled) return
    execution.settled = true
    if (execution.timer !== undefined) clearTimeout(execution.timer)
    if (!keepKillTimer && execution.killTimer !== undefined) clearTimeout(execution.killTimer)
    if (execution.signal !== undefined && execution.onAbort !== undefined) {
      execution.signal.removeEventListener('abort', execution.onAbort)
    }
    this.#executions.delete(execution.id)
    if (outcome.ok) execution.resolve(outcome.outputs)
    else execution.reject(outcome.error)
  }

  /** Settle one service call: clear its timer, forget it, then resolve/reject. */
  #settleServiceCall(
    pending: PendingServiceCall,
    outcome: { ok: true; value: unknown } | { ok: false; error: Error },
  ): void {
    if (pending.settled) return
    pending.settled = true
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    this.#serviceCalls.delete(pending.id)
    if (outcome.ok) pending.resolve(outcome.value)
    else pending.reject(outcome.error)
  }

  async #handleCall(
    child: ChildProcess,
    callId: number,
    method: string,
    args: unknown,
    nodeId: string,
  ): Promise<void> {
    try {
      const value = await this.#dispatch(child, callId, method, args, nodeId)
      if (this.#child !== child) return
      this.#send({ t: 'call-result', callId, ok: true, value: value ?? null })
    } catch (error) {
      if (this.#child !== child) return
      this.#send({ t: 'call-result', callId, ok: false, error: errorMessage(error) })
    }
  }

  async #dispatch(
    child: ChildProcess,
    callId: number,
    method: string,
    args: unknown,
    nodeId: string,
  ): Promise<unknown> {
    switch (method) {
      case 'llm.chat': {
        if (!isRecord(args)) throw new Error('llm.chat requires a ChatRequest object')
        if (!Array.isArray(args['messages'])) {
          throw new Error('llm.chat requires a messages array')
        }
        const model = args['model']
        const provider =
          isRecord(model) && typeof model['provider'] === 'string' ? model['provider'] : ''
        // Manifest gate: a module calls an LLM only when it declared one.
        const check = checkLlm(this.#capabilities, provider)
        if (!check.ok) {
          throw this.#capabilityDenied(
            nodeId,
            'llm',
            `model provider "${provider}": ${check.reason}`,
            'llm.chat',
          )
        }
        const request = args as unknown as ChatRequest
        return this.#services.llm.chat(request, (delta: ChatDelta) => {
          if (this.#child !== child) return
          this.#send({ t: 'delta', callId, delta })
        })
      }
      case 'tools.call': {
        if (!isRecord(args)) throw new Error('tools.call requires { name, args }')
        const name = args['name']
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error('tools.call requires a tool name')
        }
        // Manifest gate: a module calls a tool only when it declared one.
        const check = checkTool(this.#capabilities, name)
        if (!check.ok) {
          throw this.#capabilityDenied(
            nodeId,
            'tools',
            `tool "${name}": ${check.reason}`,
            'tools.call',
          )
        }
        return this.#services.tools.call(name, (args['args'] ?? null) as Json)
      }
      case 'tools.list':
        return this.#services.tools.list()
      case 'fs.read': {
        const path = this.#requirePath(args, 'fs.read')
        const check = checkFs(this.#capabilities, 'read', path, this.#moduleDir)
        if (!check.ok) throw this.#denied(nodeId, 'fs.read', path, check.reason)
        return this.#services.fs.read(path)
      }
      case 'fs.write': {
        const path = this.#requirePath(args, 'fs.write')
        const data = isRecord(args) ? args['data'] : undefined
        if (typeof data !== 'string') throw new Error('fs.write requires string data')
        const check = checkFs(this.#capabilities, 'write', path, this.#moduleDir)
        if (!check.ok) throw this.#denied(nodeId, 'fs.write', path, check.reason)
        return this.#services.fs.write(path, data)
      }
      case 'net.request':
        return this.#netRequest(nodeId, args)
      case 'approval.request': {
        if (!isRecord(args)) throw new Error('approval.request requires a request object')
        // Service calls wrap the request with their runId; a node sends the
        // bare ApprovalRequest (which has no `runId` + nested `request` pair).
        const fromService = typeof args['runId'] === 'string' && isRecord(args['request'])
        const runId = fromService ? (args['runId'] as string) : 'module'
        const request = (fromService ? args['request'] : args) as unknown as ApprovalRequest

        let approval: ApprovalService | undefined
        if (fromService) {
          approval = this.#services.approvalFor?.(runId)
          if (approval === undefined) {
            const message = `approval.request is not available for run "${runId}": the host resolved no approval channel`
            this.#reportDenied('approval.request', message)
            throw new Error(message)
          }
        } else {
          approval = this.#services.approval
        }

        const decision: ApprovalDecision = await approval.request(request, { runId, nodeId })
        if (decision !== 'allowed-once') {
          this.#reportDenied('approval.request', `approval was ${decision}`)
          // A service has no node-level policy to fall back on, so a refusal is
          // an error: it cannot proceed by accident.
          if (fromService) {
            throw new Error(`approval was ${decision} for run "${runId}"`)
          }
        }
        return decision
      }
      default:
        this.#reportDenied('unsupported', `unknown capability call "${method}"`)
        throw new Error(`unknown capability call "${method}"`)
    }
  }

  async #netRequest(nodeId: string, args: unknown): Promise<unknown> {
    if (!isRecord(args)) throw new Error('net.request requires { url, method?, headers?, body? }')
    const url = args['url']
    if (typeof url !== 'string') throw new Error('net.request requires a url string')

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`net.request url is not valid: ${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`net.request only supports http(s), not "${parsed.protocol}"`)
    }

    const check = checkNet(this.#capabilities, parsed.hostname)
    if (!check.ok) throw this.#denied(nodeId, 'net.request', parsed.hostname, check.reason)

    const init: RequestInit = {
      method: typeof args['method'] === 'string' ? args['method'].toUpperCase() : 'GET',
      headers: this.#requestHeaders(args['headers']),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
    if (typeof args['body'] === 'string') init.body = args['body']

    const response = await fetch(parsed, init)
    const { body, truncated } = await readBody(response)
    return {
      status: response.status,
      headers: headersRecord(response.headers),
      body,
      truncated,
    }
  }

  #requestHeaders(raw: unknown): Record<string, string> {
    const headers: Record<string, string> = {}
    if (!isRecord(raw)) return headers
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') headers[key] = value
    }
    return headers
  }

  #requirePath(args: unknown, method: string): string {
    if (!isRecord(args)) throw new Error(`${method} requires a path`)
    const path = args['path']
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`${method} requires a non-empty path string`)
    }
    return path
  }

  /** Report a refusal without deciding how it is surfaced to the module. */
  #reportDenied(kind: string, detail: string): void {
    this.#services.onCapabilityDenied?.({
      moduleId: this.#moduleId,
      version: this.#moduleVersion,
      kind,
      detail,
    })
  }

  /**
   * Refuse a manifest capability the module did not declare, e.g.
   * `capability "llm" not granted for llm.chat (...)`.
   */
  #capabilityDenied(
    nodeId: string,
    capability: 'llm' | 'tools',
    detail: string,
    method: string,
  ): Error {
    const message = `capability "${capability}" not granted for ${method} (${detail})`
    this.#reportDenied(method, message)
    this.#services.onLog?.({ nodeId, level: 'warn', message })
    return new Error(message)
  }

  #denied(nodeId: string, method: string, target: string, reason: string): Error {
    const message = `capability denied for ${method} "${target}": ${reason}`
    // Audit hook: every denial is visible to the host even when the module
    // swallows the error.
    this.#reportDenied(method, message)
    this.#services.onLog?.({ nodeId, level: 'warn', message })
    return new Error(message)
  }
}
