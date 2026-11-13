/**
 * The composition root: one place that opens the journal, the module store,
 * branch memory and the provider registry, and hands a run its registry and
 * services.
 *
 * A runtime owns **one** `ModuleRuntime` for its whole life: every active
 * module gets a single child process that hosts both its nodes and its granted
 * worker services. Runs share that process; only the services they select and
 * the approvals they register are per run. Host-mode services are imported
 * once into the host process by a `ModuleServiceRuntime`.
 *
 * @module @z1/bootstrap/runtime
 */

import { mkdirSync } from 'node:fs'

import { SqliteJournal } from '@z1/journal'
import { BranchMemory } from '@z1/memory'
import { ModuleStore, compareVersions, serviceMode } from '@z1/module'
import type { InstalledModule, ModuleServiceKind } from '@z1/module'
import type { ApprovalDecision, ApprovalRequest, NodeRegistry } from '@z1/node'
import {
  ModuleRuntime,
  ModuleServiceRuntime,
  StartedServiceRegistry,
  cloneRegistry,
  declarationRegistry,
} from '@z1/node-host'
import type { ModuleServiceLog, WorkerCapabilityDenial } from '@z1/node-host'
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
  /**
   * Identity the run is journaled under. When present, the run's approval is
   * reachable from module code as `approvalFor(runId)` until the handle is
   * disposed.
   */
  runId?: string
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
  /**
   * Per-run switch for service modules, host and worker alike. `false` keeps
   * service adapters out of this run while node modules still execute; `true`
   * uses them even when the runtime config turned them off. Defaults to
   * `RuntimeConfig.useServiceModules`.
   */
  useServiceModules?: boolean
  onEvent?: (event: RunEvent) => void
  onLog?: RuntimeServices['onLog']
}

