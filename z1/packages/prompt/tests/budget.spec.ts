import { describe, expect, test } from 'vitest'
import { estimateTokens, stackSections } from '../src/index.ts'
import { section } from './helpers.ts'

const LONG = 'x'.repeat(400)

describe('estimateTokens', () => {
  test('is ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens(LONG)).toBe(100)
  })
})

describe('budget', () => {
  test('drops the lowest-priority optional sections first', () => {
    const result = stackSections(
      [
        section('core.keep', 'core', 0, LONG, true),
        section('task.a', 'task', 5, LONG),
        section('task.b', 'task', 5, LONG),
        section('context.c', 'context', 9, LONG),
      ],
      {},
      { budgetTokens: 250 },
    )

    expect(result.sections.map((entry) => entry.id)).toEqual(['core.keep', 'task.a'])
    expect(result.tokens).toBe(200)
  })

  test('breaks priority ties by the later slot, then the later id', () => {
    const result = stackSections(
      [
        section('task.a', 'task', 5, LONG),
        section('task.b', 'task', 5, LONG),
        section('context.c', 'context', 5, LONG),
      ],
      {},
      { budgetTokens: 100 },
    )

    expect(result.sections.map((entry) => entry.id)).toEqual(['task.a'])
  })

  test('never drops a required section, even at the lowest priority', () => {
    const result = stackSections(
      [section('core.required', 'core', 99, LONG, true), section('custom.optional', 'custom', 0, LONG)],
      {},
      { budgetTokens: 100 },
    )

    expect(result.sections.map((entry) => entry.id)).toEqual(['core.required'])
    expect(result.tokens).toBe(100)
  })

  test('renders required sections and reports the overflow when they alone exceed the budget', () => {
    const result = stackSections(
      [section('core.a', 'core', 0, LONG, true), section('core.b', 'core', 1, LONG, true)],
      {},
      { budgetTokens: 50 },
    )

    expect(result.sections.map((entry) => entry.id)).toEqual(['core.a', 'core.b'])
    expect(result.tokens).toBe(200)
    expect(result.text.length).toBe(802)
  })

  test('keeps everything when the stack fits', () => {
    const result = stackSections(
      [section('core.a', 'core', 0, LONG, true), section('custom.b', 'custom', 1, LONG)],
      {},
      { budgetTokens: 200 },
    )

    expect(result.sections).toHaveLength(2)
  })
})
