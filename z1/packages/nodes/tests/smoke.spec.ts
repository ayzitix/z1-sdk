import { expect, test } from 'vitest'
import { builtinNodes, createBuiltinRegistry, PACKAGE } from '../src/index.ts'

test('package identity', () => {
  expect(PACKAGE).toBe('@z1/nodes')
})

test('registers every SPEC §7 node at 1.0.0', () => {
  const registry = createBuiltinRegistry()
  const ids = registry.list().map((definition) => definition.id).sort()

  expect(ids).toEqual([
    'z1.core.const',
    'z1.core.input',
    'z1.core.output',
    'z1.core.template',
    'z1.flow.if',
    'z1.flow.loop',
    'z1.flow.map',
    'z1.graph.subgraph',
    'z1.llm.chat',
    'z1.llm.model',
    'z1.tool.call',
  ])
  expect(builtinNodes).toHaveLength(ids.length)
  for (const id of ids) expect(registry.has(id, '1.0.0')).toBe(true)
})
