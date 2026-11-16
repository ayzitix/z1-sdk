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
import { MemoryJournal, createMockRuntimeServices, runGraph } from '../src/index.ts'

function configOf(schema: z.ZodType): z.ZodType<unknown> {
  return schema as unknown as z.ZodType<unknown>
}

function dataPort(id: string, schema: z.ZodType = z.unknown()): PortSpec {
  return { kind: 'data', id, schema, required: true }
}

const constNode = defineNode<unknown>({
  id: 'test.const',
  version: '1.0.0',
  title: 'const',
  category: 'test',
  config: configOf(z.object({ value: z.unknown() })),
  inputs: [],
  outputs: [dataPort('value')],
  execute: async (ctx) => ({ value: ctx.config.value as Json }),
})

/** Every execution appends to `calls`, so a replay is distinguishable from a re-run. */
function counterNode(calls: string[]) {
  return defineNode<unknown>({
    id: 'test.counter',
    version: '1.0.0',
    title: 'counter',
    category: 'test',
    config: configOf(z.object({})),
    inputs: [],
    outputs: [dataPort('value')],
    execute: async () => {
      calls.push(`call-${String(calls.length + 1)}`)
      return { value: calls[calls.length - 1] ?? null }
    },
  })
}

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

/** `value` -> output, so a changed constant is enough to change the digest. */
function valueGraph(id = 'run-id-graph', value: Json = 'seed'): GraphDocument {
  return {
    schemaVersion: 1,
    id,
    nodes: [
      graphNode('value', 'test.const', { value }),
      graphNode('out', 'z1.core.output', {}),
    ],
    edges: [dataEdge('e1', 'value', 'value', 'out', 'value')],
  }
}

function counterGraph(id = 'run-id-counter'): GraphDocument {
  return {
    schemaVersion: 1,
    id,
    nodes: [graphNode('count', 'test.counter'), graphNode('out', 'z1.core.output', {})],
    edges: [dataEdge('e1', 'count', 'value', 'out', 'value')],
  }
}

const REGISTRY = makeRegistry(constNode, outputNode)

function runValue(
  journal: MemoryJournal,
  graph: GraphDocument,
  runId: string,
  options: { resume?: boolean; input?: Json } = {},
) {
  return runGraph({
    graph,
    registry: REGISTRY,
    services: createMockRuntimeServices(),
    journal,
    runId,
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  })
}

function countEvents(journal: MemoryJournal, runId: string, type: string): number {
  return journal.read(runId).filter((event) => event.type === type).length
}

describe('run identity', () => {
  test('starting the same id twice is refused without journaling a second row', async () => {
    const journal = new MemoryJournal()
    const first = await runValue(journal, valueGraph(), 'r-same')
    expect(first.status).toBe('completed')
    const rows = journal.read('r-same').length

    const again = await runValue(journal, valueGraph(), 'r-same')

    expect(again.status).toBe('failed')
    expect(again.error).toBe('RUN_EXISTS: run "r-same" already exists')
    // A run id is an identity: the refused call must not touch the journal.
    expect(journal.read('r-same')).toHaveLength(rows)
    expect(countEvents(journal, 'r-same', 'run.started')).toBe(1)
  })

  test('resuming a finished run is refused with exactly one run.failed row', async () => {
    const journal = new MemoryJournal()
    const first = await runValue(journal, valueGraph(), 'r-done')
    expect(first.status).toBe('completed')

    const resumed = await runValue(journal, valueGraph(), 'r-done', { resume: true })

    expect(resumed.status).toBe('failed')
    expect(resumed.error).toContain('already ended with run.completed')
    // The refusal is journaled once, so a reader sees why the resume stopped.
    expect(countEvents(journal, 'r-done', 'run.failed')).toBe(1)
    expect(countEvents(journal, 'r-done', 'run.completed')).toBe(1)
  })

  test('resuming an unknown id fails with a run.failed row', async () => {
    const journal = new MemoryJournal()

    const result = await runValue(journal, valueGraph(), 'r-unknown', { resume: true })

    expect(result.status).toBe('failed')
    expect(result.error).toBe('RESUME_MISMATCH: journal has no run.started event for run "r-unknown"')
    expect(countEvents(journal, 'r-unknown', 'run.failed')).toBe(1)
  })

  test('resuming with a different graph id fails with a run.failed row', async () => {
    const journal = new MemoryJournal()
    const first = await runValue(journal, valueGraph('run-id-graph'), 'r-graph-id')
    expect(first.status).toBe('completed')

    const resumed = await runValue(journal, valueGraph('run-id-other'), 'r-graph-id', {
      resume: true,
    })

    expect(resumed.status).toBe('failed')
    expect(resumed.error).toContain('does not match journal graph "run-id-graph"')
    expect(countEvents(journal, 'r-graph-id', 'run.failed')).toBe(1)
  })

  test('resuming after the graph changed fails with a run.failed row', async () => {
    const journal = new MemoryJournal()
    const first = await runValue(journal, valueGraph('run-id-digest', 'seed'), 'r-digest')
    expect(first.status).toBe('completed')

    const resumed = await runValue(journal, valueGraph('run-id-digest', 'changed'), 'r-digest', {
      resume: true,
    })

    expect(resumed.status).toBe('failed')
    expect(resumed.error).toContain('graph digest')
    expect(resumed.error).toContain('does not match journal digest')
    expect(countEvents(journal, 'r-digest', 'run.failed')).toBe(1)
  })

  test('two run.started events resume from the last one', async () => {
    const calls: string[] = []
    const graph = counterGraph()
    const registry = makeRegistry(counterNode(calls), outputNode)
    const journal = new MemoryJournal()

    const first = await runGraph({
      graph,
      registry,
      services: createMockRuntimeServices(),
      journal,
      runId: 'r-twice',
    })
    expect(first.status).toBe('completed')
    expect(first.outputs['output']).toBe('call-1')

    // A journal that reused the id: the second start is the run being continued,
    // and the `node.completed` before it belongs to the previous occupancy.
    const started = journal.read('r-twice')[0]
    if (started?.type !== 'run.started') throw new Error('the first run did not start')
    journal.append({ ...started, at: Date.now() })
    expect(countEvents(journal, 'r-twice', 'run.started')).toBe(2)

    const resumed = await runGraph({
      graph,
      registry,
      services: createMockRuntimeServices(),
      journal,
      runId: 'r-twice',
      resume: true,
    })

    expect(resumed.status).toBe('completed')
    // Replayed from the last start, which completed nothing: the node re-ran.
    expect(calls).toEqual(['call-1', 'call-2'])
    expect(resumed.outputs['output']).toBe('call-2')
    const completed = journal
      .read('r-twice')
      .filter((event) => event.type === 'node.completed' && event.nodeId === 'count')
      .map((event) => (event.type === 'node.completed' ? event.outputs['value'] : undefined))
    expect(completed).toEqual(['call-1', 'call-2'])
  })
})
