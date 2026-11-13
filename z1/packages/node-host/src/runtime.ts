import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  InstalledModule,
  ModuleNodeDeclaration,
  ModuleServiceDeclaration,
  ModuleServiceKind,
  ModuleStore,
} from '@z1/module'
import { serviceMode } from '@z1/module'
import { NodeRegistry } from '@z1/node'
import type { ApprovalService } from '@z1/runtime'
import { moduleNodeDefinition } from './adapter.ts'
import {
  workerArtifactService,
  workerFsService,
  workerLlmService,
  workerMemoryService,
  workerToolService,
} from './adapters.ts'
import {
  ModuleWorker,
  type StartedWorker,
  type WorkerCapabilityDenial,
  type WorkerHostServices,
} from './host.ts'
import type { WorkerNodeInfo, WorkerServiceInfo } from './protocol.ts'

export interface ModuleRuntimeOptions {
  store: ModuleStore
  /** Host services brokered to every module worker. */
  services: WorkerHostServices
  /** Registry to extend; a fresh one when omitted. */
  baseRegistry?: NodeRegistry
  /**
   * Notification hook for host-side capability denials. Registered alongside
   * the services' own hook; the CLI uses it to append to the audit log.
   */
  onCapabilityDenied?: (info: WorkerCapabilityDenial) => void
  /**
   * Instantiate each module's worker-mode services in its child. Defaults to
   * `true`; `false` keeps every worker node-only, so no service factory runs.
   */
  loadServices?: boolean
  /**
   * Approval channel for service-originated requests, resolved per run. Wins
   * over `services.approvalFor` when both are present.
   */
  approvalFor?: (runId: string) => ApprovalService | undefined
}

/** One service a module provides, as the host sees it. */
export interface ModuleWorkerService {
  kind: ModuleServiceKind
  /** The host-side adapter over the worker (`llm`, `tools`, …). */
  instance: unknown
}

/** What a module's single worker needs, kept so a respawn reuses the shape. */
interface ModuleSlot {
  readonly installed: InstalledModule
  /** Manifest node ids; the child may export a subset. */
  readonly nodeIds: readonly string[]
  /** Worker-mode services the grant approved (empty when none are loaded). */
  readonly services: readonly ModuleServiceDeclaration[]
  readonly loadServices: boolean
  readonly capabilities: InstalledModule['grant']['capabilities']
  worker: ModuleWorker | undefined
  starting: Promise<ModuleWorker> | undefined
  /** Set while the newest child has not reached `ready`. */
  failure: Error | undefined
  /** True once the node definitions are in the registry. */
  registered: boolean
}

/**
 * Bridges the local module store to the node registry and to service
 * consumers.
 *
 * Every active installed module gets **one** child process. That child hosts
 * both the module's nodes and its worker-mode services, so a node and its
 * module's `llm` service share a `process.pid` and one sandbox. Nodes map to
 * runtime `NodeDefinition`s bound to a worker getter, so a respawn after a
 * crash does not leave a stale definition behind.
 *
 * Loading is all-or-nothing: a module that cannot start (or disagrees with its
 * manifest) disposes the workers already spawned and rejects, so a run never
 * sees a half-populated registry.
 */
export class ModuleRuntime {
  readonly #options: ModuleRuntimeOptions
  readonly #registry: NodeRegistry
  readonly #slots = new Map<string, ModuleSlot>()
  #startPromise: Promise<NodeRegistry> | undefined
  #disposePromise: Promise<void> | undefined
  #disposed = false

  constructor(options: ModuleRuntimeOptions) {
    this.#options = options
    this.#registry = options.baseRegistry ?? new NodeRegistry()
  }

  /** The registry that holds built-ins plus module nodes. */
  registry(): NodeRegistry {
    return this.#registry
  }

  start(): Promise<NodeRegistry> {
    if (this.#disposePromise !== undefined) {
      return Promise.reject(new Error('module runtime has been disposed'))
    }
    this.#startPromise ??= this.#start()
    return this.#startPromise
  }

