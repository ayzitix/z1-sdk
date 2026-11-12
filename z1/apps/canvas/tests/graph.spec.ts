import type { GraphDocument } from '@z1/graph'
import type { NodeDescriptor } from '@z1/protocol'
import { describe, expect, it } from 'vitest'

import {
  canConnect,
  fromFlow,
  handleId,
  mergeRunEvent,
  toFlow,
  type RunEvent,
  type Z1FlowEdge,
} from '../src/graph.ts'

const descriptors: NodeDescriptor[] = [
  {
    id: 'text',
    version: '1.0.0',
    title: 'Text',
    category: 'core',
    inputs: [],
    outputs: [{ id: 'text', kind: 'data', schema: { type: 'string' } }],
  },
  {
    id: 'number',
    version: '1.0.0',
    title: 'Number',
    category: 'core',
    inputs: [],
    outputs: [{ id: 'value', kind: 'data', schema: { type: 'number' } }],
  },
  {
    id: 'llm',
    version: '1.0.0',
    title: 'LLM',
    category: 'ai',
    inputs: [
      { id: 'prompt', kind: 'data', required: true, schema: { type: 'string' } },
      { id: 'any', kind: 'data' },
      { id: 'in', kind: 'flow' },
    ],
    outputs: [
      { id: 'answer', kind: 'data', schema: { type: 'string' } },
      { id: 'out', kind: 'flow' },
    ],
  },
]

const graph: GraphDocument = {
  schemaVersion: 1,
  id: 'test-graph',
  title: 'Test graph',
  nodes: [
    {
      id: 'a',
      type: 'text',
      version: '1.0.0',
      config: { text: 'hello' },
      position: { x: 10, y: 20 },
      autonomy: { mode: 'ask' },
    },
    {
      id: 'b',
      type: 'llm',
      version: '1.0.0',
      config: {},
      position: { x: 300, y: 20 },
    },
  ],
  edges: [
    {
      id: 'e1',
      kind: 'data',
      from: { node: 'a', port: 'text' },
      to: { node: 'b', port: 'prompt' },
    },
  ],
}

