import { describe, expect, test } from 'vitest'
import { dataEdge, flowEdge, graphNode, makeGraph, runBuiltins } from './helpers.ts'

/** Renders one template against a constant vars value. */
async function runTemplate(vars: unknown, template: string) {
  const graph = makeGraph(
    'template-case',
    [
      graphNode('const1', 'z1.core.const', { value: vars }),
      graphNode('tpl', 'z1.core.template', { template }),
      graphNode('out1', 'z1.core.output'),
    ],
    [
      dataEdge('d1', 'const1', 'value', 'tpl', 'vars'),
      dataEdge('d2', 'tpl', 'text', 'out1', 'value'),
    ],
  )
  return await runBuiltins({ graph })
}

describe('z1.core nodes', () => {

  test('input -> template -> output renders the run input', async () => {
    const graph = makeGraph(
      'hello',
      [
        graphNode('in1', 'z1.core.input'),
        graphNode('tpl', 'z1.core.template', { template: 'hello {{name}}' }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'in1', 'value', 'tpl', 'vars'),
        dataEdge('d2', 'tpl', 'text', 'out1', 'value'),
        flowEdge('f1', 'in1', 'out', 'out1', 'in'),
      ],
    )

    const { result } = await runBuiltins({ graph, input: { name: 'world' } })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'hello world' })
  })

  test('template renders nested paths, empty misses and leaves malformed placeholders alone', async () => {
    const graph = makeGraph(
      'template',
      [
        graphNode('const1', 'z1.core.const', { value: { a: { b: 'deep' }, n: 2 } }),
        graphNode('tpl', 'z1.core.template', {
          template: '{{a.b}}|{{n}}|{{missing}}|{{bad key}}',
        }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'const1', 'value', 'tpl', 'vars'),
        dataEdge('d2', 'tpl', 'text', 'out1', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'deep|2||{{bad key}}' })
  })

  test('template indexes arrays with numeric segments', async () => {
    const { result } = await runTemplate(
      { list: [{ name: 'first' }, { name: 'second' }] },
      '{{list.1.name}}|{{list.0.name}}|{{list.9.name}}',
    )

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'second|first|' })
  })

  test('template refuses prototype keys and inherited properties', async () => {
    const { result } = await runTemplate(
      { a: { b: 'x' } },
      '[{{__proto__}}][{{prototype}}][{{a.constructor}}][{{a.__proto__}}][{{a.toString}}]',
    )

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: '[][][][][]' })
  })

  test('template renders empty for non-object vars', async () => {
    const scalar = await runTemplate(42, '{{a}}')
    const array = await runTemplate([1, 2], '{{0}}|{{length}}|{{a.b}}')

    expect(scalar.result.outputs).toEqual({ output: '' })
    expect(array.result.outputs).toEqual({ output: '1||' })
  })

  test('template renders empty when a nested path is missing', async () => {
    const graph = makeGraph(
      'template-missing',
      [
        graphNode('const1', 'z1.core.const', { value: { a: { b: 'leaf' }, n: null } }),
        graphNode('tpl', 'z1.core.template', { template: '{{a.b.c}}|{{a.missing.deep}}|{{n.x}}' }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'const1', 'value', 'tpl', 'vars'),
        dataEdge('d2', 'tpl', 'text', 'out1', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: '||' })
  })

  test('const emits its config value and honours the output port name', async () => {
    const graph = makeGraph(
      'const',
      [
        graphNode('const1', 'z1.core.const', { value: { list: [1, 2] } }),
        graphNode('out1', 'z1.core.output', { port: 'greeting' }),
      ],
      [dataEdge('d1', 'const1', 'value', 'out1', 'value')],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ greeting: { list: [1, 2] } })
  })
})
