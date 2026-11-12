import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import {
  defineNode,
  NodeRegistry,
  type AutonomyPolicy,
  type NodeDefinition,
  type PortSpec,
} from '@z1/node'
import {
  MemoryJournal,
  createMockRuntimeServices,
  runGraph,
  type MockRuntimeServices,
  type RunEvent,
} from '../src/index.ts'

function configOf(schema: z.ZodType): z.ZodType<unknown> {
  return schema as unknown as z.ZodType<unknown>
}

function dataPort(id: string, schema: z.ZodType = z.unknown()): PortSpec {
  return { kind: 'data', id, schema, required: true }
}

function flowPort(id: string): PortSpec {
  return { kind: 'flow', id }
}

const countNode = defineNode<unknown>({
  id: 'test.count',
  version: '1.0.0',
  title: 'count',
  category: 'test',
  config: configOf(z.object({})),
  inputs: [],
  outputs: [dataPort('value')],
  execute: async (ctx) => ({ value: `call-${String(ctx.attempt)}` }),
})

const outputNode = defineNode<unknown>({
  id: 'z1.core.output',
  version: '1.0.0',
  title: 'output',
  category: 'core',
  config: configOf(z.object({ port: z.string().optional() })),
  inputs: [flowPort('in'), dataPort('value')],
  outputs: [],
  execute: async () => ({}),
})

const askNode = defineNode<unknown>({
  id: 'test.ask',
  version: '1.0.0',
  title: 'ask',
  category: 'test',
  config: configOf(z.object({})),
  inputs: [],
  outputs: [dataPort('value'), flowPort('out')],
  execute: async () => ({ value: 'approved', out: true }),
})

function makeRegistry(...definitions: NodeDefinition<unknown>[]): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of definitions) registry.register(definition)
  return registry
}

function graphNode(id: string, type: string, autonomy?: AutonomyPolicy): GraphNode {
  return {
    id,
    type,
    version: '1.0.0',
    config: {},
    position: { x: 0, y: 0 },
    ...(autonomy !== undefined ? { autonomy } : {}),
  }
}