describe('toFlow', () => {
  it('maps ids, positions, config, autonomy and handles', () => {
    const flow = toFlow(graph, descriptors)
    expect(flow.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(flow.nodes[0]?.position).toEqual({ x: 10, y: 20 })
    expect(flow.nodes[0]?.data.config).toEqual({ text: 'hello' })
    expect(flow.nodes[0]?.data.autonomy).toBe('ask')
    expect(flow.nodes[0]?.data.descriptor.id).toBe('text')
    expect(flow.nodes[1]?.data.descriptor.category).toBe('ai')
    expect(flow.edges[0]?.sourceHandle).toBe(handleId('a', 'text', 'data'))
    expect(flow.edges[0]?.targetHandle).toBe(handleId('b', 'prompt', 'data'))
    expect(flow.edges[0]?.data?.kind).toBe('data')
    expect(flow.edges[0]?.style?.stroke).toBe('#0a0a0a')
  })

  it('keeps unknown node types visible', () => {
    const flow = toFlow(
      {
        schemaVersion: 1,
        id: 'g',
        nodes: [
          { id: 'x', type: 'missing', version: '9.9.9', config: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
      descriptors,
    )
    expect(flow.nodes[0]?.data.descriptor.title).toBe('missing')
    expect(flow.nodes[0]?.data.descriptor.inputs).toEqual([])
  })
})

describe('fromFlow', () => {
  it('round-trips a graph document', () => {
    const flow = toFlow(graph, descriptors)
    const back = fromFlow(flow.nodes, flow.edges, 'Test graph')
    expect(back.schemaVersion).toBe(1)
    expect(back.title).toBe('Test graph')
    expect(back.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(back.nodes[0]?.type).toBe('text')
    expect(back.nodes[0]?.version).toBe('1.0.0')
    expect(back.nodes[0]?.position).toEqual({ x: 10, y: 20 })
    expect(back.nodes[0]?.config).toEqual({ text: 'hello' })
    expect(back.nodes[0]?.autonomy).toEqual({ mode: 'ask' })
    expect(back.edges).toEqual(graph.edges)
  })
})

describe('canConnect', () => {
  const flow = toFlow(graph, descriptors)
  const [text, llm] = flow.nodes
  if (text === undefined || llm === undefined) throw new Error('fixture is missing nodes')

  it('accepts compatible data ports', () => {
    expect(
      canConnect(
        {
          source: 'a',
          target: 'b',
          sourceHandle: handleId('a', 'text', 'data'),
          targetHandle: handleId('b', 'prompt', 'data'),
        },
        flow.nodes,
        descriptors,
      ),
    ).toBe(true)
  })

  it('rejects mismatched schema types', () => {
    const withNumber = [
      ...flow.nodes,
      {
        id: 'n',
        type: 'z1' as const,
        position: { x: 0, y: 0 },
        data: { descriptor: descriptors[1] as NodeDescriptor, config: {} },
      },
    ]
    expect(
      canConnect(
        {
          source: 'n',
          target: 'b',
          sourceHandle: handleId('n', 'value', 'data'),
          targetHandle: handleId('b', 'prompt', 'data'),
        },
        withNumber,
        descriptors,
      ),
    ).toBe(false)
  })

  it('accepts an unconstrained side', () => {
    expect(
      canConnect(
        {
          source: 'a',
          target: 'b',
          sourceHandle: handleId('a', 'text', 'data'),
          targetHandle: handleId('b', 'any', 'data'),
        },
        flow.nodes,
        descriptors,
      ),
    ).toBe(true)
  })

  it('rejects mixed kinds and self edges', () => {
    expect(
      canConnect(
        {
          source: 'a',
          target: 'b',
          sourceHandle: handleId('a', 'text', 'data'),
          targetHandle: handleId('b', 'in', 'flow'),
        },
        flow.nodes,
        descriptors,
      ),
    ).toBe(false)
    expect(
      canConnect(
        {
          source: 'b',
          target: 'b',
          sourceHandle: handleId('b', 'answer', 'data'),
          targetHandle: handleId('b', 'prompt', 'data'),
        },
        flow.nodes,
        descriptors,
      ),
    ).toBe(false)
  })

  it('rejects a second data edge into the same target port', () => {
    const existing: Z1FlowEdge = {
      id: 'existing',
      source: 'a',
      target: 'b',
      sourceHandle: handleId('a', 'text', 'data'),
      targetHandle: handleId('b', 'prompt', 'data'),
      data: { kind: 'data' },
    }
    expect(
      canConnect(
        {
          source: 'a',
          target: 'b',
          sourceHandle: handleId('a', 'text', 'data'),
          targetHandle: handleId('b', 'prompt', 'data'),
        },
        flow.nodes,
        descriptors,
        [existing],
      ),
    ).toBe(false)
  })

  it('rejects handles that do not exist', () => {
    expect(
      canConnect(
        {
          source: 'a',
          target: 'b',
          sourceHandle: handleId('a', 'nope', 'data'),
          targetHandle: handleId('b', 'prompt', 'data'),
        },
        flow.nodes,
        descriptors,
      ),
    ).toBe(false)
  })
})

describe('mergeRunEvent', () => {
  const started: RunEvent = {
    type: 'node.started',
    runId: 'r1',
    nodeId: 'a',
    path: 'a',
    attempt: 1,
    at: 1,
  }

  it('tracks running, completed and cached', () => {
    let state = mergeRunEvent({ nodeStatus: {} }, started)
    expect(state.nodeStatus['a']).toBe('running')
    state = mergeRunEvent(state, {
      type: 'node.completed',
      runId: 'r1',
      nodeId: 'a',
      path: 'a',
      attempt: 1,
      durationMs: 4,
      at: 2,
      outputs: { text: 'hi' },
    })
    expect(state.nodeStatus['a']).toBe('completed')
    state = mergeRunEvent(state, {
      type: 'node.cached',
      runId: 'r1',
      nodeId: 'a',
      path: 'a',
      at: 3,
    })
    expect(state.nodeStatus['a']).toBe('cached')
  })

  it('records the last error', () => {
    let state = mergeRunEvent({ nodeStatus: {} }, started)
    state = mergeRunEvent(state, {
      type: 'node.failed',
      runId: 'r1',
      nodeId: 'a',
      path: 'a',
      attempt: 1,
      error: 'boom',
      at: 2,
    })
    expect(state.nodeStatus['a']).toBe('failed')
    expect(state.error).toBe('boom')
  })

  it('resets the map when a run starts', () => {
    const state = mergeRunEvent(
      { nodeStatus: { a: 'completed' }, error: 'old' },
      {
        type: 'run.started',
        runId: 'r2',
        graphId: 'g',
        graphDigest: 'digest',
        at: 1,
      },
    )
    expect(state.nodeStatus).toEqual({})
  })
})
