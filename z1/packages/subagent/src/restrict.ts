import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import { SubagentError, type RestrictToolServiceOptions } from './types.ts'

/**
 * Wrap a tool service so only `names` are advertised and callable.
 *
 * `list()` returns exactly the granted schemas, in grant order. `call()` checks
 * the grant before touching `inner`, and then forwards to `inner.call`, so a
 * host guard installed underneath this restriction (for example a live
 * `/tools off` check) still sees and can revoke the call.
 */
export function restrictToolService(
  inner: ToolService,
  names: readonly string[],
  options: RestrictToolServiceOptions = {},
): ToolService {
  const allowed = new Set(names)
  const inventory = options.inventory
  const byName =
    inventory === undefined
      ? undefined
      : new Map(inventory.map((schema) => [schema.name, schema]))

  return {
    async list(): Promise<readonly ToolSchema[]> {
      const schemas = byName === undefined ? await inner.list() : [...byName.values()]
      const available = new Map(schemas.map((schema) => [schema.name, schema]))
      const granted: ToolSchema[] = []
      for (const name of names) {
        const schema = available.get(name)
        if (schema !== undefined) granted.push(schema)
      }
      return granted
    },

    async call(name: string, args: Json): Promise<Json> {
      if (!allowed.has(name)) {
        const list = names.length === 0 ? '(none)' : names.join(', ')
        throw new SubagentError(
          'unknown_tool',
          `tool "${name}" is not granted to this subagent; granted tools: ${list}`,
        )
      }
      if (byName !== undefined && !byName.has(name)) {
        throw new SubagentError(
          'child_tool_missing',
          `tool "${name}" is no longer available to this subagent`,
        )
      }
      if (options.guardCall !== undefined) await options.guardCall(name, args)
      return await inner.call(name, args)
    },
  }
}
