/**
 * One `ToolService` built from several modules that all provide `kind: "tools"`.
 *
 * Unlike every other service kind, tools compose: a filesystem module and a web
 * module each ship a disjoint set of tools and the agent should see both. The
 * composite owns no process and no lifecycle — it holds the per-run instances
 * the caller already selected, so disposing the run (or the shared module
 * runtime) is unchanged.
 *
 * @module @z1/bootstrap/tool-composite
 */

import type { Json, ToolSchema } from '@z1/node'
import type { ModuleServiceLog } from '@z1/node-host'
import type { ToolService } from '@z1/runtime'

/** One module's contribution to the composite. */
export interface ToolServiceMember {
  readonly moduleId: string
  readonly version: string
  readonly instance: ToolService
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Merge the members' tools into one service.
 *
 * `list()` asks every member on every call and returns the concatenation in
 * member order. Schemas are deliberately **not** cached: a member's `list()` is
 * a cheap in-process call (a worker RPC at worst) and a cached copy is exactly
 * the kind of stale inventory that makes the prompt advertise a tool the
 * service no longer has. The name → member routing table *is* cached, because
 * a run's module set is fixed at `beginRun` — service adapters are built there
 * and there is no mid-run install path today — so a second `list()` cannot
 * change who owns a name. A rejected `list()` never hides the others; only a
 * run in which every member fails propagates the first error. The table then
 * keeps the last good inventory, so `call()` still answers until a later
 * `list()` succeeds again.
 */
export function composeToolService(
  members: readonly ToolServiceMember[],
  log: ModuleServiceLog,
): ToolService {
  let routing: Map<string, ToolServiceMember> | undefined
  let building: Promise<void> | undefined

  async function mergedList(): Promise<readonly ToolSchema[]> {
    const schemas: ToolSchema[] = []
    const owners = new Map<string, ToolServiceMember>()
    let failures = 0
    let firstError: unknown

    for (const member of members) {
      let listed: readonly ToolSchema[]
      try {
        listed = await member.instance.list()
      } catch (error) {
        failures += 1
        firstError ??= error
        log(
          'error',
          `service tools: list() from ${member.moduleId}@${member.version} failed: ${errorMessage(error)}`,
        )
        continue
      }
      for (const schema of listed) {
        const owner = owners.get(schema.name)
        if (owner !== undefined) {
          // Never silently shadow: the first member wins, and the loser is named.
          log(
            'warn',
            `service tools: duplicate tool "${schema.name}" from ${member.moduleId}@${member.version} ignored, keeps ${owner.moduleId}@${owner.version}`,
          )
          continue
        }
        owners.set(schema.name, member)
        schemas.push(schema)
      }
    }

    if (failures === members.length && firstError !== undefined) throw firstError
    routing = owners
    return schemas
  }

  /** The routing table, built from `list()` once if `call()` arrives first. */
  async function ensureRouting(): Promise<Map<string, ToolServiceMember> | undefined> {
    if (routing !== undefined) return routing
    if (building === undefined) {
      building = (async () => {
        try {
          await mergedList()
        } finally {
          building = undefined
        }
      })()
    }
    await building
    return routing
  }

  return {
    async list(): Promise<readonly ToolSchema[]> {
      return await mergedList()
    },

    async call(name: string, args: Json): Promise<Json> {
      const owners = await ensureRouting()
      const owner = owners?.get(name)
      if (owner === undefined) throw new Error(`unknown tool "${name}"`)
      return await owner.instance.call(name, args)
    },
  }
}
