/**
 * The composition root: one place that opens the journal, the module store,
 * branch memory and the provider registry, and hands a run its registry and
 * services.
 *
 * @module @z1/bootstrap/runtime
 */

import { mkdirSync } from 'node:fs'

import { SqliteJournal } from '@z1/journal'
import { BranchMemory } from '@z1/memory'
import { ModuleStore, compareVersions, serviceMode } from '@z1/module'
import type { InstalledModule, ModuleServiceDeclaration, ModuleServiceKind } from '@z1/module'
import type { NodeRegistry } from '@z1/node'
import {
  ModuleRuntime,
  ModuleServiceRuntime,
  ModuleWorker,
  cloneRegistry,
  declarationRegistry,
  workerArtifactService,
  workerFsService,
  workerLlmService,
  workerMemoryService,
  workerToolService,
} from '@z1/node-host'
import type { ModuleServiceLog, StartedWorker, WorkerHostServices } from '@z1/node-host'
import { createBuiltinRegistry } from '@z1/nodes'
import { ProviderRegistry } from '@z1/provider'
import type { TemplateRegistry } from '@z1/template'
import {
  createMockRuntimeServices,
  type ApprovalService,
  type ArtifactService,
  type FsService,
  type LlmService,
  type RunEvent,
  type RuntimeServices,
  type ToolService,
} from '@z1/runtime'

import type { RuntimeConfig } from './config.ts'
import { createAgentTemplateRegistry, createTemplateRegistry } from './templates.ts'

export interface RunOverrides {
  approval: ApprovalService
  /**
   * Approval policy for module code. Module code is less trusted than a graph,
   * so it defaults to `approval` only when a caller does not distinguish them.
   */
  moduleApproval?: ApprovalService
  llm?: LlmService
  tools?: ToolService
  fs?: FsService
  artifacts?: ArtifactService
  onEvent?: (event: RunEvent) => void
  onLog?: RuntimeServices['onLog']
}

export interface RunHandle {
  registry: NodeRegistry
  services: RuntimeServices
  /** Stops this run's module workers; idempotent. */
  dispose(): Promise<void>
}

