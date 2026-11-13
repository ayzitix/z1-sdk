import { z } from 'zod'
import type {
  AutonomyPolicy,
  Capability,
  Json,
  NodeContext,
  NodeDefinition,
  NodeOutputs,
  PortSpec,
} from '@z1/node'
import type {
  DeclaredPort,
  ModuleCapabilities,
  ModuleNodeDeclaration,
} from '@z1/module'
import type { ModuleWorker } from './host.ts'

function toPort(port: DeclaredPort): PortSpec {
  if (port.kind === 'flow') {
    return {
      kind: 'flow',
      id: port.id,
      ...(port.title !== undefined ? { title: port.title } : {}),
      ...(port.description !== undefined ? { description: port.description } : {}),
    }
  }
  return {
    kind: 'data',
    id: port.id,
    schema: z.unknown(),
    ...(port.title !== undefined ? { title: port.title } : {}),
    ...(port.description !== undefined ? { description: port.description } : {}),
    ...(port.required !== undefined ? { required: port.required } : {}),
    ...(port.mode !== undefined ? { mode: port.mode } : {}),
  }
}

/** Translate the manifest vocabulary into executor capabilities. */
export function moduleCapabilities(capabilities: ModuleCapabilities | undefined): Capability[] {
  const result: Capability[] = []
  const read = capabilities?.fs?.read
  if (read !== undefined && read.length > 0) result.push({ kind: 'fs.read', paths: read })
  const write = capabilities?.fs?.write
  if (write !== undefined && write.length > 0) result.push({ kind: 'fs.write', paths: write })
  const hosts = capabilities?.net?.hosts
  if (hosts !== undefined && hosts.length > 0) result.push({ kind: 'net', hosts })
  const spawn = capabilities?.process?.spawn
  if (spawn !== undefined && spawn.length > 0) {
    result.push({ kind: 'process.spawn', commands: spawn })
  }
  const spend = capabilities?.spend
  if (spend !== undefined) {
    result.push({
      kind: 'spend',
      currency: spend.currency,
      ...(spend.perCall !== undefined ? { perCall: spend.perCall } : {}),
      ...(spend.perRun !== undefined ? { perRun: spend.perRun } : {}),
    })
  }
  const secrets = capabilities?.secrets
  if (secrets !== undefined && secrets.length > 0) {
    result.push({ kind: 'secrets', refs: secrets })
  }
  return result
}

/**
 * A module declaration carries no autonomy field yet, so the only meaningful
 * policy is derived from what it is allowed to spend: spending money always
 * asks. Everything else runs automatically.
 */
function toAutonomy(capabilities: ModuleCapabilities | undefined): AutonomyPolicy {
  if (capabilities?.spend !== undefined) {
    return { mode: 'ask', reason: 'module node declares a spend capability' }
  }
  return { mode: 'auto' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The worker a definition talks to, or a getter that resolves the worker at
 * execution time.
 *
 * A runtime that can respawn a module passes the getter: the registered
 * definition then always reaches the live child instead of a dead one.
 */
export type ModuleWorkerSource = ModuleWorker | (() => ModuleWorker)

function resolveWorker(source: ModuleWorkerSource): ModuleWorker {
  return typeof source === 'function' ? source() : source
}

/**
 * Adapt a manifest declaration plus a live {@link ModuleWorker} into a runtime
 * `NodeDefinition`, so module nodes run through the normal executor with the
 * usual config parsing, port validation, caching and approvals.
 *
 * The M4 executor exposes a non-root node's merged data inputs as
 * `ctx.input`; the adapter therefore treats a record `ctx.input` as the port
 * inputs map and forwards it as the module's run seed as well.
 */
export function moduleNodeDefinition(
  declaration: ModuleNodeDeclaration,
  source: ModuleWorkerSource,
): NodeDefinition {
  const capabilities = moduleCapabilities(declaration.capabilities)

  const definition: NodeDefinition = {
    id: declaration.id,
    version: declaration.version,
    title: declaration.title,
    category: declaration.category,
    config: z.unknown(),
    inputs: declaration.inputs.map(toPort),
    outputs: declaration.outputs.map(toPort),
    autonomy: toAutonomy(declaration.capabilities),
    cacheable: false,
    ...(capabilities.length > 0 ? { capabilities } : {}),
    execute: async (ctx: NodeContext<unknown>): Promise<NodeOutputs> => {
      const inputs = isRecord(ctx.input) ? ctx.input : {}
      const outputs = await resolveWorker(source).executeWithHooks(
        declaration.id,
        ctx.config,
        inputs,
        ctx.input,
        ctx.signal,
        {
          onLog: (event) => {
            ctx.log(event.level, event.message, event.data)
          },
          onStream: (event) => {
            ctx.emit(event.port, event.chunk)
          },
        },
      )
      return outputs as NodeOutputs
    },
  }

  return definition
}

/** Kept for callers that build ports by hand; same shape as the adapter uses. */
export function declaredPortToPortSpec(port: DeclaredPort): PortSpec {
  return toPort(port)
}

/** Module outputs are untrusted JSON; the executor re-validates every port. */
export function asJsonOutputs(outputs: Record<string, unknown>): Record<string, Json | undefined> {
  return outputs as Record<string, Json | undefined>
}
