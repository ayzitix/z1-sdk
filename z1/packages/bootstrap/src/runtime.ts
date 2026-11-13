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
import { ModuleStore } from '@z1/module'
import type { NodeRegistry } from '@z1/node'
import {
  ModuleRuntime,
  cloneRegistry,
  declarationRegistry,
} from '@z1/node-host'
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
import { createTemplateRegistry } from './templates.ts'

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
  /** Built-in `agent.loop` plus every static template under `templatesPath`. */
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
 * Open every resource a run may need. Directories are created eagerly so the
 * first `graph.save` or module install cannot fail on a missing directory.
 */
export async function createRuntime(config: RuntimeConfig): Promise<Runtime> {
  mkdirSync(config.graphsPath, { recursive: true })
  mkdirSync(config.modulesPath, { recursive: true })
  mkdirSync(config.templatesPath, { recursive: true })

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
  const templates = createTemplateRegistry(config)

  /** A store projection, so an approval or rollback is visible immediately. */
  function currentRegistry(): NodeRegistry {
    return config.useModules ? declarationRegistry(builtins, modules) : cloneRegistry(builtins)
  }

  const handles = new Set<RunHandle>()
  let closed = false
  let closing: Promise<void> | undefined

  const runtime: Runtime = {
    config,
    journal,
    modules,
    memory,
    providers,
    llm,
    templates,
    get registry(): NodeRegistry {
      return currentRegistry()
    },

    async beginRun(overrides: RunOverrides): Promise<RunHandle> {
      if (closed) throw new Error('runtime is closed')

      const services: RuntimeServices = {
        llm: overrides.llm ?? llm,
        tools: overrides.tools ?? mock.tools,
        fs: overrides.fs ?? mock.fs,
        artifacts: overrides.artifacts ?? mock.artifacts,
        approval: overrides.approval,
        ...(memory === undefined ? {} : { memory }),
        ...(overrides.onEvent === undefined ? {} : { onEvent: overrides.onEvent }),
        ...(overrides.onLog === undefined ? {} : { onLog: overrides.onLog }),
      }

      let moduleRuntime: ModuleRuntime | undefined
      let registry: NodeRegistry
      if (config.useModules && hasActiveModule(modules)) {
        // Workers are per run: a module crash must not poison later runs, and an
        // approval from module code must reach the connection that started it.
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
        try {
          registry = await moduleRuntime.start()
        } catch (error) {
          await moduleRuntime.dispose()
          throw error
        }
      } else {
        registry = cloneRegistry(builtins)
      }

      let disposed: Promise<void> | undefined
      const handle: RunHandle = {
        registry,
        services,
        dispose: (): Promise<void> => {
          disposed ??= (async () => {
            await moduleRuntime?.dispose()
            handles.delete(handle)
          })()
          return disposed
        },
      }
      handles.add(handle)
      return handle
    },

    async close(): Promise<void> {
      closing ??= (async () => {
        closed = true
        await Promise.allSettled([...handles].map((handle) => handle.dispose()))
        journal.close()
      })()
      return await closing
    },
  }

  return runtime
}
