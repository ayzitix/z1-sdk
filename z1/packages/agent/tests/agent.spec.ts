import { describe, expect, test } from 'vitest'
import { validateGraphTree, type GraphDocument } from '@z1/graph'
import { createBuiltinRegistry } from '@z1/nodes'
import {
  createMockRuntimeServices,
  MemoryJournal,
  runGraph,
  type RunResult,
} from '@z1/runtime'
import { agentLoopExample, buildAgentGraph, type AgentGraphOptions } from '../src/index.ts'

const MODEL = { provider: 'mock', model: 'mock-1' } as const

interface Fixture {
  readonly graph: GraphDocument
  readonly result: RunResult
  readonly services: ReturnType<typeof createMockRuntimeServices>
  readonly journal: MemoryJournal
}

async function run(
  options: AgentGraphOptions,
  input: string,
  prepare?: (services: ReturnType<typeof createMockRuntimeServices>) => void,
): Promise<Fixture> {
  const graph = buildAgentGraph(options)
  const services = createMockRuntimeServices()
  const journal = new MemoryJournal()
  prepare?.(services)
  const result = await runGraph({
    graph,
    registry: createBuiltinRegistry(),
    services,
    input,
    journal,
  })
  return { graph, result, services, journal }
}

/** The stack output recorded in the journal, proving the hash is observable. */
function stackHash(journal: MemoryJournal, runId: string): string {
  const event = journal
    .read(runId)
    .find((entry) => entry.type === 'node.completed' && entry.nodeId === 'promptStack')
  if (event?.type !== 'node.completed') throw new Error('prompt stack did not complete')
  const hash = event.outputs['hash']
  if (typeof hash !== 'string') throw new Error('prompt stack hash is not a string')
  return hash
}

function systemMessage(fixture: Fixture, index = 0): string {
  const message = fixture.services.chatCalls[index]?.messages[0]
  expect(message?.role).toBe('system')
  return message?.content ?? ''
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
    const fixture = await run({ model: MODEL }, 'hello')
    const { result, services } = fixture

    expect(result.status).toBe('completed')
    expect(result.outputs['output']).toBe('mock: hello')
    expect(services.chatCalls).toHaveLength(1)
    expect(services.lastChatRequest?.messages[1]).toEqual({ role: 'user', content: 'hello' })
  })

  test('sends one system prompt with the core headings, then the user message', async () => {
    const fixture = await run({ model: MODEL }, 'hello')
    const system = systemMessage(fixture)

    expect(system).toContain('You are the z1 agent')
    expect(system).toContain('## Graph contract')
    expect(system).toContain('## Autonomy')
    expect(system).toContain('## Output')
    // The stack is materialized once: no transcript system message plus a port.
    for (const request of fixture.services.chatCalls) {
      const systems = request.messages.filter((message) => message.role === 'system')
      expect(systems).toHaveLength(1)
      expect(systems[0]?.content).toBe(system)
    }
  })

  test('feeds memory text into the prompt instead of the message list', async () => {
    const fixture = await run({ model: MODEL }, 'hello', (services) => {
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

    expect(systemMessage(fixture)).toContain('## Ancestors')
    expect(fixture.services.lastChatRequest?.messages).toHaveLength(2)
  })

  test('appends a custom system section at the end of the prompt', async () => {
    const { services } = await run({ model: MODEL, system: 'CUSTOM RULE' }, 'hello')

    const system = services.lastChatRequest?.messages[0]?.content ?? ''
    expect(system.endsWith('CUSTOM RULE')).toBe(true)
  })

  test('includes the planner delta for the planner role', async () => {
    const { services } = await run({ model: MODEL, role: 'planner' }, 'hello')

    const system = services.lastChatRequest?.messages[0]?.content ?? ''
    expect(system).toContain('## Role: Planner')
    expect(system).toContain('You plan. You do not implement.')
  })

  test('exposes a stable stack hash that changes with the custom section', async () => {
    const first = await run({ model: MODEL }, 'hello')
    const second = await run({ model: MODEL }, 'hello')
    const custom = await run({ model: MODEL, system: 'CUSTOM RULE' }, 'hello')

    const same = stackHash(first.journal, first.result.runId)
    expect(stackHash(second.journal, second.result.runId)).toBe(same)
    expect(stackHash(custom.journal, custom.result.runId)).not.toBe(same)
  })

  test('validates as a graph tree with no issues', () => {
    const graph = buildAgentGraph({ model: MODEL, tools: [{ name: 'echo', parameters: {} }] })
    expect(validateGraphTree(graph, createBuiltinRegistry())).toEqual([])
    expect(validateGraphTree(agentLoopExample, createBuiltinRegistry())).toEqual([])
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
