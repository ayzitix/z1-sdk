import { describe, expect, test } from 'vitest'

import type { Json } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import {
  createSubagentTool,
  MAX_SUBAGENT_MAX_STEPS,
  MAX_SUBAGENT_TIME_MINUTES,
  MIN_SUBAGENT_TIME_MINUTES,
  restrictToolService,
  subagentToolSchema,
  withSubagentTool,
  SubagentError,
  type SubagentInventory,
} from '../src/index.ts'
import { createFakeHost, createTestJournal, schema, staticLlm } from './fakes.ts'

const MODEL = { provider: 'mock', model: 'mock-1' } as const

const inventory: SubagentInventory = {
  installed: [schema('read'), schema('grep'), schema('shell')],
  enabled: [schema('read'), schema('grep')],
}

const validArgs = {
  description: 'inspect one file',
  prompt: 'read the file and report the first line',
  tools: { enable: ['read'] },
  // These tests pin the v1 contract (block, return the child's result), which
  // since 2b is `wait: true`; the background launch has its own spec file.
  wait: true,
}

function asRecord(value: Json | undefined): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object')
  }
  return value
}

function toolFor(host: ReturnType<typeof createFakeHost>) {
  return createSubagentTool({
    model: MODEL,
    host,
    inventory,
  })
}

function fakeInner(): ToolService & {
  readonly seen: { readonly name: string; readonly args: Json }[]
} {
  const seen: { name: string; args: Json }[] = []
  return {
    seen,
    async list() {
      return [schema('read'), schema('grep'), schema('shell')]
    },
    async call(name: string, args: Json): Promise<Json> {
      seen.push({ name, args })
      return { ok: true, name }
    },
  }
}

describe('subagentToolSchema', () => {
  test('declares the documented input and required fields', () => {
    expect(subagentToolSchema.name).toBe('subagent')
    expect(subagentToolSchema.description).toContain('child agent')

    const parameters = asRecord(subagentToolSchema.parameters)
    expect(parameters['type']).toBe('object')
    expect(parameters['additionalProperties']).toBe(false)
    expect(parameters['required']).toEqual(['description', 'prompt', 'tools'])

    const properties = asRecord(parameters['properties'])
    expect(asRecord(properties['description'])['type']).toBe('string')
    expect(asRecord(properties['prompt'])['type']).toBe('string')

    const tools = asRecord(properties['tools'])
    expect(tools['required']).toEqual(['enable'])
    expect(tools['additionalProperties']).toBe(false)
    const toolProperties = asRecord(tools['properties'])
    expect(asRecord(toolProperties['enable'])['type']).toBe('array')
    expect(asRecord(toolProperties['disable'])['type']).toBe('array')

    // 2b: `wait` is optional (absent ⇒ background) and the description says
    // which mode to use when.
    const wait = asRecord(properties['wait'])
    expect(wait['type']).toBe('boolean')
    expect(parameters['required']).not.toContain('wait')
    expect(subagentToolSchema.description).toContain('background')
    expect(subagentToolSchema.description).toContain('wait: true')

    // The soft time budget is the one bound the parent agent may choose per
    // call: bounded, integer, optional, and it says what an expired budget does.
    const timeMinutes = asRecord(properties['timeMinutes'])
    expect(timeMinutes['type']).toBe('integer')
    expect(timeMinutes['minimum']).toBe(MIN_SUBAGENT_TIME_MINUTES)
    expect(timeMinutes['maximum']).toBe(MAX_SUBAGENT_TIME_MINUTES)
    expect(String(timeMinutes['description'])).toContain('partial')
    expect(parameters['required']).not.toContain('timeMinutes')
  })
})

