import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { NodeRegistry, defineNode } from '@z1/node'

import { describeNode, describeNodes, type NodeDescriptor } from '../src/index.ts'

function registry(): NodeRegistry {
  const registry = new NodeRegistry()
  registry.register(
    defineNode({
      id: 'test.echo',
      version: '1.0.0',
      title: 'Echo',
      category: 'test',
      config: z.object({}),
      inputs: [
        { kind: 'flow', id: 'in' },
        { kind: 'data', id: 'value', schema: z.string() },
      ],
      outputs: [
        { kind: 'data', id: 'text', schema: z.string(), required: false, mode: 'stream' },
        { kind: 'data', id: 'count', schema: z.number() },
        { kind: 'flow', id: 'out' },
      ],
      execute: async () => ({ text: 'hi', count: 1 }),
    }),
  )
  registry.register(
    defineNode({
      id: 'test.const',
      version: '2.0.0',
      title: 'Const',
      category: 'test',
      config: z.object({ value: z.string() }),
      inputs: [],
      outputs: [{ kind: 'data', id: 'value', schema: z.string() }],
      execute: async () => ({ value: 'x' }),
    }),
  )
  return registry
}

describe('describeNodes', () => {
  test('lists every registered node in insertion order', () => {
    const nodes = describeNodes(registry())
    expect(nodes.map((node) => `${node.id}@${node.version}`)).toEqual([
      'test.echo@1.0.0',
      'test.const@2.0.0',
    ])
  })

  test('flattens ports into JSON-safe descriptors', () => {
    const [echo] = describeNodes(registry())
    if (echo === undefined) throw new Error('expected an echo node')

    expect(echo).toMatchObject({
      id: 'test.echo',
      version: '1.0.0',
      title: 'Echo',
      category: 'test',
    })
    expect(echo.inputs).toEqual([
      { id: 'in', kind: 'flow' },
      { id: 'value', kind: 'data', required: true, mode: 'value', schema: expect.objectContaining({ type: 'string' }) },
    ])
    expect(echo.outputs).toEqual([
      { id: 'text', kind: 'data', required: false, mode: 'stream', schema: expect.objectContaining({ type: 'string' }) },
      { id: 'count', kind: 'data', required: true, mode: 'value', schema: expect.objectContaining({ type: 'number' }) },
      { id: 'out', kind: 'flow' },
    ])
  })

  test('produces a descriptor that survives JSON serialisation', () => {
    const descriptor = describeNode(
      defineNode({
        id: 'test.only',
        version: '0.1.0',
        title: 'Only',
        category: 'test',
        config: z.object({}),
        inputs: [],
        outputs: [],
        execute: async () => ({}),
      }),
    )
    const roundTripped = JSON.parse(JSON.stringify(descriptor)) as NodeDescriptor
    expect(roundTripped).toEqual(descriptor)
  })
})
