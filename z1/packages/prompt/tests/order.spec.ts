import { describe, expect, test } from 'vitest'
import { stackSections } from '../src/index.ts'
import { section } from './helpers.ts'

describe('stack ordering', () => {
  test('orders by slot, then priority, then id', () => {
    const result = stackSections(
      [
        section('custom.z', 'custom', 0, 'z'),
        section('core.b', 'core', 10, 'b'),
        section('role.a', 'role', 5, 'a'),
        section('core.a', 'core', 10, 'a'),
        section('core.first', 'core', 0, 'first'),
        section('contract.c', 'contract', 0, 'c'),
        section('task.t', 'task', 3, 't'),
        section('context.x', 'context', 1, 'x'),
      ],
      {},
    )

    expect(result.sections.map((entry) => entry.id)).toEqual([
      'core.first',
      'core.a',
      'core.b',
      'role.a',
      'task.t',
      'context.x',
      'contract.c',
      'custom.z',
    ])
  })

  test('keeps the first section for an id in sorted order and drops later ones', () => {
    const result = stackSections(
      [
        section('shared', 'custom', 0, 'custom body'),
        section('shared', 'role', 0, 'role body'),
      ],
      {},
    )

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]?.text).toBe('role body')
  })

  test('skips empty and whitespace-only bodies', () => {
    const result = stackSections(
      [section('a', 'core', 0, 'kept'), section('b', 'core', 1, '   \n\t')],
      {},
    )

    expect(result.sections.map((entry) => entry.id)).toEqual(['a'])
  })

  test('joins bodies verbatim with a blank line', () => {
    const result = stackSections(
      [section('a', 'core', 0, '  padded  '), section('b', 'core', 1, '## B\nline')],
      {},
    )

    expect(result.text).toBe('  padded  \n\n## B\nline')
  })
})
