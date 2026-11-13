import { describe, expect, test } from 'vitest'
import type { Json, MemoryEnvelope } from '@z1/node'
import { createMockRuntimeServices, type RunEvent } from '@z1/runtime'
import { createBuiltinRegistry } from '../src/index.ts'
import { makeGraph, runBuiltins } from './helpers.ts'

/** A root memory node publishes nothing, so its outputs live in the events. */
function outputsOf(
  events: readonly RunEvent[],
  path: string,
): Record<string, Json> | undefined {
  for (const event of events) {
    if (event.type === 'node.completed' && event.path === path) return event.outputs
  }
  return undefined
}

const memoryOnly = (id: string) =>
  makeGraph(
    id,
    [{ id: 'memory', type: 'z1.memory.context', version: '1.0.0', config: {}, position: { x: 0, y: 0 } }],
    [],
  )

describe('z1.memory.context', () => {
  test('is an empty envelope when the host supplies no memory service', async () => {
    const { result, events } = await runBuiltins({ graph: memoryOnly('memory-none') })

    expect(result.status).toBe('completed')
    expect(outputsOf(events, 'memory')).toEqual({ text: '', messages: [] })
  })

  test('forwards the run id and returns text plus messages', async () => {
    const envelope: MemoryEnvelope = {
      text: '## Ancestors\n- root',
      messages: [{ role: 'system', content: 'Context from the branch tree:\n## Ancestors' }],
      spine: ['root'],
      siblings: [],
      recent: [],
    }
    const services = createMockRuntimeServices()
    let requested = ''
    services.memory = {
      buildContext: async (request) => {
        requested = request.runId
        return envelope
      },
    }

    const { result, events } = await runBuiltins({
      graph: memoryOnly('memory-service'),
      services,
    })

    expect(requested).toBe(result.runId)
    expect(outputsOf(events, 'memory')).toEqual({
      text: envelope.text,
      messages: envelope.messages,
    })
    expect(createBuiltinRegistry().has('z1.memory.context', '1.0.0')).toBe(true)
  })
})
