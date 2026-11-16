/**
 * The dispatch gate on the tool boundary.
 *
 * A model emits a tool *name*, and a name is not a capability: whatever the run
 * service has registered would otherwise be callable, including modules the
 * graph was never meant to expose. The advertised set is therefore the
 * allowlist, and a name outside it is rejected before the service is reached.
 *
 * The advertisement is either static (a `z1.core.const` wired into a `tools`
 * port) or live (a node that asks the service, e.g. `z1.tools.list`). Only the
 * static case can be turned into an allowlist: a live inventory *is* the
 * declaration, so the gate stays open and the service's own policy decides.
 *
 * @module @z1/runtime/tool-gate
 */

import type { GraphDocument, GraphNode } from '@z1/graph'
import type { Json } from '@z1/node'
import type { RuntimeServices, ToolService } from './types.ts'

/** How deep `config.graph` / `config.body` nesting is followed. */
const MAX_NESTED_DEPTH = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGraphShaped(value: unknown): value is GraphDocument {
  return isRecord(value) && Array.isArray(value['nodes']) && Array.isArray(value['edges'])
}

/** Tool names a `tools` port declaration names, or `undefined` when it is dynamic. */
function declaredNames(node: GraphNode): readonly string[] | undefined {
  // Only a `const` has a value the graph can be read for. Anything else is
  // computed at run time (the live list), so the declaration is not static.
  if (node.type !== 'z1.core.const' || !isRecord(node.config)) return undefined
  const value = node.config['value']
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const name = entry['name']
    if (typeof name !== 'string') return undefined
    names.push(name)
  }
  return names
}

/**
 * The tool names the graph advertises to a model, or `undefined` when the run
 * has no static declaration and the gate must stay open.
 *
 * Every data edge into a port named `tools` is a declaration: the agent's chat
 * and compaction nodes both take one. One dynamic source (or one source that is
 * not a tool list) makes the whole run dynamic: a partially known allowlist
 * would silently block tools the model was told about.
 */
export function declaredToolNames(graph: GraphDocument): readonly string[] | undefined {
  const collected: string[] = []
  let found = false

  const visit = (current: GraphDocument, depth: number): boolean => {
    for (const node of current.nodes) {
      if (!isRecord(node.config)) continue
      for (const key of ['graph', 'body'] as const) {
        const nested = node.config[key]
        if (!isGraphShaped(nested) || depth + 1 > MAX_NESTED_DEPTH) continue
        if (!visit(nested, depth + 1)) return false
      }
    }

    const byId = new Map(current.nodes.map((node) => [node.id, node]))
    for (const edge of current.edges) {
      if (edge.kind !== 'data' || edge.to.port !== 'tools') continue
      const source = byId.get(edge.from.node)
      // A dangling edge is a validation error, not a declaration.
      if (source === undefined) continue
      const names = declaredNames(source)
      if (names === undefined) return false
      found = true
      for (const name of names) if (!collected.includes(name)) collected.push(name)
    }
    return true
  }

  return visit(graph, 0) && found ? collected : undefined
}

/**
 * Wrap a tool service so only `allowed` names are dispatched. `undefined`
 * returns the service untouched (no declaration means no additional gate).
 */
export function gateToolService(
  tools: ToolService,
  allowed: readonly string[] | undefined,
): ToolService {
  if (allowed === undefined) return tools
  const names = new Set(allowed)
  return {
    async call(name: string, args: Json): Promise<Json> {
      if (!names.has(name)) throw new Error(`tool "${name}" is not available in this run`)
      return await tools.call(name, args)
    },
    async list() {
      // Do not advertise what this run would refuse: the prompt and the gate
      // must describe the same toolset.
      return (await tools.list()).filter((schema) => names.has(schema.name))
    },
  }
}

/** Apply {@link gateToolService} to a run's services. */
export function withToolGate(
  services: RuntimeServices,
  allowed: readonly string[] | undefined,
): RuntimeServices {
  if (allowed === undefined) return services
  return { ...services, tools: gateToolService(services.tools, allowed) }
}