  async #start(): Promise<NodeRegistry> {
    const active = this.#options.store.list().filter((module) => module.active)
    try {
      for (const installed of active) {
        const slot = this.#slotFor(installed)
        // Nothing to run: no nodes and no approved services.
        if (slot === undefined) continue
        await this.#ensureWorker(slot)
      }
    } catch (error) {
      await this.dispose()
      throw error
    }
    return this.#registry
  }

  /**
   * The module's live worker, respawning it when the previous child exited.
   *
   * `undefined` when the module is unknown, unloaded (no nodes, no granted
   * services) or the runtime is disposed. A respawn is initiated here; calls
   * made on the returned worker wait for its handshake, and a failure to boot
   * surfaces as the call's rejection.
   */
  workerFor(moduleId: string): ModuleWorker | undefined {
    const slot = this.#slots.get(moduleId)
    if (slot === undefined) return undefined
    return this.#workerForSlot(slot)
  }

  /**
   * Host-side adapters for the module's worker-mode services, built lazily
   * from its one worker. Calls made through an instance address the current
   * child, including after a respawn.
   *
   * `runId` is attached to every service call, so an approval the service asks
   * for resolves through the run that is actually consuming it.
   */
  servicesFor(
    moduleId: string,
    options: { runId?: string } = {},
  ): Readonly<Record<string, ModuleWorkerService>> {
    const slot = this.#slots.get(moduleId)
    if (slot === undefined) return {}
    if (this.#disposed) return {}
    const worker = this.#workerForSlot(slot)
    const services: Record<string, ModuleWorkerService> = {}
    for (const declaration of slot.services) {
      services[declaration.id] = {
        kind: declaration.kind,
        instance: adaptService(declaration.kind, worker, declaration.id, options.runId),
      }
    }
    return services
  }

  /** Stop every worker. Safe to call more than once, including before start(). */
  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    this.#disposed = true
    const workers: ModuleWorker[] = []
    for (const slot of this.#slots.values()) {
      if (slot.worker !== undefined) workers.push(slot.worker)
    }
    this.#slots.clear()
    await Promise.allSettled(workers.map((worker) => worker.dispose()))
  }

  /** Build the slot for a freshly seen module; `undefined` when inert. */
  #slotFor(installed: InstalledModule): ModuleSlot | undefined {
    const existing = this.#slots.get(installed.manifest.id)
    if (existing !== undefined) return existing

    const nodeIds = installed.manifest.nodes.map((node) => node.id)
    const granted = this.#grantedWorkerServices(installed)
    const loadServices = (this.#options.loadServices ?? true) && granted.length > 0
    const services = loadServices ? granted : []
    if (nodeIds.length === 0 && services.length === 0) {
      // A service-only module with no approved service has nothing to start;
      // spawning a node-less worker would only make it fail its own handshake.
      return undefined
    }

    const slot: ModuleSlot = {
      installed,
      nodeIds,
      services,
      loadServices,
      capabilities: installed.grant?.capabilities ?? installed.manifest.capabilities ?? {},
      worker: undefined,
      starting: undefined,
      failure: undefined,
      registered: false,
    }
    this.#slots.set(installed.manifest.id, slot)
    return slot
  }

  /**
   * The module's worker-mode services. The grant is the approval record, so it
   * decides: a service the grant omits is never started.
   */
  #grantedWorkerServices(installed: InstalledModule): ModuleServiceDeclaration[] {
    const grant = installed.grant
    const declared = grant !== undefined ? grant.services : (installed.manifest.services ?? [])
    return declared.filter((declaration) => serviceMode(declaration) === 'worker')
  }

  async #ensureWorker(slot: ModuleSlot): Promise<ModuleWorker> {
    const worker = slot.worker
    if (worker !== undefined) {
      if (worker.state === 'ready') return worker
      if (worker.state === 'starting') return await this.#awaitStart(slot)
      if (worker.state === 'disposed') throw new Error(this.#startFailure(slot))
    }
    return await this.#startSlot(slot)
  }

  #workerForSlot(slot: ModuleSlot): ModuleWorker {
    const worker = slot.worker
    if (worker !== undefined && (worker.state === 'ready' || worker.state === 'starting')) {
      return worker
    }
    if (this.#disposed) {
      throw new Error(
        `module runtime has been disposed; cannot respawn module "${slot.installed.manifest.id}"`,
      )
    }
    // Fail before spawning when the payload is gone: a synchronous error here
    // is much clearer than a handshake timeout later.
    const { id, version, entry } = slot.installed.manifest
    const entryPath = resolve(slot.installed.directory, entry)
    if (!existsSync(entryPath)) {
      throw new Error(
        `cannot respawn module "${id}"@${version}: module entry not found: ${entryPath}`,
      )
    }
    return this.#respawn(slot)
  }

  /** Spawn a child and wait for its handshake (initial load). */
  async #startSlot(slot: ModuleSlot): Promise<ModuleWorker> {
    const { worker, starting } = this.#begin(slot)
    await starting
    return worker
  }

  /**
   * Spawn a child and return it at once; calls on it wait for readiness.
   * Used by lazy respawns, which are triggered by a synchronous getter.
   */
  #respawn(slot: ModuleSlot): ModuleWorker {
    return this.#begin(slot).worker
  }

  #begin(slot: ModuleSlot): { worker: ModuleWorker; starting: Promise<ModuleWorker> } {
    const worker = this.#spawn(slot)
    const starting = this.#collect(slot, worker)
    // Keep the rejection reachable without marking it unhandled when nobody
    // awaits the slot promise (a respawn is triggered by a sync getter).
    void starting.catch(() => undefined)
    slot.starting = starting
    return { worker, starting }
  }

  async #awaitStart(slot: ModuleSlot): Promise<ModuleWorker> {
    const starting = slot.starting
    if (starting === undefined) {
      throw new Error(this.#startFailure(slot))
    }
    return await starting
  }

  /** Create the child and re-register the module's nodes idempotently. */
  #spawn(slot: ModuleSlot): ModuleWorker {
    const { id: moduleId, version, limits } = slot.installed.manifest
    const worker = new ModuleWorker({
      moduleDir: slot.installed.directory,
      entry: slot.installed.manifest.entry,
      manifestNodeIds: [...slot.nodeIds],
      manifestServiceIds: slot.services.map((declaration) => declaration.id),
      loadServices: slot.loadServices,
      capabilities: slot.capabilities,
      services: this.#services(),
      moduleId,
      moduleVersion: version,
      ...(limits?.timeoutMs !== undefined ? { timeoutMs: limits.timeoutMs } : {}),
      ...(limits?.memoryMb !== undefined ? { maxMemoryMb: limits.memoryMb } : {}),
    })
    slot.worker = worker
    slot.failure = undefined
    return worker
  }

  /**
   * Wait for a spawned child's handshake, then validate what it exports and
   * (re)collect its services. Rejects with the module's start error.
   */
  async #collect(slot: ModuleSlot, worker: ModuleWorker): Promise<ModuleWorker> {
    let started: StartedWorker
    try {
      started = await worker.startAll()
    } catch (error) {
      const failure = new Error(this.#startFailure(slot, error))
      slot.failure = failure
      throw failure
    }
    try {
      this.#validateNodes(slot, started.nodes)
      this.#validateServices(slot, started.services)
      this.#registerNodes(slot)
    } catch (error) {
      const failure = new Error(this.#startFailure(slot, error))
      slot.failure = failure
      throw failure
    }
    slot.failure = undefined
    return worker
  }

  #startFailure(slot: ModuleSlot, error?: unknown): string {
    const { id, version } = slot.installed.manifest
    const reason =
      error !== undefined
        ? errorMessage(error)
        : (slot.failure?.message ?? 'worker is not available')
    return `cannot start module "${id}"@${version}: ${reason}`
  }

  /** Exported ids and versions must match the declarations the grant approved. */
  #validateNodes(slot: ModuleSlot, exported: readonly WorkerNodeInfo[]): void {
    const { id: moduleId, version } = slot.installed.manifest
    const declared = new Map<string, ModuleNodeDeclaration>(
      slot.installed.manifest.nodes.map((node) => [node.id, node]),
    )
    for (const info of exported) {
      const declaration = declared.get(info.id)
      if (declaration === undefined) {
        throw new Error(
          `module "${moduleId}"@${version} exports node "${info.id}", which the manifest does not declare`,
        )
      }
      if (declaration.version !== info.version) {
        throw new Error(
          `module "${moduleId}"@${version} exports node "${info.id}"@${info.version}, but the manifest declares ${declaration.version}`,
        )
      }
    }
  }

  /** A grant only covers the services its manifest declared, and vice versa. */
  #validateServices(slot: ModuleSlot, exported: readonly WorkerServiceInfo[]): void {
    const { id: moduleId, version } = slot.installed.manifest
    const allowed = new Set(slot.services.map((declaration) => declaration.id))
    const seen = new Set<string>()
    for (const service of exported) {
      if (seen.has(service.id)) {
        throw new Error(`module "${moduleId}"@${version} exports service "${service.id}" twice`)
      }
      seen.add(service.id)
      if (!allowed.has(service.id)) {
        throw new Error(
          `module "${moduleId}"@${version} exports service "${service.id}", which the grant does not include`,
        )
      }
    }
  }

  /**
   * Register the module's nodes once, bound to a worker getter: after a
   * respawn the same definition reaches the new child.
   */
  #registerNodes(slot: ModuleSlot): void {
    if (slot.registered || slot.nodeIds.length === 0) return
    const { id: moduleId, version } = slot.installed.manifest
    for (const declaration of slot.installed.manifest.nodes) {
      if (this.#registry.has(declaration.id, declaration.version)) {
        throw new Error(
          `module "${moduleId}"@${version} declares node "${declaration.id}"@${declaration.version}, which is already registered`,
        )
      }
      try {
        this.#registry.register(
          moduleNodeDefinition(declaration, () => {
            const worker = this.workerFor(moduleId)
            if (worker === undefined) {
              throw new Error(
                `module "${moduleId}" is not loaded; no worker is available for node "${declaration.id}"`,
              )
            }
            return worker
          }),
        )
      } catch (error) {
        throw new Error(
          `module "${moduleId}"@${version} cannot register node "${declaration.id}": ${errorMessage(error)}`,
        )
      }
    }
    slot.registered = true
  }

  #services(): WorkerHostServices {
    const services = this.#options.services
    const hook = this.#options.onCapabilityDenied
    const approvalFor = this.#options.approvalFor ?? services.approvalFor
    if (hook === undefined && approvalFor === services.approvalFor) return services
    return {
      ...services,
      ...(approvalFor !== undefined ? { approvalFor } : {}),
      ...(hook !== undefined
        ? {
            onCapabilityDenied: (info: WorkerCapabilityDenial) => {
              services.onCapabilityDenied?.(info)
              hook(info)
            },
          }
        : {}),
    }
  }
}

/** Host-side adapter for one worker-mode service kind. */
function adaptService(
  kind: ModuleServiceKind,
  worker: ModuleWorker,
  serviceId: string,
  runId?: string,
): unknown {
  switch (kind) {
    case 'llm':
      return workerLlmService(worker, serviceId, runId)
    case 'tools':
      return workerToolService(worker, serviceId, runId)
    case 'fs':
      return workerFsService(worker, serviceId, runId)
    case 'artifacts':
      return workerArtifactService(worker, serviceId, runId)
    case 'memory':
      return workerMemoryService(worker, serviceId, runId)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
