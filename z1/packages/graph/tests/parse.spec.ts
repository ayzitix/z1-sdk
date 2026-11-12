import { describe, expect, test } from 'vitest'
import { GraphParseError, parseGraph } from '../src/index.ts'
import { edge, makeGraph, node } from './fixtures.ts'

describe('parseGraph', () => {
  test('round-trips a parsed document', () => {
    const document = {
      ...makeGraph({
        id: 'roundtrip',
        title: 'Round trip',
        metadata: { owner: 'tests', tags: ['a', 'b'] },
        nodes: [
          {
            ...node('a', 'test.source', { nested: { list: [1, 2, { ok: true }] } }, { label: 'A' }),
            autonomy: { mode: 'ask' as const, reason: 'external call', timeoutMs: 500 },
          },
          node('b', 'test.pass', {}, { label: 'B' }),
        ],
        edges: [edge('e1', 'data', 'a', 'value', 'b', 'value')],
      }),
    }

    const parsed = parseGraph(document)
    expect(parsed).toEqual(document)
    expect(parsed).toEqual(parseGraph(JSON.parse(JSON.stringify(parsed)) as unknown))
  })

  test('accepts duplicate node ids (reported by validateGraph)', () => {
    const parsed = parseGraph(
      makeGraph({ nodes: [node('dup', 'test.source'), node('dup', 'test.pass')] }),
    )
    expect(parsed.nodes.map((entry) => entry.id)).toEqual(['dup', 'dup'])
  })

  test('rejects a wrong schema version', () => {
    expect(() => parseGraph({ ...makeGraph(), schemaVersion: 2 })).toThrow(GraphParseError)
  })

  test('rejects an empty id', () => {
    expect(() => parseGraph(makeGraph({ id: '' }))).toThrow(GraphParseError)
  })

  test('rejects non-JSON config with the zod issue path', () => {
    const document: unknown = {
      ...makeGraph(),
      nodes: [
        {
          id: 'a',
          type: 'test.source',
          version: '1.0.0',
          config: { bad: undefined },
          position: { x: 0, y: 0 },
        },
      ],
    }
    let error: unknown
    try {
      parseGraph(document)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GraphParseError)
    const issues = (error as GraphParseError).issues
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]?.path.join('.')).toContain('config')
  })
})