describe('createSubagentTool', () => {
  test('runs a child with the exact grant and returns a compact result', async () => {
    const model = staticLlm('child answer')
    const journal = createTestJournal()
    const host = createFakeHost({
      tools: [schema('read'), schema('grep')],
      llm: model.llm,
      journal,
    })
    const tool = toolFor(host)

    const result = await tool.call(validArgs)

    expect(result.status).toBe('completed')
    expect(result.tools).toEqual(['read'])
    expect(result.denied).toEqual([])
    expect(result.output).toBe('child answer')
    expect(result.runId).toMatch(/^run_[0-9a-f-]{36}$/)

    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools?.map((entry) => entry.name)).toEqual(['read'])
    expect(model.requests[0]?.messages[0]?.content).toContain(
      'Your tools for this run are exactly: `read`.',
    )

    const begin = host.beginCalls[0]
    expect(begin?.runId).toBe(result.runId)
    expect(begin?.moduleApproval).toBe(begin?.approval)
    await expect(
      begin?.approval.request({ action: 'tool.call' }, { runId: 'r', nodeId: 'n' }),
    ).resolves.toBe('rejected')

    expect(host.handles[0]?.disposed).toBe(true)
    const record = journal.runs.get(result.runId)
    expect(record?.status).toBe('completed')
    expect(record).not.toHaveProperty('parentRunId')
    expect(
      journal.events.get(result.runId)?.some((event) => event.type === 'run.completed'),
    ).toBe(true)
  })

  test('forwards a granted child tool call to the child service', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host)

    const result = await tool.call({
      ...validArgs,
      prompt: '[[tool:read]] read the file',
    })

    expect(result.output).toBe('mock: done')
    expect(host.handles[0]?.services.toolCalls).toEqual([{ name: 'read', args: {} }])
  })

  test('the SDK gate rejects an ungranted child call before the service', async () => {
    const host = createFakeHost({ tools: [schema('read'), schema('shell')] })
    const tool = toolFor(host)

    const result = await tool.call({
      ...validArgs,
      prompt: '[[tool:shell]] run something',
    })

    expect(result.output).toBe('mock: done')
    expect(host.handles[0]?.services.toolCalls).toEqual([])
    const second = host.handles[0]?.services.chatCalls[1]
    const toolMessage = second?.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('not available in this run')
    expect(toolMessage?.content).toContain('shell')
  })

  test('reports denied names without giving them to the child', async () => {
    const model = staticLlm('done')
    const host = createFakeHost({
      tools: [schema('read'), schema('grep')],
      llm: model.llm,
    })
    const tool = toolFor(host)

    const result = await tool.call({
      ...validArgs,
      tools: { enable: ['read', 'grep'], disable: ['grep'] },
    })

    expect(result.tools).toEqual(['read'])
    expect(result.denied).toEqual(['grep'])
    expect(model.requests[0]?.tools?.map((entry) => entry.name)).toEqual(['read'])
  })

  test('fails closed when a granted tool disappears before the child starts', async () => {
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('grep')], journal })
    const tool = toolFor(host)

    await expect(tool.call(validArgs)).rejects.toMatchObject({
      code: 'child_tool_missing',
    })

    expect(host.beginCalls).toHaveLength(1)
    expect(host.handles[0]?.disposed).toBe(true)
    expect(journal.runs.size).toBe(0)
  })

  test('disposes the handle when listing child tools throws', async () => {
    const host = createFakeHost({
      tools: async () => {
        throw new Error('worker is gone')
      },
    })
    const tool = toolFor(host)

    await expect(tool.call(validArgs)).rejects.toMatchObject({ code: 'child_failed' })
    expect(host.handles[0]?.disposed).toBe(true)
  })

  test('a maxSteps above the loop ceiling is rejected before any child starts', async () => {
    // `z1.flow.loop` validates `maxIterations` as int().min(1).max(10_000), so
    // 10_001 used to build a graph and fail inside `buildAgentGraph` - after
    // `beginRun`, with no row and a message that never names the option.
    const host = createFakeHost({ tools: [schema('read')], llm: staticLlm('ok').llm })
    const tool = createSubagentTool({ model: MODEL, host, inventory, maxSteps: MAX_SUBAGENT_MAX_STEPS + 1 })

    const error = await tool.call(validArgs).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(SubagentError)
    expect((error as SubagentError).code).toBe('invalid_input')
    expect((error as SubagentError).message).toContain('maxSteps must be <= 10000')
    expect(host.beginCalls).toEqual([])
    expect(host.handles).toEqual([])
  })

  test('an invalid grant has no side effects', async () => {
    const journal = createTestJournal()
    const host = createFakeHost({ tools: [schema('read')], journal })
    const tool = toolFor(host)

    const invalid = [
      { ...validArgs, tools: { enable: ['nope'] } },
      { ...validArgs, tools: { enable: ['shell'] } },
      { ...validArgs, tools: { enable: ['*', 'read'] } },
      { ...validArgs, tools: { enable: ['read'], disable: ['*'] } },
      { ...validArgs, tools: { enable: ['read'], disable: ['reed'] } },
      { ...validArgs, description: 'd'.repeat(121) },
      { ...validArgs, prompt: 'p'.repeat(64 * 1024 + 1) },
      // `wait` is optional, but a misspelt value must not decide the mode.
      { ...validArgs, wait: 'flase' },
      { ...validArgs, wait: 1 },
    ]

    for (const args of invalid) {
      await expect(tool.call(args)).rejects.toBeInstanceOf(SubagentError)
    }

    expect(host.beginCalls).toEqual([])
    expect(host.handles).toEqual([])
    expect(journal.runs.size).toBe(0)
  })

  test('the restricted child ToolService advertises no tools at run level', async () => {
    const model = staticLlm('no tools needed')
    const host = createFakeHost({
      tools: [schema('read'), schema('shell')],
      llm: model.llm,
    })
    const tool = toolFor(host)

    const result = await tool.call({ ...validArgs, tools: { enable: [] } })

    expect(result.tools).toEqual([])
    expect(model.requests[0]?.tools).toEqual([])
    expect(model.requests[0]?.messages[0]?.content).toContain('You have no tools for this run')
  })

  test('the child graph advertises exactly the grant at run level', async () => {
    const host = createFakeHost({
      tools: [schema('read'), schema('shell')],
    })
    const tool = toolFor(host)

    await tool.call(validArgs)

    // The graph was built with the one granted schema, and the same names were
    // passed to runGraph's gate.
    const request = host.handles[0]?.services.chatCalls[0]
    expect(request?.tools?.map((entry) => entry.name)).toEqual(['read'])
  })
})

