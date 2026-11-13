import { describe, expect, it } from 'vitest'

import {
  draftFromConfig,
  fieldsFromSchema,
  mergeDraft,
  type Draft,
} from '../src/components/SchemaForm.tsx'

const schema: Record<string, unknown> = {
  type: 'object',
  required: ['slot', 'count'],
  properties: {
    slot: { type: 'string', enum: ['core', 'task'], description: 'where the text lands' },
    body: { type: 'string', description: 'the fragment' },
    template: { type: 'string' },
    label: { type: 'string', title: 'Label' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    enabled: { type: 'boolean' },
    extra: { type: 'object' },
    list: { type: 'array' },
    anything: {},
  },
}

describe('fieldsFromSchema', () => {
  it('maps the schema subset to field kinds and keeps required/description', () => {
    const fields = fieldsFromSchema(schema)
    const byKey = new Map(fields.map((field) => [field.key, field]))

    expect(byKey.get('slot')?.kind).toBe('enum')
    expect(byKey.get('slot')?.options).toEqual(['core', 'task'])
    expect(byKey.get('slot')?.required).toBe(true)
    expect(byKey.get('slot')?.description).toBe('where the text lands')

    // Long-body keys and the description property open as textareas.
    expect(byKey.get('body')?.kind).toBe('textarea')
    expect(byKey.get('template')?.kind).toBe('textarea')
    expect(byKey.get('label')?.kind).toBe('text')
    expect(byKey.get('label')?.label).toBe('Label')

    expect(byKey.get('count')?.kind).toBe('number')
    expect(byKey.get('count')?.integer).toBe(true)
    expect(byKey.get('count')?.required).toBe(true)
    expect(byKey.get('ratio')?.kind).toBe('number')
    expect(byKey.get('ratio')?.integer).toBe(false)
    expect(byKey.get('enabled')?.kind).toBe('boolean')

    expect(byKey.get('extra')?.kind).toBe('json')
    expect(byKey.get('list')?.kind).toBe('json')
    expect(byKey.get('anything')?.kind).toBe('json')
  })

  it('yields no fields for an unconstrained or absent schema', () => {
    expect(fieldsFromSchema({})).toEqual([])
    expect(fieldsFromSchema(undefined)).toEqual([])
    expect(fieldsFromSchema({ type: 'object' })).toEqual([])
  })
})

describe('mergeDraft', () => {
  it('merges only described keys and preserves the rest', () => {
    const fields = fieldsFromSchema(schema)
    const config = { keep: true, slot: 'core' }
    const draft: Draft = draftFromConfig(fields, config)
    draft['slot'] = 'task'
    draft['body'] = 'hello'
    draft['count'] = '2'
    draft['enabled'] = true

    const result = mergeDraft(fields, config, draft)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config).toEqual({
      keep: true,
      slot: 'task',
      body: 'hello',
      count: 2,
      enabled: true,
    })
  })

  it('reports a fraction for an integer field and writes nothing', () => {
    const fields = fieldsFromSchema(schema)
    const draft: Draft = draftFromConfig(fields, {})
    draft['count'] = '1.5'

    const result = mergeDraft(fields, {}, draft)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors)).toEqual(['count'])
    expect(result.errors['count']).toMatch(/whole number/)
  })

  it('reports invalid JSON per field and accepts valid JSON', () => {
    const fields = fieldsFromSchema(schema)
    const draft: Draft = draftFromConfig(fields, {})
    draft['extra'] = '{nope'

    const bad = mergeDraft(fields, {}, draft)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(Object.keys(bad.errors)).toEqual(['extra'])

    draft['extra'] = '{"a":1}'
    draft['list'] = '[1,2]'
    const good = mergeDraft(fields, {}, draft)
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.config).toEqual({ extra: { a: 1 }, list: [1, 2] })
  })

  it('drops an empty enum/number entry instead of storing an empty string', () => {
    const fields = fieldsFromSchema(schema)
    const draft: Draft = draftFromConfig(fields, { slot: 'core', count: 3 })
    draft['slot'] = ''
    draft['count'] = ''

    const result = mergeDraft(fields, { slot: 'core', count: 3 }, draft)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config).toEqual({})
  })
})
