import { describe, expect, test } from 'vitest'
import { renderTemplate } from '../src/index.ts'

describe('renderTemplate', () => {
  test('substitutes nested object values', () => {
    const vars = { task: { spec: { title: 'T32' } } }
    expect(renderTemplate('Task {{task.spec.title}}.', vars)).toBe('Task T32.')
  })

  test('substitutes array indices', () => {
    const vars = { steps: [{ id: 'a' }, { id: 'b' }] }
    expect(renderTemplate('{{steps.1.id}}', vars)).toBe('b')
    expect(renderTemplate('{{steps.2.id}}', vars)).toBe('')
    expect(renderTemplate('{{steps.first}}', vars)).toBe('')
  })

  test('renders missing placeholders as empty strings', () => {
    expect(renderTemplate('[{{missing.path}}]', {})).toBe('[]')
    expect(renderTemplate('[{{a}}]', { a: null })).toBe('[]')
  })

  test('blocks prototype keys', () => {
    const vars = { safe: { value: 'ok' } }
    expect(renderTemplate('{{__proto__}}', vars)).toBe('')
    expect(renderTemplate('{{safe.constructor}}', vars)).toBe('')
    expect(renderTemplate('{{safe.prototype.value}}', vars)).toBe('')
  })

  test('stringifies objects and arrays as JSON', () => {
    const vars = { list: ['a', 1, true], obj: { k: 'v' } }
    expect(renderTemplate('{{list}}', vars)).toBe('["a",1,true]')
    expect(renderTemplate('{{obj}}', vars)).toBe('{"k":"v"}')
  })

  test('renders primitives and leaves malformed placeholders alone', () => {
    expect(renderTemplate('{{n}} {{b}}', { n: 3, b: false })).toBe('3 false')
    expect(renderTemplate('{{a b}}', { a: 'x' })).toBe('{{a b}}')
  })

  test('renders empty strings for a missing root', () => {
    expect(renderTemplate('{{a.b.c}}', {})).toBe('')
  })
})
