import { expect, test } from 'vitest'
import { z } from 'zod'
import { defineNode, NodeRegistry } from '../src/index.ts'
import type { NodeDefinition } from '../src/index.ts'

function node(id: string, version: string): NodeDefinition {
  return defineNode({
    id,
    version,
    title: `${id} v${version}`,
    category: 'test',
    config: z.object({}),
    inputs: [],
    outputs: [],
    execute: async () => ({}),
  })
}

test('register throws for a duplicate id + version', () => {
  const registry = new NodeRegistry()
  registry.register(node('a', '1.0.0'))
  expect(() => registry.register(node('a', '1.0.0'))).toThrow(/already registered/)
})

test('register accepts the same id with a different version', () => {
  const registry = new NodeRegistry()
  registry.register(node('a', '1.0.0'))
  registry.register(node('a', '2.0.0'))
  expect(registry.list()).toHaveLength(2)
})

test('get(id) returns the only registered version', () => {
  const registry = new NodeRegistry()
  const only = node('a', '1.0.0')
  registry.register(only)
  expect(registry.get('a')).toBe(only)
})

test('get(id) throws when the id has several versions', () => {
  const registry = new NodeRegistry()
  registry.register(node('a', '1.0.0'))
  registry.register(node('a', '2.0.0'))
  expect(() => registry.get('a')).toThrow(/specify a version/)
})

test('get(id, version) returns the exact version', () => {
  const registry = new NodeRegistry()
  const first = node('a', '1.0.0')
  const second = node('a', '2.0.0')
  registry.register(first)
  registry.register(second)
  expect(registry.get('a', '1.0.0')).toBe(first)
  expect(registry.get('a', '2.0.0')).toBe(second)
})

test('get returns undefined for unknown ids and versions', () => {
  const registry = new NodeRegistry()
  registry.register(node('a', '1.0.0'))
  expect(registry.get('missing')).toBeUndefined()
  expect(registry.get('a', '9.9.9')).toBeUndefined()
})

test('has reports existence, optionally for an exact version', () => {
  const registry = new NodeRegistry()
  registry.register(node('a', '1.0.0'))
  expect(registry.has('a')).toBe(true)
  expect(registry.has('a', '1.0.0')).toBe(true)
  expect(registry.has('a', '2.0.0')).toBe(false)
  expect(registry.has('missing')).toBe(false)
})

test('list returns every definition across versions', () => {
  const registry = new NodeRegistry()
  registry.register(node('a', '1.0.0'))
  registry.register(node('b', '1.0.0'))
  registry.register(node('a', '2.0.0'))
  expect(registry.list().map((definition) => `${definition.id}@${definition.version}`)).toEqual([
    'a@1.0.0',
    'a@2.0.0',
    'b@1.0.0',
  ])
  expect(new NodeRegistry().list()).toEqual([])
})
