import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import {
  defineNode,
  NodeRegistry,
  type Json,
  type NodeDefinition,
  type PortSpec,
} from '@z1/node'
import {
  MemoryJournal,
  createMockRuntimeServices,
  declaredToolNames,
  gateToolService,
  runGraph,
  withToolGate,
  type MockRuntimeServices,
  type ToolService,
} from '../src/index.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configOf(schema: z.ZodType): z.ZodType<unknown> {
  return schema as unknown as z.ZodType<unknown>
}

function dataPort(id: string, schema: z.ZodType = z.unknown(), required = true): PortSpec {
  return { kind: 'data', id, schema, required }
}

/** Calls one tool by name and publishes either the result or the rejection. */
const callNode = defineNode<unknown>({
  id: 'test.toolCall',
  version: '1.0.0',
  title: 'tool call',
  category: 'test',
  config: configOf(z.object({ name: z.string(), args: z.unknown().optional() })),
  inputs: [dataPort('tools', z.array(z.unknown()), false)],
  outputs: [dataPort('value'), dataPort('error')],
  execute: async (ctx) => {
    const args = isRecord(ctx.config.args) ? ctx.config.args : {}
    try {
      return { value: await ctx.tools.call(ctx.config.name, args as Json) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

/** Publishes what the run is told it may call. */
const listNode = defineNode<unknown>({
  id: 'test.toolList',
  version: '1.0.0',
  title: 'tool list',
  category: 'test',
  config: configOf(z.object({})),
  inputs: [dataPort('tools', z.array(z.unknown()), false)],
  outputs: [dataPort('names')],
  execute: async (ctx) => ({
    names: (await ctx.tools.list()).map((schema) => schema.name),
  }),
})

const outputNode = defineNode<unknown>({
  id: 'z1.core.output',
  version: '1.0.0',
  title: 'output',
  category: 'core',
  config: configOf(z.object({ port: z.string().optional() })),
  inputs: [{ kind: 'flow', id: 'in' }, dataPort('value')],
  outputs: [],
  execute: async () => ({}),
})

const constNode = defineNode<unknown>({
  id: 'z1.core.const',
  version: '1.0.0',
  title: 'const',
  category: 'core',
  config: configOf(z.object({ value: z.unknown() })),
  inputs: [],
  outputs: [dataPort('value')],
  execute: async (ctx) => ({ value: ctx.config.value as Json }),
})

/** Stands in for `z1.tools.list`: a declaration only the run time knows. */
const dynamicToolsNode = defineNode<unknown>({
  id: 'z1.tools.list',
  version: '1.0.0',
  title: 'tools list',
  category: 'tools',
  config: configOf(z.object({})),
  inputs: [],
  outputs: [dataPort('tools', z.array(z.unknown()))],
  execute: async () => ({ tools: [] }),
})

function makeRegistry(...definitions: NodeDefinition<unknown>[]): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of definitions) registry.register(definition)
  return registry
}

function graphNode(id: string, type: string, config: Json = {}): GraphNode {
  return { id, type, version: '1.0.0', config, position: { x: 0, y: 0 } }
}

function dataEdge(id: string, from: string, fromPort: string, to: string, toPort: string): GraphEdge {
  return { id, kind: 'data', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

/**
 * `declared` is the graph's tool declaration. `declarationType` may be the live
 * `z1.tools.list` on purpose; `callType` lets a case swap the caller node.
 */
function callGraph(
  id: string,
  declared: Json,
  declarationType = 'z1.core.const',
  callType = 'test.toolCall',
): GraphDocument {
  return {
    schemaVersion: 1,
    id,
    nodes: [
      graphNode(
        'declaration',
        declarationType,
        declarationType === 'z1.core.const' ? { value: declared } : {},
      ),
      graphNode('call', callType, { name: 'other' }),
      graphNode('publishValue', 'z1.core.output', { port: 'value' }),
      graphNode('publishError', 'z1.core.output', { port: 'error' }),
    ],
    edges: [
      dataEdge('e0', 'declaration', declarationType === 'z1.core.const' ? 'value' : 'tools', 'call', 'tools'),
      dataEdge('e1', 'call', 'value', 'publishValue', 'value'),
      dataEdge('e2', 'call', 'error', 'publishError', 'value'),
    ],
  }
}

const REGISTRY = makeRegistry(constNode, dynamicToolsNode, callNode, listNode, outputNode)

async function runGraphOnce(
  graph: GraphDocument,
  options: { tools?: readonly string[]; services?: MockRuntimeServices; runId?: string } = {},
) {
  const services = options.services ?? createMockRuntimeServices()
  const journal = new MemoryJournal()
  const result = await runGraph({
    graph,
    registry: REGISTRY,
    services,
    journal,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  })
    return { result, services }
}

describe('declaredToolNames', () => {
  test('reads the names of a constant declaration', () => {
    const graph = callGraph('gate-static', [{ name: 'echo' }])

    expect(declaredToolNames(graph)).toEqual(['echo'])
  })

  test('returns undefined for a live declaration (z1.tools.list)', () => {
    const graph = callGraph('gate-dynamic', [], 'z1.tools.list')

    expect(declaredToolNames(graph)).toBeUndefined()
  })

  test('returns undefined when a declaration is not a tool list', () => {
    const graph: GraphDocument = {
      schemaVersion: 1,
      id: 'gate-malformed',
      nodes: [graphNode('declaration', 'z1.core.const', { value: 'echo' }), graphNode('call', 'test.toolCall', { name: 'echo' })],
      edges: [dataEdge('e0', 'declaration', 'value', 'call', 'tools')],
    }

    expect(declaredToolNames(graph)).toBeUndefined()
  })

  test('returns undefined when the graph declares no tools at all', () => {
    const graph = callGraph('gate-none', [], 'call')
    graph.edges = []

    expect(declaredToolNames(graph)).toBeUndefined()
  })

  test('one dynamic source leaves the whole run open', () => {
    const graph = callGraph('gate-mixed', [{ name: 'echo' }])
    // A second, live declaration into the list node: a partially known
    // allowlist would hide tools the model was told about.
    graph.nodes.push(graphNode('live', 'z1.tools.list'))
    graph.edges.push(dataEdge('e9', 'live', 'tools', 'call', 'tools'))

    expect(declaredToolNames(graph)).toBeUndefined()
  })
})

describe('withToolGate', () => {
  test('rejects a name outside the allowlist before the service is reached', async () => {
    const calls: string[] = []
    const service: ToolService = {
      async call(name) {
        calls.push(name)
        return null
      },
      async list() {
        return []
      },
    }
    const gated = gateToolService(service, ['echo'])

    await expect(gated.call('other', {})).rejects.toThrow(
      'tool "other" is not available in this run',
    )
    expect(calls).toEqual([])
    await expect(gated.call('echo', {})).resolves.toBeNull()
    expect(calls).toEqual(['echo'])
  })

  test('list() advertises only the allowlist', async () => {
    const service: ToolService = {
      async call() {
        return null
      },
      async list() {
        return [
          { name: 'echo', parameters: {} },
          { name: 'shell', parameters: {} },
        ]
      },
    }
    const gated = gateToolService(service, ['echo'])

    expect((await gated.list()).map((schema) => schema.name)).toEqual(['echo'])
    expect(await gateToolService(service, []).list()).toEqual([])
  })

  test('an undefined allowlist leaves the service untouched', () => {
    const services = createMockRuntimeServices()
    expect(withToolGate(services, undefined)).toBe(services)
  })
})

describe('the run graph gate', () => {
  test('a declared echo does not let the graph call another tool', async () => {
    const graph = callGraph('gate-reject', [{ name: 'echo' }])
    const { result, services } = await runGraphOnce(graph)

    expect(result.status).toBe('completed')
    expect(result.outputs['error']).toBe('tool "other" is not available in this run')
    expect(result.outputs['value']).toBeUndefined()
    // Nothing was dispatched: the gate sits in front of the service.
    expect(services.toolCalls).toEqual([])
  })

  test('both declared tools dispatch', async () => {
    const graph = callGraph('gate-allow', [{ name: 'echo' }, { name: 'other' }])
    const { result, services } = await runGraphOnce(graph)

    expect(result.status).toBe('completed')
    expect(result.outputs['value']).toEqual({ ok: true, name: 'other', args: {} })
    expect(services.toolCalls).toEqual([{ name: 'other', args: {} }])
  })

  test('a dynamic declaration leaves the gate open', async () => {
    const graph = callGraph('gate-open', [], 'z1.tools.list')
    const { result, services } = await runGraphOnce(graph)

    expect(result.status).toBe('completed')
    expect(services.toolCalls).toEqual([{ name: 'other', args: {} }])
  })

  test('tools: [] rejects every call and hides every tool', async () => {
    const graph = callGraph('gate-empty', [{ name: 'echo' }])
    const { result, services } = await runGraphOnce(graph, { tools: [] })

    expect(result.status).toBe('completed')
    expect(result.outputs['error']).toBe('tool "other" is not available in this run')
    expect(services.toolCalls).toEqual([])
  })

  test('ctx.tools.list is filtered by the allowlist', async () => {
    const services = createMockRuntimeServices()
    services.tools = {
      ...services.tools,
      list: async () => [
        { name: 'echo', parameters: {} },
        { name: 'shell', parameters: {} },
      ],
    }
    const graph: GraphDocument = {
      schemaVersion: 1,
      id: 'gate-list',
      nodes: [
        graphNode('declaration', 'z1.core.const', { value: [{ name: 'echo' }] }),
        graphNode('list', 'test.toolList'),
        graphNode('publish', 'z1.core.output', { port: 'names' }),
      ],
      edges: [
        dataEdge('e0', 'declaration', 'value', 'list', 'tools'),
        dataEdge('e1', 'list', 'names', 'publish', 'value'),
      ],
    }

    const { result } = await runGraphOnce(graph, { services })

    expect(result.status).toBe('completed')
    expect(result.outputs['names']).toEqual(['echo'])
  })

  test('RunOptions.tools overrides the graph declaration', async () => {
    const graph = callGraph('gate-override', [{ name: 'echo' }])
    const { result, services } = await runGraphOnce(graph, { tools: ['other'] })

    expect(result.status).toBe('completed')
    expect(services.toolCalls).toEqual([{ name: 'other', args: {} }])
    expect(result.outputs['error']).toBeUndefined()
  })
})
