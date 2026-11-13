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

  test('get resolves nested paths, array indices, misses and prototype keys', async () => {
    async function runGet(value: unknown, path: string) {
      const graph = makeGraph(
        'get',
        [
          graphNode('src', 'z1.core.const', { value }),
          graphNode('get', 'z1.core.get', { path }),
          graphNode('out', 'z1.core.output'),
        ],
        [
          dataEdge('d1', 'src', 'value', 'get', 'value'),
          dataEdge('d2', 'get', 'value', 'out', 'value'),
        ],
      )
      const { result } = await runBuiltins({ graph })
      expect(result.status).toBe('completed')
      return result.outputs['output']
    }

    expect(await runGet({ a: { b: 'deep' } }, 'a.b')).toBe('deep')
    expect(await runGet({ items: [{ name: 'first' }] }, 'items.0.name')).toBe('first')
    expect(await runGet({ a: 1 }, 'a.b.c')).toBeNull()
    expect(await runGet({ a: 1 }, '__proto__')).toBeNull()
    expect(await runGet({}, 'constructor.name')).toBeNull()
  })

  test('concat appends a scalar and spreads an array', async () => {
    async function runConcat(a: unknown, b: unknown) {
      const graph = makeGraph(
        'concat',
        [
          graphNode('srcA', 'z1.core.const', { value: a }),
          graphNode('srcB', 'z1.core.const', { value: b }),
          graphNode('cat', 'z1.core.concat'),
          graphNode('out', 'z1.core.output'),
        ],
        [
          dataEdge('d1', 'srcA', 'value', 'cat', 'a'),
          dataEdge('d2', 'srcB', 'value', 'cat', 'b'),
          dataEdge('d3', 'cat', 'value', 'out', 'value'),
        ],
      )
      const { result } = await runBuiltins({ graph })
      expect(result.status).toBe('completed')
      return result.outputs['output']
    }

    expect(await runConcat([1, 2], 'x')).toEqual([1, 2, 'x'])
    expect(await runConcat([1], [2, 3])).toEqual([1, 2, 3])
  })

  test('message builds assistant tool calls, tool results and stringified content', async () => {
    async function runMessage(config: unknown, inputs: Record<string, unknown>) {
      const nodes = [graphNode('msg', 'z1.core.message', config), graphNode('out', 'z1.core.output')]
      const edges = [dataEdge('d0', 'msg', 'message', 'out', 'value')]
      let index = 0
      for (const [port, value] of Object.entries(inputs)) {
        index += 1
        nodes.push(graphNode(`src${String(index)}`, 'z1.core.const', { value }))
        edges.push(dataEdge(`d${String(index)}`, `src${String(index)}`, 'value', 'msg', port))
      }
      const { result } = await runBuiltins({ graph: makeGraph('message', nodes, edges) })
      expect(result.status).toBe('completed')
      return result.outputs['output']
    }

    const calls = [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }]
    expect(
      await runMessage({ role: 'assistant' }, { content: 'hi', toolCalls: calls }),
    ).toEqual({ role: 'assistant', content: 'hi', toolCalls: calls })

    const tool = await runMessage({ role: 'tool' }, { content: 'result', toolCallId: 'c1' })
    expect(tool).toEqual({ role: 'tool', content: 'result', toolCallId: 'c1' })
    expect(Object.hasOwn(tool as Record<string, unknown>, 'toolCalls')).toBe(false)

    expect(await runMessage({ role: 'user' }, { content: { ok: true } })).toEqual({
      role: 'user',
      content: '{"ok":true}',
    })
  })

  test('last emits the final item or null when empty', async () => {
    async function runLast(items: unknown) {
      const graph = makeGraph(
        'last',
        [
          graphNode('src', 'z1.core.const', { value: items }),
          graphNode('last', 'z1.core.last'),
          graphNode('out', 'z1.core.output'),
        ],
        [
          dataEdge('d1', 'src', 'value', 'last', 'items'),
          dataEdge('d2', 'last', 'value', 'out', 'value'),
        ],
      )
      const { result } = await runBuiltins({ graph })
      expect(result.status).toBe('completed')
      return result.outputs['output']
    }

    expect(await runLast([])).toBeNull()
    expect(await runLast([1, 'two'])).toBe('two')
  })

  test('merge prefers a and falls back to b', async () => {
    async function runMerge(inputs: Record<string, unknown>) {
      const nodes = [graphNode('merge', 'z1.core.merge'), graphNode('out', 'z1.core.output')]
      const edges = [dataEdge('d0', 'merge', 'value', 'out', 'value')]
      let index = 0
      for (const [port, value] of Object.entries(inputs)) {
        index += 1
        nodes.push(graphNode(`src${String(index)}`, 'z1.core.const', { value }))
        edges.push(dataEdge(`d${String(index)}`, `src${String(index)}`, 'value', 'merge', port))
      }
      const { result } = await runBuiltins({ graph: makeGraph('merge', nodes, edges) })
      expect(result.status).toBe('completed')
      return result.outputs['output']
    }

    expect(await runMerge({ a: 'first', b: 'second' })).toBe('first')
    expect(await runMerge({ b: 'second' })).toBe('second')
  })

  async function runBranchMerge(condition: boolean) {
    const graph = makeGraph(
      `branch-merge-${String(condition)}`,
      [
        graphNode('start', 'z1.core.input'),
        graphNode('cond', 'z1.core.const', { value: condition }),
        graphNode('branch', 'z1.flow.if'),
        graphNode('vThen', 'z1.core.value', { value: 'T' }),
        graphNode('vElse', 'z1.core.value', { value: 'E' }),
        graphNode('merge', 'z1.core.merge'),
        graphNode('out', 'z1.core.output'),
      ],
      [
        flowEdge('f1', 'start', 'out', 'branch', 'in'),
        dataEdge('d1', 'cond', 'value', 'branch', 'condition'),
        flowEdge('f2', 'branch', 'then', 'vThen', 'in'),
        flowEdge('f3', 'branch', 'else', 'vElse', 'in'),
        dataEdge('d2', 'vThen', 'value', 'merge', 'a'),
        dataEdge('d3', 'vElse', 'value', 'merge', 'b'),
        flowEdge('f4', 'branch', 'then', 'merge', 'in'),
        flowEdge('f5', 'branch', 'else', 'merge', 'in'),
        dataEdge('d4', 'merge', 'value', 'out', 'value'),
      ],
    )
    return await runBuiltins({ graph, input: null })
  }

  test('a flow-gated merge sees only the executed branch and runs once', async () => {
    for (const condition of [true, false]) {
      const { result, events } = await runBranchMerge(condition)
      expect(result.status).toBe('completed')
      expect(result.outputs).toEqual({ output: condition ? 'T' : 'E' })
      const merges = events.filter(
        (event) => event.type === 'node.completed' && event.nodeId === 'merge',
      )
      expect(merges).toHaveLength(1)
    }
  })

  test('core.value only fires on its branch and never as a root', async () => {
    const { result, events } = await runBranchMerge(false)
    expect(result.status).toBe('completed')
    expect(events.some((event) => event.type === 'node.completed' && event.nodeId === 'vThen')).toBe(
      false,
    )
  })

  test('flow-gated assembly nodes only run when their token arrives', async () => {
    const cases = [
      {
        type: 'z1.core.get',
        config: { path: 'a' },
        inputs: { value: { a: 'X' } },
        output: 'value',
        expected: 'X',
      },
      {
        type: 'z1.core.concat',
        config: {},
        inputs: { a: [1], b: 2 },
        output: 'value',
        expected: [1, 2],
      },
      {
        type: 'z1.core.message',
        config: { role: 'user' },
        inputs: { content: 'hi' },
        output: 'message',
        expected: { role: 'user', content: 'hi' },
      },
    ]

    for (const entry of cases) {
      for (const condition of [true, false]) {
        const nodes = [
          graphNode('start', 'z1.core.input'),
          graphNode('cond', 'z1.core.const', { value: condition }),
          graphNode('branch', 'z1.flow.if'),
          graphNode('gated', entry.type, entry.config),
          graphNode('fallback', 'z1.core.const', { value: 'unused' }),
          graphNode('outThen', 'z1.core.output', { port: 'then' }),
          graphNode('outElse', 'z1.core.output', { port: 'else' }),
        ]
        const edges = [
          flowEdge('f1', 'start', 'out', 'branch', 'in'),
          dataEdge('d1', 'cond', 'value', 'branch', 'condition'),
          flowEdge('f2', 'branch', 'then', 'gated', 'in'),
          flowEdge('f3', 'branch', 'then', 'outThen', 'in'),
          flowEdge('f4', 'branch', 'else', 'outElse', 'in'),
          dataEdge('d2', 'gated', entry.output, 'outThen', 'value'),
          dataEdge('d3', 'fallback', 'value', 'outElse', 'value'),
        ]
        let index = 0
        for (const [port, value] of Object.entries(entry.inputs)) {
          index += 1
          nodes.push(graphNode(`src${String(index)}`, 'z1.core.const', { value }))
          edges.push(dataEdge(`ds${String(index)}`, `src${String(index)}`, 'value', 'gated', port))
        }

        const { result, events } = await runBuiltins({
          graph: makeGraph(`gated-${entry.type}-${String(condition)}`, nodes, edges),
          input: null,
        })

        expect(result.status).toBe('completed')
        expect(result.outputs).toEqual(condition ? { then: entry.expected } : { else: 'unused' })
        const ran = events.some(
          (event) => event.type === 'node.completed' && event.nodeId === 'gated',
        )
        expect(ran).toBe(condition)
      }
    }
  })
})
