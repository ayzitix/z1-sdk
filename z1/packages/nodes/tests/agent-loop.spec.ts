import { describe, expect, test } from 'vitest'
import { dataEdge, flowEdge, graphNode, makeGraph, runBuiltins } from './helpers.ts'

/**
 * A miniature agent loop assembled from the built-in nodes: one user turn in,
 * one tool round trip, then a terminating assistant turn. It is the shape the
 * real `agent` template will take, kept small enough to assert every message.
 *
 * Both branch-local outcomes (the carrying transcript and the `done` flag) are
 * gated on their branch's flow token and joined by `core.merge`, so the merge
 * never sees the untaken side.
 */
export function loopBody() {
  return makeGraph(
    'agent-loop-body',
    [
      graphNode('bin', 'z1.core.input'),
      // A loop body's input node holds the whole `{ value, iteration }` record.
      graphNode('seedMsgs', 'z1.core.get', { path: 'value' }),
      graphNode('chat', 'z1.llm.chat', { model: { provider: 'mock', model: 'mock-1' } }),
      graphNode('branch', 'z1.flow.if'),
      graphNode('callName', 'z1.core.get', { path: '0.name' }),
      graphNode('callArgs', 'z1.core.get', { path: '0.arguments' }),
      graphNode('callId', 'z1.core.get', { path: '0.id' }),
      graphNode('tool', 'z1.tool.call'),
      graphNode('toolMsg', 'z1.core.message', { role: 'tool' }),
      graphNode('thenAssistant', 'z1.core.concat'),
      graphNode('thenMsgs', 'z1.core.concat'),
      graphNode('thenDone', 'z1.core.value', { value: false }),
      graphNode('elseMsgs', 'z1.core.concat'),
      graphNode('elseDone', 'z1.core.value', { value: true }),
      graphNode('msgsMerge', 'z1.core.merge'),
      graphNode('doneMerge', 'z1.core.merge'),
      graphNode('outValue', 'z1.core.output', { port: 'value' }),
      graphNode('outDone', 'z1.core.output', { port: 'done' }),
    ],
    [
      dataEdge('d1', 'bin', 'value', 'seedMsgs', 'value'),
      dataEdge('d2', 'seedMsgs', 'value', 'chat', 'messages'),
      dataEdge('d3', 'chat', 'hasToolCalls', 'branch', 'condition'),
      dataEdge('d4', 'chat', 'toolCalls', 'callName', 'value'),
      dataEdge('d5', 'chat', 'toolCalls', 'callArgs', 'value'),
      dataEdge('d6', 'chat', 'toolCalls', 'callId', 'value'),
      dataEdge('d7', 'callName', 'value', 'tool', 'name'),
      dataEdge('d8', 'callArgs', 'value', 'tool', 'args'),
      dataEdge('d9', 'tool', 'result', 'toolMsg', 'content'),
      dataEdge('d10', 'callId', 'value', 'toolMsg', 'toolCallId'),
      dataEdge('d11', 'seedMsgs', 'value', 'thenAssistant', 'a'),
      dataEdge('d12', 'chat', 'message', 'thenAssistant', 'b'),
      dataEdge('d13', 'thenAssistant', 'value', 'thenMsgs', 'a'),
      dataEdge('d14', 'toolMsg', 'message', 'thenMsgs', 'b'),
      dataEdge('d15', 'thenMsgs', 'value', 'msgsMerge', 'a'),
      dataEdge('d16', 'seedMsgs', 'value', 'elseMsgs', 'a'),
      dataEdge('d17', 'chat', 'message', 'elseMsgs', 'b'),
      dataEdge('d18', 'elseMsgs', 'value', 'msgsMerge', 'b'),
      dataEdge('d19', 'msgsMerge', 'value', 'outValue', 'value'),
      dataEdge('d20', 'thenDone', 'value', 'doneMerge', 'a'),
      dataEdge('d21', 'elseDone', 'value', 'doneMerge', 'b'),
      dataEdge('d22', 'doneMerge', 'value', 'outDone', 'value'),
      flowEdge('f1', 'bin', 'out', 'branch', 'in'),
      flowEdge('f2', 'branch', 'then', 'tool', 'in'),
      flowEdge('f3', 'branch', 'then', 'toolMsg', 'in'),
      flowEdge('f4', 'branch', 'then', 'thenAssistant', 'in'),
      flowEdge('f5', 'branch', 'then', 'thenMsgs', 'in'),
      flowEdge('f6', 'branch', 'then', 'thenDone', 'in'),
      flowEdge('f7', 'branch', 'else', 'elseMsgs', 'in'),
      flowEdge('f8', 'branch', 'else', 'elseDone', 'in'),
      flowEdge('f9', 'branch', 'then', 'msgsMerge', 'in'),
      flowEdge('f10', 'branch', 'else', 'msgsMerge', 'in'),
      flowEdge('f11', 'branch', 'then', 'doneMerge', 'in'),
      flowEdge('f12', 'branch', 'else', 'doneMerge', 'in'),
    ],
  )
}

