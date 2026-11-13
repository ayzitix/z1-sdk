import { describe, expect, test } from 'vitest'
import { dataEdge, flowEdge, graphNode, makeGraph, runBuiltins, streamedText } from './helpers.ts'

describe('z1.llm nodes', () => {
  test('model -> chat streams text and prepends the system message', async () => {
    const graph = makeGraph(
      'chat',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('msgs', 'z1.core.const', {
          value: [{ role: 'user', content: 'hi there' }],
        }),
        graphNode('chat1', 'z1.llm.chat', { system: 'be brief', maxTokens: 64 }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d3', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, events, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: 'mock: hi there' })
    expect(streamedText(events, 'chat1')).toBe('mock: hi there')
    expect(
      events.some((event) => event.type === 'node.stream' && event.port === 'text'),
    ).toBe(true)

    const call = services.chatCalls[0]
    expect(call?.model).toEqual({ provider: 'mock', model: 'mock-1' })
    expect(call?.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(call?.messages[1]).toEqual({ role: 'user', content: 'hi there' })
    expect(call?.maxTokens).toBe(64)
  })

  test('exposes a tool call from the model reply', async () => {
    const graph = makeGraph(
      'chat-tool',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('msgs', 'z1.core.const', {
          value: [{ role: 'user', content: '[[tool:echo]]' }],
        }),
        graphNode('chat1', 'z1.llm.chat'),
        graphNode('out1', 'z1.core.output', { port: 'tools' }),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d3', 'chat1', 'toolCalls', 'out1', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    const calls = result.outputs['tools']
    expect(Array.isArray(calls)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls).toMatchObject([{ name: 'echo' }])
  })

  test('accepts a plain prompt when messages are absent', async () => {
    const graph = makeGraph(
      'chat-prompt',
      [
        graphNode('input1', 'z1.core.input'),
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('chat1', 'z1.llm.chat'),
        graphNode('outText', 'z1.core.output', { port: 'text' }),
        graphNode('outHas', 'z1.core.output', { port: 'hasToolCalls' }),
      ],
      [
        dataEdge('d1', 'input1', 'value', 'chat1', 'prompt'),
        dataEdge('d2', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d3', 'chat1', 'text', 'outText', 'value'),
        dataEdge('d4', 'chat1', 'hasToolCalls', 'outHas', 'value'),
        flowEdge('f1', 'input1', 'out', 'chat1', 'in'),
        flowEdge('f2', 'chat1', 'out', 'outText', 'in'),
        flowEdge('f3', 'chat1', 'out', 'outHas', 'in'),
      ],
    )

    const { result, services } = await runBuiltins({ graph, input: 'hi there' })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ text: 'mock: hi there', hasToolCalls: false })
    expect(services.chatCalls[0]?.messages).toEqual([{ role: 'user', content: 'hi there' }])
  })

  test('reports hasToolCalls when the reply carries a tool call', async () => {
    const graph = makeGraph(
      'chat-has-tool-calls',
      [
        graphNode('input1', 'z1.core.input'),
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('chat1', 'z1.llm.chat'),
        graphNode('outHas', 'z1.core.output', { port: 'hasToolCalls' }),
      ],
      [
        dataEdge('d1', 'input1', 'value', 'chat1', 'prompt'),
        dataEdge('d2', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d3', 'chat1', 'hasToolCalls', 'outHas', 'value'),
        flowEdge('f1', 'input1', 'out', 'chat1', 'in'),
        flowEdge('f2', 'chat1', 'out', 'outHas', 'in'),
      ],
    )

    const { result } = await runBuiltins({ graph, input: '[[tool:echo]]' })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ hasToolCalls: true })
  })

  test('a connected model port wins over config.model', async () => {
    const graph = makeGraph(
      'chat-port-model',
      [
        graphNode('portModel', 'z1.llm.model', { provider: 'mock', model: 'port-model' }),
        graphNode('msgs', 'z1.core.const', { value: [{ role: 'user', content: 'hi' }] }),
        graphNode('chat1', 'z1.llm.chat', {
          model: { provider: 'mock', model: 'config-model' },
        }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'portModel', 'model', 'chat1', 'model'),
        dataEdge('d2', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d3', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.chatCalls[0]?.model).toEqual({ provider: 'mock', model: 'port-model' })
  })

  test('a connected system port wins over config.system', async () => {
    const graph = makeGraph(
      'chat-system-port',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('sys', 'z1.core.const', { value: 'from the port' }),
        graphNode('msgs', 'z1.core.const', { value: [{ role: 'user', content: 'hi' }] }),
        graphNode('chat1', 'z1.llm.chat', { system: 'from config' }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'sys', 'value', 'chat1', 'system'),
        dataEdge('d3', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d4', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.chatCalls[0]?.messages).toEqual([
      { role: 'system', content: 'from the port' },
      { role: 'user', content: 'hi' },
    ])
  })

  test('an empty system port string means no system message', async () => {
    const graph = makeGraph(
      'chat-system-empty-port',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('sys', 'z1.core.const', { value: '   ' }),
        graphNode('msgs', 'z1.core.const', { value: [{ role: 'user', content: 'hi' }] }),
        graphNode('chat1', 'z1.llm.chat', { system: 'from config' }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'sys', 'value', 'chat1', 'system'),
        dataEdge('d3', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d4', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.chatCalls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('config.system still applies when the system port is disconnected', async () => {
    const graph = makeGraph(
      'chat-system-config',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('msgs', 'z1.core.const', { value: [{ role: 'user', content: 'hi' }] }),
        graphNode('chat1', 'z1.llm.chat', { system: 'config only' }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d3', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.chatCalls[0]?.messages[0]).toEqual({ role: 'system', content: 'config only' })
  })

  test('does not prepend the configured system message when messages already start with one', async () => {
    const graph = makeGraph(
      'chat-system-dedup',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('msgs', 'z1.core.const', {
          value: [
            { role: 'system', content: 'keep me' },
            { role: 'user', content: 'hi' },
          ],
        }),
        graphNode('chat1', 'z1.llm.chat', { system: 'be brief' }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d3', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.chatCalls[0]?.messages).toEqual([
      { role: 'system', content: 'keep me' },
      { role: 'user', content: 'hi' },
    ])
  })

  test('ignores prompt when messages are present', async () => {
    const graph = makeGraph(
      'chat-prompt-ignored',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('msgs', 'z1.core.const', {
          value: [{ role: 'user', content: 'from messages' }],
        }),
        graphNode('prompt', 'z1.core.const', { value: 'from prompt' }),
        graphNode('chat1', 'z1.llm.chat'),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'msgs', 'value', 'chat1', 'messages'),
        dataEdge('d3', 'prompt', 'value', 'chat1', 'prompt'),
        dataEdge('d4', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.chatCalls[0]?.messages).toEqual([{ role: 'user', content: 'from messages' }])
  })

  test('treats an empty prompt as a user message with empty content', async () => {
    const graph = makeGraph(
      'chat-empty-prompt',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('prompt', 'z1.core.const', { value: '' }),
        graphNode('chat1', 'z1.llm.chat'),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'prompt', 'value', 'chat1', 'prompt'),
        dataEdge('d3', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.chatCalls[0]?.messages).toEqual([{ role: 'user', content: '' }])
  })

  test('fails clearly when no model is provided', async () => {
    const graph = makeGraph(
      'chat-no-model',
      [graphNode('chat1', 'z1.llm.chat'), graphNode('out1', 'z1.core.output')],
      [dataEdge('d1', 'chat1', 'text', 'out1', 'value')],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('no model')
  })

  test('forwards a connected tools declaration to the model request', async () => {
    const tools = [
      { name: 'echo', description: 'Echo text', parameters: { type: 'object' } },
    ]
    const graph = makeGraph(
      'chat-tools',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('prompt', 'z1.core.const', { value: 'hi' }),
        graphNode('decls', 'z1.core.const', { value: tools }),
        graphNode('chat1', 'z1.llm.chat'),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'prompt', 'value', 'chat1', 'prompt'),
        dataEdge('d3', 'decls', 'value', 'chat1', 'tools'),
        dataEdge('d4', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { result, services } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(services.lastChatRequest?.tools).toEqual(tools)
  })

  test('omits tools when no port is connected', async () => {
    const graph = makeGraph(
      'chat-no-tools',
      [
        graphNode('model1', 'z1.llm.model', { provider: 'mock', model: 'mock-1' }),
        graphNode('prompt', 'z1.core.const', { value: 'hi' }),
        graphNode('chat1', 'z1.llm.chat'),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'model1', 'model', 'chat1', 'model'),
        dataEdge('d2', 'prompt', 'value', 'chat1', 'prompt'),
        dataEdge('d3', 'chat1', 'text', 'out1', 'value'),
      ],
    )

    const { services } = await runBuiltins({ graph })

    expect(services.lastChatRequest).toBeDefined()
    expect(services.lastChatRequest?.tools).toBeUndefined()
  })
})