export interface Runtime {
  readonly config: RuntimeConfig
  readonly journal: SqliteJournal
  readonly modules: ModuleStore
  readonly memory: BranchMemory | undefined
  readonly providers: ProviderRegistry
  readonly llm: LlmService
  /**
   * Services of active modules; `undefined` when `useServiceModules` is off.
   * Host-mode services start in-process, worker-mode ones in a child worker.
   * Started lazily by the first `beginRun`.
   */
  readonly serviceModules: ModuleServiceRuntime | undefined
  /**
   * Built-in `agent.loop` plus every static template under `templatesPath`.
   * Reading this is what loads the static files, so a malformed template only
   * affects commands that actually use templates.
   */
  readonly templates: TemplateRegistry
  /** Builtins + declaration stubs for active modules (no workers). */
  readonly registry: NodeRegistry
  beginRun(overrides: RunOverrides): Promise<RunHandle>
  close(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasActiveModule(store: ModuleStore): boolean {
  return store.list().some((module) => module.active)
}

/**
 * Built-in nodes only. Commands that inventory or validate a graph without
 * running it use this instead of opening a journal for a throwaway runtime.
 */
export function builtinRegistry(): NodeRegistry {
  return createBuiltinRegistry()
}

/**
 * Open every resource a run may need. The journal and module store must exist
 * now; graphs and templates are created on first use so a read-only command
 * (`z1 tree`) leaves no directories behind.
 */
export async function createRuntime(config: RuntimeConfig): Promise<Runtime> {
  mkdirSync(config.modulesPath, { recursive: true })

  const journal = new SqliteJournal(config.dbPath)
  let modules: ModuleStore
  try {
    modules = new ModuleStore(config.modulesPath)
  } catch (error) {
    journal.close()
    throw new Error(`cannot open module store "${config.modulesPath}": ${errorMessage(error)}`)
  }

  const memory = config.useMemory ? new BranchMemory(journal) : undefined
  const mock = createMockRuntimeServices()
  const providers = new ProviderRegistry({
    providers: config.providers,
    env: config.env,
    mock: mock.llm,
  })
  const llm = config.live ? providers.create() : mock.llm
  const builtins = builtinRegistry()
  // The builder template is registered eagerly (no file I/O); static files are
  // read on first access, never at construction: one broken `*.json` must not
  // make `z1 run <graph>` fail. A failed load is not cached, so fixing the file
  // fixes the next command in the same process.
  const agentTemplates = createAgentTemplateRegistry()
  let loadedTemplates: TemplateRegistry = agentTemplates
  function templates(): TemplateRegistry {
    if (loadedTemplates !== agentTemplates) return loadedTemplates
    mkdirSync(config.templatesPath, { recursive: true })
    loadedTemplates = createTemplateRegistry(config)
    return loadedTemplates
  }

  /** A store projection, so an approval or rollback is visible immediately. */
  function currentRegistry(): NodeRegistry {
    return config.useModules ? declarationRegistry(builtins, modules) : cloneRegistry(builtins)
  }

  const handles = new Set<RunHandle>()
  let closed = false
  let closing: Promise<void> | undefined

  const serviceModules = config.useServiceModules ? new ModuleServiceRuntime() : undefined
  interface ProvidedService {
    moduleId: string
    version: string
    kind: ModuleServiceKind
    serviceId: string
    instance: unknown
    /** Set for worker-mode services; absent for in-process ones. */
    worker?: ModuleWorker
  }
  interface StartedServiceModule {
    moduleId: string
    version: string
    started: { services: Record<string, unknown>; dispose(): Promise<void> }
  }
  const startedServiceModules: StartedServiceModule[] = []
  const startedServiceWorkers: ModuleWorker[] = []
  const startedById = new Map<string, unknown>()
  let providedServices: Promise<Partial<Record<ModuleServiceKind, ProvidedService>>> | undefined

  const serviceLog: ModuleServiceLog = (level, message, data) => {
    // The choice of provider must be visible even in `--json` runs, so it goes
    // to stderr rather than stdout.
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
    process.stderr.write(`z1: [${level}] ${message}${suffix}\n`)
  }

  /**
   * A worker service is sandboxed: it may not reach the user for a decision.
   * A refusal is the only answer that cannot escalate its authority.
   */
  const rejectAllApproval: ApprovalService = { request: async () => 'rejected' }

  /** One adapter per kind, all speaking the same `serviceCall` protocol. */
  const SERVICE_ADAPTERS: Record<
    ModuleServiceKind,
    (worker: ModuleWorker, serviceId: string) => unknown
  > = {
    llm: workerLlmService,
    tools: workerToolService,
    fs: workerFsService,
    artifacts: workerArtifactService,
    memory: workerMemoryService,
  }

  /** Host-side services a worker-mode module may call back into. */
  function workerHostServices(installed: InstalledModule): WorkerHostServices {
    const { id, version } = installed.manifest
    return {
      llm,
      tools: mock.tools,
      fs: mock.fs,
      approval: rejectAllApproval,
      onLog: (event) => {
        serviceLog(event.level, `[${id}@${version}] ${event.message}`, event.data)
      },
      onCapabilityDenied: (info) => {
        modules.recordDenied(info.moduleId, info.version, `${info.kind}: ${info.detail}`)
      },
    }
  }

  /**
   * Start one sandboxed worker for a module's worker-mode services.
   *
   * The same entry may also export nodes; the worker is told about them so the
   * handshake agrees with the manifest, but only the services are used here.
   * `ModuleRuntime` still starts its own worker for the nodes, so a module with
   * both gets two children — a known duplication to optimize later.
   */
  async function startWorkerServices(
    installed: InstalledModule,
    declarations: readonly ModuleServiceDeclaration[],
  ): Promise<ProvidedService[]> {
    const manifest = installed.manifest
    const worker = new ModuleWorker({
      moduleDir: installed.directory,
      entry: manifest.entry,
      manifestNodeIds: manifest.nodes.map((node) => node.id),
      manifestServiceIds: declarations.map((declaration) => declaration.id),
      capabilities: manifest.capabilities ?? {},
      services: workerHostServices(installed),
      moduleId: manifest.id,
      moduleVersion: manifest.version,
      ...(manifest.limits?.timeoutMs !== undefined
        ? { timeoutMs: manifest.limits.timeoutMs }
        : {}),
      ...(manifest.limits?.memoryMb !== undefined
        ? { maxMemoryMb: manifest.limits.memoryMb }
        : {}),
    })
    startedServiceWorkers.push(worker)

    let started: StartedWorker
    try {
      started = await worker.startAll()
    } catch (error) {
      throw new Error(
        `cannot start module "${manifest.id}"@${manifest.version} service worker: ${errorMessage(error)}`,
      )
    }

    const exported = new Set(started.services.map((service) => service.id))
    return declarations.map((declaration) => {
      if (!exported.has(declaration.id)) {
        throw new Error(
          `module "${manifest.id}"@${manifest.version} declares service "${declaration.id}" (${declaration.kind}) but its entry exports no factory`,
        )
      }
      return {
        moduleId: manifest.id,
        version: manifest.version,
        kind: declaration.kind,
        serviceId: declaration.id,
        instance: SERVICE_ADAPTERS[declaration.kind](worker, declaration.id),
        worker,
      }
    })
  }

  /** Start the in-process services of a module (the pre-worker path). */
  async function startHostServices(
    installed: InstalledModule,
    declarations: readonly ModuleServiceDeclaration[],
  ): Promise<ProvidedService[]> {
    const hostRuntime = serviceModules
    if (hostRuntime === undefined) throw new Error('service modules are disabled')
    const { id: moduleId, version } = installed.manifest
    // Only the host declarations: a mixed module must not import its worker
    // services into the host process.
    const projected: InstalledModule = {
      ...installed,
      manifest: { ...installed.manifest, services: [...declarations] },
    }
    const started = await hostRuntime.start(projected, {
      log: serviceLog,
      get: (id) => startedById.get(id),
    })
    startedServiceModules.push({ moduleId, version, started })
    return declarations.map((declaration) => ({
      moduleId,
      version,
      kind: declaration.kind,
      serviceId: declaration.id,
      instance: started.services[declaration.id],
    }))
  }

  /**
   * Start every active module that declares services and resolve one instance
   * per kind. Host services are imported in-process, worker services run in a
   * child; the highest module version wins across both, and ties keep the
   * lower module id. Started once per runtime: instances are ambient.
   * A failed attempt is not cached, so fixing a module lets the next run retry.
   */
  async function ensureServiceModules(): Promise<Partial<Record<ModuleServiceKind, ProvidedService>>> {
    if (serviceModules === undefined) return {}
    if (providedServices === undefined) {
      const attempt = (async () => {
        const active = modules
          .list()
          .filter((module) => module.active && (module.manifest.services?.length ?? 0) > 0)
        const chosen: Partial<Record<ModuleServiceKind, ProvidedService>> = {}

        const rollback = async (): Promise<void> => {
          await Promise.allSettled(
            startedServiceModules.splice(0).map((entry) => entry.started.dispose()),
          )
          await Promise.allSettled(
            startedServiceWorkers.splice(0).map((worker) => worker.dispose()),
          )
          startedById.clear()
        }

        try {
          for (const installed of active) {
            // A close() while starting must not leave a started service behind
            // with no owner to dispose it.
            if (closed) throw new Error('runtime is closed')
            const declarations = installed.manifest.services ?? []
            const workerDeclarations = declarations.filter(
              (declaration) => serviceMode(declaration) === 'worker',
            )
            const hostDeclarations = declarations.filter(
              (declaration) => serviceMode(declaration) === 'host',
            )

            const provided: ProvidedService[] = []
            if (workerDeclarations.length > 0) {
              provided.push(...(await startWorkerServices(installed, workerDeclarations)))
            }
            if (closed) throw new Error('runtime is closed')
            if (hostDeclarations.length > 0) {
              provided.push(...(await startHostServices(installed, hostDeclarations)))
            }
            if (closed) throw new Error('runtime is closed')

            for (const service of provided) {
              // `ctx.get(id)` of a host service resolves any declaration by id.
              if (!startedById.has(service.serviceId)) {
                startedById.set(service.serviceId, service.instance)
              }
              const current = chosen[service.kind]
              if (current !== undefined) {
                const order = compareVersions(service.version, current.version)
                if (order < 0 || (order === 0 && service.moduleId >= current.moduleId)) {
                  serviceLog(
                    'info',
                    `service ${service.kind} keeps ${current.moduleId}@${current.version}`,
                    {
                      ignored: `${service.moduleId}@${service.version}`,
                      id: service.serviceId,
                    },
                  )
                  continue
                }
              }
              chosen[service.kind] = service
              serviceLog(
                'info',
                `service ${service.kind} from ${service.moduleId}@${service.version} (${
                  service.worker === undefined ? 'host' : 'worker'
                })`,
                { id: service.serviceId },
              )
            }
          }
          return chosen
        } catch (error) {
          await rollback()
          throw error instanceof Error && error.message === 'runtime is closed'
            ? error
            : new Error(`cannot start service modules: ${errorMessage(error)}`)
        }
      })()
      providedServices = attempt
      // Only the current attempt may clear the cache: a concurrent caller that
      // arrived mid-flight must not see a cleared slot and start a second copy.
      void attempt.catch(() => {
        if (providedServices === attempt) providedServices = undefined
      })
    }
    return providedServices
  }

  const runtime: Runtime = {
    config,
    journal,
    modules,
    memory,
    providers,
    llm,
    serviceModules,
    get templates(): TemplateRegistry {
      return templates()
    },
    get registry(): NodeRegistry {
      return currentRegistry()
    },

    async beginRun(overrides: RunOverrides): Promise<RunHandle> {
      if (closed) throw new Error('runtime is closed')

      let moduleRuntime: ModuleRuntime | undefined
      let registry: NodeRegistry = cloneRegistry(builtins)
      let services: RuntimeServices | undefined

      // A run is visible to `close()` from the moment it starts, even though
      // its services and module workers only exist after the first `await`.
      // `dispose()` waits for that startup to settle so a close mid-startup
      // still disposes what the run created.
      let settleStartup = (): void => {}
      const startup = new Promise<void>((resolve) => {
        settleStartup = resolve
      })
      let disposed: Promise<void> | undefined
      const handle: RunHandle = {
        get registry(): NodeRegistry {
          return registry
        },
        get services(): RuntimeServices {
          if (services === undefined) throw new Error('run services are not ready')
          return services
        },
        dispose: (): Promise<void> => {
          disposed ??= (async () => {
            await startup
            await moduleRuntime?.dispose()
            handles.delete(handle)
          })()
          return disposed
        },
      }
      handles.add(handle)

      try {
        const provided = await ensureServiceModules()
        if (closed) throw new Error('runtime is closed')
        services = {
          llm: overrides.llm ?? (provided.llm?.instance as LlmService | undefined) ?? llm,
          tools:
            overrides.tools ?? (provided.tools?.instance as ToolService | undefined) ?? mock.tools,
          fs: overrides.fs ?? (provided.fs?.instance as FsService | undefined) ?? mock.fs,
          artifacts:
            overrides.artifacts ??
            (provided.artifacts?.instance as ArtifactService | undefined) ??
            mock.artifacts,
          approval: overrides.approval,
          ...(provided.memory === undefined
            ? memory === undefined
              ? {}
              : { memory }
            : { memory: provided.memory.instance as NonNullable<RuntimeServices['memory']> }),
          ...(overrides.onEvent === undefined ? {} : { onEvent: overrides.onEvent }),
          ...(overrides.onLog === undefined ? {} : { onLog: overrides.onLog }),
        }

        if (config.useModules && hasActiveModule(modules)) {
          // Workers are per run: a module crash must not poison later runs, and
          // an approval from module code must reach the connection that started it.
          moduleRuntime = new ModuleRuntime({
            store: modules,
            services: {
              llm: services.llm,
              tools: services.tools,
              fs: services.fs,
              // Deliberately not `services.approval` when the caller separates
              // them: graph autonomy must not silently grant module code rights.
              approval: overrides.moduleApproval ?? overrides.approval,
            },
            // A stub would collide with the real definition the worker registers.
            baseRegistry: cloneRegistry(builtins),
            onCapabilityDenied: (info) => {
              modules.recordDenied(info.moduleId, info.version, `${info.kind}: ${info.detail}`)
            },
          })
          registry = await moduleRuntime.start()
        }
        if (closed) throw new Error('runtime is closed')
        return handle
      } catch (error) {
        settleStartup()
        await handle.dispose()
        throw error
      } finally {
        settleStartup()
      }
    },

    async close(): Promise<void> {
      closing ??= (async () => {
        closed = true
        await Promise.allSettled([...handles].map((handle) => handle.dispose()))
        await Promise.allSettled(
          startedServiceModules.splice(0).map((entry) => entry.started.dispose()),
        )
        // Workers last: a host service may still have been using one.
        await Promise.allSettled(
          startedServiceWorkers.splice(0).map((worker) => worker.dispose()),
        )
        startedById.clear()
        journal.close()
      })()
      return await closing
    },
  }

  return runtime
}
