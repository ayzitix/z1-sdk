import { describe, expect, test } from 'vitest'
import type { GraphDocument } from '@z1/graph'
import { TemplateRegistry, splitTemplateSpec, staticTemplate } from '../src/index.ts'
import type { GraphTemplate, TemplateContext } from '../src/index.ts'

function graph(id: string): GraphDocument {
  return { schemaVersion: 1, id, nodes: [], edges: [] }
}

function builder(id: string, version: string): GraphTemplate {
  return {
    kind: 'builder',
    id,
    version,
    title: `Builder ${id}`,
    build(context: TemplateContext): GraphDocument {
      return graph(`${id}:${context.role ?? 'none'}`)
    },
  }
}

describe('TemplateRegistry', () => {
  test('builds a builder template with its context and clones a static graph', () => {
    const registry = new TemplateRegistry()
    registry.register(builder('dynamic', '1.0.0'))
    registry.register(staticTemplate({ id: 'fixed', version: '1.0.0', title: 'Fixed' }, graph('fixed')))

    expect(registry.build('dynamic', { role: 'planner' }).id).toBe('dynamic:planner')
    expect(registry.build('fixed').id).toBe('fixed')
    expect(registry.get('fixed')?.kind).toBe('static')
  })

  test('rejects a duplicate id+version', () => {
    const registry = new TemplateRegistry()
    registry.register(builder('dup', '1.0.0'))
    expect(() => registry.register(builder('dup', '1.0.0'))).toThrow(/already registered/)
    // A different version of the same id is a distinct template.
    registry.register(builder('dup', '1.1.0'))
    expect(registry.list()).toHaveLength(2)
  })

  test('an unknown id throws', () => {
    expect(() => new TemplateRegistry().build('missing')).toThrow(/unknown template "missing"/)
  })

  test('a static build is a deep clone', () => {
    const stored = graph('stored')
    stored.nodes = [
      { id: 'n', type: 't', version: '1.0.0', config: { nested: { value: 1 } }, position: { x: 0, y: 0 } },
    ]
    const registry = new TemplateRegistry()
    registry.register(staticTemplate({ id: 'stored', version: '1.0.0', title: 'Stored' }, stored))

    const first = registry.build('stored')
    expect(first).not.toBe(stored)
    const node = first.nodes[0]
    expect(node).toBeDefined()
    if (node !== undefined) node.config = { nested: { value: 999 } }

    const second = registry.build('stored')
    expect(second.nodes[0]?.config).toEqual({ nested: { value: 1 } })
  })

  test('a version-less get resolves the highest version', () => {
    const registry = new TemplateRegistry()
    registry.register(builder('multi', '1.9.0'))
    registry.register(builder('multi', '1.10.0'))
    registry.register(builder('multi', '1.2.0'))

    expect(registry.get('multi')?.version).toBe('1.10.0')
    expect(registry.get('multi', '1.2.0')?.version).toBe('1.2.0')
    expect(registry.list().map((meta) => meta.version)).toEqual(['1.2.0', '1.9.0', '1.10.0'])
  })

  test('an id@version spec selects exactly that version', () => {
    const registry = new TemplateRegistry()
    registry.register(builder('multi', '1.2.0'))
    registry.register(builder('multi', '1.10.0'))

    expect(registry.get('multi@1.2.0')?.version).toBe('1.2.0')
    expect(registry.build('multi@1.2.0').id).toBe('multi:none')
    expect(registry.get('multi@9.9.9')).toBeUndefined()
    expect(() => registry.build('multi@9.9.9')).toThrow(/unknown template "multi@9.9.9"/)
  })

  test('the split happens at the last @ and only for a semver suffix', () => {
    expect(splitTemplateSpec('agent.loop@1.0.0')).toEqual({
      id: 'agent.loop',
      version: '1.0.0',
    })
    expect(splitTemplateSpec('ns@scope@1.0.0-rc.1+build')).toEqual({
      id: 'ns@scope',
      version: '1.0.0-rc.1+build',
    })
    expect(splitTemplateSpec('a@b@main')).toEqual({ id: 'a@b@main' })
    expect(splitTemplateSpec('a@1.0')).toEqual({ id: 'a@1.0' })
    expect(splitTemplateSpec('@1.0.0')).toEqual({ id: '@1.0.0' })
  })
})
