import { expect, test } from 'vitest'
import { builtinNodes, createBuiltinRegistry, PACKAGE } from '../src/index.ts'

test('package identity', () => {
  expect(PACKAGE).toBe('@z1/nodes')
})

test('registers every SPEC §7 node at 1.0.0', () => {
  const registry = createBuiltinRegistry()
  const ids = registry.list().map((definition) => definition.id).sort()

  expect(ids).toEqual([
    'z1.core.concat',
    'z1.core.const',
    'z1.core.fail',
    'z1.core.get',
    'z1.core.input',
    'z1.core.last',
    'z1.core.merge',
    'z1.core.message',
    'z1.core.output',
    'z1.core.template',
    'z1.core.value',
    'z1.ctx.budget',
    'z1.ctx.clip',
    'z1.ctx.compact',
    'z1.ctx.summarize',
    'z1.flow.if',
    'z1.flow.loop',
    'z1.flow.map',
    'z1.graph.subgraph',
    'z1.llm.chat',
    'z1.llm.model',
    'z1.memory.context',
    'z1.prompt.context',
    'z1.prompt.section',
    'z1.prompt.stack',
    'z1.prompt.text',
    'z1.tool.call',
    'z1.tools.list',
  ])
  expect(builtinNodes).toHaveLength(ids.length)
  for (const id of ids) expect(registry.has(id, '1.0.0')).toBe(true)
})

test('container nodes do not inherit the 120 s per-node timeout', () => {
  // The loop runs every body iteration inside one node execution; the executor's
  // default would kill a long agent turn at two minutes (observed in a real run).
  const byId = new Map(builtinNodes.map((definition) => [definition.id, definition]))
  for (const id of ['z1.flow.loop', 'z1.flow.map', 'z1.graph.subgraph']) {
    const timeout = byId.get(id)?.timeoutMs ?? 0
    expect(timeout, id).toBeGreaterThanOrEqual(1_800_000)
  }
})

test('nodes with side effects are never cached', () => {
  // The per-run cache keys on type, config, inputs and path. A node that talks
  // to the outside world must opt out, or two identical calls collapse into one.
  const effectful = [
    'z1.llm.chat',
    'z1.tool.call',
    'z1.tools.list',
    'z1.graph.subgraph',
    'z1.flow.loop',
    'z1.flow.map',
    'z1.memory.context',
  ]
  const byId = new Map(builtinNodes.map((definition) => [definition.id, definition]))
  for (const id of effectful) {
    expect(byId.get(id)?.cacheable, id).toBe(false)
  }
})
