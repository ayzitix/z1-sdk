import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'

import {
  createRecordingLlmService,
  withLlmCallContext,
  type BlobJournal,
  type LlmService,
  type RunEvent,
} from '../src/index.ts'

/** A journal that keeps rows and blobs in memory, enough for the decorator. */
function memoryJournal(): BlobJournal & { events: RunEvent[] } {
  const events: RunEvent[] = []
  const blobs = new Map<string, string>()
  const journal = {
    events,
    append: (event: RunEvent) => {
      events.push(event)
    },
    read: () => events,
    putBlob: (bytes: Uint8Array, mime: string) => {
      const hash = createHash('sha256').update(bytes).digest('hex')
      blobs.set(hash, `${mime}:${new TextDecoder().decode(bytes)}`)
      return hash
    },
    getBlob: (hash: string) => {
      const value = blobs.get(hash)
      if (value === undefined) return undefined
      const [, text] = value.split(':')
      return { hash, mime: 'text/plain', bytes: new TextEncoder().encode(text) }
    },
  }
  return journal as unknown as BlobJournal & { events: RunEvent[] }
}

const chat: LlmService['chat'] = async () => ({
  message: { role: 'assistant', content: 'ok' },
  toolCalls: [],
  stopReason: 'stop',
})

test('a metadata read is journaled with the run path and its body', async () => {
  const journal = memoryJournal()
  const service = createRecordingLlmService({
    inner: {
      chat,
      get: async () => ({ status: 200, ok: true, body: '{"data":[]}', truncated: false }),
    },
    journal,
    mode: 'full',
  })

  const response = await withLlmCallContext(
    { runId: 'run_1', nodeId: 'chat', path: 'loop/0/chat', attempt: 2 },
    () => service.get?.({ provider: 'openai', path: '/models', query: { 'api-version': '1' } }),
  )
  expect(response?.status).toBe(200)

  expect(journal.events).toHaveLength(1)
  const event = journal.events[0]
  expect(event?.type).toBe('llm.meta')
  if (event?.type !== 'llm.meta') throw new Error('expected llm.meta')
  expect(event.runId).toBe('run_1')
  expect(event.path).toBe('loop/0/chat')
  expect(event.provider).toBe('openai')
  expect(event.urlPath).toBe('/models')
  expect(event.query).toEqual({ 'api-version': '1' })
  expect(event.bodyHash).toBe(event.bodyBlob)
  expect(event.latencyMs).toBeGreaterThanOrEqual(0)
})

test('llm.meta in hashes mode stores no body and off stores nothing', async () => {
  const hashes = memoryJournal()
  const hashesService = createRecordingLlmService({
    inner: { chat, get: async () => ({ status: 200, ok: true, body: '{}', truncated: false }) },
    journal: hashes,
    mode: 'hashes',
  })
  await withLlmCallContext({ runId: 'r', nodeId: 'n', path: 'p', attempt: 1 }, () =>
    hashesService.get?.({ provider: 'x', path: '/models' }),
  )
  expect(hashes.events[0]?.type).toBe('llm.meta')
  expect(hashes.events[0]).not.toHaveProperty('bodyBlob')

  const off = memoryJournal()
  const offService = createRecordingLlmService({
    inner: { chat, get: async () => ({ status: 200, ok: true, body: '{}', truncated: false }) },
    journal: off,
    mode: 'off',
  })
  await withLlmCallContext({ runId: 'r', nodeId: 'n', path: 'p', attempt: 1 }, () =>
    offService.get?.({ provider: 'x', path: '/models' }),
  )
  expect(off.events).toHaveLength(0)
})

test('a metadata call outside a run is served but not journaled', async () => {
  const journal = memoryJournal()
  const service = createRecordingLlmService({
    inner: { chat, get: async () => ({ status: 200, ok: true, body: '{}', truncated: false }) },
    journal,
    mode: 'full',
  })
  await service.get?.({ provider: 'x', path: '/models' })
  expect(journal.events).toHaveLength(0)
})
