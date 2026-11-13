import type { InstalledModule, ModuleNodeDeclaration, ModuleStore } from '@z1/module'
import { NodeRegistry } from '@z1/node'
import { moduleNodeDefinition } from './adapter.ts'
import {
  ModuleWorker,
  type WorkerCapabilityDenial,
  type WorkerHostServices,
} from './host.ts'

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
}

/**
 * Bridges the local module store to the node registry: every active installed
 * module gets one worker, and each declared node becomes a runtime
 * `NodeDefinition` backed by that worker.
 *
 * Loading is all-or-nothing: a module that cannot start (or disagrees with its
 * manifest) disposes the workers already spawned and rejects, so a run never
 * sees a half-populated registry.
 */
export class ModuleRuntime {
  readonly #options: ModuleRuntimeOptions
  readonly #registry: NodeRegistry
  readonly #workers: ModuleWorker[] = []
  #startPromise: Promise<NodeRegistry> | undefined
  #disposePromise: Promise<void> | undefined

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
        // A service-only module has no node worker: `@z1/node-host/services`
        // imports it in-process instead.
        if (installed.manifest.nodes.length === 0) continue
        await this.#load(installed)
      }
    } catch (error) {
      await this.dispose()
      throw error
    }
    return this.#registry
  }

  async #load(installed: InstalledModule): Promise<void> {
    const { id: moduleId, version } = installed.manifest
    const worker = new ModuleWorker({
      moduleDir: installed.directory,
      entry: installed.manifest.entry,
      manifestNodeIds: installed.manifest.nodes.map((node) => node.id),
      capabilities: installed.manifest.capabilities ?? {},
      services: this.#services(),
      moduleId,
      moduleVersion: version,
      ...(installed.manifest.limits?.timeoutMs !== undefined
        ? { timeoutMs: installed.manifest.limits.timeoutMs }
        : {}),
      ...(installed.manifest.limits?.memoryMb !== undefined
        ? { maxMemoryMb: installed.manifest.limits.memoryMb }
        : {}),
    })
    this.#workers.push(worker)

    let exported: readonly { id: string; version: string }[]
    try {
      exported = await worker.start()
    } catch (error) {
      throw new Error(
        `cannot start module "${moduleId}"@${version}: ${errorMessage(error)}`,
      )
    }

    const declared = new Map<string, ModuleNodeDeclaration>(
      installed.manifest.nodes.map((node) => [node.id, node]),
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

    for (const declaration of installed.manifest.nodes) {
      if (this.#registry.has(declaration.id, declaration.version)) {
        throw new Error(
          `module "${moduleId}"@${version} declares node "${declaration.id}"@${declaration.version}, which is already registered`,
        )
      }
      try {
        this.#registry.register(moduleNodeDefinition(declaration, worker))
      } catch (error) {
        throw new Error(
          `module "${moduleId}"@${version} cannot register node "${declaration.id}": ${errorMessage(error)}`,
        )
      }
    }
  }

  #services(): WorkerHostServices {
    const services = this.#options.services
    const hook = this.#options.onCapabilityDenied
    if (hook === undefined) return services
    return {
      ...services,
      onCapabilityDenied: (info) => {
        services.onCapabilityDenied?.(info)
        hook(info)
      },
    }
  }

  /** Stop every worker. Safe to call more than once, including before start(). */
  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    const workers = this.#workers.splice(0)
    await Promise.allSettled(workers.map((worker) => worker.dispose()))
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
