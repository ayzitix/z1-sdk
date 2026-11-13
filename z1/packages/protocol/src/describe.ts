/**
 * Node catalogue projection for the `node.list` method.
 *
 * The canvas needs plain JSON it can render; a {@link NodeDefinition} carries
 * zod schemas and an `execute` function, so it must never hit the wire. This
 * module is the single place that flattens one into a {@link NodeDescriptor}.
 *
 * @module @z1/protocol/describe
 */

import { configJsonSchema, portJsonSchema, type NodeDefinition, type NodeRegistry, type PortSpec } from '@z1/node'

import type { NodeDescriptor, PortDescriptor } from './types.ts'

/** Describe every registered node, in registry order (all versions). */
export function describeNodes(registry: NodeRegistry): NodeDescriptor[] {
  return registry.list().map((definition) => describeNode(definition))
}

/** Describe one node definition, omitting schemas the canvas cannot use. */
export function describeNode(definition: NodeDefinition): NodeDescriptor {
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    category: definition.category,
    inputs: definition.inputs.map((port) => describePort(port)),
    outputs: definition.outputs.map((port) => describePort(port)),
    // A schema-less definition still gets an object to render, not `undefined`,
    // so the canvas never has to branch on the field's presence.
    configSchema: configJsonSchema(definition),
    defaultConfig: definition.defaultConfig ?? {},
  }
}

function describePort(port: PortSpec): PortDescriptor {
  // Flow ports are control edges: no value, so no schema and no value settings.
  if (port.kind === 'flow') return { id: port.id, kind: 'flow' }

  const schema = portJsonSchema(port)
  const descriptor: PortDescriptor = {
    id: port.id,
    kind: 'data',
    // Mirror the engine defaults so the UI does not have to know them.
    required: port.required ?? true,
    mode: port.mode ?? 'value',
  }
  if (schema !== undefined) descriptor.schema = schema
  return descriptor
}
