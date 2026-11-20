import { describe, expect, test } from 'vitest'
import { canonicalJson, graphDigest } from '../src/index.ts'
import { edge, makeGraph, node } from './fixtures.ts'

function sampleGraph() {
  return makeGraph({
    id: 'digest.graph',
    title: 'Digest sample',
    nodes: [
      node('a', 'test.source', {}, { label: 'A' }),
      node('b', 'test.pass'),
      node('c', 'test.numberSink'),
    ],
    edges: [
      edge('e1', 'flow', 'a', 'out', 'b', 'in'),
      edge('e2', 'data', 'a', 'count', 'b', 'value'),
      edge('e3', 'data', 'b', 'value', 'c', 'value'),
    ],
  })
}

describe('graphDigest', () => {
  test('is stable across node and edge order', () => {
    const graph = sampleGraph()
    const shuffled = makeGraph({
      id: graph.id,
      ...(graph.title !== undefined ? { title: graph.title } : {}),
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    })
    expect(graphDigest(shuffled)).toBe(graphDigest(graph))
  })

  test('changes when config changes', () => {
    const left = makeGraph({ nodes: [node('n', 'test.config', { label: 'left' })] })
    const right = makeGraph({ nodes: [node('n', 'test.config', { label: 'right' })] })
    expect(graphDigest(left)).not.toBe(graphDigest(right))
  })

  test('includes nested config.graph', () => {
    const inner = makeGraph({ id: 'inner', nodes: [node('n', 'test.source')] })
    const other = makeGraph({ id: 'other', nodes: [node('n', 'test.source')] })
    const left = makeGraph({ nodes: [node('outer', 'test.nested', { graph: inner })] })
    const right = makeGraph({ nodes: [node('outer', 'test.nested', { graph: other })] })
    expect(graphDigest(left)).not.toBe(graphDigest(right))
  })

  test('is a sha256 hex digest', () => {
    expect(graphDigest(sampleGraph())).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ignores node position', () => {
    const left = makeGraph({ nodes: [node('a', 'test.source')] })
    const moved = makeGraph({
      nodes: [{ ...node('a', 'test.source'), position: { x: 420, y: -17 } }],
    })
    expect(graphDigest(moved)).toBe(graphDigest(left))
  })

  test('ignores node label', () => {
    const left = makeGraph({ nodes: [node('a', 'test.source', {}, { label: 'A' })] })
    const renamed = makeGraph({ nodes: [node('a', 'test.source', {}, { label: 'Renamed' })] })
    expect(graphDigest(renamed)).toBe(graphDigest(left))
  })

  test('ignores the graph title', () => {
    const left = makeGraph({ nodes: [node('a', 'test.source')] })
    const renamed = { ...makeGraph({ nodes: [node('a', 'test.source')] }), title: 'Renamed' }
    expect(graphDigest(renamed)).toBe(graphDigest(left))
  })

  test('ignores display fields inside a nested graph body', () => {
    const body = (title: string, nodeConfig: Record<string, unknown>, x: number, label: string) => ({
      schemaVersion: 1,
      id: 'nested',
      title,
      nodes: [
        {
          id: 'map',
          type: 'test.source',
          version: '1.0.0',
          config: nodeConfig,
          position: { x, y: 0 },
          label,
        },
      ],
      edges: [],
    })
    const left = makeGraph({
      nodes: [node('loop', 'test.nested', { body: body('Tool calls', { path: 'a' }, 0, 'A') })],
    })
    const renamed = makeGraph({
      nodes: [
        node('loop', 'test.nested', { body: body('Renamed', { path: 'a' }, 420, 'Renamed') }),
      ],
    })

    expect(graphDigest(renamed)).toBe(graphDigest(left))
  })

  test('changes when a nested node config changes', () => {
    const body = (path: string) => ({
      schemaVersion: 1,
      id: 'nested',
      nodes: [{ id: 'map', type: 'test.source', version: '1.0.0', config: { path } }],
      edges: [],
    })
    const left = makeGraph({ nodes: [node('loop', 'test.nested', { body: body('a') })] })
    const right = makeGraph({ nodes: [node('loop', 'test.nested', { body: body('b') })] })

    expect(graphDigest(right)).not.toBe(graphDigest(left))
  })

  test('ignores a nested title under config.graph too', () => {
    const inner = (title: string) => ({
      schemaVersion: 1,
      id: 'inner',
      title,
      nodes: [node('n', 'test.source')],
      edges: [],
    })
    const left = makeGraph({ nodes: [node('sub', 'test.nested', { graph: inner('Before') })] })
    const renamed = makeGraph({ nodes: [node('sub', 'test.nested', { graph: inner('After') })] })

    expect(graphDigest(renamed)).toBe(graphDigest(left))
  })

  test('changes when autonomy changes', () => {
    const left = makeGraph({ nodes: [node('a', 'test.source')] })
    const right = makeGraph({
      nodes: [{ ...node('a', 'test.source'), autonomy: { mode: 'deny' } }],
    })
    expect(graphDigest(right)).not.toBe(graphDigest(left))
  })

  test('changes when edges change', () => {
    const left = makeGraph({
      nodes: [node('a', 'test.source'), node('b', 'test.pass')],
      edges: [edge('e1', 'data', 'a', 'count', 'b', 'value')],
    })
    const retargeted = makeGraph({
      nodes: [node('a', 'test.source'), node('b', 'test.pass')],
      edges: [edge('e1', 'data', 'a', 'any', 'b', 'value')],
    })
    expect(graphDigest(retargeted)).not.toBe(graphDigest(left))
  })
})

describe('canonicalJson', () => {
  test('sorts object keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: true, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":true}]},"b":1}',
    )
  })

  test('drops undefined object members but keeps array holes as null', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}')
  })
})
