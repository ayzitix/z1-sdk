import { describe, expect, test } from 'vitest'
import { validateGraphTree } from '@z1/graph'
import { createBuiltinRegistry } from '@z1/nodes'
import { TemplateRegistry } from '@z1/template'
import { agentTemplate, registerAgentTemplates } from '../src/index.ts'

describe('agentTemplate', () => {
  test('registerAgentTemplates registers agent.loop', () => {
    const registry = new TemplateRegistry()
    registerAgentTemplates(registry)

    expect(registry.get('agent.loop')).toBe(agentTemplate)
    expect(registry.list()).toContainEqual({
      id: 'agent.loop',
      version: '1.0.0',
      title: 'Agent loop',
      description: agentTemplate.description,
    })
  })

  test('build maps role and maxSteps into a valid graph', () => {
    const registry = new TemplateRegistry()
    registerAgentTemplates(registry)

    const graph = registry.build('agent.loop', { role: 'planner', maxSteps: 3 })

    expect(graph.id).toBe('agent.loop')
    expect(validateGraphTree(graph, createBuiltinRegistry())).toEqual([])
    expect(graph.nodes.some((node) => node.id === 'promptSection.role.planner')).toBe(true)
    const loop = graph.nodes.find((node) => node.id === 'loop')
    expect(loop?.config).toMatchObject({ maxIterations: 3 })
  })

  test('build passes the context window and reserve to the budget', () => {
    const registry = new TemplateRegistry()
    registerAgentTemplates(registry)

    const graph = registry.build('agent.loop', { contextWindow: 200_000, reserveTokens: 8_000 })
    const loop = graph.nodes.find((node) => node.id === 'loop')
    const body = (loop?.config as { body?: { nodes: { id: string; config: unknown }[] } }).body
    const budget = body?.nodes.find((node) => node.id === 'budget')
    expect(budget?.config).toMatchObject({ contextWindow: 200_000, reserveTokens: 8_000 })
    // The default stays a documented assumption, not a guess at the model.
    const fallback = registry.build('agent.loop', {})
    const fallbackLoop = fallback.nodes.find((node) => node.id === 'loop')
    const fallbackBody = (fallbackLoop?.config as { body?: { nodes: { id: string; config: unknown }[] } }).body
    expect(fallbackBody?.nodes.find((node) => node.id === 'budget')?.config).toEqual({})
  })

  test('build defaults the model to the mock provider', () => {
    const graph = agentTemplate.build?.({})
    const loop = graph?.nodes.find((node) => node.id === 'loop')
    // The chat node lives inside the loop body config, so the assertion walks
    // the serialized config rather than the top-level node list.
    expect(JSON.stringify(loop?.config)).toContain('"provider":"mock"')
    expect(JSON.stringify(loop?.config)).toContain('"model":"mock-1"')
  })
})