export interface RunHandle {
  registry: NodeRegistry
  services: RuntimeServices
  /** Unregisters this run's approvals; never stops the shared module workers. */
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
   * Host-process service runtime; `undefined` until a deployment that allows
   * service modules needs it. Worker services live in the shared `ModuleRuntime`.
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

interface ProvidedService {
  moduleId: string
  version: string
  kind: ModuleServiceKind
  serviceId: string
  instance: unknown
  mode: 'host' | 'worker'
}

/**
 * Pick one service per kind. Highest module version wins across host and
 * worker providers; equal versions keep the lower module id. Every decision is
 * logged to stderr so a `--json` run still shows which provider was chosen.
 */
function chooseServices(
  candidates: readonly ProvidedService[],
  log: ModuleServiceLog,
): Partial<Record<ModuleServiceKind, ProvidedService>> {
  const chosen: Partial<Record<ModuleServiceKind, ProvidedService>> = {}
  for (const service of candidates) {
    const current = chosen[service.kind]
    if (current !== undefined) {
      const order = compareVersions(service.version, current.version)
      if (order < 0 || (order === 0 && service.moduleId >= current.moduleId)) {
        log('info', `service ${service.kind} keeps ${current.moduleId}@${current.version}`, {
          ignored: `${service.moduleId}@${service.version}`,
          id: service.serviceId,
        })
        continue
      }
    }
    chosen[service.kind] = service
    log('info', `service ${service.kind} from ${service.moduleId}@${service.version} (${service.mode})`, {
      id: service.serviceId,
    })
  }
  return chosen
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

  const serviceLog: ModuleServiceLog = (level, message, data) => {
    // The choice of provider must be visible even in `--json` runs, so it goes
    // to stderr rather than stdout.
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
    process.stderr.write(`z1: [${level}] ${message}${suffix}\n`)
  }

  // --- approval bridge ----------------------------------------------------

  /**
   * Approvals of the runs currently in `beginRun`. Module code is shared across
   * runs (one child per module), so the run id is the only way to reach the
   * connection that started the call.
   */
  const runApprovals = new Map<string, ApprovalService>()

  /**
   * Resolve a run's approval. Module *nodes* arrive as the pseudo-run
   * `'module'` (the node channel has no run id), which resolves to the most
   * recent live run. A service call that names no run is refused: guessing
   * would let one run answer another's request.
   */
  function approvalForRun(runId: string): ApprovalService | undefined {
    const direct = runApprovals.get(runId)
    if (direct !== undefined) return direct
    if (runId === 'module') {
      let latest: ApprovalService | undefined
      for (const approval of runApprovals.values()) latest = approval
      return latest
    }
    return undefined
  }

  /** The channel module *nodes* use; kept in step with the per-run map. */
  const moduleNodeApproval: ApprovalService = {
    request: async (request: ApprovalRequest, context): Promise<ApprovalDecision> => {
      const approval = approvalForRun('module')
      if (approval === undefined) return 'rejected'
      return await approval.request(request, context)
    },
  }

  // --- persistent module runtime -----------------------------------------

  let moduleRuntime: ModuleRuntime | undefined
  let moduleRuntimeStart: Promise<NodeRegistry> | undefined

  /**
   * The one runtime that owns every module child. Created on first use and
   * reused by every later run; a failed *load* discards it so the next run
   * retries, while a crashed *child* is respawned inside it.
   */
  function moduleRuntimeFor(): ModuleRuntime | undefined {
    if (!config.useModules || !hasActiveModule(modules)) return undefined
    moduleRuntime ??= new ModuleRuntime({
      store: modules,
      services: {
        llm,
        tools: mock.tools,
        fs: mock.fs,
        approval: moduleNodeApproval,
        approvalFor: approvalForRun,
      },
      // A stub would collide with the real definition the worker registers.
      baseRegistry: cloneRegistry(builtins),
      onCapabilityDenied: (info: WorkerCapabilityDenial) => {
        modules.recordDenied(info.moduleId, info.version, `${info.kind}: ${info.detail}`)
      },
      // Nodes and granted worker services share the module's single child.
      loadServices: true,
    })
    return moduleRuntime
  }

  async function startModuleRuntime(runtime: ModuleRuntime): Promise<NodeRegistry> {
    if (moduleRuntimeStart === undefined) {
      const attempt = runtime.start()
      moduleRuntimeStart = attempt
      // Only the current attempt may clear the cache, and a rejected load
      // disposes the object it came from: a later run needs a fresh one.
      void attempt.catch(() => {
        if (moduleRuntimeStart === attempt) {
          moduleRuntimeStart = undefined
          moduleRuntime = undefined
        }
      })
    }
    return await moduleRuntimeStart
  }

  /**
   * Worker-mode service adapters of every active module, taken from the shared
   * `ModuleRuntime`. Built per run — with that run's id attached — so a
   * respawn and a per-run approval are both picked up.
   */
  function workerServices(runId: string | undefined): ProvidedService[] {
    const runtime = moduleRuntime
    if (runtime === undefined) return []
    const provided: ProvidedService[] = []
    for (const installed of modules.list()) {
      if (!installed.active) continue
      const services = runtime.servicesFor(
        installed.manifest.id,
        runId === undefined ? {} : { runId },
      )
      for (const [serviceId, service] of Object.entries(services)) {
        provided.push({
          moduleId: installed.manifest.id,
          version: installed.manifest.version,
          kind: service.kind,
          serviceId,
          instance: service.instance,
          mode: 'worker',
        })
      }
    }
    return provided
  }

  // --- host-mode service modules -----------------------------------------

  let hostRuntime: ModuleServiceRuntime | undefined
  if (config.useModules && config.useServiceModules) hostRuntime = new ModuleServiceRuntime()
  const hostRegistry = new StartedServiceRegistry()

  interface StartedHostModule {
    moduleId: string
    version: string
    started: { services: Record<string, unknown>; dispose(): Promise<void> }
  }
  const startedHostModules: StartedHostModule[] = []
  let providedHostServices: Promise<ProvidedService[]> | undefined

  /**
   * A host runtime exists whenever node modules are allowed: a per-run
   * `useServiceModules: true` must be able to start one even when the config
   * default is off.
   */
  function hostServiceRuntime(): ModuleServiceRuntime | undefined {
    if (!config.useModules) return undefined
    hostRuntime ??= new ModuleServiceRuntime()
    return hostRuntime
  }

  /**
   * Import the **granted** host services of every active module once. The
   * grant is the approval record, so a service the grant omits is never
   * imported; a pre-R3 grant (`services: []`) starts nothing.
   */
  async function ensureHostServices(): Promise<ProvidedService[]> {
    const runtime = hostServiceRuntime()
    if (runtime === undefined) return []
    if (providedHostServices === undefined) {
      const attempt = startHostServices(runtime)
      providedHostServices = attempt
      void attempt.catch(() => {
        if (providedHostServices === attempt) providedHostServices = undefined
      })
    }
    return await providedHostServices
  }

  async function startHostServices(runtime: ModuleServiceRuntime): Promise<ProvidedService[]> {
    const provided: ProvidedService[] = []

    const rollback = async (): Promise<void> => {
      await Promise.allSettled(
        startedHostModules.splice(0).map((entry) => entry.started.dispose()),
      )
      hostRegistry.clear()
    }

    try {
      for (const installed of modules.list()) {
        // A close() while starting must not leave a started service behind
        // with no owner to dispose it.
        if (closed) throw new Error('runtime is closed')
        if (!installed.active) continue

        const granted = installed.grant.services ?? []
        const declarations = granted.filter(
          (declaration) => serviceMode(declaration) === 'host',
        )
        if (declarations.length === 0) continue

        const { id: moduleId, version } = installed.manifest
        // Only the host declarations, and only the grant's capabilities: a
        // mixed module must not import its worker services into the host, and
        // the manifest is a request while the grant is the authority.
        const projected: InstalledModule = {
          ...installed,
          manifest: {
            ...installed.manifest,
            services: [...declarations],
            capabilities: installed.grant.capabilities,
          },
        }
        let started: StartedHostModule['started']
        try {
          started = await runtime.start(projected, { log: serviceLog, registry: hostRegistry })
        } catch (error) {
          throw new Error(
            `cannot start host service module "${moduleId}"@${version}: ${errorMessage(error)}`,
          )
        }
        startedHostModules.push({ moduleId, version, started })
        for (const declaration of declarations) {
          provided.push({
            moduleId,
            version,
            kind: declaration.kind,
            serviceId: declaration.id,
            instance: started.services[declaration.id],
            mode: 'host',
          })
        }
      }
      return provided
    } catch (error) {
      await rollback()
      throw error instanceof Error && error.message === 'runtime is closed'
        ? error
        : new Error(`cannot start service modules: ${errorMessage(error)}`)
    }
  }

  /**
   * One instance per kind for this run. Host services are started once (they
   * are in-process and ambient); worker adapters are rebuilt per run. The
   * choice itself is never cached, so run 1 can ignore services while run 2
   * uses them.
   */
  async function selectServices(
    runId: string | undefined,
  ): Promise<Partial<Record<ModuleServiceKind, ProvidedService>>> {
    const candidates: ProvidedService[] = []
    candidates.push(...(await ensureHostServices()))
    if (closed) throw new Error('runtime is closed')
    candidates.push(...workerServices(runId))
    return chooseServices(candidates, serviceLog)
  }

  const runtime: Runtime = {
    config,
    journal,
    modules,
    memory,
    providers,
    llm,
    get serviceModules(): ModuleServiceRuntime | undefined {
      return hostRuntime
    },
    get templates(): TemplateRegistry {
      return templates()
    },
    get registry(): NodeRegistry {
      return currentRegistry()
    },

    async beginRun(overrides: RunOverrides): Promise<RunHandle> {
      if (closed) throw new Error('runtime is closed')

      let registry: NodeRegistry = cloneRegistry(builtins)
      let services: RuntimeServices | undefined
      const approval = overrides.moduleApproval ?? overrides.approval

      // A run is visible to `close()` from the moment it starts, even though
      // its services and module workers only exist after the first `await`.
      // `dispose()` waits for that startup to settle so a close mid-startup
      // still unregisters the run.
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
            if (overrides.runId !== undefined) {
              // Only remove our own mapping: a resumed run may have re-bound it.
              if (runApprovals.get(overrides.runId) === approval) {
                runApprovals.delete(overrides.runId)
              }
            }
            handles.delete(handle)
          })()
          return disposed
        },
      }
      handles.add(handle)
      if (overrides.runId !== undefined) runApprovals.set(overrides.runId, approval)

      try {
        const shared = moduleRuntimeFor()
        if (shared !== undefined) {
          // Execution uses the real registry; `runtime.registry` keeps the
          // declaration stubs for validation and `node.list`.
          registry = await startModuleRuntime(shared)
        }
        if (closed) throw new Error('runtime is closed')

        // `--no-modules` disables host *and* worker services: it removes the
        // module layer, not just node execution.
        const useServiceModules =
          config.useModules && (overrides.useServiceModules ?? config.useServiceModules)
        const provided = useServiceModules ? await selectServices(overrides.runId) : {}

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
        // The persistent runtime is disposed exactly once, after every run has
        // unregistered: node executions and worker services share it.
        await moduleRuntime?.dispose()
        moduleRuntime = undefined
        moduleRuntimeStart = undefined
        await Promise.allSettled(
          startedHostModules.splice(0).map((entry) => entry.started.dispose()),
        )
        hostRegistry.clear()
        providedHostServices = undefined
        journal.close()
      })()
      return await closing
    },
  }

  return runtime
}
