import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { ChatDelta, ChatRequest, ModelHandle } from '@z1/node'
import { createMockRuntimeServices } from '../src/index.ts'

const model: ModelHandle = { provider: 'mock', model: 'mock-1' }

function request(content: string): ChatRequest {
  return { model, messages: [{ role: 'user', content }] }
}

describe('mock runtime services', () => {
  test('replies from the last user message and records the call', async () => {
    const services = createMockRuntimeServices()
    const result = await services.llm.chat(request('hello there'))

    expect(result.message).toEqual({ role: 'assistant', content: 'mock: hello there' })
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('stop')
    expect(services.chatCalls).toHaveLength(1)
    expect(services.chatCalls[0]).toBeDefined()
  })

  test('emits the reply word by word through onDelta', async () => {
    const services = createMockRuntimeServices()
    const deltas: ChatDelta[] = []
    const result = await services.llm.chat(request('one two three'), (delta) => {
      deltas.push(delta)
    })

    expect(deltas.every((delta) => delta.type === 'text')).toBe(true)
    const text = deltas.map((delta) => (delta.type === 'text' ? delta.text : '')).join('')
    expect(text).toBe(result.message.content)
    expect(deltas.length).toBe(4)
  })

  test('turns a [[tool:name]] marker into a tool call', async () => {
    const services = createMockRuntimeServices()
    const result = await services.llm.chat(request('please [[tool:search]] now'))

    expect(result.stopReason).toBe('tool_calls')
    expect(result.message).toEqual({ role: 'assistant', content: '' })
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'search', arguments: {} }])
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 })
  })

  test('terminates with text once the transcript carries a tool result', async () => {
    const services = createMockRuntimeServices()
    const result = await services.llm.chat({
      model,
      messages: [
        { role: 'user', content: 'please [[tool:search]] now' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'search', arguments: {} }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' },
      ],
    })

    expect(result.message).toEqual({ role: 'assistant', content: 'mock: done' })
    expect(result.toolCalls).toEqual([])
    expect(result.stopReason).toBe('stop')
  })

  test('tools return a default result and record invocations', async () => {
    const services = createMockRuntimeServices()
    const result = await services.tools.call('echo', { text: 'hi' })

    expect(result).toEqual({ ok: true, name: 'echo', args: { text: 'hi' } })
    expect(services.toolCalls).toEqual([{ name: 'echo', args: { text: 'hi' } }])
    expect(await services.tools.list()).toEqual([])
  })

  test('fs is in-memory and throws for a missing file', async () => {
    const services = createMockRuntimeServices()
    await services.fs.write('notes/a.txt', 'hello')

    expect(await services.fs.read('notes/a.txt')).toBe('hello')
    expect(services.files.get('notes/a.txt')).toBe('hello')
    await expect(services.fs.read('notes/missing.txt')).rejects.toThrow('ENOENT')
  })

  test('artifacts are addressed by the sha256 of their bytes', async () => {
    const services = createMockRuntimeServices()
    const bytes = new Uint8Array([1, 2, 3, 4])
    const hash = await services.artifacts.put(bytes, 'application/octet-stream')

    expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await services.artifacts.get(hash)).toEqual(bytes)
    await expect(services.artifacts.get('missing')).rejects.toThrow('unknown artifact')
  })

  test('approval accepts fixed decisions and functions', async () => {
    const allowed = createMockRuntimeServices()
    expect(
      await allowed.approval.request({ action: 'node.execute' }, { runId: 'r', nodeId: 'n' }),
    ).toBe('allowed-once')

    const rejected = createMockRuntimeServices({ approval: 'rejected' })
    expect(
      await rejected.approval.request({ action: 'node.execute' }, { runId: 'r', nodeId: 'n' }),
    ).toBe('rejected')

    const cancelled = createMockRuntimeServices({ approval: 'cancelled' })
    expect(
      await cancelled.approval.request({ action: 'node.execute' }, { runId: 'r', nodeId: 'n' }),
    ).toBe('cancelled')

    const seen: string[] = []
    const dynamic = createMockRuntimeServices({
      approval: (approvalRequest, context) => {
        seen.push(`${context.runId}:${context.nodeId}:${String(approvalRequest.target)}`)
        return 'allowed-once'
      },
    })
    const decision = await dynamic.approval.request(
      { action: 'node.execute', target: 'test.const' },
      { runId: 'run1', nodeId: 'n1' },
    )
    expect(decision).toBe('allowed-once')
    expect(seen).toEqual(['run1:n1:test.const'])
  })
})