describe('restrictToolService', () => {
  test('advertises only the grant, in grant order', async () => {
    const inner = fakeInner()
    const restricted = restrictToolService(inner, ['grep', 'read'])

    expect((await restricted.list()).map((entry) => entry.name)).toEqual(['grep', 'read'])
  })

  test('rejects an ungranted call before forwarding and names the grant', async () => {
    const inner = fakeInner()
    const restricted = restrictToolService(inner, ['read'], {
      inventory: [schema('read')],
    })

    await expect(restricted.call('shell', {})).rejects.toMatchObject({
      code: 'unknown_tool',
    })
    await expect(restricted.call('shell', {})).rejects.toThrow(
      /not granted to this subagent; granted tools: read/,
    )
    expect(inner.seen).toEqual([])

    await expect(restricted.call('read', { path: 'a' })).resolves.toEqual({
      ok: true,
      name: 'read',
    })
    expect(inner.seen).toEqual([{ name: 'read', args: { path: 'a' } }])
  })

  test('an empty grant advertises nothing and says so on a call', async () => {
    const inner = fakeInner()
    const restricted = restrictToolService(inner, [])

    expect(await restricted.list()).toEqual([])
    await expect(restricted.call('read', {})).rejects.toThrow(/granted tools: \(none\)/)
  })

  test('forwards granted calls so an inner live guard can still revoke them', async () => {
    const inner: ToolService = {
      async list() {
        return [schema('read')]
      },
      async call() {
        throw new Error('tool "read" is off')
      },
    }
    const restricted = restrictToolService(inner, ['read'], {
      inventory: [schema('read')],
    })

    await expect(restricted.call('read', {})).rejects.toThrow(/is off/)
  })

  test('a guardCall hook revokes a granted call before forwarding', async () => {
    const inner = fakeInner()
    const restricted = restrictToolService(inner, ['read'], {
      inventory: [schema('read')],
      guardCall: (name) => {
        if (name === 'read') throw new Error('tool "read" is off')
      },
    })

    await expect(restricted.call('read', {})).rejects.toThrow(/is off/)
    expect(inner.seen).toEqual([])
  })

  test('with an inventory, a vanished name is rejected without forwarding', async () => {
    const inner = fakeInner()
    const restricted = restrictToolService(inner, ['read'], {
      inventory: [schema('read')],
    })

    const changed = restrictToolService(inner, ['grep'], {
      inventory: [schema('read')],
    })
    expect(await changed.list()).toEqual([])
    await expect(changed.call('grep', {})).rejects.toMatchObject({
      code: 'child_tool_missing',
    })
    expect(inner.seen).toEqual([])

    expect((await restricted.list()).map((entry) => entry.name)).toEqual(['read'])
  })
})

