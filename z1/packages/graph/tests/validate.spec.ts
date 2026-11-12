import { describe, expect, test } from 'vitest'
import { validateGraph, validateGraphTree } from '../src/index.ts'
import { codes, createRegistry, edge, makeGraph, node } from './fixtures.ts'

const registry = createRegistry()

describe('validateGraph', () => {
  test('accepts a well-formed graph', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [
        edge('e1', 'data', 'src', 'value', 'out', 'text'),
        edge('e2', 'flow', 'src', 'out', 'out', 'in'),
      ],
    })
    expect(validateGraph(graph, registry)).toEqual([])
  })

  test('duplicate-node-id', () => {
    const graph = makeGraph({
      nodes: [node('dup', 'test.source'), node('dup', 'test.pass')],
    })
    expect(codes(validateGraph(graph, registry))).toContain('duplicate-node-id')
  })

  test('unknown-node-type', () => {
    const graph = makeGraph({
      nodes: [node('n', 'ghost.type', {}, { version: '9.9.9' })],
    })
    const issues = validateGraph(graph, registry)
    expect(codes(issues)).toContain('unknown-node-type')
    expect(issues.find((issue) => issue.code === 'unknown-node-type')?.nodeId).toBe('n')
  })

  test('unknown-port', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [edge('e1', 'data', 'src', 'missing', 'out', 'text')],
    })
    expect(codes(validateGraph(graph, registry))).toContain('unknown-port')
  })

  test('port-kind-mismatch', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [edge('e1', 'data', 'src', 'out', 'out', 'text')],
    })
    expect(codes(validateGraph(graph, registry))).toContain('port-kind-mismatch')
  })

  test('port-type-mismatch', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('num', 'test.numberSink')],
      edges: [edge('e1', 'data', 'src', 'value', 'num', 'value')],
    })
    expect(codes(validateGraph(graph, registry))).toContain('port-type-mismatch')
  })

  test('unconstrained and union-typed ports are compatible', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('num', 'test.numberSink')],
      edges: [edge('e1', 'data', 'src', 'any', 'num', 'value')],
    })
    expect(codes(validateGraph(graph, registry))).not.toContain('port-type-mismatch')
  })

  test('type arrays intersect when one member matches', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [edge('e1', 'data', 'src', 'maybe', 'out', 'text')],
    })
    expect(codes(validateGraph(graph, registry))).not.toContain('port-type-mismatch')
  })

  test('missing-required-input', () => {
    const graph = makeGraph({ nodes: [node('out', 'test.sink')] })
    const issues = validateGraph(graph, registry)
    const missing = issues.filter((issue) => issue.code === 'missing-required-input')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.nodeId).toBe('out')
  })

  test('optional inputs are not required', () => {
    const graph = makeGraph({ nodes: [node('opt', 'test.optionalSink')] })
    expect(codes(validateGraph(graph, registry))).not.toContain('missing-required-input')
  })

  // Intended behaviour (SPEC §5): required data inputs of a node with no
  // incoming edges are exactly what this check flags — the executor cannot
  // invent a value for them. `z1.core.input` is exempt in practice because it
  // declares no inputs; roots that do declare required inputs are real errors.
  test('flags required data inputs of a node with no incoming edges', () => {
    const issues = validateGraph(makeGraph({ nodes: [node('num', 'test.numberSink')] }), registry)
    expect(issues.filter((issue) => issue.code === 'missing-required-input')).toHaveLength(1)
  })

  test('does not flag roots that declare no inputs', () => {
    const graph = makeGraph({ nodes: [node('src', 'test.source')] })
    expect(codes(validateGraph(graph, registry))).not.toContain('missing-required-input')
  })

  test('required input fed by a data edge is satisfied', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('num', 'test.numberSink')],
      edges: [edge('e1', 'data', 'src', 'count', 'num', 'value')],
    })
    expect(codes(validateGraph(graph, registry))).not.toContain('missing-required-input')
  })

  test('dangling-edge', () => {
    const graph = makeGraph({
      nodes: [node('out', 'test.sink')],
      edges: [edge('e1', 'data', 'ghost', 'value', 'out', 'text')],
    })
    const issues = validateGraph(graph, registry)
    expect(codes(issues)).toContain('dangling-edge')
    expect(issues.find((issue) => issue.code === 'dangling-edge')?.edgeId).toBe('e1')
  })

  test('self-edge', () => {
    const graph = makeGraph({
      nodes: [node('a', 'test.pass')],
      edges: [edge('e1', 'data', 'a', 'value', 'a', 'value')],
    })
    expect(codes(validateGraph(graph, registry))).toContain('self-edge')
  })

  test('flow-cycle', () => {
    const graph = makeGraph({
      nodes: [node('a', 'test.pass'), node('b', 'test.pass')],
      edges: [
        edge('e1', 'flow', 'a', 'out', 'b', 'in'),
        edge('e2', 'flow', 'b', 'out', 'a', 'in'),
      ],
    })
    const issues = validateGraph(graph, registry)
    expect(codes(issues)).toContain('flow-cycle')
  })

  test('data edges do not form a flow cycle', () => {
    const graph = makeGraph({
      nodes: [node('a', 'test.pass'), node('b', 'test.pass')],
      edges: [
        edge('e1', 'flow', 'a', 'out', 'b', 'in'),
        edge('e2', 'data', 'b', 'value', 'a', 'value'),
      ],
    })
    expect(codes(validateGraph(graph, registry))).not.toContain('flow-cycle')
  })

  test('invalid-config', () => {
    const graph = makeGraph({ nodes: [node('n', 'test.config', {})] })
    const issues = validateGraph(graph, registry)
    expect(codes(issues)).toContain('invalid-config')
    expect(issues.find((issue) => issue.code === 'invalid-config')?.nodeId).toBe('n')
  })

  test('duplicate-edge-id', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [
        edge('dup', 'data', 'src', 'value', 'out', 'text'),
        edge('dup', 'data', 'src', 'count', 'out', 'note'),
      ],
    })
    expect(codes(validateGraph(graph, registry))).toContain('duplicate-edge-id')
  })

  test('duplicate-data-edge rejects two incoming data edges into one port', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [
        edge('e1', 'data', 'src', 'value', 'out', 'text'),
        edge('e2', 'data', 'src', 'any', 'out', 'text'),
      ],
    })
    const issues = validateGraph(graph, registry)
    const duplicates = issues.filter((issue) => issue.code === 'duplicate-data-edge')

    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]?.nodeId).toBe('out')
    expect(duplicates[0]?.edgeId).toBe('e2')
  })

  test('two data edges into different ports are allowed', () => {
    const graph = makeGraph({
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [
        edge('e1', 'data', 'src', 'value', 'out', 'text'),
        edge('e2', 'data', 'src', 'count', 'out', 'note'),
      ],
    })
    expect(codes(validateGraph(graph, registry))).not.toContain('duplicate-data-edge')
  })

  test('does not recurse into nested graphs on its own', () => {
    const inner = makeGraph({
      id: 'inner',
      nodes: [node('out', 'test.sink')],
      edges: [edge('e1', 'data', 'ghost', 'value', 'out', 'text')],
    })
    const outer = makeGraph({
      nodes: [node('n', 'test.nested', { body: inner })],
    })
    expect(codes(validateGraph(outer, registry))).not.toContain('dangling-edge')
  })
})