function dataEdge(id: string, from: string, fromPort: string, to: string, toPort: string): GraphEdge {
  return { id, kind: 'data', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

function flowEdge(id: string, from: string, fromPort: string, to: string, toPort: string): GraphEdge {
  return { id, kind: 'flow', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

function countGraph(id = 'resume-count'): GraphDocument {
  return {
    schemaVersion: 1,
    id,
    nodes: [graphNode('count', 'test.count'), graphNode('out1', 'z1.core.output')],
    edges: [dataEdge('e1', 'count', 'value', 'out1', 'value')],
  }
}

function askGraph(): GraphDocument {
  return {
    schemaVersion: 1,
    id: 'resume-ask',
    nodes: [
      graphNode('ask', 'test.ask', { mode: 'ask' }),
      graphNode('out1', 'z1.core.output'),
    ],
    edges: [
      dataEdge('e1', 'ask', 'value', 'out1', 'value'),
      flowEdge('f1', 'ask', 'out', 'out1', 'in'),
    ],
  }
}

interface RunFlags {
  resume?: boolean
  suspendOnApproval?: boolean
}

function runWith(
  journal: MemoryJournal,
  graph: GraphDocument,
  runId: string,
  services: MockRuntimeServices,
  flags: RunFlags = {},
) {
  return runGraph({
    graph,
    registry: makeRegistry(countNode, askNode, outputNode),
    services,
    journal,
    runId,
    ...(flags.resume !== undefined ? { resume: flags.resume } : {}),
    ...(flags.suspendOnApproval !== undefined
      ? { suspendOnApproval: flags.suspendOnApproval }
      : {}),
  })
}

function countingServices(): { services: MockRuntimeServices; asked(): number } {
  let asked = 0
  const services = createMockRuntimeServices({
    approval: () => {
      asked += 1
      return 'allowed-once'
    },
  })
  return { services, asked: () => asked }
}

describe('resume', () => {
  test('replays completed nodes instead of executing them', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_replay'
    const first = await runWith(journal, countGraph(), runId, createMockRuntimeServices())
    expect(first.status).toBe('completed')
    expect(first.outputs).toEqual({ output: 'call-1' })

    const second = await runWith(journal, countGraph(), runId, createMockRuntimeServices(), {
      resume: true,
    })
    const events = journal.read(runId)

    expect(second.status).toBe('completed')
    expect(second.outputs).toEqual(first.outputs)
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.resumed')).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'node.started' && event.path === 'count'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'node.completed' && event.path === 'count'),
    ).toHaveLength(1)
    const cached = events.filter(
      (event) => event.type === 'node.cached' && event.path === 'count',
    )
    expect(cached).toHaveLength(1)
    expect(cached[0]?.type === 'node.cached' ? cached[0].reason : undefined).toBe('resume')
  })

  test('node.completed carries the validated outputs', async () => {
    const journal = new MemoryJournal()
    const result = await runWith(journal, countGraph(), 'run_resume_outputs', createMockRuntimeServices())
    const completed = journal
      .read(result.runId)
      .find((event) => event.type === 'node.completed' && event.path === 'count')

    expect(completed?.type).toBe('node.completed')
    expect(completed?.type === 'node.completed' ? completed.outputs : undefined).toEqual({
      value: 'call-1',
    })
  })

  test('fails with RESUME_MISMATCH when the graph changed', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_mismatch'
    await runWith(journal, countGraph('resume-a'), runId, createMockRuntimeServices())

    const result = await runWith(journal, countGraph('resume-b'), runId, createMockRuntimeServices(), {
      resume: true,
    })
    const events = journal.read(runId)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('RESUME_MISMATCH')
    expect(events.filter((event) => event.type === 'run.resumed')).toHaveLength(0)
  })

  test('fails with RESUME_MISMATCH when the journal has no run.started', async () => {
    const result = await runWith(
      new MemoryJournal(),
      countGraph(),
      'run_resume_missing',
      createMockRuntimeServices(),
      { resume: true },
    )

    expect(result.status).toBe('failed')
    expect(result.error).toContain('RESUME_MISMATCH')
  })

  test('suspendOnApproval stops before the ask node', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_suspend'
    const { services, asked } = countingServices()
    const result = await runWith(journal, askGraph(), runId, services, {
      suspendOnApproval: true,
    })
    const events = journal.read(runId)

    expect(result.status).toBe('suspended')
    expect(result.pendingApproval?.path).toBe('ask')
    expect(result.pendingApproval?.request.action).toBe('node.execute')
    expect(result.pendingApproval?.request.target).toBe('test.ask')
    expect(asked()).toBe(0)
    expect(events.filter((event) => event.type === 'approval.requested')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.suspended')).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'node.started' && event.path === 'ask'),
    ).toHaveLength(0)
  })

  test('resume suspends again while the approval is undecided', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_pending'
    const first = await runWith(journal, askGraph(), runId, createMockRuntimeServices(), {
      suspendOnApproval: true,
    })
    const second = await runWith(journal, askGraph(), runId, createMockRuntimeServices(), {
      resume: true,
      suspendOnApproval: true,
    })
    const events = journal.read(runId)

    expect(second.status).toBe('suspended')
    expect(second.pendingApproval).toEqual(first.pendingApproval)
    expect(events.filter((event) => event.type === 'approval.requested')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.suspended')).toHaveLength(2)
  })

  test('resume honours a journaled allowed decision without asking', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_allowed'
    await runWith(journal, askGraph(), runId, createMockRuntimeServices(), {
      suspendOnApproval: true,
    })
    journal.append({
      type: 'approval.decided',
      runId,
      nodeId: 'ask',
      path: 'ask',
      decision: 'allowed-once',
    })

    const { services, asked } = countingServices()
    const result = await runWith(journal, askGraph(), runId, services, { resume: true })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'approved' })
    expect(asked()).toBe(0)
  })

  test('resume honours a journaled rejected decision without asking', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_rejected'
    await runWith(journal, askGraph(), runId, createMockRuntimeServices(), {
      suspendOnApproval: true,
    })
    journal.append({
      type: 'approval.decided',
      runId,
      nodeId: 'ask',
      path: 'ask',
      decision: 'rejected',
    })

    const { services, asked } = countingServices()
    const result = await runWith(journal, askGraph(), runId, services, { resume: true })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('APPROVAL_REJECTED')
    expect(asked()).toBe(0)
  })
})
