import { describe, expect, test } from 'vitest'
import { dataEdge, flowEdge, graphNode, makeGraph, runBuiltins } from './helpers.ts'

describe('z1.graph.subgraph', () => {
  const nested = makeGraph(
    'nested',
    [
      graphNode('nin', 'z1.core.input'),
      graphNode('ntpl', 'z1.core.template', { template: 'sub:{{name}}' }),
      graphNode('nout', 'z1.core.output'),
    ],
    [
      dataEdge('n1', 'nin', 'value', 'ntpl', 'vars'),
      dataEdge('n2', 'ntpl', 'text', 'nout', 'value'),
    ],
  )

  test('returns the nested graph output', async () => {
    const graph = makeGraph(
      'parent',
      [
        graphNode('in1', 'z1.core.input'),
        graphNode('sg', 'z1.graph.subgraph', { graph: nested }),
        graphNode('out1', 'z1.core.output', { port: 'sub' }),
      ],
      [
        flowEdge('f1', 'in1', 'out', 'sg', 'in'),
        dataEdge('d1', 'in1', 'value', 'sg', 'input'),
        flowEdge('f2', 'sg', 'out', 'out1', 'in'),
        dataEdge('d2', 'sg', 'output', 'out1', 'value'),
      ],
    )

    const { result, events } = await runBuiltins({ graph, input: { name: 'nested' } })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ sub: 'sub:nested' })
    // Nested execution keeps the parent path prefix.
    expect(
      events.some((event) => event.type === 'node.started' && event.path.startsWith('sg/')),
    ).toBe(true)
  })

  test('runs without an input value', async () => {
    const noInput = makeGraph(
      'nested-no-input',
      [graphNode('nout', 'z1.core.const', { value: 'alone' }), graphNode('out1', 'z1.core.output')],
      [dataEdge('n1', 'nout', 'value', 'out1', 'value')],
    )
    const graph = makeGraph(
      'parent-no-input',
      [graphNode('sg', 'z1.graph.subgraph', { graph: noInput }), graphNode('out1', 'z1.core.output')],
      [dataEdge('d1', 'sg', 'output', 'out1', 'value')],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'alone' })
  })

  test('selects the default output port when the body exposes several', async () => {
    const twoOutputs = makeGraph(
      'nested-two-outputs',
      [
        graphNode('valA', 'z1.core.const', { value: 'A' }),
        graphNode('valB', 'z1.core.const', { value: 'B' }),
        graphNode('outMain', 'z1.core.output'),
        graphNode('outExtra', 'z1.core.output', { port: 'extra' }),
      ],
      [
        dataEdge('n1', 'valA', 'value', 'outMain', 'value'),
        dataEdge('n2', 'valB', 'value', 'outExtra', 'value'),
      ],
    )
    const parent = (config: unknown) =>
      makeGraph(
        'parent-multi',
        [
          graphNode('sg', 'z1.graph.subgraph', config),
          graphNode('out1', 'z1.core.output'),
        ],
        [dataEdge('d1', 'sg', 'output', 'out1', 'value')],
      )

    const defaulted = await runBuiltins({ graph: parent({ graph: twoOutputs }) })
    const selected = await runBuiltins({
      graph: parent({ graph: twoOutputs, outputPort: 'extra' }),
    })

    expect(defaulted.result.outputs).toEqual({ output: 'A' })
    expect(selected.result.outputs).toEqual({ output: 'B' })
  })

  test('falls back to the whole outputs map when the port is absent', async () => {
    const onlyExtra = makeGraph(
      'nested-only-extra',
      [
        graphNode('valB', 'z1.core.const', { value: 'B' }),
        graphNode('outExtra', 'z1.core.output', { port: 'extra' }),
      ],
      [dataEdge('n1', 'valB', 'value', 'outExtra', 'value')],
    )
    const graph = makeGraph(
      'parent-fallback',
      [graphNode('sg', 'z1.graph.subgraph', { graph: onlyExtra }), graphNode('out1', 'z1.core.output')],
      [dataEdge('d1', 'sg', 'output', 'out1', 'value')],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: { extra: 'B' } })
  })
})
