import { describe, expect, test } from 'vitest'
import { createMockRuntimeServices } from '@z1/runtime'
import { dataEdge, flowEdge, graphNode, makeGraph, runBuiltins } from './helpers.ts'

function toolGraph(config: unknown = {}) {
  return makeGraph(
    'tool',
    [
      graphNode('name1', 'z1.core.const', { value: 'echo' }),
      graphNode('args1', 'z1.core.const', { value: { a: 1 } }),
      graphNode('call1', 'z1.tool.call', config),
      graphNode('outResult', 'z1.core.output', { port: 'result' }),
      graphNode('outError', 'z1.core.output', { port: 'isError' }),
    ],
    [
      dataEdge('d1', 'name1', 'value', 'call1', 'name'),
      dataEdge('d2', 'args1', 'value', 'call1', 'args'),
      dataEdge('d3', 'call1', 'result', 'outResult', 'value'),
      dataEdge('d4', 'call1', 'isError', 'outError', 'value'),
    ],
  )
}

describe('z1.tool.call', () => {
  test('returns the tool result', async () => {
    const { result, services } = await runBuiltins({ graph: toolGraph() })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({
      result: { ok: true, name: 'echo', args: { a: 1 } },
      isError: false,
    })
    expect(services.toolCalls).toEqual([{ name: 'echo', args: { a: 1 } }])
  })

  test('turns a throwing tool into an error result', async () => {
    const services = createMockRuntimeServices()
    services.tools.call = async () => {
      throw new Error('boom')
    }

    const { result } = await runBuiltins({ graph: toolGraph(), services })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ result: { error: 'boom' }, isError: true })
  })

  test('reports a missing tool name instead of throwing', async () => {
    const graph = makeGraph(
      'tool-no-name',
      [
        graphNode('args1', 'z1.core.const', { value: null }),
        graphNode('call1', 'z1.tool.call'),
        graphNode('outResult', 'z1.core.output', { port: 'result' }),
        graphNode('outError', 'z1.core.output', { port: 'isError' }),
      ],
      [
        dataEdge('d1', 'args1', 'value', 'call1', 'args'),
        dataEdge('d3', 'call1', 'result', 'outResult', 'value'),
        dataEdge('d4', 'call1', 'isError', 'outError', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({
      result: { error: 'tool name is required' },
      isError: true,
    })
  })

  test('errors instead of falling back when the name port is not a non-empty string', async () => {
    const graph = makeGraph(
      'tool-bad-port-name',
      [
        graphNode('name1', 'z1.core.const', { value: null }),
        graphNode('args1', 'z1.core.const', { value: {} }),
        graphNode('call1', 'z1.tool.call', { name: 'configured' }),
        graphNode('outResult', 'z1.core.output', { port: 'result' }),
        graphNode('outError', 'z1.core.output', { port: 'isError' }),
      ],
      [
        dataEdge('d1', 'name1', 'value', 'call1', 'name'),
        dataEdge('d2', 'args1', 'value', 'call1', 'args'),
        dataEdge('d3', 'call1', 'result', 'outResult', 'value'),
        dataEdge('d4', 'call1', 'isError', 'outError', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({
      result: { error: 'tool name must be a non-empty string' },
      isError: true,
    })
    // The config fallback must not be used when the port is connected.
    expect(services.toolCalls).toEqual([])
  })

  test('falls back to the configured tool name', async () => {
    const graph = makeGraph(
      'tool-config-name',
      [
        graphNode('args1', 'z1.core.const', { value: {} }),
        graphNode('call1', 'z1.tool.call', { name: 'configured' }),
        graphNode('outResult', 'z1.core.output', { port: 'result' }),
      ],
      [
        dataEdge('d1', 'args1', 'value', 'call1', 'args'),
        dataEdge('d3', 'call1', 'result', 'outResult', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ result: { ok: true, name: 'configured', args: {} } })
  })

  test('carries the flow token on out', async () => {
    const graph = makeGraph(
      'tool-flow',
      [
        graphNode('start', 'z1.core.input'),
        graphNode('name1', 'z1.core.const', { value: 'echo' }),
        graphNode('args1', 'z1.core.const', { value: {} }),
        graphNode('call1', 'z1.tool.call'),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'name1', 'value', 'call1', 'name'),
        dataEdge('d2', 'args1', 'value', 'call1', 'args'),
        dataEdge('d3', 'call1', 'result', 'out1', 'value'),
        flowEdge('f1', 'start', 'out', 'call1', 'in'),
        flowEdge('f2', 'call1', 'out', 'out1', 'in'),
      ],
    )

    const { result } = await runBuiltins({ graph, input: {} })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: { ok: true, name: 'echo', args: {} } })
  })
})
