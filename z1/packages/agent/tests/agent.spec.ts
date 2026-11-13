import { describe, expect, test } from 'vitest'
import { validateGraphTree, type GraphDocument } from '@z1/graph'
import { createBuiltinRegistry } from '@z1/nodes'
import { createMockRuntimeServices, runGraph, type RunResult } from '@z1/runtime'
import { agentLoopExample, buildAgentGraph, type AgentGraphOptions } from '../src/index.ts'

const MODEL = { provider: 'mock', model: 'mock-1' } as const

interface Fixture {
  readonly graph: GraphDocument
  readonly result: RunResult
  readonly services: ReturnType<typeof createMockRuntimeServices>
}

async function run(
  options: AgentGraphOptions,
  input: string,
  prepare?: (services: ReturnType<typeof createMockRuntimeServices>) => void,
): Promise<Fixture> {
  const graph = buildAgentGraph(options)
  const services = createMockRuntimeServices()
  prepare?.(services)
  const result = await runGraph({
    graph,
    registry: createBuiltinRegistry(),
    services,
    input,
  })
  return { graph, result, services }
}

describe('buildAgentGraph', () => {
  test('runs the tool round trip and terminates on the assistant answer', async () => {
    const { result, services } = await run({ model: MODEL }, '[[tool:echo]] hi')

    expect(result.status).toBe('completed')
    expect(result.outputs['output']).toBe('mock: done')
    expect(services.toolCalls).toEqual([{ name: 'echo', args: {} }])
    // Tool call turn, then the terminating assistant turn.
    expect(services.chatCalls).toHaveLength(2)
  })

  test('answers a plain prompt in exactly one chat call', async () => {
    const { result, services } = await run({ model: MODEL }, 'hello')

    expect(result.status).toBe('completed')
    expect(result.outputs['output']).toBe('mock: hello')
    expect(services.chatCalls).toHaveLength(1)
    // No memory service, so the user message is still the first thing the model sees.
    expect(services.lastChatRequest?.messages[0]).toEqual({ role: 'user', content: 'hello' })
  })

  test('prepends memory messages before the user message', async () => {
    const { services } = await run({ model: MODEL }, 'hello', (services) => {
      services.memory = {
        buildContext: async () => ({
          text: '## Ancestors\n- root chat chat: {"text":"hi"}',
          messages: [{ role: 'system', content: 'Context from the branch tree:\n## Ancestors' }],
          spine: ['root chat chat: {"text":"hi"}'],
          siblings: [],
          recent: [],
        }),
      }
    })

    expect(services.lastChatRequest?.messages[0]).toEqual({
      role: 'system',
      content: 'Context from the branch tree:\n## Ancestors',
    })
    expect(services.lastChatRequest?.messages[1]).toEqual({ role: 'user', content: 'hello' })
  })

  test('validates as a graph tree with no issues', () => {
    const graph = buildAgentGraph({ model: MODEL, tools: [{ name: 'echo', parameters: {} }] })
    expect(validateGraphTree(graph, createBuiltinRegistry())).toEqual([])
    expect(validateGraphTree(agentLoopExample, createBuiltinRegistry())).toEqual([])
  })

  test('puts the configured system message first in the chat request', async () => {
    const { services } = await run({ model: MODEL, system: 'You are terse.' }, 'hello')

    const request = services.lastChatRequest
    expect(request).toBeDefined()
    expect(request?.messages[0]).toEqual({ role: 'system', content: 'You are terse.' })
  })

  test('stops at maxSteps even when the model always asks for a tool', async () => {
    const { result, services } = await run({ model: MODEL, maxSteps: 1 }, '[[tool:echo]] again')

    expect(result.status).toBe('completed')
    // One body run only: the tool was called once and the loop stopped on the cap.
    expect(services.chatCalls).toHaveLength(1)
    expect(services.toolCalls).toHaveLength(1)
    expect(typeof result.outputs['output']).toBe('string')
  })
})