export function agentGraph(body: unknown) {
  return makeGraph(
    'agent-loop',
    [
      graphNode('input', 'z1.core.input'),
      graphNode('userMsg', 'z1.core.message', { role: 'user' }),
      graphNode('empty', 'z1.core.const', { value: [] }),
      graphNode('start', 'z1.core.concat'),
      graphNode('loop', 'z1.flow.loop', { body, maxIterations: 5 }),
      graphNode('last', 'z1.core.last'),
      graphNode('text', 'z1.core.get', { path: 'content' }),
      graphNode('outText', 'z1.core.output', { port: 'text' }),
      graphNode('outMessages', 'z1.core.output', { port: 'messages' }),
      graphNode('outIterations', 'z1.core.output', { port: 'iterations' }),
    ],
    [
      dataEdge('d1', 'input', 'value', 'userMsg', 'content'),
      dataEdge('d2', 'empty', 'value', 'start', 'a'),
      dataEdge('d3', 'userMsg', 'message', 'start', 'b'),
      dataEdge('d4', 'start', 'value', 'loop', 'seed'),
      dataEdge('d5', 'loop', 'result', 'last', 'items'),
      dataEdge('d6', 'last', 'value', 'text', 'value'),
      dataEdge('d7', 'text', 'value', 'outText', 'value'),
      dataEdge('d8', 'loop', 'result', 'outMessages', 'value'),
      dataEdge('d9', 'loop', 'iterations', 'outIterations', 'value'),
      flowEdge('f1', 'input', 'out', 'loop', 'in'),
    ],
  )
}

describe('agent loop assembly', () => {
  test('runs the tool round trip and terminates on the assistant answer', async () => {
    const { result, services, events } = await runBuiltins({
      graph: agentGraph(loopBody()),
      input: '[[tool:echo]] hi',
    })

    expect(result.status).toBe('completed')
    expect(result.outputs['text']).toBe('mock: done')
    // Two iterations: tool call, then the terminating assistant turn.
    expect(result.outputs['iterations']).toBe(2)
    expect(services.toolCalls).toEqual([{ name: 'echo', args: {} }])
    const chatPaths = events
      .filter((event) => event.type === 'node.started' && event.nodeId === 'chat')
      .map((event) => event.path)
    expect(chatPaths).toEqual(['loop/0/chat', 'loop/1/chat'])

    const messages = result.outputs['messages']
    expect(Array.isArray(messages)).toBe(true)
    const roles = (messages as { role: string }[]).map((message) => message.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant'])

    const toolMessage = (messages as Record<string, unknown>[]).find(
      (message) => message['role'] === 'tool',
    )
    expect(toolMessage?.['toolCallId']).toBe('call_1')
    expect(typeof toolMessage?.['content']).toBe('string')
    expect(toolMessage?.['content']).toContain('echo')
  })

  test('a prompt without a tool marker completes in a single iteration', async () => {
    const { result, services } = await runBuiltins({
      graph: agentGraph(loopBody()),
      input: 'plain question',
    })

    expect(result.status).toBe('completed')
    expect(result.outputs['text']).toBe('mock: plain question')
    expect(result.outputs['iterations']).toBe(1)
    expect(services.toolCalls).toEqual([])
  })
})
