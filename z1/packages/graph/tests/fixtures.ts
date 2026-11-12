import { z } from 'zod'
import { defineNode, NodeRegistry } from '@z1/node'
import type { Json } from '@z1/node'
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  ValidationIssue,
} from '../src/index.ts'

export const source = defineNode({
  id: 'test.source',
  version: '1.0.0',
  title: 'Source',
  category: 'test',
  config: z.object({}),
  inputs: [],
  outputs: [
    { kind: 'data', id: 'value', schema: z.string() },
    { kind: 'data', id: 'count', schema: z.number() },
    { kind: 'data', id: 'any', schema: z.unknown() },
    { kind: 'data', id: 'maybe', schema: z.string().nullable() },
    { kind: 'flow', id: 'out' },
  ],
  execute: async () => ({}),
})

export const sink = defineNode({
  id: 'test.sink',
  version: '1.0.0',
  title: 'Sink',
  category: 'test',
  config: z.object({}),
  inputs: [
    { kind: 'flow', id: 'in' },
    { kind: 'data', id: 'text', schema: z.string() },
    { kind: 'data', id: 'note', schema: z.string(), required: false },
  ],
  outputs: [],
  execute: async () => ({}),
})

export const numberSink = defineNode({
  id: 'test.numberSink',
  version: '1.0.0',
  title: 'Number sink',
  category: 'test',
  config: z.object({}),
  inputs: [{ kind: 'data', id: 'value', schema: z.number() }],
  outputs: [],
  execute: async () => ({}),
})

export const pass = defineNode({
  id: 'test.pass',
  version: '1.0.0',
  title: 'Pass',
  category: 'test',
  config: z.object({}),
  inputs: [
    { kind: 'flow', id: 'in' },
    { kind: 'data', id: 'value', schema: z.number(), required: false },
  ],
  outputs: [
    { kind: 'flow', id: 'out' },
    { kind: 'data', id: 'value', schema: z.number() },
  ],
  execute: async () => ({}),
})

export const optionalSink = defineNode({
  id: 'test.optionalSink',
  version: '1.0.0',
  title: 'Optional sink',
  category: 'test',
  config: z.object({}),
  inputs: [{ kind: 'data', id: 'note', schema: z.string(), required: false }],
  outputs: [],
  execute: async () => ({}),
})

export const configurable = defineNode({
  id: 'test.config',
  version: '1.0.0',
  title: 'Configurable',
  category: 'test',
  config: z.object({ label: z.string() }),
  inputs: [],
  outputs: [],
  execute: async () => ({}),
})

export const nested = defineNode({
  id: 'test.nested',
  version: '1.0.0',
  title: 'Nested',
  category: 'test',
  config: z.object({ graph: z.unknown().optional(), body: z.unknown().optional() }),
  inputs: [],
  outputs: [],
  execute: async () => ({}),
})

export function createRegistry(): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of [source, sink, numberSink, pass, configurable, nested, optionalSink]) {
    registry.register(definition)
  }
  return registry
}

export function node(
  id: string,
  type: string,
  config: Json = {},
  options: { version?: string; label?: string } = {},
): GraphNode {
  return {
    id,
    type,
    version: options.version ?? '1.0.0',
    config,
    position: { x: 0, y: 0 },
    ...(options.label !== undefined ? { label: options.label } : {}),
  }
}

export function edge(
  id: string,
  kind: 'data' | 'flow',
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
): GraphEdge {
  return { id, kind, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } }
}

export function makeGraph(input: {
  id?: string
  title?: string
  nodes?: readonly GraphNode[]
  edges?: readonly GraphEdge[]
  metadata?: Record<string, Json>
} = {}): GraphDocument {
  return {
    schemaVersion: 1,
    id: input.id ?? 'test.graph',
    ...(input.title !== undefined ? { title: input.title } : {}),
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
}

export function codes(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code)
}
