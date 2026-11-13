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
import { ModuleStore, compareVersions } from '@z1/module'
import type { ModuleServiceKind } from '@z1/module'
import type { NodeRegistry } from '@z1/node'
import {
  ModuleRuntime,
  ModuleServiceRuntime,
  cloneRegistry,
  declarationRegistry,
} from '@z1/node-host'
import type { ModuleServiceLog } from '@z1/node-host'
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
   * Trusted in-process services of active modules; `undefined` when
   * `useServiceModules` is off. Started lazily by the first `beginRun`.
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
    serviceId: string
    instance: unknown
  }
  interface StartedServiceModule {
    moduleId: string
    version: string
    started: { services: Record<string, unknown>; dispose(): Promise<void> }
  }
  const startedServiceModules: StartedServiceModule[] = []
  const startedById = new Map<string, unknown>()
  let providedServices: Promise<Partial<Record<ModuleServiceKind, ProvidedService>>> | undefined

  const serviceLog: ModuleServiceLog = (level, message, data) => {
    // The choice of provider must be visible even in `--json` runs, so it goes
    // to stderr rather than stdout.
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
    process.stderr.write(`z1: [${level}] ${message}${suffix}\n`)
  }

  /**
   * Start every active module that declares services and resolve one instance
   * per kind. Highest module version wins; ties keep the first module id.
   * Started once per runtime: service instances are ambient, not per-run.
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
        try {
          for (const installed of active) {
            // A close() while starting must not leave a started service behind
            // with no owner to dispose it.
            if (closed) throw new Error('runtime is closed')
            const started = await serviceModules.start(installed, {
              log: serviceLog,
              get: (id) => startedById.get(id),
            })
            startedServiceModules.push({
              moduleId: installed.manifest.id,
              version: installed.manifest.version,
              started,
            })
            if (closed) throw new Error('runtime is closed')
            for (const declaration of installed.manifest.services ?? []) {
              const instance = started.services[declaration.id]
              startedById.set(declaration.id, instance)
              const current = chosen[declaration.kind]
              if (
                current !== undefined &&
                compareVersions(installed.manifest.version, current.version) <= 0
              ) {
                serviceLog('info', `service ${declaration.kind} keeps ${current.moduleId}@${current.version}`, {
                  ignored: `${installed.manifest.id}@${installed.manifest.version}`,
                })
                continue
              }
              chosen[declaration.kind] = {
                moduleId: installed.manifest.id,
                version: installed.manifest.version,
                serviceId: declaration.id,
                instance,
              }
              serviceLog('info', `service ${declaration.kind} from ${installed.manifest.id}@${installed.manifest.version}`, {
                id: declaration.id,
              })
            }
          }
          return chosen
        } catch (error) {
          await Promise.allSettled(startedServiceModules.splice(0).map((entry) => entry.started.dispose()))
          startedById.clear()
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
        startedById.clear()
        journal.close()
      })()
      return await closing
    },
  }

  return runtime
}