describe('validateGraphTree', () => {
  test('validates config.body and config.graph recursively', () => {
    const inner = makeGraph({
      id: 'inner',
      nodes: [node('out', 'test.sink')],
      edges: [edge('e1', 'data', 'ghost', 'value', 'out', 'text')],
    })
    const alsoInner = makeGraph({
      id: 'also-inner',
      nodes: [node('n', 'test.config', {})],
    })
    const outer = makeGraph({
      nodes: [
        node('body', 'test.nested', { body: inner }),
        node('graph', 'test.nested', { graph: alsoInner }),
      ],
    })
    const found = codes(validateGraphTree(outer, registry))
    expect(found).toContain('dangling-edge')
    expect(found).toContain('invalid-config')
  })

  test('applies duplicate-data-edge to nested graphs', () => {
    const inner = makeGraph({
      id: 'inner',
      nodes: [node('src', 'test.source'), node('out', 'test.sink')],
      edges: [
        edge('e1', 'data', 'src', 'value', 'out', 'text'),
        edge('e2', 'data', 'src', 'any', 'out', 'text'),
      ],
    })
    const outer = makeGraph({ nodes: [node('n', 'test.nested', { body: inner })] })
    expect(codes(validateGraphTree(outer, registry))).toContain('duplicate-data-edge')
  })

  test('nested-too-deep beyond 32 levels', () => {
    let document = makeGraph({ id: 'deep-0', nodes: [node('leaf', 'test.source')] })
    for (let level = 1; level <= 34; level += 1) {
      document = makeGraph({
        id: `deep-${level}`,
        nodes: [node('n', 'test.nested', { body: document })],
      })
    }
    const issues = validateGraphTree(document, registry)
    expect(codes(issues)).toContain('nested-too-deep')
    expect(issues.find((issue) => issue.code === 'nested-too-deep')?.nodeId).toBe('n')
  })

  test('32 nested levels are accepted', () => {
    let document = makeGraph({ id: 'deep-0', nodes: [node('leaf', 'test.source')] })
    for (let level = 1; level <= 32; level += 1) {
      document = makeGraph({
        id: `deep-${level}`,
        nodes: [node('n', 'test.nested', { body: document })],
      })
    }
    expect(codes(validateGraphTree(document, registry))).not.toContain('nested-too-deep')
  })
})
