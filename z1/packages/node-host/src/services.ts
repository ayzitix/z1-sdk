/**
 * Trusted in-process service modules.
 *
 * Unlike node modules, which run in a child worker, a *host-mode* service
 * module is imported into the host process: it replaces an ambient capability
 * (`llm`, `tools`, …) that every node already uses. There is therefore no
 * capability broker between the service and the host. Approving the module is
 * the security decision; a host declaration must say `trusted: true`, and this
 * runtime never pretends it is a sandbox. Worker-mode services use the child
 * process instead and are adapted by `./adapters.ts`.
 *
 * @module @z1/node-host/services
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  InstalledModule,
  ModuleServiceDeclaration,
  ModuleServiceKind,
} from '@z1/module'

export type ModuleServiceLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type ModuleServiceLog = (
  level: ModuleServiceLogLevel,
  message: string,
  data?: unknown,
) => void

/** The `ctx` every service factory receives. */
export interface ModuleServiceContext {
  moduleId: string
  version: string
  directory: string
  /** Per-module config; v1 manifests carry no config, so this is `{}`. */
  config: Record<string, unknown>
  log: ModuleServiceLog
  /** Resolve another already-started service by declaration id. */
  get(name: string): unknown
}

export type ModuleServiceFactory = (ctx: ModuleServiceContext) => unknown

/** What a service module's entry may export alongside `nodes`. */
export interface ModuleServiceEntrypoints {
  services?: Record<string, unknown>
}

export interface ModuleServiceEnvironment {
  config?: Record<string, unknown>
  log?: ModuleServiceLog
  /** Lookup across services started earlier by the host. */
  get?: (name: string) => unknown
}

export interface StartedModuleServices {
  /** Keyed by the manifest's service `id`. */
  services: Record<string, unknown>
  /** Idempotent; calls every instance's optional `dispose()`. */
  dispose(): Promise<void>
}

/** Methods a service of each kind must expose. */
const REQUIRED_METHODS: Record<ModuleServiceKind, readonly string[]> = {
  llm: ['chat'],
  tools: ['call', 'list'],
  fs: ['read', 'write'],
  artifacts: ['put', 'get'],
  memory: ['buildContext'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describe(moduleId: string, version: string): string {
  return `module "${moduleId}"@${version}`
}

function checkInstance(
  instance: Record<string, unknown>,
  declaration: ModuleServiceDeclaration,
  moduleId: string,
  version: string,
): void {
  for (const method of REQUIRED_METHODS[declaration.kind]) {
    if (typeof instance[method] !== 'function') {
      throw new Error(
        `${describe(moduleId, version)} service "${declaration.id}" (${declaration.kind}) must implement ${method}()`,
      )
    }
  }
}

/**
 * Start the services declared by one installed module. All-or-nothing: a
 * missing factory or a wrongly shaped instance disposes whatever already
 * started and rejects, naming the module and service.
 */
export class ModuleServiceRuntime {
  async start(
    installed: InstalledModule,
    env: ModuleServiceEnvironment = {},
  ): Promise<StartedModuleServices> {
    const { id: moduleId, version, entry } = installed.manifest
    const declarations = installed.manifest.services ?? []
    if (declarations.length === 0) {
      return { services: {}, dispose: async () => {} }
    }

    const file = resolve(installed.directory, entry)
    let imported: unknown
    try {
      imported = await import(/* @vite-ignore */ pathToFileURL(file).href)
    } catch (error) {
      throw new Error(`${describe(moduleId, version)} cannot import "${entry}": ${errorMessage(error)}`)
    }

    const exported =
      isRecord(imported) && isRecord(imported['services']) ? imported['services'] : {}
    const log = env.log ?? (() => {})
    const started: Record<string, unknown> = {}
    const disposeFactories: Array<() => Promise<unknown>> = []
    const context = (declaration: ModuleServiceDeclaration): ModuleServiceContext => ({
      moduleId,
      version,
      directory: installed.directory,
      config: env.config ?? {},
      log: (level, message, data) =>
        log(level, `[${moduleId}/${declaration.id}] ${message}`, data),
      get: (name) => started[name] ?? env.get?.(name),
    })

    const disposeAll = async (): Promise<void> => {
      await Promise.allSettled(disposeFactories.map((dispose) => dispose()))
    }

    try {
      for (const declaration of declarations) {
        const factory = exported[declaration.id]
        if (typeof factory !== 'function') {
          throw new Error(
            `${describe(moduleId, version)} declares service "${declaration.id}" (${declaration.kind}) but its entry exports no factory`,
          )
        }

        let instance: unknown
        try {
          instance = await (factory as ModuleServiceFactory)(context(declaration))
        } catch (error) {
          throw new Error(
            `${describe(moduleId, version)} service "${declaration.id}" failed to start: ${errorMessage(error)}`,
          )
        }
        if (!isRecord(instance)) {
          throw new Error(
            `${describe(moduleId, version)} service "${declaration.id}" (${declaration.kind}) did not return an object`,
          )
        }

        checkInstance(instance, declaration, moduleId, version)
        started[declaration.id] = instance

        if (typeof instance['dispose'] === 'function') {
          const dispose = instance['dispose'] as () => unknown
          // Bound to the instance, and deferred so a synchronous throw still
          // lands in `allSettled` rather than escaping `disposeAll`.
          disposeFactories.push(async () => await dispose.call(instance))
        }
      }
    } catch (error) {
      await disposeAll()
      throw error
    }

    let disposed: Promise<void> | undefined
    return {
      services: started,
      dispose: (): Promise<void> => {
        disposed ??= disposeAll()
        return disposed
      },
    }
  }
}
