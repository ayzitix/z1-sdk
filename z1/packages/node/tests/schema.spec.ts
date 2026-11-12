import { expect, test } from 'vitest'
import { z } from 'zod'
import {
  defineNode,
  NodeConfigError,
  parseNodeConfig,
  parsePortValue,
  portJsonSchema,
} from '../src/index.ts'
import type { NodeDefinition, PortSpec } from '../src/index.ts'

function definition(config: z.ZodType): NodeDefinition {
  return defineNode({
    id: 'schema-test',
    version: '1.0.0',
    title: 'Schema test',
    category: 'test',
    config,
    inputs: [],
    outputs: [],
    execute: async () => ({}),
  })
}

test('portJsonSchema converts object, string and array schemas', () => {
  const object = portJsonSchema({
    kind: 'data',
    id: 'payload',
    schema: z.object({ a: z.string(), b: z.number().optional() }),
  })
  expect(object).toMatchObject({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['a'],
  })

  expect(portJsonSchema({ kind: 'data', id: 's', schema: z.string() })).toMatchObject({
    type: 'string',
  })

  expect(portJsonSchema({ kind: 'data', id: 'a', schema: z.array(z.number()) })).toMatchObject({
    type: 'array',
    items: { type: 'number' },
  })
})

test('portJsonSchema handles union schemas without throwing', () => {
  const schema = portJsonSchema({
    kind: 'data',
    id: 'u',
    schema: z.union([z.string(), z.number()]),
  })
  expect(schema).toBeTypeOf('object')
  expect(schema?.type).toEqual(['string', 'number'])
})

test('portJsonSchema returns undefined for flow ports', () => {
  expect(portJsonSchema({ kind: 'flow', id: 'next' })).toBeUndefined()
})

test('portJsonSchema degrades to a permissive schema when zod cannot convert', () => {
  // z.date() is not representable in JSON Schema and makes zod throw.
  expect(() => z.toJSONSchema(z.date(), { io: 'output' })).toThrow()
  expect(portJsonSchema({ kind: 'data', id: 'when', schema: z.date() })).toEqual({})
})

test('parseNodeConfig returns the parsed value', () => {
  const node = definition(z.object({ limit: z.coerce.number() }))
  expect(parseNodeConfig(node, { limit: '42' })).toEqual({ limit: 42 })
})

test('parseNodeConfig throws NodeConfigError with node type and issues', () => {
  const node = definition(z.object({ limit: z.number() }))
  let error: unknown
  try {
    parseNodeConfig(node, { limit: 'not-a-number' })
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(NodeConfigError)
  const configError = error as NodeConfigError
  expect(configError.name).toBe('NodeConfigError')
  expect(configError.nodeType).toBe('schema-test')
  expect(configError.issues.length).toBeGreaterThanOrEqual(1)
  expect(configError.issues[0]?.path).toEqual(['limit'])
})

test('parsePortValue validates data ports', () => {
  const port: PortSpec = { kind: 'data', id: 'count', schema: z.number().int() }
  expect(parsePortValue(port, 3)).toBe(3)
  expect(() => parsePortValue(port, '3')).toThrow()
  expect(() => parsePortValue(port, 1.5)).toThrow()
})

test('parsePortValue accepts booleans on flow ports', () => {
  const port: PortSpec = { kind: 'flow', id: 'next' }
  expect(parsePortValue(port, true)).toBe(true)
  expect(parsePortValue(port, false)).toBe(false)
  expect(() => parsePortValue(port, 'yes')).toThrow(TypeError)
})
