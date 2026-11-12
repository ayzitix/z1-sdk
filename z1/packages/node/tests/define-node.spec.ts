import { expect, test } from 'vitest'
import { z } from 'zod'
import { defineNode } from '../src/index.ts'
import type { ApprovalRequest, NodeContext, NodeDefinition } from '../src/index.ts'

test('defineNode returns the same object', () => {
  const definition = {
    id: 'echo',
    version: '1.0.0',
    title: 'Echo',
    category: 'test',
    config: z.object({ limit: z.number() }),
    inputs: [],
    outputs: [],
    execute: async () => ({}),
  }
  const node = defineNode(definition)
  expect(node).toBe(definition)
})

test('defineNode preserves the inferred config type', () => {
  const node: NodeDefinition<{ limit: number }> = defineNode({
    id: 'typed',
    version: '1.0.0',
    title: 'Typed',
    category: 'test',
    config: z.object({ limit: z.number() }),
    inputs: [],
    outputs: [],
    execute: async (ctx) => {
      // Compile-time proof that ctx.config is the schema output, not unknown.
      const limit: number = ctx.config.limit
      return { limit }
    },
  })

  const parsed: { limit: number } = node.config.parse({ limit: 2 })
  expect(parsed.limit).toBe(2)
})

test('NodeContext can be implemented by a fake context', async () => {
  const controller = new AbortController()
  const emitted: Array<[string, unknown]> = []

  const ctx = {
    runId: 'run-1',
    nodeId: 'typed',
    path: 'loop1/0/typed',
    attempt: 0,
    input: { text: 'hi' },
    config: { limit: 3 },
    signal: controller.signal,
    log: () => {},
    emit: (port: string, chunk: unknown) => {
      emitted.push([port, chunk])
    },
    llm: {
      chat: async () => ({
        message: { role: 'assistant' as const, content: 'ok' },
        toolCalls: [],
        stopReason: 'stop' as const,
      }),
    },
    tools: {
      call: async () => null,
      list: async () => [],
    },
    fs: {
      read: async () => '',
      write: async () => {},
    },
    artifacts: {
      put: async () => 'hash',
      get: async () => new Uint8Array(),
    },
    approval: {
      request: async (request: ApprovalRequest) => {
        void request
        return 'allowed-once' as const
      },
    },
    runSubgraph: async () => ({ outputs: {} }),
  } satisfies NodeContext<{ limit: number }>

  expect(ctx.path).toBe('loop1/0/typed')
  expect(await ctx.approval.request({ action: 'fs.write' })).toBe('allowed-once')
  expect(emitted).toEqual([])
})