describe('withSubagentTool', () => {
  test('composes list and routes both services without shadowing', async () => {
    const model = staticLlm('child answer')
    const host = createFakeHost({ tools: [schema('read')], llm: model.llm })
    const tool = toolFor(host)
    const inner = fakeInner()
    const composed = await withSubagentTool(inner, tool)

    expect((await composed.list()).map((entry) => entry.name)).toEqual([
      'read',
      'grep',
      'shell',
      'subagent',
    ])
    await expect(composed.call('read', { a: 1 })).resolves.toEqual({ ok: true, name: 'read' })
    expect(inner.seen).toEqual([{ name: 'read', args: { a: 1 } }])

    const result = await composed.call('subagent', validArgs)
    expect(asRecord(result)).toMatchObject({
      status: 'completed',
      tools: ['read'],
      denied: [],
      output: 'child answer',
    })
  })

  test('fails at composition when the live service already has the name', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host)
    const inner: ToolService = {
      async list() {
        return [schema('subagent')]
      },
      async call() {
        return null
      },
    }

    await expect(withSubagentTool(inner, tool)).rejects.toMatchObject({
      code: 'duplicate_tool',
    })
    expect(host.beginCalls).toEqual([])
  })

  test('fails at composition for a disabled tool in the raw inventory', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host)
    const inner = fakeInner()

    await expect(
      withSubagentTool(inner, tool, { inventory: [schema('subagent')] }),
    ).rejects.toMatchObject({ code: 'duplicate_tool' })
    expect(host.beginCalls).toEqual([])
  })

  test('the live list cannot be shadowed even when a raw inventory is supplied', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host)
    const inner: ToolService = {
      async list() {
        return [schema('subagent')]
      },
      async call() {
        return null
      },
    }

    await expect(
      withSubagentTool(inner, tool, { inventory: [schema('read')] }),
    ).rejects.toMatchObject({ code: 'duplicate_tool' })
    expect(host.beginCalls).toEqual([])
  })

  test('a guardCall hook revokes the composite before a child starts', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host)
    const inner = fakeInner()
    const composed = await withSubagentTool(inner, tool, {
      guardCall: (name) => {
        if (name === 'subagent') throw new Error('tool "subagent" is off')
      },
    })

    await expect(composed.call('subagent', validArgs)).rejects.toThrow(/"subagent" is off/)
    expect(host.beginCalls).toEqual([])
    expect(inner.seen).toEqual([])
  })

  test('a tool added after composition cannot be shadowed by list or call', async () => {
    const host = createFakeHost({ tools: [schema('read')] })
    const tool = toolFor(host)
    const schemas: ReturnType<typeof schema>[] = [schema('read')]
    const inner: ToolService = {
      async list() {
        return schemas
      },
      async call() {
        return null
      },
    }
    const composed = await withSubagentTool(inner, tool)

    schemas.push(schema('subagent'))

    await expect(composed.list()).rejects.toMatchObject({ code: 'duplicate_tool' })
    await expect(composed.call('subagent', validArgs)).rejects.toMatchObject({
      code: 'duplicate_tool',
    })
    expect(host.beginCalls).toEqual([])
  })
})
