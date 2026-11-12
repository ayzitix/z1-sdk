import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import type { Json, NodeDefinition } from '@z1/node'
import {
  createMockRuntimeServices,
  runGraph,
  type MockRuntimeServices,
  type RunEvent,
  type RunResult,
} from '@z1/runtime'
import { createBuiltinRegistry } from '../src/index.ts'

export const VERSION = '1.0.0'

export function graphNode(id: string, type: string, config: unknown = {}): GraphNode {
  return { id, type, version: VERSION, config: config as Json, position: { x: 0, y: 0 } }
}

export function dataEdge(
  id: string,
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
): GraphEdge {
  return { id, kind: 'data', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

export function flowEdge(
  id: string,
  from: string,
  fromPort: string,
  to: string,
  toPort: string,
): GraphEdge {
  return { id, kind: 'flow', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

export function makeGraph(
  id: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphDocument {
  return { schemaVersion: 1, id, nodes, edges }
}

export interface RunFixture {
  readonly result: RunResult
  readonly events: readonly RunEvent[]
  readonly services: MockRuntimeServices
}

export interface RunBuiltinsOptions {
  graph: GraphDocument
  input?: Json
  services?: MockRuntimeServices
  definitions?: readonly NodeDefinition[]
}

/** Runs a graph against the built-in registry, collecting every run event. */
export async function runBuiltins(options: RunBuiltinsOptions): Promise<RunFixture> {
  const registry = createBuiltinRegistry()
  for (const definition of options.definitions ?? []) registry.register(definition)

  const services = options.services ?? createMockRuntimeServices()
  const events: RunEvent[] = []
  services.onEvent = (event) => events.push(event)

  const result = await runGraph({
    graph: options.graph,
    registry,
    services,
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
  return { result, events, services }
}

export function streamedText(events: readonly RunEvent[], nodeId: string): string {
  return events
    .filter(
      (event): event is Extract<RunEvent, { type: 'node.stream' }> =>
        event.type === 'node.stream' && event.nodeId === nodeId,
    )
    .map((event) => (typeof event.chunk === 'string' ? event.chunk : ''))
    .join('')
}
