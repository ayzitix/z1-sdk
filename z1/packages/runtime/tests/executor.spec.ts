import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import type { GraphDocument, GraphEdge, GraphNode } from '@z1/graph'
import {
  defineNode,
  NodeRegistry,
  type AutonomyMode,
  type AutonomyPolicy,
  type Json,
  type NodeDefinition,
  type PortSpec,
} from '@z1/node'
import {
  MemoryJournal,
  createMockRuntimeServices,
  runGraph,
  type LogEntry,
  type MockRuntimeServices,
  type RunEvent,
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

function flowPort(id: string): PortSpec {
  return { kind: 'flow', id }
}

const constNode = defineNode<unknown>({
  id: 'test.const',
  version: '1.0.0',
  title: 'const',
  category: 'test',
  config: configOf(z.object({ value: z.unknown() })),
  inputs: [],
  outputs: [dataPort('value')],
  execute: async (ctx) => {
    const config = isRecord(ctx.config) ? ctx.config : {}
    return { value: (config['value'] ?? null) as Json }
  },
})

const templateNode = defineNode<unknown>({
  id: 'test.template',
  version: '1.0.0',
  title: 'template',
  category: 'test',
  config: configOf(z.object({ template: z.string() })),
  inputs: [dataPort('vars')],
  outputs: [dataPort('text', z.string())],
  execute: async (ctx) => {
    const config = isRecord(ctx.config) ? ctx.config : {}
    const inputs = isRecord(ctx.input) ? ctx.input : {}
    const template = typeof config['template'] === 'string' ? config['template'] : ''
    return { text: template.replaceAll('{{vars}}', String(inputs['vars'] ?? '')) }
  },
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

const inputNode = defineNode<unknown>({
  id: 'z1.core.input',
  version: '1.0.0',
  title: 'input',
  category: 'core',
  config: configOf(z.object({})),
  inputs: [],
  outputs: [dataPort('value')],
  execute: async (ctx) => {
    if (isRecord(ctx.input) && 'value' in ctx.input) {
      return { value: ctx.input['value'] as Json }
    }
    return { value: ctx.input }
  },
})

const branchNode = defineNode<unknown>({
  id: 'test.if',
  version: '1.0.0',
  title: 'if',
  category: 'test',
  config: configOf(z.object({})),
  inputs: [flowPort('in'), dataPort('condition', z.boolean())],
  outputs: [flowPort('then'), flowPort('else')],
  execute: async (ctx) => {
    const inputs = isRecord(ctx.input) ? ctx.input : {}
    const condition = inputs['condition'] === true
    return condition ? { then: true, else: false } : { then: false, else: true }
  },
})

const flowStartNode = defineNode<unknown>({
  id: 'test.start',
  version: '1.0.0',
  title: 'start',
  category: 'test',
  config: configOf(z.object({ pass: z.boolean() })),
  inputs: [],
  outputs: [flowPort('out')],
  execute: async (ctx) => {
    const config = isRecord(ctx.config) ? ctx.config : {}
    return { out: config['pass'] === true }
  },
})

const flowGateNode = defineNode<unknown>({
  id: 'test.gate',
  version: '1.0.0',
  title: 'gate',
  category: 'test',
  config: configOf(z.object({ pass: z.boolean() })),
  inputs: [flowPort('in')],
  outputs: [flowPort('out')],
  execute: async (ctx) => {
    const config = isRecord(ctx.config) ? ctx.config : {}
    return { out: config['pass'] === true }
  },
})

function makeRegistry(...definitions: NodeDefinition<unknown>[]): NodeRegistry {
  const registry = new NodeRegistry()
  for (const definition of definitions) registry.register(definition)
  return registry
}

interface NodeExtras {
  autonomy?: AutonomyPolicy
}

function graphNode(id: string, type: string, config: unknown, extras: NodeExtras = {}): GraphNode {
  return {
    id,
    type,
    version: '1.0.0',
    config: config as Json,
    position: { x: 0, y: 0 },
    ...(extras.autonomy !== undefined ? { autonomy: extras.autonomy } : {}),
  }
}

function dataEdge(id: string, from: string, fromPort: string, to: string, toPort: string): GraphEdge {
  return { id, kind: 'data', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

function flowEdge(id: string, from: string, fromPort: string, to: string, toPort: string): GraphEdge {
  return { id, kind: 'flow', from: { node: from, port: fromPort }, to: { node: to, port: toPort } }
}

function makeGraph(id: string, nodes: GraphNode[], edges: GraphEdge[]): GraphDocument {
  return { schemaVersion: 1, id, nodes, edges }
}

function linearGraph(): GraphDocument {
  return makeGraph(
    'linear',
    [
      graphNode('const1', 'test.const', { value: 'world' }),
      graphNode('template1', 'test.template', { template: 'hello {{vars}}' }),
      graphNode('out1', 'z1.core.output', { port: 'greeting' }),
    ],
    [
      dataEdge('e1', 'const1', 'value', 'template1', 'vars'),
      dataEdge('e2', 'template1', 'text', 'out1', 'value'),
    ],
  )
}

const LINEAR_DEFS = [constNode, templateNode, outputNode]

async function runLinear(
  services: MockRuntimeServices = createMockRuntimeServices(),
): Promise<{ events: readonly RunEvent[]; result: Awaited<ReturnType<typeof runGraph>> }> {
  const journal = new MemoryJournal()
  const result = await runGraph({
    graph: linearGraph(),
    registry: makeRegistry(...LINEAR_DEFS),
    services,
    journal,
  })
  return { events: journal.read(result.runId), result }
}

describe('executor', () => {
  test('runs a linear const -> template -> output graph', async () => {
    const { result, events } = await runLinear()
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ greeting: 'hello world' })
    expect(events.filter((event) => event.type === 'node.completed')).toHaveLength(3)
    expect(events.at(-1)?.type).toBe('run.completed')
  })

  test('if routes to then', async () => {
    const result = await runBranchGraph(true)
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ then: 'T' })
  })

  test('if routes to else', async () => {
    const result = await runBranchGraph(false)
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ else: 'E' })
  })

  test('reports a deadlock with idle nodes and missing ports', async () => {
    const graph = makeGraph(
      'deadlock',
      [
        graphNode('const1', 'test.const', { value: 'x' }),
        graphNode('start', 'test.start', { pass: false }),
        graphNode('gate', 'test.gate', { pass: true }),
        graphNode('out1', 'z1.core.output', {}),
      ],
      [
        flowEdge('e1', 'start', 'out', 'gate', 'in'),
        flowEdge('e2', 'gate', 'out', 'out1', 'in'),
        dataEdge('e3', 'const1', 'value', 'out1', 'value'),
      ],
    )
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph,
      registry: makeRegistry(constNode, flowStartNode, flowGateNode, outputNode),
      services: createMockRuntimeServices(),
      journal,
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('DEADLOCK')
    expect(result.error).toContain('gate')
    expect(result.error).toContain('out1')
    expect(journal.read(result.runId).some((event) => event.type === 'run.failed')).toBe(true)
  })

  test('a throwing node emits node.failed and run.failed', async () => {
    const throwNode = defineNode<unknown>({
      id: 'test.throw',
      version: '1.0.0',
      title: 'throw',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      execute: async () => {
        throw new Error('boom')
      },
    })
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph: makeGraph('throws', [graphNode('a', 'test.throw', {})], []),
      registry: makeRegistry(throwNode),
      services: createMockRuntimeServices(),
      journal,
    })
    const events = journal.read(result.runId)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('NODE_FAILED')
    expect(result.error).toContain('boom')
    const failed = events.find((event) => event.type === 'node.failed')
    expect(failed?.type === 'node.failed' ? failed.error : '').toContain('NODE_FAILED')
    expect(events.some((event) => event.type === 'run.failed')).toBe(true)
  })

  test('retries a thrown error and succeeds on the second attempt', async () => {
    let calls = 0
    const flakyNode = defineNode<unknown>({
      id: 'test.flaky',
      version: '1.0.0',
      title: 'flaky',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      retry: { attempts: 1, backoffMs: 0 },
      execute: async () => {
        calls += 1
        if (calls === 1) throw new Error('first attempt')
        return { value: 'ok' }
      },
    })
    const graph = makeGraph(
      'retry',
      [graphNode('flaky', 'test.flaky', {}), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 'flaky', 'value', 'out1', 'value')],
    )
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph,
      registry: makeRegistry(flakyNode, outputNode),
      services: createMockRuntimeServices(),
      journal,
    })
    const starts = journal
      .read(result.runId)
      .filter((event) => event.type === 'node.started' && event.nodeId === 'flaky')

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'ok' })
    expect(calls).toBe(2)
    expect(starts.map((event) => (event.type === 'node.started' ? event.attempt : 0))).toEqual([
      1, 2,
    ])
  })

  test('fails a node that exceeds its timeout', async () => {
    const slowNode = defineNode<unknown>({
      id: 'test.slow',
      version: '1.0.0',
      title: 'slow',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      timeoutMs: 10,
      execute: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50))
        return { value: 'late' }
      },
    })
    const graph = makeGraph(
      'timeout',
      [graphNode('slow', 'test.slow', {}), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 'slow', 'value', 'out1', 'value')],
    )
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph,
      registry: makeRegistry(slowNode, outputNode),
      services: createMockRuntimeServices(),
      journal,
    })
    const failed = journal.read(result.runId).find((event) => event.type === 'node.failed')

    expect(result.status).toBe('failed')
    expect(result.error).toContain('TIMEOUT')
    expect(failed?.type === 'node.failed' ? failed.error : '').toContain('TIMEOUT')
  })

  test('ask autonomy proceeds when approval is allowed', async () => {
    const result = await runApprovalGraph('ask', createMockRuntimeServices())
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'approved' })
  })

  test('ask autonomy fails when approval is rejected', async () => {
    const result = await runApprovalGraph(
      'ask',
      createMockRuntimeServices({ approval: 'rejected' }),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('APPROVAL_REJECTED')
  })

  test('deny autonomy fails without asking', async () => {
    let asked = 0
    const services = createMockRuntimeServices({
      approval: () => {
        asked += 1
        return 'allowed-once'
      },
    })
    const result = await runApprovalGraph('deny', services)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('AUTONOMY_DENIED')
    expect(asked).toBe(0)
  })

  test('caches node outputs across nested iterations', async () => {
    const loopNode = defineNode<unknown>({
      id: 'test.loop',
      version: '1.0.0',
      title: 'loop',
      category: 'test',
      config: configOf(z.object({ seed: z.unknown(), body: z.unknown() })),
      inputs: [],
      outputs: [dataPort('result')],
      execute: async (ctx) => {
        const config = isRecord(ctx.config) ? ctx.config : {}
        const first = await ctx.runSubgraph({
          graph: config['body'],
          input: config['seed'] as Json,
        })
        const second = await ctx.runSubgraph({
          graph: config['body'],
          input: config['seed'] as Json,
        })
        expect(first.outputs).toEqual(second.outputs)
        return { result: second.outputs['out'] ?? null }
      },
    })

    const body = makeGraph(
      'body',
      [
        graphNode('in1', 'z1.core.input', {}),
        graphNode('t1', 'test.template', { template: 'v={{vars}}' }),
        graphNode('out1', 'z1.core.output', { port: 'out' }),
      ],
      [
        dataEdge('b1', 'in1', 'value', 't1', 'vars'),
        dataEdge('b2', 't1', 'text', 'out1', 'value'),
      ],
    )
    const graph = makeGraph(
      'cache',
      [graphNode('loop1', 'test.loop', { seed: 'seed', body }), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 'loop1', 'result', 'out1', 'value')],
    )
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph,
      registry: makeRegistry(inputNode, templateNode, outputNode, loopNode),
      services: createMockRuntimeServices(),
      journal,
    })
    const events = journal.read(result.runId)

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'v=seed' })
    expect(events.some((event) => event.type === 'node.cached')).toBe(true)
    expect(
      events.some((event) => event.type === 'node.started' && event.path.startsWith('loop1/')),
    ).toBe(true)
  })

  test('cancels before start', async () => {
    const controller = new AbortController()
    controller.abort()
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph: linearGraph(),
      registry: makeRegistry(...LINEAR_DEFS),
      services: createMockRuntimeServices(),
      journal,
      signal: controller.signal,
    })

    expect(result.status).toBe('cancelled')
    expect(journal.read(result.runId).some((event) => event.type === 'run.cancelled')).toBe(true)
    expect(journal.read(result.runId).some((event) => event.type === 'node.started')).toBe(false)
  })

  test('cancels a running node', async () => {
    const slowNode = defineNode<unknown>({
      id: 'test.slow',
      version: '1.0.0',
      title: 'slow',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      execute: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
        return { value: 'late' }
      },
    })
    const graph = makeGraph(
      'cancel',
      [graphNode('slow', 'test.slow', {}), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 'slow', 'value', 'out1', 'value')],
    )
    const controller = new AbortController()
    const journal = new MemoryJournal()
    setTimeout(() => controller.abort(), 10)

    const result = await runGraph({
      graph,
      registry: makeRegistry(slowNode, outputNode),
      services: createMockRuntimeServices(),
      journal,
      signal: controller.signal,
    })
    const events = journal.read(result.runId)

    expect(result.status).toBe('cancelled')
    expect(events.some((event) => event.type === 'node.started')).toBe(true)
    expect(events.some((event) => event.type === 'run.cancelled')).toBe(true)
  })

  test('fails a node that returns an invalid port value', async () => {
    const badNode = defineNode<unknown>({
      id: 'test.bad',
      version: '1.0.0',
      title: 'bad',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value', z.string())],
      execute: async () => ({ value: 42 }),
    })
    const graph = makeGraph(
      'invalid-output',
      [graphNode('bad', 'test.bad', {}), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 'bad', 'value', 'out1', 'value')],
    )
    const result = await runGraph({
      graph,
      registry: makeRegistry(badNode, outputNode),
      services: createMockRuntimeServices(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('INVALID_OUTPUT')
  })

  test('rejects an invalid graph without throwing', async () => {
    const result = await runGraph({
      graph: makeGraph('invalid', [graphNode('a', 'test.missing', {})], []),
      registry: makeRegistry(),
      services: createMockRuntimeServices(),
    })
    expect(result.status).toBe('failed')
    expect(result.error).toBe('invalid graph: unknown-node-type')
  })

  test('delivers stream chunks to onEvent but not the journal', async () => {
    const streamNode = defineNode<unknown>({
      id: 'test.stream',
      version: '1.0.0',
      title: 'stream',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      execute: async (ctx) => {
        ctx.emit('chunk', 'one')
        return { value: 'ok' }
      },
    })
    const graph = makeGraph(
      'stream',
      [graphNode('s', 'test.stream', {}), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 's', 'value', 'out1', 'value')],
    )
    const seen: RunEvent[] = []
    const services = createMockRuntimeServices()
    services.onEvent = (event) => seen.push(event)
    const journal = new MemoryJournal()
    const result = await runGraph({ graph, registry: makeRegistry(streamNode, outputNode), services, journal })

    expect(result.status).toBe('completed')
    expect(seen.some((event) => event.type === 'node.stream')).toBe(true)
    expect(journal.read(result.runId).some((event) => event.type === 'node.stream')).toBe(false)
  })

  test('different root seeds in a loop body are not cache hits', async () => {
    const seen: Json[] = []
    const recordNode = defineNode<unknown>({
      id: 'test.record',
      version: '1.0.0',
      title: 'record',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [dataPort('value')],
      outputs: [],
      execute: async (ctx) => {
        const input = isRecord(ctx.input) ? ctx.input : {}
        seen.push(input['value'] ?? null)
        return {}
      },
    })
    const body = makeGraph(
      'seed-body',
      [graphNode('in1', 'z1.core.input', {}), graphNode('rec', 'test.record', {})],
      [dataEdge('b1', 'in1', 'value', 'rec', 'value')],
    )
    const seedLoopNode = defineNode<unknown>({
      id: 'test.seedLoop',
      version: '1.0.0',
      title: 'seed loop',
      category: 'test',
      config: configOf(z.object({ seeds: z.array(z.unknown()), body: z.unknown() })),
      inputs: [],
      outputs: [dataPort('done')],
      execute: async (ctx) => {
        const config = isRecord(ctx.config) ? ctx.config : {}
        const seeds = Array.isArray(config['seeds']) ? config['seeds'] : []
        for (const seed of seeds) {
          await ctx.runSubgraph({ graph: config['body'], input: seed as Json })
        }
        return { done: true }
      },
    })
    const graph = makeGraph(
      'seed-cache',
      [
        graphNode('loop1', 'test.seedLoop', { seeds: [1, 2], body }),
        graphNode('out1', 'z1.core.output', {}),
      ],
      [dataEdge('e1', 'loop1', 'done', 'out1', 'value')],
    )
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph,
      registry: makeRegistry(inputNode, recordNode, seedLoopNode, outputNode),
      services: createMockRuntimeServices(),
      journal,
    })
    const events = journal.read(result.runId)

    expect(result.status).toBe('completed')
    expect(seen).toEqual([1, 2])
    expect(
      events.filter((event) => event.type === 'node.cached' && event.path.startsWith('loop1/')),
    ).toHaveLength(0)
  })

  test('deny is not bypassed by a cache hit', async () => {
    let calls = 0
    const stableNode = defineNode<unknown>({
      id: 'test.stable',
      version: '1.0.0',
      title: 'stable',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      execute: async () => {
        calls += 1
        return { value: 'v' }
      },
    })
    // Identical type/version/config/input: without the policy check first, `b`
    // would be served from `a`'s cache entry and never be denied.
    const graph = makeGraph(
      'deny-cache',
      [
        graphNode('a', 'test.stable', {}),
        graphNode('b', 'test.stable', {}, { autonomy: { mode: 'deny' } }),
      ],
      [],
    )
    const result = await runGraph({
      graph,
      registry: makeRegistry(stableNode),
      services: createMockRuntimeServices(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('AUTONOMY_DENIED')
    expect(calls).toBe(1)
  })

  test('approval timeout rejects by default', async () => {
    const result = await runApprovalGraph(
      'ask',
      createMockRuntimeServices({ approval: () => new Promise<never>(() => {}) }),
      { policy: { timeoutMs: 10 } },
    )

    expect(result.status).toBe('failed')
    expect(result.error).toContain('APPROVAL_REJECTED')
    expect(result.error).toContain('timed out')
  })

  test('approval timeout can be configured to approve', async () => {
    const result = await runApprovalGraph(
      'ask',
      createMockRuntimeServices({ approval: () => new Promise<never>(() => {}) }),
      { policy: { timeoutMs: 10, onTimeout: 'approve' } },
    )

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'approved' })
  })

  test('aborts a run while approval is pending', async () => {
    let asked = 0
    const services = createMockRuntimeServices({
      approval: () => {
        asked += 1
        return new Promise<never>(() => {})
      },
    })
    const controller = new AbortController()
    const journal = new MemoryJournal()
    const pending = runApprovalGraph('ask', services, {
      signal: controller.signal,
      journal,
      policy: { timeoutMs: 5_000 },
    })
    setTimeout(() => controller.abort(), 10)
    const result = await pending

    expect(result.status).toBe('cancelled')
    expect(asked).toBe(1)
    expect(journal.read(result.runId).some((event) => event.type === 'run.cancelled')).toBe(true)
  })

  test('routes ctx.log to services.onLog', async () => {
    const logs: LogEntry[] = []
    const logNode = defineNode<unknown>({
      id: 'test.logger',
      version: '1.0.0',
      title: 'logger',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      execute: async (ctx) => {
        ctx.log('info', 'hello', { n: 1 })
        ctx.log('debug', 'plain')
        return { value: 'ok' }
      },
    })
    const graph = makeGraph(
      'log',
      [graphNode('log1', 'test.logger', {}), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 'log1', 'value', 'out1', 'value')],
    )
    const services = createMockRuntimeServices()
    services.onLog = (entry) => logs.push(entry)
    const result = await runGraph({
      graph,
      registry: makeRegistry(logNode, outputNode),
      services,
    })

    expect(result.status).toBe('completed')
    expect(logs).toHaveLength(2)
    expect(logs[0]).toEqual({
      runId: result.runId,
      nodeId: 'log1',
      path: 'log1',
      level: 'info',
      message: 'hello',
      data: { n: 1 },
    })
    expect(logs[1]).toEqual({
      runId: result.runId,
      nodeId: 'log1',
      path: 'log1',
      level: 'debug',
      message: 'plain',
    })
  })

  test('ctx.log is a no-op when no onLog handler is configured', async () => {
    const logNode = defineNode<unknown>({
      id: 'test.logger',
      version: '1.0.0',
      title: 'logger',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [],
      outputs: [dataPort('value')],
      execute: async (ctx) => {
        ctx.log('warn', 'ignored')
        return { value: 'ok' }
      },
    })
    const graph = makeGraph(
      'log-noop',
      [graphNode('log1', 'test.logger', {}), graphNode('out1', 'z1.core.output', {})],
      [dataEdge('e1', 'log1', 'value', 'out1', 'value')],
    )
    const result = await runGraph({
      graph,
      registry: makeRegistry(logNode, outputNode),
      services: createMockRuntimeServices(),
    })
    expect(result.status).toBe('completed')
  })

  test('a nested run emits no run-level events', async () => {
    const subNode = defineNode<unknown>({
      id: 'test.sub',
      version: '1.0.0',
      title: 'sub',
      category: 'test',
      config: configOf(z.object({ graph: z.unknown() })),
      inputs: [],
      outputs: [dataPort('value')],
      execute: async (ctx) => {
        const config = isRecord(ctx.config) ? ctx.config : {}
        const { outputs } = await ctx.runSubgraph({ graph: config['graph'] })
        return { value: outputs['out'] ?? null }
      },
    })
    const body = makeGraph(
      'sub-body',
      [
        graphNode('c', 'test.const', { value: 'inner' }),
        graphNode('o', 'z1.core.output', { port: 'out' }),
      ],
      [dataEdge('s1', 'c', 'value', 'o', 'value')],
    )
    const graph = makeGraph(
      'sub-outer',
      [
        graphNode('sub', 'test.sub', { graph: body }),
        graphNode('out1', 'z1.core.output', {}),
      ],
      [dataEdge('e1', 'sub', 'value', 'out1', 'value')],
    )
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph,
      registry: makeRegistry(constNode, subNode, outputNode),
      services: createMockRuntimeServices(),
      journal,
    })
    const events = journal.read(result.runId)

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'inner' })
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(1)
    expect(
      events.some((event) => event.type === 'node.started' && event.path === 'sub/c'),
    ).toBe(true)
  })

  test('completes when every node is done even without a core.output', async () => {
    const journal = new MemoryJournal()
    const result = await runGraph({
      graph: makeGraph('no-output', [graphNode('c', 'test.const', { value: 'x' })], []),
      registry: makeRegistry(constNode),
      services: createMockRuntimeServices(),
      journal,
    })
    const events = journal.read(result.runId)

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({})
    expect(events.some((event) => event.type === 'run.completed')).toBe(true)
  })

  test('a real deadlock names the missing data ports and flow tokens', async () => {
    const flowSourceNode = defineNode<unknown>({
      id: 'test.flowSource',
      version: '1.0.0',
      title: 'flow source',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [flowPort('in')],
      outputs: [dataPort('value')],
      execute: async () => ({ value: 'v' }),
    })
    const graph = makeGraph(
      'deadlock-ports',
      [
        graphNode('start', 'test.start', { pass: false }),
        graphNode('gate', 'test.gate', { pass: true }),
        graphNode('producer', 'test.flowSource', {}),
        graphNode('out1', 'z1.core.output', {}),
      ],
      [
        flowEdge('f1', 'start', 'out', 'gate', 'in'),
        flowEdge('f2', 'gate', 'out', 'producer', 'in'),
        flowEdge('f3', 'gate', 'out', 'out1', 'in'),
        dataEdge('d1', 'producer', 'value', 'out1', 'value'),
      ],
    )
    const result = await runGraph({
      graph,
      registry: makeRegistry(flowStartNode, flowGateNode, flowSourceNode, outputNode),
      services: createMockRuntimeServices(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('DEADLOCK')
    expect(result.error).toContain('missing data ports: out1.value')
    expect(result.error).toContain('missing flow tokens:')
  })
  test('identical arguments at different paths are not collapsed by the cache', async () => {
    let calls = 0
    const sideEffectNode = defineNode<unknown>({
      id: 'test.effect',
      version: '1.0.0',
      title: 'effect',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [dataPort('value')],
      outputs: [dataPort('value')],
      execute: async (ctx) => {
        calls += 1
        const inputs = isRecord(ctx.input) ? ctx.input : {}
        return { value: (inputs['value'] ?? null) as Json }
      },
    })

    const graph = makeGraph(
      'cache-identity',
      [
        graphNode('src', 'test.const', { value: 'same' }),
        graphNode('first', 'test.effect', {}),
        graphNode('second', 'test.effect', {}),
        graphNode('out1', 'z1.core.output', { port: 'a' }),
        graphNode('out2', 'z1.core.output', { port: 'b' }),
      ],
      [
        dataEdge('e1', 'src', 'value', 'first', 'value'),
        dataEdge('e2', 'src', 'value', 'second', 'value'),
        dataEdge('e3', 'first', 'value', 'out1', 'value'),
        dataEdge('e4', 'second', 'value', 'out2', 'value'),
      ],
    )
    const result = await runGraph({
      graph,
      registry: makeRegistry(constNode, sideEffectNode, outputNode),
      services: createMockRuntimeServices(),
    })

    expect(result.status).toBe('completed')
    expect(calls).toBe(2)
  })

  test('an output node still advances its outgoing flow edges', async () => {
    let ran = false
    // A custom `core.output` with a declared flow port: the builtin one has no
    // output ports, so the validator would reject an outgoing edge.
    const chainedOutputNode = defineNode<unknown>({
      id: 'z1.core.output',
      version: '1.0.0',
      title: 'output',
      category: 'core',
      config: configOf(z.object({ port: z.string().optional() })),
      inputs: [flowPort('in'), dataPort('value')],
      outputs: [flowPort('out')],
      execute: async () => ({ out: true }),
    })
    const boomNode = defineNode<unknown>({
      id: 'test.boom',
      version: '1.0.0',
      title: 'boom',
      category: 'test',
      config: configOf(z.object({})),
      inputs: [flowPort('in')],
      outputs: [],
      execute: async () => {
        ran = true
        throw new Error('boom ran')
      },
    })

    const graph = makeGraph(
      'output-flow',
      [
        graphNode('start', 'test.start', { pass: true }),
        graphNode('src', 'test.const', { value: 'v' }),
        graphNode('out1', 'z1.core.output', {}),
        graphNode('boom', 'test.boom', {}),
      ],
      [
        flowEdge('f1', 'start', 'out', 'out1', 'in'),
        flowEdge('f2', 'out1', 'out', 'boom', 'in'),
        dataEdge('d1', 'src', 'value', 'out1', 'value'),
      ],
    )
    const result = await runGraph({
      graph,
      registry: makeRegistry(flowStartNode, constNode, chainedOutputNode, boomNode),
      services: createMockRuntimeServices(),
    })

    expect(ran).toBe(true)
    expect(result.status).toBe('failed')
  })
})

async function runBranchGraph(condition: boolean) {
  const graph = makeGraph(
    `branch-${String(condition)}`,
    [
      graphNode('start', 'test.start', { pass: true }),
      graphNode('cond', 'test.const', { value: condition }),
      graphNode('branch', 'test.if', {}),
      graphNode('val-then', 'test.const', { value: 'T' }),
      graphNode('val-else', 'test.const', { value: 'E' }),
      graphNode('out-then', 'z1.core.output', { port: 'then' }),
      graphNode('out-else', 'z1.core.output', { port: 'else' }),
    ],
    [
      flowEdge('f1', 'start', 'out', 'branch', 'in'),
      dataEdge('d1', 'cond', 'value', 'branch', 'condition'),
      flowEdge('f2', 'branch', 'then', 'out-then', 'in'),
      flowEdge('f3', 'branch', 'else', 'out-else', 'in'),
      dataEdge('d2', 'val-then', 'value', 'out-then', 'value'),
      dataEdge('d3', 'val-else', 'value', 'out-else', 'value'),
    ],
  )
  return await runGraph({
    graph,
    registry: makeRegistry(constNode, flowStartNode, branchNode, outputNode),
    services: createMockRuntimeServices(),
  })
}

async function runApprovalGraph(
  mode: AutonomyMode,
  services: MockRuntimeServices,
  options: { policy?: Partial<AutonomyPolicy>; signal?: AbortSignal; journal?: MemoryJournal } = {},
) {
  const approveNode = defineNode<unknown>({
    id: 'test.approve',
    version: '1.0.0',
    title: 'approve',
    category: 'test',
    config: configOf(z.object({})),
    inputs: [],
    outputs: [dataPort('value')],
    execute: async () => ({ value: 'approved' }),
  })
  const graph = makeGraph(
    `approval-${mode}`,
    [
      graphNode('ask', 'test.approve', {}, { autonomy: { mode, ...options.policy } }),
      graphNode('out1', 'z1.core.output', {}),
    ],
    [dataEdge('e1', 'ask', 'value', 'out1', 'value')],
  )
  return await runGraph({
    graph,
    registry: makeRegistry(approveNode, outputNode),
    services,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.journal !== undefined ? { journal: options.journal } : {}),
  })
}

