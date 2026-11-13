import { describe, expect, test } from 'vitest'
import { stackSections } from '../src/index.ts'
import { section } from './helpers.ts'

describe('pre-rendered sections', () => {
  test('text is emitted verbatim and never templated a second time', () => {
    const rendered = stackSections(
      [
        {
          id: 'context.memory',
          slot: 'context',
          priority: 0,
          body: 'ignored body {{memory}}',
          text: 'user: keep {{keepme}} exactly',
        },
      ],
      { memory: 'SHOULD-NOT-APPEAR', keepme: 'SHOULD-NOT-APPEAR' },
    )

    expect(rendered.text).toBe('user: keep {{keepme}} exactly')
    expect(rendered.sections.map((entry) => entry.text)).toEqual([
      'user: keep {{keepme}} exactly',
    ])
  })

  test('text wins over body, so a whitespace body does not erase rendered text', () => {
    const rendered = stackSections(
      [{ id: 'core.a', slot: 'core', priority: 0, body: '   ', text: 'kept' }],
      {},
    )

    expect(rendered.text).toBe('kept')
  })
})

describe('whitespace-only effective text', () => {
  test('a section rendering to whitespace disappears from sections, hash and tokens', () => {
    const onlyVar = section('core.blank', 'core', 0, '{{missing}}  ')
    const kept = section('core.kept', 'core', 1, 'kept')

    const withBlank = stackSections([onlyVar, kept], {})
    const withoutBlank = stackSections([kept], {})

    expect(withBlank.sections.map((entry) => entry.id)).toEqual(['core.kept'])
    expect(withBlank.text).toBe('kept')
    expect(withBlank.hash).toBe(withoutBlank.hash)
    expect(withBlank.tokens).toBe(withoutBlank.tokens)
  })
})
