import { z } from 'zod'
import type { core } from 'zod'
import type { NodeDefinition, PortSpec } from './types.ts'

/**
 * Thrown when a node's raw config cannot be parsed by its own schema. It carries
 * the node type and the zod issues so the CLI can point at the offending field
 * without re-parsing or string-matching the message.
 */
export class NodeConfigError extends Error {
  readonly nodeType: string
  readonly issues: readonly core.$ZodIssue[]

  constructor(nodeType: string, issues: readonly core.$ZodIssue[]) {
    const first = issues[0]
    super(
      first === undefined
        ? `invalid config for node "${nodeType}"`
        : `invalid config for node "${nodeType}": ${first.path.join('.') || '(root)'}: ${first.message}`,
    )
    this.name = 'NodeConfigError'
    this.nodeType = nodeType
    this.issues = issues
  }
}

/**
 * JSON Schema for a data port, used by the canvas to render a typed handle.
 * Zod cannot represent every schema (dates, transforms, custom refinements), so
 * a conversion failure degrades to the permissive `{}` rather than breaking the
 * whole node listing.
 */
export function portJsonSchema(port: PortSpec): Record<string, unknown> | undefined {
  if (port.kind === 'flow') return undefined
  try {
    const schema = z.toJSONSchema(port.schema, { io: 'output' })
    return schema as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * JSON Schema for a node's config object, used by the inspector form. `input`
 * mode is the one that matters: it describes what a human may type, so
 * defaults are not baked in as `const`. A schema zod cannot convert degrades to
 * `{}` for the same reason ports do.
 */
export function configJsonSchema(definition: NodeDefinition): Record<string, unknown> {
  try {
    const schema = z.toJSONSchema(definition.config, { io: 'input' })
    const record = schema as unknown as Record<string, unknown>
    // A schema that constrains nothing (`z.unknown()`, which is how a module
    // declaration is stubbed) is reported as `{}`: the canvas treats an empty
    // schema as "free-form JSON" and must not see a lone `$schema` marker.
    const keys = Object.keys(record)
    if (keys.length === 0 || (keys.length === 1 && keys[0] === '$schema')) return {}
    return record
  } catch {
    return {}
  }
}

/** Parse and normalise a node's config; throws {@link NodeConfigError} on failure. */
export function parseNodeConfig(definition: NodeDefinition, config: unknown): unknown {
  const result = definition.config.safeParse(config)
  if (!result.success) {
    throw new NodeConfigError(definition.id, result.error.issues)
  }
  return result.data
}

/**
 * Validate a value arriving on a port. Flow ports are control edges: they carry
 * a boolean enable signal, so a data schema is not involved.
 */
export function parsePortValue(port: PortSpec, value: unknown): unknown {
  if (port.kind === 'flow') {
    if (typeof value !== 'boolean') {
      throw new TypeError(`flow port "${port.id}" expects a boolean, got ${typeof value}`)
    }
    return value
  }
  return port.schema.parse(value)
}