describe('data port waitFor', () => {
  function anyPort(id: string): PortSpec {
    return { kind: 'data', id, schema: z.unknown(), required: false, waitFor: 'any' }
  }

  /** Records each execution so a test can prove the node did (not) run. */
  function sinkNode(id: string, inputs: readonly PortSpec[], seen: Json[]): NodeDefinition<unknown> {
    return defineNode<unknown>({
      id,
      version: '1.0.0',
      title: id,
      category: 'test',
      config: configOf(z.object({})),
      inputs,
      outputs: [dataPort('seen')],
      execute: async (ctx) => {
        const size = seen.length
        seen.push((isRecord(ctx.input) ? ctx.input : {}) as Json)
        return { seen: size + 1 }
      },
    })
  }

  /** Completes but publishes no `value` when `emit` is absent. */
  const emitNode = defineNode<unknown>({
    id: 'test.emit',
    version: '1.0.0',
    title: 'emit',
    category: 'test',
    config: configOf(z.object({ value: z.unknown().optional() })),
    inputs: [],
    outputs: [dataPort('value')],
    execute: async (ctx) => {
      const config = isRecord(ctx.config) ? ctx.config : {}
      return Object.hasOwn(config, 'value') ? { value: (config['value'] ?? null) as Json } : {}
    },
  })

  async function run(
    nodes: GraphNode[],
    edges: GraphEdge[],
    definitions: NodeDefinition<unknown>[],
  ) {
    return await runGraph({
      graph: makeGraph('wait-for', nodes, edges),
      registry: makeRegistry(constNode, outputNode, emitNode, ...definitions),
      services: createMockRuntimeServices(),
      journal: new MemoryJournal(),
    })
  }

  test('two "any" inputs run on the first produced value', async () => {
    const seen: Json[] = []
    const sink = sinkNode('test.sink', [anyPort('a'), anyPort('b')], seen)
    const result = await run(
      [
        graphNode('none', 'test.emit', {}),
        graphNode('sink', 'test.sink', {}),
        graphNode('only', 'test.const', { value: 'A' }),
      ],
      [
        dataEdge('e1', 'none', 'value', 'sink', 'a'),
        dataEdge('e2', 'only', 'value', 'sink', 'b'),
      ],
      [sink],
    )

    expect(result.status).toBe('completed')
    expect(seen).toEqual([{ b: 'A' }])
  })

  test('one "all" plus "any" inputs waits for the all port and one any port', async () => {
    const seen: Json[] = []
    const sink = sinkNode(
      'test.sink',
      [dataPort('base'), anyPort('x'), anyPort('y')],
      seen,
    )
    const result = await run(
      [
        graphNode('xsrc', 'test.const', { value: 'X' }),
        graphNode('sink', 'test.sink', {}),
        graphNode('base', 'test.const', { value: 'B' }),
        graphNode('ysrc', 'test.emit', {}),
      ],
      [
        dataEdge('e1', 'xsrc', 'value', 'sink', 'x'),
        dataEdge('e2', 'base', 'value', 'sink', 'base'),
        dataEdge('e3', 'ysrc', 'value', 'sink', 'y'),
      ],
      [sink],
    )

    expect(result.status).toBe('completed')
    expect(seen).toEqual([{ x: 'X', base: 'B' }])
  })

  test('two "all" inputs still wait for both and deadlock when one is absent', async () => {
    const seen: Json[] = []
    const sink = sinkNode('test.sink', [dataPort('p'), dataPort('q')], seen)
    const result = await run(
      [
        graphNode('psrc', 'test.const', { value: 'P' }),
        graphNode('sink', 'test.sink', {}),
        graphNode('qsrc', 'test.emit', {}),
      ],
      [
        dataEdge('e1', 'psrc', 'value', 'sink', 'p'),
        dataEdge('e2', 'qsrc', 'value', 'sink', 'q'),
      ],
      [sink],
    )

    expect(result.status).toBe('failed')
    expect(result.error).toContain('DEADLOCK')
    expect(result.error).toContain('sink.q')
    expect(seen).toEqual([])
  })
})
