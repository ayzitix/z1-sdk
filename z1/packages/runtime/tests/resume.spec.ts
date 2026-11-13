import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import {
  defineNode,
  NodeRegistry,
  type AutonomyPolicy,
  type Json,
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

/** Root node that republishes the run seed, so a resume can observe `input`. */
const echoInputNode = defineNode<unknown>({
  id: 'test.echoInput',
  version: '1.0.0',
  title: 'echo input',
  category: 'test',
  config: configOf(z.object({})),
  inputs: [],
  outputs: [dataPort('value')],
  execute: async (ctx) => ({ value: ctx.input }),
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

function echoGraph(id = 'resume-echo'): GraphDocument {
  return {
    schemaVersion: 1,
    id,
    nodes: [graphNode('echo', 'test.echoInput'), graphNode('out1', 'z1.core.output')],
    edges: [dataEdge('e1', 'echo', 'value', 'out1', 'value')],
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
  input?: Json
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
    registry: makeRegistry(countNode, askNode, echoInputNode, outputNode),
    services,
    journal,
    runId,
    ...(flags.input !== undefined ? { input: flags.input } : {}),
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

/** Body root: republishes the loop's `{ value, iteration }` record. */
const binNode = defineNode<unknown>({
  id: 'test.bin',
  version: '1.0.0',
  title: 'bin',
  category: 'test',
  config: configOf(z.object({})),
  inputs: [],
  outputs: [dataPort('value'), dataPort('iteration')],
  execute: async (ctx) => {
    const input = isRecord(ctx.input) ? ctx.input : {}
    return { value: input['value'] ?? null, iteration: input['iteration'] ?? null }
  },
})

/** Body step: finishes on the third iteration and records every execution. */
function chatNode(calls: string[]) {
  return defineNode<unknown>({
    id: 'test.chat',
    version: '1.0.0',
    title: 'chat',
    category: 'test',
    config: configOf(z.object({})),
    inputs: [dataPort('value'), dataPort('iteration')],
    outputs: [dataPort('value'), dataPort('done')],
    execute: async (ctx) => {
      const input = isRecord(ctx.input) ? ctx.input : {}
      const iteration = typeof input['iteration'] === 'number' ? input['iteration'] : 0
      calls.push(`${ctx.path}@${String(iteration)}`)
      return { value: `msg-${String(iteration)}`, done: iteration >= 2 }
    },
  })
}

/** Loop that labels each body run with its iteration, like `z1.flow.loop`. */
const iterationLoopNode = defineNode<unknown>({
  id: 'test.iterationLoop',
  version: '1.0.0',
  title: 'iteration loop',
  category: 'test',
  config: configOf(z.object({ body: z.unknown(), maxIterations: z.number() })),
  inputs: [],
  outputs: [dataPort('result'), dataPort('iterations')],
  execute: async (ctx) => {
    const config = isRecord(ctx.config) ? ctx.config : {}
    const max = typeof config['maxIterations'] === 'number' ? config['maxIterations'] : 1
    let current: unknown = null
    let iterations = 0
    while (iterations < max) {
      const { outputs } = await ctx.runSubgraph({
        graph: config['body'],
        input: { value: current as Json, iteration: iterations },
        label: String(iterations),
      })
      iterations += 1
      current = outputs['value'] ?? null
      if (outputs['done'] === true) break
    }
    return { result: current as Json, iterations }
  },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function labelledLoopGraph(): GraphDocument {
  const body: GraphDocument = {
    schemaVersion: 1,
    id: 'iteration-body',
    nodes: [
      graphNode('bin', 'test.bin'),
      graphNode('chat', 'test.chat'),
      {
        id: 'outValue',
        type: 'z1.core.output',
        version: '1.0.0',
        config: { port: 'value' },
        position: { x: 0, y: 0 },
      },
      {
        id: 'outDone',
        type: 'z1.core.output',
        version: '1.0.0',
        config: { port: 'done' },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [
      dataEdge('e1', 'bin', 'value', 'chat', 'value'),
      dataEdge('e2', 'bin', 'iteration', 'chat', 'iteration'),
      dataEdge('e3', 'chat', 'value', 'outValue', 'value'),
      dataEdge('e4', 'chat', 'done', 'outDone', 'value'),
    ],
  }
  return {
    schemaVersion: 1,
    id: 'iteration-loop',
    nodes: [
      {
        id: 'loop',
        type: 'test.iterationLoop',
        version: '1.0.0',
        config: { body, maxIterations: 10 },
        position: { x: 0, y: 0 },
      },
      graphNode('outResult', 'z1.core.output'),
      {
        id: 'outCount',
        type: 'z1.core.output',
        version: '1.0.0',
        config: { port: 'iterations' },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [
      dataEdge('e1', 'loop', 'result', 'outResult', 'value'),
      dataEdge('e2', 'loop', 'iterations', 'outCount', 'value'),
    ],
  }
}

/**
 * Copy a run's journal up to (excluding) the first `node.started` at `path`,
 * mirroring `SqliteJournal.fork`: the node at `path` must re-execute.
 */
function forkBefore(
  source: MemoryJournal,
  sourceRunId: string,
  forkedRunId: string,
  path: string,
): MemoryJournal {
  const forked = new MemoryJournal()
  for (const event of source.read(sourceRunId)) {
    if (event.type === 'node.started' && event.path === path) break
    forked.append({ ...event, runId: forkedRunId })
  }
  return forked
}


describe('resume', () => {
  test('run.started journals the run input and its digest', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_input_journal'
    const input = { prompt: 'one', nested: { b: 2, a: 1 } }
    await runWith(journal, echoGraph(), runId, createMockRuntimeServices(), { input })

    const started = journal.read(runId).find((event) => event.type === 'run.started')

    expect(started?.type === 'run.started' ? started.input : undefined).toEqual(input)
    expect(started?.type === 'run.started' ? started.inputDigest : undefined).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  test('fails with RESUME_MISMATCH when the resumed input differs', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_input_mismatch'
    const first = await runWith(journal, echoGraph(), runId, createMockRuntimeServices(), {
      input: { prompt: 'one' },
    })
    expect(first.status).toBe('completed')

    const result = await runWith(journal, echoGraph(), runId, createMockRuntimeServices(), {
      resume: true,
      input: { prompt: 'two' },
    })
    const events = journal.read(runId)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('RESUME_MISMATCH: run input differs from the journaled input')
    expect(events.filter((event) => event.type === 'run.resumed')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'run.failed')).toHaveLength(1)
  })

  test('resume without input re-executes with the journaled input', async () => {
    const journal = new MemoryJournal()
    const sourceId = 'run_resume_input_source'
    const first = await runWith(journal, echoGraph(), sourceId, createMockRuntimeServices(), {
      input: { prompt: 'stored' },
    })
    expect(first.outputs).toEqual({ output: { prompt: 'stored' } })

    const forkedId = 'run_resume_input_forked'
    const forked = forkBefore(journal, sourceId, forkedId, 'echo')
    const resumed = await runWith(forked, echoGraph(), forkedId, createMockRuntimeServices(), {
      resume: true,
    })
    const events = forked.read(forkedId)

    expect(resumed.status).toBe('completed')
    // Without the stored seed the re-executed node would see `null`.
    expect(resumed.outputs).toEqual({ output: { prompt: 'stored' } })
    expect(
      events.filter((event) => event.type === 'node.started' && event.path === 'echo'),
    ).toHaveLength(1)
  })

  test('resume with the same input replays as before', async () => {
    const journal = new MemoryJournal()
    const runId = 'run_resume_input_same'
    const input = { prompt: 'same' }
    const first = await runWith(journal, echoGraph(), runId, createMockRuntimeServices(), { input })
    const second = await runWith(journal, echoGraph(), runId, createMockRuntimeServices(), {
      resume: true,
      input: { prompt: 'same' },
    })
    const events = journal.read(runId)

    expect(second.status).toBe('completed')
    expect(second.outputs).toEqual(first.outputs)
    expect(
      events.filter((event) => event.type === 'node.started' && event.path === 'echo'),
    ).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.failed')).toHaveLength(0)
  })

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

  test('a fork inside a loop replays completed iterations and re-executes only the fork point', async () => {
    const calls: string[] = []
    const registry = makeRegistry(
      binNode,
      chatNode(calls),
      iterationLoopNode,
      outputNode,
    )
    const graph = labelledLoopGraph()
    const source = new MemoryJournal()
    const sourceId = 'run_loop_source'
    const first = await runGraph({
      graph,
      registry,
      services: createMockRuntimeServices(),
      journal: source,
      runId: sourceId,
    })

    expect(first.status).toBe('completed')
    // Done on iteration 2: three iterations, well under the cap of 10.
    expect(first.outputs['iterations']).toBe(3)
    expect(calls).toEqual(['loop/0/chat@0', 'loop/1/chat@1', 'loop/2/chat@2'])

    const forkedId = 'run_loop_fork'
    const forked = forkBefore(source, sourceId, forkedId, 'loop/1/chat')
    calls.length = 0
    const resumed = await runGraph({
      graph,
      registry,
      services: createMockRuntimeServices(),
      journal: forked,
      runId: forkedId,
      resume: true,
    })
    const events = forked.read(forkedId)

    expect(resumed.status).toBe('completed')
    // The bug replayed iteration 0's completion for every later iteration and
    // ran to the cap; with per-iteration paths the loop stops at 3 again.
    expect(resumed.outputs['iterations']).toBe(3)
    expect(calls).toEqual(['loop/1/chat@1', 'loop/2/chat@2'])

    const cached = events.filter(
      (event) => event.type === 'node.cached' && event.path === 'loop/0/chat',
    )
    expect(cached).toHaveLength(1)
    expect(cached[0]?.type === 'node.cached' ? cached[0].reason : undefined).toBe('resume')
    expect(
      events.filter((event) => event.type === 'node.started' && event.path === 'loop/1/chat'),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'node.completed' && event.path === 'loop/0/chat'),
    ).toHaveLength(1)
  })
})
